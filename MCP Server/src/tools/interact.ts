/**
 * Element interaction tool handler.
 *
 * Extracted from the monolith server.js — contains all element-level
 * interactions: click, hover, type, fill, select, press, drag, scroll,
 * upload, focus, check, and tap.
 */

import type { ToolResult, ServerContext } from '../types.js';
import type { ToolRegistry } from './registry.js';
import { defineTool } from './base-tool.js';
import { ok, fail, randomDelay, generateBezierPath } from '../utils/helpers.js';
import { Errors, wrapError } from '../utils/error-handler.js';
import { slimify } from './slim-mode.js';
import {
  sleep,
  waitForSelector,
  waitForText,
  waitForTextGone,
  type SelectorState,
} from '../utils/wait.js';

// ─── Network Settle Helper ──────────────────────────────────────────

/**
 * Wait for network to settle after an action (no new requests for 500ms).
 * Mirrors Playwright's waitForCompletion pattern.
 */
async function waitForNetworkSettle(
  ctx: ServerContext,
  sess: string,
  timeoutMs: number = 3000,
): Promise<string[]> {
  const events: string[] = [];
  const networkReqs = ctx.networkReqs.get(sess);
  if (!networkReqs) return events;

  const pendingAtStart = new Set<string>();
  for (const [id, req] of networkReqs) {
    if (!req.status) pendingAtStart.add(id);
  }

  if (pendingAtStart.size === 0) return events;

  const start = Date.now();
  let lastActivity = Date.now();

  while (Date.now() - start < timeoutMs) {
    await sleep(100);
    let stillPending = 0;
    for (const id of pendingAtStart) {
      const req = networkReqs.get(id);
      if (req && !req.status) {
        stillPending++;
      } else if (req?.status) {
        events.push(`${req.method} ${req.url.substring(0, 60)} → ${req.status}`);
        pendingAtStart.delete(id);
        lastActivity = Date.now();
      }
    }
    if (stillPending === 0) break;
    if (Date.now() - lastActivity > 500) break; // settled
  }

  return events;
}

// ─── Click waitFor Helper ───────────────────────────────────────────

/**
 * Run a post-click wait condition. Mirrors `page.wait` semantics so an agent
 * can click+wait in a single call.
 *
 * Parity with Playwright MCP browser_click — single-call equivalent of
 * `browser_click` followed by `browser_wait_for { text | textGone | time }`.
 *
 * Returns a short human-readable suffix to append to the click result.
 */
async function runClickWaitFor(
  ctx: ServerContext,
  sess: string,
  waitFor: NonNullable<InteractArgs['waitFor']>,
  defaultTimeout: number,
): Promise<string> {
  const timeout = waitFor.timeout ?? defaultTimeout;
  const cdpSend = (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>> =>
    ctx.sendCommand(method, params, sessionId) as Promise<Record<string, unknown>>;

  if (waitFor.textGone) {
    const found = await waitForTextGone(cdpSend, sess, waitFor.textGone, timeout);
    return found
      ? `\nWait: "${waitFor.textGone}" disappeared`
      : `\nWait: timed out (${timeout}ms) waiting for "${waitFor.textGone}" to disappear`;
  }

  if (waitFor.text) {
    const found = await waitForText(cdpSend, sess, waitFor.text, timeout);
    return found
      ? `\nWait: "${waitFor.text}" appeared`
      : `\nWait: timed out (${timeout}ms) waiting for "${waitFor.text}"`;
  }

  if (waitFor.selector) {
    const state: SelectorState = waitFor.state ?? 'visible';
    const found = await waitForSelector(cdpSend, sess, waitFor.selector, state, timeout);
    return found
      ? `\nWait: ${waitFor.selector} ${state}`
      : `\nWait: timed out (${timeout}ms) waiting for ${waitFor.selector} [state: ${state}]`;
  }

  return '';
}

// ─── Arg Interfaces ─────────────────────────────────────────────────

interface InteractArgs {
  action: string;
  tabId: string;
  uid?: number;
  selector?: string;
  // click
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  modifiers?: Array<'Control' | 'Shift' | 'Alt' | 'Meta'>;
  jsClick?: boolean;
  // type
  text?: string;
  clear?: boolean;
  submit?: boolean;
  delay?: number;
  charDelay?: number;
  wordDelay?: number;
  typoRate?: number;
  // fill
  fields?: Array<{
    uid?: number;
    selector?: string;
    value: string;
    type?: 'text' | 'checkbox' | 'radio' | 'select';
  }>;
  // select
  value?: string;
  // press
  key?: string;
  // drag
  sourceUid?: number;
  sourceSelector?: string;
  targetUid?: number;
  targetSelector?: string;
  // scroll
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  x?: number;
  y?: number;
  // upload
  files?: string[];
  // check
  checked?: boolean;
  // click waitFor (Playwright parity — see handleClick)
  waitFor?: {
    selector?: string;
    text?: string;
    textGone?: string;
    state?: SelectorState;
    timeout?: number;
  };
  // common
  timeout?: number;
  humanMode?: boolean;
  autoSnapshot?: boolean;
  // session
  sessionId?: string;
  cleanupStrategy?: string;
  exclusive?: boolean;
}

/** Resolved element info from CDP. */
interface ResolvedElement {
  x: number;
  y: number;
  w: number;
  h: number;
  tag: string;
  label: string;
}

/** Resolved element with objectId for JS calls. */
interface ResolvedElementObject {
  objectId: string;
  resolvedSession: string;
}

// ─── Action Handlers ────────────────────────────────────────────────

/**
 * Perform a JavaScript el.click() on an element identified by backendNodeId.
 * Reusable by other handlers (e.g. form.ts combobox clicking).
 */
export async function jsClickElement(
  ctx: ServerContext,
  sessionId: string,
  backendNodeId: number,
): Promise<void> {
  const { object } = await ctx.sendCommand('DOM.resolveNode', {
    backendNodeId,
  }, sessionId) as { object: { objectId: string } };
  await ctx.sendCommand('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: 'function() { this.click(); }',
    returnByValue: true,
  }, sessionId);
}

