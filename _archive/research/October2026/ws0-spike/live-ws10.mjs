// WS10 live gate v7 — ONE connection (MCP dist client). THREE recording
// variants through the SHIPPED tool path (to find the flush mechanism and
// still produce a binary gate verdict):
//   A: default ['loading'], 8s, one reload
//   B: ['v8'] escalation, 20s (periodic-flush window rider)
//   C: ['v8'] escalation, 12s, TWO mid-trace reloads (flush-on-death rider)
// Gate rule: whichever attempt first yields BOTH classes decides the
// shipping category set (pre-declared, plan WS10 PROBE RESULT). Killed
// classes (LongTask, EventTiming) must NOT be asserted.
import { fileURLToPath } from 'url';
import fs from 'fs';
const sdk = 'file:///' + 'A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/'.replace(/ /g, '%20');
const { Client } = await import(sdk + 'index.js');
const { StdioClientTransport } = await import(sdk + 'stdio.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/dist/index.js'],
});
const client = new Client({ name: 'live-ws10', version: '0.0.1' });
await client.connect(transport);
const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 140_000 });
const textOf = (res) => {
  const raw = (res && Array.isArray(res.content)) ? res.content.map((x) => (x && typeof x.text === 'string') ? x.text : '').join('\n') : String(res?.error?.message ?? res ?? '');
  return typeof raw === 'string' ? raw : String(raw);
};

let failures = 0;
const records = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasL = (s) => typeof s === 'string' && s.includes("H1 id='lcp'");
const hasC = (s) => typeof s === 'string' && /[1-9][0-9]* (non-input|shift)/.test(s) && /[0-9]+ shift/.test(s);
const hasBoth = (s) => hasL(s) && hasC(s);

const recordOnce = async (tabId, label, { categorised, recordingMs, midFreeMs, extraReloadAt }) => {
  const started = textOf(await call('observe', categorised
    ? { tabId, action: 'perf_start', categories: ['v8'] }
    : { tabId, action: 'perf_start' }));
  await sleep(300);
  await call('page', { tabId, action: 'reload' });
  if (extraReloadAt) { await sleep(extraReloadAt - 300); await call('page', { tabId, action: 'reload' }); }
  await sleep(midFreeMs);
  // focus audit right before stop
  const vis = textOf(await call('execute', { tabId, action: 'eval', expression: 'document.visibilityState + "|focus=" + document.hasFocus()' }));
  await sleep(recordingMs - midFreeMs);
  const out = textOf(await call('observe', { tabId, action: 'perf_stop' }));
  const rec = { attempt: label, started: started.split('\n')[0], vis, out: String(out) };
  records.push(rec);
  console.log(`[${label}] vis=${vis}; classes: ${hasL(out) ? 'LCP' : 'no-LCP'} / ${hasC(out) ? 'CLS' : 'no-CLS'}`);
  return rec;
};

const newTab = textOf(await call('tabs', { action: 'new', url: 'http://localhost:8877/slow-rig.html?ws10gate=1' }));
const tabId = newTab.match(/\[([0-9A-F]{32})\]/)?.[1];
console.log('gate tab:', tabId);
await sleep(800);

const throttle = textOf(await call('emulate', { tabId, networkCondition: 'slow3g' }));
check('slow3g accepted via emulate tool', throttle.includes('Network: slow3g'), throttle.split('\n')[0]);

await recordOnce(tabId, 'A-loading-8s', { categorised: false, recordingMs: 8000, midFreeMs: 6000 });
if (!records.some((r) => hasBoth(r.out))) {
  await recordOnce(tabId, 'B-v8-20s', { categorised: true, recordingMs: 20_000, midFreeMs: 6000 });
}
if (!records.some((r) => hasBoth(r.out))) {
  await recordOnce(tabId, 'C-v8-12s-2xreload', { categorised: true, recordingMs: 12_000, midFreeMs: 4000, extraReloadAt: 3500 });
}

const best = records.find((r) => hasBoth(r.out)) ?? records[records.length - 1];
const out = best.out;
fs.writeFileSync(new URL('./live-ws10-output.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), records }, null, 2));

check('perf_stop delivers insights', out.includes('Performance insights'), out.split('\n')[0]);
check('LCP insight present (surviving class)', hasL(out), hasL(out) ? out.split('\n').filter((l) => l.startsWith('-'))[0] : out.includes('zero LCP/CLS') ? 'zero-class' : 'n/a');
check('LCP candidate is the rig element (H1 id=lcp)', out.includes("H1 id='lcp'"), out.split('\n').filter((l) => l.startsWith('-'))[0] || '-');
check('CLS insight present (surviving class)', hasC(out), (out.match(/(final [0-9.]+|[0-9]+ shift)/) || ['no-match'])[0]);
check('dataLoss NOT flagged', !out.includes('dataLossOccurred'), out.split('\n')[1] || '');
const proven = records.find((r) => hasBoth(r.out));
console.log(`\nattempts: ${records.map((r) => r.attempt).join(' → ')} — shipping category set: ${proven ? (proven.attempt.startsWith('A') ? "['loading']" : "['loading','v8']") : 'NOT PROVEN (gate FAIL)'}`);
console.log(`\n──── best (attempt ${best.attempt}) perf_stop output ────\n${out}\n────────────`);

const second = textOf(await call('observe', { tabId, action: 'perf_stop' }));
check('second perf_stop errors actionably', second.includes('No performance recording active'), second.split('\n')[0]);

await call('emulate', { tabId, reset: true });
await call('tabs', { action: 'close', tabId });
console.log(`\ngate tab closed. RESULT: ${failures === 0 ? 'GATE PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);
