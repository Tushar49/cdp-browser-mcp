/**
 * WS1: webauthn tool handler flow — mocked CDP send (page-find.test.ts
 * pattern). Covers the option-combination validator, internal-uniqueness
 * mapping, unknown-authenticator errors, lazy enable ordering, credential
 * add/list formatting, override bits, and reset.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  handleAddAuthenticator,
  handleRemoveAuthenticator,
  handleListAuthenticators,
  handleAddCredential,
  handleListCredentials,
  handleSetUserVerified,
  handleSetOverrideBits,
  handleReset,
} from '../../tools/webauthn.js';
import { WebAuthnStateManager } from '../../session/webauthn-state.js';
import type { ServerContext, ToolResult } from '../../types.js';

function textOf(r: ToolResult): string {
  const content = (r as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

type SendLog = Array<{ method: string; params: Record<string, unknown>; sessionId?: string }>;

function makeCtx(sendImpl?: (method: string, params: Record<string, unknown>, sessionId?: string) => unknown) {
  const calls: SendLog = [];
  const webauthnState = new WebAuthnStateManager();
  const ctx = {
    capabilities: { require: async () => {} },
    tabSessions: {
      getSession: async (_c: unknown, tabId: string) => `sess-${tabId}`,
    },
    sendCommand: async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      calls.push({ method, params, sessionId });
      if (sendImpl) return sendImpl(method, params, sessionId);
      if (method === 'WebAuthn.addVirtualAuthenticator') return { authenticatorId: 'auth-new' };
      if (method === 'WebAuthn.getCredentials') return { credentials: [] };
      return {};
    },
    webauthnState,
  } as unknown as ServerContext;
  return { ctx, calls, webauthnState };
}

describe('webauthn tool (WS1)', () => {
  describe('add_authenticator', () => {
    it('enables the virtual environment BEFORE creating, with zero-config defaults', async () => {
      const { ctx, calls } = makeCtx();
      const r = await handleAddAuthenticator(ctx, { tabId: 't1' });
      expect(textOf(r)).toContain('Virtual authenticator created');
      const enableIdx = calls.findIndex((c) => c.method === 'WebAuthn.enable');
      const addIdx = calls.findIndex((c) => c.method === 'WebAuthn.addVirtualAuthenticator');
      expect(enableIdx).toBeGreaterThanOrEqual(0);
      expect(enableIdx).toBeLessThan(addIdx);
      const opts = calls[addIdx].params.options as Record<string, unknown>;
      expect(opts.protocol).toBe('ctap2');
      expect(opts.transport).toBe('internal');
      expect(opts.hasResidentKey).toBe(true);
      expect(opts.isUserVerified).toBe(true);
      expect(opts.automaticPresenceSimulation).toBe(true);
      expect(calls[enableIdx].sessionId).toBe('sess-t1');
      expect(calls[addIdx].sessionId).toBe('sess-t1');
    });

    it('registers the created authenticator owned by the tab', async () => {
      const { ctx, webauthnState } = makeCtx();
      await handleAddAuthenticator(ctx, { tabId: 't1' });
      expect(webauthnState.get('auth-new')?.ownerTabId).toBe('t1');
    });

    it('rejects invalid option combinations before any CDP call', async () => {
      const { ctx, calls } = makeCtx();
      const r1 = await handleAddAuthenticator(ctx, { tabId: 't1', hasResidentKey: false, extensions: { largeBlob: true } });
      expect(textOf(r1)).toContain('largeBlob and cmtgKey extensions require hasResidentKey');
      const r2 = await handleAddAuthenticator(ctx, { tabId: 't1', protocol: 'u2f', transport: 'cable' });
      expect(textOf(r2)).toContain('transport "cable" is invalid');
      const r3 = await handleAddAuthenticator(ctx, { tabId: 't1', protocol: 'u2f', ctap2Version: 'ctap2_1' });
      expect(textOf(r3)).toContain('ctap2Version only applies');
      expect(calls).toHaveLength(0);
    });

    it('maps the one-internal-authenticator CDP error to an actionable failure', async () => {
      const { ctx, webauthnState } = makeCtx((method) => {
        if (method === 'WebAuthn.addVirtualAuthenticator') {
          throw new Error('-32602 Chrome only supports one internal authenticator per environment');
        }
        return {};
      });
      webauthnState.register('auth-existing', {
        ownerTabId: 't1',
        options: { transport: 'internal' },
        createdAt: 0,
      });
      const r = await handleAddAuthenticator(ctx, { tabId: 't1' });
      expect(textOf(r)).toContain('one internal authenticator');
      expect(textOf(r)).toContain('auth-existin');
    });

    it('extension flags map to the has* option names', async () => {
      const { ctx, calls } = makeCtx();
      await handleAddAuthenticator(ctx, { tabId: 't1', extensions: { prf: true, largeBlob: true } });
      const opts = calls.find((c) => c.method === 'WebAuthn.addVirtualAuthenticator')!.params.options as Record<string, unknown>;
      expect(opts.hasPrf).toBe(true);
      expect(opts.hasLargeBlob).toBe(true);
      expect(opts.hasCredBlob).toBeUndefined();
    });
  });

  describe('unknown authenticator', () => {
    it('every authenticatorId action throws an actionable error when unregistered (dispatch renders it)', async () => {
      const { ctx } = makeCtx();
      await expect(handleRemoveAuthenticator(ctx, { authenticatorId: 'ghost' }))
        .rejects.toThrow(/Unknown authenticator/);
      await expect(handleListCredentials(ctx, { authenticatorId: 'ghost' }))
        .rejects.toThrow(/Unknown authenticator/);
    });
  });

  describe('list_authenticators', () => {
    it('shows owner tabs and empty-state guidance', async () => {
      const { ctx, webauthnState } = makeCtx();
      const empty = handleListAuthenticators(ctx);
      expect(textOf(empty)).toContain('No virtual authenticators');
      webauthnState.register('auth-1', { ownerTabId: 't9', options: { transport: 'usb' }, createdAt: 0 });
      const r = handleListAuthenticators(ctx);
      expect(textOf(r)).toContain('1 virtual authenticator');
      expect(textOf(r)).toContain('t9');
    });
  });

  describe('add_credential', () => {
    it('requires privateKey, credentialId and rpId', async () => {
      const { ctx, webauthnState } = makeCtx();
      webauthnState.register('auth-1', { ownerTabId: 't1', options: {}, createdAt: 0 });
      const r1 = await handleAddCredential(ctx, { authenticatorId: 'auth-1' });
      expect(textOf(r1)).toContain('privateKey');
      const r2 = await handleAddCredential(ctx, { authenticatorId: 'auth-1', privateKey: 'abc' });
      expect(textOf(r2)).toContain('credentialId');
      const r3 = await handleAddCredential(ctx, { authenticatorId: 'auth-1', privateKey: 'abc', credentialId: 'def' });
      expect(textOf(r3)).toContain('rpId');
    });

    it('rejects malformed base64 before any CDP call', async () => {
      const { ctx, webauthnState, calls } = makeCtx();
      webauthnState.register('auth-1', { ownerTabId: 't1', options: {}, createdAt: 0 });
      const r = await handleAddCredential(ctx, {
        authenticatorId: 'auth-1',
        privateKey: 'not base64!!',
        credentialId: 'abc',
        rpId: 'example.com',
      });
      expect(textOf(r)).toContain('not valid base64');
      expect(textOf(r)).toContain('privateKey');
      expect(calls.filter((c) => c.method === 'WebAuthn.addCredential')).toHaveLength(0);
    });

    it('sends the credential with defaults filled', async () => {
      const { ctx, calls, webauthnState } = makeCtx();
      webauthnState.register('auth-1', { ownerTabId: 't1', options: {}, createdAt: 0 });
      await handleAddCredential(ctx, {
        authenticatorId: 'auth-1',
        credentialId: 'cred-id',
        privateKey: 'priv-key',
        rpId: 'webauthn.io',
      });
      const call = calls.find((c) => c.method === 'WebAuthn.addCredential')!;
      const cred = call.params.credential as Record<string, unknown>;
      expect(cred.isResidentCredential).toBe(true);
      expect(cred.signCount).toBe(0);
      expect(cred.rpId).toBe('webauthn.io');
      expect(call.sessionId).toBe('sess-t1');
    });
  });

  describe('list_credentials', () => {
    it('formats credentials with rpId, resident flag and signCount', async () => {
      const { ctx, webauthnState } = makeCtx();
      webauthnState.register('auth-1', { ownerTabId: 't1', options: {}, createdAt: 0 });
      const { handleListCredentials: list } = await import('../../tools/webauthn.js');
      const r = await list(ctx, { authenticatorId: 'auth-1' });
      expect(textOf(r)).toContain('holds 0 credential');
    });

    it('fullIds result opts out of the scrubber (5.3.5 fix — credentialId is an identifier, not a secret; 5.4 canary-caught at the battery rerun)', async () => {
      const { ctx, webauthnState } = makeCtx((_method, params) => {
        if (_method === 'WebAuthn.enable') return {};
        if (_method === 'WebAuthn.getCredentials')
          return { credentials: [{ credentialId: 'c' + '9'.repeat(60), rpId: 'example.com', isResidentCredential: true, signCount: 4 }] };
        return {};
      });
      webauthnState.register('auth-1', { ownerTabId: 't1', options: {}, createdAt: 0 });
      const r = await handleListCredentials(ctx, { authenticatorId: 'auth-1', fullIds: true });
      expect(textOf(r)).toContain('c' + '9'.repeat(60)); // UNMASKED — full id printed
      expect((r as Record<string, unknown>)._noScrub).toBe(true);
    });
  });

  describe('set_user_verified / set_override_bits', () => {
    it('set_user_verified defaults to true and reports the direction', async () => {
      const { ctx, calls, webauthnState } = makeCtx();
      webauthnState.register('auth-1', { ownerTabId: 't1', options: {}, createdAt: 0 });
      const r = await handleSetUserVerified(ctx, { authenticatorId: 'auth-1' });
      expect(textOf(r)).toContain('succeeds');
      const call = calls.find((c) => c.method === 'WebAuthn.setUserVerified')!;
      expect(call.params.isUserVerified).toBe(true);
    });

    it('set_override_bits forwards all three bits and reports sabotage', async () => {
      const { ctx, calls, webauthnState } = makeCtx();
      webauthnState.register('auth-1', { ownerTabId: 't1', options: {}, createdAt: 0 });
      const r = await handleSetOverrideBits(ctx, { authenticatorId: 'auth-1', isBogusSignature: true });
      expect(textOf(r)).toContain('sabotaged');
      const call = calls.find((c) => c.method === 'WebAuthn.setResponseOverrideBits')!;
      expect(call.params.isBogusSignature).toBe(true);
      expect(call.params.isBadUV).toBeUndefined();
    });
  });

  describe('reset', () => {
    it('removes only the tab\'s authenticators and disables the environment', async () => {
      const { ctx, calls, webauthnState } = makeCtx();
      webauthnState.register('auth-a', { ownerTabId: 't1', options: {}, createdAt: 0 });
      webauthnState.register('auth-b', { ownerTabId: 't2', options: {}, createdAt: 0 });
      const r = await handleReset(ctx, { tabId: 't1' });
      expect(textOf(r)).toContain('removed 1 authenticator');
      expect(webauthnState.get('auth-a')).toBeUndefined();
      expect(webauthnState.get('auth-b')).toBeDefined();
      const removedIds = calls.filter((c) => c.method === 'WebAuthn.removeVirtualAuthenticator')
        .map((c) => (c.params as { authenticatorId: string }).authenticatorId);
      expect(removedIds).toEqual(['auth-a']);
      expect(calls.some((c) => c.method === 'WebAuthn.disable')).toBe(true);
    });

    it('continues past a failing removal and reports it', async () => {
      const { ctx, webauthnState } = makeCtx((method) => {
        if (method === 'WebAuthn.removeVirtualAuthenticator') throw new Error('boom');
        return {};
      });
      webauthnState.register('auth-a', { ownerTabId: 't1', options: {}, createdAt: 0 });
      const r = await handleReset(ctx, { tabId: 't1' });
      expect(textOf(r)).toContain('removed 0 authenticator');
      expect(textOf(r)).toContain('boom');
    });
  });
});