async function handleClick(ctx: ServerContext, args: InteractArgs): Promise<ToolResult> {
  const sess = await getTabSession(ctx, args.tabId);
  const retryTimeout = args.timeout || ctx.config.actionTimeout;

  const el = await withRetry(
    () => resolveAndCheck(ctx, sess, args.uid, args.selector, args.tabId),
    retryTimeout,
  );

  // Resolve backendNodeId for potential JS-click fallback
  const { objectId, resolvedSession } = await resolveElementObjectId(ctx, sess, args.uid, args.selector, args.tabId);
  const { node } = await ctx.sendCommand('DOM.describeNode', { objectId }, resolvedSession) as {
    node: { backendNodeId: number };
  };

  // Force JS click — skip CDP mouse events entirely
  if (args.jsClick) {
    await jsClickElement(ctx, resolvedSession, node.backendNodeId);
    const waitSuffixJs = args.waitFor
      ? await runClickWaitFor(ctx, sess, args.waitFor, retryTimeout)
      : '';
    return ok(slimify(`Clicked (JS) <${el.tag}> "${el.label}" at (${Math.round(el.x)}, ${Math.round(el.y)})${waitSuffixJs}`, 'Clicked'));
  }

  const button = args.button || 'left';
  const clicks = args.clickCount || 1;
  const buttonsMap: Record<string, number> = { left: 1, right: 2, middle: 4 };
  const buttons = buttonsMap[button] || 1;
  const mods = modifierFlags(args.modifiers);

  // P0-5: No automatic MutationObserver detection — CDP click only,
  // with JS fallback on CDP error (not on "no effect" heuristic)
  try {
    if (args.humanMode) {
      // Human-like: bezier curve mouse path with overshoot and jitter
      const path = generateBezierPath({ x: 0, y: 0 }, { x: el.x, y: el.y });
      for (let i = 0; i < path.length; i++) {
        await ctx.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: path[i].x, y: path[i].y, modifiers: mods,
        }, sess);
        const progress = i / path.length;
        const moveDelay = progress > 0.7 ? 15 + Math.random() * 20 : 5 + Math.random() * 10;
        await sleep(moveDelay);
      }
      await sleep(30 + Math.random() * 50); // pre-click hesitation
    } else {
      await ctx.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: el.x, y: el.y, modifiers: mods,
      }, sess);
      await sleep(50);
    }

    await ctx.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: el.x, y: el.y, button, clickCount: clicks, buttons, modifiers: mods,
    }, sess);
    await ctx.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: el.x, y: el.y, button, clickCount: clicks, modifiers: mods,
    }, sess);

    // Wait briefly for any triggered network requests to settle
    const netEvents = await waitForNetworkSettle(ctx, sess, 2000);
    const netSuffix = netEvents.length > 0 ? `\nNetwork: ${netEvents.length} request(s) completed` : '';
    const waitSuffix = args.waitFor
      ? await runClickWaitFor(ctx, sess, args.waitFor, retryTimeout)
      : '';
    return ok(slimify(`Clicked <${el.tag}> "${el.label}" at (${Math.round(el.x)}, ${Math.round(el.y)})${netSuffix}${waitSuffix}`, 'Clicked'));
  } catch {
    // CDP click failed (element not interactable) — fallback to JS click
    await jsClickElement(ctx, resolvedSession, node.backendNodeId);
    const netEvents2 = await waitForNetworkSettle(ctx, sess, 2000);
    const netSuffix2 = netEvents2.length > 0 ? `\nNetwork: ${netEvents2.length} request(s) completed` : '';
    const waitSuffix2 = args.waitFor
      ? await runClickWaitFor(ctx, sess, args.waitFor, retryTimeout)
      : '';
    return ok(slimify(`Clicked (JS fallback) <${el.tag}> "${el.label}" at (${Math.round(el.x)}, ${Math.round(el.y)})${netSuffix2}${waitSuffix2}`, 'Clicked'));
  }
}

async function handleHover(ctx: ServerContext, args: InteractArgs): Promise<ToolResult> {
  const sess = await getTabSession(ctx, args.tabId);
  const retryTimeout = args.timeout || ctx.config.actionTimeout;
  const el = await withRetry(
    () => resolveElement(ctx, sess, args.uid, args.selector, args.tabId),
    retryTimeout,
  );
  const mods = modifierFlags(args.modifiers);

  if (args.humanMode) {
    const path = generateBezierPath({ x: 0, y: 0 }, { x: el.x, y: el.y });
    for (const pt of path) {
      await ctx.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: pt.x, y: pt.y, modifiers: mods,
      }, sess);
      await sleep(5 + Math.random() * 15);
    }
  } else {
    await ctx.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: el.x, y: el.y, modifiers: mods,
    }, sess);
  }

  return ok(slimify(`Hovering over <${el.tag}> "${el.label}" at (${Math.round(el.x)}, ${Math.round(el.y)})${args.humanMode ? ' (human path)' : ''}`, 'Hovered'));
}

