/**
 * Accessibility tree capture and serialization.
 *
 * Extracts the full accessibility tree from a CDP session and serializes it
 * to a compact human-readable text format suitable for LLM consumption.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface AXNode {
  role: string;
  name: string;
  uid?: number;
  backendNodeId: number;
  value?: string;
  description?: string;
  properties?: Record<string, unknown>;
  children?: AXNode[];
  frameId?: string;
  // State properties
  focused?: boolean;
  selected?: boolean;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  readonly?: boolean;
}

/** Raw CDP AX node as returned by Accessibility.getFullAXTree */
interface CDPAXNode {
  nodeId: string;
  parentId?: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: { value: string };
  name?: { value: string };
  value?: { value: unknown };
  description?: { value: string };
  properties?: Array<{ name: string; value: { value: unknown } }>;
  childIds?: string[];
}

type CdpSend = (method: string, params?: object) => Promise<any>;

/** Frame metadata used during multi-frame tree capture. */
interface FrameInfo {
  id: string | null;
  url: string;
  securityOrigin: string;
}

/** Result of capturing a full multi-frame accessibility tree. */
export interface FullTreeResult {
  /** Main frame nodes. */
  mainNodes: AXNode[];
  /** OOP iframe nodes keyed by child targetId. */
  frameNodes: Map<string, { nodes: AXNode[]; url: string }>;
  /** uid → childSessionId routing for cross-frame element resolution. */
  refRouting: Map<number, string>;
}

// Roles that are purely structural/decorative — skipped during parsing
const SKIP_ROLES = new Set([
  'none',
  'GenericContainer',
  'InlineTextBox',
]);

// ─── Tree capture ───────────────────────────────────────────────────

/**
 * Captures the full accessibility tree from a CDP session.
 *
 * Walks the CDP AX node graph, filters out ignored and structural-only
 * nodes, and returns a cleaned tree of {@link AXNode} objects with
 * `backendNodeId` attached for downstream element resolution.
 */
export async function captureAccessibilityTree(
  cdpSend: CdpSend,
  sessionId: string,
  frameId?: string,
): Promise<AXNode[]> {
  const params: Record<string, string> = {};
  if (frameId) params.frameId = frameId;

  const { nodes } = (await cdpSend('Accessibility.getFullAXTree', params)) as {
    nodes: CDPAXNode[];
  };
  if (!nodes || nodes.length === 0) return [];

  // Build lookup map for parent → child resolution
  const nodeMap = new Map<string, CDPAXNode>();
  for (const n of nodes) nodeMap.set(n.nodeId, n);

  // Find root nodes (no parentId, or parent not in this response)
  const roots = nodes.filter(n => !n.parentId || !nodeMap.has(n.parentId));

  function convertNode(raw: CDPAXNode): AXNode | null {
    // Ignored nodes: recurse into children but don't emit a node
    if (raw.ignored) {
      const children = flatMapChildren(raw);
      return children.length > 0 ? wrapChildren(children) : null;
    }

    const role = raw.role?.value;
    if (!role || SKIP_ROLES.has(role)) {
      // Skip purely structural containers but keep their children
      const children = flatMapChildren(raw);
      return children.length > 0 ? wrapChildren(children) : null;
    }

    const node: AXNode = {
      role,
      name: raw.name?.value ?? '',
      backendNodeId: raw.backendDOMNodeId ?? 0,
    };

    // Optional fields
    if (raw.value?.value !== undefined && raw.value.value !== '') {
      node.value = String(raw.value.value);
    }
    if (raw.description?.value) {
      node.description = raw.description.value;
    }

    // Parse boolean/state properties from CDP property array
    if (raw.properties) {
      const props: Record<string, unknown> = {};
      for (const p of raw.properties) {
        const val = p.value?.value;
        if (val === undefined || val === null) continue;
        props[p.name] = val;
      }
      if (Object.keys(props).length > 0) node.properties = props;

      // Promote commonly-used states to top-level booleans
      node.focused = props['focused'] === true || undefined;
      node.selected = props['selected'] === true || undefined;
      node.disabled = props['disabled'] === true || undefined;
      node.readonly = props['readonly'] === true || undefined;
      node.expanded = typeof props['expanded'] === 'boolean' ? props['expanded'] : undefined;
      if (props['checked'] === true || props['checked'] === 'true') node.checked = true;
      else if (props['checked'] === 'mixed') node.checked = 'mixed';
    }

    // Children
    const children = flatMapChildren(raw);
    if (children.length > 0) node.children = children;

    return node;
  }

  /** Recursively convert children, flattening skipped intermediate containers */
  function flatMapChildren(raw: CDPAXNode): AXNode[] {
    const childIds = raw.childIds || [];
    const result: AXNode[] = [];
    for (const id of childIds) {
      const child = nodeMap.get(id);
      if (!child) continue;
      const converted = convertNode(child);
      if (!converted) continue;
      // If conversion returned a wrapper (no real node), splice in its children
      if (converted.role === '__wrapper__') {
        if (converted.children) result.push(...converted.children);
      } else {
        result.push(converted);
      }
    }
    return result;
  }

  /** Temporary wrapper to carry children through skipped containers */
  function wrapChildren(children: AXNode[]): AXNode {
    return { role: '__wrapper__', name: '', backendNodeId: 0, children };
  }

  // Convert all roots
  const result: AXNode[] = [];
  for (const root of roots) {
    const converted = convertNode(root);
    if (!converted) continue;
    if (converted.role === '__wrapper__' && converted.children) {
      result.push(...converted.children);
    } else {
      result.push(converted);
    }
  }
  return result;
}

