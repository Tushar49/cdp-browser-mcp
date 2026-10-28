import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const WebSocket = require('A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/ws');

const [port, ...rest] = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/);
const targetId = process.argv[3];
const browserPath = rest.join('').trim();

let id = 0;
const pending = new Map();
const handlers = [];
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function waitEvent(test, ms) {
  return new Promise((resolve) => {
    const h = (msg) => { if (test(msg)) { cleanup(); resolve(msg); } };
    const t = setTimeout(() => { cleanup(); resolve(null); }, ms);
    function cleanup() { clearTimeout(t); const i = handlers.indexOf(h); if (i >= 0) handlers.splice(i, 1); }
    handlers.push(h);
  });
}
const ws = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`, { maxPayload: 256 * 1024 * 1024, perMessageDeflate: false });
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  } else if (msg.method) {
    for (const h of handlers) h(msg);
  }
});
ws.on('open', async () => {
  try {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);

    const toolsAddedP = waitEvent(m => m.method === 'WebMCP.toolsAdded' && m.params.tools?.length, 4000);
    await send('WebMCP.enable', {}, sessionId);
    const toolsAdded = await toolsAddedP;
    const tool = toolsAdded.params.tools.find(t => t.name === 'ws0_echo') || toolsAdded.params.tools[0];
    console.log('== tool from registry ==', tool.name);

    const invoked = await send('WebMCP.invokeTool', { frameId: tool.frameId, toolName: tool.name, input: { hello: 'ws0' } }, sessionId);
    console.log('== invocationId ==', invoked.invocationId);
    const resp = await waitEvent(m => m.method === 'WebMCP.toolResponded' && m.params.invocationId === invoked.invocationId, 10000);
    console.log('== toolResponded ==', JSON.stringify(resp && resp.params, null, 2));

    const canceled = resp && resp.params.status === 'Completed' && resp.params.output && resp.params.output.echo?.hello === 'ws0';
    console.log(canceled ? 'E2E VERDICT: PASS — register → toolsAdded → invokeTool → toolResponded Completed with echoed output' : 'E2E VERDICT: FAIL — inspect above');
    process.exit(canceled ? 0 : 1);
  } catch (e) {
    console.log('PROBE ERROR:', e.message);
    process.exit(1);
  }
});
ws.on('error', (e) => { console.log('WS ERROR:', e.message); process.exit(1); });
