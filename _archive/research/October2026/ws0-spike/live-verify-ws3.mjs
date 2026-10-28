import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const distPath = fileURLToPath(new URL('./dist/index.js', import.meta.url));
const tabId = process.argv[2];

const transport = new StdioClientTransport({ command: process.execPath, args: [distPath] });
const client = new Client({ name: 'live-webmcp', version: '0.0.1' });
await client.connect(transport);
const call = (name, args) => client.callTool({ name, arguments: args });
const firstLine = (res) => (res.content ?? []).map((x) => x.text ?? '').join('\n');

await call('page', { action: 'goto', tabId, url: 'http://127.0.0.1:8877/rig.html' });

const list = await call('page', { action: 'webmcp_list', tabId });
console.log('== webmcp_list ==\n' + firstLine(list));

const echo = await call('page', { action: 'webmcp_call', tabId, name: 'ws0_echo', input: { hello: 'ws3' } });
console.log('\n== webmcp_call ws0_echo ==\n' + firstLine(echo));

const slow = await call('page', { action: 'webmcp_call', tabId, name: 'ws0_slow', timeout: 1500 });
const slowText = firstLine(slow);
console.log('\n== webmcp_call ws0_slow (short timeout) ==\n' + slowText);
const invMatch = slowText.match(/invocation: ([0-9A-F-]+)/i);
if (invMatch) {
  const cancel = await call('page', { action: 'webmcp_cancel', tabId, invocationId: invMatch[1] });
  console.log('\n== webmcp_cancel ==\n' + firstLine(cancel));
}

console.log('\nWS3 LIVE GATE: ' + (firstLine(list).includes('ws0_echo') && firstLine(echo).includes('UNTRUSTED') ? 'PASS (list + call; cancel ' + (invMatch ? 'exercised)' : 'SKIPPED - no invocation id)') : 'FAIL'));
transport.close();
process.exit(0);
