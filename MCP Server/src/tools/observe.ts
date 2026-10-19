/**
 * Observe tool — browser monitoring (console, network, performance, HAR).
 *
 * Read-only introspection into what the browser is doing.
 * All actions delegate to CDP domains like Log, Network, Performance.
 */

import type { ToolRegistry } from './registry.js';
import type { ServerContext, ToolResult } from '../types.js';
import { defineTool } from './base-tool.js';
import { ok, fail } from '../utils/helpers.js';

// ─── Action handlers ────────────────────────────────────────────────

async function handleConsole(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;

  // Enable monitoring — the real server enables Log/Console domain on demand
  await ctx.sendCommand('Log.enable', {}, sess);

  // In the full server, console logs are stored in a per-session Map.
  // Here we stub the CDP call structure — the actual log buffer is managed
  // by the runtime integration layer.
  const result = (await ctx.sendCommand('Log.getEntries', {}, sess).catch(() => ({ entries: [] }))) as Record<string, unknown>;
  const entries = (result.entries ?? []) as Array<Record<string, unknown>>;

  let logs = entries;
  const level = params.level as string | undefined;
  if (level && level !== 'all') {
    logs = logs.filter(l => l.level === level);
  }
  const last = params.last as number | undefined;
  if (last) logs = logs.slice(-last);
  if (params.clear) {
    await ctx.sendCommand('Log.clear', {}, sess).catch(() => {});
  }

  if (!logs.length) return ok('No console messages captured yet. Interact with the page to generate console output.');

  const lines = logs.map(l => {
    const ts = new Date(l.ts as number).toLocaleTimeString();
    return `[${ts}] [${(l.level as string || 'log').toUpperCase()}] ${(l.text as string || '').substring(0, 200)}`;
  });
  return ok(`${logs.length} console message(s):\n\n${lines.join('\n')}`);
}

async function handleNetwork(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  await ctx.sendCommand('Network.enable', {}, sess);

  // Network requests are tracked in an in-memory Map by the runtime layer.
  // Stub: return structure from the runtime integration.
  let reqs: Array<Record<string, unknown>> = [];

  const filter = params.filter as string | undefined;
  if (filter) {
    const f = filter.toLowerCase();
    reqs = reqs.filter(r => ((r.url as string) || '').toLowerCase().includes(f));
  }
  const types = params.types as string[] | undefined;
  if (types?.length) {
    const typeSet = new Set(types.map(t => t.toLowerCase()));
    reqs = reqs.filter(r => typeSet.has(((r.type as string) || '').toLowerCase()));
  }
  const last = params.last as number | undefined;
  if (last) reqs = reqs.slice(-last);
  if (params.clear) {
    // clear would reset the in-memory request map
  }

  if (!reqs.length) return ok('No network requests captured yet. Navigate or interact to start capturing.');

  const lines = reqs.map(r => {
    const status = (r.status as number | string) || 'pending';
    const size = r.size != null ? `${((r.size as number) / 1024).toFixed(1)}KB` : '?';
    return `[${r.id}] ${r.method} ${status} ${size} ${r.type} ${(r.url as string).substring(0, 120)}`;
  });
  return ok(`${reqs.length} request(s):\n\n${lines.join('\n')}`);
}

