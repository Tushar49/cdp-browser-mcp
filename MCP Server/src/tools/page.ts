/**
 * Page-level tool handler.
 *
 * Extracted from the monolith server.js — contains all page-level
 * operations: navigation, snapshots, screenshots, content extraction,
 * wait conditions, PDF export, dialogs, script/CSS injection, and CSP bypass.
 */

import { writeFileSync } from 'fs';
import { join, resolve, normalize } from 'path';
import type { ToolResult, ServerContext } from '../types.js';
import type { ToolRegistry } from './registry.js';
import { defineTool } from './base-tool.js';
import { ok, fail } from '../utils/helpers.js';
import { ActionableError, Errors, wrapError } from '../utils/error-handler.js';
import { sleep, waitForReadyState, waitForText, waitForTextGone, waitForSelector } from '../utils/wait.js';
import type { WaitUntil, SelectorState } from '../utils/wait.js';
import { TempFileManager } from '../utils/temp-files.js';
import type { AXNode } from '../snapshot/accessibility.js';
import { isSlimMode, defaultSnapshotMaxLength } from './slim-mode.js';

// ─── Path Security ──────────────────────────────────────────────────

const BLOCKED_PREFIXES = [
  normalize('C:\\Windows'),
  normalize('C:\\Program Files'),
  normalize('C:\\Program Files (x86)'),
  normalize('/etc'),
  normalize('/usr'),
  normalize('/bin'),
  normalize('/sbin'),
];

/** Validate output path is not a protected system directory. */
function validateOutputPath(userPath: string): string {
  const resolved = resolve(userPath);
  const normalized = normalize(resolved);

  for (const blocked of BLOCKED_PREFIXES) {
    if (normalized.toLowerCase().startsWith(blocked.toLowerCase())) {
      throw new ActionableError(
        `Cannot write to protected path: ${normalized}`,
        'Choose a different output path. Suggested: use a path in your project or downloads folder.',
      );
    }
  }

  return normalized;
}

// ─── Arg Interfaces ─────────────────────────────────────────────────

interface PageArgs {
  action: string;
  tabId: string;
  // Navigation
  url?: string;
  waitUntil?: WaitUntil;
  ignoreCache?: boolean;
  // Screenshot
  fullPage?: boolean;
  quality?: number;
  type?: 'png' | 'jpeg';
  path?: string;
  uid?: number;
  // Content
  selector?: string;
  format?: 'text' | 'html' | 'full';
  // Wait
  text?: string;
  textGone?: string;
  timeout?: number;
  state?: SelectorState;
  // Dialog
  accept?: boolean;
  // PDF
  landscape?: boolean;
  scale?: number;
  paperWidth?: number;
  paperHeight?: number;
  margin?: { top?: number; bottom?: number; left?: number; right?: number };
  // Snapshot filtering
  interactive?: boolean;
  search?: string;
  maxLength?: number;
  // set_content
  html?: string;
  // add_style
  css?: string;
  cssUrl?: string;
  persistent?: boolean;
  // inject
  script?: string;
  // bypass_csp
  enabled?: boolean;
  // Snapshot diff
  diff?: boolean;
  // Session params
  sessionId?: string;
  cleanupStrategy?: string;
  exclusive?: boolean;
}

// ─── Action Handlers ────────────────────────────────────────────────

async function handleGoto(ctx: ServerContext, args: PageArgs): Promise<ToolResult> {
  if (!args.url) return fail("Provide 'url' for navigation.");
  const sess = await getTabSession(ctx, args.tabId);
  await ensureDomain(ctx, sess, 'Page');

  // P1-2: Clear ElementResolver on navigation — backendNodeIds are invalidated
  ctx.elementResolvers.get(args.tabId)?.onNavigation();

  const result = await ctx.sendCommand('Page.navigate', { url: args.url }, sess) as Record<string, unknown>;
  if (result.errorText) return fail(`Navigation failed: ${result.errorText}`);

  // Invalidate snapshot cache on navigation
  if (ctx.snapshotCache) {
    ctx.snapshotCache.invalidate(args.tabId);
  }

  const waitUntil = args.waitUntil || 'load';
  const navTimeout = args.timeout || ctx.config.navigationTimeout;

  if (waitUntil === 'commit') {
    const title = await evalTitle(ctx, sess);
    return ok(`Navigated to: ${args.url}\nTitle: ${title}`);
  }

  await waitForReadyState(
    cdpSendAdapter(ctx, sess),
    sess,
    waitUntil,
    navTimeout,
  );
  const title = await evalTitle(ctx, sess);
  return ok(`Navigated to: ${args.url}\nTitle: ${title}`);
}