/**
 * Capture accessibility trees from the main frame AND all OOP (cross-origin) iframes.
 *
 * This is the multi-frame equivalent of `captureAccessibilityTree`. It also captures
 * same-origin iframes via frameId, then OOP iframes via their child CDP sessions.
 * Returns all trees plus a routing map so element interactions can target the correct session.
 */
export async function captureFullTree(
  cdpSend: CdpSend,
  mainSessionId: string,
  childSessions: Map<string, { sessionId: string; url: string }>,
): Promise<FullTreeResult> {
  const mainNodes: AXNode[] = [];
  const frameNodes = new Map<string, { nodes: AXNode[]; url: string }>();
  const refRouting = new Map<number, string>();

  // 1. Capture same-origin frames via Page.getFrameTree
  let frameIds: Array<string | null> = [null]; // null = root frame
  try {
    const { frameTree } = (await cdpSend('Page.getFrameTree', {})) as {
      frameTree: { frame: { id: string }; childFrames?: any[] };
    };
    frameIds = collectFrameIds(frameTree);
  } catch {
    // Can't get frame tree — root frame only
  }

  for (const frameId of frameIds) {
    try {
      const nodes = await captureAccessibilityTree(cdpSend, mainSessionId, frameId ?? undefined);
      if (nodes.length > 0) {
        mainNodes.push(...nodes);
      }
    } catch {
      // Individual frame failure — continue with others
    }
  }

  // 2. Capture OOP (cross-origin) iframe content via child CDP sessions
  if (childSessions.size > 0) {
    for (const [targetId, { sessionId: childSess, url: frameUrl }] of childSessions) {
      try {
        const childCdpSend: CdpSend = (method, params) =>
          cdpSend(method, { ...params, __sessionId: childSess });
        const nodes = await captureAccessibilityTree(childCdpSend, childSess);
        if (nodes.length > 0) {
          // Tag all nodes in this frame with their child session for routing
          tagNodesWithSession(nodes, childSess, refRouting);
          frameNodes.set(targetId, { nodes, url: frameUrl });
        }
      } catch {
        // OOP frame capture failure — continue with others
      }
    }
  }

  return { mainNodes, frameNodes, refRouting };
}

