// WS9 live gate — ONE connection (MCP fresh-dist client):
// CDP-set partitioned cookie → get_cookies shows it → export → clear → import →
// IDENTICAL partitionKey (object equality). CDP-path per the WS7 reshaped gate.
const sdk = 'file:///' + 'A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/'.replace(/ /g, '%20');
const [{ Client: C }] = [await import(sdk + 'index.js')];
const [{ StdioClientTransport: TST }] = [await import(sdk + 'stdio.js')];
const transport = new TST({
  command: process.execPath,
  args: ['A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/dist/index.js'],
});
const client = new C({ name: 'live-ws9', version: '0.0.1' });
await client.connect(transport);
const call = (name, args) => client.callTool({ name, arguments: args });
const textOf = (res) => (res.content ?? []).map((x) => x.text ?? '').join('\n');
const jsonFrom = (t) => { const i = t.indexOf('{'); const j = t.lastIndexOf('}'); return i >= 0 && j > i ? JSON.parse(t.slice(i, j + 1)) : null; };

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const newTab = textOf(await call('tabs', { action: 'new', url: 'http://localhost:8877/chips.html?ws9gate=1' }));
const tabId = newTab.match(/\[([0-9A-F]{32})\]/)?.[1];
console.log('gate tab:', tabId);
await new Promise((r) => setTimeout(r, 900));

// 1 ── set partitioned cookie via the TOOL (string shorthand → auto-Secure)
const setOut = textOf(await call('storage', { action: 'set_cookie', tabId, name: 'ws9_pk', value: 'roundtrip', partitionKey: 'http://localhost' }));
check('set_cookie partitionKey string shorthand', setOut.includes('Cookie set: ws9_pk'), setOut.split('\n')[0]);

// 2 ── get_cookies surfaces | partitioned:
const getC = textOf(await call('storage', { action: 'get_cookies', tabId, urls: ['http://localhost:8877/'] }));
check('get_cookies shows | partitioned: http://localhost', getC.includes('| partitioned: http://localhost'), (getC.split('\n').find((l) => l.includes('ws9_pk')) ?? '').trim());

// 3 ── export_state captures it
const expOut = textOf(await call('storage', { action: 'export_state', tabId }));
const state = jsonFrom(expOut);
const exported = state?.cookies?.find((c) => c.name === 'ws9_pk');
check('export_state carries partitionKey passthrough', exported && exported.partitionKey && exported.partitionKey.topLevelSite === 'http://localhost', exported ? JSON.stringify(exported.partitionKey) : 'missing');

// 4 ── clear + verify gone
await call('storage', { action: 'clear_cookies', tabId });
const gone = textOf(await call('storage', { action: 'get_cookies', tabId, urls: ['http://localhost:8877/'] }));
check('cleared', !gone.includes('ws9_pk'), gone.split('\n')[0]);

// 5 ── import → identical partitionKey (object equality)
const impOut = textOf(await call('storage', { action: 'import_state', tabId, clearFirst: true, state: (() => { const s = JSON.parse(JSON.stringify(state)); return s; })() }));
check('import sets the partitioned cookie', impOut.includes('cookie(s) set') && !/failed|skipped/i.test(impOut), impOut.split('\n')[0]);

// 6 ── verify the round-trip key equality at ground truth
const reGet = textOf(await call('storage', { action: 'get_cookies', tabId, urls: ['http://localhost:8877/'] }));
const hasCookie = reGet.includes('ws9_pk');
const pkShown = reGet.includes('| partitioned: http://localhost');
check('imported cookie shows partitioned: http://localhost', hasCookie && pkShown, (reGet.match(/ws9_pk[\s\S]{0,200}/)?.[0] ?? 'missing').replace(/\s+/g, ' ').slice(0, 200));
// object equality AFTER round-trip via export again
const reExpOut = textOf(await call('storage', { action: 'export_state', tabId }));
const reState = jsonFrom(reExpOut);
const rePk = reState?.cookies?.find((c) => c.name === 'ws9_pk')?.partitionKey;
check('round-trip partitionKey OBJECT equality', JSON.stringify(rePk) === JSON.stringify({ topLevelSite: 'http://localhost', hasCrossSiteAncestor: false }) || JSON.stringify(rePk) === JSON.stringify({ topLevelSite: 'http://localhost' }), rePk ? JSON.stringify(rePk) : 'missing');

// 7 ── partition-scoped delete (uses the param, ground truth via get)
await call('storage', { action: 'delete_cookies', tabId, name: 'ws9_pk', url: 'http://localhost:8877/', partitionKey: 'http://localhost' });
const afterDel = textOf(await call('storage', { action: 'get_cookies', tabId, urls: ['http://localhost:8877/'] }));
check('partition-scoped delete removes it', !afterDel.includes('ws9_pk'), 'ground truth via get_cookies');

await call('tabs', { action: 'close', tabId });
console.log(`\ngate tab closed. RESULT: ${failures === 0 ? 'GATE PASS' : failures + ' FAILURES'}`);
transport.constructor; // keep import shape
process.exit(failures === 0 ? 0 : 1);
