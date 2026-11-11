const sdk = 'file:///' + 'A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/'.replace(/ /g, '%20');
const { Client } = await import(sdk + 'index.js');
const { StdioClientTransport } = await import(sdk + 'stdio.js');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/dist/index.js'],
  env: { ...process.env, CDP_DEBUG: '1' },
});
const client = new Client({ name: 'probe-disc', version: '0.0.1' });
await client.connect(transport);
const call = (name, args, ms = 20000) => client.callTool({ name, arguments: args }, undefined, { timeout: ms });
const textOf = (res) => {
  const raw = (res && Array.isArray(res.content)) ? res.content.map((x) => (x && typeof x.text === 'string') ? x.text : '').join('\n') : String(res?.error?.message ?? res ?? '');
  return typeof raw === 'string' ? raw : String(raw);
};
for (const [label, fn] of [
  ['browser profiles', () => call('browser', { action: 'profiles' })],
  ['browser active', () => call('browser', { action: 'active' })],
]) {
  const t = Date.now();
  try {
    const out = textOf(await fn());
    console.log(`\n=== ${label} (${Date.now() - t}ms) ===\n${out.slice(0, 2000)}`);
  } catch (e) {
    console.log(`\n=== ${label} ERROR (${Date.now() - t}ms) === ${e?.message ?? e}`);
  }
}
process.exit(0);
