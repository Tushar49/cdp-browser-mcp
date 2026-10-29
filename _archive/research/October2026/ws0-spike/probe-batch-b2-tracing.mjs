// WS7 Batch B2 — final consolidated canary connection:
// (1) battery tab Brought to FRONT (rendering-driven events need a painted tab)
// (2) rig boot check: page-side PerformanceObserver ground truth must exist
// (3) category matrix, 3 sequential traces on one connection
// (4) C9 regression piggyback: MCP dist client (spawn = own browser attach)
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WebSocket = require('A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/ws');

const RIG = 'http://localhost:8877';
const results = { probes: [], startedAt: new Date().toISOString() };
const note = (name, verdict, evidence) => {
  results.probes.push({ name, verdict, evidence });
  console.log(`[${verdict}] ${name}\n    ${evidence}`);
};
const [port, ...rest] = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/);
const browserPath = rest.join('').trim();
let id = 0;
const pending = new Map();
const events = [];
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const msgId = ++id;
  pending.set(msgId, { resolve, reject: (e) => reject(new Error(method + ' → ' + JSON.stringify(e))) });
  ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const trySend = async (m, p = {}, s) => { try { return { ok: true, result: await send(m, p, s) }; } catch (e) { return { ok: false, error: e.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`, { maxPayload: 1024 * 1024 * 1024, perMessageDeflate: false });
console.log('WS connecting… click Allow if a dialog appears.');
ws.on('message', (d) => {
  const msg = JSON.parse(d.toString());
  if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(msg.error) : p.resolve(msg.result); }
  else if (msg.method) events.push(msg);
});
const ev = (m) => events.filter((x) => x.method === m);
const evAfter = (start) => events.slice(start);

async function traceRun(s, cats, waitMs = 5600) {
  events.length = 0;
  const start = await trySend('Tracing.start', { traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: cats } }, s);
  if (!start.ok) return { startError: String(start.error).slice(0, 160) };
  await send('Page.reload', {}, s);
  await sleep(waitMs);
  await trySend('Tracing.end', {}, s);
  let complete = null;
  for (let i = 0; i < 100; i++) { await sleep(250); complete = ev('Tracing.tracingComplete').at(-1); if (complete) break; }
  const raw = ev('Tracing.dataCollected').flatMap((m) => m.params.value || []);
  const by = {};
  for (const e of raw.filter((e) => /largestContentful|LayoutShift|LongTask|RunTask|EventTiming|firstPaint|firstMeaningful|firstContentful/.test(e.name || ''))) by[e.name] = (by[e.name] || 0) + 1;
  const pick = (re) => raw.filter((e) => re.test(e.name || '')).slice(0, 1).map((e) => JSON.stringify(e).slice(0, 240)).join('');
  return {
    startOk: true, complete: complete ? { dataLoss: !!complete.params.dataLossOccurred } : 'TIMEOUT',
    total: raw.length, interesting: by,
    ls: pick(/LayoutShift/), lcp: pick(/largestContentfulPaint::Candidate/), lt: pick(/LongTask|RunTask/),
    bytes: ev('Tracing.dataCollected').reduce((a, m) => a + JSON.stringify(m.params.value || []).length, 0),
  };
}

ws.on('open', async () => {
  try {
    const bt = await send('Target.createTarget', { url: RIG + '/slow-rig.html?b2=1&fg=1' });
    await sleep(500);
    const { sessionId: s } = await send('Target.attachToTarget', { targetId: bt.targetId, flatten: true });
    await send('Page.enable', {}, s);
    await send('Runtime.enable', {}, s);
    const ft = await trySend('Page.bringToFront', {}, s);
    note('B2-0 bringToFront (paint required for LCP/CLS)', ft.ok ? 'OK' : 'reject', ft.ok ? 'battery tab foreground' : JSON.stringify(ft.error).slice(0, 120));
    await sleep(4200);
    const perf = await trySend('Runtime.evaluate', { expression: `JSON.stringify({lcp: window.__PERF?.lcp?.length ?? null, shifts: window.__PERF?.shifts?.length ?? null, tasks: window.__PERF?.longTasks?.length ?? null, full: window.__PERF})`, returnByValue: true }, s);
    note('B2-1 rig boot check: page-side observers recorded', /lcp/.test(JSON.stringify(perf.result?.value || {})) ? 'YES' : 'NO — rig page broken?', String(JSON.stringify(perf.result?.value ?? perf.error)).replace(/\s+/g, ' ').slice(0, 380));

    // category matrix (sequential traces, one connection)
    const m1 = await traceRun(s, ['devtools.timeline' + ',devtools.timeline.frame']);
    note('B2-2 cats [devtools.timeline,devtools.timeline.frame]', JSON.stringify(m1.interesting || m1).slice(0, 120),
      `total=${m1.total} ls=${m1.ls.slice(0, 200) || '-'} lcp=${m1.lcp.slice(0, 200) || '-'} lt=${m1.lt.slice(0, 200) || '-'} complete=${JSON.stringify(m1.complete)} bytes=${m1.bytes}`);
    const m2 = await traceRun(s, ['loading']);
    note('B2-3 cats [loading]', JSON.stringify(m2.interesting || m2).slice(0, 120),
      `total=${m2.total} ls=${m2.ls.slice(0, 200) || '-'} lcp=${m2.lcp.slice(0, 200) || '-'} lt=${m2.lt.slice(0, 200) || '-'} complete=${JSON.stringify(m2.complete)}`);
    const m3 = await traceRun(s, ['devtools.timeline', 'loading']);
    note('B2-4 cats [devtools.timeline, loading]', JSON.stringify(m3.interesting || m3).slice(0, 120),
      `total=${m3.total} ls=${m3.ls.slice(0, 200) || '-'} lcp=${m3.lcp.slice(0, 200) || '-'} lt=${m3.lt.slice(0, 200) || '-'} complete=${JSON.stringify(m3.complete)}`);

    await trySend('Target.closeTarget', { targetId: bt.targetId });
    console.log('\ntracing matrix done (tab closed). MCP regression piggyback…');

    // ── C9 regression ──
    const sdkClient = 'file:///' + 'A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'.replace(/ /g, '%20');
    const sdkStdio = 'file:///' + 'A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'.replace(/ /g, '%20');
    const [{ Client: C }] = await import(sdkClient);
    const [{ StdioClientTransport: TST }] = await import(sdkStdio);
    const transport = new TST({ command: process.execPath, args: ['A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/dist/index.js'] });
    const client = new C({ name: 'ws7-b2-regression', version: '0.0.1' });
    await client.connect(transport);
    const textOf = (res) => (res.content ?? []).map((x) => x.text ?? '').join('\n');
    const ping = textOf(await client.callTool({ name: 'ping', arguments: {} }));
    const status = textOf(await client.callTool({ name: 'status', arguments: {} }));
    note('C9 MCP dist regression: ping + status', ping.includes('5.3.0') && /Mode/i.test(status) ? 'PASS' : 'CHECK',
      `ping=${ping.split('\n')[0].slice(0, 80)} status=${status.replace(/\s+/g, ' ').slice(0, 140)}`);
    await transport.close().catch(() => {});
  } catch (e) {
    console.log('FATAL:', e.message);
  }
  fs.writeFileSync(new URL('./batch-b2-results.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), JSON.stringify(results, null, 2));
  process.exit(0);
});
ws.on('error', (e) => { console.log('WS ERROR:', e.message); process.exit(1); });
