#!/usr/bin/env node
/**
 * Entry point for the CDP Browser MCP Server v5.
 *
 * Wires together all extracted modules:
 *  - Configuration (env vars → typed config)
 *  - CDP client (WebSocket connection to the browser)
 *  - Health monitor (ping/pong + auto-reconnect)
 *  - Domain manager (lazy CDP domain enablement)
 *  - Snapshot cache (incremental/diff snapshots)
 *  - Tool registry (registration + dispatch)
 *  - MCP SDK server (STDIO transport)
 *
 * Startup optimizations:
 *  - No browser discovery at startup (lazy on first tool call)
 *  - Synchronous tool registration (no async)
 *  - STDIO transport started immediately
 *  - Startup time logged to stderr for benchmarking
 */

const startTime = performance.now();

import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { CDPClient } from './connection/cdp-client.js';
import { DomainManager } from './connection/domain-manager.js';
import { TabSessionService } from './connection/tab-session-service.js';
import { SessionManager } from './session/session-manager.js';
import { TabOwnership } from './session/tab-ownership.js';
import { ModalStateManager } from './session/modal-state.js';
import type { ModalState } from './session/modal-state.js';
import { HealthMonitor } from './connection/health-monitor.js';
import { SnapshotCache } from './snapshot/cache.js';
import { ToolRegistry } from './tools/registry.js';
import { preprocessToolCall } from './tools/dispatch.js';
import { defineTool, success } from './tools/base-tool.js';
import { ActionableError, wrapError } from './utils/error-handler.js';
import type { ServerContext, FileChooserHandler } from './types.js';

// Tool modules
import { registerTabsTools } from './tools/tabs.js';
import { registerPageTools } from './tools/page.js';
import { registerInteractTools } from './tools/interact.js';
import { registerExecuteTools } from './tools/execute.js';
import { registerObserveTools } from './tools/observe.js';
import { registerEmulateTools } from './tools/emulate.js';
import { registerStorageTools } from './tools/storage.js';
import { registerInterceptTools } from './tools/intercept.js';
import { registerCleanupTools } from './tools/cleanup.js';
import { registerBrowserTools } from './tools/browser.js';
import { registerDebugTools } from './tools/debug.js';
import { registerFormTools } from './tools/form.js';
import { getSlimTools, mapSlimToFull } from './tools/slim-mode.js';

// ─── Bootstrap ──────────────────────────────────────────────────────

const VERSION = '5.0.2';

const config = loadConfig();

const cdpClient = new CDPClient({ commandTimeout: config.globalTimeout });

// Lazy initialization: HealthMonitor is created but doesn't discover browsers
const healthMonitor = new HealthMonitor(cdpClient, {
  cdpHost: config.cdpHost,
  cdpPort: config.cdpPort,
  preferredProfile: config.autoConnectProfile,
});

const domainManager = new DomainManager();
const tabSessionService = new TabSessionService();
const snapshotCache = new SnapshotCache();
const registry = new ToolRegistry();

// Wire auto-reconnect: when the WebSocket drops, let HealthMonitor retry
// and clear domain state since all sessions are invalidated
let modalEventsWired = false;
let eventPipelineWired = false;

cdpClient.on('disconnected', () => {
  modalEventsWired = false;
  eventPipelineWired = false;
  domainManager.clearAll();
  snapshotCache.clear();
  tabSessionService.clear();
  healthMonitor.onDisconnect().catch(() => {
    // Reconnect failed — next tool call will trigger autoConnect
  });
});

// Wire modal state and event pipeline when connected
cdpClient.on('connected', () => {
  wireModalEvents(ctx);
  wireEventPipeline(ctx);
});

// ─── Modal State Wiring ─────────────────────────────────────────────