async function handleBack(ctx: ServerContext, args: PageArgs): Promise<ToolResult> {
  const sess = await getTabSession(ctx, args.tabId);
  ctx.elementResolvers.get(args.tabId)?.onNavigation();
  const history = await ctx.sendCommand('Page.getNavigationHistory', {}, sess) as {
    currentIndex: number;
    entries: Array<{ id: number }>;
  };
  if (history.currentIndex > 0) {
    await ctx.sendCommand(
      'Page.navigateToHistoryEntry',
      { entryId: history.entries[history.currentIndex - 1].id },
      sess,
    );
    const waitUntil = args.waitUntil || 'load';
    const navTimeout = args.timeout || ctx.config.navigationTimeout;
    if (waitUntil !== 'commit') {
      await waitForReadyState(cdpSendAdapter(ctx, sess), sess, waitUntil, navTimeout);
    } else {
      await sleep(300);
    }
    const info = await evalTitleAndUrl(ctx, sess);
    return ok(`Navigated back → ${info}`);
  }
  return ok('Already at the beginning of history.');
}

async function handleForward(ctx: ServerContext, args: PageArgs): Promise<ToolResult> {
  const sess = await getTabSession(ctx, args.tabId);
  ctx.elementResolvers.get(args.tabId)?.onNavigation();
  const history = await ctx.sendCommand('Page.getNavigationHistory', {}, sess) as {
    currentIndex: number;
    entries: Array<{ id: number }>;
  };
  if (history.currentIndex < history.entries.length - 1) {
    await ctx.sendCommand(
      'Page.navigateToHistoryEntry',
      { entryId: history.entries[history.currentIndex + 1].id },
      sess,
    );
    const waitUntil = args.waitUntil || 'load';
    const navTimeout = args.timeout || ctx.config.navigationTimeout;
    if (waitUntil !== 'commit') {
      await waitForReadyState(cdpSendAdapter(ctx, sess), sess, waitUntil, navTimeout);
    } else {
      await sleep(300);
    }
    const info = await evalTitleAndUrl(ctx, sess);
    return ok(`Navigated forward → ${info}`);
  }
  return ok('Already at the end of history.');
}

async function handleReload(ctx: ServerContext, args: PageArgs): Promise<ToolResult> {
  const sess = await getTabSession(ctx, args.tabId);
  ctx.elementResolvers.get(args.tabId)?.onNavigation();
  await ctx.sendCommand('Page.reload', { ignoreCache: args.ignoreCache || false }, sess);
  const waitUntil = args.waitUntil || 'load';
  const navTimeout = args.timeout || ctx.config.navigationTimeout;
  if (waitUntil !== 'commit') {
    await waitForReadyState(cdpSendAdapter(ctx, sess), sess, waitUntil, navTimeout);
  } else {
    await sleep(300);
  }
  return ok('Page reloaded.');
}

async function handleFrames(ctx: ServerContext, args: PageArgs): Promise<ToolResult> {
  const sess = await getTabSession(ctx, args.tabId);
  const frames: Array<{
    index: number;
    id: string;
    url: string;
    securityOrigin: string;
    type: string;
    depth: number;
    sessionId?: string;
  }> = [];

  // Same-origin frames from Page.getFrameTree
  try {
    await ensureDomain(ctx, sess, 'Page');
    const { frameTree } = await ctx.sendCommand('Page.getFrameTree', {}, sess) as {
      frameTree: {
        frame: { id: string; url: string; securityOrigin?: string };
        childFrames?: Array<unknown>;
      };
    };
    let idx = 0;
    function collectFrames(tree: any, depth: number): void {
      frames.push({
        index: idx++,
        id: tree.frame.id,
        url: tree.frame.url,
        securityOrigin: tree.frame.securityOrigin || '',
        type: depth === 0 ? 'main' : 'same-origin',
        depth,
      });
      if (tree.childFrames) {
        for (const child of tree.childFrames) collectFrames(child, depth + 1);
      }
    }
    collectFrames(frameTree, 0);
  } catch {
    // Frame tree unavailable
  }

  // OOP (cross-origin) frames from auto-attached child sessions
  const childSessions = ctx.tabSessions.getChildSessions(sess);
  if (childSessions.size > 0) {
    let idx = frames.length;
    for (const [targetId, { sessionId: childSess, url: frameUrl }] of childSessions) {
      frames.push({
        index: idx++,
        id: targetId,
        url: frameUrl,
        securityOrigin: '',
        type: 'cross-origin',
        depth: 1,
        sessionId: childSess,
      });
    }
  }

  if (frames.length === 0) return ok('No frames found.');
  const lines = frames.map(
    f => `[frame ${f.index}] ${f.type} | ${f.url.substring(0, 120)}`,
  );
  return ok(`${frames.length} frame(s):\n\n${lines.join('\n')}`);
}

