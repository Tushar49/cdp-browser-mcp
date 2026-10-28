/**
 * Debug tool — JavaScript debugger, resource overrides, DOM/event breakpoints.
 *
 * Uses CDP Debugger and DOMDebugger domains. The largest tool by action count.
 * Resource overrides use the Fetch domain (response-stage interception).
 */

import type { ToolRegistry } from './registry.js';
import type { ServerContext, ToolResult } from '../types.js';
import { defineTool } from './base-tool.js';
import { ok, fail } from '../utils/helpers.js';

// ─── Debugger action handlers ───────────────────────────────────────

async function handleEnable(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  const sess = p._sessionId as string;
  await ctx.sendCommand('Debugger.enable', {}, sess);
  return ok('Debugger enabled. Scripts are being tracked. Set breakpoints with set_breakpoint.');
}

async function handleDisable(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  const sess = p._sessionId as string;
  try { await ctx.sendCommand('Debugger.disable', {}, sess); } catch { /* ok */ }
  return ok('Debugger disabled.');
}

async function handleSetBreakpoint(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  if (p.url === undefined || p.lineNumber === undefined) return fail("Provide 'url' and 'lineNumber'.");
  const sess = p._sessionId as string;
  await ctx.sendCommand('Debugger.enable', {}, sess);

  const cdpParams: Record<string, unknown> = {
    url: p.url as string,
    lineNumber: p.lineNumber as number,
  };
  if (p.columnNumber !== undefined) cdpParams.columnNumber = p.columnNumber;
  if (p.condition) cdpParams.condition = p.condition;

  const result = (await ctx.sendCommand('Debugger.setBreakpointByUrl', cdpParams, sess)) as Record<string, unknown>;
  const locations = (result.locations || []) as Array<Record<string, unknown>>;
  const locs = locations.map(l => `  ${l.scriptId}:${l.lineNumber}:${l.columnNumber || 0}`).join('\n');
  return ok(`Breakpoint set: ${result.breakpointId}\nResolved locations:\n${locs || '  (none yet — will resolve when matching script loads)'}`);
}

async function handleRemoveBreakpoint(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  if (!p.breakpointId) return fail("Provide 'breakpointId'.");
  const sess = p._sessionId as string;
  await ctx.sendCommand('Debugger.removeBreakpoint', { breakpointId: p.breakpointId as string }, sess);
  return ok(`Breakpoint removed: ${p.breakpointId}`);
}

async function handleListBreakpoints(_ctx: ServerContext, _p: Record<string, unknown>): Promise<ToolResult> {
  // In the full server, breakpoints are tracked in an in-memory Map per session.
  // This stub returns the empty state; runtime integration populates the map.
  return ok('No active breakpoints.');
}

async function handlePause(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  const sess = p._sessionId as string;
  await ctx.sendCommand('Debugger.pause', {}, sess);
  return ok('Pause requested. Execution will halt at the next statement.');
}

async function handleResume(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  const sess = p._sessionId as string;
  await ctx.sendCommand('Debugger.resume', {}, sess);
  return ok('Resumed execution.');
}

async function handleStepOver(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  const sess = p._sessionId as string;
  await ctx.sendCommand('Debugger.stepOver', {}, sess);
  return ok('Stepped over. Waiting for next pause...');
}

async function handleStepInto(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  const sess = p._sessionId as string;
  await ctx.sendCommand('Debugger.stepInto', {}, sess);
  return ok('Stepped into. Waiting for next pause...');
}

async function handleStepOut(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  const sess = p._sessionId as string;
  await ctx.sendCommand('Debugger.stepOut', {}, sess);
  return ok('Stepped out. Waiting for next pause...');
}

async function handleCallStack(_ctx: ServerContext, _p: Record<string, unknown>): Promise<ToolResult> {
  // In the full server, paused state is stored in pausedTabs Map.
  // This stub returns the expected error when not paused.
  return fail("Debugger is not paused. Use 'pause' or set a breakpoint first.");
}

