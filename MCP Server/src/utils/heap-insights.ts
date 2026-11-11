/**
 * Heap snapshot offline summary (5.4 WS11).
 *
 * Parses `.heapsnapshot` files (Chromium `HeapProfiler.takeHeapSnapshot`
 * format: JSON object — "snapshot" header, flat "nodes" int array, flat
 * "edges" int array, "strings" table, then remainder) WITHOUT ever
 * materializing the parsed document: an incremental chunked char-stepper
 * converts int tokens straight into preallocated typed arrays sized from
 * the header, so a 50MB+ snapshot stays bounded in RAM. Zero deps (law).
 * Unit tests use a GENERATED fixture (no _archive paths — promote-safe).
 *
 * SEMANTICS (locked by the plan): SELF-size rollups + constructor top-N +
 * bounded-depth GC-root path hints over the edge table. The word
 * "retained" is NOT shipped — true retained size needs a dominator tree
 * (plan risk row: not in this cycle). Column indices are resolved from
 * `meta.node_fields` NAMES — the newer detachedness-era 6-field format
 * (WS7 batch-c artifact) and older 5-field dumps both parse; a
 * SHUFFLED-field fixture proves the resolver.
 */

import { existsSync, statSync, createReadStream } from 'fs';

/** Hard input cap — the parse refuses and leaves the file untouched. */
export const HEAP_SNAPSHOT_MAX_BYTES = 500 * 1024 * 1024;

/** Memory guard for the strings table. */
export const MAX_STRINGS = 2_000_000;

export interface HeapSummaryOptions {
  topN?: number;
  hintDepth?: number;
  hintBudget?: number;
  /**
   * Byte cap override (default HEAP_SNAPSHOT_MAX_BYTES). Internal/test
   * surface — the public contract wording is identical for any cap.
   */
  maxBytes?: number;
}

export interface HeapSummary {
  output: string;
  nodeCount: number;
  edgeCount: number;
  totalSelfBytes: number;
  topConstructors: Array<{ type: string; name: string; count: number; selfSize: number }>;
  byType: Array<{ type: string; count: number; selfSize: number }>;
  detached: { unknown: number; attached: number; detached: number };
}

interface Tables {
  nodeFields: string[];
  nodeTypes: string[][];
  edgeFields: string[];
  nodes: Int32Array;
  nodeRows: number;
  edges: Int32Array;
  edgeRows: number;
  stringTable: string[];
  headerNodeCount: number;
  headerEdgeCount: number;
}

// ─── 1. incremental scanner ─────────────────────────────────────────

/**
 * ONE-PASS char stepper over the whole document. State machine spanning
 * chunk boundaries (the stream supplies decoded strings). Guarantees:
 * - nodes/edges land in Int32Arrays allocated from the header
 *   (node_count/edge_count) — bounded RAM by construction
 * - the "snapshot" header is the only JSON.parse'd subtotal (few KB)
 * - "strings" is lexed escape-aware with a hard per-entry cap
 * - every other top-level value is SKIPPED string-aware (no buffering)
 */
class Scanner {
  state:
    | 'top' | 'key' | 'colon' | 'header' | 'nums'
    | 'strings' | 'string' | 'esc' | 'hex4'
    | 'skipScalar' | 'skipContainer' | 'skipStr' | 'skipStrEsc' = 'top';
  private key = '';
  private headerBuf = '';
  private hdepth = 0;
  private sdepth = 0;
  private numTok = '';
  private curIsNodes = false;
  private fieldCount = 0;
  private arr: Int32Array | null = null;
  private written = 0;
  private strAcc = '';
  private hexAcc = '';
  private fileDone = false;

  nodesArr: Int32Array | null = null;
  edgesArr: Int32Array | null = null;
  nodesRows = 0;
  edgesRows = 0;
  stringTable: string[] = [];
  meta: {
    node_fields: string[];
    node_types: string[][];
    edge_fields: string[];
    node_count: number;
    edge_count: number;
  } | null = null;
  headerSeen = false;
  stringsSeen = false;

