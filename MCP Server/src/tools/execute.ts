/**
 * Execute tool — JavaScript execution on the page.
 *
 * Three modes: eval (expression), script (async IIFE), call (function on element).
 * Mostly CDP pass-through to Runtime.evaluate / Runtime.callFunctionOn.
 */

import type { ToolRegistry } from './registry.js';
import type { ServerContext, ToolResult } from '../types.js';
import { defineTool } from './base-tool.js';
import { ok, fail } from '../utils/helpers.js';

// ─── Helpers ────────────────────────────────────────────────────────

/** Format a Runtime.evaluate / callFunctionOn result value for display. */
function formatValue(v: Record<string, unknown>): string {
  if (v.type === 'undefined') return 'undefined';
  if (v.value !== undefined) {
    return typeof v.value === 'string'
      ? v.value
      : JSON.stringify(v.value, null, 2);
  }
  return (v.description as string) || String(v);
}

/** Extract a human-readable error from CDP exceptionDetails. */
function exceptionMessage(
  details: Record<string, unknown>,
  fallback: string,
): string {
  const exc = details.exception as Record<string, unknown> | undefined;
  return (exc?.description as string) || (details.text as string) || fallback;
}

// ─── Action handlers ────────────────────────────────────────────────

async function handleEval(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  if (!params.expression) return fail("Provide 'expression' to evaluate.");

  const result = (await ctx.sendCommand('Runtime.evaluate', {
    expression: params.expression as string,
    returnByValue: true,
    awaitPromise: true,
    generatePreview: true,
    userGesture: true,
  }, params._sessionId as string)) as Record<string, unknown>;

  if (result.exceptionDetails) {
    return fail(exceptionMessage(result.exceptionDetails as Record<string, unknown>, 'Evaluation error'));
  }
  const v = result.result as Record<string, unknown>;
  return ok(formatValue(v));
}

async function handleScript(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  if (!params.code) return fail("Provide 'code' for script body.");

  const wrapped = `(async () => { ${params.code as string} })()`;
  const result = (await ctx.sendCommand('Runtime.evaluate', {
    expression: wrapped,
    returnByValue: true,
    awaitPromise: true,
    generatePreview: true,
    userGesture: true,
  }, params._sessionId as string)) as Record<string, unknown>;

  if (result.exceptionDetails) {
    return fail(exceptionMessage(result.exceptionDetails as Record<string, unknown>, 'Script error'));
  }
  const v = result.result as Record<string, unknown>;
  if (v.type === 'undefined') return ok('Script completed (no return value).');
  if (v.value !== undefined) {
    return ok(typeof v.value === 'string' ? v.value : JSON.stringify(v.value, null, 2));
  }
  return ok((v.description as string) || 'Script completed.');
}

