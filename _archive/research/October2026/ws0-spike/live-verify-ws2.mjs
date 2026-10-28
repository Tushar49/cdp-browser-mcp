import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const distPath = fileURLToPath(new URL('./dist/index.js', import.meta.url));
const tabId = process.argv[2];

const transport = new StdioClientTransport({ command: process.execPath, args: [distPath] });
const client = new Client({ name: 'live-verify', version: '0.0.1' });
await client.connect(transport);

const checks = [
  { check: 'visible', selector: '#gate-enabled' },
  { check: 'visible', selector: '#gate-hidden' },
  { check: 'text', value: 'quick brown fox' },
  { check: 'text', value: 'not-present-xyz' },
  { check: 'url', value: 'http://127.0.0.1:8877', mode: 'prefix' },
  { check: 'url', value: 'https://wrong.example.com', mode: 'exact' },
  { check: 'title', value: 'WS0 WebMCP spike rig' },
  { check: 'enabled', selector: '#gate-enabled' },
  { check: 'enabled', selector: '#gate-disabled' },
  { check: 'value', selector: '#gate-input', value: 'prefilled-value' },
];
let passCount = 0;
let failCount = 0;
for (const c of checks) {
  const res = await client.callTool({ name: 'page', arguments: { action: 'verify', tabId, ...c } });
  const text = (res.content ?? []).map((x) => x.text ?? '').join(' ').split('\n')[0];
  if (text.startsWith('PASS')) passCount++; else failCount++;
  console.log(`${String(res.isError)}  ${JSON.stringify(c)} => ${text}`);
}

// Polling live check: reload adds "late-arriving" text via injected delayed script
await client.callTool({ name: 'page', arguments: { action: 'inject', tabId, script: `setTimeout(() => {
  const el = document.createElement('div');
  el.id = 'late-arriving';
  el.textContent = 'late-arriving-text';
  document.body.appendChild(el);
}, 1200);` } });
await client.callTool({ name: 'page', arguments: { action: 'reload', tabId } });
const polled = await client.callTool({ name: 'page', arguments: { action: 'verify', tabId, check: 'text', value: 'late-arriving-text', timeout: 5000 } });
const polledText = (polled.content ?? []).map((x) => x.text ?? '').join(' ').split('\n')[0];
console.log(`poll => ${polledText}`);
console.log(`\nBATTERY: ${passCount} expected-PASS checked, ${failCount} expected-FAIL checked`);
console.log(/PASS.*attempts/.test(polledText) ? 'LIVE GATE VERDICT: PASS (incl. polling)' : 'LIVE GATE VERDICT: check polling line above');
transport.close();
process.exit(0);