  feed(chunk: string): void {
    for (const ch of chunk) {
      if (this.fileDone) return;
      this.step(ch);
    }
  }

  done(): void {
    this.commit();
    this.fileDone = true;
  }

  private step(ch: string): void {
    switch (this.state) {
      case 'top': {
        if (ch === '"') { this.key = ''; this.state = 'key'; }
        break;
      }
      case 'key': {
        if (ch === '"') { this.state = 'colon'; }
        else this.key += ch;
        break;
      }
      case 'colon': {
        if (ch !== ':') break;
        this.state = 'top';
        if (this.key === 'snapshot') { this.headerBuf = ''; this.hdepth = 0; this.state = 'header'; }
        else if (this.key === 'nodes') { this.startNumbers(true); }
        else if (this.key === 'edges') { this.startNumbers(false); }
        else if (this.key === 'strings') { this.stringTableInit(); }
        else { this.sdepth = 0; this.state = 'skipScalar'; }
        break;
      }
      case 'header': {
        this.headerBuf += ch;
        if (ch === '{' || ch === '[') this.hdepth = this.hdepth === 0 ? 1 : this.hdepth + 1;
        else if ((ch === '}' || ch === ']') && this.hdepth > 0) {
          this.hdepth--;
          if (this.hdepth === 0) { this.headerComplete(); this.state = 'top'; }
        }
        break;
      }
      case 'nums': {
        if (ch === ',' || ch === ']') {
          this.commit();
          if (ch === ']') { this.arr = null; this.state = 'top'; }
        } else if (ch >= '0' && ch <= '9') { this.numTok += ch; }
        else if (ch === '-') { this.numTok += ch; }
        else if (this.numTok) { this.commit(); }
        break;
      }
      case 'strings': {
        if (ch === '"') { this.strAcc = ''; this.state = 'string'; }
        else if (ch === ']') { this.stringsSeen = true; this.state = 'top'; }
        break;
      }
      case 'string': {
        if (ch === '\\') { this.state = 'esc'; }
        else if (ch === '"') {
          this.pushEntry(this.strAcc);
          this.strAcc = '';
          this.state = 'strings';
        } else this.strAcc += ch;
        break;
      }
      case 'esc': {
        if (ch === 'u') { this.hexAcc = ''; this.state = 'hex4'; }
        else {
          this.strAcc += ch === 'n' ? '\n' : ch === 't' ? '\t' : ch === 'r' ? '\r' : ch;
          this.state = 'string';
        }
        break;
      }
      case 'hex4': {
        this.hexAcc += ch;
        if (this.hexAcc.length === 4) {
          this.strAcc += String.fromCharCode(parseInt(this.hexAcc, 16));
          this.hexAcc = '';
          this.state = 'string';
        }
        break;
      }
      case 'skipScalar': {
        if (ch === ',') { this.state = 'top'; }
        else if (ch === '{' || ch === '[') { this.sdepth = 1; this.state = 'skipContainer'; }
        else if (ch === '"') { this.state = 'skipStr'; }
        // '}' closes the root document — tolerated silently
        break;
      }
      case 'skipContainer': {
        if (ch === '{' || ch === '[') this.sdepth++;
        else if (ch === '}' || ch === ']') {
          this.sdepth--;
          if (this.sdepth === 0) this.state = 'top';
        } else if (ch === '"') { this.state = 'skipStr'; }
        break;
      }
      case 'skipStr': {
        if (ch === '\\') { this.state = 'skipStrEsc'; }
        else if (ch === '"') { this.state = this.sdepth > 0 ? 'skipContainer' : 'skipScalar'; }
        break;
      }
      case 'skipStrEsc': {
        this.state = this.sdepth > 0 ? 'skipContainer' : 'skipScalar';
        break;
      }
    }
  }

  private startNumbers(isNodes: boolean): void {
    this.curIsNodes = isNodes;
    this.fieldCount = isNodes ? (this.meta?.node_fields.length ?? 0) : (this.meta?.edge_fields.length ?? 0);
    this.arr = isNodes ? this.nodesArr : this.edgesArr;
    this.written = 0;
    this.numTok = '';
    this.state = 'nums';
  }

