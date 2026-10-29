/**
 * WebAuthn virtual-authenticator automation tool (5.2 WS1).
 *
 * Lets agents test passkey flows without a real security key: create virtual
 * authenticators on a tab's CDP session, inject credentials into them, list
 * what the browser stored, and drive presence/user-verification simulation —
 * including negative-testing override bits (bogus signature, bad UV/UP).
 *
 * Routing rule (oracle-verified): every authenticatorId-taking command is sent
 * through the OWNING tab's session, resolved live via tabSessions.getSession
 * (recorded session ids die on re-attach; authenticators are target-side state
 * and survive re-attach). `WebAuthn.enable` is per-session state, so
 * `add_authenticator` unconditionally sends it right before creating the
 * authenticator — the call is idempotent.
 *
 * Profile safety: virtual authenticators live in CDP memory only. Nothing is
 * written to the user's real keyring; everything dies with the CDP session.
 */

import type { ServerContext, ToolResult } from '../types.js';
import { randomUUID } from 'crypto';
import { fail, ok } from '../utils/helpers.js';
import { Errors } from '../utils/error-handler.js';
import { defineTool } from './base-tool.js';
import type { ToolRegistry } from './registry.js';
import { WebAuthnStateManager, type AuthenticatorRecord, type CredentialActivity } from '../session/webauthn-state.js';

// ─── Constants ──────────────────────────────────────────────────────

const TRANSPORTS = ['usb', 'nfc', 'ble', 'cable', 'hybrid', 'smart-card', 'internal'] as const;
const CTAP2_VERSIONS = ['ctap2_0', 'ctap2_1', 'ctap2_2'] as const;

/** Zero-config defaults: platform-style passkey authenticator that auto-approves everything. */
const DEFAULT_OPTIONS: Record<string, unknown> = {
  protocol: 'ctap2',
  transport: 'internal',
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
};

// ─── Helpers ────────────────────────────────────────────────────────

async function getTabSession(ctx: ServerContext, tabId: string): Promise<string> {
  return ctx.tabSessions.getSession(ctx.cdpClient, tabId);
}

/** Resolve the session of the tab that OWNS an authenticator (live, never cached). */
async function ownerSession(ctx: ServerContext, authenticatorId: string): Promise<string> {
  const record = ctx.webauthnState.get(authenticatorId);
  if (!record) {
    throw Errors.authenticatorNotFound(authenticatorId, ctx.webauthnState.list().map((r) => r.authenticatorId));
  }
  const sess = await getTabSession(ctx, record.ownerTabId);
  // `WebAuthn.enable` is per-CDP-session state that dies on session re-attach
  // (live-verified: "Virtual Authenticator Environment has not been enabled for
  // this session" after a cross-process navigation swapped the session). Every
  // authenticator command therefore best-effort re-enables first — idempotent.
  await ctx.sendCommand('WebAuthn.enable', { enableUI: false }, sess).catch(() => {});
  return sess;
}

/**
 * CDP binary fields REQUIRE padded standard base64 (live-verified: unpadded
 * and URL-safe alphabets are rejected by Chromium bindings with "invalid
 * base64 string"). Normalize: URL-safe → standard, strip whitespace, pad.
 */
function normalizeBase64(s: string): string {
  let v = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  while (v.length % 4 !== 0) v += '=';
  return v;
}

/** Shape check for CDP binary (base64) params — standard/URL-safe, padding optional. */
function isBase64Shape(s: string): boolean {
  return /^[A-Za-z0-9+/=_-]+$/.test(s) && s.length > 0;
}

/** Returns an error message when a binary param is malformed, null when fine. */
function base64Error(value: unknown, field: string): string | null {
  if (typeof value === 'string' && !isBase64Shape(value)) {
    return `Parameter "${field}" is not valid base64. CDP binary fields accept base64 (standard or URL-safe alphabet, padding optional) — privateKey is PKCS#8 DER of an ECDSA P-256 key.`;
  }
  return null;
}

/**
 * Validate VirtualAuthenticatorOptions combinations against Chromium's
 * addVirtualAuthenticator rules (webauthn_handler.cc): largeBlob/cmtgKey
 * require a resident key; credBlob/largeBlob/minPinLength/hmacSecret require
 * CTAP2; u2f+cable is invalid; ctap2Version only applies to ctap2.
 */
