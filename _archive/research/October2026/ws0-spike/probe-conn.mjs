const sdk = 'file:///' + 'A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/'.replace(/ /g, '%20');
const { Client } = await import(sdk + 'index.js');
const { StdioClientTransport } = await import(sdk + 'stdio.js');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/dist/index.js'],
});
const client = new Client({ name: 'probe-conn', version: '0.0.1' });
const t0 = Date.now();
await client.connect(transport);
console.log('connect ms:', Date.now() - t0);
const call = (name, args, ms = 15000) => client.callTool({ name, arguments: args }, undefined, { timeout: ms });
const textOf = (res) => {
  const raw = (res && Array.isArray(res.content)) ? res.content.map((x) => (x && typeof x.text === 'string') ? x.text : '').join('\n') : String(res?.error?.message ?? res ?? '');
  return typeof raw === 'string' ? raw : String(raw);
};
for (const [label, fn] of [
  ['ping', () => call('ping', {})],
  ['status', () => call('status', {})],
  ['tabs list', () => call('tabs', { action: 'list' })],
  ['tabs new', () => call('tabs', { action: 'new', url: 'http://127.0.0.1:8877/wsa-rig.html?connprobe=1' })],
]) {
  const t = Date.now();
  try {
    const out = textOf(await fn());
    console.log(`${label}: ${Date.now() - t}ms -> ${out.split('\n')[0].slice(0, 120)}`);
  } catch (e) {
    console.log(`${label}: ${Date.now() - t}ms -> ERROR ${e?.message ?? e}`);
    break;
  }
}
process.exit(0);
