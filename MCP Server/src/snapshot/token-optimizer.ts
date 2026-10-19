/**
 * Token optimizer for accessibility tree snapshots.
 *
 * Implements Fix 7: reduce snapshot size for LLM consumption.
 * Applies a pipeline of transformations that strip decorative content,
 * collapse empty containers, and truncate verbose text — all while
 * preserving the interactive elements and structural hierarchy that
 * LLMs need for reasoning and action.
 */

import type { AXNode } from './accessibility.js';

/** Roles that are purely decorative or structural — add no value for LLMs */
const SKIP_ROLES = new Set([
  'generic',
  'none',
  'presentation',
  'separator',
  'LineBreak',
  'InlineTextBox',
]);

/** Roles that represent interactive elements and should always be kept */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'searchbox',
  'tree',
  'treeitem',
  'textarea',
  'menu',
  'menubar',
  'gridcell',
  'row',
]);

export class TokenOptimizer {
  /**
   * Filter out decorative/structural roles that add no value for LLMs.
   * Children of filtered nodes are promoted to the parent level.
   */
  static filterRoles(nodes: AXNode[]): AXNode[] {
    return TokenOptimizer.flatMapNodes(nodes, node => {
      if (SKIP_ROLES.has(node.role)) {
        // Promote children to parent scope
        return node.children ? TokenOptimizer.filterRoles(node.children) : [];
      }
      // Merge StaticText into parent when it's a single child with matching name
      // (handled by caller at the tree level)
      return [{
        ...node,
        children: node.children ? TokenOptimizer.filterRoles(node.children) : undefined,
      }];
    });
  }

  /**
   * Collapse empty container nodes that have no name and no interactive children.
   * These are structural wrappers (div, section, etc.) that add indentation
   * without providing useful information.
   */
  static collapseEmpty(nodes: AXNode[]): AXNode[] {
    return TokenOptimizer.flatMapNodes(nodes, node => {
      const hasName = node.name && node.name.trim().length > 0;
      const hasValue = node.value !== undefined && node.value !== '';
      const isInteractive = INTERACTIVE_ROLES.has(node.role);
      const hasRef = node.uid !== undefined;
      const hasProperties = node.properties && Object.keys(node.properties).length > 0;

      // Keep if the node itself is meaningful
      if (hasName || hasValue || isInteractive || hasProperties) {
        return [{
          ...node,
          children: node.children ? TokenOptimizer.collapseEmpty(node.children) : undefined,
        }];
      }

      // Collapse: promote children, skip this wrapper
      const children = node.children ? TokenOptimizer.collapseEmpty(node.children) : [];

      // If only one child, just return it directly
      if (children.length === 1) return children;

      // If multiple children exist, keep the container to preserve structure
      if (children.length > 1) {
        return [{ ...node, children }];
      }

      // No children and no content — drop entirely
      return [];
    });
  }

  /**
   * Truncate long text content in node names and values.
   * @param maxLen Maximum characters per text field (default: 100)
   */
  static truncateText(nodes: AXNode[], maxLen = 100): AXNode[] {
    return nodes.map(node => {
      const copy = { ...node };
      if (copy.name && copy.name.length > maxLen) {
        copy.name = copy.name.substring(0, maxLen) + '…';
      }
      if (copy.value && copy.value.length > maxLen) {
        copy.value = copy.value.substring(0, maxLen) + '…';
      }
      if (copy.children) {
        copy.children = TokenOptimizer.truncateText(copy.children, maxLen);
      }
      return copy;
    });
  }

  /**
   * Limit tree depth. Nodes beyond maxDepth are pruned entirely.
   * @param maxDepth Maximum nesting level (default: 6)
   */
  static limitDepth(nodes: AXNode[], maxDepth = 6): AXNode[] {
    if (maxDepth <= 0) return [];
    return nodes.map(node => ({
      ...node,
      children: node.children
        ? TokenOptimizer.limitDepth(node.children, maxDepth - 1)
        : undefined,
    }));
  }

  /**
   * Merge StaticText children into their parent's name when:
   * - The parent has exactly one child
   * - That child is a StaticText node
   * - The parent doesn't already have a name
   *
   * This eliminates redundant nesting like:
   * ```
   * - link [ref=5]
   *   - StaticText "Click here" [ref=6]
   * ```
   * → `- link "Click here" [ref=5]`
   */
  static mergeStaticText(nodes: AXNode[]): AXNode[] {
    return nodes.map(node => {
      const copy = { ...node };

      if (copy.children) {
        // Recurse first
        copy.children = TokenOptimizer.mergeStaticText(copy.children);

        // Merge single StaticText child into parent
        if (
          copy.children.length === 1 &&
          copy.children[0].role === 'StaticText' &&
          (!copy.name || copy.name.trim() === '')
        ) {
          copy.name = copy.children[0].name;
          copy.children = copy.children[0].children; // usually undefined
        }
      }

      // Clean up empty children arrays
      if (copy.children && copy.children.length === 0) {
        copy.children = undefined;
      }

      return copy;
    });
  }

