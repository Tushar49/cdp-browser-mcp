// WS5 live gate: content format 'annotated' parses the real proto into a
// labeled tree. Single run; opens one tab, neutralizes it at the end.
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const distPath = fileURLToPath(new URL('./dist/index.js', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [distPath] });
const client = new Client({ name: 'live-ws5', version: '0.0.1' });
await client.connect(transport);
const call = (name, args) => client.callTool({ name, arguments: args });
const textOf = (res) => (res.content ?? []).map((x) => x.text ?? '').join('\n');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const newTab = textOf(await call('tabs', { action: 'new' }));
const tabId = newTab.match(/\[([0-9A-F]{32})\]/)?.[1];
console.log('battery tab:', tabId);

await call('page', { action: 'goto', tabId, url: 'http://localhost:8877/rig.html' });
const annotated = textOf(await call('page', { action: 'content', tabId, format: 'annotated' }));

check('APC header present (parsed, not fallback)', annotated.includes('[APC]'), annotated.split('\n')[0]);
check('no fallback marker (parse succeeded)', !annotated.includes('parseFailed'), annotated.split('\n')[0]);
const hasStructure = /\[APC\]|\b(link|form|input|heading|#)\b/.test(annotated) && annotated.split('\n').length > 2;
check('labeled tree rendered', hasStructure, `${annotated.split('\n').length} lines`);
console.log('--- first 25 lines ---');
console.log(annotated.split('\n').slice(0, 25).join('\n'));

await call('page', { action: 'goto', tabId, url: 'about:blank' });
console.log(failures === 0 ? '\nWS5 LIVE GATE: PASS' : `\nWS5 LIVE GATE: ${failures} FAILURE(S)`);
transport.close();
process.exit(failures === 0 ? 0 : 1);
