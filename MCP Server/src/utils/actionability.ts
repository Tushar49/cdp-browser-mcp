/**
 * Actionability gate (5.1.0 A1) — Playwright-style element checks on raw CDP.
 *
 * One injected check evaluates: visible (non-empty box, not hidden),
 * enabled (no disabled/aria-disabled/fieldset[disabled]), editable (not
 * readOnly/aria-readonly for inputs, or contentEditable), and hit-target
 * (document.elementFromPoint at center resolves to the element or a
 * descendant). "Stable" = identical bounding box across consecutive rounds.
 *
 * Polling uses a Playwright-shaped backoff ladder [20, 50, 100, 100, 500] ms
 * (500 steady afterwards) within the action's retry timeout. Deadline
 * exceeded → ActionableError naming the failed state with a `force` hint.
 *
 * The same JS body runs via Runtime.callFunctionOn (uid path, `this` bound)
 * or Runtime.evaluate (selector path) — single source of truth.
 */

import { ActionableError } from './error-handler.js';

export type ActionabilityState = 'visible' | 'stable' | 'enabled' | 'editable';

/** Playwright-verified backoff shape, then 500ms steady. */
export const ACTIONABILITY_LADDER = [20, 50, 100, 100, 500];

/** Marker string inside the injected script — tests assert gate vs non-gate calls. */
export const ACTIONABILITY_FN_NAME = '__cdpActionabilityCheck';

interface RoundResult {
  present: boolean;
  visible?: boolean;
  enabled?: boolean;
  editable?: boolean;
  stable?: boolean;
  hitOk?: boolean;
  hitTag?: string;
  box?: { x: number; y: number; w: number; h: number };
}

type SendFn = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;

// ─── Injected JS (single source of truth) ───────────────────────────

/**
 * Pure function body: (el, prevBox) → RoundResult. Shared between the
 * callFunctionOn wrapper (uid path) and the evaluate wrapper (selector path).
 */
const CHECK_BODY = `
  function __cdpActionabilityCheck(el, prevBox) {
    if (!el || !el.isConnected) return { present: false };
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const visible = r.width > 0 && r.height > 0
      && style.visibility !== 'hidden' && style.display !== 'none';
    const disabled = el.disabled === true
      || el.getAttribute('aria-disabled') === 'true'
      || (el.closest && el.closest('fieldset[disabled]') !== null);
    const enabled = !disabled;
    const editable = el.isContentEditable === true
      || ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.readOnly && !disabled);
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    let hitOk = true, hitTag = '';
    if (visible) {
      const hit = document.elementFromPoint(cx, cy);
      hitTag = hit ? hit.tagName.toLowerCase() : '(nothing)';
      hitOk = !!hit && (hit === el || el.contains(hit) || hit.contains(el));
    }
    const box = { x: r.x, y: r.y, w: r.width, h: r.height };
    const stable = prevBox != null
      && Math.abs(prevBox.x - box.x) < 0.5 && Math.abs(prevBox.y - box.y) < 0.5
      && Math.abs(prevBox.w - box.w) < 0.5 && Math.abs(prevBox.h - box.h) < 0.5;
    return { present: true, visible, enabled, editable, hitOk, hitTag, box, stable };
  }
`;

const CALL_FN_WRAPPER = `function(prevBoxJson) {
  ${CHECK_BODY}
  const prevBox = prevBoxJson ? JSON.parse(prevBoxJson) : null;
  return __cdpActionabilityCheck(this, prevBox);
}`;

const EVALUATE_WRAPPER = (selector: string, prevBoxJson: string) => `(() => {
  ${CHECK_BODY}
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { present: false };
  const prevBox = ${prevBoxJson ? `JSON.parse(${JSON.stringify(prevBoxJson)})` : 'null'};
  return __cdpActionabilityCheck(el, prevBox);
})()`;

// ─── Ladder retry (consolidates 3 prior implementations) ────────────

export interface LadderOptions {
  timeoutMs: number;
  ladder?: number[];
}

/**
 * Deadline-based retry with the Playwright-shaped delay ladder.
 * Re-throws the last error when the deadline expires.
 */