  private commit(): void {
    if (this.numTok === '') return;
    const n = parseInt(this.numTok, 10);
    this.numTok = '';
    if (Number.isNaN(n) || !this.arr || this.fieldCount === 0) return;
    if (this.written >= this.arr.length) return;
    this.arr[this.written] = n;
    if ((this.written + 1) % this.fieldCount === 0) {
      if (this.curIsNodes) this.nodesRows = (this.written + 1) / this.fieldCount;
      else this.edgesRows = (this.written + 1) / this.fieldCount;
    }
    this.written++;
  }

  private headerComplete(): void {
    const parsed = JSON.parse(this.headerBuf) as {
      meta: { node_fields: string[]; node_types: string[][]; edge_fields: string[] };
      node_count?: number;
      edge_count?: number;
    };
    if (!parsed?.meta?.node_fields) throw new Error('Malformed .heapsnapshot header (no meta.node_fields).');
    const nodeFields = parsed.meta.node_fields;
    const edgeFields = parsed.meta.edge_fields ?? [];
    const nodesCap = (parsed.node_count ?? 0) * nodeFields.length;
    const edgesCap = (parsed.edge_count ?? 0) * Math.max(1, edgeFields.length);
    this.nodesArr = new Int32Array(nodesCap);
    this.edgesArr = new Int32Array(edgesCap);
    this.meta = {
      node_fields: nodeFields,
      node_types: parsed.meta.node_types ?? [],
      edge_fields: edgeFields,
      node_count: parsed.node_count ?? 0,
      edge_count: parsed.edge_count ?? 0,
    };
    this.headerSeen = true;
  }

  private stringTableInit(): void {
    this.stringTable = [];
    this.state = 'strings';
  }

  private pushEntry(s: string): void {
    if (this.stringTable.length < MAX_STRINGS) {
      this.stringTable.push(s.length > 65_536 ? s.slice(0, 65_536) : s);
    }
  }

  finish(): Tables {
    this.commit();
    return {
      nodeFields: this.meta?.node_fields ?? [],
      nodeTypes: this.meta?.node_types ?? [],
      edgeFields: this.meta?.edge_fields ?? [],
      nodes: this.nodesArr ?? new Int32Array(0),
      nodeRows: this.nodesRows,
      edges: this.edgesArr ?? new Int32Array(0),
      edgeRows: this.edgesRows,
      stringTable: this.stringTable,
      headerNodeCount: this.meta?.node_count ?? 0,
      headerEdgeCount: this.meta?.edge_count ?? 0,
    };
  }
}

// ─── 2. scan driver ─────────────────────────────────────────────────

async function scanTables(filePath: string, maxBytes = HEAP_SNAPSHOT_MAX_BYTES): Promise<Tables> {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const size = statSync(filePath).size;
  if (size > maxBytes) {
    throw new Error(`Refusing to parse ${(size / 1048576).toFixed(0)}MB — over the ${(maxBytes / 1048576).toFixed(0)}MB cap. The file stays on disk untouched.`);
  }
  const scanner = new Scanner();
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 });
    stream.on('data', (piece) => {
      try { scanner.feed(piece as string); } catch (e) { stream.destroy(); reject(e); }
    });
    stream.on('end', () => { try { scanner.done(); resolve(); } catch (e) { reject(e); } });
    stream.on('error', reject);
  });
  const t = scanner.finish();
  if (t.nodeFields.length === 0) throw new Error('Not a .heapsnapshot file (no snapshot header).');
  if (t.nodeRows === 0) throw new Error('Truncated .heapsnapshot (zero node rows scanned).');
  return t;
}

// ─── 3. summarizer (pure, over the scanned tables) ─────────────────

