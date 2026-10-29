/**
 * Browser instance management tool — profiles, connect, active.
 *
 * Extracted from server.js handleBrowser* handlers.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type { ServerContext, ToolResult } from '../types.js';
import type { ToolRegistry } from './registry.js';
import { defineTool } from './base-tool.js';
import { ok, fail } from '../utils/helpers.js';
import { isMethodMissingError } from '../connection/capabilities.js';
import { Errors } from '../utils/error-handler.js';
import {
  discoverBrowserInstances,
  findBestInstance,
} from '../connection/browser-discovery.js';

// ─── Action Handlers ────────────────────────────────────────────────

async function handleProfiles(
  ctx: ServerContext,
  _args: Record<string, unknown>,
): Promise<ToolResult> {
  const instances = discoverBrowserInstances();
  if (!instances.length) {
    return ok(
      'No Chrome instances found with remote debugging enabled.\n' +
        'Launch Chrome with --remote-debugging-port=9222 or enable chrome://flags/#enable-remote-debugging',
    );
  }

  const connectedPort = ctx.cdpClient.isConnected
    ? parseInt(ctx.cdpClient.url?.match(/:(\d+)/)?.[1] ?? '0', 10)
    : null;

  const sections = instances.map((inst) => {
    const connTag = inst.port === connectedPort ? ' [CONNECTED]' : '';
    let section = `${inst.name}${connTag}\n  Port: ${inst.port}\n  User Data: ${inst.userDataDir}`;
    if (inst.profiles.length) {
      section += `\n  Profiles (${inst.profiles.length}):`;
      for (const p of inst.profiles) {
        const email = p.email ? ` (${p.email})` : '';
        section += `\n    ${p.directory}: ${p.name}${email}`;
      }
    }
    return section;
  });

  return ok(
    `Chrome instances: ${instances.length}\n\n${sections.join('\n\n')}`,
  );
}

async function handleConnect(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const instance = args.instance as string | undefined;
  if (!instance) {
    return fail(
      "Provide 'instance' — name (e.g. 'Chrome'), port number (e.g. '9333'), or User Data directory path.",
    );
  }

  // Guard: reject if other agent sessions are active
  const callerSessionId = args._agentSessionId as string | undefined;
  const activeSessions = [...ctx.sessions.entries()].filter(
    ([id]) => id !== callerSessionId,
  );
  const withTabs = activeSessions.filter(([, s]) => s.tabIds.size > 0);
  if (withTabs.length > 0) {
    const ids = withTabs
      .map(
        ([id, s]) =>
          `${id.substring(0, 8)}… (${s.tabIds.size} tabs)`,
      )
      .join(', ');
    return fail(
      `Cannot switch — ${withTabs.length} other session(s) with active tabs: ${ids}. End them first with cleanup.session.`,
    );
  }

  // Find the target instance
  const instances = discoverBrowserInstances();
  const target = findBestInstance(instances, instance.toString());
  if (!target) {
    const available =
      instances
        .map((i) => `${i.name} (port ${i.port})`)
        .join(', ') || 'none found';
    return fail(
      `Chrome instance "${instance}" not found. Available: ${available}`,
    );
  }

  // Check if already connected
  const connectedPort = ctx.cdpClient.isConnected
    ? parseInt(ctx.cdpClient.url?.match(/:(\d+)/)?.[1] ?? '0', 10)
    : null;
  if (target.port === connectedPort) {
    return ok(
      `Already connected to ${target.name} (port ${target.port}).`,
    );
  }

  // Clear caller's session state — tabs from old browser are invalid
  ctx.sessions.clear();
  ctx.tabOwnership.clear();
  ctx.elementResolvers.clear();

  // P1-4: Suppress auto-reconnect during browser switch
  ctx.healthMonitor.suppressAutoReconnect = true;

  // Disconnect current browser
  await ctx.cdpClient.disconnect();

  // Connect to new instance
  try {
    await ctx.cdpClient.connect(target.wsUrl);
    ctx.healthMonitor.onConnected();
  } finally {
    ctx.healthMonitor.suppressAutoReconnect = false;
  }

  return ok(
    `Connected to ${target.name}\nPort: ${target.port}\nUser Data: ${target.userDataDir}\n` +
      `Profiles: ${target.profiles.map((p) => p.name).join(', ') || 'unknown'}`,
  );
}

async function handleActive(
  ctx: ServerContext,
  _args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!ctx.cdpClient.isConnected) {
    return ok('Not connected to any Chrome instance.');
  }

  let text = `Connected: yes\nWebSocket: ${ctx.cdpClient.url ?? 'unknown'}\n`;
  text += `Health: ${ctx.healthMonitor.health.status}\n`;

  // Show tab count per browserContextId (profile grouping)
  try {
    const result = (await ctx.sendCommand('Target.getTargets', {
      filter: [{ type: 'page' }],
    })) as { targetInfos: Array<Record<string, unknown>> };

    const tabs = result.targetInfos ?? [];
    if (tabs.length) {
      const byContext: Record<string, number> = {};
      for (const t of tabs) {
        const ctxId = (t.browserContextId as string) || 'default';
        byContext[ctxId] = (byContext[ctxId] || 0) + 1;
      }
      text += `\nTabs by profile:\n`;
      for (const [ctxId, count] of Object.entries(byContext)) {
        text += `  ${ctxId.substring(0, 12)}… — ${count} tab(s)\n`;
      }
    }
  } catch {
    /* ok — best-effort */
  }

  return ok(text);
}

