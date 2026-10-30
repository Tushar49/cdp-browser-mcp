// WS12 — EventTiming bounded retry (ONE CDP connection, ONE Allow dialog).
// The WS10/12 plan: exactly one retry for the EventTiming/INP class, needing
// a REAL user-driven input event. Flow: trace ['v8','loading'] starts →
// short settle → CLICK WINDOW (you click inside the rig tab, 2 deliberate
// clicks) → settle → Tracing.end → count EventTiming / Interaction events.
// GO ⇒ the class moves to the 5.5 carcass as first-class (input-dependent
// usage note required); re-KILL ⇒ verb "retry spent". No product changes
// inside 5.4.0 either way.
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WebSocket = require('A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/ws');

const RIG = 'http://localhost:8877';
const [port, ...rest] = fs.readFileSync('A:/.devTools/cache/temp/opencode/ws0/b3-port.txt', 'utf8').trim().split(/\r?\n/);
const browserPath = rest.join('').trim();
const ws = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`, { maxPayload: 1024 * 1024 * 1024, perMessageDeflate: false });
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

ws.on('message', (d) => {
  const msg = JSON.parse(d.toString());
  if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(msg.error) : p.resolve(msg.result); return; }
  if (msg.method) events.push(msg);
});
const ev = (m) => events.filter((x) => x.method === m);

ws.on('open', async () => {
  try {
    const bt = await send('Target.createTarget', { url: RIG + '/slow-rig.html?ws12retry=1' });
    await sleep(500);
    const { sessionId: s } = await send('Target.attachToTarget', { targetId: bt.targetId, flatten: true });
    await send('Page.enable', {}, s);
    await send('Runtime.enable', {}, s);
    await send('Page.bringToFront', {}, s);
    await sleep(2500);

    const start = await trySend('Tracing.start', { traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: ['v8', 'loading', 'devtools.timeline'] } }, s);
    if (!start.ok) throw new Error('Tracing.start: ' + start.error);
    console.log('>>> TRACE RUNNING — CLICK INSIDE THE RIG TAB NOW (2 deliberate clicks). 7 seconds…');
    await sleep(7000);
    console.log('>>> window closed — harvesting…');
    await sleep(800);
    await trySend('Tracing.end', {}, s);
    let complete = null;
    for (let i = 0; i < 100; i++) { await sleep(250); complete = ev('Tracing.tracingComplete').at(-1); if (complete) break; }
    const raw = ev('Tracing.dataCollected').flatMap((m) => m.params.value || []);
    const by = {};
    for (const e of raw.filter((e) => /EventTiming|Interaction|EventDispatch|InputLatency|textInput|mouse/i.test(e.name || ''))) by[e.name] = (by[e.name] || 0) + 1;
    const allNames = {};
    for (const e of raw) allNames[e.name || '?'] = (allNames[e.name || '?'] || 0) + 1;
    const top = Object.entries(allNames).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const sample = raw.filter((e) => /EventTiming|Interaction/i.test(e.name || '')).slice(0, 2).map((e) => JSON.stringify(e).slice(0, 300));
    const out = {
      at: new Date().toISOString(),
      totalEvents: raw.length,
      interesting: by,
      topNames: top,
      samples: sample,
      dataLoss: complete ? !!complete.params.dataLossOccurred : 'TIMEOUT',
    };
    console.log('\nverdict inputs:', JSON.stringify(out, null, 2).slice(0, 1800));
    fs.writeFileSync(new URL('./batch-b5-results.json', import.meta.url), JSON.stringify(out, null, 2));
    await trySend('Target.closeTarget', { targetId: bt.targetId });
    console.log('\nretry harvest done (tab closed).');
  } catch (e) {
    console.log('FATAL:', e.message);
  }
  process.exit(0);
});
ws.on('error', (e) => { console.log('WS ERROR:', e.message); process.exit(1); });
