/**
 * Slim-mode output budget regression tests.
 *
 * These tests enforce the budgets that make slim mode usable on
 * 32K-context models. They MUST FAIL on regression — that is the
 * whole point. If you legitimately need to widen a budget, do it
 * here so reviewers see the change.
 *
 * Budgets (v5.0.0-alpha.4):
 *   - Slim schema total                            <  1500 chars
 *   - Synthetic complex-form snapshot output       <  6000 chars
 *   - Slim click result message                    <    80 chars
 *   - Slim default snapshot maxLength              =  4000 chars
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getSlimTools,
  isSlimMode,
  slimify,
  defaultSnapshotMaxLength,
  SLIM_DEFAULT_SNAPSHOT_MAX_LENGTH,
  FULL_DEFAULT_SNAPSHOT_MAX_LENGTH,
} from '../../tools/slim-mode.js';
import { TokenOptimizer } from '../../snapshot/token-optimizer.js';
import { serializeTree } from '../../snapshot/accessibility.js';
import type { AXNode } from '../../snapshot/accessibility.js';

// ─── Helpers ────────────────────────────────────────────────────────

function n(role: string, name = '', children?: AXNode[], extra?: Partial<AXNode>): AXNode {
  return { role, name, backendNodeId: 0, ...extra, children };
}

/**
 * Synthetic accessibility tree that mirrors the structure of
 * `__tests__/fixtures/test-pages/complex-form.html` — a Greenhouse /
 * LinkedIn-Easy-Apply style form with ~30 interactive nodes (text inputs,
 * comboboxes, file input, 5 skill checkboxes, 3 + 3 radio buttons,
 * submit button).
 *
 * Real browser snapshots also include ~10–20 generic / wrapper nodes that
 * `TokenOptimizer.optimize` filters out, so this synthetic tree is a fair
 * lower bound on what a 32K-context model will see.
 */
