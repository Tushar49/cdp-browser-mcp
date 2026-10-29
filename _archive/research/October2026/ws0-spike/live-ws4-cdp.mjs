// WS4 CDP-only gate — SINGLE consolidated run (one Allow dialog, no page, no
// WebAuthn ceremony, no passkey creation — everything is CDP against a
// virtual authenticator).
// (2026-10-29 rerun copy: file-url imports — archive dir has no bare
// specifier resolution; dist path absolute.)
// (2026-10-29 rerun copy: file-url imports — archive dir has no bare
// specifier resolution; dist path absolute.)
import { randomBytes, generateKeyPairSync } from 'crypto';
const sdk = 'file:///' + 'A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/'.replace(/ /g, '%20');
const { Client } = await import(sdk + 'index.js');
const { StdioClientTransport } = await import(sdk + 'stdio.js');

const distPath = 'A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/dist/index.js';
const transport = new StdioClientTransport({ command: process.execPath, args: [distPath] });
const client = new Client({ name: 'live-ws4-cdp', version: '0.0.1' });
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

await call('webauthn', { action: 'reset', tabId });
const add = textOf(await call('webauthn', { action: 'add_authenticator', tabId }));
const authId = add.match(/created: ([A-Za-z0-9-]+)/)?.[1];
check('add_authenticator', !!authId, authId ?? add.split('\n')[0]);

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pkcs8B64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const credIdB64u = randomBytes(32).toString('base64url');
const added = textOf(await call('webauthn', {
  action: 'add_credential', authenticatorId: authId,
  credentialId: credIdB64u, privateKey: pkcs8B64,
  userHandle: randomBytes(16).toString('base64'),
  rpId: 'example.com', isResidentCredential: true, signCount: 1,
}));
check('add_credential', added.includes('added'), added.split('\n')[0]);

const props = textOf(await call('webauthn', {
  action: 'set_credential_properties', authenticatorId: authId, credentialId: credIdB64u,
  backupEligibility: true, backupState: true, signCount: 42,
}));
check('set_credential_properties (backup flags + counter)', props.includes('updated'), props);

const list = textOf(await call('webauthn', { action: 'list_credentials', authenticatorId: authId, fullIds: true }));
check('list_credentials: flags + signCount 42 persisted', list.includes('backed-up') && list.includes('signCount: 42'),
  list.split('\n').filter((l) => l.includes('signCount') || l.includes('backed-up')).join(' / '));
// CDP echoes base64url back in the standard alphabet (normalizeBase64 on the
// way in) — compare in the standard alphabet, not the URL-safe one.
const credIdStd = (() => {
  let std = credIdB64u.replace(/-/g, '+').replace(/_/g, '/');
  while (std.length % 4) std += '=';
  return std;
})();
check('fullIds prints untruncated id', list.includes(credIdStd), 'searched=' + credIdStd.slice(0, 20) + '… got=' + list.split('\n').filter((l) => l.includes('credentialId')).join(' | '));

const removed = textOf(await call('webauthn', {
  action: 'set_credential_properties', authenticatorId: authId, credentialId: credIdB64u, signCount: -1,
}));
const list2 = textOf(await call('webauthn', { action: 'list_credentials', authenticatorId: authId }));
check('signCount -1 removes the counter', removed.includes('REMOVED') && list2.includes('signCount: none'),
  removed.split('\n')[0] + ' | ' + list2.split('\n').filter((l) => l.includes('signCount')).join(' / '));

const backupOff = textOf(await call('webauthn', {
  action: 'set_credential_properties', authenticatorId: authId, credentialId: credIdB64u,
  backupEligibility: false, backupState: false,
}));
const list3 = textOf(await call('webauthn', { action: 'list_credentials', authenticatorId: authId }));
check('backup flags can be cleared', backupOff.includes('updated') && !list3.includes('backed-up'), backupOff.split('\n')[0]);

await call('webauthn', { action: 'reset', tabId });
await call('page', { action: 'goto', tabId, url: 'about:blank' });

console.log(failures === 0 ? '\nWS4 CDP-ONLY GATE: PASS' : `\nWS4 CDP-ONLY GATE: ${failures} FAILURE(S)`);
transport.close();
process.exit(failures === 0 ? 0 : 1);
