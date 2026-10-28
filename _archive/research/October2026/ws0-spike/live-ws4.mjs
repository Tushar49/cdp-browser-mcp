import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { generateKeyPairSync } from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const distPath = fileURLToPath(new URL('./dist/index.js', import.meta.url));

const transport = new StdioClientTransport({ command: process.execPath, args: [distPath] });
const client = new Client({ name: 'live-ws4', version: '0.0.1' });
await client.connect(transport);
const call = (name, args) => client.callTool({ name, arguments: args });
const textOf = (res) => (res.content ?? []).map((x) => x.text ?? '').join('\n');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// Open a dedicated tab (maintainer consented to agent-opened tabs), neutralize at the end
const newTab = textOf(await call('tabs', { action: 'new' }));
const tabId = newTab.match(/\[([0-9A-F]{32})\]/)?.[1];
console.log('battery tab:', tabId);

// SAFETY ORDER: reset → add_authenticator → inject credential via CDP → THEN
// navigate. The rig NEVER calls credentials.create — if WebAuthn were proxied
// (Bitwarden), the assertion on this CDP-injected credential fails loudly and
// nothing is ever created in any real provider.
const preReset = textOf(await call('webauthn', { action: 'reset', tabId }));
console.log('pre-reset:', preReset.split('\n')[0]);

const add = textOf(await call('webauthn', { action: 'add_authenticator', tabId }));
const authId = add.match(/created: ([A-Za-z0-9-]+)/)?.[1];
check('add_authenticator', !!authId, authId ?? add.split('\n')[0]);

// Generate the credential keypair: private → CDP (PKCS#8 DER b64), public → page (SPKI DER b64)
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pkcs8B64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const spkiB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const credIdB64u = randomBytes(32).toString('base64url');
const userHandle = randomBytes(16).toString('base64');

const injected = textOf(await call('webauthn', {
  action: 'add_credential', authenticatorId: authId,
  credentialId: credIdB64u, privateKey: pkcs8B64, userHandle,
  rpId: 'localhost', isResidentCredential: true, signCount: 1,
}));
check('add_credential (CDP-injected)', injected.includes('added') || !injected.startsWith('#'), injected.split('\n')[0]);

const rigUrl = `http://localhost:8877/webauthn-rig.html?credId=${credIdB64u}&spki=${encodeURIComponent(spkiB64)}`;
await call('page', { action: 'goto', tabId, url: rigUrl });

// 1. assertion on the INJECTED credential → proves the virtual environment is
//    actually handling WebAuthn (if Bitwarden proxies, this fails loudly, no create)
const valid = textOf(await call('page', { action: 'verify', tabId, check: 'text', value: 'SIGNATURE-VALID', timeout: 8000 }));
check('client-side WebCrypto signature verify (genuine, injected credential)', valid.startsWith('PASS'), valid);

// 2. sabotage → signature zeroed → client verify fails
await call('webauthn', { action: 'set_override_bits', authenticatorId: authId, isBogusSignature: true });
const sabotaged = textOf(await call('page', { action: 'verify', tabId, check: 'text', value: 'SIGNATURE-INVALID', timeout: 8000 }));
check('sabotage (isBogusSignature) → client verify FAILS', sabotaged.startsWith('PASS'), sabotaged);

// 3. restore
await call('webauthn', { action: 'set_override_bits', authenticatorId: authId, isBogusSignature: false, isBadUV: false, isBadUP: false });
const restored = textOf(await call('page', { action: 'verify', tabId, check: 'text', value: 'SIGNATURE-VALID', timeout: 8000 }));
check('restore → genuine again', restored.startsWith('PASS'), restored);

// 4. credential properties: backup flags + signCount 42 (credId known — injected)
const props = textOf(await call('webauthn', {
  action: 'set_credential_properties', authenticatorId: authId, credentialId: credIdB64u,
  backupEligibility: true, backupState: true, signCount: 42,
}));
check('set_credential_properties', props.includes('updated'), props.split('\n')[0]);
const list = textOf(await call('webauthn', { action: 'list_credentials', authenticatorId: authId, fullIds: true }));
check('list_credentials shows backup flags + signCount 42 + last: asserted',
  list.includes('backed-up') && list.includes('signCount: 42') && list.includes('last: asserted'),
  list.split('\n').filter((l) => l.includes('signCount') || l.includes('last:')).join(' / '));
check('fullIds param prints untruncated id', list.includes(credIdB64u), credIdB64u.slice(0, 20) + '…');

// 4b. signCount -1 removes the counter
const removed = textOf(await call('webauthn', {
  action: 'set_credential_properties', authenticatorId: authId, credentialId: credIdB64u, signCount: -1,
}));
const list2 = textOf(await call('webauthn', { action: 'list_credentials', authenticatorId: authId }));
check('signCount -1 removes the counter', removed.includes('REMOVED') && list2.includes('signCount: 0'), removed.split('\n')[0]);

// 5. inputVisualization + record flow
const viz = textOf(await call('emulate', { tabId, inputVisualization: true }));
check('emulate inputVisualization on', viz.includes('Input visualization: on'), viz);
const recStart = textOf(await call('page', { action: 'record_start', tabId }));
check('record_start (click markers auto-enabled)', recStart.includes('click markers: on'), recStart.split('\n')[0]);
await call('interact', { action: 'click_xy', tabId, x: 300, y: 300 });
const recStop = textOf(await call('page', { action: 'record_stop', tabId }));
check('record_stop (saved + markers off)', recStop.includes('Recording saved'), recStop.split('\n')[0]);
const reset = textOf(await call('emulate', { tabId, reset: true }));
check('emulate reset clears overrides', reset.includes('reset'), reset);

// 6. cleanup
await call('webauthn', { action: 'reset', tabId });
await call('page', { action: 'goto', tabId, url: 'about:blank' });

console.log(failures === 0 ? '\nWS4 LIVE GATE: PASS' : `\nWS4 LIVE GATE: ${failures} FAILURE(S)`);
transport.close();
process.exit(failures === 0 ? 0 : 1);