function validateOptionCombinations(p: Record<string, unknown>): string | null {
  const protocol = (p.protocol as string | undefined) ?? 'ctap2';
  const transport = (p.transport as string | undefined) ?? 'internal';
  const hasResidentKey = (p.hasResidentKey as boolean | undefined) ?? true;
  const ext = (p.extensions ?? {}) as Record<string, unknown>;
  const wantsLargeBlob = ext.largeBlob === true;
  const wantsCredBlob = ext.credBlob === true;
  const wantsMinPinLength = ext.minPinLength === true;
  const wantsHmacSecret = ext.hmacSecret === true;
  const wantsCmtgKey = ext.cmtgKey === true;

  if (protocol === 'u2f' && transport === 'cable') return 'transport "cable" is invalid with protocol "u2f"';
  if ((wantsLargeBlob || wantsCmtgKey) && !hasResidentKey) {
    return 'largeBlob and cmtgKey extensions require hasResidentKey: true';
  }
  if (protocol !== 'ctap2') {
    const ctapOnly = [wantsCredBlob, wantsLargeBlob, wantsMinPinLength, wantsHmacSecret].some(Boolean);
    if (ctapOnly) return 'credBlob/largeBlob/minPinLength/hmacSecret extensions require protocol "ctap2"';
    if (p.ctap2Version !== undefined) return 'ctap2Version only applies to protocol "ctap2"';
  }
  return null;
}

/** Map raw CDP errors from WebAuthn commands into actionable failures. */
function mapCdpWebAuthnError(ctx: ServerContext, err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  if (/one internal authenticator/i.test(msg)) {
    return Errors.internalAuthenticatorConflict(ctx.webauthnState.listInternal()).toToolResult();
  }
  if (/virtual (authenticator )?environment|WebAuthn\.enable/i.test(msg)) {
    return fail(
      'WebAuthn virtual environment is not enabled on this tab\'s session (it dies on re-attach).\n' +
        'Re-create it: webauthn({ action: "add_authenticator", tabId }) — add_authenticator re-enables automatically.',
    );
  }
  throw err;
}

function describeOptions(options: Record<string, unknown>): string {
  const parts = Object.entries(options).map(([k, v]) => `${k}: ${String(v)}`);
  return parts.join(', ');
}

function formatCredential(c: Record<string, unknown>, activity?: CredentialActivity, fullId = false): string {
  const id = String(c.credentialId ?? '');
  const lines = [
    `- credentialId: ${fullId ? id : id.slice(0, 24) + (id.length > 24 ? '…' : '')}`,
    `  rpId: ${c.rpId ?? '(none)'} | resident: ${c.isResidentCredential ? 'yes' : 'no'} | signCount: ${c.signCount === -1 ? 'none' : (c.signCount ?? 0)}`,
  ];
  const userBits: string[] = [];
  if (c.userName) userBits.push(`user: ${c.userName}`);
  if (c.userDisplayName) userBits.push(`display: ${c.userDisplayName}`);
  if (userBits.length) lines.push(`  ${userBits.join(' | ')}`);
  const flags: string[] = [];
  if (c.backupEligibility === true) flags.push('backup-eligible');
  if (c.backupState === true) flags.push('backed-up');
  if (c.largeBlob !== undefined && c.largeBlob !== null) {
    flags.push(`largeBlob: ${Buffer.from(String(c.largeBlob), 'base64').length}B`);
  }
  if (flags.length) lines.push(`  ${flags.join(' | ')}`);
  if (activity) {
    const time = new Date(activity.lastTs).toLocaleTimeString();
    const sc = activity.signCount !== undefined ? `, signCount ${activity.signCount}` : '';
    lines.push(`  last: ${activity.lastEvent} ${time}${sc}`);
  }
  return lines.join('\n');
}

// ─── Action Handlers ────────────────────────────────────────────────

