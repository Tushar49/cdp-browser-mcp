import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WebSocket = require('A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/ws');

const [port, ...rest] = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/);
const rigUrl = process.argv[3] || 'http://127.0.0.1:8877/rig.html';
const wantedTargetId = process.argv[4];
const browserPath = rest.join('').trim();

const log = (...a) => console.log(...a);
const ws = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`, { maxPayload: 256 * 1024 * 1024, perMessageDeflate: false });

let id = 0;
const pending = new Map();
const handlers = [];
const webmcpEvents = [];
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  } else if (msg.method) {
    if (msg.method.startsWith('WebMCP.')) webmcpEvents.push(msg);
    for (const h of handlers) h(msg);
  }
});
ws.on('open', async () => {
  try {
    const { sessionId } = await send('Target.attachToTarget', { targetId: wantedTargetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);

    log('== navigate (listener active BEFORE navigate) ==');
    await send('Page.navigate', { url: rigUrl }, sessionId);
    await waitEvent(m => m.method === 'Page.loadEventFired' && m.sessionId === sessionId, 15000);
    await sleep(1500);

    const ev = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__WS0DIAG || {error:"diag missing"})', returnByValue: true }, sessionId);
    log('== page diagnostics ==', ev.result.value);

    log('== WebMCP.enable (listener active BEFORE enable) ==');
    try { await send('WebMCP.enable', {}, sessionId); log('enable OK'); }
    catch (e) { log('enable FAILED:', e.message); }
    await sleep(3000);

    log('== re-register ws0_echo2 post-enable ==');
    const re = await send('Runtime.evaluate', {
      expression: `(() => { try { document.modelContext.registerTool({ name: 'ws0_echo2', description: 'post-enable re-register probe', execute: (i) => ({ echo: i ?? null }) }); return 'registered'; } catch (e) { return 'ERR: ' + e; } })()`,
      returnByValue: true
    }, sessionId);
    log('re-register:', re.result.value);
    await sleep(3000);

    log('== ALL WebMCP.* events captured ==');
    for (const m of webmcpEvents) log(m.method, JSON.stringify(m.params).slice(0, 300));

    if (!webmcpEvents.length) log('VERDICT: OUTCOME-A-NOWIRE (page API live, zero CDP WebMCP events — passthrough premature)');
    else log('VERDICT: see events above');
    process.exit(0);
  } catch (e) {
    log('PROBE ERROR:', e.message);
    process.exitCode = 1;
    process.exit(1);
  }
  function waitEvent(test, ms) {
    return new Promise((resolve) => {
      const h = (msg) => { if (test(msg)) { cleanup(); resolve(msg); } };
      const t = setTimeout(() => { cleanup(); resolve(null); }, ms);
      function cleanup() { clearTimeout(t); const i = handlers.indexOf(h); if (i >= 0) handlers.splice(i, 1); }
      handlers.push(h);
    });
  }
});
ws.on('error', (e) => { console.log('WS ERROR:', e.message); process.exitCode = 1; });
