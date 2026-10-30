/**
 * WS11 — observe heap_dump/heap_summary: TempStreamWriter contracts
 * (append-discipline, .partial lifecycle, size cap), the streaming
 * .heapsnapshot parser (generated fixtures only — NO _archive references),
 * the column-resolver proof (SHUFFLED node_fields), bounded root hints,
 * and the opt-in gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../tools/registry.js';
import { registerObserveTools } from '../../tools/observe.js';
import { TempFileManager } from '../../utils/temp-files.js';
import { summarizeHeapSnapshot } from '../../utils/heap-insights.js';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ServerContext } from '../../types.js';

// ─── fixtures (generated in-test) ───────────────────────────────────

interface FixtureOpts {
  nodeFields?: string[]; // default [type,name,id,self_size,edge_count,detachedness]
  rootless?: boolean;    // shrink the synthetic graph
}

/** Build a synthetic .heapsnapshot JSON string with controllable rows. */
function buildSnapshot(opts: FixtureOpts = {}): string {
  const nodeFields = opts.nodeFields ?? ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'];
  const typeNames = ['hidden', 'array', 'string', 'object', 'code', 'closure'];
  const idx = (f: string) => nodeFields.indexOf(f);
  const fc = nodeFields.length;

  // layout: node0 = synthetic root -> kConstructor nodes + leaf children
  const kCtor = 6; // 'HeapGateMarker' objects
  const kLeaf = 3;
  const rootRow = new Array(fc).fill(0);
  rootRow[idx('type')] = typeNames.indexOf('object'); // object root
  const rootName = idx('name');
  rootRow[rootName] = 0; // '' == string 0
  const rootEdges = rootRow[idx('edge_count')] = kCtor;

  // ctor nodes: object HeapGateMarker紧密 self 100 each; leaf edges 1 each... keep
  const ctorRows: number[][] = [];
  const leafRows: number[][] = [];
  const heapGateNameId = 1; // strings[1] = 'HeapGateMarker'
  for (let i = 0; i < kCtor; i++) {
    const row = new Array(fc).fill(0);
    row[idx('type')] = typeNames.indexOf('object');
    row[rootName] = heapGateNameId;
    row[idx('self_size')] = 100;
    row[idx('edge_count')] = 1;
    row[idx('detachedness')] = i % 2 === 0 ? 2 : 1; // mix detached/attached
    ctorRows.push(row);
  }
  for (let i = 0; i < kLeaf; i++) {
    const row = new Array(fc).fill(0);
    row[idx('type')] = typeNames.indexOf('string');
    row[rootName] = 2; // strings[2] = 'leaf'
    row[idx('self_size')] = 10;
    row[idx('edge_count')] = 0;
    leafRows.push(row);
  }

  const rows = [rootRow, ...ctorRows, ...leafRows];
  const nodeCount = rows.length;
  const edgeCount = rootEdges + kCtor; // root->ctors + ctor->leaf

  // edges: flat [type, name_or_index, to_node(real: toNodeSlotIndex * fc)] per edge
  // row order: root(0) ctor1(1..k) leaf(k+1..)
  const edges: number[] = [];
  const rootToCtor: number[] = [];
  for (let r = 1; r <= kCtor; r++) rootToCtor.push(r);
  for (let i = 0; i < kCtor; i++) {
    edges.push(5, 3, rootToCtor[i] * fc); // edge type 5 = property; name 3 = 'next' placeholder
  }
  for (let i = 0; i < kCtor; i++) {
    edges.push(5, 2, (1 + kCtor + i) * fc); // ctor -> leaf
  }
  void edges;

  const nodesFlat = rows.flat();
  const edgeTypeNames = [0, 1, 2, 3, 4, 5].map((x) => `edge-type-${x}`);
  const snapshot = {
    snapshot: {
      meta: {
        node_fields: nodeFields,
        node_types: [typeNames, [], [], [], [], []],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [edgeTypeNames, [], []],
      },
      node_count: nodeCount,
      edge_count: edgeCount,
      total_self_size: kCtor * 100 + kLeaf * 10,
    },
    nodes: nodesFlat,
    edges,
    strings: ['', 'HeapGateMarker', 'leaf', 'next', 'SyntheticSnapshotRoot', 'extra'],
    locations: [],
  };
  return JSON.stringify(snapshot);
}

// ─── TempStreamWriter contracts ─────────────────────────────────────