export async function handleAddAuthenticator(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  const tabId = p.tabId as string;
  const sess = await getTabSession(ctx, tabId);
  await ctx.capabilities.require(ctx.cdpClient, 'WebAuthn', undefined, sess);

  const validationError = validateOptionCombinations(p);
  if (validationError) return fail(`Invalid authenticator options: ${validationError}.`);

  const extensions = (p.extensions ?? {}) as Record<string, unknown>;
  const options: Record<string, unknown> = { ...DEFAULT_OPTIONS };
  for (const key of ['protocol', 'transport', 'hasResidentKey', 'hasUserVerification', 'isUserVerified', 'automaticPresenceSimulation'] as const) {
    if (p[key] !== undefined) options[key] = p[key];
  }
  if (options.protocol === 'ctap2' && p.ctap2Version !== undefined) options.ctap2Version = p.ctap2Version;
  const extMap: Record<string, string> = {
    prf: 'hasPrf', largeBlob: 'hasLargeBlob', credBlob: 'hasCredBlob',
    minPinLength: 'hasMinPinLength', hmacSecret: 'hasHmacSecret', cmtgKey: 'hasCmtgKey',
  };
  for (const [k, option] of Object.entries(extMap)) {
    if (extensions[k] === true) options[option] = true;
  }

  // enable is per-session and idempotent — always send right before creating.
  try {
    await ctx.sendCommand('WebAuthn.enable', { enableUI: false }, sess);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail(`Could not enable the WebAuthn virtual environment: ${msg}`);
  }

  try {
    const r = (await ctx.sendCommand('WebAuthn.addVirtualAuthenticator', { options }, sess)) as {
      authenticatorId: string;
    };
    const record: AuthenticatorRecord = { ownerTabId: tabId, options, createdAt: Date.now() };
    ctx.webauthnState.register(r.authenticatorId, record);
    return ok(`Virtual authenticator created: ${r.authenticatorId}\nOwner tab: ${tabId}\nOptions: ${describeOptions(options)}\n\n` +
      `Next steps — drive the page (page navigate/interact) and the authenticator auto-responds. ` +
      `Inspect what was stored: webauthn({ action: "list_credentials", authenticatorId: "${r.authenticatorId.slice(0, 12)}…" })`);
  } catch (err) {
    return mapCdpWebAuthnError(ctx, err);
  }
}

export async function handleRemoveAuthenticator(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  const authenticatorId = p.authenticatorId as string;
  const sess = await ownerSession(ctx, authenticatorId);
  await ctx.capabilities.require(ctx.cdpClient, 'WebAuthn', undefined, sess);
  await ctx.sendCommand('WebAuthn.removeVirtualAuthenticator', { authenticatorId }, sess);
  ctx.webauthnState.unregister(authenticatorId);
  return ok(`Virtual authenticator removed: ${authenticatorId.slice(0, 12)}…`);
}

export function handleListAuthenticators(ctx: ServerContext): ToolResult {
  const all = ctx.webauthnState.list();
  if (!all.length) {
    return ok('No virtual authenticators. Create one: webauthn({ action: "add_authenticator", tabId })');
  }
  const lines = all.map((r) =>
    `- ${r.authenticatorId.slice(0, 12)}… | owner tab: ${r.ownerTabId} | ${describeOptions(r.options)}`,
  );
  return ok(`${all.length} virtual authenticator(s):\n${lines.join('\n')}`);
}

export async function handleAddCredential(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  const authenticatorId = p.authenticatorId as string;
  const sess = await ownerSession(ctx, authenticatorId);
  await ctx.capabilities.require(ctx.cdpClient, 'WebAuthn', undefined, sess);

  for (const field of ['credentialId', 'privateKey', 'userHandle', 'largeBlob']) {
    const err = base64Error(p[field], field);
    if (err) return fail(err);
  }
  if (!p.privateKey) return fail('add_credential requires privateKey (ECDSA P-256 key in PKCS#8 DER, base64-encoded).');
  if (!p.credentialId) return fail('add_credential requires credentialId (base64).');
  if (!p.rpId) return fail('add_credential requires rpId — the Relying Party ID the credential is scoped to (e.g. "webauthn.io").');

  const isResident = p.isResidentCredential ?? true;
  // Chromium requires a userHandle for resident credentials (live-verified:
  // "The User Handle is required for Resident Credentials"). Auto-generate one
  // when omitted so agents don't need to know this rule.
  let userHandleAutoGenerated = false;
  let userHandle = p.userHandle as string | undefined;
  if (isResident && !userHandle) {
    userHandle = randomUUID().replace(/-/g, '').slice(0, 32);
    // randomUUID chars are hex — encode as 16 raw bytes, then base64
    userHandle = Buffer.from(userHandle, 'hex').toString('base64');
    userHandleAutoGenerated = true;
  }

  const credential: Record<string, unknown> = {
    credentialId: normalizeBase64(p.credentialId as string),
    isResidentCredential: isResident,
    rpId: p.rpId,
    privateKey: normalizeBase64(p.privateKey as string),
    signCount: typeof p.signCount === 'number' ? p.signCount : 0,
  };
  if (userHandle !== undefined) credential.userHandle = normalizeBase64(userHandle);
  if (p.largeBlob !== undefined) credential.largeBlob = normalizeBase64(p.largeBlob as string);
  if (p.userName !== undefined) credential.userName = p.userName;
  if (p.userDisplayName !== undefined) credential.userDisplayName = p.userDisplayName;
  if (p.backupEligibility !== undefined) credential.backupEligibility = p.backupEligibility;
  if (p.backupState !== undefined) credential.backupState = p.backupState;

  try {
    await ctx.sendCommand('WebAuthn.addCredential', { authenticatorId, credential }, sess);
  } catch (err) {
    return mapCdpWebAuthnError(ctx, err);
  }
  return ok(`Credential added to ${authenticatorId.slice(0, 12)}… (rpId: ${String(p.rpId)}, resident: ${isResident ? 'yes' : 'no'}${userHandleAutoGenerated ? ', userHandle auto-generated' : ''}). ` +
    'Navigate to the RP and trigger the sign-in flow — the browser will use this credential.');
}