  /**
   * Combined optimization pipeline.
   *
   * Applies all optimizations in order:
   * 1. Filter decorative roles
   * 2. Merge StaticText into parents
   * 3. Collapse empty containers
   * 4. Truncate long text
   * 5. Limit tree depth
   *
   * If the result still exceeds `maxTokenBudget`, depth is progressively
   * reduced until it fits.
   */
  static optimize(
    nodes: AXNode[],
    options?: {
      maxTokenBudget?: number;
      maxDepth?: number;
      maxTextLen?: number;
    },
  ): AXNode[] {
    const budget = options?.maxTokenBudget ?? 20_000;
    const maxTextLen = options?.maxTextLen ?? 100;
    let maxDepth = options?.maxDepth ?? 6;

    // Apply pipeline
    let result = TokenOptimizer.filterRoles(nodes);
    result = TokenOptimizer.mergeStaticText(result);
    result = TokenOptimizer.collapseEmpty(result);
    result = TokenOptimizer.truncateText(result, maxTextLen);
    result = TokenOptimizer.limitDepth(result, maxDepth);

    // Progressive depth reduction if still over budget
    while (maxDepth > 2 && estimateSize(result) > budget) {
      maxDepth--;
      result = TokenOptimizer.limitDepth(result, maxDepth);
    }

    return result;
  }

  // ─── Internal helpers ───────────────────────────────────────────────

  /** Apply a transform that maps each node to zero or more replacement nodes */
  private static flatMapNodes(
    nodes: AXNode[],
    fn: (node: AXNode) => AXNode[],
  ): AXNode[] {
    const result: AXNode[] = [];
    for (const node of nodes) {
      result.push(...fn(node));
    }
    return result;
  }

  // ─── Slim-mode optimizations ────────────────────────────────────────

  /**
   * Interactive-only mode — return only elements users can interact with,
   * plus headings for context and named images.
   * Ideal for small-context models that only need actionable elements.
   */
  static interactiveOnly(nodes: AXNode[]): AXNode[] {
    return TokenOptimizer.filterTree(nodes, node =>
      INTERACTIVE_ROLES.has(node.role) ||
      node.role === 'heading' ||
      (node.role === 'img' && !!node.name),
    );
  }

  /**
   * Search mode — return only elements whose name, value, or description
   * matches the query string (case-insensitive).
   */
  static search(nodes: AXNode[], query: string): AXNode[] {
    const q = query.toLowerCase();
    return TokenOptimizer.filterTree(nodes, node =>
      (node.name?.toLowerCase().includes(q) ?? false) ||
      (node.value?.toLowerCase().includes(q) ?? false) ||
      (node.description?.toLowerCase().includes(q) ?? false),
    );
  }

  /**
   * Cap serialized output to a maximum character length with smart truncation.
   * Truncates at a line boundary to avoid breaking element references.
   *
   * @param slim When true, emit a much shorter truncation footer (-40 chars).
   *             Used by slim-mode callers where every byte matters.
   */
  static capLength(serialized: string, maxChars: number, slim = false): string {
    if (serialized.length <= maxChars) return serialized;
    const truncPoint = serialized.lastIndexOf('\n', maxChars - 200);
    const cutAt = truncPoint > 0 ? truncPoint : maxChars - 200;
    const dropped = serialized.length - cutAt;
    const footer = slim
      ? `\n... (+${dropped} chars truncated; use search)`
      : `\n\n... (truncated ${dropped} chars. Use search parameter to find specific elements)`;
    return serialized.substring(0, cutAt) + footer;
  }

  /**
   * Filter tree, keeping nodes that match predicate and their ancestors.
   * Children of non-matching nodes are promoted to parent scope.
   */
  private static filterTree(
    nodes: AXNode[],
    predicate: (node: AXNode) => boolean,
  ): AXNode[] {
    const result: AXNode[] = [];
    for (const node of nodes) {
      const filteredChildren = node.children
        ? TokenOptimizer.filterTree(node.children, predicate)
        : [];

      if (predicate(node)) {
        // Keep this node with its filtered children
        result.push({
          ...node,
          children: filteredChildren.length > 0 ? filteredChildren : undefined,
        });
      } else if (filteredChildren.length > 0) {
        // Node doesn't match but has matching descendants — promote them
        result.push(...filteredChildren);
      }
    }
    return result;
  }
}

/**
 * Rough estimate of serialized tree size in characters.
 * Used to check if output fits within the token budget.
 */
function estimateSize(nodes: AXNode[], depth = 0): number {
  let size = 0;
  for (const node of nodes) {
    // Estimate: indent + "- " + role + name + props + ref ≈ structured line
    size += depth * 2 + 4 + node.role.length;
    if (node.name) size += node.name.length + 3; // quotes + space
    if (node.value) size += node.value.length + 10;
    if (node.properties) size += Object.keys(node.properties).length * 12;
    size += 10; // ref tag
    if (node.children) {
      size += estimateSize(node.children, depth + 1);
    }
  }
  return size;
}
