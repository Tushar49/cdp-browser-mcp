// WS10 step-zero probe (Batch B3) — decides the 5.4.0 WS10 pre-conditions.
// One CDP connection, one Allow dialog. Probes:
// (1) PRISTINE ['loading'] baseline — LCP candidate + LayoutShift must appear; LongTask expected ABSENT.
// (2) BUSY-DRIVEN LongTask hunt with ['v8','loading','devtools.timeline','disabled-by-default-devtools.timeline'],
//     driven with 4x window.__BUSY(300) — LongTask/RunTask GO/KILL.
// (3) EventTiming GO/KILL (B-cache: only with 'v8') + event VOLUME per category set (decides aggregator architecture:
//     parse-once vs incremental per-chunk). Volume = total raw events + top name histogram + chunk shapes.
// (4) LCP args.data + LayoutShift had_recent_input field capture (the aggregator's exact field requirements).
// Rig ground truth via window.__PERF cross-check.
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WebSocket = require('A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/ws');

const RIG = 'http://localhost:8877';
const results = { probes: [], startedAt: new Date().toISOString() };
const note = (name, verdict, evidence) => {
  results.probes.push({ name, verdict, evidence });
  console.log(`[${verdict}] ${name}\n    ${evidence}`);
};
const [port, ...rest] = fs.readFileSync('A:/.devTools/cache/temp/opencode/ws0/b3-port.txt', 'utf8').trim().split(/\r?\n/);
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
console.log('WS connecting to ws://127.0.0.1:' + port + browserPath + ' — click Allow if a dialog appears.');

let chunkSizes = []; // per-trace dataCollected payload sizes (restored by traceRun)
ws.on('message', (d) => {
  const msg = JSON.parse(d.toString());
  if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(msg.error) : p.resolve(msg.result); return; }
  if (msg.method) {
    if (msg.method === 'Tracing.dataCollected') chunkSizes.push((msg.params.value || []).length);
    events.push(msg);
  }
});
const ev = (m) => events.filter((x) => x.method === m);

async function traceRun(s, cats, { waitMs = 5800, busy = false } = {}) {
  events.length = 0;
  chunkSizes = [];
  const start = await trySend('Tracing.start', { traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: cats } }, s);
  if (!start.ok) return { startError: String(start.error).slice(0, 160) };
  await send('Page.reload', {}, s);
  if (busy) {
    // heavier main-thread blocks than the rig's own 250ms tasks (LT probe: LT appears after 50ms+)
    for (const [delay] of [2600, 3300, 4000, 4700].map((x) => [x])) {
      setTimeout(() => trySend('Runtime.evaluate', { expression: 'window.__BUSY(300)', returnByValue: true }, s), delay);
    }
  }
  await sleep(waitMs);
  await trySend('Tracing.end', {}, s);
  let complete = null;
  for (let i = 0; i < 100; i++) { await sleep(250); complete = ev('Tracing.tracingComplete').at(-1); if (complete) break; }
  const raw = ev('Tracing.dataCollected').flatMap((m) => m.params.value || []);
  const by = {};
  for (const e of raw.filter((e) => /largestContentful|LayoutShift|LongTask|RunTask|EventTiming|firstPaint|firstMeaningful|firstContentful|Interaction/.test(e.name || ''))) {
    by[e.name] = (by[e.name] || 0) + 1;
  }
  const allNames = {};
  for (const e of raw) allNames[e.name || '?'] = (allNames[e.name || '?'] || 0) + 1;
  const top = Object.entries(allNames).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const pick = (re) => raw.filter((e) => re.test(e.name || '')).slice(0, 1).map((e) => JSON.stringify(e).slice(0, 300)).join('');
  return {
    startOk: true,
    complete: complete ? { dataLoss: !!complete.params.dataLossOccurred } : 'TIMEOUT',
    total: raw.length,
    chunkCount: chunkSizes.length,
    maxChunk: chunkSizes.length ? Math.max(...chunkSizes) : 0,
    interesting: by,
    topNames: top,
    ls: pick(/LayoutShift/), lcp: pick(/largestContentfulPaint::Candidate/), lt: pick(/LongTask|RunTask/), timing: pick(/EventTiming|Interaction/),
  };
}

