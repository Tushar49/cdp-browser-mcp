// WS7 C9 standalone — MCP dist regression (spawned server = own CDP attach).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/dist/index.js'],
});
const client = new Client({ name: 'ws7-c9-regression', version: '0.0.1' });
await client.connect(transport);
const textOf = (res) => (res.content ?? []).map((x) => x.text ?? '').join('\n');
const ping = textOf(await client.callTool({ name: 'ping', arguments: {} }));
const status = textOf(await client.callTool({ name: 'status', arguments: {} }));
console.log('ping →', ping.split('\n').slice(0, 2).join(' | '));
console.log('status →', status.replace(/\s+/g, ' ').slice(0, 200));
console.log(ping.includes('5.3.0') && /Mode/.test(status) ? 'REGRESSION: PASS' : 'REGRESSION: CHECK');
await transport.close().catch(() => {});
process.exit(0);
