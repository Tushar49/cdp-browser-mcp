/**
 * Central preprocessing layer that runs before every tool handler.
 *
 * Mirrors the session routing, tab claiming, and modal-check logic
 * that lived in server.js handleTool() but was missing from the v5
 * registry-based dispatch.
 *
 * P0-1 fix: Without this, tools never receive _agentSessionId or
 * _agentSession — session isolation and tab locking are broken.
 */

import type { ServerContext } from '../types.js';
import type { CleanupStrategy } from '../types.js';
import { Errors } from '../utils/error-handler.js';

/** Timestamp of the last stale-session sweep. */
let lastSweep = 0;
const SWEEP_INTERVAL_MS = 30_000;

/**
 * Tools whose actions all operate on a tab (agent-DX E5, v5.2): when the
 * schema no longer requires tabId, these may auto-resolve it.
 */
const TAB_BOUND_TOOLS = new Set([
  'page', 'interact', 'form', 'execute', 'observe', 'emulate', 'storage', 'debug',
]);

/** Action-aware check: does THIS call operate on a tab? */
export function needsTabId(toolName: string, action?: string): boolean {
  if (TAB_BOUND_TOOLS.has(toolName)) return true;
  if (toolName === 'tabs') return ['info', 'close', 'activate'].includes(action ?? '');
  if (toolName === 'webauthn') return ['add_authenticator', 'reset'].includes(action ?? '');
  return false;
}

/**
 * Auto-resolve tabId when omitted (agent-DX E5): exactly one open page tab →
 * use it; otherwise throw an actionable error that lists the open tabs.
 * Deliberately applied ONLY to tab-bound (toolName, action) pairs —
 * tabs.list with many tabs must keep working without a tabId.
 */
export async function autoResolveTabId(ctx: ServerContext): Promise<string> {
  const targets = (await ctx.sendCommand('Target.getTargets', {})) as {
    targetInfos?: Array<{ targetId: string; url?: string; type?: string }>;
  };
  const pages = (targets.targetInfos ?? []).filter((t) => t.type === 'page');
  if (pages.length === 1) return pages[0].targetId;
  if (pages.length === 0) {
    throw Errors.noOpenTabs();
  }
  const list = pages
    .slice(0, 12)
    .map((t, i) => `${i + 1}. [${t.targetId}] ${String(t.url ?? '').slice(0, 80)}`);
  throw Errors.tabIdRequired(
    pages[0].targetId,
    `Multiple tabs are open (${pages.length}) and no tabId was specified.`,
    `${list.join('\n')}${pages.length > 12 ? `\n… and ${pages.length - 12} more` : ''}`,
  );
}

/**
 * Preprocess a tool call: resolve agent session, claim tab locks,
 * check modal blockers, and inject internal fields.
 */
export async function preprocessToolCall(
  ctx: ServerContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // 1. Resolve or create agent session
  const sessionId = (args.sessionId as string) || ctx.processSessionId;
  const cleanupStrategy = (args.cleanupStrategy as CleanupStrategy) || undefined;
  const session = ctx.sessions.getOrCreate(
    sessionId,
    ctx.config.defaultCleanupStrategy,
    cleanupStrategy,
  );
  ctx.sessions.touch(sessionId);

  // 2. Sweep stale sessions periodically (non-blocking)
  const now = Date.now();
  if (now - lastSweep > SWEEP_INTERVAL_MS) {
    lastSweep = now;
    ctx.sessions.sweepStale(ctx.config.sessionTTL, async (expired) => {
      // Release tab locks and close tabs when cleanupStrategy is 'close'
      const tabIds = ctx.tabOwnership.releaseSession(expired.id);
      if (expired.cleanupStrategy === 'close') {
        for (const tabId of tabIds) {
          try {
            await ctx.sendCommand('Target.closeTarget', { targetId: tabId });
          } catch { /* tab may already be closed */ }
        }
      }
      // 'detach' and 'none' — just release locks, tabs stay open
    }).catch(() => { /* best-effort sweep */ });
  }

  // 2.5 Auto-resolve tabId when omitted (agent-DX E5, v5.2): tab-bound tools
  // work with zero-config when exactly one tab is open; otherwise they fail
  // with an actionable list of open tabs. Never fires for tab-less actions
  // (tabs list/find/new, webauthn authenticatorId actions, cleanup, …).
  if (!args.tabId && needsTabId(toolName, args.action as string | undefined)) {
    args.tabId = await autoResolveTabId(ctx);
  }

  // 3. If tabId provided, claim tab lock if unowned
  const tabId = args.tabId as string | undefined;
  if (tabId) {
    const exclusive = args.exclusive !== false;
    const claimed = ctx.tabOwnership.claimIfUnowned(tabId, sessionId, exclusive);
    if (!claimed && !ctx.tabOwnership.canAccess(tabId, sessionId, exclusive ? undefined : false)) {
      const lock = ctx.tabOwnership.getLock(tabId);
      throw Errors.tabLocked(tabId, lock?.sessionId ?? 'another session');
    }
    // Add to session's tab set
    session.tabIds.add(tabId);
  }

  // 4. Check modal state blocking
  if (tabId && ctx.modalStates) {
    const action = args.action as string | undefined;
    const blocked = ctx.modalStates.checkBlocked(tabId, toolName, action);
    if (blocked) throw blocked;
  }

  // 5. Auto-detect profile: pin session to the Chrome profile of its first tab
  if (tabId && !session.browserContextId) {
    try {
      const targets = (await ctx.sendCommand('Target.getTargets', {})) as {
        targetInfos?: Array<{ targetId: string; browserContextId?: string }>;
      };
      const target = targets?.targetInfos?.find((t) => t.targetId === tabId);
      if (target?.browserContextId) {
        session.browserContextId = target.browserContextId;
      }
    } catch { /* non-critical — profile detection is best-effort */ }
  }

  // 6. Inject internal fields for tools
  args._agentSessionId = sessionId;
  args._agentSession = session;

  // 7. Resolve CDP target session for tab-bound tools
  if (tabId) {
    try {
      const cdpSessionId = await ctx.tabSessions.getSession(ctx.cdpClient, tabId);
      args._sessionId = cdpSessionId;
    } catch {
      // Tab may not be attachable (e.g., chrome:// pages)
      // Don't fail — some tools don't need a CDP session
    }
  }

  return args;
}