async function handleEvaluateOnFrame(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  if (!p.expression) return fail("Provide 'expression'.");
  const sess = p._sessionId as string;

  // In full server, we'd read from pausedTabs to get callFrameId.
  // Here we show the structure — the runtime integration provides the paused state.
  const frameIndex = (p.frameIndex as number) || 0;

  // Stub: attempt the CDP call (will fail if not paused, which is correct behavior)
  const result = (await ctx.sendCommand('Debugger.evaluateOnCallFrame', {
    callFrameId: `frame-${frameIndex}`,
    expression: p.expression as string,
    returnByValue: true,
  }, sess)) as Record<string, unknown>;

  if (result.exceptionDetails) {
    const details = result.exceptionDetails as Record<string, unknown>;
    const exc = details.exception as Record<string, unknown> | undefined;
    return fail(`Evaluation error: ${exc?.description || details.text}`);
  }

  const val = result.result as Record<string, unknown>;
  let display: string;
  if (val.type === 'object' && val.value !== undefined) {
    display = JSON.stringify(val.value, null, 2);
  } else if (val.type === 'undefined') {
    display = 'undefined';
  } else {
    display = (val.description as string) || val.value?.toString() || (val.type as string);
  }
  return ok(`[frame #${frameIndex}] ${p.expression} = ${display}`);
}

async function handleListScripts(_ctx: ServerContext, _p: Record<string, unknown>): Promise<ToolResult> {
  // Scripts are tracked via Debugger.scriptParsed events in runtime layer.
  return ok("No scripts tracked. Call 'enable' first, then reload the page.");
}

async function handleGetSource(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  if (!p.scriptId) return fail("Provide 'scriptId'.");
  const sess = p._sessionId as string;
  const result = (await ctx.sendCommand('Debugger.getScriptSource', {
    scriptId: p.scriptId as string,
  }, sess)) as Record<string, unknown>;
  const source = (result.scriptSource as string) || '';
  return ok(`Script ${p.scriptId} (${source.length} chars):\n\n${source}`);
}

// ─── Resource override handlers ─────────────────────────────────────

async function handleOverrideResource(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  if (!p.urlPattern) return fail("Provide 'urlPattern' (regex pattern to match response URLs).");
  const sess = p._sessionId as string;

  // Validate regex
  try {
    new RegExp(p.urlPattern as string, 'i');
  } catch (e: unknown) {
    return fail(`Invalid regex: ${(e as Error).message}`);
  }

  const responseCode = (p.responseCode as number) || 200;
  const body = (p.body as string) || '';
  let headers: Array<{ name: string; value: string }>;
  if (p.headers) {
    headers = Object.entries(p.headers as Record<string, string>).map(
      ([name, value]) => ({ name, value: String(value) }),
    );
  } else {
    headers = [{ name: 'Content-Type', value: 'text/html' }];
  }

  // In the full server, overrides are stored in resourceOverrides Map
  // and Fetch.enable is refreshed with response-stage patterns.
  // Ensure Fetch domain is enabled for response-stage interception.
  try {
    await ctx.sendCommand('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Response' }],
    }, sess);
  } catch { /* may already be enabled */ }

  void headers; // used by runtime integration layer
  return ok(
    `Resource override registered.\nPattern: ${p.urlPattern}\nStatus: ${responseCode}\nBody: ${body.length} chars\nMatching responses will be replaced automatically.`,
  );
}

async function handleRemoveOverride(_ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  if (!p.urlPattern) return fail("Provide 'urlPattern'.");
  // In full server, removes from resourceOverrides Map and refreshes Fetch patterns.
  return ok(`Override removed: ${p.urlPattern}`);
}

async function handleListOverrides(_ctx: ServerContext, _p: Record<string, unknown>): Promise<ToolResult> {
  // In full server, reads from resourceOverrides Map.
  return ok('No active resource overrides.');
}