export async function handleListCredentials(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  const authenticatorId = p.authenticatorId as string;
  const sess = await ownerSession(ctx, authenticatorId);
  await ctx.capabilities.require(ctx.cdpClient, 'WebAuthn', undefined, sess);
  let r: { credentials?: Array<Record<string, unknown>> };
  try {
    r = (await ctx.sendCommand('WebAuthn.getCredentials', { authenticatorId }, sess)) as { credentials?: Array<Record<string, unknown>> };
  } catch (err) {
    return mapCdpWebAuthnError(ctx, err);
  }
  const creds = r.credentials ?? [];
  if (!creds.length) {
    return ok(`Authenticator ${authenticatorId.slice(0, 12)}… holds 0 credentials. ` +
      'Credentials appear after the page runs navigator.credentials.create (or inject one: add_credential).');
  }
  const activity = ctx.webauthnState.credentialActivity(authenticatorId);
  const fullIds = p.fullIds === true;
  const formatted = creds.map((c) => formatCredential(c, activity?.get(String(c.credentialId)), fullIds)).join('\n');
  const result = ok(`Authenticator ${authenticatorId.slice(0, 12)}… holds ${creds.length} credential(s):\n${formatted}`);
  // 5.3.5 §WS4-rerun fix (canary-caught, live at the battery rerun): the WS1
  // scrubber's PLAIN_PAIR masks `credentialId: …` (SECRET_KEY matches
  // "credential") — defeating fullIds' documented purpose (untruncated ids
  // must be copyable into remove_credential / set_credential_properties).
  // A virtual-authenticator credential ID is an identifier scoped to the
  // session's own authenticator, not a secret. Scoped opt-out, export_state
  // precedent (the listing carries ids/rpId/counters — never key material).
  return { ...result, _noScrub: true };
}

export async function handleRemoveCredential(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  const authenticatorId = p.authenticatorId as string;
  const sess = await ownerSession(ctx, authenticatorId);
  await ctx.capabilities.require(ctx.cdpClient, 'WebAuthn', undefined, sess);
  if (!p.credentialId) return fail('remove_credential requires credentialId (base64) — get it from list_credentials.');
  try {
    await ctx.sendCommand('WebAuthn.removeCredential', { authenticatorId, credentialId: p.credentialId }, sess);
  } catch (err) {
    return mapCdpWebAuthnError(ctx, err);
  }
  return ok('Credential removed.');
}

export async function handleClearCredentials(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  const authenticatorId = p.authenticatorId as string;
  const sess = await ownerSession(ctx, authenticatorId);
  await ctx.capabilities.require(ctx.cdpClient, 'WebAuthn', undefined, sess);
  try {
    await ctx.sendCommand('WebAuthn.clearCredentials', { authenticatorId }, sess);
  } catch (err) {
    return mapCdpWebAuthnError(ctx, err);
  }
  return ok('All credentials cleared from the authenticator.');
}