async function handleSnapshot(ctx: ServerContext, args: PageArgs): Promise<ToolResult> {
  const sess = await getTabSession(ctx, args.tabId);

  const { captureAccessibilityTree, captureFullTree, serializeTree } = await import('../snapshot/accessibility.js');
  const { TokenOptimizer } = await import('../snapshot/token-optimizer.js');
  const { ElementResolver } = await import('../snapshot/element-resolver.js');

  // P1-2: Use per-tab ElementResolver for stable uid refs across snapshots
  let resolver = ctx.elementResolvers.get(args.tabId);
  if (!resolver) {
    resolver = new ElementResolver();
    ctx.elementResolvers.set(args.tabId, resolver);
  }

  // Build a cdpSend that routes __sessionId-tagged calls to the right child session
  const cdpSend = (method: string, params?: Record<string, unknown>) => {
    const childSessId = params?.__sessionId as string | undefined;
    if (childSessId) {
      const { __sessionId: _, ...rest } = params!;
      return ctx.sendCommand(method, rest, childSessId) as Promise<any>;
    }
    return ctx.sendCommand(method, params, sess) as Promise<any>;
  };

  // Capture OOP (cross-origin) iframe child sessions
  const childSessions = ctx.tabSessions.getChildSessions(sess);

  let snapshot: string;
  let nodeCount: number;
  let allOptimized: AXNode[];

  if (childSessions.size > 0) {
    // Multi-frame capture: main + OOP iframes
    const fullTree = await captureFullTree(cdpSend as any, sess, childSessions);

    const optimizedMain = TokenOptimizer.optimize(fullTree.mainNodes);
    resolver.assignRefs(optimizedMain);
    const mainSnapshot = serializeTree(optimizedMain);

    const slim = isSlimMode();
    const frameParts: string[] = [];
    const frameOptimized: AXNode[] = [];
    let frameIndex = 1;
    for (const [, { nodes }] of fullTree.frameNodes) {
      const optimizedFrame = TokenOptimizer.optimize(nodes);
      resolver.assignRefs(optimizedFrame);
      // Slim mode shortens "[frame N] " (10 chars) → "[fN] " (5 chars).
      const framePrefix = slim ? `[f${frameIndex}] ` : `[frame ${frameIndex}] `;
      frameParts.push(serializeTree(optimizedFrame, 0, framePrefix));
      frameOptimized.push(...optimizedFrame);
      frameIndex++;
    }

    // Store uid → session routing for cross-frame element interaction
    ctx.tabSessions.setRefRouting(sess, fullTree.refRouting);

    const allParts = [mainSnapshot, ...frameParts].filter(Boolean);
    snapshot = allParts.join('\n');
    allOptimized = [...optimizedMain, ...frameOptimized];
    nodeCount = countNodes(allOptimized);
  } else {
    // Single-frame capture (common case)
    const tree = await captureAccessibilityTree(cdpSend as any, sess);
    const optimized = TokenOptimizer.optimize(tree);
    resolver.assignRefs(optimized);
    snapshot = serializeTree(optimized);
    allOptimized = optimized;
    nodeCount = countNodes(optimized);
  }

  // Get page title and URL
  let title = '';
  let currentUrl = '';
  try {
    title = await evalTitle(ctx, sess);
    currentUrl = await evalExpression(ctx, sess, 'location.href');
  } catch {
    // Page may be transitioning
  }

  // Diff mode: return only changes since last snapshot
  if (args.diff && ctx.snapshotCache) {
    const diffResult = ctx.snapshotCache.diff(args.tabId, snapshot);
    // Store updated snapshot in cache after diffing
    ctx.snapshotCache.set(args.tabId, snapshot, allOptimized, currentUrl);
    if (diffResult.changed) {
      return ok(`### Snapshot Changes (${diffResult.added} added, ${diffResult.removed} removed)\n${diffResult.lines.join('\n')}`);
    } else {
      return ok('No visible changes since last snapshot.');
    }
  }

  // Store in cache
  if (ctx.snapshotCache && args.tabId) {
    ctx.snapshotCache.set(args.tabId, snapshot, allOptimized, currentUrl);
  }

  // Post-processing: interactive-only filter
  if (args.interactive) {
    const interactiveNodes = TokenOptimizer.interactiveOnly(allOptimized);
    const { serializeTree: serialize } = await import('../snapshot/accessibility.js');
    snapshot = serialize(interactiveNodes);
    nodeCount = countNodes(interactiveNodes);
  }

  // Post-processing: search filter
  if (args.search) {
    const searchNodes = TokenOptimizer.search(allOptimized, args.search);
    const { serializeTree: serialize } = await import('../snapshot/accessibility.js');
    snapshot = serialize(searchNodes);
    nodeCount = countNodes(searchNodes);
  }

  const slim = isSlimMode();
  // Slim header trims "Page: ...\nURL: ...\nElements: N\n\n" (80–250 chars)
  // down to "[N elems] title\n\n" (~30 chars).
  const header = slim
    ? `[${nodeCount} elems] ${title}\n\n`
    : `Page: ${title}\nURL: ${currentUrl}\nElements: ${nodeCount}\n\n`;
  const fullOutput = header + snapshot;

  // Post-processing: cap output length. Slim mode defaults to a 4 000-char
  // cap (vs 20 000 in full mode) and uses a shorter truncation footer.
  const maxLen = args.maxLength ?? defaultSnapshotMaxLength();
  return ok(TokenOptimizer.capLength(fullOutput, maxLen, slim));
}