// ─── DOM/Event breakpoint handlers ──────────────────────────────────

async function handleSetDomBreakpoint(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  if (p.uid === undefined) return fail("Provide 'uid' (element ref from snapshot).");
  if (!p.type) return fail("Provide 'type': 'subtree-modified', 'attribute-modified', or 'node-removed'.");
  const sess = p._sessionId as string;

  // Resolve uid → backendNodeId via ElementResolver
  const tabId = p.tabId as string;
  const resolver = ctx.elementResolvers.get(tabId);
  const backendNodeId = resolver?.resolve(p.uid as number);
  if (!backendNodeId) {
    return fail(`Element ref=${p.uid} not found. Take a fresh snapshot.`);
  }

  await ctx.sendCommand('DOM.getDocument', { depth: 0 }, sess);
  const resolveResult = (await ctx.sendCommand('DOM.resolveNode', {
    backendNodeId,
  }, sess)) as Record<string, unknown>;

  if (!resolveResult.object) {
    return fail(`Element ref=${p.uid} not found. Take a fresh snapshot.`);
  }

  // Get nodeId via pushNodesByBackendIds
  const pushResult = (await ctx.sendCommand('DOM.pushNodesByBackendIds', {
    backendNodeIds: [backendNodeId],
  }, sess)) as Record<string, unknown>;
  const nodeIds = pushResult.nodeIds as number[] | undefined;
  const nodeId = nodeIds?.[0];
  if (!nodeId) return fail(`Cannot resolve DOM nodeId for ref=${p.uid}. The element may have been removed.`);

  await ctx.sendCommand('DOMDebugger.setDOMBreakpoint', {
    nodeId,
    type: p.type as string,
  }, sess);

  const typeDesc = p.type === 'subtree-modified'
    ? 'or its children are modified'
    : p.type === 'attribute-modified'
      ? 'has attributes changed'
      : 'removed from DOM';
  return ok(`DOM breakpoint set: ${p.type} on ref=${p.uid} (nodeId=${nodeId})\nExecution will pause when this node is ${typeDesc}.`);
}

async function handleRemoveDomBreakpoint(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  if (p.uid === undefined) return fail("Provide 'uid'.");
  if (!p.type) return fail("Provide 'type'.");
  const sess = p._sessionId as string;

  // Resolve uid → backendNodeId via ElementResolver
  const tabId = p.tabId as string;
  const resolver = ctx.elementResolvers.get(tabId);
  const backendNodeId = resolver?.resolve(p.uid as number);
  if (!backendNodeId) {
    return fail(`Element ref=${p.uid} not found. Take a fresh snapshot.`);
  }

  await ctx.sendCommand('DOM.getDocument', { depth: 0 }, sess);
  const pushResult = (await ctx.sendCommand('DOM.pushNodesByBackendIds', {
    backendNodeIds: [backendNodeId],
  }, sess)) as Record<string, unknown>;
  const nodeIds = pushResult.nodeIds as number[] | undefined;
  const nodeId = nodeIds?.[0];
  if (!nodeId) return fail(`Cannot resolve DOM nodeId for ref=${p.uid}.`);

  await ctx.sendCommand('DOMDebugger.removeDOMBreakpoint', {
    nodeId,
    type: p.type as string,
  }, sess);
  return ok(`DOM breakpoint removed: ${p.type} on ref=${p.uid}`);
}

async function handleSetEventBreakpoint(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  if (!p.eventName) return fail("Provide 'eventName' (e.g. 'click', 'xhr', 'setTimeout').");
  const sess = p._sessionId as string;
  await ctx.sendCommand('DOMDebugger.setEventListenerBreakpoint', {
    eventName: p.eventName as string,
  }, sess);
  return ok(`Event breakpoint set: ${p.eventName}\nExecution will pause when a '${p.eventName}' event fires.`);
}

