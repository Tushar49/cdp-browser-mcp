/**
 * Cleanup tool — disconnect sessions, clean temp files, manage agent sessions.
 *
 * Extracted from server.js handleCleanup* handlers.
 */

import { existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import type { ServerContext, ToolResult } from '../types.js';
import type { ToolRegistry } from './registry.js';
import { defineTool } from './base-tool.js';
import { ok, fail } from '../utils/helpers.js';

// ─── Action Handlers ────────────────────────────────────────────────

async function handleDisconnectTab(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tabId = args.tabId as string | undefined;
  if (!tabId) return fail("Provide 'tabId'.");

  const sessionId = args._agentSessionId as string | undefined;
  const lock = ctx.tabOwnership.getLock(tabId);
  if (lock?.sessionId && lock.sessionId !== sessionId) {
    return fail(
      `Tab [${tabId}] is locked by another session. Cannot disconnect.`,
    );
  }

  // Release the tab lock and clean up per-tab state
  ctx.tabOwnership.release(tabId);
  ctx.elementResolvers.delete(tabId);
  const detachedSess = ctx.tabSessions.get(tabId);
  if (detachedSess) ctx.findState.delete(detachedSess);
  ctx.tabSessions.detach(tabId, ctx.cdpClient);
  ctx.snapshotCache.invalidate(tabId);
  // Remove from session's tabIds
  const session = args._agentSession as { tabIds: Set<string> } | undefined;
  if (session) session.tabIds.delete(tabId);

  return ok('Detached from tab.');
}

async function handleDisconnectAll(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const sessionId = args._agentSessionId as string | undefined;
  let count = 0;
  let skipped = 0;

  for (const [tabId, lock] of ctx.tabOwnership.entries()) {
    if (!lock.sessionId || lock.sessionId === sessionId) {
      ctx.tabOwnership.release(tabId);
      count++;
    } else {
      skipped++;
    }
  }

  return ok(
    `Disconnected from ${count} tab(s).${skipped ? ` ${skipped} locked tab(s) skipped.` : ''}`,
  );
}

async function handleCleanTemp(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tempDir = ctx.config.tempDir;
  if (!tempDir || !existsSync(tempDir)) return ok('No temp directory.');

  const sessionId = args._agentSessionId as string | undefined;
  const prefix = sessionId ? sessionId.substring(0, 8) + '_' : null;
  const files = readdirSync(tempDir);
  let count = 0;

  for (const f of files) {
    // Only delete files belonging to this session, or unprefixed legacy files
    if (!prefix || f.startsWith(prefix) || !/^[a-f0-9]{8}_/.test(f)) {
      try {
        unlinkSync(join(tempDir, f));
        count++;
      } catch {
        /* best-effort */
      }
    }
  }

  return ok(`Cleaned up ${count} temp file(s) from ${tempDir}`);
}

async function handleListSessions(
  ctx: ServerContext,
  _args: Record<string, unknown>,
): Promise<ToolResult> {
  if (ctx.sessions.size === 0) return ok('No active agent sessions.');

  // Fetch all tabs once for URL lookup
  let allTabs: Array<Record<string, unknown>> = [];
  try {
    const result = (await ctx.sendCommand('Target.getTargets', {
      filter: [{ type: 'page' }],
    })) as { targetInfos: Array<Record<string, unknown>> };
    allTabs = result.targetInfos ?? [];
  } catch {
    /* ok */
  }
  const tabMap = new Map<string, Record<string, unknown>>();
  for (const t of allTabs) tabMap.set(t.targetId as string, t);

  const now = Date.now();
  const ttl = ctx.config.sessionTTL;
  const sections: string[] = [];

  for (const [id, s] of ctx.sessions.entries()) {
    const age = ((now - s.lastActivity) / 1000).toFixed(0);
    const remaining = Math.max(
      0,
      (ttl - (now - s.lastActivity)) / 1000,
    ).toFixed(0);

    const ownedTabs = [...s.tabIds].filter(
      (tid) => ctx.tabOwnership.getLock(tid)?.sessionId === id,
    );

    let section =
      `Session: ${id.substring(0, 8)}…\n` +
      `  Last activity: ${age}s ago | TTL remaining: ${remaining}s\n` +
      `  Cleanup strategy: ${s.cleanupStrategy || 'detach'}\n` +
      `  Owned tabs: ${ownedTabs.length}`;

    if (ownedTabs.length) {
      for (const tid of ownedTabs) {
        const tab = tabMap.get(tid);
        const lock = ctx.tabOwnership.getLock(tid);
        const originTag = lock ? ` (${lock.origin})` : '';
        section += `\n    [${tid}]${originTag} ${tab ? tab.url : '(unknown)'}`;
      }
    }
    sections.push(section);
  }

  return ok(
    `Agent sessions: ${ctx.sessions.size}\n` +
      `Session TTL: ${ttl / 1000}s\n\n` +
      sections.join('\n\n'),
  );
}

async function handleSession(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const sid = args._agentSessionId as string | undefined;
  if (!sid) return fail('No session found.');

  const session = ctx.sessions.get(sid);
  if (!session) return fail('No session found.');

  const strategy =
    (args.cleanupStrategy as string) ||
    session.cleanupStrategy ||
    'detach';
  let cleaned = 0;

  for (const tid of session.tabIds) {
    const lock = ctx.tabOwnership.getLock(tid);
    if (!lock || lock.sessionId !== sid) continue; // skip borrowed

    if (lock.origin === 'claimed') {
      // Pre-existing tabs: release lock + detach, never close
      ctx.tabOwnership.release(tid);
      ctx.elementResolvers.delete(tid);
      ctx.tabSessions.detach(tid, ctx.cdpClient);
      ctx.snapshotCache.invalidate(tid);
      cleaned++;
    } else {
      // Created tabs: apply cleanup strategy
      if (strategy === 'none') {
        ctx.tabOwnership.release(tid);
      } else if (strategy === 'close') {
        try {
          await ctx.sendCommand('Target.closeTarget', { targetId: tid });
        } catch {
          /* ok */
        }
        ctx.tabOwnership.release(tid);
      } else {
        // detach
        ctx.tabOwnership.release(tid);
      }
      ctx.elementResolvers.delete(tid);
      ctx.tabSessions.detach(tid, ctx.cdpClient);
      ctx.snapshotCache.invalidate(tid);
      cleaned++;
    }
  }

  session.tabIds.clear();
  ctx.sessions.delete(sid);

  const verb =
    strategy === 'close'
      ? 'closed'
      : strategy === 'none'
        ? 'released (tabs preserved)'
        : 'detached';
  return ok(
    `Session ${sid.substring(0, 8)}… ended. ${cleaned} owned tab(s) ${verb}.`,
  );
}

async function handleReset(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const closeTabs = (args.closeTabs as boolean) || false;
  let closedCount = 0;
  let detachedCount = 0;
  let preservedCount = 0;

  for (const [id, s] of ctx.sessions.entries()) {
    for (const tid of s.tabIds) {
      const lock = ctx.tabOwnership.getLock(tid);
      if (!lock || lock.sessionId !== id) continue;

      if (lock.origin === 'claimed') {
        // NEVER close pre-existing tabs
        ctx.tabOwnership.release(tid);
        ctx.elementResolvers.delete(tid);
        ctx.tabSessions.detach(tid, ctx.cdpClient);
        ctx.snapshotCache.invalidate(tid);
        preservedCount++;
      } else if (lock.origin === 'created' && closeTabs) {
        try {
          await ctx.sendCommand('Target.closeTarget', { targetId: tid });
        } catch {
          /* ok */
        }
        ctx.tabOwnership.release(tid);
        ctx.elementResolvers.delete(tid);
        ctx.tabSessions.detach(tid, ctx.cdpClient);
        ctx.snapshotCache.invalidate(tid);
        closedCount++;
      } else {
        ctx.tabOwnership.release(tid);
        ctx.elementResolvers.delete(tid);
        ctx.tabSessions.detach(tid, ctx.cdpClient);
        ctx.snapshotCache.invalidate(tid);
        detachedCount++;
      }
    }
    s.tabIds.clear();
  }

  const sessionCount = ctx.sessions.size;
  ctx.sessions.clear();
  ctx.tabOwnership.clear();

  return ok(
    `Reset complete. ${sessionCount} session(s) cleared.\n` +
      `Created tabs: ${closeTabs ? closedCount + ' closed' : detachedCount + ' detached'}\n` +
      `Pre-existing tabs: ${preservedCount} preserved (never closed)`,
  );
}

async function handleStatus(
  ctx: ServerContext,
  _args: Record<string, unknown>,
): Promise<ToolResult> {
  let tabs: Array<Record<string, unknown>> = [];
  try {
    const result = (await ctx.sendCommand('Target.getTargets', {
      filter: [{ type: 'page' }],
    })) as { targetInfos: Array<Record<string, unknown>> };
    tabs = result.targetInfos ?? [];
  } catch {
    /* ok */
  }

  const tempDir = ctx.config.tempDir;
  const tempCount =
    tempDir && existsSync(tempDir) ? readdirSync(tempDir).length : 0;

  const tabList = tabs
    .slice(0, 10)
    .map(
      (t) =>
        `  ${t.targetId} — ${(t.title as string) || '(untitled)'}`,
    )
    .join('\n');
  const more =
    tabs.length > 10 ? `\n  ... and ${tabs.length - 10} more` : '';

  // Issue #15: Show per-session TTL remaining
  const ttl = ctx.config.sessionTTL;
  const now = Date.now();
  let sessionSummary = `Agent sessions: ${ctx.sessions.size}`;
  if (ctx.sessions.size > 0) {
    sessionSummary += `\nSession TTL: ${ttl / 1000}s`;
    for (const [id, s] of ctx.sessions.entries()) {
      const remaining = Math.max(0, ttl - (now - s.lastActivity));
      const remainingSec = Math.round(remaining / 1000);
      const tabCount = s.tabIds.size;
      const warning = remainingSec < 60 ? ' ⚠ EXPIRING SOON' : '';
      sessionSummary += `\n  ${id.substring(0, 8)}… — TTL: ${remainingSec}s remaining, ${tabCount} tab(s), strategy: ${s.cleanupStrategy || 'detach'}${warning}`;
    }
  }

  return ok(
    `Browser tabs: ${tabs.length}\n` +
      sessionSummary + '\n' +
      `Connection health: ${ctx.healthMonitor.health.status} (failures: ${ctx.healthMonitor.health.failures})\n` +
      `Temp dir: ${tempDir || '(not set)'}\n` +
      `Temp files: ${tempCount}\n` +
      `\nRecent tabs:\n${tabList}${more}`,
  );
}

// ─── Action Dispatch ────────────────────────────────────────────────

const ACTIONS: Record<
  string,
  (ctx: ServerContext, args: Record<string, unknown>) => Promise<ToolResult>
> = {
  disconnect_tab: handleDisconnectTab,
  disconnect_all: handleDisconnectAll,
  clean_temp: handleCleanTemp,
  status: handleStatus,
  list_sessions: handleListSessions,
  session: handleSession,
  reset: handleReset,
};

// ─── Registration ───────────────────────────────────────────────────

export function registerCleanupTools(
  registry: ToolRegistry,
  ctx: ServerContext,
): void {
  registry.register(
    defineTool({
      name: 'cleanup',
      description: [
        "Session and connection management. Use 'status' to check server health.",
        '',
        "WARNING: 'reset' terminates ALL sessions. Only use if something is fundamentally broken.",
        '',
        'Operations:',
        '- disconnect_tab: Disconnect from a specific tab session without closing the tab (requires: tabId)',
        '- disconnect_all: Disconnect all active tab sessions owned by this session (no parameters)',
        '- clean_temp: Delete temporary files (screenshots, PDFs, response dumps) created by this session (no parameters)',
        '- status: Show current server status — active sessions, temp file count, connection state (no parameters)',
        '- list_sessions: List all active agent sessions with their TTL, idle time, cleanup strategy, and associated tabs (no parameters)',
        '- session: Explicitly end this agent session and clean up its owned tabs (optional: cleanupStrategy)',
        '- reset: Terminate ALL sessions and release all tab locks (optional: closeTabs — default false)',
        '',
        'Session params (all tools): sessionId — agent session ID for tab ownership/isolation; cleanupStrategy — close|detach|none for tab cleanup on expiry (default: detach); exclusive — lock tabs to session (default: true)',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'disconnect_tab',
              'disconnect_all',
              'clean_temp',
              'status',
              'list_sessions',
              'session',
              'reset',
            ],
            description: 'Cleanup action.',
          },
          tabId: {
            type: 'string',
            description: 'Tab ID for disconnect_tab.',
          },
          closeTabs: {
            type: 'boolean',
            description:
              'For reset: close tabs created by sessions (default: false). Pre-existing claimed tabs are NEVER closed.',
          },
          sessionId: {
            type: 'string',
            description:
              'Agent session ID for tab ownership and isolation. Tabs are locked to sessions. Default: per-process UUID.',
          },
          cleanupStrategy: {
            type: 'string',
            enum: ['close', 'detach', 'none'],
            description:
              "Tab cleanup on session expiry. 'detach' (default) keeps tabs open, 'close' removes them from browser, 'none' skips cleanup. Sticky per session.",
          },
          exclusive: {
            type: 'boolean',
            description:
              'Lock tab to this session (default: true). Set false to allow shared access.',
          },
        },
        required: ['action'],
      },
      handler: async (
        _ctx: ServerContext,
        params: Record<string, unknown>,
      ): Promise<ToolResult> => {
        const action = params.action as string;
        const handler = ACTIONS[action];
        if (!handler) {
          return fail(
            `Unknown cleanup action: "${action}". ` +
              `Available: ${Object.keys(ACTIONS).join(', ')}`,
          );
        }
        return handler(ctx, params);
      },
    }),
  );
}
