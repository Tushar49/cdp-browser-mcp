# Tool Parity Gaps - v5.0.0-alpha.4

> **Date:** 2026-05-13
> **Source:** Distilled from `.research/ToolComparison.md`, `.research/CompetitiveAnalysis.md`, `.research/PlaywrightMCP.md`
> **Purpose:** Identify single-call equivalents in Playwright MCP that we currently require multiple calls for, and propose surgical fixes.

---

## Top 10 Parity Gaps (single-call equivalence)

These are sequences where Playwright MCP completes a workflow in 1 call but we require 2-5. Pulled from the research files.

| # | Gap | Playwright | Ours (today) | Calls saved | Implementable? |
|---|-----|-----------|--------------|-------------|----------------|
| 1 | **Click-then-wait-for-element** | `browser_click` followed by auto `waitForCompletion()` (network + DOM settle); explicit `browser_wait_for` accepts `text/textGone/time` | `interact.click` + separate `page.wait` | 1 -> 2 | YES (surgical: add `waitFor` to click) |
| 2 | **localStorage / sessionStorage R/W** | `browser_localstorage_get/set/clear`, `browser_sessionstorage_*` (opt-in `storage` cap) | We only have `storage.clear_data` (deletes everything for an origin), no per-key R/W | 1 -> 0 (impossible today, must use `execute.eval`) | YES (surgical: add 3 actions to `storage`) |
| 3 | **Get response body without listing first** | `browser_network_requests` returns each request with body inline (paginated) | `observe.network` lists; `observe.request` requires `requestId` from that listing | 1 -> 2 | YES (surgical: add `urlFilter` to `observe.request`) |
| 4 | **Fill multiple fields in one call** | `browser_fill_form` accepts `fields: [{ref, value, type}]` | `interact.fill` and `form.fill` already accept batch arrays | 1 -> 1 (already at parity) | DONE |
| 5 | **File chooser modal pattern** | `browser_file_upload` triggered by file chooser modal state | `interact.upload` already monitors `Page.fileChooserOpened` and accepts files in one call (popup-aware) | 1 -> 1 | DONE |
| 6 | **Vision mouse (x/y click)** | `browser_mouse_click_xy` (opt-in `vision` cap) | `interact.click` requires uid or selector; cannot click pure (x,y) without resolving an element | 1 -> 2 (snapshot + click) | YES (surgical: accept `x`/`y` on click) - **deferred (see below)** |
| 7 | **Auto-snapshot post-action** | Every input tool returns a fresh snapshot in the response | `interact.*` only returns text result; `autoSnapshot` param marked "experimental, not yet implemented" | 1 -> 2 (act + snapshot) | NO (>100 lines: must wire snapshot into every action handler + invalidate cache) - **deferred** |
| 8 | **Modal state enforcement** | `defineTabTool` blocks tools when dialog/file chooser open | `ModalStateManager` already exists with `checkBlocked()` (see `modal-state.test.ts`) | n/a | DONE |
| 9 | **Adaptive timeouts on emulation** | Throttle multipliers scale wait timeouts | We have `CDP_ACTION_TIMEOUT` global only | 1 -> 1 (works but blunt) | NO (would need cross-tool timeout middleware) - **deferred** |
| 10 | **Storage state save/restore** | `browser_storage_state` / `browser_set_storage_state` serialize cookies+localStorage to JSON | We can serialize cookies via `storage.get_cookies` but not localStorage | 1 -> N | YES (subset of #2 above) |

---

## Top 5 with concrete fixes

| Rank | Gap | Surgical Change | Tool File | LOC est. |
|------|-----|-----------------|-----------|----------|
| 1 | Click + wait-for-element in 1 call | New `waitFor` param on `interact.click` action | `interact.ts` | ~50 |
| 2 | localStorage / sessionStorage R/W | Three new actions on `storage` tool: `get_storage`, `set_storage`, `delete_storage` | `storage.ts` | ~80 |
| 3 | Response body lookup without listing | New `urlFilter` param on `observe.request` action | `observe.ts` | ~30 |
| 4 | Vision mouse x/y click | Allow `x`/`y` on `interact.click` (no uid/selector) - **deferred** | `interact.ts` | ~40 |
| 5 | Auto-snapshot after action | Wire snapshot into action handlers - **deferred** | `interact.ts` + `snapshot/` | >150 |

---

## Implemented in this session (top 3)

### Fix 1: `interact.click` `waitFor` parameter

**Problem:** After clicking a button (e.g. "Easy Apply"), agents must call `page.wait { selector / text }` to confirm the next state appeared. Two tool calls for one logical action.

**Fix:** Add optional `waitFor` object on `interact.click`:

```ts
waitFor?: {
  selector?: string;            // wait for CSS selector
  text?: string;                // wait for text to appear
  textGone?: string;            // wait for text to disappear
  state?: 'visible' | 'hidden' | 'attached' | 'detached'; // for selector
  timeout?: number;             // ms (default: actionTimeout)
}
```

When present, runs the same `waitForSelector` / `waitForText` / `waitForTextGone` helpers used by `page.wait` after the click completes. Result string includes the wait outcome.

**Parity rationale:** Playwright MCP `browser_click` auto-waits via `waitForCompletion()` (network settle + DOM stability). This gives agents an explicit, deterministic wait-for-element variant in the same call.

### Fix 2: `storage` web storage R/W

**Problem:** No way to read or write a single `localStorage` / `sessionStorage` key. The only option today is `execute.eval` with arbitrary JS, which is verbose, error-prone, and bypasses the typed storage tool.

**Fix:** Three new actions on `storage`:

- `get_storage` — reads `localStorage` / `sessionStorage` (whole object or single key)
- `set_storage` — sets `key=value` in chosen storage area
- `delete_storage` — removes a key (or all keys) from chosen storage area

New `storageType` param: `"local" | "session"` (default: `"local"`).

**Parity rationale:** Playwright MCP exposes `browser_localstorage_*` and `browser_sessionstorage_*` tools (opt-in storage cap). Bringing this into our existing `storage` tool keeps the tool surface flat and matches what agents expect.

### Fix 3: `observe.request` `urlFilter`

**Problem:** Reading the response body of an XHR requires two calls: `observe.network { filter }` to find the requestId, then `observe.request { requestId }` to fetch the body.

**Fix:** Allow `urlFilter` (string substring) as an alternative to `requestId`. Picks the most recent request matching the filter from `ctx.networkReqs`, then proceeds as before.

**Parity rationale:** Playwright MCP `browser_network_requests` returns request bodies inline with the listing. Our split (list vs body-fetch) is more token-efficient but costs an extra round-trip. The `urlFilter` shortcut closes the gap when the agent already knows the URL pattern.

---

## Deferred (top-5 fixes #4 and #5) - for next session

### Skipped: Vision mouse x/y click (gap #6)

**Why deferred:** While the change to `interact.click` itself is small (~40 LOC), it conflicts conceptually with the existing `x`/`y` params on `scroll` (which mean "scroll-to position"). Adding click semantics on the same fields would force a special-case in dispatch (`if action === 'click' && x && y && !uid && !selector`). Cleaner solution is a new `coordinates: { x, y }` object on click, but that's a schema breakage worth its own RFC.

**Workaround today:** Use `execute.script` with `document.elementFromPoint(x, y).click()`.

### Skipped: Auto-snapshot post-action (gap #7)

**Why deferred:** Real implementation needs:
1. Each action handler in `interact.ts` (12 handlers) must opt-in to a post-action snapshot.
2. Snapshot cache (`snapshot-cache.ts`) must be invalidated automatically (we currently invalidate on `page.snapshot` only).
3. The response shape changes — currently `ok(string)`; would need to become `{ text, snapshot }` and propagate through `slim-mode` mapping.

Estimated 150+ LOC across 4 files. Doing it surgically risks half-implementing the contract. The `autoSnapshot` flag in the schema is already marked "experimental — not yet implemented" so agents are warned.

**Workaround today:** Call `page.snapshot { diff: true }` after the action — diff mode keeps tokens low.

---

## Verification

- All 3 fixes compile under `tsc --noEmit`.
- New unit tests added in `MCP Server/src/__tests__/unit/`:
  - `interact-click-wait-for.test.ts` — schema includes `waitFor`, dispatch is wired.
  - `storage-web-storage.test.ts` — schema includes new actions and `storageType`, evaluate expression is built correctly.
  - `observe-request-url-filter.test.ts` — schema includes `urlFilter`, requestId is picked from `ctx.networkReqs`.
- Full test suite still green (`npm test`).
