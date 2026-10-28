/**
 * 5.3 WS4 — riders: inputVisualization (emulate + record auto-enable),
 * WebAuthn set_credential_properties, credential-event surfacing into
 * list_credentials, WebAuthnStateManager activity registry.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../tools/registry.js';
import { registerEmulateTools } from '../../tools/emulate.js';
import { registerPageTools } from '../../tools/page.js';
import {
  handleSetCredentialProperties,
  handleListCredentials,
} from '../../tools/webauthn.js';
import { handleRecordStart, handleRecordStop } from '../../tools/page.js';
import { WebAuthnStateManager } from '../../session/webauthn-state.js';
import type { ServerContext, ToolResult } from '../../types.js';

interface Call { method: string; params?: Record<string, unknown> }

function textOf(r: ToolResult): string {
  return ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('\n');
}

function baseCtx(calls: Call[], extra: Record<string, unknown> = {}): ServerContext {
  const ctx = {
    tabSessions: { getSession: async () => 'sess-1', getRefSession: () => undefined },
    sendCommand: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      return {};
    },
    capabilities: { require: async () => {}, has: async () => true },
    webauthnState: new WebAuthnStateManager(),
    ...extra,
  } as unknown as ServerContext;
  return ctx;
}

describe('emulate inputVisualization (Page.setInputVisualization)', () => {
  it('sends clicks:true/false and reports', async () => {
    const calls: Call[] = [];
    const ctx = baseCtx(calls);
    const registry = new ToolRegistry();
    registerEmulateTools(registry, ctx);
    const r = await registry.dispatch('emulate', { _sessionId: 'sess-1', inputVisualization: true }, ctx);
    expect(textOf(r)).toContain('Input visualization: on');
    expect(calls.find((c) => c.method === 'Page.setInputVisualization')?.params).toEqual({ clicks: true });

    const calls2: Call[] = [];
    const ctx2 = baseCtx(calls2);
    const registry2 = new ToolRegistry();
    registerEmulateTools(registry2, ctx2);
    await registry2.dispatch('emulate', { _sessionId: 'sess-1', inputVisualization: false }, ctx2);
    expect(calls2.find((c) => c.method === 'Page.setInputVisualization')?.params).toEqual({ clicks: false });
  });

  it('reset clears the visualization', async () => {
    const calls: Call[] = [];
    const ctx = baseCtx(calls);
    const registry = new ToolRegistry();
    registerEmulateTools(registry, ctx);
    await registry.dispatch('emulate', { _sessionId: 'sess-1', reset: true }, ctx);
    const viz = calls.find((c) => c.method === 'Page.setInputVisualization');
    expect(viz?.params).toEqual({ clicks: false });
  });

  it('unsupported browser → actionable fail naming the flag', async () => {
    const calls: Call[] = [];
    const ctx = baseCtx(calls);
    (ctx as { sendCommand: (m: string) => Promise<unknown> }).sendCommand = async (method: string) => {
      calls.push({ method });
      if (method === 'Page.setInputVisualization') throw new Error("'Page.setInputVisualization' wasn't found");
      return {};
    };
    const registry = new ToolRegistry();
    registerEmulateTools(registry, ctx);
    const r = await registry.dispatch('emulate', { _sessionId: 'sess-1', inputVisualization: true }, ctx);
    expect(textOf(r)).toContain('#devtools-webmcp-support');
  });
});

describe('record_start/stop click markers (auto-enable, opt-out)', () => {
  it('record_start enables clicks by default, opt-out skips', async () => {
    const calls: Call[] = [];
    const ctx = baseCtx(calls, { config: { tempDir: '.', maxTempFiles: 5, maxTempAgeMs: 1000 } });
    await handleRecordStart(ctx, { tabId: 't1' });
    expect(calls.find((c) => c.method === 'Page.setInputVisualization')?.params).toEqual({ clicks: true });

    const calls2: Call[] = [];
    const ctx2 = baseCtx(calls2, { config: { tempDir: '.', maxTempFiles: 5, maxTempAgeMs: 1000 } });
    await handleRecordStart(ctx2, { tabId: 't1', clickMarkers: false });
    expect(calls2.find((c) => c.method === 'Page.setInputVisualization')).toBeUndefined();
  });

  it('record_stop disables the markers', async () => {
    const calls: Call[] = [];
    const ctx = baseCtx(calls, { config: { tempDir: '.', maxTempFiles: 5, maxTempAgeMs: 1000 } });
    await handleRecordStop(ctx, { tabId: 't1' });
    const viz = calls.find((c) => c.method === 'Page.setInputVisualization');
    expect(viz?.params).toEqual({ clicks: false });
  });
});

describe('WebAuthnStateManager credential activity (5.3 WS4)', () => {
  it('records events per credential and clears with the authenticator', () => {
    const m = new WebAuthnStateManager();
    m.register('auth-1', { ownerTabId: 't1', options: {}, createdAt: 1 });
    m.noteCredentialEvent('auth-1', 'added', 'cred-A', 0);
    m.noteCredentialEvent('auth-1', 'asserted', 'cred-A', 3);
    const activity = m.credentialActivity('auth-1');
    expect(activity?.get('cred-A')).toMatchObject({ lastEvent: 'asserted', signCount: 3 });

    m.clearForTab('t1');
    expect(m.credentialActivity('auth-1')).toBeUndefined();
  });

  it('clearAll drops everything', () => {
    const m = new WebAuthnStateManager();
    m.noteCredentialEvent('auth-x', 'updated', 'cred-B');
    m.clearAll();
    expect(m.credentialActivity('auth-x')).toBeUndefined();
  });
});

describe('webauthn set_credential_properties', () => {
  it('requires credentialId', async () => {
    const calls: Call[] = [];
    const ctx = baseCtx(calls, {
      webauthnState: (() => {
        const m = new WebAuthnStateManager();
        m.register('auth-1', { ownerTabId: 't1', options: {}, createdAt: 1 });
        return m;
      })(),
    });
    const r = await handleSetCredentialProperties(ctx, { authenticatorId: 'auth-1' });
    expect(textOf(r)).toContain('requires credentialId');
  });

  it('requires at least one property', async () => {
    const calls: Call[] = [];
    const state = new WebAuthnStateManager();
    state.register('auth-1', { ownerTabId: 't1', options: {}, createdAt: 1 });
    const ctx = baseCtx(calls, { webauthnState: state });
    const r = await handleSetCredentialProperties(ctx, { authenticatorId: 'auth-1', credentialId: 'cred-A' });
    expect(textOf(r)).toContain('at least one of');
  });

  it('sends the exact CDP params (signCount -1 removes the counter)', async () => {
    const calls: Call[] = [];
    const state = new WebAuthnStateManager();
    state.register('auth-1', { ownerTabId: 't1', options: {}, createdAt: 1 });
    const ctx = baseCtx(calls, { webauthnState: state });
    const r = await handleSetCredentialProperties(ctx, {
      authenticatorId: 'auth-1', credentialId: 'cred-A', backupEligibility: true, backupState: true, signCount: -1,
    });
    expect(textOf(r)).toContain('counter REMOVED');
    expect(calls.find((c) => c.method === 'WebAuthn.setCredentialProperties')?.params).toEqual({
      authenticatorId: 'auth-1', credentialId: 'cred+A==', backupEligibility: true, backupState: true, signCount: -1,
    });
  });
});

describe('list_credentials activity annotation', () => {
  it('appends last-event lines from the registry', async () => {
    const calls: Call[] = [];
    const state = new WebAuthnStateManager();
    state.register('auth-1', { ownerTabId: 't1', options: {}, createdAt: 1 });
    state.noteCredentialEvent('auth-1', 'asserted', 'cred-A', 7);
    const ctx = baseCtx(calls, { webauthnState: state });
    (ctx as { sendCommand: (m: string, p?: Record<string, unknown>) => Promise<unknown> }).sendCommand =
      async (method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === 'WebAuthn.getCredentials') {
          return { credentials: [{ credentialId: 'cred-A', rpId: 'example.com', signCount: 7 }] };
        }
        return {};
      };
    const r = await handleListCredentials(ctx, { authenticatorId: 'auth-1' });
    const text = textOf(r);
    expect(text).toContain('last: asserted');
    expect(text).toContain('signCount 7');
  });

  it('fullIds prints untruncated ids; default truncates', async () => {
    const calls: Call[] = [];
    const state = new WebAuthnStateManager();
    state.register('auth-1', { ownerTabId: 't1', options: {}, createdAt: 1 });
    const ctx = baseCtx(calls, { webauthnState: state });
    const longId = 'a'.repeat(43) + '=';
    (ctx as { sendCommand: (m: string, p?: Record<string, unknown>) => Promise<unknown> }).sendCommand =
      async (method: string) => {
        calls.push({ method });
        if (method === 'WebAuthn.getCredentials') {
          return { credentials: [{ credentialId: longId, rpId: 'example.com', signCount: 1 }] };
        }
        return {};
      };
    const truncated = textOf(await handleListCredentials(ctx, { authenticatorId: 'auth-1' }));
    expect(truncated).not.toContain(longId);
    expect(truncated).toContain('…');
    const full = textOf(await handleListCredentials(ctx, { authenticatorId: 'auth-1', fullIds: true }));
    expect(full).toContain(longId);
  });

  it('renders signCount -1 (counter removed) as none', async () => {
    const calls: Call[] = [];
    const state = new WebAuthnStateManager();
    state.register('auth-1', { ownerTabId: 't1', options: {}, createdAt: 1 });
    const ctx = baseCtx(calls, { webauthnState: state });
    (ctx as { sendCommand: (m: string, p?: Record<string, unknown>) => Promise<unknown> }).sendCommand =
      async (method: string) => {
        calls.push({ method });
        if (method === 'WebAuthn.getCredentials') {
          return { credentials: [{ credentialId: 'cred-A', rpId: 'example.com', signCount: -1 }] };
        }
        return {};
      };
    const r = await handleListCredentials(ctx, { authenticatorId: 'auth-1' });
    expect(textOf(r)).toContain('signCount: none');
  });
});