ws.on('open', async () => {
  try {
    const bt = await send('Target.createTarget', { url: RIG + '/slow-rig.html?b3=1&fg=1' });
    await sleep(500);
    const { sessionId: s } = await send('Target.attachToTarget', { targetId: bt.targetId, flatten: true });
    await send('Page.enable', {}, s);
    await send('Runtime.enable', {}, s);
    await send('Page.bringToFront', {}, s);
    note('B3-0 foreground battery tab', 'OK', 'painted tab required for LCP/CLS');
    await sleep(4200);
    const boot = await trySend('Runtime.evaluate', { expression: 'JSON.stringify({ lcp: window.__PERF?.lcp?.length ?? null, shifts: window.__PERF?.shifts?.length ?? null, tasks: window.__PERF?.longTasks?.length ?? null, __PERF: window.__PERF })', returnByValue: true }, s);
    note('B3-1 rig boot check (page-side ground truth exists)', /lcp/.test(boot.result?.value || '') ? 'YES' : 'NO — rig broken?', String(boot.result?.value ?? boot.error).replace(/\s+/g, ' ').slice(0, 400));

    // PRISTINE — the category set we ship today
    const p1 = await traceRun(s, ['loading']);
    note('B3-2 pristine [loading]', JSON.stringify(p1.interesting || p1).slice(0, 140),
      `total=${p1.total} maxChunk=${p1.maxChunk} ls=${p1.ls.slice(0, 240) || '-'}\n    lcp=${p1.lcp.slice(0, 240) || '-'} lt=${p1.lt.slice(0, 100) || '-'} complete=${JSON.stringify(p1.complete)}`);

    // BUSY-DRIVEN LongTask hunt — full overlay battery
    const p2 = await traceRun(s, ['v8', 'loading', 'devtools.timeline', 'disabled-by-default-devtools.timeline'], { busy: true, waitMs: 6400 });
    note('B3-3 busy-driven overlay [v8, loading, devtools.timeline, disabled-by-default-devtools.timeline]',
      JSON.stringify(p2.interesting || p2).slice(0, 200),
      `total=${p2.total} maxChunk=${p2.maxChunk} lt=${p2.lt.slice(0, 240) || '-'} timing=${p2.timing.slice(0, 240) || '-'} complete=${JSON.stringify(p2.complete)}\n    top=${JSON.stringify(p2.topNames).slice(0, 420)}`);

    // VOLUME — v8 + loading on the pristine page: does v8 noise blow a 50k cap before LCP/CLS?
    const p3 = await traceRun(s, ['v8', 'loading']);
    note('B3-4 volume [v8, loading] pristine', JSON.stringify(p3.interesting || p3).slice(0, 140),
      `total=${p3.total} chunks=${p3.chunkCount} maxChunk=${p3.maxChunk} complete=${JSON.stringify(p3.complete)} top=${JSON.stringify(p3.topNames).slice(0, 420)}`);

    const go = {
      LCP_on_pristine: !!(p1.interesting?.['largestContentfulPaint::Candidate'] || p1.lcp),
      CLS_on_pristine: !!p1.interesting?.LayoutShift,
      LongTask_or_RunTask_busyOverlay: !!(p2.interesting?.LongTask || p2.interesting?.RunTask || p2.lt),
      EventTiming_busyOverlay: !!(p2.interesting?.EventTiming || p2.timing),
      v8VolumeUnder50kCap: p3.total <= 50000,
    };
    results.summary = {
      go,
      pristine: { total: p1.total, interesting: p1.interesting, lcp: p1.lcp, ls: p1.ls },
      busyOverlay: { total: p2.total, lt: p2.lt, timing: p2.timing, maxChunk: p2.maxChunk },
      volume: { total: p3.total, chunks: p3.chunkCount, maxChunk: p3.maxChunk, topNames: p3.topNames },
    };
    note('B3-5 GO table', JSON.stringify(go),
      `pristine total=${p1.total}; busy-overlay total=${p2.total}; volume(v8+loading) total=${p3.total} — 50k cap ${go.v8VolumeUnder50kCap ? 'safe for parse-once' : 'NOT SAFE — incremental aggregation REQUIRED'}`);

    await trySend('Target.closeTarget', { targetId: bt.targetId });
    console.log('\nB3 probe done (tab closed).');
  } catch (e) {
    console.log('FATAL:', e.message);
  }
  fs.writeFileSync(new URL('./batch-b3-results.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), JSON.stringify(results, null, 2));
  process.exit(0);
});
ws.on('error', (e) => { console.log('WS ERROR:', e.message); process.exit(1); });
