// WSD live gate — ONE MCP connection (DevToolsActivePort via CDP_USER_DATA).
// ByRule rule-list UX round-trip: preset → list, full replace → list,
// append → list, remove-index → list, invalid index → actionable error,
// reset → empty list.
const sdk = 'file:///' + 'A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/'.replace(/ /g, '%20');
const { Client } = await import(sdk + 'index.js');
const { StdioClientTransport } = await import(sdk + 'stdio.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/dist/index.js'],
  env: { ...process.env, CDP_USER_DATA: 'A:\\Programs\\Browsers\\brave-portable\\data' },
});
const client = new Client({ name: 'live-wsd', version: '0.0.1' });
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

const newTab = textOf(await call('tabs', { action: 'new', url: 'http://127.0.0.1:8877/wsa-rig.html?wsdgate=1' }));
const tabId = newTab.match(/\[([0-9A-F]{32})\]/)?.[1];
if (!tabId) { console.log(newTab); process.exit(1); }
console.log('gate tab:', tabId);
await call('tabs', { action: 'activate', tabId });
await sleep(300);

const A = { urlPattern: 'https://a.example/*', latency: 10, downloadThroughput: -1, uploadThroughput: -1 };
const B = { urlPattern: 'https://b.example/*', latency: 500, downloadThroughput: 80000, uploadThroughput: -1 };
const C = { urlPattern: 'https://c.example/*', latency: 20, downloadThroughput: 1000, uploadThroughput: 1000 };

// 1) preset rides ByRule → visible in the list
const presetSet = textOf(await call('emulate', { tabId, networkCondition: 'slow3g' }));
console.log('\npreset set:', presetSet);
const list1 = textOf(await call('emulate', { tabId, networkRulesList: true }));
console.log('list after preset:\n' + list1);
check('preset appears as one active rule', list1.includes('Network rules: 1 active'), list1.split('\n')[0]);
check('preset rule carries slow3g numbers', list1.includes('latency 2000ms') && list1.includes('down 50000B/s'), '');

// 2) full replace → ordered list
await call('emulate', { tabId, networkRules: [A, B] });
const list2 = textOf(await call('emulate', { tabId, networkRulesList: true }));
console.log('\nlist after replace:\n' + list2);
check('full replace renders 2 indexed rules in order', /\[0\] urlPattern="https:\/\/a\.example\/\*"/.test(list2) && /\[1\] urlPattern="https:\/\/b\.example\/\*"/.test(list2), '');
check('first-match order is stated', list2.includes('index order = evaluation order'), '');

// 3) append → 3 active
await call('emulate', { tabId, networkRulesAppend: C });
const list3 = textOf(await call('emulate', { tabId, networkRulesList: true }));
console.log('\nlist after append:\n' + list3);
check('append adds the rule at the tail', list3.includes('Network rules: 3 active') && /\[2\] urlPattern="https:\/\/c\.example\/\*"/.test(list3), list3.split('\n')[0]);

// 4) remove index 1 (B) → A, C reindexed
const removed = textOf(await call('emulate', { tabId, networkRulesRemove: 1 }));
console.log('\nremove [1]:', removed);
const list4 = textOf(await call('emulate', { tabId, networkRulesList: true }));
console.log('list after remove:\n' + list4);
check('remove re-pushes the remainder reindexed', /\[0\] urlPattern="https:\/\/a\.example\/\*"/.test(list4) && /\[1\] urlPattern="https:\/\/c\.example\/\*"/.test(list4) && !list4.includes('b.example'), '');

// 5) invalid index → actionable error (no mutation)
const bad = textOf(await call('emulate', { tabId, networkRulesRemove: 9 }));
console.log('\nremove [9]:', bad);
check('invalid index fails actionably with the valid range', bad.includes('index 9 is out of range') && bad.includes('0-1'), bad.split('\n')[0]);
const list5 = textOf(await call('emulate', { tabId, networkRulesList: true }));
check('invalid remove left the list untouched', /\[0\] urlPattern="https:\/\/a\.example\/\*"/.test(list5) && list5.includes('2 active'), '');

// 6) reset → empty list
await call('emulate', { tabId, reset: true });
const list6 = textOf(await call('emulate', { tabId, networkRulesList: true }));
console.log('\nlist after reset:', list6);
check('reset clears the tracked rule list', list6.includes('none active'), list6.split('\n')[0]);

await call('tabs', { action: 'close', tabId });
console.log(`\nRESULT: ${failures === 0 ? 'GATE PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);
