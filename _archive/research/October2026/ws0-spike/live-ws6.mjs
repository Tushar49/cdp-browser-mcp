// WS6 live gate: Extensions listing + opt-in toolbar trigger + guardrails.
// Single connection. Opens one tab, neutralizes it at the end.
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const allowlist = 'kdobafodeeolkgnfehbeppdlmbkbkgpm'; // WS6 Test Extension (user-loaded)
const distPath = fileURLToPath(new URL('./dist/index.js', import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [distPath],
  env: { ...process.env, CDP_EXTENSION_TRIGGER_ALLOWLIST: allowlist },
});
const client = new Client({ name: 'live-ws6', version: '0.0.1' });
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

// 1. listing shows the user-loaded unpacked extension
const list = textOf(await call('browser', { action: 'extensions' }));
console.log(list.split('\n').slice(0, 4).join('\n'));
check('listing shows the unpacked extension', list.includes('WS6 Test Extension') && list.includes(allowlist), list.split('\n')[0]);
check('listing includes version/path/enabled', /\bv1\.0\.0\b/.test(list) && /path:/i.test(list) && list.includes('enabled'), '');

// 2. guardrail: a NON-listed id must fail with the env remedy
const negative = textOf(await call('browser', { action: 'trigger_extension', id: 'ffffffffffffffffffffffffffffffff', tabId }));
check('non-listed id blocked with remedy', negative.includes('not allow-listed') && negative.includes('CDP_EXTENSION_TRIGGER_ALLOWLIST'), negative.split('\n')[0]);

// 3. allow-listed trigger fires (the user should see the popup bubble)
// Trigger on a REAL page — about:blank may not satisfy the action's enabled state
await call('page', { action: 'goto', tabId, url: 'http://localhost:8877/rig.html' });
const trigger = textOf(await call('browser', { action: 'trigger_extension', id: allowlist, tabId }));
check('allow-listed trigger fired', trigger.includes('triggered') && trigger.includes('UNTRUSTED'), trigger);
console.log('--- full trigger result ---');
console.log(trigger);

await call('page', { action: 'goto', tabId, url: 'about:blank' });
console.log(failures === 0 ? '\nWS6 LIVE GATE: PASS' : `\nWS6 LIVE GATE: ${failures} FAILURE(S)`);
transport.close();
process.exit(failures === 0 ? 0 : 1);