/** Subscribe to CDP events that populate modal state. */
function wireModalEvents(serverCtx: ServerContext): void {
  if (modalEventsWired) return; // Already wired — don't duplicate
  modalEventsWired = true;

  const client = serverCtx.cdpClient;

  client.on('event', (event: { method: string; params: Record<string, unknown>; sessionId?: string }) => {
    switch (event.method) {
      case 'Page.javascriptDialogOpening': {
        const tabId = findTabBySession(serverCtx, event.sessionId);
        if (tabId) {
          serverCtx.modalStates.setModal(tabId, {
            type: 'dialog',
            tabId,
            details: {
              dialogType: event.params.type as ModalState['details']['dialogType'],
              message: event.params.message as string | undefined,
              defaultPrompt: event.params.defaultPrompt as string | undefined,
            },
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'Page.javascriptDialogClosed': {
        const tabId = findTabBySession(serverCtx, event.sessionId);
        if (tabId) serverCtx.modalStates.clearModal(tabId);
        break;
      }

      case 'Debugger.paused': {
        const tabId = findTabBySession(serverCtx, event.sessionId);
        if (tabId) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CDP callFrames shape is untyped
          const frames = event.params.callFrames as any[];
          const frame = frames?.[0];
          serverCtx.modalStates.setModal(tabId, {
            type: 'debugger-paused',
            tabId,
            details: {
              reason: event.params.reason as string | undefined,
              location: frame ? `${frame.url}:${frame.location?.lineNumber}` : undefined,
            },
            timestamp: Date.now(),
          });
        }
        break;
      }

      case 'Debugger.resumed': {
        const tabId = findTabBySession(serverCtx, event.sessionId);
        if (tabId) serverCtx.modalStates.clearModal(tabId);
        break;
      }
    }
  });
}

/** Reverse lookup: find tabId from a CDP sessionId. */
function findTabBySession(serverCtx: ServerContext, sessionId?: string): string | undefined {
  if (!sessionId) return undefined;
  for (const [tabId, cdpSid] of serverCtx.tabSessions.entries()) {
    if (cdpSid === sessionId) return tabId;
  }
  return undefined;
}

// ─── CDP Event Pipeline ─────────────────────────────────────────────

/**
 * Subscribe to ALL CDP events and route them to the appropriate state stores.
 *
 * Ported from server.js `handleEvent()` — covers:
 *  - Runtime.consoleAPICalled / exceptionThrown → consoleLogs
 *  - Network.requestWillBeSent / responseReceived / loadingFinished → networkReqs
 *  - Page.downloadWillBegin / downloadProgress → downloads
 *  - Page.javascriptDialogOpening → pendingDialogs (+ auto-accept timeout)
 *  - Page.fileChooserOpened → pendingFileChoosers callback dispatch
 *  - Fetch.requestPaused → pendingFetchRequests
 *  - Debugger.paused / resumed → pausedTabs
 *  - Target.attachedToTarget / detachedFromTarget → child session tracking (OOP iframes)
 */
function wireEventPipeline(serverCtx: ServerContext): void {
  if (eventPipelineWired) return;
  eventPipelineWired = true;

  const client = serverCtx.cdpClient;

  client.on('event', (event: { method: string; params: Record<string, unknown>; sessionId?: string }) => {
    const sessionId = event.sessionId ?? '';
    const params = event.params;

    switch (event.method) {
      // ── Console messages ──
      case 'Runtime.consoleAPICalled': {
        const logs = serverCtx.consoleLogs.get(sessionId) || [];
        const args = params.args as Array<{ value?: string; description?: string; type?: string }> | undefined;
        logs.push({
          level: params.type as string,
          text: args?.map(a => a.value ?? a.description ?? a.type).join(' ') || '',
          ts: Date.now(),
          url: (params.stackTrace as { callFrames?: Array<{ url?: string }> })?.callFrames?.[0]?.url || '',
        });
        if (logs.length > 500) logs.splice(0, logs.length - 500);
        serverCtx.consoleLogs.set(sessionId, logs);
        break;
      }

      case 'Runtime.exceptionThrown': {
        const logs = serverCtx.consoleLogs.get(sessionId) || [];
        const details = params.exceptionDetails as {
          exception?: { description?: string };
          text?: string;
          url?: string;
        } | undefined;
        logs.push({
          level: 'error',
          text: details?.exception?.description || details?.text || 'Unknown exception',
          ts: Date.now(),
          url: details?.url || '',
        });
        serverCtx.consoleLogs.set(sessionId, logs);
        break;
      }

      // ── Network requests ──
      case 'Network.requestWillBeSent': {
        const reqs = serverCtx.networkReqs.get(sessionId) || new Map();
        const reqId = params.requestId as string;
        const request = params.request as { url: string; method: string };
        reqs.set(reqId, {
          id: reqId,
          url: request.url,
          method: request.method,
          type: (params.type as string) || 'Other',
          ts: Date.now(),
          status: null,
          mimeType: null,
          size: null,
        });
        if (reqs.size > 300) {
          const first = reqs.keys().next().value;
          if (first !== undefined) reqs.delete(first);
        }
        serverCtx.networkReqs.set(sessionId, reqs);
        break;
      }

      case 'Network.responseReceived': {
        const reqs = serverCtx.networkReqs.get(sessionId);
        const reqId = params.requestId as string;
        if (reqs?.has(reqId)) {
          const r = reqs.get(reqId)!;
          const response = params.response as { status: number; mimeType: string };
          r.status = response.status;
          r.mimeType = response.mimeType;
        }
        break;
      }

      case 'Network.loadingFinished': {
        const reqs = serverCtx.networkReqs.get(sessionId);
        const reqId = params.requestId as string;
        if (reqs?.has(reqId)) {
          reqs.get(reqId)!.size = params.encodedDataLength as number;
        }
        break;
      }

      // ── Download tracking ──
      case 'Page.downloadWillBegin': {
        const dl = serverCtx.downloads.get(sessionId) || [];
        dl.push({
          guid: params.guid as string,
          url: params.url as string,
          suggestedFilename: (params.suggestedFilename as string) || 'unknown',
          state: 'inProgress',
          receivedBytes: 0,
          totalBytes: 0,
          ts: Date.now(),
        });
        if (dl.length > 100) dl.splice(0, dl.length - 100);
        serverCtx.downloads.set(sessionId, dl);
        break;
      }

      case 'Page.downloadProgress': {
        const dl = serverCtx.downloads.get(sessionId);
        if (dl) {
          const entry = dl.find(d => d.guid === (params.guid as string));
          if (entry) {
            entry.receivedBytes = (params.receivedBytes as number) || 0;
            entry.totalBytes = (params.totalBytes as number) || 0;
            entry.state = (params.state as string) || entry.state;
          }
        }
        break;
      }

      // ── Dialog handling ──
      case 'Page.javascriptDialogOpening': {
        const dialogs = serverCtx.pendingDialogs.get(sessionId) || [];
        dialogs.push({
          type: params.type as string,
          message: params.message as string,
          defaultPrompt: (params.defaultPromptText as string) || '',
          url: (params.url as string) || '',
          ts: Date.now(),
        });
        serverCtx.pendingDialogs.set(sessionId, dialogs);

        // Auto-accept after 10s if not manually handled
        setTimeout(async () => {
          const current = serverCtx.pendingDialogs.get(sessionId);
          if (current && current.length > 0) {
            try {
              await serverCtx.sendCommand('Page.handleJavaScriptDialog', { accept: true }, sessionId);
              current.shift();
            } catch { /* already handled */ }
          }
        }, 10000);
        break;
      }

      // ── File chooser events ──
      case 'Page.fileChooserOpened': {
        const handlers = serverCtx.pendingFileChoosers.get(sessionId) || [];
        for (const handler of handlers) {
          handler(sessionId, event.method, params);
        }

        // Also set modal state so other tools know about the file chooser
        const fileTabId = findTabBySession(serverCtx, sessionId);
        if (fileTabId) {
          serverCtx.modalStates.setModal(fileTabId, {
            type: 'filechooser',
            tabId: fileTabId,
            details: {
              multiple: params.mode === 'selectMultiple',
            },
            timestamp: Date.now(),
          });
        }
        break;
      }

      // ── Fetch interception ──
      case 'Fetch.requestPaused': {
        // Response-stage pause — continue by default
        if (params.responseStatusCode !== undefined) {
          (async () => {
            try {
              await serverCtx.sendCommand('Fetch.continueResponse', {
                requestId: params.requestId,
              }, sessionId);
            } catch { /* ok */ }
          })();
          break;
        }

        // Request-stage pause
        const pending = serverCtx.pendingFetchRequests.get(sessionId) || new Map();
        const reqId = params.requestId as string;
        const request = params.request as { url: string; method: string; headers: Record<string, string> };
        pending.set(reqId, {
          requestId: reqId,
          url: request.url,
          method: request.method,
          headers: request.headers,
          resourceType: params.resourceType as string,
          ts: Date.now(),
        });
        serverCtx.pendingFetchRequests.set(sessionId, pending);

        // Auto-continue after 10s to prevent hangs
        setTimeout(async () => {
          if (pending.has(reqId)) {
            try {
              await serverCtx.sendCommand('Fetch.continueRequest', { requestId: reqId }, sessionId);
            } catch { /* ok */ }
            pending.delete(reqId);
          }
        }, 10000);
        break;
      }

      // ── Debugger events ──
      case 'Debugger.paused': {
        const pauseTs = Date.now();
        serverCtx.pausedTabs.set(sessionId, {
          reason: params.reason as string,
          callFrames: params.callFrames as any[],
          hitBreakpoints: (params.hitBreakpoints as string[]) || [],
          ts: pauseTs,
        });

        // Auto-resume after debugger timeout to prevent permanently bricked tabs
        setTimeout(async () => {
          const entry = serverCtx.pausedTabs.get(sessionId);
          if (entry && entry.ts === pauseTs) {
            try {
              await serverCtx.sendCommand('Debugger.resume', {}, sessionId);
            } catch { /* ok */ }
            serverCtx.pausedTabs.delete(sessionId);
          }
        }, serverCtx.config.debuggerTimeout);
        break;
      }

      case 'Debugger.resumed': {
        serverCtx.pausedTabs.delete(sessionId);
        break;
      }

      // ── OOP iframe auto-attach events ──
      case 'Target.attachedToTarget': {
        const childSessionId = params.sessionId as string;
        const targetInfo = params.targetInfo as { type?: string; targetId?: string; url?: string } | undefined;
        if (targetInfo?.type === 'iframe' && targetInfo.targetId) {
          serverCtx.tabSessions.addChildSession(
            sessionId,
            targetInfo.targetId,
            childSessionId,
            targetInfo.url || '',
          );
          // Enable Runtime on the child session for JS execution
          serverCtx.sendCommand('Runtime.enable', {}, childSessionId).catch(() => {});
        }
        break;
      }

      case 'Target.detachedFromTarget': {
        const detachedSessionId = params.sessionId as string | undefined;
        const detachedTargetId = params.targetId as string | undefined;
        if (detachedSessionId || detachedTargetId) {
          serverCtx.tabSessions.removeChildSession(
            sessionId,
            detachedTargetId || detachedSessionId || '',
          );
        }
        break;
      }
    }
  });
}

// ─── Server Context (DI container) ──────────────────────────────────

const ctx: ServerContext = {
  config,
  cdpClient,
  healthMonitor,
  domainManager,
  sendCommand: (method, params, sessionId) =>
    cdpClient.send(method, params ?? {}, sessionId),
  tabSessions: tabSessionService,
  sessions: new SessionManager(),
  tabOwnership: new TabOwnership(),
  modalStates: new ModalStateManager(),
  processSessionId: randomUUID(),
  snapshotCache,
  elementResolvers: new Map(),
  consoleLogs: new Map(),
  networkReqs: new Map(),
  downloads: new Map(),
  pendingDialogs: new Map(),
  pendingFileChoosers: new Map(),
  pausedTabs: new Map(),
  pendingFetchRequests: new Map(),
};

// ─── Auto-connect with mutex (P0-2) ────────────────────────────────

let connectPromise: Promise<void> | null = null;

async function ensureConnected(): Promise<void> {
  if (cdpClient.isConnected) return;
  if (connectPromise) return connectPromise;

  connectPromise = healthMonitor.autoConnect();
  try {
    await connectPromise;
  } finally {
    connectPromise = null;
  }
}

// ─── Demo Tools ─────────────────────────────────────────────────────

registry.register(
  defineTool({
    name: 'ping',
    description: 'Health check. Returns server version and connection status.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () =>
      success(
        `pong — CDP Browser MCP v${VERSION}\nConnected: ${cdpClient.isConnected}`,
      ),
  }),
);

registry.register(
  defineTool({
    name: 'status',
    description: 'Server status: connection, config, sessions.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const lines = [
        `## CDP Browser MCP Server v${VERSION}`,
        `Connected: ${cdpClient.isConnected}`,
        `Default timeout: ${config.globalTimeout}ms`,
        `Default cleanup: ${config.defaultCleanupStrategy}`,
        `Session TTL: ${config.sessionTTL}ms`,
        `Registered tools: ${registry.size}`,
      ];
      return success(lines.join('\n'));
    },
  }),
);

// ─── Register All Tool Modules ──────────────────────────────────────

if (config.slimMode) {
  // Slim mode: 6 essential tools with Playwright-compatible names
  const slimTools = getSlimTools();
  for (const tool of slimTools) {
    registry.register(
      defineTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        handler: async (serverCtx, args) => {
          const mapped = mapSlimToFull(tool.name, args);
          return registry.dispatch(mapped.tool, mapped.args, serverCtx);
        },
      }),
    );
  }

  // Still register the full tools so slim→full dispatch works
  registerTabsTools(registry, ctx);
  registerPageTools(registry, ctx);
  registerInteractTools(registry, ctx);
  registerFormTools(registry, ctx);
} else {
  // Full mode: all 15 tools
  registerTabsTools(registry, ctx);
  registerPageTools(registry, ctx);
  registerInteractTools(registry, ctx);
  registerExecuteTools(registry, ctx);
  registerObserveTools(registry, ctx);
  registerEmulateTools(registry, ctx);
  registerStorageTools(registry, ctx);
  registerInterceptTools(registry, ctx);
  registerCleanupTools(registry, ctx);
  registerBrowserTools(registry, ctx);
  registerDebugTools(registry, ctx);
  registerFormTools(registry, ctx);
}