async function handleScreenshot(ctx: ServerContext, args: PageArgs): Promise<ToolResult> {
  const sess = await getTabSession(ctx, args.tabId);
  const params: Record<string, unknown> = {};

  // Format: explicit type > quality implies jpeg > default png
  if (args.quality !== undefined) {
    params.format = 'jpeg';
    params.quality = args.quality;
  } else if (args.type === 'jpeg') {
    params.format = 'jpeg';
    params.quality = 80;
  } else {
    params.format = args.type || 'png';
  }

  // Element-level screenshot via uid
  if (args.uid !== undefined) {
    const resolver = ctx.elementResolvers.get(args.tabId);
    const backendNodeId = resolver?.resolve(args.uid);
    if (!backendNodeId) {
      return fail(`Element uid=${args.uid} not found. Take a snapshot first.`);
    }

    try {
      const { model } = await ctx.sendCommand('DOM.getBoxModel', { backendNodeId }, sess) as {
        model?: { content: number[] };
      };
      if (model?.content) {
        const q = model.content;
        // content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
        const x = Math.min(q[0], q[2], q[4], q[6]);
        const y = Math.min(q[1], q[3], q[5], q[7]);
        const maxX = Math.max(q[0], q[2], q[4], q[6]);
        const maxY = Math.max(q[1], q[3], q[5], q[7]);
        params.clip = { x, y, width: maxX - x, height: maxY - y, scale: 1 };
      }
    } catch {
      return fail(`Could not get layout for element uid=${args.uid}. It may be hidden or off-screen.`);
    }

    const { data } = await ctx.sendCommand('Page.captureScreenshot', params, sess) as { data: string };
    return saveOrReturnScreenshot(data, params.format as string, args.path);
  }

  if (args.fullPage) {
    // Full-page screenshot: resize viewport to full content, capture, restore
    await ensureDomain(ctx, sess, 'Page');
    const m = await ctx.sendCommand('Page.getLayoutMetrics', {}, sess) as Record<string, any>;
    let { width, height } = m.cssContentSize || m.contentSize;
    const viewport = m.cssVisualViewport || m.visualViewport || {};
    const maxDim = 16384; // Chrome's max GPU texture dimension

    if (height > maxDim) height = maxDim;

    // Resize viewport to full content
    await ctx.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: Math.ceil(width),
      height: Math.ceil(height),
      deviceScaleFactor: viewport.scale || 1,
      mobile: false,
    }, sess);
    await sleep(400);

    params.clip = { x: 0, y: 0, width, height, scale: 1 };
    params.captureBeyondViewport = true;

    let captureData: string;
    try {
      const result = await ctx.sendCommand('Page.captureScreenshot', params, sess) as { data: string };
      captureData = result.data;
    } finally {
      // Restore original viewport
      await ctx.sendCommand('Emulation.clearDeviceMetricsOverride', {}, sess).catch(() => {});
      await sleep(100);
    }

    return saveOrReturnScreenshot(captureData, params.format as string, args.path);
  }

  // Viewport screenshot
  const { data } = await ctx.sendCommand('Page.captureScreenshot', params, sess) as { data: string };
  return saveOrReturnScreenshot(data, params.format as string, args.path);
}

async function handleContent(ctx: ServerContext, args: PageArgs): Promise<ToolResult> {
  const sess = await getTabSession(ctx, args.tabId);

  // format: "full" returns complete document HTML with doctype
  if (args.format === 'full') {
    if (args.uid !== undefined || args.selector) {
      return fail("format: 'full' returns the entire document — uid/selector not supported. Use format: 'html' for element HTML.");
    }
    const result = await ctx.sendCommand('Runtime.evaluate', {
      expression: `(document.doctype ? new XMLSerializer().serializeToString(document.doctype) + '\\n' : '') + document.documentElement.outerHTML`,
      returnByValue: true,
    }, sess) as { result: { value: string } };
    return ok(result.result.value ?? '(empty)');
  }

  const prop = args.format === 'html' ? 'innerHTML' : 'innerText';

  if (args.uid !== undefined || args.selector) {
    if (args.uid !== undefined) {
      // Resolve uid via ElementResolver
      const resolver = ctx.elementResolvers.get(args.tabId);
      const backendNodeId = resolver?.resolve(args.uid);
      if (!backendNodeId) {
        return fail(`Element uid=${args.uid} not found. Take a snapshot first.`);
      }
      const { object } = await ctx.sendCommand('DOM.resolveNode', {
        backendNodeId,
      }, sess) as { object: { objectId?: string } };
      if (!object?.objectId) {
        return fail(`Element uid=${args.uid} is stale — take a new snapshot.`);
      }
      const result = await ctx.sendCommand('Runtime.callFunctionOn', {
        functionDeclaration: `function() { return this.${prop}; }`,
        objectId: object.objectId,
        returnByValue: true,
      }, sess) as { result: { value: string } };
      return ok(result.result.value ?? '(empty)');
    }
    if (args.selector) {
      const result = await ctx.sendCommand('Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(args.selector)})?.${prop} ?? '(not found)'`,
        returnByValue: true,
      }, sess) as { result: { value: string } };
      return ok(result.result.value ?? '(empty)');
    }
  }

  // Default: body
  const result = await ctx.sendCommand('Runtime.evaluate', {
    expression: `document.body.${prop}`,
    returnByValue: true,
  }, sess) as { result: { value: string } };
  return ok(result.result.value ?? '(empty)');
}