async function handleType(ctx: ServerContext, args: InteractArgs): Promise<ToolResult> {
  if (!args.text) return fail("Provide 'text' to type.");
  const sess = await getTabSession(ctx, args.tabId);
  const retryTimeout = args.timeout || ctx.config.actionTimeout;

  // Resolve element and focus it
  const { objectId, resolvedSession } = await withRetry(async () => {
    await resolveAndCheck(ctx, sess, args.uid, args.selector, args.tabId);
    return resolveElementObjectId(ctx, sess, args.uid, args.selector, args.tabId);
  }, retryTimeout);

  // Clear existing content if requested (default: true)
  const clearCode = args.clear !== false
    ? `if ('value' in this) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                          || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(this, '');
        else this.value = '';
        this.dispatchEvent(new Event('input', {bubbles:true}));
      } else if (this.isContentEditable) { this.textContent = ''; }`
    : '';

  await ctx.sendCommand('Runtime.callFunctionOn', {
    functionDeclaration: `function() { this.scrollIntoView({block:"center"}); this.focus(); ${clearCode} return {ok:true}; }`,
    objectId,
    returnByValue: true,
  }, resolvedSession);

  if (args.charDelay || args.wordDelay) {
    // Human-like typing: randomized per-char and per-word delays
    const charBase = args.charDelay || 200;
    const wordBase = args.wordDelay || 800;

    for (const char of args.text) {
      // Typo simulation
      if (args.typoRate && args.typoRate > 0 && Math.random() < args.typoRate && /[a-zA-Z]/.test(char)) {
        const wrongChar = getAdjacentKey(char);
        await ctx.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown', text: wrongChar, key: wrongChar, unmodifiedText: wrongChar,
        }, sess);
        await ctx.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: wrongChar }, sess);
        await sleep(randomDelay(charBase * 2)); // pause — "noticing" the mistake

        const bk = resolveKey('Backspace');
        await ctx.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown', key: bk.key, code: bk.code,
          windowsVirtualKeyCode: bk.keyCode, nativeVirtualKeyCode: bk.keyCode,
        }, sess);
        await ctx.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp', key: bk.key, code: bk.code,
          windowsVirtualKeyCode: bk.keyCode, nativeVirtualKeyCode: bk.keyCode,
        }, sess);
        await sleep(randomDelay(charBase * 0.5));
      }

      await ctx.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown', text: char, key: char, unmodifiedText: char,
      }, sess);
      await ctx.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: char }, sess);

      if (char === ' ' || char === '\t') {
        await sleep(randomDelay(wordBase));
      } else if (char === '\n') {
        await sleep(randomDelay(wordBase));
      } else {
        await sleep(randomDelay(charBase));
      }
    }
  } else if (args.delay && args.delay > 0) {
    // Legacy: fixed delay per keystroke
    for (const char of args.text) {
      await ctx.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown', text: char, key: char, unmodifiedText: char,
      }, sess);
      await ctx.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: char }, sess);
      await sleep(args.delay);
    }
  } else {
    // Instant fill using nativeInputValueSetter for React/Angular compatibility
    await ctx.sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const el = document.activeElement;
        if (!el) return;
        const val = ${JSON.stringify(args.text)};
        if ('value' in el) {
          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                            || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(el, val);
          else el.value = val;
        } else if (el.isContentEditable) {
          document.execCommand('insertText', false, val);
        }
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
      })()`,
    }, sess);
  }

  if (args.submit) {
    const k = resolveKey('Enter');
    await ctx.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', ...k,
    }, sess);
    await ctx.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key: k.key, code: k.code,
      windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode,
    }, sess);
  }

  const display = args.text.length > 60 ? args.text.substring(0, 60) + '...' : args.text;
  return ok(slimify(`Typed "${display}"${args.submit ? ' + Enter' : ''}`, `Typed${args.submit ? '+Enter' : ''}`));
}

async function handleFill(ctx: ServerContext, args: InteractArgs): Promise<ToolResult> {
  if (!args.fields?.length) return fail("Provide 'fields' array.");
  const sess = await getTabSession(ctx, args.tabId);
  const retryTimeout = args.timeout || ctx.config.actionTimeout;
  const results: Array<Record<string, unknown>> = [];

  for (const field of args.fields) {
    try {
      const { objectId, resolvedSession: fieldSession } = await withRetry(async () => {
        await resolveAndCheck(ctx, sess, field.uid, field.selector, args.tabId);
        return resolveElementObjectId(ctx, sess, field.uid, field.selector, args.tabId);
      }, retryTimeout);

      const fieldType = field.type || 'text';
      const r = await ctx.sendCommand('Runtime.callFunctionOn', {
        functionDeclaration: `function() {
          this.scrollIntoView({ block: "center" });
          const type = ${JSON.stringify(fieldType)};
          const val = ${JSON.stringify(field.value)};
          if (type === "checkbox") {
            const wanted = val === "true" || val === "1";
            if (this.checked !== wanted) this.click();
            return { ok: true, value: String(this.checked) };
          }
          if (type === "radio") { this.click(); return { ok: true, value: val }; }
          if (type === "select") {
            let opt = Array.from(this.options).find(o => o.value === val || o.textContent.trim() === val);
            if (!opt) return { error: "Option not found: " + val };
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
            if (nativeSetter) nativeSetter.call(this, opt.value);
            else this.value = opt.value;
            this.dispatchEvent(new Event('input', {bubbles:true}));
            this.dispatchEvent(new Event('change', {bubbles:true}));
            return { ok: true, value: opt.textContent.trim() };
          }
          this.focus();
          if ('value' in this) {
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                              || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            if (nativeSetter) nativeSetter.call(this, val);
            else this.value = val;
          } else if (this.isContentEditable) {
            this.textContent = val;
          }
          this.dispatchEvent(new Event('input', {bubbles:true}));
          this.dispatchEvent(new Event('change', {bubbles:true}));
          return { ok: true, value: val.substring(0, 40) };
        }`,
        objectId,
        returnByValue: true,
      }, fieldSession) as { result: { value: Record<string, unknown> } };

      results.push({ field: field.uid ?? field.selector, ...(r.result.value || { error: 'eval failed' }) });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ field: field.uid ?? field.selector, error: msg });
    }
  }

  return ok({ filled: results });
}

async function handleSelect(ctx: ServerContext, args: InteractArgs): Promise<ToolResult> {
  if (!args.value) return fail("Provide 'value' to select.");
  const sess = await getTabSession(ctx, args.tabId);
  const retryTimeout = args.timeout || ctx.config.actionTimeout;

  const { objectId, resolvedSession } = await withRetry(async () => {
    await resolveAndCheck(ctx, sess, args.uid, args.selector, args.tabId);
    return resolveElementObjectId(ctx, sess, args.uid, args.selector, args.tabId);
  }, retryTimeout);

  const result = await ctx.sendCommand('Runtime.callFunctionOn', {
    functionDeclaration: `function() {
      const sel = this;
      if (sel.tagName === "SELECT") {
        const targetVal = ${JSON.stringify(args.value)};
        let opt = Array.from(sel.options).find(o => o.value === targetVal);
        if (!opt) opt = Array.from(sel.options).find(o => o.textContent.trim() === targetVal);
        if (!opt) return { error: "Option not found: " + targetVal + ". Available: " + Array.from(sel.options).map(o => o.textContent.trim()).join(", ") };

        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(sel, opt.value);
        else sel.value = opt.value;

        sel.dispatchEvent(new Event("input", { bubbles: true }));
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return { selected: opt.textContent.trim(), value: opt.value };
      }

      const role = sel.getAttribute("role");
      const isCustomDropdown = role === "combobox" || role === "listbox" ||
        sel.getAttribute("aria-haspopup") ||
        sel.classList.toString().match(/MuiSelect|ant-select|react-select|Select/i);

      if (isCustomDropdown) {
        sel.scrollIntoView({ block: "center" });
        sel.click();
        return { customDropdown: true, message: "Custom dropdown opened — click the matching option" };
      }

      return { error: "Not a <select> element and not a recognized custom dropdown. Element: <" + sel.tagName.toLowerCase() + ">" };
    }`,
    objectId,
    returnByValue: true,
  }, resolvedSession) as { result: { value: Record<string, unknown> } };

  const v = result.result.value;
  if (v?.error) return fail(String(v.error));

  // If custom dropdown was opened, try to click the matching option
  if (v?.customDropdown) {
    await sleep(300);
    const clickResult = await ctx.sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const val = ${JSON.stringify(args.value)};
        const options = document.querySelectorAll('[role="option"], [role="listitem"], li[data-value], .MuiMenuItem-root, .ant-select-item, [class*="option"]');
        for (const opt of options) {
          const text = opt.textContent.trim();
          const value = opt.getAttribute("data-value") || opt.getAttribute("value") || "";
          if (text === val || value === val || text.toLowerCase() === val.toLowerCase()) {
            opt.scrollIntoView({ block: "center" });
            opt.click();
            return { selected: text, value: value || text };
          }
        }
        return { error: "Option not found in custom dropdown: " + val + ". Visible options: " + Array.from(options).slice(0, 10).map(o => o.textContent.trim()).join(", ") };
      })()`,
      returnByValue: true,
    }, sess) as { result: { value: Record<string, unknown> } };

    const cv = clickResult.result.value;
    if (cv?.error) return fail(String(cv.error));
  }

  return ok(slimify('Selected option successfully', 'Selected'));
}

