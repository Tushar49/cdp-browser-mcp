// Raw CDP probe v3: tab-type target behavior for blank-then-navigated tab (our tabs.new + page.goto flow)
import { readFileSync } from 'fs';
import WebSocket from 'ws';

const [port, path] = readFileSync('A:\\Programs\\Browsers\\brave-portable\\data\\DevToolsActivePort', 'utf8').trim().split(/\r?\n/);
const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { maxPayload: 256 * 1024 * 1024 });
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
});
ws.on('open', async () => {
  const { targetId: pageId } = await send('Target.createTarget', { url: 'about:blank' });
  console.log('page target:', pageId);
  // attach a session and navigate like our page.goto does
  const { sessionId } = await send('Target.attachToTarget', { targetId: pageId, flatten: true });
  const sessSend = (method, params = {}) => send(method, params, sessionId = undefined) ?? null;
  const sendSess = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });
  await sendSess('Page.enable');
  await sendSess('Page.navigate', { url: 'http://localhost:8877/rig.html' });
  await new Promise((r) => setTimeout(r, 1500));

  const f = await send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, {}] });
  const tabs = (f.targetInfos ?? []).filter((t) => t.type === 'tab');
  console.log('ALL tab-type targets:', JSON.stringify(tabs.map((t) => ({ id: t.targetId, url: t.url })), null, 1));
  const plain = await send('Target.getTargets');
  const page = (plain.targetInfos ?? []).find((t) => t.targetId === pageId);
  console.log('my page target now:', JSON.stringify(page));

  // Try the trigger RAW with several candidate mappings
  const tabCands = tabs.filter((t) => t.url === page?.url);
  console.log('tab candidates by exact URL:', tabCands.length);
  if (tabCands.length === 1) {
    try {
      const r = await send('Extensions.triggerAction', { id: 'kdobafodeeolkgnfehbeppdlmbkbkgpm', targetId: tabCands[0].targetId });
      console.log('TRIGGER RAW RESULT:', JSON.stringify(r));
    } catch (e) {
      console.log('TRIGGER RAW ERROR:', e.message);
    }
  }
  await send('Target.closeTarget', { targetId: pageId });
  ws.close();
  process.exit(0);
});
ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 60000);
