// WS7 Batch C canary — HeapProfilertakeHeapSnapshot streaming shapes + size,
// live-traffic liveness during snapshot, + regression piggyback via the MCP
// dist (that client opens its OWN CDP connection — expect one extra dialog).
// ONE script = ONE primary connection (+1 from the piggyback) = 2 dialogs.
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
const t0 = Date.now();
let id = 0;
const pending = new Map();
const events = [];
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const msgId = ++id;
  pending.set(msgId, { resolve, reject: (e) => reject(new Error(method + ' → ' + JSON.stringify(e))) });
  ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const trySend = async (method, params = {}, sessionId) => {
  try { return { ok: true, result: await send(method, params, sessionId) }; }
  catch (e) { return { ok: false, error: e.message }; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`, { maxPayload: 1024 * 1024 * 1024, perMessageDeflate: false });
console.log('WS connecting… if this stalls >20s, the browser is waiting on the CDP Allow dialog — click it.');
ws.on('open', () => console.log('WS open after ' + (Date.now() - t0) + 'ms'));
ws.on('message', (d) => {
  const msg = JSON.parse(d.toString());
  if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(msg.error) : p.resolve(msg.result); }
  else if (msg.method) events.push(msg);
});
const ev = (method) => events.filter((m) => m.method === method);
let progressEvents;
ws.on('error', (e) => { console.log('WS ERROR:', e.message); process.exit(1); });

ws.on('open', async () => {
  try {
    const bt = await send('Target.createTarget', { url: RIG + '/slow-rig.html?batchc=1&construct=WS7GroundTruthObj' });
    await sleep(900);
    const { sessionId: s } = await send('Target.attachToTarget', { targetId: bt.targetId, flatten: true });
    await send('Page.enable', {}, s);
    await send('Runtime.enable', {}, s);
    await sleep(300);

    // B5 (folded to save a dialog) ── focused trace: ['loading','devtools.timeline']
    // + page-self-measurement cross-check via window.__PERF
    events.length = 0;
    const perfBefore = await trySend('Runtime.evaluate', { expression: '(async () => { window.__PERF = null; })()', returnByValue: true, awaitPromise: false }, s);
    note('B5 reset __PERF', perfBefore.ok ? 'ok' : 'err', 'cleared before trace');
    const b5start = await trySend('Tracing.start', {
      traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: ['loading', 'devtools.timeline'] },
    }, s);
    const b5nav = await send('Page.navigate', { url: RIG + '/slow-rig.html?b5=1' }, s).catch((e) => ({ err: String(e.message) }));
    await sleep(6500); // covers 800ms shift, 1s+2s tasks, 2.6s second shift
    await trySend('Tracing.end', {}, s);
    let b5complete = null;
    for (let i = 0; i < 80; i++) { await sleep(250); b5complete = ev('Tracing.tracingComplete').at(-1); if (b5complete) break; }
    const raw5 = ev('Tracing.dataCollected').flatMap((m) => m.params.value || []);
    const by5 = {};
    for (const e of raw5.filter((e) => /largestContentful|LayoutShift|LongTask|RunTask|EventTiming/.test(e.name || ''))) by5[e.name] = (by5[e.name] || 0) + 1;
    const ls = raw5.filter((e) => e.name === 'LayoutShift').slice(0, 2).map((e) => JSON.stringify(e).slice(0, 280));
    const lt = raw5.filter((e) => e.name === 'LongTask' || /RunTask|taskInfo/.test(e.name || '')).slice(0, 2).map((e) => JSON.stringify(e).slice(0, 240));
    const perf = await trySend('Runtime.evaluate', { expression: 'JSON.stringify(window.__PERF)', returnByValue: true }, s);
    note('B5 cats=loading+devtools.timeline', b5complete ? 'complete dataLoss=' + !!b5complete.params.dataLossOccurred : 'TIMEOUT',
      `totalEvents=${raw5.length} interesting=${JSON.stringify(by5)} | LS samples: ${ls.join(' | ') || '-'} || LT: ${lt.join(' | ') || '-'}`);
    note('B5b page-side __PERF ground truth (PerformanceObserver)', perf.ok ? 'captured' : 'err',
      String(JSON.stringify(perf.result.value ?? perf.error)).replace(/\s+/g, ' ').slice(0, 420));


    // C0 (AFTER B5's navigation) ── seed ground-truth objects in the SETTLED page
    const gt = await send('Runtime.evaluate', {
      expression: `(function(){ class GT {} ; window.__GT=[]; for(let i=0;i<1234;i++) window.__GT.push(new GT()); return {count: window.__GT.length, kw: 'WS7GroundTruthObj'}; })()`,
      returnByValue: true,
    }, s).catch(() => null);
    note('C0 ground-truth seeded', gt ? 'ready' : 'err', gt ? JSON.stringify(gt.result.value) : 'n/a');

    // C1 ── takeHeapSnapshot chunk / progress shapes + wall time ─────────
    const hp = await trySend('HeapProfiler.enable', {}, s);
    note('C1 HeapProfiler.enable', hp.ok ? 'OK' : 'reject', hp.ok ? 'enabled' : JSON.stringify(hp.error).slice(0, 200));
    // kill our marker: count WS7GroundTruthObj constructor names offline
    events.length = 0;
    const t0 = Date.now();
    const snap = await trySend('HeapProfiler.takeHeapSnapshot', { reportProgress: true }, s);
    const wall = Date.now() - t0;
    const lastUpdateNums = ev('HeapProfiler.lastSeenObjectId');
    progressEvents = ev('HeapProfiler.reportHeapSnapshotProgress');
    const lastProgress = progressEvents.at(-1)?.params;
    const chunkEvents = ev('HeapProfiler.addHeapSnapshotChunk');
    const chunkCount = chunkEvents.length;
    const totalMB = +(chunkEvents.reduce((a, m) => a + (m.params.chunk || '').length, 0) / 1048576).toFixed(2);
    note('C2 takeHeapSnapshot', snap.ok ? 'OK' : 'reject',
      `wall=${wall}ms chunks=${chunkCount} totalMB=${totalMB} progressEvents=${progressEvents.length} lastProgress=${JSON.stringify(lastProgress).slice(0, 220)} lastSeenObjectIdEvents=${lastUpdateNums.length}`);
    const rawHead = chunkEvents[0]?.params?.chunk || '';
    note('C3 chunk stream shape', rawHead ? 'captured' : 'absent', 'firstChunkHead=' + rawHead.slice(0, 180));
    const tail = (chunkEvents.at(-1)?.params?.chunk || '').slice(-160);
    note('C4 snapshot tail (meta?)', tail ? 'captured' : 'absent', 'tail=' + tail);

    // C5 ── live-traffic liveness during snapshot (stall check) ──────────
    const liveness = await send('Runtime.evaluate', { expression: '2+2', returnByValue: true }, s);
    note('C5 post-snapshot session liveness', liveness.result.value === 4 ? 'LIVE (evaluate answered)' : 'STALLED?', JSON.stringify(liveness.result.value));
    const pingOther = await trySend('Runtime.getVersion', {}, s);
    note('C6 browser-level during-after? (post) ', pingOther.ok ? 'OK' : 'reject', pingOther.ok ? 'browser session responsive' : String(pingOther.error).slice(0, 160));

    // C7 ── does the snapshot file parse? offline test data: save chunks to file
    const file = new URL('./batch-c-snapshot.heapsnapshot', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const chunks = ev('HeapProfiler.addHeapSnapshotChunk').map((m) => m.params.chunk || '').join('');
    fs.writeFileSync(file, chunks);
    note('C7 snapshot persisted for offline parse test', fs.statSync(file).size + ' bytes', file);

    // count ground truth in snapshot content (raw text scan; offline parser is WS11's work)
    const withGt = (chunks.match(/WS7GroundTruthObj/g) || []).length;
    note('C8 ground-truth marker occurrences in snapshot text', withGt > 0 ? 'PRESENT' : 'absent', `occurrences=${withGt}`);

    await trySend('Target.closeTarget', { targetId: bt.targetId });
    console.log('\nC primary done (our tab closed). Now MCP regression piggyback…');

    // ── regression piggyback: fresh-dist MCP client (its own CDP attach) ─
    const sdkDir = 'A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/@modelcontextprotocol/sdk/';
    // use dynamic import resolved from this module for ESM compatibility
    const sdk = await Promise.all([
      import('file:///' + sdkDir + 'client/index.js'),
      import('file:///' + sdkDir + 'client/stdio.js'),
    ]);
    const [{ Client: C }, { StdioClientTransport: TST }] = [sdk[0], sdk[1]];
    const distPath = 'A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/dist/index.js';
    const transport = new TST({ command: process.execPath, args: [distPath] });
    const client = new C({ name: 'ws7-batchC-regression', version: '0.0.1' });
    await client.connect(transport);
    const call = (name, args) => client.callTool({ name, arguments: args });
    const textOf = (res) => (res.content ?? []).map((x) => x.text ?? '').join('\n');
    const ping = textOf(await call('ping', {}));
    const status = textOf(await call('status', {}));
    note('C9 MCP dist regression: ping + status', ping.includes('5.3.0') && /Mode/.test(status) ? 'PASS' : 'CHECK',
      `ping=${ping.split('\n').slice(0, 2).join(' | ').slice(0, 160)} status=${status.slice(0, 160).replace(/\s+/g, ' ')}`);
    await transport.close().catch(() => {});
    console.log('regression done.');
  } catch (e) {
    console.log('FATAL:', e.message);
  }
  fs.writeFileSync(new URL('./batch-c-probes.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), JSON.stringify(results, null, 2));
  process.exit(0);
});
