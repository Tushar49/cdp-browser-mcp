/**
 * Smart waiting utilities extracted from the server.js monolith.
 *
 * Provides Playwright-inspired wait strategies for page readiness,
 * text polling, selector polling, and post-action network settling.
 */

// ─── Types ──────────────────────────────────────────────────────────

/** Function signature for sending CDP commands. */
export type CdpSend = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
  timeout?: number,
) => Promise<Record<string, unknown>>;

export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle' | 'commit';

export type SelectorState = 'visible' | 'hidden' | 'attached' | 'detached';

// ─── sleep ──────────────────────────────────────────────────────────

/** Promise-based delay. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── waitForReadyState ──────────────────────────────────────────────

/**
 * Wait for the page to reach a ready state (like Playwright's waitUntil):
 *
 * - `"load"` — `document.readyState === "complete"` (default)
 * - `"domcontentloaded"` — `document.readyState !== "loading"`
 * - `"networkidle"` — readyState complete + no pending resource loads for 500 ms
 * - `"commit"` — returns immediately (navigation response received)
 */
export async function waitForReadyState(
  cdpSend: CdpSend,
  sessionId: string,
  waitUntil: WaitUntil,
  timeout: number,
): Promise<void> {
  if (waitUntil === 'commit') return;

  const start = Date.now();
  const target = waitUntil === 'domcontentloaded' ? 'interactive' : 'complete';

  while (Date.now() - start < timeout) {
    try {
      const r = await cdpSend(
        'Runtime.evaluate',
        { expression: 'document.readyState', returnByValue: true },
        sessionId,
        3000,
      );
      const state = (r as { result: { value: string } }).result.value;
      if (target === 'interactive' && state !== 'loading') break;
      if (target === 'complete' && state === 'complete') break;
    } catch {
      /* page transitioning */
    }
    await sleep(500);
  }

  // For networkidle, also wait for no pending resource loads for 500 ms
  if (waitUntil === 'networkidle') {
    const idleStart = Date.now();
    let lastActivity = Date.now();
    while (
      Date.now() - idleStart <
      Math.min(5000, timeout - (Date.now() - start))
    ) {
      try {
        const r = await cdpSend(
          'Runtime.evaluate',
          {
            expression: `performance.getEntriesByType('resource').filter(e => e.responseEnd === 0).length`,
            returnByValue: true,
          },
          sessionId,
          2000,
        );
        if ((r as { result: { value: number } }).result.value > 0)
          lastActivity = Date.now();
        if (Date.now() - lastActivity > 500) break;
      } catch {
        break;
      }
      await sleep(200);
    }
  }
}


// ─── waitForText ────────────────────────────────────────────────────

/**
 * Poll until `text` appears in the page body, or timeout expires.
 * Returns `true` if found, `false` on timeout.
 */
export async function waitForText(
  cdpSend: CdpSend,
  sessionId: string,
  text: string,
  timeout: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await cdpSend(
        'Runtime.evaluate',
        {
          expression: `document.body.innerText.includes(${JSON.stringify(text)})`,
          returnByValue: true,
        },
        sessionId,
        5000,
      );
      if ((r as { result: { value: boolean } }).result.value === true)
        return true;
    } catch {
      /* page may be transitioning */
    }
    await sleep(300);
  }
  return false;
}

// ─── waitForTextGone ────────────────────────────────────────────────

/**
 * Poll until `text` is no longer present in the page body, or timeout expires.
 * Returns `true` if disappeared, `false` on timeout.
 */
export async function waitForTextGone(
  cdpSend: CdpSend,
  sessionId: string,
  text: string,
  timeout: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await cdpSend(
        'Runtime.evaluate',
        {
          expression: `!document.body.innerText.includes(${JSON.stringify(text)})`,
          returnByValue: true,
        },
        sessionId,
        5000,
      );
      if ((r as { result: { value: boolean } }).result.value === true)
        return true;
    } catch {
      /* page may be transitioning */
    }
    await sleep(300);
  }
  return false;
}

// ─── waitForSelector ────────────────────────────────────────────────

/**
 * Poll until a CSS selector matches an element in the specified state,
 * or timeout expires.  Mirrors Playwright's `locator.waitFor({ state })`.
 */
export async function waitForSelector(
  cdpSend: CdpSend,
  sessionId: string,
  selector: string,
  state: SelectorState,
  timeout: number,
): Promise<boolean> {
  const start = Date.now();

  let expr: string;
  switch (state) {
    case 'detached':
      expr = `!document.querySelector(${JSON.stringify(selector)})`;
      break;
    case 'hidden':
      expr = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return !el || el.offsetParent === null || getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).display === 'none'; })()`;
      break;
    case 'visible':
      expr = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none'; })()`;
      break;
    default: // 'attached'
      expr = `!!document.querySelector(${JSON.stringify(selector)})`;
  }

  while (Date.now() - start < timeout) {
    try {
      const r = await cdpSend(
        'Runtime.evaluate',
        { expression: expr, returnByValue: true },
        sessionId,
        5000,
      );
      if ((r as { result: { value: boolean } }).result.value === true)
        return true;
    } catch {
      /* page may be transitioning */
    }
    await sleep(300);
  }
  return false;
}