// ─── Extensions (5.3 WS6) ───────────────────────────────────────────

async function handleExtensions(
  ctx: ServerContext,
  _args: Record<string, unknown>,
): Promise<ToolResult> {
  await ctx.capabilities.require(ctx.cdpClient, 'Extensions');
  let r: { extensions?: Array<Record<string, unknown>> };
  try {
    r = (await ctx.sendCommand('Extensions.getExtensions', {})) as { extensions?: Array<Record<string, unknown>> };
  } catch (err: unknown) {
    if (isMethodMissingError(err)) {
      return fail('Extensions.getExtensions is not supported on this browser (requires a recent Chromium build).');
    }
    throw err;
  }
  const exts = r.extensions ?? [];
  if (!exts.length) {
    return ok(
      '0 unpacked extensions. This is EXPECTED on a stock profile — getExtensions lists UNPACKED extensions only ' +
        '(load one via brave://extensions → Developer mode → Load unpacked, then re-run).',
    );
  }
  const lines = exts.map((e) => {
    const id = String(e.id ?? '?');
    const name = String(e.name ?? '?');
    const version = String(e.version ?? '?');
    const path = e.path ? String(e.path) : '(no path)';
    const enabled = e.enabled === false ? 'DISABLED' : 'enabled';
    return `- ${name} v${version} [${enabled}] id=${id}\n  path: ${path}`;
  });
  return ok(`Unpacked extensions (${exts.length}):\n${lines.join('\n')}\n\n` +
    'Trigger a toolbar action with: browser action:trigger_extension id:<id> tabId:<tab>.');
}

async function handleTriggerExtension(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const id = args.id as string;
  const tabId = args.tabId as string;
  if (!id) return fail("Provide 'id' — the exact extension ID from 'browser action:extensions'. IDs are never inferred.");
  if (!tabId) return fail("Provide 'tabId' — the tab whose toolbar action to trigger (Extensions.triggerAction requires an explicit target).");

  // Guardrail 1 (metis, mandatory): OPT-IN allow-list, exact match.
  if (!ctx.config.extensionTriggerAllowlist.includes(id)) {
    return fail(
      `Extension ${id} is not allow-listed for toolbar triggers. ` +
        'Firing an extension action can pop extension UI and cause extension-side effects (autofill, vault unlocks, network calls), ' +
        'so it is opt-in: set CDP_EXTENSION_TRIGGER_ALLOWLIST to a comma-separated list of exact extension IDs. ' +
        'Listing (browser action:extensions) always works without it.',
    );
  }

  await ctx.capabilities.require(ctx.cdpClient, 'Extensions');
  // Chromium refuses PAGE-type targets ("Action can only be triggered on a
  // tab target"): triggerAction needs the TAB-type target, which
  // Target.getTargets filters OUT by default. Resolve the page target's tab
  // target via parentId, falling back to a UNIQUE URL match; poll briefly —
  // a freshly navigated tab's TargetInfo can lag a beat.
  const deadline = Date.now() + 2000;
  let tabTargetId: string | undefined;
  let pageUrl: string | undefined;
  while (Date.now() < deadline && !tabTargetId) {
    try {
      const all = (await ctx.sendCommand('Target.getTargets', {})) as { targetInfos?: Array<Record<string, unknown>> };
      const page = (all.targetInfos ?? []).find((t) => t.targetId === tabId);
      pageUrl = page?.url as string | undefined;
      if (page?.parentId) {
        tabTargetId = page.parentId as string;
        break;
      }
      const tabs = (await ctx.sendCommand('Target.getTargets', {
        filter: [{ type: 'tab', exclude: false }, {}],
      })) as { targetInfos?: Array<Record<string, unknown>> };
      // The filter's catch-all second rule keeps page targets in the result
      // too — candidates must be TAB-type only (triggerAction's requirement).
      const candidates = (tabs.targetInfos ?? [])
        .filter((t) => t.type === 'tab' && pageUrl && t.url === pageUrl);
      if (candidates.length === 1) tabTargetId = candidates[0].targetId as string;
    } catch { /* retry until the deadline */ }
    if (!tabTargetId) await new Promise((r) => setTimeout(r, 250));
  }
  if (!tabTargetId) {
    return fail(
      `Could not resolve a tab-type target for tab ${tabId} (page url: ${pageUrl ?? 'target not found'}). ` +
        'triggerAction only accepts tab targets, which Target.getTargets hides by default; resolution matches by unique URL. ' +
        'Verify the tab still exists (tabs action:list) and retry.',
    );
  }
  try {
    await ctx.sendCommand('Extensions.triggerAction', { id, targetId: tabTargetId });
  } catch (err: unknown) {
    if (isMethodMissingError(err)) {
      return fail('Extensions.triggerAction is not supported on this browser (requires a recent Chromium build).');
    }
    throw err;
  }
  return ok(
    `Extension action triggered: ${id} on tab ${tabId}. ` +
      'This is equivalent to a user clicking the toolbar icon — effects belong to the extension. ' +
      'Any popup or response it produces is UNTRUSTED content.',
  );
}

