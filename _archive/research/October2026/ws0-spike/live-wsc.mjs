// WSC live gate — ONE MCP connection (DevToolsActivePort via CDP_USER_DATA).
// Part 1: two real heap dumps with a KNOWN marker-count delta (120 → 180)
//         → heap_diff must classify HeapDiffMarker GROWN ×120 → ×180.
// Part 2: perf_start keepRaw → trusted input → perf_stop → raw .jsonl path.
import fs from 'fs';
const sdk = 'file:///' + 'A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/'.replace(/ /g, '%20');
const { Client } = await import(sdk + 'index.js');
const { StdioClientTransport } = await import(sdk + 'stdio.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/dist/index.js'],
  env: { ...process.env, CDP_USER_DATA: 'A:\\Programs\\Browsers\\brave-portable\\data' },
});
const client = new Client({ name: 'live-wsc', version: '0.0.1' });
await client.connect(transport);
const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 240_000 });
const textOf = (res) => {
  const raw = (res && Array.isArray(res.content)) ? res.content.map((x) => (x && typeof x.text === 'string') ? x.text : '').join('\n') : String(res?.error?.message ?? res ?? '');
  return typeof raw === 'string' ? raw : String(raw);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const newTab = textOf(await call('tabs', { action: 'new', url: 'http://127.0.0.1:8877/wsa-rig.html?wscgate=1' }));
const tabId = newTab.match(/\[([0-9A-F]{32})\]/)?.[1];
if (!tabId) { console.log(newTab); process.exit(1); }
console.log('gate tab:', tabId);
await call('tabs', { action: 'activate', tabId });
await sleep(400);

// ── Part 1: heap_diff with a known marker delta ─────────────────────
const plant = async (n) => textOf(await call('execute', {
  tabId, action: 'eval',
  expression: `(function(){
    if (!window.__HDM) window.__HDM = class HeapDiffMarker { constructor(){ this.payload = { a: 1, b: 'marker' }; } };
    window.__KEEP = window.__KEEP || [];
    for (let i = 0; i < ${n}; i++) window.__KEEP.push(new window.__HDM());
    return window.__KEEP.length;
  })()`,
}));

console.log('plant A:', await plant(120));
const dumpAOut = textOf(await call('observe', { tabId, action: 'heap_dump', confirm: true }));
const pathA = dumpAOut.match(/[\w:\\/.-]+heap-\d+\.heapsnapshot/)?.[0];
check('heap_dump A produced a .heapsnapshot', !!pathA, pathA ? pathA.slice(-45) : dumpAOut.split('\n')[0]);

console.log('plant B:', await plant(60));
const dumpBOut = textOf(await call('observe', { tabId, action: 'heap_dump', confirm: true }));
const pathB = dumpBOut.match(/[\w:\\/.-]+heap-\d+\.heapsnapshot/)?.[0];
check('heap_dump B produced a .heapsnapshot', !!pathB, pathB ? pathB.slice(-45) : dumpBOut.split('\n')[0]);

if (pathA && pathB) {
  const diff = textOf(await call('observe', { tabId, action: 'heap_diff', pathA, pathB }));
  console.log('\n──── heap_diff output (head) ────\n' + diff.split('\n').slice(0, 18).join('\n') + '\n────────────');
  check('heap_diff honest header (self-size, no retained)', diff.includes('"retained" NOT claimed'), diff.split('\n')[0]);
  check('heap_diff classifies HeapDiffMarker GROWN', /\[GROWN\] HeapDiffMarker/.test(diff), (diff.match(/\[GROWN\] HeapDiffMarker[^\n]*/) || ['none'])[0]);
  check('heap_diff exact marker growth ×120 → ×180', /×120 → ×180/.test(diff), (diff.match(/HeapDiffMarker[^\n]*/) || ['none'])[0]);
  check('heap_diff reports a +exact self delta', /\[GROWN\] HeapDiffMarker.*self \+/.test(diff), '');
  check('heap_diff ≈ bucket rollup rendered separately', diff.includes('(≈) Byte-bucket rollup'), '');
  check('heap_diff node delta present', /nodes: \d+ → \d+ \(Δ \+?\d+\)/.test(diff), (diff.match(/nodes: [^\n|]*/) || ['none'])[0]);
} else {
  check('heap_diff run skipped (dump failure)', false);
}

// ── Part 2: raw-trace dump (keepRaw) ────────────────────────────────
const startOut = textOf(await call('observe', { tabId, action: 'perf_start', categories: ['v8'], keepRaw: true }));
console.log('\nperf_start:', startOut.split('\n')[0]);
check('perf_start keepRaw advertises the streaming file', startOut.includes('Raw events are streaming'), startOut.split('\n')[0]);

await call('interact', { tabId, action: 'click', selector: 'text=UniqueTextTarget' });
await sleep(120);
await call('interact', { tabId, action: 'click', selector: 'testid=submit-btn' });
await sleep(300);

const stopOut = textOf(await call('observe', { tabId, action: 'perf_stop' }));
const rawPath = stopOut.match(/Raw trace dump: ([\w:\\/.-]+\.jsonl)/)?.[1];
console.log('\nraw path:', rawPath ?? '(none)');
check('perf_stop advertises the raw .jsonl path', !!rawPath, rawPath ?? stopOut.split('\n').slice(-1)[0]);

if (rawPath) {
  const stat = fs.existsSync(rawPath) ? fs.statSync(rawPath) : null;
  check('raw dump file exists and is non-empty', !!stat && stat.size > 0, stat ? `${stat.size} bytes` : 'missing');
  const lines = fs.readFileSync(rawPath, 'utf8').trim().split('\n');
  let parsed = 0;
  let sawCore = false;
  const names = new Set();
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      parsed++;
      if (typeof e.name === 'string') names.add(e.name);
      if (e.name === 'process_name' || e.name === 'thread_name' || e.name === 'TracingStartedInBrowser' || e.name === 'EventTiming') sawCore = true;
    } catch { /* count only valid lines */ }
  }
  check('raw dump is valid JSONL (every sampled line parses)', parsed === lines.length && parsed > 0, `${parsed}/${lines.length} lines`);
  check('raw dump is VERBATIM (carries core trace events)', sawCore, [...names].slice(0, 6).join(', ') || 'none');
}

await call('tabs', { action: 'close', tabId });
console.log(`\nRESULT: ${failures === 0 ? 'GATE PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);