async function handleSetContent(ctx: ServerContext, args: PageArgs): Promise<ToolResult> {
  if (!args.html) return fail("Provide 'html' content.");
  const sess = await getTabSession(ctx, args.tabId);
  await ensureDomain(ctx, sess, 'Page');

  // Get the root frame ID
  const { frameTree } = await ctx.sendCommand('Page.getFrameTree', {}, sess) as {
    frameTree: { frame: { id: string } };
  };
  const frameId = frameTree.frame.id;

  await ctx.sendCommand('Page.setDocumentContent', { frameId, html: args.html }, sess);
  await sleep(200);

  return ok(`Page content set (${args.html.length} chars).`);
}

async function handleWait(ctx: ServerContext, args: PageArgs): Promise<ToolResult> {
  // Fixed delay: just timeout with no condition
  if (args.timeout && !args.selector && !args.text && !args.textGone) {
    const timeMs = Math.min(args.timeout, 60000);
    await sleep(timeMs);
    return ok(`Waited ${timeMs}ms.${args.timeout > 60000 ? ` (capped from ${args.timeout}ms)` : ''}`);
  }

  if (!args.selector && !args.text && !args.textGone) {
    return fail("Provide 'text', 'textGone', or 'selector' for conditional wait — or just 'timeout' for a fixed delay.");
  }

  const sess = await getTabSession(ctx, args.tabId);
  const timeout = args.timeout || ctx.config.actionTimeout;
  const cdpSend = cdpSendAdapter(ctx, sess);

  if (args.textGone) {
    const found = await waitForTextGone(cdpSend, sess, args.textGone, timeout);
    if (found) return ok(`"${args.textGone}" disappeared`);
    return fail(`Timed out (${timeout}ms) waiting for "${args.textGone}" to disappear`);
  }

  if (args.text) {
    const found = await waitForText(cdpSend, sess, args.text, timeout);
    if (found) return ok(`"${args.text}" appeared`);
    return fail(`Timed out (${timeout}ms) waiting for "${args.text}"`);
  }

  // Selector wait
  const state = (args.state || 'attached') as SelectorState;
  const found = await waitForSelector(cdpSend, sess, args.selector!, state, timeout);
  if (found) return ok(`${args.selector} ${state}`);
  return fail(`Timed out (${timeout}ms) waiting for ${args.selector} [state: ${state}]`);
}