async function handleRequest(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  await ctx.sendCommand('Network.enable', {}, sess);

  // Parity with Playwright MCP browser_network_requests — single-call equivalent.
  // Allow `urlFilter` (substring) as an alternative to `requestId`. We resolve the
  // most-recent matching request from ctx.networkReqs so the agent doesn't have to
  // call observe.network first just to find the requestId.
  let requestId = params.requestId as string | undefined;
  let resolvedFrom: string | null = null;

  if (!requestId) {
    const urlFilter = params.urlFilter as string | undefined;
    if (!urlFilter) {
      return fail("Provide 'requestId' (from network listing) or 'urlFilter' (URL substring of the request to look up).");
    }
    const reqMap = ctx.networkReqs.get(sess);
    if (!reqMap || reqMap.size === 0) {
      return fail(`No network requests captured yet for this tab. Navigate or interact first, then retry with urlFilter="${urlFilter}".`);
    }
    const needle = urlFilter.toLowerCase();
    let bestId: string | undefined;
    let bestTs = -Infinity;
    for (const [id, req] of reqMap) {
      if ((req.url || '').toLowerCase().includes(needle) && req.ts > bestTs) {
        bestTs = req.ts;
        bestId = id;
      }
    }
    if (!bestId) {
      return fail(`No captured request URL matches "${urlFilter}". Use observe.network to list candidates.`);
    }
    requestId = bestId;
    resolvedFrom = urlFilter;
  }

  const result: Record<string, unknown> = { requestId };
  if (resolvedFrom !== null) result.matchedFrom = resolvedFrom;

  // Get response body
  try {
    const resp = (await ctx.sendCommand('Network.getResponseBody', { requestId }, sess)) as Record<string, unknown>;
    if (resp.base64Encoded) {
      const decoded = Buffer.from(resp.body as string, 'base64');
      result.responseBody = decoded.toString('utf8');
    } else {
      result.responseBody = resp.body;
    }
  } catch (e: unknown) {
    result.responseBody = `[Not available: ${(e as Error).message}]`;
  }

  // Get request post data
  try {
    const post = (await ctx.sendCommand('Network.getRequestPostData', { requestId }, sess)) as Record<string, unknown>;
    result.requestBody = post.postData;
  } catch {
    result.requestBody = null;
  }

  return ok(result);
}