async function handlePress(ctx: ServerContext, args: InteractArgs): Promise<ToolResult> {
  if (!args.key) return fail("Provide 'key' to press.");
  const sess = await getTabSession(ctx, args.tabId);
  const k = resolveKey(args.key);
  const mods = modifierFlags(args.modifiers);

  await ctx.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyDown', key: k.key, code: k.code,
    windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode,
    modifiers: mods, text: k.text,
  }, sess);
  await ctx.sendCommand('Input.dispatchKeyEvent', {
    type: 'keyUp', key: k.key, code: k.code,
    windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode,
    modifiers: mods,
  }, sess);

  const modStr = args.modifiers?.length ? args.modifiers.join('+') + '+' : '';
  return ok(slimify(`Pressed ${modStr}${args.key}`, 'Pressed'));
}

async function handleDrag(ctx: ServerContext, args: InteractArgs): Promise<ToolResult> {
  const sess = await getTabSession(ctx, args.tabId);
  const retryTimeout = args.timeout || ctx.config.actionTimeout;

  const src = await withRetry(
    () => resolveElement(ctx, sess, args.sourceUid, args.sourceSelector, args.tabId),
    retryTimeout,
  );
  const tgt = await withRetry(
    () => resolveElement(ctx, sess, args.targetUid, args.targetSelector, args.tabId),
    retryTimeout,
  );

  await ctx.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: src.x, y: src.y,
  }, sess);
  await sleep(50);
  await ctx.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: src.x, y: src.y, button: 'left', clickCount: 1,
  }, sess);
  await sleep(100);

  if (args.humanMode) {
    const path = generateBezierPath({ x: src.x, y: src.y }, { x: tgt.x, y: tgt.y }, 25, 3);
    for (const pt of path) {
      await ctx.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: pt.x, y: pt.y,
      }, sess);
      await sleep(10 + Math.random() * 15);
    }
  } else {
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const px = src.x + (tgt.x - src.x) * (i / steps);
      const py = src.y + (tgt.y - src.y) * (i / steps);
      await ctx.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: px, y: py,
      }, sess);
      await sleep(20);
    }
  }

  await ctx.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: tgt.x, y: tgt.y, button: 'left', clickCount: 1,
  }, sess);

  return ok(slimify(`Dragged <${src.tag}> "${src.label}" → <${tgt.tag}> "${tgt.label}"${args.humanMode ? ' (human path)' : ''}`, 'Dragged'));
}

async function handleScroll(ctx: ServerContext, args: InteractArgs): Promise<ToolResult> {
  const sess = await getTabSession(ctx, args.tabId);
  const amount = args.amount || 400;
  const retryTimeout = args.timeout || ctx.config.actionTimeout;

  // scrollTo absolute position
  if (args.x !== undefined || args.y !== undefined) {
    const scrollX = args.x ?? 0;
    const scrollY = args.y ?? 0;
    if (args.uid !== undefined || args.selector) {
      const { objectId, resolvedSession } = await withRetry(
        () => resolveElementObjectId(ctx, sess, args.uid, args.selector, args.tabId),
        retryTimeout,
      );
      await ctx.sendCommand('Runtime.callFunctionOn', {
        functionDeclaration: `function() { this.scrollTo({left:${scrollX},top:${scrollY},behavior:'smooth'}); }`,
        objectId,
        returnByValue: true,
      }, resolvedSession);
    } else {
      await ctx.sendCommand('Runtime.evaluate', {
        expression: `window.scrollTo({left:${scrollX},top:${scrollY},behavior:'smooth'})`,
        returnByValue: true,
      }, sess);
    }
    return ok(slimify(`Scrolled to (${scrollX}, ${scrollY})`, 'Scrolled'));
  }

  // scrollBy with direction
  const dir = args.direction || 'down';
  let deltaX = 0, deltaY = 0;
  switch (dir) {
    case 'up': deltaY = -amount; break;
    case 'down': deltaY = amount; break;
    case 'left': deltaX = -amount; break;
    case 'right': deltaX = amount; break;
  }

  if (args.uid !== undefined || args.selector) {
    const { objectId, resolvedSession } = await withRetry(
      () => resolveElementObjectId(ctx, sess, args.uid, args.selector, args.tabId),
      retryTimeout,
    );
    await ctx.sendCommand('Runtime.callFunctionOn', {
      functionDeclaration: `function() { this.scrollBy({left:${deltaX},top:${deltaY},behavior:'smooth'}); }`,
      objectId,
      returnByValue: true,
    }, resolvedSession);
  } else {
    await ctx.sendCommand('Runtime.evaluate', {
      expression: `window.scrollBy({left:${deltaX},top:${deltaY},behavior:'smooth'})`,
      returnByValue: true,
    }, sess);
  }

  return ok(slimify(`Scrolled ${dir} by ${amount}px`, 'Scrolled'));
}

