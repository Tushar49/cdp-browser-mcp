const sdk = 'file:///' + 'A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/'.replace(/ /g, '%20');
const { Client } = await import(sdk + 'index.js');
const { StdioClientTransport } = await import(sdk + 'stdio.js');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/dist/index.js'],
});
const client = new Client({ name: 'probe-wsa-fail', version: '0.0.1' });
await client.connect(transport);
const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 140_000 });
const textOf = (res) => {
  const raw = (res && Array.isArray(res.content)) ? res.content.map((x) => (x && typeof x.text === 'string') ? x.text : '').join('\n') : String(res?.error?.message ?? res ?? '');
  return typeof raw === 'string' ? raw : String(raw);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const newTab = textOf(await call('tabs', { action: 'new', url: 'http://127.0.0.1:8877/wsa-rig.html?failprobe=1' }));
const tabId = newTab.match(/\[([0-9A-F]{32})\]/)?.[1];
console.log('tab:', tabId);
await sleep(1500);
console.log('readyState:', textOf(await call('execute', { tabId, action: 'eval', expression: 'document.readyState' })));
console.log('hits-fn:', textOf(await call('execute', { tabId, action: 'eval', expression: 'typeof window.hit' })));

console.log('\n--- text=ShadowButton ---');
console.log(textOf(await call('interact', { tabId, action: 'click', selector: 'text=ShadowButton' })));
console.log('\n--- text=LateButton ---');
console.log(textOf(await call('interact', { tabId, action: 'click', selector: 'text=LateButton', timeout: 8000 })));
console.log('\n--- css=#css-target ---');
console.log(textOf(await call('interact', { tabId, action: 'click', selector: 'css=#css-target' })));
await sleep(300);
console.log('hits:', textOf(await call('execute', { tabId, action: 'eval', expression: 'window.__HITS.join(",")' })));
await call('tabs', { action: 'close', tabId });
process.exit(0);
