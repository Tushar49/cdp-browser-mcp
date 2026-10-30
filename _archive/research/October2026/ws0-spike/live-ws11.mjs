// WS11 live gate — ONE connection (MCP dist client). Per the plan's T1-2 pin:
// rig dump via the SHIPPED heap_dump (confirm-gated) → offline heap_summary
// states the EXACT known object count of a distinctive test constructor,
// evaluated via Runtime.evaluate IMMEDIATELY BEFORE the dump (objects
// batch-created and retained in window.__HEAP_KEEP so GC cannot trim).
import { fileURLToPath } from 'url';
import fs from 'fs';
const sdk = 'file:///' + 'A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/'.replace(/ /g, '%20');
const { Client } = await import(sdk + 'index.js');
const { StdioClientTransport } = await import(sdk + 'stdio.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/dist/index.js'],
});
const client = new Client({ name: 'live-ws11', version: '0.0.1' });
await client.connect(transport);
const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 140_000 });
const textOf = (res) => {
  const raw = (res && Array.isArray(res.content)) ? res.content.map((x) => (x && typeof x.text === 'string') ? x.text : '').join('\n') : String(res?.error?.message ?? res ?? '');
  return typeof raw === 'string' ? raw : String(raw);
};

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const newTab = textOf(await call('tabs', { action: 'new', url: 'http://localhost:8877/rig.html?ws11gate=1' }));
const tabId = newTab.match(/\[([0-9A-F]{32})\]/)?.[1];
console.log('gate tab:', tabId);
await sleep(800);

// 1 ── opt-in gate works BEFORE any dump
const unconfirmed = textOf(await call('observe', { tabId, action: 'heap_dump' }));
check('heap_dump without confirm fails actionably (opt-in lane)', unconfirmed.includes('confirm: true') && unconfirmed.includes('auth-state'), unconfirmed.split('\n')[0]);

// 2 ── batch-create the ground-truth objects; count evaluated IMMEDIATELY pre-dump
const N = 421;
const planted = textOf(await call('execute', {
  tabId, action: 'eval',
  expression: `(function(){ window.__HG = class HeapGateMarker { constructor(){ this.payload = { a: 1, b: 'marker' }; } }; window.__HEAP_KEEP = Array.from({ length: ${N} }, () => new window.__HG()); return window.__HEAP_KEEP.length; })()`,
}));
check('ground-truth objects batch-created + retained', planted.trim() === String(N), `${planted} (expected ${N})`);

// 3 ── the dump (chunks stream via the event pipeline → .partial → finalize)
const dumpOut = textOf(await call('observe', { tabId, action: 'heap_dump', confirm: true }));
const dumpPath = dumpOut.match(/[\w:\\/.-]+heap-\d+\.heapsnapshot/)?.[0];
check('heap_dump completes with a .heapsnapshot path', !!dumpPath && dumpOut.includes('Heap dump complete:'), dumpPath ? dumpPath.slice(-40) : dumpOut.split('\n')[0]);
fs.writeFileSync(new URL('./live-ws11-output.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), dumpOut, dumpPath }, null, 2));
console.log('\n──── heap_dump output ────\n' + dumpOut + '\n────────────');

// 4 ── offline summary: exact ground-truth count
const summary = textOf(await call('observe', { tabId, action: 'heap_summary', path: dumpPath, top: 40 }));
console.log('\n──── heap_summary output (head) ────\n' + summary.split('\n').slice(0, 24).join('\n') + '\n────────────');
check('heap_summary parsed offline', summary.includes('Heap snapshot summary'), summary.split('\n')[0]);
check('ground-truth constructor found by name', summary.includes('HeapGateMarker'), summary.includes('HeapGateMarker') ? 'named' : 'missing');
check('ground-truth count EXACT (421)', /×421 —/.test(summary) || /×421\s/.test(summary), (summary.match(/HeapGateMarker.*×\d+/) || ['no-match'])[0]);
check('honest self-size header (no "retained" claim)', summary.includes('"retained" NOT claimed'), '');
check('(D)etachedness rollup present (rig values)', /detachedness:/.test(summary), (summary.match(/detachedness: .*/) || [''])[0].slice(0, 80));

// 5 ── second dump NEVER advertised while summarize uses the first artifact — skip; teardown
await call('tabs', { action: 'close', tabId });
console.log(`\ngate tab closed (dump file intentionally left for clean_temp). RESULT: ${failures === 0 ? 'GATE PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);