export async function handleSetUserVerified(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  const authenticatorId = p.authenticatorId as string;
  const sess = await ownerSession(ctx, authenticatorId);
  await ctx.capabilities.require(ctx.cdpClient, 'WebAuthn', undefined, sess);
  const isUserVerified = p.isUserVerified ?? true;
  try {
    await ctx.sendCommand('WebAuthn.setUserVerified', { authenticatorId, isUserVerified }, sess);
  } catch (err) {
    return mapCdpWebAuthnError(ctx, err);
  }
  return ok(`User verification ${isUserVerified ? 'succeeds' : 'FAILS'} for this authenticator. ` +
    'Sites requiring UV will get NotAllowedError while it is false.');
}

export async function handleSetPresenceSimulation(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  const authenticatorId = p.authenticatorId as string;
  const sess = await ownerSession(ctx, authenticatorId);
  await ctx.capabilities.require(ctx.cdpClient, 'WebAuthn', undefined, sess);
  const enabled = p.enabled ?? true;
  try {
    await ctx.sendCommand('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled }, sess);
  } catch (err) {
    return mapCdpWebAuthnError(ctx, err);
  }
  return ok(enabled
    ? 'Presence simulation ON — create/get calls resolve immediately.'
    : 'Presence simulation OFF — create/get calls will hang until re-enabled (use this to test timeouts).');
}

export async function handleSetOverrideBits(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  const authenticatorId = p.authenticatorId as string;
  const sess = await ownerSession(ctx, authenticatorId);
  await ctx.capabilities.require(ctx.cdpClient, 'WebAuthn', undefined, sess);
  const bits = { isBogusSignature: p.isBogusSignature, isBadUV: p.isBadUV, isBadUP: p.isBadUP };
  const anySet = Object.values(bits).some((v) => v === true);
  try {
    await ctx.sendCommand('WebAuthn.setResponseOverrideBits', { authenticatorId, ...bits }, sess);
  } catch (err) {
    return mapCdpWebAuthnError(ctx, err);
  }
  return ok(anySet
    ? 'Response override bits SET — the next assertion is sabotaged (zeroed signature / UV / UP flag). Expect the site\'s flow to reject it.'
    : 'Response override bits CLEARED — authenticator responses are genuine again.');
}

/**
 * 5.3 WS4: mutate a stored credential — backup flags and/or the signature
 * counter. `signCount: -1` removes the counter (protocol-verified; great for
 * testing signCount-monotonicity handling in relying parties).
 */
export async function handleSetCredentialProperties(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  const authenticatorId = p.authenticatorId as string;
  const credentialId = p.credentialId as string;
  if (!credentialId) return fail('set_credential_properties requires credentialId — get it from list_credentials.');
  const sess = await ownerSession(ctx, authenticatorId);
  await ctx.capabilities.require(ctx.cdpClient, 'WebAuthn', undefined, sess);

  const props: Record<string, unknown> = { authenticatorId, credentialId: normalizeBase64(credentialId) };
  const changes: string[] = [];
  if (p.backupEligibility !== undefined) {
    props.backupEligibility = p.backupEligibility;
    changes.push(`backupEligibility: ${p.backupEligibility}`);
  }
  if (p.backupState !== undefined) {
    props.backupState = p.backupState;
    changes.push(`backupState: ${p.backupState}`);
  }
  if (p.signCount !== undefined) {
    props.signCount = p.signCount;
    changes.push(p.signCount === -1 ? 'signCount: counter REMOVED' : `signCount: ${p.signCount}`);
  }
  if (!changes.length) {
    return fail('Provide at least one of: backupEligibility, backupState, signCount (-1 removes the counter).');
  }
  try {
    await ctx.sendCommand('WebAuthn.setCredentialProperties', props, sess);
  } catch (err) {
    return mapCdpWebAuthnError(ctx, err);
  }
  return ok(`Credential properties updated — ${changes.join(', ')}.`);
}

export async function handleReset(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  const tabId = p.tabId as string;
  const sess = await getTabSession(ctx, tabId);
  await ctx.capabilities.require(ctx.cdpClient, 'WebAuthn', undefined, sess);
  const ids = ctx.webauthnState.listByTab(tabId);
  const removed: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of ids) {
    try {
      await ctx.sendCommand('WebAuthn.removeVirtualAuthenticator', { authenticatorId: id }, sess);
      ctx.webauthnState.unregister(id);
      removed.push(id.slice(0, 12) + '…');
    } catch (err) {
      failed.push({ id: id.slice(0, 12) + '…', error: (err instanceof Error ? err.message : String(err)).slice(0, 120) });
    }
  }
  await ctx.sendCommand('WebAuthn.disable', {}, sess).catch(() => {});
  const parts = [`WebAuthn reset for tab ${tabId}: removed ${removed.length} authenticator(s) and disabled the virtual environment.`];
  if (removed.length) parts.push(`Removed: ${removed.join(', ')}`);
  if (failed.length) parts.push(`Failed to remove:\n${failed.map((f) => `- ${f.id}: ${f.error}`).join('\n')}`);
  return ok(parts.join('\n'));
}

