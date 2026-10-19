/**
 * Profile / browserContextId resolution for profile-sticky sessions.
 *
 * ─── Bug background (Issue B, alpha.4) ───────────────────────────────
 * v5.0.0-alpha.2 added profile-sticky sessions: once a session interacts
 * with a tab, `session.browserContextId` is pinned to that tab's Chrome
 * profile context, and subsequent `tabs.new` calls are supposed to open
 * inside the same profile.
 *
 * In practice (see .temp/chat2.md, item 31 — agent sent outreach from
 * the personal Gmail account because that profile was foreground), the
 * agent still landed in whichever Chrome window the user had focused.
 *
 * Two failure modes were identified:
 *
 *   1. `tabs.new` was called with a pinned `browserContextId` that no
 *      longer existed (the user closed every tab in that profile, or
 *      Chrome rotated context IDs after a profile switch). When Chrome
 *      cannot find the requested context it silently falls back to the
 *      *currently active* browser context — exactly the wrong profile.
 *
 *   2. `Target.getBrowserContexts` only lists contexts created via
 *      `Target.createBrowserContext` (incognito-like). User-data-dir
 *      profile contexts only appear via `Target.getTargets`, so any
 *      validation that looked at one endpoint missed the other.
 *
 * Fix: validate the pinned `browserContextId` against the *union* of
 * `getBrowserContexts` and the `browserContextId` field on every
 * existing target before passing it to `Target.createTarget`. If the
 * pin is stale, drop it so the post-create logic can re-pin to the
 * profile the new tab actually landed in (rather than silently
 * pretending we are still pinned to a dead context).
 *
 * This file is consumed by `tools/tabs.ts handleNew` and is unit-tested
 * directly in `__tests__/unit/profile-launch.test.ts`.
 */

import type { AgentSession } from './session-manager.js';

// ─── Types ──────────────────────────────────────────────────────────

/** Minimal CDP send-command signature this module needs. */
export type ProfileResolverSend = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

interface TargetInfo {
  targetId: string;
  browserContextId?: string;
  type?: string;
  url?: string;
  title?: string;
}

// ─── Public helpers ─────────────────────────────────────────────────

/**
 * Collect every browserContextId Chrome currently knows about, by
 * combining `Target.getBrowserContexts` (for `createBrowserContext`-
 * created contexts) with the `browserContextId` field of every
 * existing target (for user-data-dir profile contexts, which are NOT
 * returned by `getBrowserContexts`).
 *
 * Errors from either CDP call are swallowed — the helper returns the
 * union of whatever it could collect.
 */
export async function collectKnownContextIds(
  send: ProfileResolverSend,
): Promise<Set<string>> {
  const ids = new Set<string>();

  try {
    const ctxs = (await send('Target.getBrowserContexts', {})) as {
      browserContextIds?: string[];
    };
    for (const id of ctxs?.browserContextIds ?? []) ids.add(id);
  } catch {
    /* ignore — helper is best-effort */
  }

  try {
    const targets = (await send('Target.getTargets', {})) as {
      targetInfos?: TargetInfo[];
    };
    for (const t of targets?.targetInfos ?? []) {
      if (t.browserContextId) ids.add(t.browserContextId);
    }
  } catch {
    /* ignore — helper is best-effort */
  }

  return ids;
}

/**
 * Resolve the browserContextId to use when creating a new tab for a
 * profile-pinned session.
 *
 * Returns:
 *  - the pinned context id if Chrome still knows about it,
 *  - `undefined` if the session has no pin,
 *  - `undefined` if the pin has gone stale (caller should clear the
 *    pin and let the post-create flow re-pin to whatever profile the
 *    new tab actually lands in).
 */
export async function resolvePinnedContextId(
  send: ProfileResolverSend,
  session: Pick<AgentSession, 'browserContextId'> | undefined,
): Promise<string | undefined> {
  const pinned = session?.browserContextId;
  if (!pinned) return undefined;

  const known = await collectKnownContextIds(send);
  if (known.has(pinned)) return pinned;

  return undefined;
}