export function summarizeTables(t: Tables, opts: HeapSummaryOptions = {}): { output: string; summary: HeapSummary } {
  const colIdx = (field: string): number => {
    const i = t.nodeFields.indexOf(field);
    if (i === -1) throw new Error(`node_fields has no '${field}' column — unknown format version.`);
    return i;
  };
  const typeIdx = colIdx('type');
  const nameIdx = colIdx('name');
  const selfIdx = colIdx('self_size');
  const edgeCountIdx = t.nodeFields.indexOf('edge_count');
  const detachIdx = t.nodeFields.indexOf('detachedness');
  const typeNames = t.nodeTypes[0] ?? [];

  const rows = t.nodeRows;
  const byType = new Map<string, { count: number; selfSize: number }>();
  const byCtor = new Map<string, { type: string; name: string; count: number; selfSize: number }>();
  const detachedCounter = { unknown: 0, attached: 0, detached: 0 };
  let totalSelf = 0;
  for (let r = 0; r < rows; r++) {
    const off = r * t.nodeFields.length;
    const type = typeNames[t.nodes[off + typeIdx]] ?? String(t.nodes[off + typeIdx]);
    const nameId = t.nodes[off + nameIdx];
    const selfSize = t.nodes[off + selfIdx];
    totalSelf += selfSize;
    if (detachIdx !== -1) {
      const dv = t.nodes[off + detachIdx];
      if (dv === 0) detachedCounter.unknown++;
      else if (dv === 1) detachedCounter.attached++;
      else detachedCounter.detached++;
    }
    const ty = byType.get(type) ?? { count: 0, selfSize: 0 };
    ty.count++; ty.selfSize += selfSize;
    byType.set(type, ty);
    if (type === 'object' || type === 'closure' || type === 'array') {
      const name = nameId < t.stringTable.length ? t.stringTable[nameId] : `<str:${nameId}>`;
      const k = `${type}\u0000${name}`;
      const c = byCtor.get(k) ?? { type, name, count: 0, selfSize: 0 };
      c.count++; c.selfSize += selfSize;
      byCtor.set(k, c);
    }
  }

  const top = [...byCtor.values()].sort((a, b) => b.selfSize - a.selfSize).slice(0, opts.topN ?? 25);
  const toNodeIdx = t.edgeFields.indexOf('to_node'); // -1 tolerated: hints return [] when absent
  const hints = rootHints(t, toNodeIdx, new Set(top.slice(0, 8).map((c) => c.name)), opts.hintDepth ?? 3, opts.hintBudget ?? 4000);

  const out: string[] = [];
  out.push('Heap snapshot summary (self-size semantics; "retained" NOT claimed — no dominator tree shipped):');
  out.push(`nodes: ${rows} (header ${t.headerNodeCount}) | edges: ${t.edgeRows} rows (header ${t.headerEdgeCount}) | strings: ${t.stringTable.length} | self total: ${(totalSelf / 1048576).toFixed(1)}MB`);
  if (detachIdx !== -1) {
    out.push(`detachedness: unknown ${detachedCounter.unknown} | attached ${detachedCounter.attached} | detached ${detachedCounter.detached}`);
  }
  out.push('');
  out.push('Top constructors by self size:');
  for (const c of top) {
    const sz = c.selfSize >= 1024 ? `${(c.selfSize / 1024).toFixed(1)}KB` : `${c.selfSize}B`;
    out.push(`- ${c.name} (${c.type}): ×${c.count} — self ${sz}`);
  }
  if (hints.length > 0) {
    out.push('');
    out.push(`GC-root paths to top offenders (BFS depth ≤ ${opts.hintDepth ?? 3}):`);
    for (const h of hints.slice(0, 8)) out.push(h);
  }
  if (t.stringTable.length === 0) {
    out.push('(strings table empty — constructor names unresolved; truncated file?)');
  }

  return {
    output: out.join('\n'),
    summary: {
      output: out.join('\n'),
      nodeCount: rows,
      edgeCount: t.edgeRows,
      totalSelfBytes: totalSelf,
      topConstructors: top,
      byType: [...byType.entries()].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.selfSize - a.selfSize),
      detached: detachedCounter,
    },
  };
}