async function handleUpload(ctx: ServerContext, args: InteractArgs): Promise<ToolResult> {
  if (!args.files?.length) return fail("Provide 'files' array with absolute file paths.");
  const sess = await getTabSession(ctx, args.tabId);
  const retryTimeout = args.timeout || ctx.config.actionTimeout;

  // No element specified — smart multi-target file upload
  // Monitors main page AND popup windows for file chooser dialogs or file inputs.
  if (!args.uid && !args.selector) {
    const uploadTimeout = args.timeout || 30000;
    const managedSessions = new Map<string, { targetId: string; isPopup: boolean }>();
    const popupSessionIds: string[] = [];
    let done = false;
    let masterResolve!: (result: { sessionId: string; via: string }) => void;
    let masterReject!: (err: Error) => void;

    const masterPromise = new Promise<{ sessionId: string; via: string }>((resolve, reject) => {
      masterResolve = resolve;
      masterReject = reject;
    });

    const masterTimer = setTimeout(() => {
      if (!done) {
        done = true;
        masterReject(new Error(
          `No file input or file chooser dialog found within ${uploadTimeout / 1000}s.\n` +
          'If a popup window opened (e.g. Google Drive Picker):\n' +
          '• Use tabs.list to find the popup window\n' +
          '• Snapshot the popup to find its file input or upload button\n' +
          '• Use interact.upload with uid/selector targeting the file input in the popup',
        ));
      }
    }, uploadTimeout);

    function succeed(result: { sessionId: string; via: string }): void {
      if (!done) {
        done = true;
        clearTimeout(masterTimer);
        masterResolve(result);
      }
    }

    // Universal file chooser handler — fires for ANY monitored session
    const fileChooserHandler = (sid: string, _method: string, _params: unknown): void => {
      if (managedSessions.has(sid) && !done) {
        succeed({ sessionId: sid, via: 'fileChooser' });
      }
    };

    // Add file chooser monitoring to a CDP session
    async function addMonitoring(sessId: string, targetId: string, isPopup: boolean): Promise<void> {
      if (managedSessions.has(sessId) || done) return;
      managedSessions.set(sessId, { targetId, isPopup });
      const pending = ctx.pendingFileChoosers.get(sessId) || [];
      pending.push(fileChooserHandler);
      ctx.pendingFileChoosers.set(sessId, pending);
      try {
        await ctx.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }, sessId);
      } catch { /* ok */ }
    }

    // 1. Monitor main page session for file chooser
    await addMonitoring(sess, args.tabId, false);

    // 2. Quick check: is there already a <input type="file"> on this page?
    if (await findAndSetFileInput(ctx, sess, args.files)) {
      succeed({ sessionId: sess, via: 'directInput' });
    }

    // 3. Record current tabs to detect new popups
    const tabResult = await ctx.sendCommand('Target.getTargets', {
      filter: [{ type: 'page' }],
    }) as { targetInfos: Array<{ targetId: string }> };
    const seenTargets = new Set((tabResult.targetInfos ?? []).map(t => t.targetId));

    // 4. Poll for new popup windows + scan them for file inputs
    const pollTimer = setInterval(async () => {
      if (done) return;
      try {
        const targets = await ctx.sendCommand('Target.getTargets', {
          filter: [{ type: 'page' }],
        }) as { targetInfos: Array<{ targetId: string }> };

        for (const tab of (targets.targetInfos ?? [])) {
          if (seenTargets.has(tab.targetId) || done) continue;
          seenTargets.add(tab.targetId);

          // New popup/tab — attach lightweight CDP session and monitor
          try {
            const { sessionId: psid } = await ctx.sendCommand('Target.attachToTarget', {
              targetId: tab.targetId, flatten: true,
            }) as { sessionId: string };
            popupSessionIds.push(psid);
            await ctx.sendCommand('Runtime.enable', {}, psid).catch(() => {});
            await ctx.sendCommand('Page.enable', {}, psid).catch(() => {});
            await addMonitoring(psid, tab.targetId, true);
          } catch { /* failed to attach — popup may have closed */ }
        }

        // Retry file input search on popup sessions (content may have loaded)
        for (const psid of popupSessionIds) {
          if (done) break;
          if (await findAndSetFileInput(ctx, psid, args.files!)) {
            succeed({ sessionId: psid, via: 'popupDirectInput' });
          }
        }
      } catch { /* ignore polling errors */ }
    }, 1000);

    try {
      const result = await masterPromise;

      if (result.via === 'fileChooser') {
        await ctx.sendCommand('Page.handleFileChooser', {
          action: 'accept', files: args.files,
        }, result.sessionId);
        const where = managedSessions.get(result.sessionId)?.isPopup ? ' (from popup window)' : '';
        return ok(slimify(`Uploaded ${args.files.length} file(s) via file chooser${where}: ${args.files.map(f => f.split(/[/\\]/).pop()).join(', ')}`, `Uploaded ${args.files.length}`));
      }

      if (result.via === 'popupDirectInput') {
        await sleep(1000); // let the popup process the files
        return ok(slimify(`Uploaded ${args.files.length} file(s) via popup file input: ${args.files.map(f => f.split(/[/\\]/).pop()).join(', ')}`, `Uploaded ${args.files.length}`));
      }

      // directInput on main page
      return ok(slimify(`Uploaded ${args.files.length} file(s) via file input: ${args.files.map(f => f.split(/[/\\]/).pop()).join(', ')}`, `Uploaded ${args.files.length}`));
    } catch (err) {
      return fail((err as Error).message);
    } finally {
      clearInterval(pollTimer);
      clearTimeout(masterTimer);

      // Clean up file chooser handlers
      for (const [sid] of managedSessions) {
        const pending = ctx.pendingFileChoosers.get(sid) || [];
        ctx.pendingFileChoosers.set(sid, pending.filter(h => h !== fileChooserHandler));
        try {
          await ctx.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }, sid);
        } catch { /* ok */ }
      }

      // Detach from popup sessions
      for (const psid of popupSessionIds) {
        try { await ctx.sendCommand('Target.detachFromTarget', { sessionId: psid }); } catch { /* ok */ }
        ctx.consoleLogs.delete(psid);
        ctx.networkReqs.delete(psid);
        ctx.pendingDialogs.delete(psid);
        ctx.pendingFileChoosers.delete(psid);
      }
    }
  }

  // Element specified — use direct file input approach
  const { objectId, resolvedSession } = await withRetry(
    () => resolveElementObjectId(ctx, sess, args.uid, args.selector, args.tabId),
    retryTimeout,
  );

  const { node } = await ctx.sendCommand('DOM.describeNode', { objectId }, resolvedSession) as {
    node: { backendNodeId: number };
  };
  await ctx.sendCommand('DOM.setFileInputFiles', {
    files: args.files, backendNodeId: node.backendNodeId,
  }, resolvedSession);

  return ok(slimify(`Uploaded ${args.files.length} file(s): ${args.files.map(f => f.split(/[/\\]/).pop()).join(', ')}`, `Uploaded ${args.files.length}`));
}