function complexFormTree(): AXNode[] {
  return [
    n('RootWebArea', 'Complex Form — LinkedIn Easy Apply / Greenhouse Style', [
      n('heading', 'Job Application', undefined, { properties: { level: 1 } }),
      // Basic text fields
      n('textbox', 'Full Name', undefined, { properties: { required: true } }),
      n('textbox', 'Email', undefined, { properties: { required: true } }),
      // Country code combobox
      n('combobox', 'Phone Country Code', [
        n('searchbox', 'Search country...'),
        n('listbox', 'Country codes', [
          n('option', 'United States (+1)'),
          n('option', 'Canada (+1)'),
          n('option', 'United Kingdom (+44)'),
          n('option', 'India (+91)'),
        ]),
      ]),
      n('textbox', 'Phone Number'),
      // Location autocomplete
      n('combobox', 'Location', [
        n('searchbox', 'Start typing a city...'),
      ]),
      // File upload
      n('button', 'Resume / CV — Choose File'),
      n('group', 'Or drag and drop your file here'),
      // Skills checkboxes
      n('group', 'Skills (select all that apply)', [
        n('checkbox', 'JavaScript'),
        n('checkbox', 'TypeScript'),
        n('checkbox', 'Python'),
        n('checkbox', 'React'),
        n('checkbox', 'Node.js'),
      ]),
      // Experience radios
      n('group', 'Experience Level', [
        n('radio', 'Junior (0-2 years)'),
        n('radio', 'Mid (3-5 years)'),
        n('radio', 'Senior (6+ years)'),
      ]),
      // Work auth radios
      n('group', 'Work Authorization', [
        n('radio', 'Citizen'),
        n('radio', 'Visa Holder'),
        n('radio', 'Other'),
      ]),
      n('button', 'Submit Application'),
    ]),
  ];
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('Slim Mode — output budgets', () => {
  const originalSlim = process.env.CDP_SLIM_MODE;

  beforeEach(() => {
    process.env.CDP_SLIM_MODE = 'true';
  });

  afterEach(() => {
    if (originalSlim === undefined) delete process.env.CDP_SLIM_MODE;
    else process.env.CDP_SLIM_MODE = originalSlim;
  });

  describe('schema budget', () => {
    it('total slim schema stays under 1500 chars', () => {
      const tools = getSlimTools();
      const totalSchema = JSON.stringify(tools.map(t => t.inputSchema)).length;
      expect(totalSchema).toBeLessThan(1500);
    });

    it('total slim descriptions stay under 250 chars', () => {
      const tools = getSlimTools();
      const totalDesc = tools.reduce((s, t) => s + t.description.length, 0);
      expect(totalDesc).toBeLessThan(250);
    });

    it('full slim ListTools JSON stays under 1600 chars', () => {
      const tools = getSlimTools();
      const json = JSON.stringify(tools);
      expect(json.length).toBeLessThan(1600);
    });
  });

  describe('snapshot output budget', () => {
    it('synthetic complex-form snapshot stays under 6000 chars in slim mode', () => {
      const tree = complexFormTree();
      const optimized = TokenOptimizer.optimize(tree);
      const serialized = serializeTree(optimized);

      // Header in slim mode is short: "[N elems] title\n\n"
      const header = `[${countNodes(optimized)} elems] Complex Form — LinkedIn Easy Apply / Greenhouse Style\n\n`;
      const full = header + serialized;

      // Apply slim cap (4 000) to mirror the page.ts handler
      const capped = TokenOptimizer.capLength(full, defaultSnapshotMaxLength(), true);
      expect(capped.length).toBeLessThan(6000);
    });

    it('default snapshot maxLength is 4000 in slim mode', () => {
      expect(defaultSnapshotMaxLength()).toBe(SLIM_DEFAULT_SNAPSHOT_MAX_LENGTH);
      expect(SLIM_DEFAULT_SNAPSHOT_MAX_LENGTH).toBe(4000);
    });

    it('default snapshot maxLength is 20000 in full mode', () => {
      delete process.env.CDP_SLIM_MODE;
      expect(defaultSnapshotMaxLength()).toBe(FULL_DEFAULT_SNAPSHOT_MAX_LENGTH);
      expect(FULL_DEFAULT_SNAPSHOT_MAX_LENGTH).toBe(20_000);
    });

    it('slim cap-truncation footer is shorter than full footer', () => {
      const long = 'x'.repeat(2000) + '\n' + 'y'.repeat(2000);
      const slimOut = TokenOptimizer.capLength(long, 1000, true);
      const fullOut = TokenOptimizer.capLength(long, 1000, false);
      expect(slimOut.length).toBeLessThan(fullOut.length);
      // Slim footer must still tell the agent how to recover (mention search)
      expect(slimOut).toMatch(/truncated/);
      expect(slimOut).toMatch(/search/);
    });
  });

  describe('response message budget', () => {
    it('slim click result is under 80 chars even with network suffix', () => {
      const verbose =
        `Clicked <button> "Submit Application" at (320, 482)\n` +
        `Network: 3 request(s) completed`;
      const slim = slimify(verbose, 'Clicked');
      expect(slim).toBe('Clicked');
      expect(slim.length).toBeLessThan(80);
    });

    it('slim hover / type / drag / scroll / focus / tap responses are all 1-2 words', () => {
      const cases = [
        slimify('Hovering over <a> "Login"', 'Hovered'),
        slimify('Typed "very long text input that wastes tokens"', 'Typed'),
        slimify('Dragged <div> "A" → <div> "B"', 'Dragged'),
        slimify('Scrolled down by 500px', 'Scrolled'),
        slimify('Focused <input> "Email"', 'Focused'),
        slimify('Tapped <a> "Login" at (10, 20)', 'Tapped'),
      ];
      for (const out of cases) {
        expect(out.length).toBeLessThan(20);
      }
    });

    it('non-slim mode still emits the verbose, debug-friendly messages', () => {
      delete process.env.CDP_SLIM_MODE;
      const verbose = 'Clicked <div> "Submit" at (320, 482)';
      expect(slimify(verbose, 'Clicked')).toBe(verbose);
    });
  });

  describe('isSlimMode()', () => {
    it('reads from CDP_SLIM_MODE env var', () => {
      process.env.CDP_SLIM_MODE = 'true';
      expect(isSlimMode()).toBe(true);
      process.env.CDP_SLIM_MODE = 'false';
      expect(isSlimMode()).toBe(false);
      delete process.env.CDP_SLIM_MODE;
      expect(isSlimMode()).toBe(false);
    });
  });
});

function countNodes(nodes: AXNode[]): number {
  let n = 0;
  for (const node of nodes) {
    n++;
    if (node.children) n += countNodes(node.children);
  }
  return n;
}