async function handlePdf(ctx: ServerContext, args: PageArgs): Promise<ToolResult> {
  const sess = await getTabSession(ctx, args.tabId);
  await ensureDomain(ctx, sess, 'Page');

  const pdfParams = {
    printBackground: true,
    landscape: args.landscape || false,
    scale: args.scale || 1,
    paperWidth: args.paperWidth || 8.5,
    paperHeight: args.paperHeight || 11,
    marginTop: args.margin?.top ?? 0.4,
    marginBottom: args.margin?.bottom ?? 0.4,
    marginLeft: args.margin?.left ?? 0.4,
    marginRight: args.margin?.right ?? 0.4,
  };

  const { data } = await ctx.sendCommand('Page.printToPDF', pdfParams, sess) as { data: string };
  const pdfBuffer = Buffer.from(data, 'base64');

  // Save PDF to disk
  if (args.path) {
    const safePath = validateOutputPath(args.path);
    writeFileSync(safePath, pdfBuffer);
    return ok(`PDF saved to: ${safePath} (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);
  }

  // Use TempFileManager if tempDir is configured
  const tempDir = ctx.config.tempDir || join(process.cwd(), '.temp');
  const tempManager = new TempFileManager({
    tempDir,
    maxTempFiles: ctx.config.maxTempFiles,
    maxTempAgeMs: ctx.config.maxTempAgeMs,
  });
  const fileName = `page-${Date.now()}.pdf`;
  const filePath = tempManager.write(fileName, pdfBuffer, 'binary' as BufferEncoding);
  return ok(`PDF saved to: ${filePath} (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);
}

async function handleDialog(ctx: ServerContext, args: PageArgs): Promise<ToolResult> {
  const sess = await getTabSession(ctx, args.tabId);

  // TODO: Wire pendingDialogs state when session management is integrated
  const accept = args.accept !== undefined ? args.accept : true;
  const dialogParams: Record<string, unknown> = { accept };
  if (args.text !== undefined) dialogParams.promptText = args.text;

  await ctx.sendCommand('Page.handleJavaScriptDialog', dialogParams, sess);

  return ok(`Dialog handled. Action: ${accept ? 'accepted' : 'dismissed'}${args.text ? ` with text: "${args.text}"` : ''}`);
}

async function handleInject(ctx: ServerContext, args: PageArgs): Promise<ToolResult> {
  if (!args.script) return fail("Provide 'script' to inject.");
  const sess = await getTabSession(ctx, args.tabId);
  await ensureDomain(ctx, sess, 'Page');

  const { identifier } = await ctx.sendCommand(
    'Page.addScriptToEvaluateOnNewDocument',
    { source: args.script },
    sess,
  ) as { identifier: string };

  return ok(
    `Script injected (id: ${identifier}). Will run on every new document load.\nPreview: ${args.script.substring(0, 120)}`,
  );
}

async function handleBypassCsp(ctx: ServerContext, args: PageArgs): Promise<ToolResult> {
  const sess = await getTabSession(ctx, args.tabId);
  await ensureDomain(ctx, sess, 'Page');
  const enabled = args.enabled !== undefined ? args.enabled : true;
  await ctx.sendCommand('Page.setBypassCSP', { enabled }, sess);
  return ok(`Content Security Policy bypass: ${enabled ? 'enabled' : 'disabled'}`);
}

async function handleAddStyle(ctx: ServerContext, args: PageArgs): Promise<ToolResult> {
  if (!args.css && !args.cssUrl) {
    return fail("Provide 'css' (inline content) or 'cssUrl' (external stylesheet URL).");
  }
  const sess = await getTabSession(ctx, args.tabId);

  if (args.persistent) {
    await ensureDomain(ctx, sess, 'Page');
    const code = args.css
      ? `(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(args.css)}; const insert = () => (document.head || document.documentElement).appendChild(s); if (document.head) insert(); else document.addEventListener('DOMContentLoaded', insert); })()`
      : `(() => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = ${JSON.stringify(args.cssUrl)}; const insert = () => (document.head || document.documentElement).appendChild(l); if (document.head) insert(); else document.addEventListener('DOMContentLoaded', insert); })()`;

    const { identifier } = await ctx.sendCommand(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: code },
      sess,
    ) as { identifier: string };

    // Also execute immediately on current page
    await ctx.sendCommand('Runtime.evaluate', { expression: code }, sess);

    return ok(`Style injected (persistent, id: ${identifier}).`);
  }

  // Non-persistent — inject into current page only
  const code = args.css
    ? `(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(args.css)}; document.head.appendChild(s); return { ok: true }; })()`
    : `(() => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = ${JSON.stringify(args.cssUrl)}; document.head.appendChild(l); return { ok: true }; })()`;

  const result = await ctx.sendCommand('Runtime.evaluate', {
    expression: code,
    returnByValue: true,
  }, sess) as Record<string, any>;

  if (result.exceptionDetails) {
    return fail('Failed to inject style: ' + (result.exceptionDetails.exception?.description || 'unknown error'));
  }

  return ok(`Style injected${args.css ? ` (${args.css.length} chars)` : ` (${args.cssUrl})`}.`);
}

// ─── Internal Helpers ───────────────────────────────────────────────

/**
 * Get or create a CDP session for a tab via the shared TabSessionService.
 */
async function getTabSession(ctx: ServerContext, tabId: string): Promise<string> {
  return ctx.tabSessions.getSession(ctx.cdpClient, tabId);
}

/** Enable a CDP domain if not already enabled. */
async function ensureDomain(ctx: ServerContext, sess: string, domain: string): Promise<void> {
  await ctx.sendCommand(`${domain}.enable`, {}, sess).catch(() => {});
}

/** Evaluate document.title in the tab session. */
async function evalTitle(ctx: ServerContext, sess: string): Promise<string> {
  const result = await ctx.sendCommand('Runtime.evaluate', {
    expression: 'document.title',
    returnByValue: true,
  }, sess) as { result: { value: string } };
  return result.result.value ?? '';
}

/** Evaluate document.title + location.href. */
async function evalTitleAndUrl(ctx: ServerContext, sess: string): Promise<string> {
  const result = await ctx.sendCommand('Runtime.evaluate', {
    expression: "document.title + ' — ' + location.href",
    returnByValue: true,
  }, sess) as { result: { value: string } };
  return result.result.value ?? '';
}

/** Evaluate an arbitrary expression and return its string value. */
async function evalExpression(ctx: ServerContext, sess: string, expr: string): Promise<string> {
  const result = await ctx.sendCommand('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
  }, sess) as { result: { value: string } };
  return result.result.value ?? '';
}

/** Adapter to convert ctx.sendCommand into the CdpSend signature expected by wait utilities. */
function cdpSendAdapter(
  ctx: ServerContext,
  _defaultSession: string,
): (method: string, params?: Record<string, unknown>, sessionId?: string, timeout?: number) => Promise<Record<string, unknown>> {
  return (method, params, sessionId, _timeout) =>
    ctx.sendCommand(method, params, sessionId) as Promise<Record<string, unknown>>;
}

