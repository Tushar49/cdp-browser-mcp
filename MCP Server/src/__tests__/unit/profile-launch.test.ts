/**
 * Profile launch regression tests (Issue B, alpha.4).
 *
 * Reproduces the scenario from .temp/chat2.md item 31:
 *   - The session is pinned to a specific Chrome profile (e.g. the
 *     job-search Gmail profile).
 *   - The human user has a *different* Chrome profile window in the
 *     foreground (e.g. their personal Gmail).
 *   - Agent calls `tabs.new({ url: '...' })` with no explicit profile.
 *
 * The new tab MUST land in the session's pinned profile, not in the
 * user's foreground profile.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  resolvePinnedContextId,
  collectKnownContextIds,
  type ProfileResolverSend,
} from '../../session/profile-resolver.js';
import { handleNew } from '../../tools/tabs.js';
import type { AgentSession } from '../../session/session-manager.js';
import type { ServerContext } from '../../types.js';

// ─── Helpers ────────────────────────────────────────────────────────

interface FakeBrowserState {
  /** Contexts returned by Target.getBrowserContexts (createBrowserContext-created). */
  isolatedContexts?: string[];
  /** Tabs Chrome currently has open (their browserContextId surfaces user-data-dir profile contexts). */
  targets: Array<{ targetId: string; browserContextId?: string; type?: string; url?: string; title?: string }>;
  /** Synthetic targetId returned by Target.createTarget. */
  newTargetId?: string;
  /**
   * What the new tab's browserContextId should look like in
   * subsequent Target.getTargets responses. If not set, it defaults
   * to whatever createTarget was called with — or, if no
   * browserContextId was passed, the "active focused" context.
   */
  activeContextId?: string;
}

interface MockResult {
  send: ReturnType<typeof vi.fn>;
  /** Capture of params passed to Target.createTarget. */
  createTargetCalls: Array<Record<string, unknown>>;
}

function buildMockSend(state: FakeBrowserState): MockResult {
  const createTargetCalls: Array<Record<string, unknown>> = [];
  const newTargetId = state.newTargetId ?? 'NEW-TARGET-1';

  const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method === 'Target.getBrowserContexts') {
      return { browserContextIds: state.isolatedContexts ?? [] };
    }
    if (method === 'Target.getTargets') {
      return { targetInfos: state.targets };
    }
    if (method === 'Target.createTarget') {
      createTargetCalls.push({ ...(params ?? {}) });
      // Determine where the tab actually landed. If the caller supplied
      // a valid browserContextId we honour it; otherwise the tab lands
      // in the "active focused" context (this is the buggy real-world
      // behaviour we're guarding against).
      const requested = params?.browserContextId as string | undefined;
      const known = new Set<string>([
        ...(state.isolatedContexts ?? []),
        ...state.targets.map((t) => t.browserContextId).filter(Boolean) as string[],
      ]);
      const landedIn = requested && known.has(requested)
        ? requested
        : state.activeContextId ?? 'CTX-DEFAULT';
      // Add the new tab so subsequent Target.getTargets sees it.
      state.targets.push({
        targetId: newTargetId,
        browserContextId: landedIn,
        type: 'page',
        url: 'about:blank',
        title: '',
      });
      return { targetId: newTargetId };
    }
    if (method === 'Target.attachToTarget') {
      return { sessionId: 'CDP-SESS-1' };
    }
    // Page.enable / Runtime.enable / Network.enable / DOM.enable / etc.
    return {};
  });

  return { send: send as unknown as MockResult['send'], createTargetCalls };
}

function buildMockCtx(send: MockResult['send']): ServerContext {
  // Only the bits handleNew actually touches; the rest can stay
  // minimal `as any` shims for test purposes.
  const ctx: Partial<ServerContext> = {
    sendCommand: send as unknown as ServerContext['sendCommand'],
    tabOwnership: {
      lock: vi.fn(),
      getLock: vi.fn(),
      release: vi.fn(),
    } as unknown as ServerContext['tabOwnership'],
    elementResolvers: new Map(),
    tabSessions: { detach: vi.fn() } as unknown as ServerContext['tabSessions'],
    snapshotCache: { invalidate: vi.fn() } as unknown as ServerContext['snapshotCache'],
  };
  return ctx as ServerContext;
}

function buildSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-test',
    createdAt: Date.now(),
    lastActivity: Date.now(),
    cleanupStrategy: 'detach',
    tabIds: new Set<string>(),
    ...overrides,
  };
}

// ─── resolvePinnedContextId / collectKnownContextIds ────────────────

describe('resolvePinnedContextId', () => {
  it('returns the pinned context when Chrome still knows about it', async () => {
    const { send } = buildMockSend({
      targets: [
        { targetId: 't1', browserContextId: 'CTX-DEFAULT' },
        { targetId: 't2', browserContextId: 'CTX-PROFILE-2' },
      ],
    });
    const session = buildSession({ browserContextId: 'CTX-PROFILE-2' });
    const result = await resolvePinnedContextId(send as unknown as ProfileResolverSend, session);
    expect(result).toBe('CTX-PROFILE-2');
  });

  it('returns undefined when the pinned context is stale', async () => {
    // Simulates the user closing every tab in Profile 2 — the
    // browserContextId no longer appears in Target.getTargets and
    // Target.getBrowserContexts returns an empty list.
    const { send } = buildMockSend({
      targets: [{ targetId: 't1', browserContextId: 'CTX-DEFAULT' }],
    });
    const session = buildSession({ browserContextId: 'CTX-PROFILE-2' });
    const result = await resolvePinnedContextId(send as unknown as ProfileResolverSend, session);
    expect(result).toBeUndefined();
  });

  it('returns undefined for an unpinned session', async () => {
    const { send } = buildMockSend({ targets: [] });
    const result = await resolvePinnedContextId(send as unknown as ProfileResolverSend, buildSession());
    expect(result).toBeUndefined();
  });

  it('returns undefined for an undefined session', async () => {
    const { send } = buildMockSend({ targets: [] });
    const result = await resolvePinnedContextId(send as unknown as ProfileResolverSend, undefined);
    expect(result).toBeUndefined();
  });
});