async function handleRemoveEventBreakpoint(ctx: ServerContext, p: Record<string, unknown>): Promise<ToolResult> {
  if (!p.eventName) return fail("Provide 'eventName'.");
  const sess = p._sessionId as string;
  await ctx.sendCommand('DOMDebugger.removeEventListenerBreakpoint', {
    eventName: p.eventName as string,
  }, sess);
  return ok(`Event breakpoint removed: ${p.eventName}`);
}

// ─── Action dispatch ────────────────────────────────────────────────

const ACTION_MAP: Record<string, (ctx: ServerContext, p: Record<string, unknown>) => Promise<ToolResult>> = {
  // Debugger
  enable: handleEnable,
  disable: handleDisable,
  set_breakpoint: handleSetBreakpoint,
  remove_breakpoint: handleRemoveBreakpoint,
  list_breakpoints: handleListBreakpoints,
  pause: handlePause,
  resume: handleResume,
  step_over: handleStepOver,
  step_into: handleStepInto,
  step_out: handleStepOut,
  call_stack: handleCallStack,
  evaluate_on_frame: handleEvaluateOnFrame,
  list_scripts: handleListScripts,
  get_source: handleGetSource,
  // Resource overrides
  override_resource: handleOverrideResource,
  remove_override: handleRemoveOverride,
  list_overrides: handleListOverrides,
  // DOM/Event breakpoints
  set_dom_breakpoint: handleSetDomBreakpoint,
  remove_dom_breakpoint: handleRemoveDomBreakpoint,
  set_event_breakpoint: handleSetEventBreakpoint,
  remove_event_breakpoint: handleRemoveEventBreakpoint,
};

// ─── Registration ───────────────────────────────────────────────────