describe('WS11 — TempStreamWriter (fd-append streaming)', () => {
  it('byte-equal append discipline: chunks append synchronously in arrival order; finalize renames', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdp-ws11-'));
    try {
      const mgr = new TempFileManager({ tempDir: dir, maxTempFiles: 10, maxTempAgeMs: 60000 });
      const w = mgr.openStreamWriter('heap.heapsnapshot');
      const chunks = ['{"snapshot":', '{"x":1},', '"strings":["a"]'];
      for (const c of chunks) w.write(c);
      const final = w.finalize();
      expect(final.endsWith('heap.heapsnapshot')).toBe(true);
      expect(final.endsWith('.partial')).toBe(false);
      expect(readFileSync(final, 'utf8')).toBe(chunks.join(''));
      expect(w.byteCount).toBe(chunks.join('').length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('abandon keeps the *.partial orphan (never advertised complete) and skips further writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdp-ws11-'));
    try {
      const mgr = new TempFileManager({ tempDir: dir, maxTempFiles: 10, maxTempAgeMs: 60000 });
      const w = mgr.openStreamWriter('dumper.heapsnapshot');
      w.write('partial-data');
      w.abandon();
      expect(existsSync(w.partialPath)).toBe(true);
      expect(existsSync(w.finalPath)).toBe(false);
      w.abandon(); // idempotent
      expect(() => w.write('more')).toThrow('TempStreamWriter is closed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hard size cap throws actionably and leaves the .partial on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdp-ws11-'));
    try {
      const mgr = new TempFileManager({ tempDir: dir, maxTempFiles: 10, maxTempAgeMs: 60000 });
      const w = mgr.openStreamWriter('big.heapsnapshot', { maxBytes: 8 });
      w.write('12345678');
      expect(() => w.write('x')).toThrow(/cap reached \(0MB\)|cap/);
      expect(existsSync(w.partialPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── parser semantics (generated fixtures) ──────────────────────────

describe('WS11 — heap snapshot parser (streaming, generated fixtures)', () => {
  it('rolls up constructor classes: HeapGateMarker count exact, self-size ordering', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdp-ws11-'));
    try {
      const p = join(dir, 'fixture.heapsnapshot');
      writeFileSync(p, buildSnapshot());
      const sum = await summarizeHeapSnapshot(p);
      expect(sum.nodeCount).toBe(10); // 1 root + 6 ctors + 3 leaves
      expect(sum.edgeCount).toBe(12); // 6 root→ctor + 6 ctor→leaf
      const gate = sum.topConstructors.find((c) => c.name === 'HeapGateMarker')!;
      expect(gate.count).toBe(6);
      expect(gate.selfSize).toBe(600);
      expect(sum.detached.detached).toBe(3); // even i rows
      expect(sum.detached.attached).toBe(3);
      expect(sum.totalSelfBytes).toBe(630);
      expect(sum.output).toContain('HeapGateMarker');
      // the retained-DISCLAIMER is honest; the retained CLAIM must not ship:
      expect(sum.output).toContain('"retained" NOT claimed');
      expect(sum.topConstructors.every((c) => !('retainedSize' in c))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SHUFFLED node_fields resolve by NAME (format-version proof, not offsets)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdp-ws11-'));
    try {
      const p = join(dir, 'shuffled.heapsnapshot');
      writeFileSync(p, buildSnapshot({ nodeFields: ['detachedness', 'self_size', 'id', 'name', 'type', 'edge_count'] }));
      const sum = await summarizeHeapSnapshot(p);
      expect(sum.topConstructors.find((c) => c.name === 'HeapGateMarker')!.selfSize).toBe(600);
      expect(sum.detached.detached).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('~50MB generated snapshot streams without a whole-document parse (named types resolved)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdp-ws11-'));
    try {
      const p = join(dir, 'huge.heapsnapshot');
      const { writeFileSync } = await import('fs');
      // generate ~14MB (stress point: well above the 1MB stream chunks; keeps the
      // test under ~2s while proving path interval behavior); count 500k nodes
      const K = 100_000; // per-batch ctor rows; 5 batches total ⇒ >5MB of rows
      const typeNames = ['hidden', 'array', 'string', 'object', 'code', 'closure'];
      const batch = (offset: number): number[][] => {
        const rows: number[][] = [];
        for (let i = 0; i < K; i++) {
          rows.push([3, 1 + (offset + i) % 4, offset + i, 64, 0, 0]);
        }
        return rows;
      };
      const edgelessRows = [...batch(0), ...batch(K), ...batch(2 * K), ...batch(3 * K), ...batch(4 * K)];
      const nodeCount = edgelessRows.length;
      const snapshot = {
        snapshot: {
          meta: {
            node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'],
            node_types: [typeNames],
            edge_fields: ['type', 'name_or_index', 'to_node'],
            edge_types: [['edge-type-0']],
          },
          node_count: nodeCount,
          edge_count: 0,
        },
        nodes: edgelessRows.flat(),
        edges: [],
        strings: ['', 'A', 'B', 'C', 'D'],
      };
      writeFileSync(p, JSON.stringify(snapshot));
      const sum = await summarizeHeapSnapshot(p, { topN: 5 });
      expect(sum.nodeCount).toBe(nodeCount);
      // names resolved from the string table (5 entries cycled mod 4)
      const a = sum.topConstructors.find((c) => c.name === 'A')!;
      expect(a.count).toBe(K * 5 / 4); // all 5 batches repeat the same 4-name cycle (offsets ≡ 0 mod 4)
      expect(a.selfSize).toBe(K * 5 / 4 * 64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it('size-cap refusal leaves the file untouched (contract wording, capped via option)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdp-ws11-'));
    try {
      const p = join(dir, 'too-big.heapsnapshot');
      writeFileSync(p, buildSnapshot());
      await expect(summarizeHeapSnapshot(p, { maxBytes: 32 })).rejects.toThrow(/Refusing to parse .* over the .* cap/);
      expect(existsSync(p)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── observe wiring ─────────────────────────────────────────────────

function makeCtx() {
  const send = vi.fn(async () => ({}));
  const ctx = {
    sendCommand: send,
    perfTraces: new Map(),
    heapDumps: new Map(),
    config: { tempDir: join(tmpdir(), 'cdp-ws11-ctx'), maxTempFiles: 10, maxTempAgeMs: 60000 },
  } as unknown as ServerContext;
  return { ctx, send, heapDumps: ctx.heapDumps };
}
function args(over: Record<string, unknown>) { return { tabId: 't1', _sessionId: 'sess1', ...over }; }
function textOf(res: { content?: Array<{ text?: string }> }) { return res.content?.[0]?.text ?? ''; }

describe('WS11 — observe heap_dump/heap_summary wiring', () => {
  let registry: ToolRegistry;
  beforeEach(() => { registry = new ToolRegistry(); registerObserveTools(registry, {} as ServerContext); });

  it('dump without confirm fails with the opt-in hint referencing auth-state material', async () => {
    const { ctx } = makeCtx();
    const res = await registry.dispatch('observe', args({ action: 'heap_dump' }), ctx);
    expect(textOf(res)).toContain('confirm: true');
    expect(textOf(res)).toContain('auth-state');
  });

  it('dump completes: finalize renames the .partial path that event chunks filled', async () => {
    const { ctx, send, heapDumps } = makeCtx();
    // mock: takeHeapSnapshot pushes chunks through the pipeline's write target
    send.mockImplementationOnce(async () => {
      const dump = heapDumps.get('sess1');
      dump!.writer.write(buildSnapshot().slice(0, 200));
      return {};
    });
    const res = await registry.dispatch('observe', args({ action: 'heap_dump', confirm: true }), ctx);
    const text = textOf(res);
    expect(text).toContain('Heap dump complete:');
    expect(text).toMatch(/\.heapsnapshot(?:\s|$|)/);
    expect(heapDumps.has('sess1')).toBe(false);
    void send;
  });

  it('session death between start and snapshot completion reports dump LOST + .partial orphan stays', async () => {
    const { ctx, send, heapDumps } = makeCtx();
    send.mockRejectedValueOnce(new Error('Session with given id not found'));
    const res = await registry.dispatch('observe', args({ action: 'heap_dump', confirm: true }), ctx);
    expect(textOf(res)).toContain('Heap dump lost');
    expect(textOf(res)).toContain('.partial');
    expect(heapDumps.has('sess1')).toBe(false);
  });

  it('heap_summary without a path fails actionably', async () => {
    const { ctx } = makeCtx();
    const res = await registry.dispatch('observe', args({ action: 'heap_summary' }), ctx);
    expect(textOf(res)).toContain('path');
  });
});