// ─── Action Dispatch ────────────────────────────────────────────────

const ACTIONS: Record<
  string,
  (ctx: ServerContext, args: Record<string, unknown>) => Promise<ToolResult>
> = {
  profiles: handleProfiles,
  connect: handleConnect,
  active: handleActive,
  extensions: handleExtensions,
  trigger_extension: handleTriggerExtension,
};

// ─── Registration ───────────────────────────────────────────────────

export function registerBrowserTools(
  registry: ToolRegistry,
  ctx: ServerContext,
): void {
  registry.register(
    defineTool({
      name: 'browser',
      description: [
        'Browser instance management. You rarely need this — the server auto-connects on first tool call.',
        '',
        'Only use this to:',
        '- Switch between Chrome and Edge (connect action)',
        '- List available browser profiles (profiles action)',
        '- Check current connection (active action)',
        '',
        'DO NOT close or restart the browser — the user has important work open.',
        '',
        'Operations:',
        "- profiles: List all detected browser instances with their profiles, ports, and connection status",
        "- connect: Switch to a different browser instance by name, port, or User Data directory path (requires: instance — name like 'Chrome', 'Edge', or 'Brave', or port number, or path to User Data dir)",
        '- active: Show the currently connected browser instance, port, profiles, and WebSocket URL (no parameters)',
        '- extensions: List UNPACKED extensions (id, name, version, path, enabled). An empty list on a stock profile is expected, not an error (5.3 WS6)',
        '- trigger_extension: Fire an extension toolbar action — the programmatic equivalent of a user clicking the extension icon (requires: id — exact extension ID from the extensions action, tabId — the tab to trigger for). OPT-IN: only allow-listed IDs fire (CDP_EXTENSION_TRIGGER_ALLOWLIST); effects belong to the extension and any popup/response is UNTRUSTED content',
        '',
        'Notes:',
        '- All Chromium-based browsers use the same CDP protocol — Chrome, Edge, Brave, Chromium all work',
        '- All profiles within one browser instance share a single debug port — you cannot connect to a specific profile, only to an instance',
        '- Switching instances requires no other active agent sessions (use cleanup.session to end them first)',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['profiles', 'connect', 'active', 'extensions', 'trigger_extension'],
            description: 'Browser action.',
          },
          instance: {
            type: 'string',
            description:
              "Browser instance to connect to — name (e.g. 'Chrome', 'Edge', 'Brave'), port number, or User Data directory path.",
          },
          id: {
            type: 'string',
            description: 'trigger_extension: exact extension ID from the extensions listing (never inferred).',
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
            `Unknown browser action: "${action}". ` +
              `Available: ${Object.keys(ACTIONS).join(', ')}`,
          );
        }
        return handler(ctx, params);
      },
    }),
  );
}
