// WS8 live gate — ONE connection (MCP dist client):
// tool-level ByRule transport on the live Brave 153.
import { fileURLToPath } from 'url';
const sdk = 'file:///' + 'A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/'.replace(/ /g, '%20');
const { Client } = await import(sdk + 'index.js');
const { StdioClientTransport } = await import(sdk + 'stdio.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/dist/index.js'],
});
const client = new Client({ name: 'live-ws8', version: '0.0.1' });
await client.connect(transport);
const call = (name, args) => client.callTool({ name, arguments: args });
const textOf = (res) => (res.content ?? []).map((x) => x.text ?? '').join('\n');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};
const timing = async (tabId) => {
  const r = textOf(await call('execute', {
    tabId, action: 'eval',
    expression: "(async () => { const t = performance.now(); await fetch('http://localhost:8877/slow-rig.html?ws8=' + performance.now(), {cache:'no-store'}); return (performance.now()-t).toFixed(0); })()",
  }));
  return parseFloat(r) || -1;
};

const newTab = textOf(await call('tabs', { action: 'new', url: 'http://localhost:8877/slow-rig.html?ws8gate=1' }));
const tabId = newTab.match(/\[([0-9A-F]{32})\]/)?.[1];
console.log('gate tab:', tabId);
await new Promise((r) => setTimeout(r, 800));

// 1 ── baseline timing (no throttle)
const baseline = await timing(tabId);
check('baseline fetch fast', baseline >= 0 && baseline < 500, `${baseline}ms`);

// 2 ── slow3g preset via ByRule transport
const throttleSet = textOf(await call('emulate', { tabId, networkCondition: 'slow3g' }));
check('slow3g accepted (output shape unchanged)', throttleSet.includes('Network: slow3g'), throttleSet.split('\n')[0]);
await new Promise((r) => setTimeout(r, 300));
const throttled = await timing(tabId);
check('slow3g throttle lands (2s latency)', throttled > baseline + 1200, `${throttled}ms vs baseline ${baseline}ms`);

// 3 ── networkRules override precedence (rules win over preset)
const rules = textOf(await call('emulate', {
  tabId,
  networkRules: [{ urlPattern: 'http://localhost:8877/*', latency: 300, downloadThroughput: -1, uploadThroughput: -1 }],
}));
check('networkRules accepted', rules.includes('Network rules: 1 rule(s), first-match-wins'), rules.split('\n')[0]);
await new Promise((r) => setTimeout(r, 300));
const ruled = await timing(tabId);
check('networkRules timing replaces preset (300ms latency)', ruled < throttled - 1000 && ruled > 200, `${ruled}ms`);

// 4 ── overrideNetworkState
await call('emulate', { tabId, overrideNetworkState: true });
const online = textOf(await call('execute', { tabId, action: 'eval', expression: 'navigator.onLine + "|" + (navigator.connection?.effectiveType || "none")' }));
check('overrideNetworkState(true) → navigator offline', online.startsWith('false|'), online);

// 5 ── reset: clears rules + restores navigator.onLine
const resetOut = textOf(await call('emulate', { tabId, reset: true }));
check('reset applied', /reset/i.test(resetOut), resetOut.split('\n')[0]);
const after = await timing(tabId);
check('reset un-throttles', after < 500, `${after}ms`);
const onlineAfter = textOf(await call('execute', { tabId, action: 'eval', expression: 'navigator.onLine' }));
check('reset restores navigator.onLine', onlineAfter === 'true', onlineAfter);

// teardown: our gate tab
await call('tabs', { action: 'close', tabId });
console.log(`\ngate tab closed. RESULT: ${failures === 0 ? 'GATE PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);
