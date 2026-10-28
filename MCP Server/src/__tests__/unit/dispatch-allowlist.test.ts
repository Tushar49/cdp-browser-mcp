/**
 * 5.3 WS1 O3 — opt-in origin allow-list (CDP_ALLOWED_ORIGINS).
 * Enforcement lives in preprocessToolCall (tab-bound pairs only) via
 * checkAllowedOrigin; fail-closed when the origin cannot be determined.
 */
import { describe, it, expect } from 'vitest';
import { preprocessToolCall, checkAllowedOrigin } from '../../tools/dispatch.js';
import { ActionableError } from '../../utils/error-handler.js';
import type { ServerContext } from '../../types.js';

type TargetInfo = { targetId: string; url?: string; type?: string };

function makeCtx(
  targetInfos: TargetInfo[],
  allowedOrigins: string[],
): ServerContext {
  const sessions = {
    getOrCreate: () => ({ id: 's1', tabIds: new Set<string>() }),
    touch: () => {},
    sweepStale: () => Promise.resolve(),
  };
  const tabOwnership = {
    claimIfUnowned: () => true,
    canAccess: () => true,
    getLock: () => undefined,
    releaseSession: () => [],
  };
  return {
    config: { allowedOrigins, defaultCleanupStrategy: 'detach' },
    processSessionId: 'proc-1',
    sendCommand: async () => ({ targetInfos }),
    sessions,
    tabOwnership,
  } as unknown as ServerContext;
}

const TABS = [
  { targetId: 'tab-ok', url: 'https://allowed.example.com/page', type: 'page' },
  { targetId: 'tab-bad', url: 'https://evil.example.net/page', type: 'page' },
];

describe('checkAllowedOrigin', () => {
  it('no-op when the allow-list is empty (default)', async () => {
    const ctx = makeCtx(TABS, []);
    await expect(checkAllowedOrigin(ctx, 'tab-bad', 'page')).resolves.toBeUndefined();
  });

  it('allows on-list origins', async () => {
    const ctx = makeCtx(TABS, ['https://allowed.example.com']);
    await expect(checkAllowedOrigin(ctx, 'tab-ok', 'page')).resolves.toBeUndefined();
  });

  it('blocks off-list origins with an actionable error naming the origin', async () => {
    const ctx = makeCtx(TABS, ['https://allowed.example.com']);
    await expect(checkAllowedOrigin(ctx, 'tab-bad', 'page')).rejects.toThrow(ActionableError);
    await expect(checkAllowedOrigin(ctx, 'tab-bad', 'page')).rejects.toThrow(/evil\.example\.net/);
    await expect(checkAllowedOrigin(ctx, 'tab-bad', 'page')).rejects.toThrow(/CDP_ALLOWED_ORIGINS/);
  });

  it('blocks chrome:// and unparseable targets (fail-closed)', async () => {
    const ctx = makeCtx(
      [{ targetId: 'tab-flags', url: 'chrome://flags/?search=webmcp', type: 'page' }],
      ['https://allowed.example.com'],
    );
    await expect(checkAllowedOrigin(ctx, 'tab-flags', 'page')).rejects.toThrow(ActionableError);
  });

  it('fail-closed when the target lookup throws', async () => {
    const ctx = makeCtx([], ['https://allowed.example.com']);
    await expect(checkAllowedOrigin(ctx, 'tab-gone', 'page')).rejects.toThrow(ActionableError);
  });
});

describe('preprocessToolCall allow-list integration', () => {
  it('blocks tab-bound calls against off-list tabs', async () => {
    const ctx = makeCtx(TABS, ['https://allowed.example.com']);
    await expect(
      preprocessToolCall(ctx, 'page', { action: 'snapshot', tabId: 'tab-bad' }),
    ).rejects.toThrow(/not on the allowed-origins list/);
  });

  it('does not block non-tab-bound tools (tabs.list, ping) even with the list set', async () => {
    const ctx = makeCtx(TABS, ['https://allowed.example.com']);
    await expect(preprocessToolCall(ctx, 'tabs', { action: 'list' })).resolves.toBeTruthy();
    await expect(preprocessToolCall(ctx, 'ping', {})).resolves.toBeTruthy();
  });

  it('does not block tab-bound calls when no list is configured', async () => {
    const ctx = makeCtx(TABS, []);
    await expect(
      preprocessToolCall(ctx, 'page', { action: 'snapshot', tabId: 'tab-bad' }),
    ).resolves.toBeTruthy();
  });

  it('applies to auto-resolved tabIds too (single tab + list set)', async () => {
    const ctx = makeCtx([TABS[1]], ['https://allowed.example.com']);
    await expect(
      preprocessToolCall(ctx, 'page', { action: 'snapshot' }),
    ).rejects.toThrow(/not on the allowed-origins list/);
  });
});