async function handleFocus(ctx: ServerContext, args: InteractArgs): Promise<ToolResult> {
  const sess = await getTabSession(ctx, args.tabId);
  const retryTimeout = args.timeout || ctx.config.actionTimeout;
  const { objectId, resolvedSession } = await withRetry(
    () => resolveElementObjectId(ctx, sess, args.uid, args.selector, args.tabId),
    retryTimeout,
  );

  const result = await ctx.sendCommand('Runtime.callFunctionOn', {
    functionDeclaration: `function() {
      this.scrollIntoView({ block: "center" });
      this.focus();
      return { tag: this.tagName.toLowerCase(), label: (this.getAttribute("aria-label") || this.textContent || "").trim().substring(0, 60) };
    }`,
    objectId,
    returnByValue: true,
  }, resolvedSession) as { result: { value: { tag: string; label: string; error?: string } } };

  const v = result.result.value;
  if (v?.error) return fail(v.error);
  return ok(slimify(`Focused <${v.tag}> "${v.label}"`, 'Focused'));
}

async function handleCheck(ctx: ServerContext, args: InteractArgs): Promise<ToolResult> {
  if (args.checked === undefined) return fail("Provide 'checked' (true/false).");
  const sess = await getTabSession(ctx, args.tabId);
  const retryTimeout = args.timeout || ctx.config.actionTimeout;

  const { objectId, resolvedSession } = await withRetry(async () => {
    await resolveAndCheck(ctx, sess, args.uid, args.selector, args.tabId);
    return resolveElementObjectId(ctx, sess, args.uid, args.selector, args.tabId);
  }, retryTimeout);

  await ctx.sendCommand('Runtime.callFunctionOn', {
    functionDeclaration: `function() {
      this.scrollIntoView({ block: "center" });
      const desired = ${args.checked === true};
      if (this.checked !== desired) {
        this.click();
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { checked: this.checked };
    }`,
    objectId,
    returnByValue: true,
  }, resolvedSession);

  return ok(slimify(`Checkbox: ${args.checked ? 'checked' : 'unchecked'}`, args.checked ? 'Checked' : 'Unchecked'));
}

async function handleTap(ctx: ServerContext, args: InteractArgs): Promise<ToolResult> {
  const sess = await getTabSession(ctx, args.tabId);
  const retryTimeout = args.timeout || ctx.config.actionTimeout;
  const el = await withRetry(
    () => resolveAndCheck(ctx, sess, args.uid, args.selector, args.tabId),
    retryTimeout,
  );

  // Auto-enable touch emulation
  try {
    await ctx.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true }, sess);
  } catch {
    // ok
  }

  await ctx.sendCommand('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: Math.round(el.x), y: Math.round(el.y) }],
  }, sess);
  await sleep(50);
  await ctx.sendCommand('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  }, sess);

  return ok(slimify(`Tapped <${el.tag}> "${el.label}" at (${Math.round(el.x)}, ${Math.round(el.y)})`, 'Tapped'));
}

// ─── Internal Helpers ───────────────────────────────────────────────

/**
 * Get or create a CDP session for a tab via the shared TabSessionService.
 */
async function getTabSession(ctx: ServerContext, tabId: string): Promise<string> {
  return ctx.tabSessions.getSession(ctx.cdpClient, tabId);
}

/**
 * Resolve an element's position and metadata for interaction.
 * Uses uid (preferred) or CSS selector to locate the element.
 */