/** Save screenshot to disk or return as base64 image. */
function saveOrReturnScreenshot(
  data: string,
  format: string,
  savePath?: string,
): ToolResult {
  if (savePath) {
    const safePath = validateOutputPath(savePath);
    const buf = Buffer.from(data, 'base64');
    writeFileSync(safePath, buf);
    return ok(`Screenshot saved to: ${safePath} (${(buf.length / 1024).toFixed(1)} KB)`);
  }
  return {
    content: [{
      type: 'image',
      data,
      mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
    }],
  };
}

/** Count total nodes in an AX tree. */
function countNodes(nodes: Array<{ children?: Array<unknown> }>): number {
  let count = 0;
  for (const node of nodes) {
    count++;
    if (node.children) count += countNodes(node.children as Array<{ children?: Array<unknown> }>);
  }
  return count;
}

// ─── Action Dispatch Map ────────────────────────────────────────────

const PAGE_ACTIONS: Record<string, (ctx: ServerContext, args: PageArgs) => Promise<ToolResult>> = {
  goto: handleGoto,
  back: handleBack,
  forward: handleForward,
  reload: handleReload,
  snapshot: handleSnapshot,
  screenshot: handleScreenshot,
  content: handleContent,
  set_content: handleSetContent,
  wait: handleWait,
  pdf: handlePdf,
  dialog: handleDialog,
  inject: handleInject,
  add_style: handleAddStyle,
  bypass_csp: handleBypassCsp,
  frames: handleFrames,
};

// ─── Tool Registration ──────────────────────────────────────────────

const PAGE_DESCRIPTION = [
  'Page operations. Take a snapshot before interacting — it gives you uid refs for elements.',
  '',
  'For slow pages (D365, SharePoint), the default 60s timeout should work. Use timeout parameter for even slower pages.',
  '',
  'The snapshot is optimized for LLM consumption — decorative elements are filtered out.',
  '',
  'Operations:',
  '- goto: Navigate to a URL and wait for page load (requires: tabId, url; optional: waitUntil[load|domcontentloaded|networkidle|commit], timeout)',
  '- back: Navigate back in browser history (requires: tabId; optional: waitUntil, timeout)',
  '- forward: Navigate forward in browser history (requires: tabId; optional: waitUntil, timeout)',
  '- reload: Reload the current page (requires: tabId; optional: ignoreCache, waitUntil, timeout)',
  '- snapshot: Capture accessibility tree snapshot with element refs for interaction (requires: tabId; optional: diff — return only changes since last snapshot, interactive — only interactive elements, search — filter by text, maxLength — cap output chars)',
  '- screenshot: Take a screenshot of the page or a specific element (requires: tabId; optional: fullPage, quality, uid, type[png|jpeg], path — absolute file path to save to disk)',
  "- content: Extract text or HTML content from the page or an element (requires: tabId; optional: uid, selector, format[text|html|full] — 'full' returns complete document HTML with doctype)",
  "- set_content: Set the page's HTML content directly (requires: tabId, html)",
  "- wait: Wait for condition or fixed delay (requires: tabId; provide text, textGone, selector for polling — or just timeout for fixed delay; optional: timeout[ms], state[visible|hidden|attached|detached] for selector waits)",
  '- pdf: Export page as PDF to temp file (requires: tabId; optional: landscape, scale, paperWidth, paperHeight, margin{top,bottom,left,right})',
  '- dialog: Handle a pending JavaScript dialog (alert/confirm/prompt) (requires: tabId; optional: accept[default:true], text for prompt response)',
  '- inject: Inject a script that runs on every new document load (requires: tabId, script)',
  '- add_style: Inject CSS into the page — either inline content or an external stylesheet URL (requires: tabId, css or cssUrl; optional: persistent — survives navigation)',
  '- bypass_csp: Enable/disable Content Security Policy bypass (requires: tabId; optional: enabled[default:true])',
  '',
  'Notes:',
  '- Always take a snapshot before interacting with elements — it provides uid refs needed by interact tools',
  '- The snapshot returns an accessibility tree with roles, names, and properties matching ARIA semantics',
  '- Wait actions poll every 300ms up to the timeout (default: CDP_ACTION_TIMEOUT)',
  "- All timeouts are in MILLISECONDS (e.g. timeout: 3000 = 3 seconds). Use timeout alone for a fixed delay (like Playwright's waitForTimeout).",
  "- Screenshots: pass 'path' (absolute file path) to save to disk instead of inline base64. Use 'type' to control format (png default, jpeg for smaller size).",
].join('\n');