async function handleCall(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  if (!params.function) return fail("Provide 'function' declaration, e.g. '(el) => el.textContent'.");

  // Element resolution is delegated to the server-level resolveElementObjectId.
  // For now, stub the CDP calls that the handler would make.
  const sess = params._sessionId as string;

  // Resolve element by uid or selector — mirrors server.js resolveElementObjectId
  let objectId: string | undefined;
  let resolvedSession: string = sess;

  if (params.uid !== undefined) {
    // Resolve uid → backendNodeId via the per-tab ElementResolver
    const tabId = params.tabId as string;
    const resolver = ctx.elementResolvers.get(tabId);
    const backendNodeId = resolver?.resolve(params.uid as number);
    if (!backendNodeId) {
      return fail(`Element ref=${params.uid} not found. Take a fresh snapshot.`);
    }
    const resolveResult = (await ctx.sendCommand('DOM.resolveNode', {
      backendNodeId,
    }, sess)) as Record<string, unknown>;
    const obj = resolveResult.object as Record<string, unknown> | undefined;
    objectId = obj?.objectId as string | undefined;
  } else if (params.selector) {
    // Use DOM + querySelector path
    const doc = (await ctx.sendCommand('DOM.getDocument', { depth: 0 }, sess)) as Record<string, unknown>;
    const root = doc.root as Record<string, unknown>;
    const qResult = (await ctx.sendCommand('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: params.selector as string,
    }, sess)) as Record<string, unknown>;
    if (!qResult.nodeId) return fail(`No element matches selector "${params.selector}".`);
    const resolved = (await ctx.sendCommand('DOM.resolveNode', {
      nodeId: qResult.nodeId,
    }, sess)) as Record<string, unknown>;
    const obj = resolved.object as Record<string, unknown> | undefined;
    objectId = obj?.objectId as string | undefined;
  } else {
    return fail("Provide 'uid' or 'selector' to identify the target element.");
  }

  if (!objectId) return fail('Could not resolve element to a JS object.');

  const result = (await ctx.sendCommand('Runtime.callFunctionOn', {
    functionDeclaration: params.function as string,
    objectId,
    arguments: [{ objectId }],
    returnByValue: true,
    awaitPromise: true,
  }, resolvedSession)) as Record<string, unknown>;

  if (result.exceptionDetails) {
    return fail(exceptionMessage(result.exceptionDetails as Record<string, unknown>, 'Call error'));
  }
  const v = result.result as Record<string, unknown>;
  return ok(formatValue(v));
}

// ─── Registration ───────────────────────────────────────────────────

export function registerExecuteTools(
  registry: ToolRegistry,
  _ctx: ServerContext,
): void {
  registry.register(
    defineTool({
      name: 'execute',
      description: [
        "Run JavaScript on the page. Use this when standard tools can't handle a specific interaction.",
        '',
        "For clicking elements that don't respond to CDP clicks (rare):",
        "  execute({ action: 'call', uid: 5, function: '(el) => el.click()' })",
        '',
        'Operations:',
        '- eval: Evaluate a JavaScript expression and return its value (requires: tabId, expression)',
        '- script: Execute an async function body wrapped in an IIFE — use for multi-step JS logic (requires: tabId, code)',
        "- call: Call a JavaScript function with a specific page element as its argument (requires: tabId, function — e.g. '(el) => el.textContent', uid or selector)",
        '',
        'Notes:',
        '- eval returns the expression\'s value directly (must be JSON-serializable)',
        '- script wraps your code in: (async () => { <your code> })() — use \'return\' to send a value back',
        '- call resolves the element first, then passes it as the first argument to your function',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['eval', 'script', 'call'], description: 'Execution mode.' },
          tabId: { type: 'string', description: 'Tab ID.' },
          expression: { type: 'string', description: 'JS expression for eval.' },
          code: { type: 'string', description: 'JS function body for script (wrapped in async IIFE).' },
          function: { type: 'string', description: "JS function for call, receives element as arg. E.g. '(el) => el.textContent'" },
          uid: { type: 'number', description: 'Element uid for call.' },
          selector: { type: 'string', description: 'CSS selector for call.' },
          sessionId: { type: 'string', description: 'Agent session ID for tab ownership and isolation. Tabs are locked to sessions. Default: per-process UUID.' },
          cleanupStrategy: { type: 'string', enum: ['close', 'detach', 'none'], description: "Tab cleanup on session expiry. 'detach' (default) keeps tabs open, 'close' removes them, 'none' skips cleanup. Sticky per session." },
          exclusive: { type: 'boolean', description: 'Lock tab to this session (default: true). Set false to allow shared access.' },
        },
        required: ['action'],
      },
      handler: async (ctx, params) => {
        const action = params.action as string;
        switch (action) {
          case 'eval':        return handleEval(ctx, params);
          case 'script':      return handleScript(ctx, params);
          case 'call':        return handleCall(ctx, params);
          default:            return fail(`Unknown execute action: "${action}". Use: eval, script, call`);
        }
      },
    }),
  );
}
