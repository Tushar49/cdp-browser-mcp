/**
 * Agent-DX E5 (v5.2): tabId auto-resolution. tabId is optional at the
 * schema layer now — dispatch auto-resolves it for tab-bound tools
 * (single tab → inject; zero/multiple → actionable error), and NEVER
 * fires for tab-less actions (tabs list/find/new, webauthn
 * authenticatorId-only actions, cleanup).
 */
import { describe, it, expect } from 'vitest';
import { autoResolveTabId, needsTabId } from '../../tools/dispatch.js';
import type { ServerContext } from '../../types.js';

function makeCtx(targetInfos: Array<{ targetId: string; url?: string; type?: string }>) {
  return {
    sendCommand: async () => ({ targetInfos }),
  } as unknown as ServerContext;
}

describe('needsTabId (E5 action-awareness)', () => {
  it('tab-bound tools always true', () => {
    expect(needsTabId('page', 'goto')).toBe(true);
    expect(needsTabId('interact', 'click')).toBe(true);
    expect(needsTabId('observe', 'memory')).toBe(true);
    expect(needsTabId('storage', 'get_cookies')).toBe(true);
    expect(needsTabId('emulate')).toBe(true);
  });

  it('tabs: only info/close/activate', () => {
    expect(needsTabId('tabs', 'list')).toBe(false);
    expect(needsTabId('tabs', 'find')).toBe(false);
    expect(needsTabId('tabs', 'new')).toBe(false);
    expect(needsTabId('tabs', 'close')).toBe(true);
    expect(needsTabId('tabs', 'info')).toBe(true);
    expect(needsTabId('tabs', 'activate')).toBe(true);
  });

  it('webauthn: only add_authenticator/reset', () => {
    expect(needsTabId('webauthn', 'add_authenticator')).toBe(true);
    expect(needsTabId('webauthn', 'reset')).toBe(true);
    expect(needsTabId('webauthn', 'list_credentials')).toBe(false);
    expect(needsTabId('webauthn', 'list_authenticators')).toBe(false);
  });

  it('tab-less tools never true', () => {
    expect(needsTabId('cleanup', 'session')).toBe(false);
    expect(needsTabId('browser', 'list')).toBe(false);
    expect(needsTabId('ping')).toBe(false);
    expect(needsTabId('status')).toBe(false);
  });
});

describe('autoResolveTabId (E5)', () => {
  it('single open page tab → returns its id', async () => {
    const r = await autoResolveTabId(makeCtx([{ targetId: 'tab-1', url: 'https://x', type: 'page' }]));
    expect(r).toBe('tab-1');
  });

  it('ignores non-page targets', async () => {
    const r = await autoResolveTabId(makeCtx([
      { targetId: 'svc', type: 'service_worker' },
      { targetId: 'tab-1', url: 'https://x', type: 'page' },
    ]));
    expect(r).toBe('tab-1');
  });

  it('zero page tabs → actionable noOpenTabs error', async () => {
    await expect(autoResolveTabId(makeCtx([{ targetId: 'svc', type: 'service_worker' }])))
      .rejects.toThrow(/No browser tabs are open/);
  });

  it('multiple page tabs → actionable error listing them with ids and URLs', async () => {
    const err = await autoResolveTabId(makeCtx([
      { targetId: 'aaa', url: 'https://first.example', type: 'page' },
      { targetId: 'bbb', url: 'https://second.example', type: 'page' },
    ])).catch((e) => e);
    expect(err.message).toContain('Multiple tabs are open (2)');
    expect(err.fix).toContain('tabId: "aaa"');
    expect(err.fix).toContain('https://first.example');
    expect(err.fix).toContain('https://second.example');
  });
});