// ─── Registration ───────────────────────────────────────────────────

export function registerWebauthnTools(
  registry: ToolRegistry,
  _ctx: ServerContext,
): void {
  registry.register(defineWebauthnTool());
}

function defineWebauthnTool() {
  const actions = [
    'add_authenticator', 'remove_authenticator', 'list_authenticators',
    'add_credential', 'list_credentials', 'remove_credential', 'clear_credentials',
    'set_user_verified', 'set_presence_simulation', 'set_override_bits',
    'set_credential_properties', 'reset',
  ] as const;

  return defineTool({
    name: 'webauthn',
    description: [
      'Use this to test passkey/WebAuthn login flows with virtual authenticators — no real security key needed. Create a virtual authenticator on a tab, then drive the page normally: the browser intercepts navigator.credentials.create/get and the virtual authenticator auto-responds.',
      '',
      'IMPORTANT: virtual authenticators live in browser memory only — nothing touches the user\'s real keyring. They die when the tab closes, the browser exits, or this server disconnects; they SURVIVE in-tab session re-attaches (process swaps) orphaned from the registry. Create the authenticator BEFORE the page runs its WebAuthn calls. The passkey flow\'s success signal is the PAGE\'s state afterwards — verify with page snapshots, not webauthn return values. Caveat: pages using conditional mediation (page-load autofill WebAuthn) can starve the site\'s own credentials.create — reload first, or pre-provision with add_credential. CAVEAT 2: if a password-manager extension with passkey interception is active (Bitwarden, etc.), it proxies ALL page WebAuthn requests at the browser level and the virtual authenticator is bypassed — assertions time out and creates go to the real vault. Disable the extension\'s passkey support when testing virtual-authenticator flows.',
      '',
      'Operations:',
      '- add_authenticator: Create a virtual authenticator (requires: tabId; optional: protocol[ctap2|u2f], transport[internal|usb|nfc|ble|cable|hybrid|smart-card], hasResidentKey, hasUserVerification, isUserVerified, automaticPresenceSimulation, ctap2Version[ctap2_0|ctap2_1|ctap2_2], extensions{prf,largeBlob,credBlob,minPinLength,hmacSecret,cmtgKey}). Defaults: ctap2/internal/resident-key/UV-verified/auto-presence — a platform passkey that approves everything. Re-enables the virtual environment automatically.',
      '- remove_authenticator: Remove one (requires: authenticatorId)',
      '- list_authenticators: List authenticators created by this server (no params)',
      '- add_credential: Inject a pre-made credential (requires: authenticatorId, credentialId[b64], privateKey[b64 PKCS#8], rpId; optional: userHandle[b64], isResidentCredential, signCount, largeBlob[b64], backupEligibility, backupState, userName, userDisplayName)',
      '- list_credentials: List credentials stored on an authenticator (requires: authenticatorId; optional: fullIds — print untruncated credential IDs, needed for remove_credential / set_credential_properties)',
      '- remove_credential: Remove one credential (requires: authenticatorId, credentialId)',
      '- clear_credentials: Remove all credentials (requires: authenticatorId)',
      '- set_user_verified: Make user verification succeed/fail (requires: authenticatorId; optional: isUserVerified, default true)',
      '- set_presence_simulation: Auto-approve or hang user-presence tests (requires: authenticatorId; optional: enabled, default true)',
      '- set_override_bits: Negative testing — sabotage the next authenticator response (requires: authenticatorId; optional: isBogusSignature, isBadUV, isBadUP — zeros the signature / UV flag / UP flag)',
      '- set_credential_properties: Mutate a stored credential — backup flags and/or the signature counter (requires: authenticatorId, credentialId; optional: backupEligibility, backupState, signCount — signCount -1 REMOVES the counter, useful for testing signCount-monotonicity handling in relying parties). Credential lifecycle events (added/updated/asserted/deleted) surface in list_credentials as "last:" lines',
      '- reset: Remove ALL authenticators on a tab + disable the environment (requires: tabId)',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...actions], description: 'WebAuthn action.' },
        tabId: { type: 'string', description: 'Tab ID (required for add_authenticator / reset).' },
        authenticatorId: { type: 'string', description: 'Authenticator ID from add_authenticator.' },
        protocol: { type: 'string', enum: ['ctap2', 'u2f'], description: 'Authenticator protocol (default ctap2).' },
        transport: { type: 'string', enum: [...TRANSPORTS], description: 'Authenticator transport (default internal). Only one internal authenticator may exist per environment.' },
        ctap2Version: { type: 'string', enum: [...CTAP2_VERSIONS], description: 'CTAP2 version (default ctap2_0; ignored for u2f).' },
        hasResidentKey: { type: 'boolean', description: 'Supports discoverable credentials (default true).' },
        hasUserVerification: { type: 'boolean', description: 'Supports user verification (default true).' },
        isUserVerified: { type: 'boolean', description: 'User verification succeeds (default true).' },
        automaticPresenceSimulation: { type: 'boolean', description: 'Presence tests succeed immediately (default true).' },
        extensions: {
          type: 'object',
          properties: {
            prf: { type: 'boolean', description: 'PRF extension.' },
            largeBlob: { type: 'boolean', description: 'largeBlob extension (needs resident key).' },
            credBlob: { type: 'boolean', description: 'credBlob extension (CTAP2.1).' },
            minPinLength: { type: 'boolean', description: 'minPinLength extension (CTAP2.1).' },
            hmacSecret: { type: 'boolean', description: 'hmac-secret extension.' },
            cmtgKey: { type: 'boolean', description: 'cmtgKey extension (needs resident key).' },
          },
          description: 'Authenticator extension support flags.',
        },
        credentialId: { type: 'string', description: 'Credential ID (base64 bytes).' },
        privateKey: { type: 'string', description: 'ECDSA P-256 private key, PKCS#8 DER, base64-encoded.' },
        rpId: { type: 'string', description: 'Relying Party ID the credential is scoped to.' },
        userHandle: { type: 'string', description: 'User handle mapping credential→user (base64, ≤64 bytes).' },
        isResidentCredential: { type: 'boolean', description: 'Credential is discoverable/resident (default true).' },
        signCount: { type: 'number', description: 'Signature counter (≥ -1; default 0).' },
        largeBlob: { type: 'string', description: 'Credential large blob (base64).' },
        userName: { type: 'string', description: 'user.name for the credential.' },
        userDisplayName: { type: 'string', description: 'user.displayName for the credential.' },
        backupEligibility: { type: 'boolean', description: 'Backup eligibility (BE) flag.' },
        backupState: { type: 'boolean', description: 'Backup state (BS) flag.' },
        enabled: { type: 'boolean', description: 'Toggle for set_user_verified / set_presence_simulation (default true).' },
        isBogusSignature: { type: 'boolean', description: 'set_override_bits: zero the response signature.' },
        isBadUV: { type: 'boolean', description: 'set_override_bits: zero the UV flag.' },
        isBadUP: { type: 'boolean', description: 'set_override_bits: zero the UP flag.' },
        fullIds: { type: 'boolean', description: 'list_credentials: print full untruncated credential IDs.' },
      },
      required: ['action'],
    },
    handler: async (ctx: ServerContext, params: Record<string, unknown>): Promise<ToolResult> => {
      const action = params.action as string;
      switch (action) {
        case 'add_authenticator':      return handleAddAuthenticator(ctx, params);
        case 'remove_authenticator':   return handleRemoveAuthenticator(ctx, params);
        case 'list_authenticators':    return handleListAuthenticators(ctx);
        case 'add_credential':         return handleAddCredential(ctx, params);
        case 'list_credentials':       return handleListCredentials(ctx, params);
        case 'remove_credential':      return handleRemoveCredential(ctx, params);
        case 'clear_credentials':      return handleClearCredentials(ctx, params);
        case 'set_user_verified':      return handleSetUserVerified(ctx, params);
        case 'set_presence_simulation': return handleSetPresenceSimulation(ctx, params);
        case 'set_override_bits':      return handleSetOverrideBits(ctx, params);
        case 'set_credential_properties': return handleSetCredentialProperties(ctx, params);
        case 'reset':                  return handleReset(ctx, params);
        default:
          return fail(`Unknown webauthn action: "${action}". Use: ${actions.join(', ')}`);
      }
    },
  });
}

export type { WebAuthnStateManager };