// ─── MCP Server─────────────────────────────────────────────────────

const server = new Server(
  { name: 'cdp-browser', version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: config.slimMode
    ? registry.list().filter(t => t.name.startsWith('browser_') || t.name === 'ping' || t.name === 'status')
    : registry.list(),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;

  // Auto-connect on first tool call
  // P0-1 (cycle 2): browser tool is exempt — it needs to work when NOT connected
  // P0-4: Surface connection errors for browser-dependent tools instead of swallowing
  const CONNECT_EXEMPT_TOOLS = new Set(['ping', 'status', 'browser']);
  if (!CONNECT_EXEMPT_TOOLS.has(name)) {
    try {
      await ensureConnected();
    } catch (err) {
      const ae = err instanceof ActionableError ? err : wrapError(err);
      return {
        content: [{
          type: 'text',
          text: `## Browser Not Connected\n\n${ae.message}\n\n### How to fix\n${ae.fix}\n\n` +
                `After fixing, just retry your command — no reconnect step needed.`,
        }],
        isError: true,
      };
    }
  }

  try {
    // P0-1: Preprocess — session routing, tab claiming, modal checks
    const args = await preprocessToolCall(ctx, name, rawArgs ?? {});
    return await registry.dispatch(name, args, ctx);
  } catch (err) {
    return wrapError(err).toToolResult();
  }
});

// ─── Start ──────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

const elapsed = performance.now() - startTime;
process.stderr.write(`CDP Browser MCP v${VERSION} started in ${elapsed.toFixed(0)}ms\n`);
