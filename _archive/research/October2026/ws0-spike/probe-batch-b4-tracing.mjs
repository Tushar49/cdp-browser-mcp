// WS10 step-zero probe (Batch B4 — b3 rerun, self-diagnosing). One CDP connection, one Allow dialog.
// b3 anomaly: no LCP/firstPaint/LayoutShift in ANY trace (316/6104/384 total events) though RunTask (4316)
// surfaced with disabled-by-default-devtools.timeline. Paint-gated classes all absent → diagnose occlusion +
// force frames via screencast, print RAW boot-check result, full [loading] histogram.
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

let chunkSizes = [];
ws.on('message', (d) => {
  const msg = JSON.parse(d.toString());
  if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(msg.error) : p.resolve(msg.result); return; }
  if (msg.method) {
    if (msg.method === 'Tracing.dataCollected') chunkSizes.push((msg.params.value || []).length);
    events.push(msg);
  }
});
const ev = (m) => events.filter((x) => x.method === m);

async function evalJson(s, expr) {
  const r = await trySend('Runtime.evaluate', { expression: expr, returnByValue: true }, s);
  return r.ok ? r.result?.result : { error: String(r.error).slice(0, 200) };
}

async function traceRun(s, cats, { waitMs = 5800, busy = false } = {}) {
  events.length = 0;
  chunkSizes = [];
  const start = await trySend('Tracing.start', { traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: cats } }, s);
  if (!start.ok) return { startError: String(start.error).slice(0, 160) };
  await send('Page.reload', {}, s);
  if (busy) {
    for (const delay of [2600, 3300, 4000, 4700]) {
      setTimeout(() => trySend('Runtime.evaluate', { expression: 'window.__BUSY(300)', returnByValue: true }, s), delay);
    }
  }
  await sleep(waitMs);
  await trySend('Tracing.end', {}, s);
  let complete = null;
  for (let i = 0; i < 100; i++) { await sleep(250); complete = ev('Tracing.tracingComplete').at(-1); if (complete) break; }
  const raw = ev('Tracing.dataCollected').flatMap((m) => m.params.value || []).filter((e) => e.name !== 'EventTiming' || true && !/screencastFrame/.test(''));
  const by = {};
  const INTEREST_RE = /largestContentful|LayoutShift|LongTask|RunTask|EventTiming|firstPaint|firstMeaningful|firstContentful|Interaction/;
  for (const e of raw.filter((e) => INTEREST_RE.test(e.name || ''))) by[e.name] = (by[e.name] || 0) + 1;
  const allNames = {};
  for (const e of raw) allNames[e.name || '?'] = (allNames[e.name || '?'] || 0) + 1;
  const top = Object.entries(allNames).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const pick = (re) => raw.filter((e) => re.test(e.name || '')).slice(0, 2).map((e) => JSON.stringify(e).slice(0, 320)).join(' | ');
  return {
    startOk: true,
    complete: complete ? { dataLoss: !!complete.params.dataLossOccurred } : 'TIMEOUT',
    total: raw.length, chunkCount: chunkSizes.length, maxChunk: chunkSizes.length ? Math.max(...chunkSizes) : 0,
    interesting: by, topNames: top,
    ls: pick(/LayoutShift/), lcp: pick(/largestContentfulPaint::Candidate/), lt: pick(/LongTask|RunTask/), timing: pick(/EventTiming|Interaction/),
  };
}

