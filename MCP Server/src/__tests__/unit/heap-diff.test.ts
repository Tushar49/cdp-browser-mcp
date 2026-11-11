/**
 * 5.5 WSC — heap_diff: identity is (constructor, exact self-size); classes
 * NEW / GONE / GROWN / SHRUNK; node/string deltas; a separate ≈ byte-bucket
 * rollup; never any "retained" claim. Fixtures are GENERATED in-test (no
 * _archive paths — promote-safe).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { diffHeapSnapshots } from '../../utils/heap-insights.js';

interface CtorFixture {
  name: string;
  type?: 'object' | 'array' | 'closure';
  size: number;
  count: number;
}

/** Minimal valid .heapsnapshot (flat nodes, zero edges). */
function buildSnapshot(ctors: CtorFixture[]): string {
  const nodeFields = ['type', 'name', 'id', 'self_size', 'edge_count'];
  const typeNames = ['hidden', 'array', 'string', 'object', 'code', 'closure'];
  const strings = ['', ...ctors.map((c) => c.name)];
  const rows: number[][] = [];
  // synthetic root
  rows.push([typeNames.indexOf('object'), 0, 0, 0, 0]);
  let id = 1;
  ctors.forEach((c, ci) => {
    const typeIdx = typeNames.indexOf(c.type ?? 'object');
    for (let i = 0; i < c.count; i++) {
      rows.push([typeIdx, ci + 1, id++, c.size, 0]);
    }
  });
  const total = ctors.reduce((s, c) => s + c.size * c.count, 0);
  return JSON.stringify({
    snapshot: {
      meta: {
        node_fields: nodeFields,
        node_types: [typeNames, [], [], [], [], []],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [[], [], []],
      },
      node_count: rows.length,
      edge_count: 0,
      total_self_size: total,
    },
    nodes: rows.flat(),
    edges: [],
    strings,
  });
}

function writeSnapshots(a: CtorFixture[], b: CtorFixture[]): { dir: string; a: string; b: string } {
  const dir = mkdtempSync(join(tmpdir(), 'heap-diff-'));
  const pa = join(dir, 'a.heapsnapshot');
  const pb = join(dir, 'b.heapsnapshot');
  writeFileSync(pa, buildSnapshot(a));
  writeFileSync(pb, buildSnapshot(b));
  return { dir, a: pa, b: pb };
}

describe('heap_diff — self-size identity classes', () => {
  it('classifies NEW / GONE / GROWN / SHRUNK and reports node deltas', async () => {
    const { dir, a, b } = writeSnapshots(
      [
        { name: 'Foo', size: 64, count: 3 },
        { name: 'Bar', size: 128, count: 2 },
        { name: 'Old', size: 32, count: 1 },
      ],
      [
        { name: 'Foo', size: 64, count: 5 },
        { name: 'Bar', size: 128, count: 1 },
        { name: 'New', size: 16, count: 2 },
      ],
    );
    try {
      const d = await diffHeapSnapshots(a, b);
      expect(d.newConstructors).toBe(1);
      expect(d.goneConstructors).toBe(1);
      expect(d.grownConstructors).toBe(1);
      expect(d.shrunkConstructors).toBe(1);
      expect(d.nodeCountDelta).toBe(2); // 6 rows → 8 rows (incl. root each)
      expect(d.output).toContain('[NEW] New (object): ×2 new');
      expect(d.output).toContain('[GONE] Old (object): ×1 gone');
      expect(d.output).toContain('[GROWN] Foo (object): ×3 → ×5');
      expect(d.output).toContain('[SHRUNK] Bar (object): ×2 → ×1');
      expect(d.output).toContain('sizes: 64B ×+2');
      expect(d.output).toContain('nodes: 7 → 9'); // root + instances
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exact-size identity: a same-constructor size shift is GROWN with a per-size breakdown (no fake match)', async () => {
    const { dir, a, b } = writeSnapshots(
      [{ name: 'Widget', size: 64, count: 4 }],
      [{ name: 'Widget', size: 96, count: 4 }],
    );
    try {
      const d = await diffHeapSnapshots(a, b);
      expect(d.grownConstructors).toBe(1);
      expect(d.output).toContain('[GROWN] Widget (object): ×4 → ×4');
      expect(d.output).toContain('sizes: 64B ×-4, 96B ×+4');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders the ≈ byte-bucket rollup separately and never claims "retained"', async () => {
    const { dir, a, b } = writeSnapshots(
      [{ name: 'A', size: 64, count: 2 }],
      [{ name: 'A', size: 64, count: 2 }, { name: 'B', size: 4096, count: 1 }],
    );
    try {
      const d = await diffHeapSnapshots(a, b);
      expect(d.output).toContain('"retained" NOT claimed');
      expect(d.output).toContain('(≈) Byte-bucket rollup');
      expect(d.output).toContain('64B–128B');
      expect(d.output).toContain('4KB–8KB');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('identical snapshots report zero class changes', async () => {
    const same: CtorFixture[] = [{ name: 'Same', size: 48, count: 3 }];
    const { dir, a, b } = writeSnapshots(same, same);
    try {
      const d = await diffHeapSnapshots(a, b);
      expect(d.newConstructors + d.goneConstructors + d.grownConstructors + d.shrunkConstructors).toBe(0);
      expect(d.nodeCountDelta).toBe(0);
      expect(d.output).toContain('Top 0 of 0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('string-table delta is reported', async () => {
    const { dir, a, b } = writeSnapshots(
      [{ name: 'Only', size: 32, count: 1 }],
      [{ name: 'Only', size: 32, count: 1 }, { name: 'Extra', size: 32, count: 1 }],
    );
    try {
      const d = await diffHeapSnapshots(a, b);
      expect(d.stringCountDelta).toBe(1);
      expect(d.output).toContain('strings: 2 → 3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing file fails actionably (not a fake empty diff)', async () => {
    const { dir, b } = writeSnapshots([{ name: 'X', size: 8, count: 1 }], []);
    try {
      await expect(diffHeapSnapshots(join(dir, 'nope.heapsnapshot'), b)).rejects.toThrow(/File not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