/** First bounded-depth GC-root paths to each self-size-heavy offender. */
function rootHints(
  t: Tables,
  toNodeIdx: number,
  targetNames: Set<string>,
  depth: number,
  budget: number,
): string[] {
  if (t.edgeRows === 0 || toNodeIdx === -1 || t.edgeFields.length === 0 || targetNames.size === 0) return [];
  const ef = t.edgeFields.length;
  const nf = t.nodeFields.length;
  const edgeCounts = new Int32Array(t.nodeRows);
  for (let r = 0; r < t.nodeRows; r++) edgeCounts[r] = t.nodes[r * nf + t.nodeFields.indexOf('edge_count')];
  const offsets = new Int32Array(t.nodeRows + 1);
  let total = 0;
  for (let r = 0; r < t.nodeRows; r++) { offsets[r] = total; total += edgeCounts[r]; }
  offsets[t.nodeRows] = total;

  const nodeName = (r: number): string => {
    const nmId = t.nodes[r * nf + t.nodeFields.indexOf('name')];
    return nmId < t.stringTable.length ? t.stringTable[nmId] : `<str:${nmId}>`;
  };

  const found: string[] = [];
  const foundNames = new Set<string>();
  const visited = new Set<number>([0]);
  let queue: Array<{ node: number; path: string[] }> = [{ node: 0, path: ['(GC roots)'] }];
  for (let d = 0; d < depth && queue.length > 0; d++) {
    const next: Array<{ node: number; path: string[] }> = [];
    let visits = budget;
    for (const item of queue) {
      if (visits-- <= 0) break;
      const eo = offsets[item.node] ?? 0;
      const count = edgeCounts[item.node] ?? 0;
      for (let e = eo; e < eo + count; e++) {
        const slot = t.edges[e * ef + toNodeIdx];
        if (slot < 0 || slot >= t.nodeRows * nf) continue;
        const target = slot / nf;
        if (visited.has(target)) continue;
        visited.add(target);
        const path = [...item.path, nodeName(target)];
        const nm = path[path.length - 1];
        if (targetNames.has(nm) && !foundNames.has(nm)) {
          foundNames.add(nm);
          found.push(`- ${path.join(' → ')}`);
        }
        if (next.length < budget) next.push({ node: target, path });
      }
    }
    queue = next;
  }
  return found;
}

// ─── 4. public entry ────────────────────────────────────────────────

export async function summarizeHeapSnapshot(
  filePath: string,
  opts: HeapSummaryOptions = {},
): Promise<HeapSummary> {
  const t = await scanTables(filePath, opts.maxBytes);
  const { summary } = summarizeTables(t, opts);
  return summary;
}

// ─── 5. heap_diff (5.5 WSC) ─────────────────────────────────────────

export interface HeapDiffOptions {
  /** Max constructor-change rows rendered (default 15). */
  topN?: number;
  /** Per-file byte cap override (internal/test surface). */
  maxBytes?: number;
}

export interface HeapDiffResult {
  output: string;
  newConstructors: number;
  goneConstructors: number;
  grownConstructors: number;
  shrunkConstructors: number;
  nodeCountDelta: number;
  stringCountDelta: number;
}

interface CtorStat {
  type: string;
  name: string;
  count: number;
  selfBytes: number;
  /** Exact self-size → instance count (identity is never node-ids). */
  sizes: Map<number, number>;
}

interface IdentityRollup {
  ctors: Map<string, CtorStat>;
  /** Coarse log2 byte bucket → totals (rendered separately as ≈). */
  buckets: Map<number, { count: number; bytes: number }>;
  nodeCount: number;
  stringCount: number;
  totalSelf: number;
}

/**
 * Scan ONE snapshot into identity rollups and drop the raw tables before
 * the caller scans the second file — two full Int32 tables are never held
 * simultaneously (heap_diff on two large dumps stays bounded).
 */
