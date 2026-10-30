/**
 * Observe tool — browser monitoring (console, network, performance, HAR).
 *
 * Read-only introspection into what the browser is doing.
 * All actions delegate to CDP domains like Log, Network, Performance.
 */

import type { ToolRegistry } from './registry.js';
import type { ServerContext, ToolResult, NetworkRequestEntry, DownloadEntry } from '../types.js';
import { TempFileManager } from '../utils/temp-files.js';
import { createPerfTraceRecording, aggregateTraceInsights } from '../utils/trace-insights.js';
import { isMethodMissingError } from '../connection/capabilities.js';
import { join } from 'path';
import { defineTool } from './base-tool.js';
import { ok, fail } from '../utils/helpers.js';

// ─── Action handlers ────────────────────────────────────────────────

async function handleConsole(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;

  // Runtime.enable is required for Runtime.consoleAPICalled / exceptionThrown
  // events (console.log/error from the page). Log domain adds browser-generated
  // entries (network errors, deprecations) that never pass through console.*.
  await ctx.sendCommand('Runtime.enable', {}, sess).catch(() => {});
  await ctx.sendCommand('Log.enable', {}, sess);

  // Live in-memory store filled by the runtime event pipeline (index.ts)
  const store = ctx.consoleLogs.get(sess) ?? [];
  let logs: Array<Record<string, unknown>> = [...store];

  // Merge browser Log-domain entries (deduped) for completeness
  const browser = (await ctx.sendCommand('Log.getEntries', {}, sess).catch(() => ({ entries: [] }))) as {
    entries?: Array<{ level?: string; text?: string; url?: string; timestamp?: number }>;
  };
  const seen = new Set(store.map((l) => `${l.level}|${l.text}|${l.url}`));
  for (const e of browser.entries ?? []) {
    const key = `${e.level ?? 'info'}|${e.text ?? ''}|${e.url ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    logs.push({
      level: e.level ?? 'info',
      text: e.text ?? '',
      url: e.url ?? '',
      ts: e.timestamp ? new Date(e.timestamp).getTime() : Date.now(),
    });
  }
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

/**
 * B4: enable durable network messages so response bodies survive
 * cross-process navigations. Silent-off when unsupported (pre-Chrome-153).
 */
function ensureNetworkResilience(ctx: ServerContext, sess: string): void {
  ctx.sendCommand('Network.configureDurableMessages', {
    maxTotalBufferSize: 104857600,
    maxResourceBufferSize: 20971520,
  }, sess).catch(() => { /* unsupported - silent */ });
}

async function handleNetwork(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  await ctx.sendCommand('Network.enable', {}, sess);
  ensureNetworkResilience(ctx, sess);

  // Live in-memory store filled by the runtime event pipeline
  // (Network.requestWillBeSent / responseReceived / loadingFinished in index.ts)
  const reqMap = ctx.networkReqs.get(sess);
  let reqs: NetworkRequestEntry[] = reqMap ? [...reqMap.values()] : [];

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
  const lines = reqs.map(r => {
    const status = (r.status as number | string) || 'pending';
    const size = r.size != null ? `${((r.size as number) / 1024).toFixed(1)}KB` : '?';
    return `[${r.id}] ${r.method} ${status} ${size} ${r.type} ${(r.url as string).substring(0, 120)}`;
  });
  const output = reqs.length
    ? `${reqs.length} request(s):\n\n${lines.join('\n')}`
    : 'No network requests captured yet. Navigate or interact to start capturing.';

  // clear:true resets the in-memory store after the listing is built
  if (params.clear) reqMap?.clear();

  return ok(output);
}

async function handleRequest(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  await ctx.sendCommand('Network.enable', {}, sess);
  ensureNetworkResilience(ctx, sess);

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

  // Get response body (B4: large bodies stream to a temp file instead of
  // inlining; unretained bodies retry via Network.streamResourceContent)
  const INLINE_BODY_CAP = 60_000;
  const PREVIEW = 2_000;
  try {
    let body: string | null = null;
    let base64 = false;
    try {
      const resp = (await ctx.sendCommand('Network.getResponseBody', { requestId }, sess)) as Record<string, unknown>;
      body = resp.body as string;
      base64 = !!resp.base64Encoded;
    } catch {
      // Body not retained (e.g. after cross-process navigation) - stream it
      // (works when durable messages are configured)
      try {
        const streamed = (await ctx.sendCommand('Network.streamResourceContent', { requestId }, sess)) as { bufferedData?: string };
        body = streamed.bufferedData ?? null;
        base64 = true;
        if (body !== null) result.bodySource = 'stream';
      } catch (e2: unknown) {
        result.responseBody = `[Not available: ${(e2 as Error).message}]`;
      }
    }
    if (body !== null && body !== undefined) {
      const decoded = base64 ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
      const text = decoded.toString('utf8');
      if (text.length > INLINE_BODY_CAP) {
        const tempDir = ctx.config.tempDir || join(process.cwd(), '.temp');
        const manager = new TempFileManager({
          tempDir,
          maxTempFiles: ctx.config.maxTempFiles,
          maxTempAgeMs: ctx.config.maxTempAgeMs,
        });
        const file = manager.write(`response-${Date.now()}.txt`, decoded, 'binary');
        result.responseBodyFile = file;
        result.responseBodyPreview = text.slice(0, PREVIEW);
        result.responseBodySize = decoded.length;
      } else {
        result.responseBody = text;
      }
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

/** Bounded wait - never rejects; { ok: false } on timeout or error. */
function raceBounded<T>(p: Promise<T>, ms: number): Promise<{ ok: boolean; value?: T }> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false }), ms);
    p.then((v) => { clearTimeout(t); resolve({ ok: true, value: v }); }).catch(() => { clearTimeout(t); resolve({ ok: false }); });
  });
}

/**
 * B5: DOM/memory counters. Memory.getDOMCounters + a forced GC sweep
 * (prepareForLeakDetection) when the browser answers; falls back to the
 * Performance.getMetrics counters (Documents/Nodes/JSEventListeners) when
 * the Memory domain is missing or unresponsive. Every Memory call is
 * bounded so an unresponsive domain degrades in seconds instead of
 * deadlocking the tool call.
 */
async function handleMemory(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  const BOUND_MS = Math.max(1, (params._boundMs as number) || 5_000);
  const skipped: string[] = [];

  try {
    const enable = await raceBounded(ctx.sendCommand('Memory.enable', {}, sess), BOUND_MS);
    if (!enable.ok) skipped.push('Memory.enable (unsupported or timed out)');

    const readMem = async (): Promise<Record<string, number> | null> => {
      const r = await raceBounded(ctx.sendCommand('Memory.getDOMCounters', {}, sess), BOUND_MS);
      if (!r.ok || !r.value) return null;
      const v = r.value as Record<string, unknown>;
      return {
        documents: v.documents as number,
        nodes: v.nodes as number,
        jsEventListeners: v.jsEventListeners as number,
      };
    };

    let counters: Record<string, number> | null = await readMem();
    const result: Record<string, unknown> = {};

    if (counters) {
      result.source = 'Memory.getDOMCounters';
      const sweep = await raceBounded(ctx.sendCommand('Memory.prepareForLeakDetection', {}, sess), BOUND_MS);
      if (!sweep.ok) skipped.push('prepareForLeakDetection (unsupported or timed out)');
      const after = await readMem();
      if (after) {
        result.gc = {
          before: counters,
          after,
          delta: {
            documents: (after.documents ?? 0) - (counters.documents ?? 0),
            nodes: (after.nodes ?? 0) - (counters.nodes ?? 0),
            jsEventListeners: (after.jsEventListeners ?? 0) - (counters.jsEventListeners ?? 0),
          },
        };
        counters = after;
      }
      const leak = await raceBounded(ctx.sendCommand('Memory.getDOMCountersForLeakDetection', {}, sess), BOUND_MS);
      if (leak.ok && leak.value) {
        const cs = (leak.value as { counters?: Array<{ name: string; count: number }> }).counters;
        if (Array.isArray(cs) && cs.length > 0) result.leakDetectors = cs.slice(0, 50);
      } else {
        skipped.push('getDOMCountersForLeakDetection');
      }
    } else {
      // Memory domain unresponsive - fall back to Performance metrics counters
      skipped.push('Memory.getDOMCounters (unsupported or unresponsive)');
      try {
        await ctx.sendCommand('Performance.enable', {}, sess);
      } catch { /* best-effort — getMetrics may still work */ }
      try {
        const perf = (await ctx.sendCommand('Performance.getMetrics', {}, sess)) as Record<string, unknown>;
        const m = (perf.metrics ?? []) as Array<{ name: string; value: number }>;
        const pick = (n: string): number | null => m.find(x => x.name === n)?.value ?? null;
        counters = {
          documents: pick('Documents'),
          nodes: pick('Nodes'),
          jsEventListeners: pick('JSEventListeners'),
        } as Record<string, number>;
        result.source = 'Performance.getMetrics (Memory domain unresponsive - no GC sweep)';
      } catch {
        counters = null;
        skipped.push('Performance.getMetrics fallback');
      }
    }

    if (counters) result.counters = counters;
    if (skipped.length > 0) result.skipped = skipped;
    if (!counters) {
      return fail(`Memory counters unavailable on this browser (Memory and Performance domains both unresponsive). Tried: ${skipped.join('; ')}`);
    }
    return ok(result);
  } catch (err: unknown) {
    if (isMethodMissingError(err)) {
      return fail('Memory domain is not supported on this browser. DOM/memory counters require a Chromium-based browser with the Memory CDP domain.');
    }
    throw err;
  }
}
/**
 * WS10 perf_start: begin a Tracing recording with the probe-PROVEN category
 * set (single 'loading' — captures LCP candidates + LayoutShift with full
 * field shapes on capable builds). Returns immediately; chunks accumulate
 * in ctx.perfTraces via the event pipeline until perf_stop.
 */
async function handlePerfStart(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;

  const existing = ctx.perfTraces.get(sess);
  if (existing) {
    return fail(existing.stopping
      ? `A previous performance recording on this tab is still finishing (started at ${new Date(existing.startedAt).toLocaleTimeString()}). Retry perf_start shortly.`
      : `Performance recording already in progress for this tab (started at ${new Date(existing.startedAt).toLocaleTimeString()}). Call observe perf_stop to finish it first — starting a second trace would discard the first.`);
  }

  // Best-effort URL baseline (bounded — never blocks the start)
  let url: string | null = null;
  const href = await raceBounded(
    ctx.sendCommand('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sess),
    2000,
  );
  if (href.ok) {
    const v = (href.value as { result?: { value?: unknown } })?.result?.value;
    if (typeof v === 'string') url = v;
  }

  await ctx.sendCommand('Tracing.start', {
    traceConfig: {
      recordMode: 'recordAsMuchAsPossible',
      includedCategories: ['loading'],
    },
  }, sess);
  ctx.perfTraces.set(sess, createPerfTraceRecording(Date.now(), url));

  return ok('Performance recording started (category: loading). Navigate or let the page render, then call observe perf_stop on this tab to extract insights (LCP, CLS). Capture quality depends on the page rendering during the recording.');
}

/**
 * WS10 perf_stop: end the recording, wait (bounded) for tracingComplete,
 * aggregate the accumulated chunks into token-capped insights, and discard
 * the raw events. No per-session state survives the stop.
 */
async function handlePerfStop(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  const rec = ctx.perfTraces.get(sess);
  if (!rec) {
    return fail('No performance recording active for this tab. Call observe perf_start first.');
  }
  if (rec.stopping) {
    return fail('A perf_stop is already finishing on this tab. Retry in a moment.');
  }
  rec.stopping = true;

  try {
    await ctx.sendCommand('Tracing.end', {}, sess);
  } catch (err: unknown) {
    // Session died between start and stop — recording is unrecoverable.
    ctx.perfTraces.delete(sess);
    return fail(`Performance recording lost — the session ended before the trace could be stopped (${(err as Error).message}). Restart: observe perf_start.`);
  }

  // Bounded wait for Tracing.tracingComplete from the event pipeline (15s)
  const deadline = Date.now() + 15_000;
  while (!rec.completed && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  ctx.perfTraces.delete(sess);
  const insight = aggregateTraceInsights(rec.events, {
    url: rec.url,
    startedAt: rec.startedAt,
    stoppedAt: Date.now(),
    dataLoss: rec.dataLoss,
    truncated: rec.truncated,
    completed: rec.completed,
  });
  return ok(insight.output);
}

async function handleDownloads(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  await ctx.sendCommand('Page.enable', {}, sess);

  // Downloads are tracked in a per-session list by the runtime layer.
  const dlStore = ctx.downloads.get(sess) ?? [];
  let dl: DownloadEntry[] = [...dlStore];
  const last = params.last as number | undefined;
  if (last) dl = dl.slice(-last);
  if (params.clear) ctx.downloads.delete(sess);

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
): Promise<ToolResult> {  const sess = params._sessionId as string;
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
        '- perf_start: Begin recording page rendering performance via CDP Tracing (LCP candidates + layout shifts). Returns immediately. Call observe perf_stop on the same tab to finish and extract insights. Capture quality depends on the page rendering during the recording (requires: tabId)',
        '- perf_stop: Stop the recording started by perf_start on this tab and aggregate it into token-capped insights: LCP (last candidate per frame) and CLS (final cumulative score, input shifts excluded). If the session died mid-recording, the stop reports the recording as lost (requires: tabId)',
        '- memory: DOM/JS memory counters (documents, nodes, JS event listeners) before/after a forced GC sweep via Memory.prepareForLeakDetection, plus leak-detection counters when supported (requires: tabId)',
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
          action: { type: 'string', enum: ['console', 'network', 'request', 'performance', 'perf_start', 'perf_stop', 'memory', 'downloads', 'har'], description: 'Observe action.' },
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
        required: ['action'],
      },
      handler: async (ctx, params) => {
        const action = params.action as string;
        switch (action) {
          case 'console':     return handleConsole(ctx, params);
          case 'network':     return handleNetwork(ctx, params);
          case 'request':     return handleRequest(ctx, params);
          case 'performance': return handlePerformance(ctx, params);
          case 'perf_start': return handlePerfStart(ctx, params);
          case 'perf_stop':  return handlePerfStop(ctx, params);
          case 'memory':     return handleMemory(ctx, params);
          case 'downloads':  return handleDownloads(ctx, params);
          case 'har':        return handleHar(ctx, params);
          default:            return fail(`Unknown observe action: "${action}". Use: console, network, request, performance, perf_start, perf_stop, memory, downloads, har`);
        }
      },
    }),
  );
}