/** Collect all frame IDs from a Page.getFrameTree response. */
function collectFrameIds(frameTree: { frame: { id: string }; childFrames?: any[] }): Array<string | null> {
  const ids: Array<string | null> = [frameTree.frame.id];
  if (frameTree.childFrames) {
    for (const child of frameTree.childFrames) {
      ids.push(...collectFrameIds(child));
    }
  }
  return ids;
}

/** Record uid → session routing for all nodes with assigned uids. */
export function tagNodesWithSession(nodes: AXNode[], sessionId: string, routing: Map<number, string>): void {
  for (const node of nodes) {
    if (node.uid !== undefined) {
      routing.set(node.uid, sessionId);
    }
    if (node.children) {
      tagNodesWithSession(node.children, sessionId, routing);
    }
  }
}

// ─── Serialization ──────────────────────────────────────────────────

/** Property names that map to simple boolean flags in serialized output */
const BOOL_PROPS: Record<string, string> = {
  disabled: 'disabled',
  checked: 'checked',
  selected: 'selected',
  required: 'required',
  readonly: 'readonly',
  focused: 'focused',
  pressed: 'pressed',
  modal: 'modal',
  multiselectable: 'multiselectable',
};

/**
 * Serializes an AXNode tree into indented text.
 *
 * Output matches the format the monolith `buildSnapshot` used:
 * ```
 * - heading "Page Title" [level=1] [ref=1]
 *   - link "Home" [ref=2]
 *     - StaticText "Home" [ref=3]
 * ```
 */
export function serializeTree(nodes: AXNode[], indent = 0, framePrefix = ''): string {
  const lines: string[] = [];

  for (const node of nodes) {
    const pad = '  '.repeat(indent);
    const nameStr = node.name
      ? ` "${sanitizeName(node.name)}"`
      : '';

    const props = serializeProps(node);
    const propStr = props.length > 0 ? ` [${props.join(', ')}]` : '';
    const refStr = node.uid !== undefined ? ` [ref=${node.uid}]` : '';

    lines.push(`${pad}${framePrefix}- ${node.role}${nameStr}${propStr}${refStr}`);

    if (node.children && node.children.length > 0) {
      lines.push(serializeTree(node.children, indent + 1, framePrefix));
    }
  }

  return lines.join('\n');
}

/** Build the property tag list for a single node */
function serializeProps(node: AXNode): string[] {
  const props: string[] = [];
  const raw = node.properties ?? {};

  for (const [key, label] of Object.entries(BOOL_PROPS)) {
    const val = raw[key];
    if (key === 'checked') {
      if (val === true || val === 'true') props.push('checked');
      else if (val === 'mixed') props.push('mixed');
    } else if (key === 'expanded') {
      if (val === true) props.push('expanded');
      else if (val === false) props.push('collapsed');
    } else if (val === true || val === 'true') {
      props.push(label);
    }
  }

  // Non-boolean properties
  if (raw['level'] !== undefined) props.push(`level=${raw['level']}`);
  if (raw['valuetext'] !== undefined) {
    props.push(`value=${JSON.stringify(String(raw['valuetext']).substring(0, 80))}`);
  }
  if (raw['hasPopup'] && raw['hasPopup'] !== 'false') {
    props.push(`haspopup=${raw['hasPopup']}`);
  }
  if (raw['autocomplete'] && raw['autocomplete'] !== 'none') {
    props.push(`autocomplete=${raw['autocomplete']}`);
  }
  if (raw['orientation'] && raw['orientation'] !== 'none') {
    props.push(`orientation=${raw['orientation']}`);
  }

  // Inline value (for inputs)
  if (node.value !== undefined && node.value !== '' && !props.some(p => p.startsWith('value='))) {
    props.push(`value=${JSON.stringify(String(node.value).substring(0, 80))}`);
  }

  return props;
}

/** Sanitize a node name for text output (collapse whitespace, escape quotes) */
function sanitizeName(name: string): string {
  return name.replace(/[\n\r"\\]/g, ' ').trim().substring(0, 120);
}