export async function retryWithLadder<T>(
  fn: (attempt: number) => Promise<T>,
  opts: LadderOptions,
): Promise<T> {
  const ladder = opts.ladder ?? ACTIONABILITY_LADDER;
  const deadline = Date.now() + opts.timeoutMs;
  let attempt = 0;
  let lastError: unknown;
  for (;;) {
    try {
      return await fn(attempt++);
    } catch (e) {
      lastError = e;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const delay = Math.min(
      ladder[Math.min(attempt - 1, ladder.length - 1)] ?? 500,
      remaining,
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw lastError;
}

// ─── Gate runner ────────────────────────────────────────────────────

export interface GateFailure {
  state: ActionabilityState | 'present' | 'hit-target';
  detail: string;
}

export class ActionabilityError extends ActionableError {
  /** Non-retriable by design: the ladder already ran to the deadline. */
  constructor(failure: GateFailure, forceHint = true) {
    super(
      `Element is not ${failure.state}: ${failure.detail}`,
      forceHint
        ? 'Wait for the page to settle and retry, or pass force: true to skip actionability checks.'
        : 'Wait for the page to settle and retry.',
      { state: failure.state },
    );
  }
}

export interface GateTarget {
  objectId?: string;
  selector?: string;
}

export interface GateOptions {
  states: ActionabilityState[];
  /** Include document.elementFromPoint hit-target verification (pointer actions). */
  hitCheck?: boolean;
  timeoutMs: number;
}

function describeFailure(
  round: RoundResult,
  states: ActionabilityState[],
  hitCheck?: boolean,
): GateFailure | null {
  if (!round.present) return { state: 'present', detail: 'element is detached or not mounted yet' };
  for (const state of states) {
    if (state === 'stable') {
      if (round.stable === false) {
        return { state: 'stable', detail: 'element is animating or moving (bounding box changing)' };
      }
      continue;
    }
    if (state === 'visible' && round.visible === false) {
      return { state: 'visible', detail: 'zero-size, display:none, or visibility:hidden' };
    }
    if (state === 'enabled' && round.enabled === false) {
      return { state: 'enabled', detail: 'element is disabled or aria-disabled' };
    }
    if (state === 'editable' && round.editable === false) {
      return { state: 'editable', detail: 'element is readonly or not editable' };
    }
  }
  if (hitCheck && states.includes('visible') && round.hitOk === false) {
    return { state: 'hit-target', detail: `point is obscured by <${round.hitTag}>` };
  }
  return null;
}

/**
 * Run the actionability gate for one element until all requested states
 * pass or the deadline expires. All rounds re-run the full check; `stable`
 * compares each round's box to the previous round's.
 */
export async function runActionabilityGate(
  send: SendFn,
  sess: string,
  target: GateTarget,
  opts: GateOptions,
): Promise<void> {
  let prevBox: { x: number; y: number; w: number; h: number } | null = null;

  await retryWithLadder(async () => {
    let round: RoundResult;
    if (target.objectId) {
      const resp = (await send('Runtime.callFunctionOn', {
        functionDeclaration: CALL_FN_WRAPPER,
        objectId: target.objectId,
        arguments: [{ value: prevBox ? JSON.stringify(prevBox) : null }],
        returnByValue: true,
      }, sess)) as { result?: { value?: RoundResult } };
      round = resp.result?.value ?? { present: false };
    } else {
      const resp = (await send('Runtime.evaluate', {
        expression: EVALUATE_WRAPPER(target.selector ?? '', prevBox ? JSON.stringify(prevBox) : ''),
        returnByValue: true,
      }, sess)) as { result?: { value?: RoundResult } };
      round = resp.result?.value ?? { present: false };
    }

    if (round.present && round.box) prevBox = round.box;

    const failure = describeFailure(round, opts.states, opts.hitCheck);
    if (failure) throw new Error(`${failure.state}: ${failure.detail}`);
  }, { timeoutMs: opts.timeoutMs }).catch((e) => {
    if (e instanceof ActionableError) throw e;
    const m = String(e?.message ?? e);
    const stateMatch = m.match(/^([a-z-]+): (.*)$/);
    if (stateMatch) {
      throw new ActionabilityError({
        state: stateMatch[1] as GateFailure['state'],
        detail: stateMatch[2],
      });
    }
    throw new ActionabilityError({ state: 'present', detail: m });
  });
}

/**
 * Scroll an element into view before pointer actions. Prefers the native
 * CDP call (object path), falls back to JS for the selector path.
 */
export async function scrollIntoViewIfNeeded(
  send: SendFn,
  sess: string,
  target: GateTarget,
): Promise<void> {
  try {
    if (target.objectId) {
      await send('DOM.scrollIntoViewIfNeeded', {
        objectId: target.objectId,
        rect: undefined,
      }, sess);
      return;
    }
    await send('Runtime.evaluate', {
      expression:
        `(function(){ const el = document.querySelector(${JSON.stringify(target.selector ?? '')});` +
        ` if (el && el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(true);` +
        ` else if (el) el.scrollIntoView({ block: 'center' }); })()`,
    }, sess);
  } catch {
    // scroll is best-effort; the hit-target check catches real misses
  }
}