async function resolveElement(
  ctx: ServerContext,
  sess: string,
  uid?: number,
  selector?: string,
  tabId?: string,
): Promise<ResolvedElement> {
  if (uid !== undefined) {
    // Resolve uid via per-tab ElementResolver → backendNodeId → box model + metadata
    const resolver = tabId ? ctx.elementResolvers.get(tabId) : undefined;
    if (!resolver) {
      throw Errors.staleRef(uid);
    }
    const backendNodeId = resolver.resolve(uid);
    if (backendNodeId === undefined) {
      throw Errors.staleRef(uid);
    }

    // Resolve backendNodeId to objectId for metadata extraction
    const { object } = await ctx.sendCommand('DOM.resolveNode', {
      backendNodeId,
    }, sess) as { object: { objectId?: string } };
    if (!object?.objectId) throw Errors.staleRef(uid);

    // Get bounding rect and element info via JS
    const info = await ctx.sendCommand('Runtime.callFunctionOn', {
      functionDeclaration: `function() {
        const r = this.getBoundingClientRect();
        return {
          x: r.x + r.width / 2, y: r.y + r.height / 2,
          w: r.width, h: r.height,
          tag: this.tagName.toLowerCase(),
          label: (this.getAttribute('aria-label') || this.textContent || '').trim().substring(0, 60),
        };
      }`,
      objectId: object.objectId,
      returnByValue: true,
    }, sess) as { result: { value: ResolvedElement | null } };

    if (!info.result.value) throw Errors.staleRef(uid);
    return info.result.value;
  }

  if (!selector) throw new Error('Provide uid or selector to identify the element.');

  const result = await ctx.sendCommand('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: r.x + r.width / 2, y: r.y + r.height / 2,
        w: r.width, h: r.height,
        tag: el.tagName.toLowerCase(),
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().substring(0, 60),
      };
    })()`,
    returnByValue: true,
  }, sess) as { result: { value: ResolvedElement | null } };

  if (!result.result.value) throw Errors.selectorNotFound(selector);
  return result.result.value;
}

/**
 * Resolve + check actionability (visible, non-zero size, enabled).
 */
async function resolveAndCheck(
  ctx: ServerContext,
  sess: string,
  uid?: number,
  selector?: string,
  tabId?: string,
): Promise<ResolvedElement> {
  // resolveElement already checks existence; add actionability checks
  const el = await resolveElement(ctx, sess, uid, selector, tabId);
  if (el.w === 0 && el.h === 0) {
    throw Errors.elementNotInteractable(uid ?? 0, 'Element has zero size — it may be hidden or collapsed.');
  }
  return el;
}

/**
 * Resolve element to a CDP objectId for Runtime.callFunctionOn.
 */
async function resolveElementObjectId(
  ctx: ServerContext,
  sess: string,
  uid?: number,
  selector?: string,
  tabId?: string,
): Promise<ResolvedElementObject> {
  if (uid !== undefined) {
    // Resolve uid via per-tab ElementResolver → backendNodeId → objectId
    const resolver = tabId ? ctx.elementResolvers.get(tabId) : undefined;
    if (!resolver) {
      throw Errors.staleRef(uid);
    }
    const backendNodeId = resolver.resolve(uid);
    if (backendNodeId === undefined) {
      throw Errors.staleRef(uid);
    }

    const { object } = await ctx.sendCommand('DOM.resolveNode', {
      backendNodeId,
    }, sess) as { object: { objectId?: string } };
    if (!object?.objectId) throw Errors.staleRef(uid);

    return { objectId: object.objectId, resolvedSession: sess };
  }

  if (!selector) throw new Error('Provide uid or selector to identify the element.');

  const result = await ctx.sendCommand('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  }, sess) as { result: { objectId?: string } };

  if (!result.result?.objectId) throw Errors.selectorNotFound(selector);

  return { objectId: result.result.objectId, resolvedSession: sess };
}

/**
 * Retry a function until it succeeds or timeout expires.
 * Mirrors the withRetry pattern from server.js.
 */
async function withRetry<T>(fn: () => Promise<T>, timeout: number): Promise<T> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeout) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      await sleep(300);
    }
  }
  throw lastError;
}

/**
 * Convert modifier key names to CDP modifier bitmask.
 */
function modifierFlags(modifiers?: string[]): number {
  if (!modifiers?.length) return 0;
  let flags = 0;
  for (const m of modifiers) {
    switch (m) {
      case 'Alt': flags |= 1; break;
      case 'Control': flags |= 2; break;
      case 'Meta': flags |= 4; break;
      case 'Shift': flags |= 8; break;
    }
  }
  return flags;
}

/** Key name → CDP key event parameters. */
interface KeyInfo {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

/**
 * Resolve a key name (e.g. "Enter", "ArrowDown", "a") to CDP key event params.
 */
function resolveKey(keyName: string): KeyInfo {
  const KEY_MAP: Record<string, KeyInfo> = {
    Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    Home: { key: 'Home', code: 'Home', keyCode: 36 },
    End: { key: 'End', code: 'End', keyCode: 35 },
    PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
    Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  };

  // F-keys
  for (let i = 1; i <= 12; i++) {
    KEY_MAP[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };
  }

  if (KEY_MAP[keyName]) return KEY_MAP[keyName];

  // Single character
  if (keyName.length === 1) {
    const code = keyName.charCodeAt(0);
    return {
      key: keyName,
      code: `Key${keyName.toUpperCase()}`,
      keyCode: code >= 97 ? code - 32 : code, // a-z → A-Z keyCode
      text: keyName,
    };
  }

  // Fallback
  return { key: keyName, code: keyName, keyCode: 0 };
}

/**
 * Get an adjacent key on the keyboard for typo simulation.
 */
function getAdjacentKey(char: string): string {
  const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
  const lower = char.toLowerCase();
  for (const row of rows) {
    const idx = row.indexOf(lower);
    if (idx >= 0) {
      const offset = Math.random() > 0.5 ? 1 : -1;
      const adjIdx = Math.max(0, Math.min(row.length - 1, idx + offset));
      const adj = row[adjIdx];
      return char === char.toUpperCase() ? adj.toUpperCase() : adj;
    }
  }
  return char; // no adjacent found
}

/**
 * Search for <input type="file"> in a page and set files directly.
 */
async function findAndSetFileInput(
  ctx: ServerContext,
  sess: string,
  files: string[],
): Promise<boolean> {
  try {
    const inputObj = await ctx.sendCommand('Runtime.evaluate', {
      expression: `(() => {
        function find(root) {
          const el = root.querySelector('input[type="file"]');
          if (el) return el;
          for (const s of root.querySelectorAll('*')) {
            if (s.shadowRoot) { const f = find(s.shadowRoot); if (f) return f; }
          }
          return null;
        }
        return find(document);
      })()`,
      returnByValue: false,
    }, sess) as { result: { objectId?: string } };

    if (!inputObj.result?.objectId) return false;

    const { node } = await ctx.sendCommand('DOM.describeNode', {
      objectId: inputObj.result.objectId,
    }, sess) as { node: { backendNodeId: number } };

    await ctx.sendCommand('DOM.setFileInputFiles', {
      files, backendNodeId: node.backendNodeId,
    }, sess);

    // Dispatch change+input events
    await ctx.sendCommand('Runtime.callFunctionOn', {
      functionDeclaration: `function() {
        this.dispatchEvent(new Event('change', { bubbles: true }));
        this.dispatchEvent(new Event('input', { bubbles: true }));
      }`,
      objectId: inputObj.result.objectId,
    }, sess).catch(() => {});

    return true;
  } catch {
    return false;
  }
}

// ─── Action Dispatch Map ────────────────────────────────────────────

const INTERACT_ACTIONS: Record<string, (ctx: ServerContext, args: InteractArgs) => Promise<ToolResult>> = {
  click: handleClick,
  hover: handleHover,
  type: handleType,
  fill: handleFill,
  select: handleSelect,
  press: handlePress,
  drag: handleDrag,
  scroll: handleScroll,
  upload: handleUpload,
  focus: handleFocus,
  check: handleCheck,
  tap: handleTap,
};

// ─── Tool Registration ──────────────────────────────────────────────

const INTERACT_DESCRIPTION = [
  'Element interaction — click, type, fill, select, press, drag, scroll, upload, focus, check, tap.',
  'Always take a snapshot first to get uid refs.',
  '',
  'Actions:',
  '- click: Click element (tabId, uid/selector; optional: button, clickCount, jsClick, modifiers, humanMode, waitFor — wait-for-element after click in same call)',
  '- hover: Hover element (tabId, uid/selector)',
  '- type: Type text (tabId, text, uid/selector; optional: clear, submit, delay, charDelay, wordDelay, typoRate)',
  '- fill: Fill multiple fields [{uid, value, type}] (tabId, fields)',
  '- select: Select dropdown option (tabId, value, uid/selector)',
  '- press: Press key (tabId, key; optional: modifiers)',
  '- drag: Drag between elements (tabId, sourceUid/sourceSelector, targetUid/targetSelector)',
  '- scroll: Scroll page/element (tabId; optional: direction, amount, x, y, uid/selector)',
  '- upload: Upload files (tabId, files; optional: uid/selector — without uid monitors for file chooser dialogs)',
  '- focus: Focus element (tabId, uid/selector)',
  '- check: Set checkbox state (tabId, checked, uid/selector)',
  '- tap: Touch tap element (tabId, uid/selector)',
  '',
  'Use uid (from snapshot) or CSS selector. UIDs preferred. Set humanMode:true for realistic mouse paths.',
].join('\n');

const INTERACT_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    action: {
      type: 'string' as const,
      enum: ['click', 'hover', 'type', 'fill', 'select', 'press', 'drag', 'scroll', 'upload', 'focus', 'check', 'tap'] as const,
      description: 'Interaction action.',
    },
    tabId: { type: 'string' as const, description: 'Tab ID.' },
    uid: { type: 'number' as const, description: 'Element uid from snapshot.' },
    selector: { type: 'string' as const, description: 'CSS selector.' },
    button: {
      type: 'string' as const,
      enum: ['left', 'right', 'middle'] as const,
      description: 'Mouse button for click.',
    },
    clickCount: { type: 'number' as const, description: 'Click count (2 = double-click).' },
    jsClick: {
      type: 'boolean' as const,
      description: "Force JavaScript el.click() instead of CDP mouse events. Use for sites like LinkedIn where CDP clicks don't trigger framework event handlers.",
    },
    modifiers: {
      type: 'array' as const,
      items: { type: 'string' as const, enum: ['Control', 'Shift', 'Alt', 'Meta'] as const },
      description: 'Modifier keys held during click, hover, or press. Matches Playwright naming.',
    },
    text: { type: 'string' as const, description: 'Text to type.' },
    clear: { type: 'boolean' as const, description: 'Clear field before typing (default: true).' },
    submit: { type: 'boolean' as const, description: 'Press Enter after typing.' },
    fields: {
      type: 'array' as const,
      description: 'Fields for fill: [{uid, selector, value, type}].',
      items: {
        type: 'object' as const,
        properties: {
          uid: { type: 'number' as const },
          selector: { type: 'string' as const },
          value: { type: 'string' as const },
          type: { type: 'string' as const, enum: ['text', 'checkbox', 'radio', 'select'] as const },
        },
        required: ['value'] as const,
      },
    },
    value: { type: 'string' as const, description: 'Value for select action.' },
    key: { type: 'string' as const, description: 'Key for press action.' },
    delay: {
      type: 'number' as const,
      description: "Delay in ms between keystrokes for type action (enables char-by-char typing like Playwright's pressSequentially).",
    },
    charDelay: {
      type: 'number' as const,
      description: 'Base delay in ms between characters within a word for human-like typing. Actual delay randomized in [charDelay, charDelay*3]. Default 200ms. Activates human-like mode.',
    },
    wordDelay: {
      type: 'number' as const,
      description: 'Base delay in ms between words (spaces/newlines) for human-like typing. Actual delay randomized in [wordDelay, wordDelay*3]. Default 800ms.',
    },
    sourceUid: { type: 'number' as const, description: 'Drag source uid.' },
    sourceSelector: { type: 'string' as const, description: 'Drag source selector.' },
    targetUid: { type: 'number' as const, description: 'Drag target uid.' },
    targetSelector: { type: 'string' as const, description: 'Drag target selector.' },
    direction: {
      type: 'string' as const,
      enum: ['up', 'down', 'left', 'right'] as const,
      description: 'Scroll direction.',
    },
    amount: { type: 'number' as const, description: 'Scroll pixels (default: 400).' },
    x: { type: 'number' as const, description: 'Scroll-to X position.' },
    y: { type: 'number' as const, description: 'Scroll-to Y position.' },
    files: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'File paths for upload.',
    },
    checked: { type: 'boolean' as const, description: 'Desired checked state for check action.' },
    waitFor: {
      type: 'object' as const,
      description: 'Optional post-click wait. Skip a separate page.wait call. Provide one of: selector, text, textGone. Parity with Playwright MCP browser_click.',
      properties: {
        selector: { type: 'string' as const, description: 'CSS selector to wait for after click.' },
        text: { type: 'string' as const, description: 'Text to wait to appear in the page after click.' },
        textGone: { type: 'string' as const, description: 'Text to wait to disappear from the page after click.' },
        state: {
          type: 'string' as const,
          enum: ['visible', 'hidden', 'attached', 'detached'] as const,
          description: 'Selector wait state (default: visible). Matches Playwright locator.waitFor states.',
        },
        timeout: { type: 'number' as const, description: 'Wait timeout in ms (default: action timeout).' },
      },
    },
    timeout: {
      type: 'number' as const,
      description: 'Retry timeout in ms for element resolution and actionability (default: CDP_ACTION_TIMEOUT). Element is polled until found+actionable or timeout.',
    },
    humanMode: {
      type: 'boolean' as const,
      description: 'Enable human-like interaction: bezier curve mouse paths with overshoot and jitter for click/hover/drag. Combine with typoRate for typing.',
    },
    autoSnapshot: {
      type: 'boolean' as const,
      description: '(Experimental — not yet implemented) Take accessibility snapshots before and after the action.',
    },
    typoRate: {
      type: 'number' as const,
      description: 'Probability of typing a wrong character then correcting (0-1, e.g. 0.03 = 3% per char). Requires charDelay or wordDelay to be set.',
    },
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
 * Register the "interact" tool with the given registry.
 *
 * The tool dispatches to the appropriate action handler based on `args.action`.
 */
export function registerInteractTools(registry: ToolRegistry, _ctx: ServerContext): void {
  registry.register(
    defineTool({
      name: 'interact',
      description: INTERACT_DESCRIPTION,
      inputSchema: INTERACT_INPUT_SCHEMA as Record<string, unknown>,
      handler: async (ctx, args) => {
        const interactArgs = args as unknown as InteractArgs;
        const action = interactArgs.action;

        if (!action) return fail("Provide 'action' parameter.");

        const handler = INTERACT_ACTIONS[action];
        if (!handler) {
          return fail(`Unknown interact action: "${action}". Available: ${Object.keys(INTERACT_ACTIONS).join(', ')}`);
        }

        try {
          return await handler(ctx, interactArgs);
        } catch (error: unknown) {
          return wrapError(error).toToolResult();
        }
      },
    }),
  );
}
