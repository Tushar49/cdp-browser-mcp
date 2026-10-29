// WS7 Batch B canary — Tracing: which category set carries LCP/CLS/long tasks,
// chunk pacing, tracingComplete/dataLossOccurred, navigation survival.
// ONE script = ONE CDP connection = one Allow dialog. Own battery tab.
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WebSocket = require('A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/ws');

const RIG = 'http://localhost:8877';
const CATS = { devtools: ['devtools.timeline'], frames: ['devtools.timeline.frame'], v8: ['v8'], loading: ['devtools.timeline,devtools.timeline.frame'] };
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
const trySend = async (method, params = {}, sessionId) => {
  try { return { ok: true, result: await send(method, params, sessionId) }; }
  catch (e) { return { ok: false, error: e.message }; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`, { maxPayload: 1024 * 1024 * 1024, perMessageDeflate: false });
ws.on('message', (d) => {
  const msg = JSON.parse(d.toString());
  if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(msg.error) : p.resolve(msg.result); }
  else if (msg.method) events.push(msg);
});
const ev = (method) => events.filter((m) => m.method === method);
const evSlice = (method, from) => events.slice(from).filter((m) => m.method === method);

async function runTrace(s, cats, label, waitMs = 4200) {
  events.length = 0; // slice window
  const before = events.length;
  const start = await trySend('Tracing.start', { traceConfig: { recordMode: 'recordUntilFull', includedCategories: cats } }, s);
  if (!start.ok) return { label, startError: start.error };
  await send('Page.reload', { ignoreCache: false }, s);
  await sleep(waitMs);
  const endIdx = events.length;
  const userData = await trySend('Tracing.end', {}, s);
  // wait for tracingComplete
  let complete = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    complete = evSlice('Tracing.tracingComplete', before).at(-1);
    if (complete) break;
  }
  const chunks = evSlice('Tracing.dataCollected', before);
  const raw = chunks.flatMap((m) => m.params.value);
  const interesting = raw.filter((e) => /largestContentful|LayoutShift|LongTask|RunTask|EventTiming|first.*[Pp]aint|FirstMeaningful/.test(e.name || ''));
  const byName = {};
  for (const e of interesting) byName[e.name] = (byName[e.name] || 0) + 1;
  const chunkSizes = chunks.map((m) => (m.params.value || []).length);
  const totalBytes = chunks.reduce((a, m) => a + JSON.stringify(m.params.value || []).length, 0);
  return {
    label, startOk: start.ok, complete: complete?.params ?? null,
    totalEvents: raw.length, interestingUnique: Object.keys(byName).length, byName,
    chunks: chunks.length, chunkSizes: chunkSizes.slice(0, 8), totalBytes,
    samples: interesting.slice(0, 2).map((e) => JSON.stringify(e).slice(0, 220)), userData,
  };
}

ws.on('open', async () => {
  try {
    const bt = await send('Target.createTarget', { url: RIG + '/slow-rig.html?batchb=1' });
    await sleep(600);
    const { sessionId: s } = await send('Target.attachToTarget', { targetId: bt.targetId, flatten: true });
    await send('Page.enable', {}, s);
    await sleep(400);

    // B1 ── devtools.timeline alone: does it carry LCP/CLS/LongTask?
    const b1 = await runTrace(s, CATS.devtools, 'devtools.timeline only');
    note('B1 categories=devtools.timeline', (b1.byName && Object.keys(b1.byName).length) ? 'YIELDS' : 'no interesting events',
      JSON.stringify(b1).slice(0, 700));
    // B2 ── + frame
    const b2 = await runTrace(s, CATS.loading, 'devtools.timeline + frame');
    note('B2 categories=+devtools.timeline.frame', (b2.byName && Object.keys(b2.byName).length) ? 'YIELDS' : 'no gain',
      JSON.stringify(b2.byName || b2));
    // B3 ── v8 (profile capture) — expected heavy; only existence check w/o full events log
    const b3 = await runTrace(s, ['devtools.timeline', 'v8'], 'devtools.timeline + v8');
    note('B3 categories=+v8 (profile budget)', b3.totalEvents ? `totalEvents=${b3.totalEvents} bytes≈${b3.totalBytes}` : 'no events',
      `interesting=${JSON.stringify(b3.byName || b3.startError || b3)}`);
    // B4 ── dataLossOccurred + long window (recordAsMuchAsPossible?) and reload survival
    const b4start = await trySend('Tracing.start', {
      traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: CATS.loading },
    }, s);
    await send('Page.navigate', { url: RIG + '/slow-rig.html?batchb-nav=1' }, s);
    await sleep(5200);
    await send('Tracing.end', {}, s);
    let complete = null;
    for (let i = 0; i < 80; i++) { await sleep(250); complete = evSlice('Tracing.tracingComplete', 0).at(-1); if (complete) break; }
    const raw4 = ev('Tracing.dataCollected').flatMap((m) => m.params.value || []);
    const by4 = {};
    for (const e of raw4.filter((e) => /largestContentful|LayoutShift|LongTask|RunTask/.test(e.name || ''))) by4[e.name] = (by4[e.name] || 0) + 1;
    note('B4 recordAsMuchAsPossible + navigation survival',
      `${b4start.ok ? 'started' : 'startFailed'} complete=${complete ? 'yes dataLoss=' + !!complete.params.dataLossOccurred : 'TIMEOUT'} interesting=${JSON.stringify(by4)}`,
      `totalEvents=${raw4.length} chunks=${ev('Tracing.dataCollected').length}`);
    if (complete) note('B4b tracingComplete params shape', 'recorded', JSON.stringify(complete.params).slice(0, 300));

    const lsSample = raw4.filter((e) => e.name === 'LayoutShift').slice(0, 3).map((e) => JSON.stringify(e).slice(0, 300));
    note('B4c LayoutShift sample (hadRecentInput field?)', lsSample.length ? 'captured' : 'absent', lsSample.join(' || ') || '-');
    const lcpSample = raw4.filter((e) => /largestContentful/i.test(e.name || '')).slice(0, 2).map((e) => JSON.stringify(e).slice(0, 300));
    note('B4d LCP candidate sample', lcpSample.length ? 'captured' : 'absent', lcpSample.join(' || ') || '-');
    const ltSample = raw4.filter((e) => e.name === 'LongTask' || /RunTask/.test(e.name || '')).slice(0, 2).map((e) => JSON.stringify(e).slice(0, 260));
    note('B4e long-task sample', ltSample.length ? 'captured' : 'absent', ltSample.join(' || ') || '-');

    // our tab back to a quiet state, then close (ours)
    await trySend('Target.closeTarget', { targetId: bt.targetId });
    console.log('\nB done. battery tab closed.');
  } catch (e) {
    console.log('FATAL:', e.message);
  }
  fs.writeFileSync(new URL('./batch-b-results.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), JSON.stringify(results, null, 2));
  process.exit(0);
});
ws.on('error', (e) => { console.log('WS ERROR:', e.message); process.exit(1); });