async function scanIdentity(filePath: string, maxBytes = HEAP_SNAPSHOT_MAX_BYTES): Promise<IdentityRollup> {
  const t = await scanTables(filePath, maxBytes);
  const idx = (name: string): number => {
    const i = t.nodeFields.indexOf(name);
    if (i === -1) throw new Error(`node_fields has no '${name}' column — unknown format version.`);
    return i;
  };
  const typeIdx = idx('type');
  const nameIdx = idx('name');
  const selfIdx = idx('self_size');
  const typeNames = t.nodeTypes[0] ?? [];

  const ctors = new Map<string, CtorStat>();
  const buckets = new Map<number, { count: number; bytes: number }>();
  let totalSelf = 0;

  for (let r = 0; r < t.nodeRows; r++) {
    const off = r * t.nodeFields.length;
    const type = typeNames[t.nodes[off + typeIdx]] ?? String(t.nodes[off + typeIdx]);
    const nameId = t.nodes[off + nameIdx];
    const name = nameId < t.stringTable.length ? t.stringTable[nameId] : `<str:${nameId}>`;
    const selfSize = t.nodes[off + selfIdx];
    totalSelf += selfSize;

    const bucket = selfSize <= 0 ? 0 : Math.floor(Math.log2(selfSize));
    const b = buckets.get(bucket) ?? { count: 0, bytes: 0 };
    b.count++; b.bytes += selfSize;
    buckets.set(bucket, b);

    if (type === 'object' || type === 'closure' || type === 'array') {
      const key = `${type}\u0000${name}`;
      const c = ctors.get(key) ?? { type, name, count: 0, selfBytes: 0, sizes: new Map<number, number>() };
      c.count++; c.selfBytes += selfSize;
      c.sizes.set(selfSize, (c.sizes.get(selfSize) ?? 0) + 1);
      ctors.set(key, c);
    }
  }

  return { ctors, buckets, nodeCount: t.nodeRows, stringCount: t.stringTable.length, totalSelf };
}