ws.on('open', async () => {
  try {
    const bt = await send('Target.createTarget', { url: RIG + '/slow-rig.html?b4=1&fg=1' });
    await sleep(500);
    const { sessionId: s } = await send('Target.attachToTarget', { targetId: bt.targetId, flatten: true });
    await send('Page.enable', {}, s);
    await send('Runtime.enable', {}, s);
    const vis0 = await evalJson(s, 'JSON.stringify({ vis: document.visibilityState, focus: document.hasFocus(), perfIdentities: Object.keys(window.__PERF || {}), lcp: (window.__PERF?.lcp || []).length, shifts: (window.__PERF?.shifts || []).length, tasks: (window.__PERF?.longTasks || []).length })');
    note('B4-0 pre-bringToFront visibility + __PERF', '?', JSON.stringify(vis0).slice(0, 300));
    const ft = await trySend('Page.bringToFront', {}, s);
    note('B4-1 bringToFront', ft.ok ? 'OK' : 'REJECT ' + JSON.stringify(ft.error).slice(0, 120), '');
    await sleep(1500);
    const vis1 = await evalJson(s, 'JSON.stringify({ vis: document.visibilityState, focus: document.hasFocus() })');
    note('B4-2 post-bringToFront visibility', '?', JSON.stringify(vis1).slice(0, 200));
    await sleep(3000);
    const perf1 = await evalJson(s, 'JSON.stringify(window.__PERF || null)');
    note('B4-3 __PERF raw (page-side observers)', perf1?.value ? 'RECORDED' : 'EMPTY/undefined', String(JSON.stringify(perf1)).slice(0, 500).replace(/\s+/g, ' '));

    // paint-forcer: screencast makes the renderer produce frames even if window is not visibly active
    const sc = await trySend('Page.startScreencast', { format: { width: 640, height: 480, quality: 30 }, everyNthFrame: 2 }, s);
    note('B4-4 screencast paint-forcer', sc.ok ? 'ON' : 'REJECT ' + JSON.stringify(sc.error).slice(0, 120), '');
    await sleep(1200);
    const vis2 = await evalJson(s, 'JSON.stringify({ vis: document.visibilityState, focus: document.hasFocus() })');
    note('B4-5 visibility under screencast', '?', JSON.stringify(vis2).slice(0, 200));

    // T0 throwaway warmup (mirror B2/WS7 pattern — first trace is always a dud)
    const t0 = await traceRun(s, ['devtools.timeline'], { waitMs: 3800 });
    note('B4-6 WARMUP throwaway [devtools.timeline]', JSON.stringify(t0.interesting || t0).slice(0, 100),
      `total=${t0.total} complete=${JSON.stringify(t0.complete)}`);

    // T1 pristine — THE decision trace for the shipping set
    const p1 = await traceRun(s, ['loading']);
    note('B4-7 pristine [loading]', JSON.stringify(p1.interesting || p1).slice(0, 160),
      `total=${p1.total} maxChunk=${p1.maxChunk} complete=${JSON.stringify(p1.complete)}`);
    if (p1.ls || p1.lcp) note('B4-8 field samples pristine', 'CAPTURED', `ls=${p1.ls.slice(0, 300)}\n    lcp=${p1.lcp.slice(0, 300)}`);

    // T2 busy-driven overlay: LongTask/RunTask + EventTiming GO/KILL + volume
    const p2 = await traceRun(s, ['v8', 'loading', 'devtools.timeline', 'disabled-by-default-devtools.timeline'], { busy: true, waitMs: 6400 });
    note('B4-9 busy overlay [v8, loading, devtools.timeline, disabled-by-default-devtools.timeline]',
      JSON.stringify(p2.interesting || p2).slice(0, 200),
      `total=${p2.total} maxChunk=${p2.maxChunk} complete=${JSON.stringify(p2.complete)}\n    lt=${p2.lt.slice(0, 280) || '-'}\n    timing=${p2.timing.slice(0, 280) || '-'}\n    top=${JSON.stringify(p2.topNames).slice(0, 400)}`);
    if (p2.ls || p2.lcp) note('B4-10 field samples overlay', 'CAPTURED', `ls=${p2.ls.slice(0, 300)}\n    lcp=${p2.lcp.slice(0, 300)}`);

    // T3 volume: v8+loading pristine — 50k-cap check for parse-once architecture
    const p3 = await traceRun(s, ['v8', 'loading']);
    note('B4-11 volume [v8, loading] pristine', JSON.stringify(p3.interesting || p3).slice(0, 160),
      `total=${p3.total} chunks=${p3.chunkCount} maxChunk=${p3.maxChunk} complete=${JSON.stringify(p3.complete)} top=${JSON.stringify(p3.topNames).slice(0, 400)}`);

    const go = {
      LCP_on_pristine: !!p1.interesting?.['largestContentfulPaint::Candidate'],
      CLS_on_pristine: !!p1.interesting?.LayoutShift,
      LongTask_or_RunTask_busyOverlay: !!(p2.interesting?.LongTask || p2.interesting?.RunTask),
      EventTiming_anyOverlay: !!(p2.interesting?.EventTiming || p3.interesting?.EventTiming),
      v8VolumeUnder50kCap: p3.total <= 50000,
    };
    results.summary = {
      go,
      diagnostics: { vis0, vis1, vis2, perf1, screencast: sc.ok },
      pristine: { total: p1.total, interesting: p1.interesting, ls: p1.ls, lcp: p1.lcp, topNames: p1.topNames },
      busyOverlay: { total: p2.total, interesting: p2.interesting, lt: p2.lt, timing: p2.timing, maxChunk: p2.maxChunk },
      volume: { total: p3.total, chunks: p3.chunkCount, maxChunk: p3.maxChunk, topNames: p3.topNames },
    };
    note('B4-12 GO table', JSON.stringify(go),
      `vis before=${JSON.stringify(vis0)} after=${JSON.stringify(vis1)} screencast=${JSON.stringify(vis2)}; pristine total=${p1.total}; busy-overlay total=${p2.total}; volume total=${p3.total} — 50k cap ${go.v8VolumeUnder50kCap ? 'SAFE for parse-once' : 'NOT SAFE — incremental REQUIRED'}`);

    await trySend('Page.stopScreencast', {}, s);
    await trySend('Target.closeTarget', { targetId: bt.targetId });
    console.log('\nB4 probe done (tab closed).');
  } catch (e) {
    console.log('FATAL:', e.message);
  }
  fs.writeFileSync(new URL('./batch-b4-results.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), JSON.stringify(results, null, 2));
  process.exit(0);
});
ws.on('error', (e) => { console.log('WS ERROR:', e.message); process.exit(1); });