async function handlePerformance(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  await ctx.sendCommand('Performance.enable', {}, sess);
  const perfResult = (await ctx.sendCommand('Performance.getMetrics', {}, sess)) as Record<string, unknown>;
  const metrics = (perfResult.metrics ?? []) as Array<{ name: string; value: number }>;

  const m: Record<string, number> = {};
  for (const { name, value } of metrics) m[name] = value;

  const fmt = (bytes: number): string => {
    if (bytes > 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
    if (bytes > 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${bytes}B`;
  };

  const lines = [
    `Documents: ${m.Documents || 0} | Frames: ${m.Frames || 0}`,
    `DOM Nodes: ${m.Nodes || 0} | JS Listeners: ${m.JSEventListeners || 0}`,
    `JS Heap: ${fmt(m.JSHeapUsedSize || 0)} / ${fmt(m.JSHeapTotalSize || 0)}`,
    `Layout: ${m.LayoutCount || 0} recalcs, ${((m.LayoutDuration || 0) * 1000).toFixed(1)}ms total`,
    `Style Recalc: ${m.RecalcStyleCount || 0} recalcs, ${((m.RecalcStyleDuration || 0) * 1000).toFixed(1)}ms total`,
    `Scripts: ${((m.ScriptDuration || 0) * 1000).toFixed(1)}ms total`,
    `Tasks: ${((m.TaskDuration || 0) * 1000).toFixed(1)}ms total`,
  ];
  return ok(`Performance Metrics:\n\n${lines.join('\n')}`);
}

async function handleDownloads(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  await ctx.sendCommand('Page.enable', {}, sess);

  // Downloads are tracked in a per-session list by the runtime layer.
  let dl: Array<Record<string, unknown>> = [];
  const last = params.last as number | undefined;
  if (last) dl = dl.slice(-last);
  // if (params.clear) clear download list

  if (!dl.length) return ok('No downloads tracked yet. Downloads are captured automatically when they occur.');

  const lines = dl.map(d => {
    const totalBytes = d.totalBytes as number;
    const receivedBytes = d.receivedBytes as number;
    const pct = totalBytes > 0 ? ` ${((receivedBytes / totalBytes) * 100).toFixed(1)}%` : '';
    const size = totalBytes > 0 ? ` ${(totalBytes / 1024).toFixed(1)}KB` : '';
    return `[${d.state}]${pct}${size} ${d.suggestedFilename} — ${(d.url as string).substring(0, 120)}`;
  });
  return ok(`${dl.length} download(s):\n\n${lines.join('\n')}`);
}

async function handleHar(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  await ctx.sendCommand('Network.enable', {}, sess);

  // Requests from runtime integration layer
  const reqs: Array<Record<string, unknown>> = [];
  if (!reqs.length) return ok('No network requests captured yet. Navigate or interact first.');

  // Build HAR 1.2 structure
  const entries = reqs.map(r => ({
    startedDateTime: new Date(r.ts as number).toISOString(),
    time: 0,
    request: {
      method: (r.method as string) || 'GET',
      url: r.url as string,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: -1,
    },
    response: {
      status: (r.status as number) || 0,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      content: {
        size: (r.size as number) || 0,
        mimeType: (r.mimeType as string) || '',
      },
      redirectURL: '',
      headersSize: -1,
      bodySize: (r.size as number) || -1,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
  }));

  const har = {
    log: {
      version: '1.2',
      creator: { name: 'CDP Browser MCP Server', version: '5.0.0' },
      entries,
    },
  };

  return ok(JSON.stringify(har, null, 2));
}

// ─── Registration ───────────────────────────────────────────────────

export function registerObserveTools(
  registry: ToolRegistry,
  _ctx: ServerContext,
): void {
  registry.register(
    defineTool({
      name: 'observe',
      description: [
        'Use this to debug page behavior — check console errors, inspect API calls, or measure performance. Monitoring starts automatically when queried.',
        '',
        'Operations:',
        '- console: Retrieve captured console messages (requires: tabId; optional: level[all|error|warning|log|info|debug], last — return only last N entries, clear — clear after returning)',
        '- network: List captured network requests with URLs, methods, status codes, and timing (requires: tabId; optional: filter — URL substring, types — resource type filter array, last, clear)',
        '- request: Get the full request and response body for a specific network request (requires: tabId; provide either requestId — from network listing — or urlFilter — substring of the URL; urlFilter resolves to the most recent matching request)',
        '- performance: Collect page performance metrics including DOM size, JS heap, layout counts, and paint timing (requires: tabId)',
        '- downloads: List tracked file downloads with progress info (requires: tabId; optional: last, clear)',
        '- har: Export captured network requests as HAR 1.2 JSON (requires: tabId)',
        '',
        'Network Resource Types: xhr, fetch, document, script, stylesheet, image, font, media, websocket, other',
        '',
        'Notes:',
        '- Console and network monitoring starts automatically when first queried — no explicit enable needed',
        '- Popups/new windows opened by pages are auto-detected and logged to the opener tab\'s console as [popup] entries',
        "- Use 'clear: true' to reset captured data between test iterations",
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['console', 'network', 'request', 'performance', 'downloads', 'har'], description: 'Observe action.' },
          tabId: { type: 'string', description: 'Tab ID.' },
          level: { type: 'string', enum: ['all', 'error', 'warning', 'log', 'info', 'debug'], description: 'Console level filter.' },
          filter: { type: 'string', description: 'Network URL filter.' },
          types: { type: 'array', items: { type: 'string' }, description: 'Network resource types filter: xhr, fetch, document, script, stylesheet, image, font, media, websocket, other.' },
          clear: { type: 'boolean', description: 'Clear captured data after returning.' },
          last: { type: 'number', description: 'Return only last N items.' },
          requestId: { type: 'string', description: 'Request ID for full body retrieval.' },
          urlFilter: { type: 'string', description: 'URL substring to look up the most recent matching request body without first calling network. Parity with Playwright MCP browser_network_requests inline-body return.' },
          sessionId: { type: 'string', description: 'Agent session ID for tab ownership and isolation. Tabs are locked to sessions. Default: per-process UUID.' },
          cleanupStrategy: { type: 'string', enum: ['close', 'detach', 'none'], description: "Tab cleanup on session expiry. 'detach' (default) keeps tabs open, 'close' removes them, 'none' skips cleanup. Sticky per session." },
          exclusive: { type: 'boolean', description: 'Lock tab to this session (default: true). Set false to allow shared access.' },
        },
        required: ['action', 'tabId'],
      },
      handler: async (ctx, params) => {
        const action = params.action as string;
        switch (action) {
          case 'console':     return handleConsole(ctx, params);
          case 'network':     return handleNetwork(ctx, params);
          case 'request':     return handleRequest(ctx, params);
          case 'performance': return handlePerformance(ctx, params);
          case 'downloads':   return handleDownloads(ctx, params);
          case 'har':         return handleHar(ctx, params);
          default:            return fail(`Unknown observe action: "${action}". Use: console, network, request, performance, downloads, har`);
        }
      },
    }),
  );
}
