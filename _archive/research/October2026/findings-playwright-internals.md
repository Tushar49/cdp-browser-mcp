# Findings — Playwright Internals & MCP Surface (RQ-D, RQ-E)

**Date:** 2026-10-21. Sources: playwright monorepo HEAD `89cd2a6` (Playwright
MCP now lives **inside** the playwright repo:
`packages/playwright-core/src/tools/`), playwright-mcp repo, playwright.dev.
Refines `02-playwright-gap-analysis.md` with implementation facts.

## Scale correction

Playwright MCP exposes **93 tools** gated by capabilities (`core*` on by
default; `network`, `storage`, `vision`, `pdf`, `testing`, `devtools`, `video`
opt-in). Registry: `packages/playwright-core/src/tools/backend/tools.ts`.
Our 14 tools / 90+ actions remain competitive on coverage; the gap is
engine behavior, not tool count.

## D1 — Auto-wait internals (our P0 seed)

- **Actionability matrix** per action (click/dblclick/tap: visible + stable +
  receives-events + enabled + not-inert; fill: + editable; press/focus: none):
  [docs/src/actionability.md](https://github.com/microsoft/playwright/blob/89cd2a6463ea14cf36a83e629d4bfbc9988e6771/docs/src/actionability.md).
- Page-side state check runs **injected** (`ElementState` union incl.
  `stable` polled via rAF bounding-box comparison across frames):
  `packages/injected/src/injectedScript.ts#L699-746`.
- Server-side retry loop `_retryWithProgressIfNotConnected` with backoff
  **[20, 50, 100, 100, 500] ms**, retries retriable errors, bails on
  non-retriable (detached frame, invalid selector, session closed):
  `packages/playwright-core/src/server/frames.ts#L1143-1195`.
- Pointer actions also: scrollIntoView cycling 4 alignments per retry
  (`dom.ts#L385-398`), clickable-point math, then a **hit-target
  interceptor** installed before dispatch (`dom.ts#L434-505`).
- Defaults: library 30s action timeout (Node API), Test-runner per-action
  unlimited-by-default, expect 5s, test 30s.
- **Our approximation on raw CDP:** a `checkElementStates`-equivalent via
  `Runtime.evaluate` injected script (visible/stable/enabled/editable), the
  same backoff ladder, and scrollIntoView cycling before click. Hit-target
  interception can be approximated with `document.elementFromPoint` at the
  click point before dispatch.

## D2 — Raw input over CDP (our mouse-xy seed)

- All of it is thin over `Input.dispatchMouseEvent`
  (`mouseMoved`/`mousePressed`/`mouseReleased`/`mouseWheel` with
  `deltaX/deltaY`, `clickCount`, `buttons` mask, `force:0.5` when dragging):
  `packages/playwright-core/src/server/chromium/crInput.ts#L105-166`.
- Text: `Input.insertText` for layout-less chars; keyboard: `rawKeyDown` /
  `keyDown` / `keyUp` with `windowsVirtualKeyCode` from `USKeyboardLayout`
  (`usKeyboardLayout.ts`).
- Touch tap = `touchStart`(+point) → `touchEnd`(empty) pair.
- Drag bookkeeping: `DragManager.interceptDragCausedByMove` suppresses
  press/release during moves.
- **Conclusion:** our `interact.mouse_*` seed is trivial on raw CDP —
  `Input.dispatchMouseEvent` directly, no Playwright machinery required.

## D3 — Frames & devices

- Frame piercing = selector-chain control parts (`internal:control` =
  `enter-frame`), walking `contentFrame()` per chunk with visibility tracking:
  `frameSelectors.ts#L128-197`. Our equivalent: frame-qualified UIDs from a
  per-frame a11y snapshot merge (see gap doc P1-4).
- Device registry: `packages/isomorphic/deviceDescriptorsSource.json`; fields
  `userAgent, viewport{width,height}, deviceScaleFactor, isMobile, hasTouch,
  defaultBrowserType`. Our `emulate.device` seed can vendor this JSON (Apache-2.0)
  or generate a minimal subset for Chromium-family only.

## D4 — storageState (our one-shot seed)

- Schema: `{ cookies: [{name,value,domain,path,expires,httpOnly,secure,sameSite[,partitionKey]}],
  origins: [{origin, localStorage:[{name,value}]}] }`
  (browsercontext.md L1533-1551; v1.51+ `indexedDB`, v1.62+ credentials).
- Save: `context.storageState({path})`; restore:
  `newContext({storageState})` or `context.setStorageState()`.
- Playwright MCP tools: `browser_storage_state`, `browser_set_storage_state`
  (clears before restore) — `tools/backend/storage.ts#L25-48`.
- Our seed: `storage.export_state`/`import_state` wrapping existing
  `Network.getAllCookies` + `Runtime.evaluate` localStorage dump / seed —
  one new action pair, no new deps.

## E1 — Playwright MCP tool inventory (highlights vs ours)

Present in theirs, absent in ours (beyond gap doc): `browser_find`
(token-cheap regex search of the a11y tree with context — we have
`page.snapshot search`, roughly at parity), `browser_verify_*` assertion
family (structured agentic self-checks), `browser_run_code_unsafe`
(server-process Node `vm` with `page` injected — documented RCE-equivalent),
`browser_start/stop_recording` (user-action codegen), `browser_start/stop_tracing`
(Trace-Viewer-compatible output), video suite (start/stop, chapter cards,
action callouts), `browser_webmcp_list/call` (page-registered WebMCP
passthrough), `browser_generate_locator`, `browser_annotate`.

## E2 — Modes / competitive read (E3)

Four browser-acquisition modes:

1. `--cdp-endpoint` — `connectOverCDP` attach to a running Chromium-family
   browser. First-class, documented.
2. `--extension` — attaches to the user's **real running profile** via their
   MV3 extension CDP relay (`packages/extension`, `tools/mcp/cdpRelay.ts`).
   This is the exact architecture our `extension/` MV3 scaffold (v5.1 plan)
   anticipated — validates our roadmap; their relay is open source and
   readable for design reference.
3. Managed persistent profile (default) — `launchPersistentContext` with a
   per-workspace-hash profile dir; single-instance lock conflicts documented.
4. `--isolated` — in-memory, seedable via `--storage-state`.

Read: their "real profile" story is real but indirect (extension relay or
persistent-but-not-your-profile). Our attach identity stays defensible; the
extension relay is the strategic convergence point to watch.

## E4 — Cheap ideas worth stealing (design notes only)

- **Response-as-codegen**: every tool response appends equivalent script
  lines (`response.addCode`) — sessions become replayable for free.
- **Verify family**: assertion-shaped tools returning pass/fail instead of
  dumps — better agent loops than snapshot-and-grep.
- **Hygiene switches**: `--redact-url-params`, `--image-responses omit`,
  `--blocked-origins`, `--idle-timeout` — small, trust-building options.
- **Snapshot `depth`/`boxes` params** — complements our token optimizer.