describe('collectKnownContextIds', () => {
  it('unions getBrowserContexts and getTargets browserContextIds', async () => {
    const { send } = buildMockSend({
      isolatedContexts: ['CTX-INCOGNITO'],
      targets: [
        { targetId: 't1', browserContextId: 'CTX-DEFAULT' },
        { targetId: 't2', browserContextId: 'CTX-PROFILE-2' },
        { targetId: 't3' }, // no browserContextId — must not crash
      ],
    });
    const ids = await collectKnownContextIds(send as unknown as ProfileResolverSend);
    expect(ids).toEqual(new Set(['CTX-INCOGNITO', 'CTX-DEFAULT', 'CTX-PROFILE-2']));
  });

  it('survives partial CDP failures', async () => {
    const send = vi.fn(async (method: string) => {
      if (method === 'Target.getBrowserContexts') throw new Error('CDP down');
      if (method === 'Target.getTargets') {
        return { targetInfos: [{ targetId: 't1', browserContextId: 'CTX-A' }] };
      }
      return {};
    });
    const ids = await collectKnownContextIds(send as unknown as ProfileResolverSend);
    expect(ids).toEqual(new Set(['CTX-A']));
  });
});

// ─── handleNew (end-to-end via mocked CDP) ──────────────────────────

describe('tabs.new — profile-sticky launch', () => {
  it('opens the new tab in the pinned profile, NOT the foreground profile', async () => {
    // Browser state: user is focused on CTX-DEFAULT (the personal
    // Gmail profile). The session, however, is pinned to CTX-PROFILE-2
    // (the job-search profile).
    const state: FakeBrowserState = {
      activeContextId: 'CTX-DEFAULT',
      targets: [
        { targetId: 'existing-personal-tab', browserContextId: 'CTX-DEFAULT', type: 'page', url: 'https://mail.google.com/mail/u/0/' },
        { targetId: 'existing-work-tab', browserContextId: 'CTX-PROFILE-2', type: 'page', url: 'https://mail.google.com/mail/u/0/' },
      ],
    };
    const { send, createTargetCalls } = buildMockSend(state);
    const ctx = buildMockCtx(send);
    const session = buildSession({ browserContextId: 'CTX-PROFILE-2' });

    await handleNew(ctx, {
      url: 'https://mail.google.com/',
      _agentSession: session,
      _agentSessionId: session.id,
    });

    // The crucial assertion: createTarget was invoked with the pinned
    // browserContextId — not omitted (which would land in the active
    // foreground profile).
    expect(createTargetCalls).toHaveLength(1);
    expect(createTargetCalls[0].browserContextId).toBe('CTX-PROFILE-2');

    // And the session's pin is unchanged.
    expect(session.browserContextId).toBe('CTX-PROFILE-2');
  });

  it('clears a stale pin and lets the post-create logic re-pin', async () => {
    // Pin points to a context that no longer exists in the browser
    // (every tab in that profile was closed, or Chrome rotated the
    // context id after a profile switch). Without the alpha.4 fix
    // we would pass the stale id to Target.createTarget and Chrome
    // would silently fall back to the active foreground profile.
    const state: FakeBrowserState = {
      activeContextId: 'CTX-DEFAULT',
      targets: [
        { targetId: 'only-personal-tab', browserContextId: 'CTX-DEFAULT', type: 'page', url: 'about:blank' },
      ],
    };
    const { send, createTargetCalls } = buildMockSend(state);
    const ctx = buildMockCtx(send);
    const session = buildSession({ browserContextId: 'CTX-DEAD-PROFILE' });

    await handleNew(ctx, {
      url: 'about:blank',
      _agentSession: session,
      _agentSessionId: session.id,
    });

    // Stale pin must NOT have been forwarded to Chrome.
    expect(createTargetCalls).toHaveLength(1);
    expect(createTargetCalls[0]).not.toHaveProperty('browserContextId');

    // Post-create logic re-pinned the session to the actual profile
    // the new tab landed in (CTX-DEFAULT here).
    expect(session.browserContextId).toBe('CTX-DEFAULT');
  });

  it('leaves browserContextId unset for a brand-new (unpinned) session', async () => {
    const state: FakeBrowserState = {
      activeContextId: 'CTX-DEFAULT',
      targets: [{ targetId: 'foo', browserContextId: 'CTX-DEFAULT' }],
    };
    const { send, createTargetCalls } = buildMockSend(state);
    const ctx = buildMockCtx(send);
    const session = buildSession();

    await handleNew(ctx, {
      url: 'about:blank',
      _agentSession: session,
      _agentSessionId: session.id,
    });

    expect(createTargetCalls).toHaveLength(1);
    expect(createTargetCalls[0]).not.toHaveProperty('browserContextId');
    // Post-create logic pins to whatever profile the new tab landed in.
    expect(session.browserContextId).toBe('CTX-DEFAULT');
  });
});