const PAGE_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    action: {
      type: 'string' as const,
      enum: ['goto', 'back', 'forward', 'reload', 'snapshot', 'screenshot', 'content', 'set_content', 'wait', 'pdf', 'dialog', 'inject', 'add_style', 'bypass_csp', 'frames'] as const,
      description: 'Page action.',
    },
    tabId: { type: 'string' as const, description: 'Tab ID.' },
    url: { type: 'string' as const, description: 'URL for goto.' },
    waitUntil: {
      type: 'string' as const,
      enum: ['load', 'domcontentloaded', 'networkidle', 'commit'] as const,
      description: "When to consider navigation complete (default: load). Matches Playwright conventions.",
    },
    ignoreCache: { type: 'boolean' as const, description: 'Ignore cache on reload.' },
    fullPage: { type: 'boolean' as const, description: 'Full-page screenshot.' },
    quality: { type: 'number' as const, description: 'JPEG quality 0-100 (automatically sets format to jpeg).' },
    type: {
      type: 'string' as const,
      enum: ['png', 'jpeg'] as const,
      description: "Image format (default: png). Use jpeg for smaller file size.",
    },
    path: {
      type: 'string' as const,
      description: "Absolute file path to save screenshot to disk (e.g. 'C:/screenshots/step1.png'). Returns file path instead of base64 image.",
    },
    uid: { type: 'number' as const, description: 'Element uid for screenshot/content.' },
    diff: { type: 'boolean' as const, description: 'If true, return only changes since last snapshot on this tab.' },
    interactive: { type: 'boolean' as const, description: 'If true, return only interactive elements (buttons, inputs, links, dropdowns). Reduces snapshot size for small-context models.' },
    search: { type: 'string' as const, description: 'Filter snapshot to elements whose name, value, or description matches this text (case-insensitive).' },
    maxLength: { type: 'number' as const, description: 'Maximum characters in snapshot output (default: 20000). Use lower values (e.g. 8000) for small-context models.' },
    selector: { type: 'string' as const, description: 'CSS selector for content/wait.' },
    format: {
      type: 'string' as const,
      enum: ['text', 'html', 'full'] as const,
      description: "Content format. 'text' (default) for visible text, 'html' for innerHTML, 'full' for complete document HTML with doctype.",
    },
    text: { type: 'string' as const, description: 'Text to wait for / dialog prompt text.' },
    textGone: { type: 'string' as const, description: 'Text to wait to disappear.' },
    timeout: {
      type: 'number' as const,
      description: "Timeout in milliseconds. With text/textGone/selector: max polling time (default: CDP_ACTION_TIMEOUT). Alone: fixed delay like Playwright's waitForTimeout. Max: 60000ms.",
    },
    state: {
      type: 'string' as const,
      enum: ['visible', 'hidden', 'attached', 'detached'] as const,
      description: "Element state to wait for when using selector (default: attached). Matches Playwright's locator.waitFor states.",
    },
    accept: { type: 'boolean' as const, description: 'Accept (true) or dismiss (false) dialog.' },
    landscape: { type: 'boolean' as const, description: 'PDF landscape orientation.' },
    scale: { type: 'number' as const, description: 'PDF scale factor.' },
    paperWidth: { type: 'number' as const, description: 'PDF paper width in inches.' },
    paperHeight: { type: 'number' as const, description: 'PDF paper height in inches.' },
    margin: {
      type: 'object' as const,
      description: 'PDF margins {top, bottom, left, right} in inches.',
      properties: {
        top: { type: 'number' as const },
        bottom: { type: 'number' as const },
        left: { type: 'number' as const },
        right: { type: 'number' as const },
      },
    },
    html: { type: 'string' as const, description: 'HTML content for set_content action.' },
    css: { type: 'string' as const, description: 'CSS content for add_style action.' },
    cssUrl: { type: 'string' as const, description: 'URL of external stylesheet for add_style action.' },
    persistent: {
      type: 'boolean' as const,
      description: 'If true, style persists across page navigations (default: false). For add_style action.',
    },
    script: { type: 'string' as const, description: 'Script for inject action.' },
    enabled: { type: 'boolean' as const, description: 'Enable/disable for bypass_csp.' },
    sessionId: {
      type: 'string' as const,
      description: 'Agent session ID for tab ownership and isolation. Tabs are locked to sessions. Default: per-process UUID.',
    },
    cleanupStrategy: {
      type: 'string' as const,
      enum: ['close', 'detach', 'none'] as const,
      description: "Tab cleanup on session expiry. 'detach' (default) keeps tabs open, 'close' removes them, 'none' skips cleanup. Sticky per session.",
    },
    exclusive: {
      type: 'boolean' as const,
      description: 'Lock tab to this session (default: true). Set false to allow shared access.',
    },
  },
  required: ['action', 'tabId'] as const,
};

/**
 * Register the "page" tool with the given registry.
 *
 * The tool dispatches to the appropriate action handler based on `args.action`.
 */
export function registerPageTools(registry: ToolRegistry, _ctx: ServerContext): void {
  registry.register(
    defineTool({
      name: 'page',
      description: PAGE_DESCRIPTION,
      inputSchema: PAGE_INPUT_SCHEMA as Record<string, unknown>,
      handler: async (ctx, args) => {
        const pageArgs = args as unknown as PageArgs;
        const action = pageArgs.action;

        if (!action) return fail("Provide 'action' parameter.");

        const handler = PAGE_ACTIONS[action];
        if (!handler) {
          return fail(`Unknown page action: "${action}". Available: ${Object.keys(PAGE_ACTIONS).join(', ')}`);
        }

        try {
          return await handler(ctx, pageArgs);
        } catch (error: unknown) {
          return wrapError(error).toToolResult();
        }
      },
    }),
  );
}