function fmtBytes(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1048576) return `${(n / 1048576).toFixed(2)}MB`;
  if (abs >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function bucketLabel(pow: number): string {
  const lo = pow <= 0 ? 0 : Math.pow(2, pow);
  const hi = Math.pow(2, pow + 1);
  const f = (x: number): string => (x >= 1024 ? `${x / 1024}KB` : `${x}B`);
  return `${f(lo)}–${f(hi)}`;
}

/**
 * Diff two `.heapsnapshot` files by self-size semantics (5.5 WSC).
 *
 * Identity: constructor (type, name) with an EXACT self-size breakdown —
 * never node ids. Constructors are classified NEW / GONE / GROWN / SHRUNK by
 * total self bytes, with per-exact-size count deltas. A coarse ≈ byte-bucket
 * rollup is rendered separately and never mixed with the exact tables.
 * No dominator tree → "retained" is NOT claimed.
 */
export async function diffHeapSnapshots(
  pathA: string,
  pathB: string,
  opts: HeapDiffOptions = {},
): Promise<HeapDiffResult> {
  const a = await scanIdentity(pathA, opts.maxBytes);
  const b = await scanIdentity(pathB, opts.maxBytes);

  type Row = {
    cls: 'NEW' | 'GONE' | 'GROWN' | 'SHRUNK';
    type: string;
    name: string;
    countA: number;
    countB: number;
    bytesA: number;
    bytesB: number;
    delta: number;
    sizeDelta: string;
  };
  const rows: Row[] = [];
  let newC = 0, goneC = 0, grownC = 0, shrunkC = 0;

  const keys = new Set<string>([...a.ctors.keys(), ...b.ctors.keys()]);
  for (const key of keys) {
    const ca = a.ctors.get(key);
    const cb = b.ctors.get(key);
    const countA = ca?.count ?? 0;
    const countB = cb?.count ?? 0;
    const bytesA = ca?.selfBytes ?? 0;
    const bytesB = cb?.selfBytes ?? 0;
    const delta = bytesB - bytesA;
    let cls: Row['cls'];
    if (!ca) { cls = 'NEW'; newC++; }
    else if (!cb) { cls = 'GONE'; goneC++; }
    else if (delta > 0) { cls = 'GROWN'; grownC++; }
    else if (delta < 0) { cls = 'SHRUNK'; shrunkC++; }
    else continue;

    // Exact-size breakdown of the count change (biggest magnitude first).
    const sizes = new Set<number>([...(ca?.sizes.keys() ?? []), ...(cb?.sizes.keys() ?? [])]);
    const parts: Array<{ size: number; d: number }> = [];
    for (const size of sizes) {
      const nA = ca?.sizes.get(size) ?? 0;
      const nB = cb?.sizes.get(size) ?? 0;
      if (nA !== nB) parts.push({ size, d: nB - nA });
    }
    parts.sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
    const sizeDelta = parts.slice(0, 2).map((p) => `${fmtBytes(p.size)} ×${p.d > 0 ? '+' : ''}${p.d}`).join(', ');

    rows.push({
      cls, type: (cb ?? ca)!.type, name: (cb ?? ca)!.name,
      countA, countB, bytesA, bytesB, delta, sizeDelta,
    });
  }

  rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  const top = rows.slice(0, opts.topN ?? 15);

  const out: string[] = [];
  out.push('Heap diff (self-size semantics; no dominator tree — "retained" NOT claimed):');
  out.push(`A: ${pathA}`);
  out.push(`B: ${pathB}`);
  out.push(`nodes: ${a.nodeCount} → ${b.nodeCount} (Δ ${b.nodeCount - a.nodeCount >= 0 ? '+' : ''}${b.nodeCount - a.nodeCount}) | strings: ${a.stringCount} → ${b.stringCount} (Δ ${b.stringCount - a.stringCount >= 0 ? '+' : ''}${b.stringCount - a.stringCount}) | self total: ${fmtBytes(a.totalSelf)} → ${fmtBytes(b.totalSelf)} (Δ ${b.totalSelf - a.totalSelf >= 0 ? '+' : ''}${fmtBytes(b.totalSelf - a.totalSelf)})`);
  out.push(`constructors: NEW ${newC} | GONE ${goneC} | GROWN ${grownC} | SHRUNK ${shrunkC}`);
  out.push('');
  out.push(`Top ${top.length} of ${rows.length} constructor changes by |self-byte delta| (identity: constructor + exact self-size):`);
  for (const r of top) {
    const sign = r.delta > 0 ? '+' : '';
    const counts = r.cls === 'NEW' ? `×${r.countB} new`
      : r.cls === 'GONE' ? `×${r.countA} gone`
        : `×${r.countA} → ×${r.countB}`;
    const sizes = r.sizeDelta ? ` (sizes: ${r.sizeDelta})` : '';
    out.push(`- [${r.cls}] ${r.name} (${r.type}): ${counts} — self ${sign}${fmtBytes(r.delta)}${sizes}`);
  }

  // Coarse ≈ rollup — separate section, never mixed with exact rows.
  out.push('');
  out.push('(≈) Byte-bucket rollup (coarse approximation, self-size; separate from the exact table):');
  const bucketKeys = new Set<number>([...a.buckets.keys(), ...b.buckets.keys()]);
  const bucketRows = [...bucketKeys].map((k) => {
    const ba = a.buckets.get(k)?.bytes ?? 0;
    const bb = b.buckets.get(k)?.bytes ?? 0;
    return { k, ba, bb, d: bb - ba };
  }).sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 8);
  for (const br of bucketRows) {
    out.push(`- ${bucketLabel(br.k)}: ${fmtBytes(br.ba)} → ${fmtBytes(br.bb)} (Δ ${br.d >= 0 ? '+' : ''}${fmtBytes(br.d)})`);
  }

  return {
    output: out.join('\n'),
    newConstructors: newC,
    goneConstructors: goneC,
    grownConstructors: grownC,
    shrunkConstructors: shrunkC,
    nodeCountDelta: b.nodeCount - a.nodeCount,
    stringCountDelta: b.stringCount - a.stringCount,
  };
}
