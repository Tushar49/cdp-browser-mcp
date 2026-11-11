// WSB live gate — ONE MCP connection (DevToolsActivePort via CDP_USER_DATA,
// no approval dialog). Records with categories:['v8'], dispatches TRUSTED
// CDP input during the window, and asserts EventTiming interaction insights.
const sdk = 'file:///' + 'A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/'.replace(/ /g, '%20');
const { Client } = await import(sdk + 'index.js');
const { StdioClientTransport } = await import(sdk + 'stdio.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/dist/index.js'],
  env: { ...process.env, CDP_USER_DATA: 'A:\\Programs\\Browsers\\brave-portable\\data' },
});
const client = new Client({ name: 'live-wsb', version: '0.0.1' });
await client.connect(transport);
const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 140_000 });
const textOf = (res) => {
  const raw = (res && Array.isArray(res.content)) ? res.content.map((x) => (x && typeof x.text === 'string') ? x.text : '').join('\n') : String(res?.error?.message ?? res ?? '');
  return typeof raw === 'string' ? raw : String(raw);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const newTab = textOf(await call('tabs', { action: 'new', url: 'http://127.0.0.1:8877/wsa-rig.html?wsbgate=1' }));
const tabId = newTab.match(/\[([0-9A-F]{32})\]/)?.[1];
if (!tabId) { console.log(newTab); process.exit(1); }
console.log('gate tab:', tabId);
await call('tabs', { action: 'activate', tabId });
await sleep(400);

const startOut = textOf(await call('observe', { tabId, action: 'perf_start', categories: ['v8'] }));
console.log('start:', startOut.split('\n')[0]);
check('perf_start advertises v8 interaction capture', startOut.includes('Interact with the page') && startOut.includes('interaction latency'), startOut.split('\n')[0]);

// Trusted CDP input during the trace window (pointer + keyboard).
await call('interact', { tabId, action: 'click', selector: 'text=UniqueTextTarget' });
await sleep(120);
await call('interact', { tabId, action: 'click', selector: 'text=UniqueTextTarget' });
await sleep(120);
await call('interact', { tabId, action: 'click', selector: 'testid=submit-btn' });
await sleep(120);
await call('interact', { tabId, action: 'press', key: 'Tab' });
await sleep(120);
await call('interact', { tabId, action: 'press', key: 'Enter' });
await sleep(400);

const stopOut = textOf(await call('observe', { tabId, action: 'perf_stop' }));
console.log('\n──── perf_stop output ────\n' + stopOut + '\n────────────');
check('perf_stop reports interaction insights section', /Interaction latency — EventTiming|v8 category was on but no EventTiming/.test(stopOut), stopOut.split('\n').slice(-1)[0]);
check('at least one interaction captured with a duration', /- \w+ — dur [\d.]+ms/.test(stopOut), (stopOut.match(/- \w+ — dur [\d.]+ms[^\n]*/) || ['none'])[0]);

await call('tabs', { action: 'close', tabId });
console.log(`\nRESULT: ${failures === 0 ? 'GATE PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);
