// WS7 Batch A adjunct — CHIPS diagnostic (one connection): what actually
// happened in the tab + iframe, and setCookie partitionKey shape variants.
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WebSocket = require('A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/ws');

const RIG = 'http://localhost:8877';
const out = (s) => console.log(s);

const [port, ...rest] = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/);
const browserPath = rest.join('').trim();
const t0 = Date.now();
let id = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const msgId = ++id;
  pending.set(msgId, { resolve, reject: (e) => reject(new Error(method + ' → ' + JSON.stringify(e))) });
  ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const trySend = async (method, params = {}, sessionId) => { try { return { ok: true, result: await send(method, params, sessionId) }; } catch (e) { return { ok: false, error: e.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`, { maxPayload: 128 * 1024 * 1024, perMessageDeflate: false });
console.log('WS connecting… if this stalls, the browser is showing the CDP Allow dialog — click it.');
ws.on('open', () => console.log('WS open (' + (Date.now() - t0) + 'ms) — proceeding'));
ws.on('message', (d) => {
  const msg = JSON.parse(d.toString());
  if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(msg.error) : p.resolve(msg.result); }
});
const evl = (exp, s) => send('Runtime.evaluate', { expression: exp, returnByValue: true, awaitPromise: exp.includes('async') }, s);

ws.on('open', async () => {
  try {
    const bt = await send('Target.createTarget', { url: RIG + '/chips.html?debug=1' });
    await sleep(1800);
    // top-page introspection
    const { sessionId: s } = await send('Target.attachToTarget', { targetId: bt.targetId, flatten: true });
    await send('Runtime.enable', {}, s);
    const top = await evl(`JSON.stringify({href: location.href, bodyLen: document.body.innerHTML.length, hasTop: 'CHIPS_TOP' in window, top: window.__CHIPS_TOP?.slice(0,160), iframes: [...document.querySelectorAll('iframe')].length, iframeSrc: [...document.querySelectorAll('iframe')].map(f=>f.src)})`, s);
    out('TOP PAGE → ' + JSON.stringify(top.result.value));
    const cookiesTop = await evl(`document.cookie`, s);
    out('top document.cookie → ' + JSON.stringify(cookiesTop.result.value));

    // find the iframe target directly
    const targets = await send('Target.getTargets', {});
    const iframes = targets.targetInfos.filter((t) => (t.url || '').includes('chips-iframe'));
    out('IFRAME TARGETS → ' + JSON.stringify(iframes.map((t) => ({ type: t.type, url: t.url }))));
    for (const t of iframes) {
      const at = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).catch((e) => ({ err: e.message }));
      if (at.err) { out('iframe attach failed: ' + at.err.slice(0, 160)); continue; }
      const diag = await evl(`JSON.stringify({d: window.__CHIPS_IFRAME, ck: document.cookie, secureCtx: !!window.isSecureContext})`, at.sessionId);
      out('IFRAME STATE → ' + JSON.stringify(diag.result.value));
    }

    // setCookie partitionKey shape variants (protocol-level, backward-CHIPS)
    const variants = [
      { v: 'https-site-secure', body: { name: 'ws7_v1', value: 'x', url: RIG + '/chips.html', secure: true, partitionKey: { topLevelSite: 'http://localhost', hasCrossSiteAncestor: false } } },
      { v: 'schemeful-site-plain', body: { name: 'ws7_v2', value: 'x', url: RIG + '/chips.html', partitionKey: { topLevelSite: 'localhost' } } },
      { v: 'no-hasCrossSiteAncestor', body: { name: 'ws7_v3', value: 'x', url: RIG + '/chips.html', partitionKey: { topLevelSite: 'http://localhost' } } },
      { v: 'storage.setCookies', body: null },
    ];
    for (const { v, body } of variants) {
      if (!body) {
        const r = await trySend('Storage.setCookies', { cookies: [{ name: 'ws7_v4', value: 'x', url: RIG + '/chips.html', partitionKey: { topLevelSite: 'http://localhost', hasCrossSiteAncestor: false } }] });
        out(`variant ${v} → ${r.ok ? 'accepted' : 'rejected ' + String(r.error).slice(0, 140)}`);
      } else {
        const r = await trySend('Network.setCookie', body, s);
        out(`variant ${v} → ${r.ok && r.result.success !== false ? 'accepted ' + JSON.stringify(r.result) : 'rejected ' + String(r.error).slice(0, 140)}`);
      }
    }
    const ncols = await trySend('Storage.getCookies', {});
    out('post-variants cookies (ws7 names) → ' + JSON.stringify(ncols.ok ? ncols.result.cookies.filter((c) => /ws7_|chips/.test(c.name)) : String(ncols.error).slice(0, 200)));

    await send('Target.closeTarget', { targetId: bt.targetId }).catch(() => {});
    out('\ndebug tab closed (ours).');
  } catch (e) {
    out('FATAL: ' + e.message);
  }
  process.exit(0);
});
ws.on('error', (e) => { out('WS ERROR: ' + e.message); process.exit(1); });