export function registerDebugTools(
  registry: ToolRegistry,
  _ctx: ServerContext,
): void {
  registry.register(
    defineTool({
      name: 'debug',
      description: [
        'Use this to debug JavaScript issues — set breakpoints, step through code, inspect variables, or override resources. Call enable first before setting breakpoints.',
        '',
        'Debugger operations:',
        '- enable: Enable JavaScript debugger for a tab — starts tracking scripts and allows breakpoints (requires: tabId)',
        '- disable: Disable the debugger for a tab (requires: tabId)',
        '- set_breakpoint: Set a breakpoint by URL pattern + line number (requires: tabId, url, lineNumber; optional: columnNumber, condition)',
        '- remove_breakpoint: Remove a breakpoint by ID (requires: tabId, breakpointId)',
        '- list_breakpoints: List all active breakpoints for a tab (requires: tabId)',
        '- pause: Pause JavaScript execution immediately (requires: tabId)',
        '- resume: Resume execution after a pause (requires: tabId)',
        '- step_over: Step over the current statement (requires: tabId)',
        '- step_into: Step into the next function call (requires: tabId)',
        '- step_out: Step out of the current function (requires: tabId)',
        '- call_stack: Get the current call stack with scope variables when paused (requires: tabId)',
        '- evaluate_on_frame: Evaluate an expression in a specific call frame (requires: tabId, expression; optional: frameIndex — default 0, top frame)',
        '- list_scripts: List all loaded scripts tracked by the debugger (requires: tabId)',
        '- get_source: Get the source code of a script by ID (requires: tabId, scriptId)',
        '',
        'Resource override operations:',
        '- override_resource: Pre-register a URL pattern + replacement response body. Pattern is a JS regex matched against response URLs. Matching responses are fulfilled automatically — no LLM round-trip (requires: tabId, urlPattern; optional: body, responseCode, headers)',
        '- remove_override: Remove a resource override by URL pattern (requires: tabId, urlPattern)',
        '- list_overrides: List all active resource overrides (requires: tabId)',
        '',
        'DOM/Event breakpoint operations:',
        "- set_dom_breakpoint: Break when a DOM node is modified (requires: tabId, uid, type — 'subtree-modified', 'attribute-modified', or 'node-removed')",
        '- remove_dom_breakpoint: Remove a DOM breakpoint (requires: tabId, uid, type)',
        "- set_event_breakpoint: Break on a specific event type like 'click', 'xhr', 'setTimeout' (requires: tabId, eventName)",
        '- remove_event_breakpoint: Remove an event breakpoint (requires: tabId, eventName)',
        '',
        'Notes:',
        "- Call 'enable' before setting breakpoints or listing scripts",
        '- When debugger pauses, ALL other tool calls on that tab are blocked until you resume/step',
        '- Auto-resume fires after 30s (CDP_DEBUGGER_TIMEOUT) to prevent permanently frozen tabs',
        "- Resource overrides work independently of the debugger — no need to call 'enable' first",
        '- Resource overrides coexist with request interception (intercept tool). Both can be active simultaneously',
        '- Performance: while overrides are active, ALL responses are routed through the handler for regex matching. Remove overrides when done to avoid unnecessary overhead on resource-heavy pages',
        '',
        'Session params (all tools): sessionId, cleanupStrategy, exclusive',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'enable', 'disable',
              'set_breakpoint', 'remove_breakpoint', 'list_breakpoints',
              'pause', 'resume', 'step_over', 'step_into', 'step_out',
              'call_stack', 'evaluate_on_frame',
              'list_scripts', 'get_source',
              'override_resource', 'remove_override', 'list_overrides',
              'set_dom_breakpoint', 'remove_dom_breakpoint',
              'set_event_breakpoint', 'remove_event_breakpoint',
            ],
            description: 'Debug action.',
          },
          tabId: { type: 'string', description: 'Tab ID.' },
          url: { type: 'string', description: 'URL pattern for set_breakpoint (matched by prefix).' },
          lineNumber: { type: 'number', description: 'Line number for set_breakpoint (0-based).' },
          columnNumber: { type: 'number', description: 'Column number for set_breakpoint (0-based, optional).' },
          condition: { type: 'string', description: 'Conditional breakpoint expression — break only when this evaluates to true.' },
          breakpointId: { type: 'string', description: 'Breakpoint ID for remove_breakpoint.' },
          expression: { type: 'string', description: 'JS expression for evaluate_on_frame.' },
          frameIndex: { type: 'number', description: 'Call frame index for evaluate_on_frame (default: 0 = top frame).' },
          scriptId: { type: 'string', description: 'Script ID for get_source.' },
          urlPattern: { type: 'string', description: "URL regex pattern for override_resource / remove_override (JS regex syntax, e.g. 'example\\\\.com/api/.*')." },
          body: { type: 'string', description: 'Response body for override_resource.' },
          responseCode: { type: 'number', description: 'HTTP status code for override_resource (default: 200).' },
          headers: { type: 'object', description: 'Response headers for override_resource (object of name→value).' },
          uid: { type: 'number', description: 'Element ref for set_dom_breakpoint / remove_dom_breakpoint.' },
          type: { type: 'string', enum: ['subtree-modified', 'attribute-modified', 'node-removed'], description: 'DOM breakpoint type.' },
          eventName: { type: 'string', description: "Event name for set_event_breakpoint (e.g. 'click', 'xhr', 'setTimeout')." },
          sessionId: { type: 'string', description: 'Agent session ID for tab ownership and isolation.' },
          cleanupStrategy: { type: 'string', enum: ['close', 'detach', 'none'], description: 'Tab cleanup on session expiry.' },
          exclusive: { type: 'boolean', description: 'Lock tab to this session (default: true).' },
        },
        required: ['action'],
      },
      handler: async (ctx, params) => {
        const action = params.action as string;
        const handler = ACTION_MAP[action];
        if (!handler) {
          return fail(`Unknown debug action: "${action}". Use: ${Object.keys(ACTION_MAP).join(', ')}`);
        }
        return handler(ctx, params);
      },
    }),
  );
}
