# Release Plan — v5.1.0 "Engine + Protocol Freshness" (EXTREME DETAIL)

**Status:** planning complete, implementation authorized (2026-10-21).
**Decisions locked:** engine + CDP freshness TOGETHER in 5.1.0; WebAuthn → 5.2
(Puppeteer-parity justification); FedCm stays watch-only (no competitor
exposes it — Playwright MCP, Puppeteer MCP, chrome-devtools-mcp all lack
FedCm automation); README compat table shipped with 5.0.3 polish; start now.
**Versioning:** semver, minor bump → 5.1.0 at release.

Ground truth anchors come from the code map of 2026-10-21 (file:line against
`MCP Server/src`) and Playwright internals research (`89cd2a6`). All paths
relative to `MCP Server/src`.

## 0. Non-negotiable rules (from 5.0.3, carry forward)

1. Tool contract additive-only; existing actions keep behavior unless a
   default-on flag is explicitly part of the design (`force` escape).
2. No new runtime deps. Device descriptors = vendored JSON (Apache-2.0,
   attributed), not a dependency.
3. No new domain-enable requirements for existing paths (`Input.*` and
   `Emulation.*` work unenabled today — verified; keep it that way, or gate
   new enables behind the capability report).
4. Every workstream lands with unit tests green + live checklist before the
   next starts (5.0.3 phase discipline).
5. Version bump (package.json + VERSION together) only in the release commit;
   CHANGELOG [Unreleased] accumulates from the first workstream commit.

---

## Workstream A — Engine (the Playwright-gap closers)

### A1. Auto-wait gate (largest item — do after B1)

**Problem (code-verified):** `resolveAndCheck` (`interact.ts:1027-1040`)
checks ONLY zero-size (`elementNotInteractable`). No visibility, stability,
enabled, editable, or hit-target checks. Mouse clicks never scroll into view
(scroll happens only in JS paths: `interact.ts:345, 451, 531, 879, 904`).
Retry = local `withRetry` 300ms deadline loop (`interact.ts:1087-1099`).

**Design — new `utils/actionability.ts`:**

```
checkActionable(sess, objectId, states: State[], timeout): Promise<void>
  State = 'visible' | 'stable' | 'enabled' | 'editable'
```

- One injected function per poll round via `Runtime.callFunctionOn(objectId)`:
  bounding box (visible = non-empty + not `visibility:hidden`), computed
  `pointer-events` + hit-target (`document.elementFromPoint(cx,cy)` chain
  contains element), `disabled`/`aria-disabled`/fieldset (enabled),
  `readOnly`/`aria-readonly` (editable).
- **Stable** = same bounding box across 2 consecutive rAF frames — poll with
  `requestAnimationFrame` counting inside the injected script, or two
  evaluate rounds ≥1 frame apart. Implement as: injected async function that
  awaits 2 rAFs and compares boxes; outer retry re-runs it.
- **Backoff ladder** `[20, 50, 100, 100, 500]` ms (Playwright-verified shape),
  then 500ms steady; deadline = existing `retryTimeout` (CDP_ACTION_TIMEOUT).
- **Scroll:** `DOM.scrollIntoViewIfNeeded {objectId}` (currently unused in
  codebase — perfect fit) before pointer actions when off-viewport; fall back
  to JS `scrollIntoView({block:'center'})` on error. Cycle 4 alignments
  (center/end/nearest/start) across retries for sticky-overlay escape.
- **Hit-target intercept:** before `mousePressed`, evaluate
  `document.elementFromPoint(x,y)` at the resolved click point; if the
  element isn't in the chain → wait + rescroll (retry), not blind click.

**Integration points (exact):**

| Site | Change |
|---|---|
| `interact.ts:1027-1040` `resolveAndCheck` | after zero-size check, call `checkActionable` with per-action state set: click/hover/tap/drag → `visible,stable,enabled`; type/fill → `visible,enabled,editable`; select → `visible,enabled` |
| `interact.ts:250-275` (mouse click path) | `DOM.scrollIntoViewIfNeeded` + hit-target eval before `mousePressed`; on miss → one retry cycle |
| `interact.ts:296-320` hover, `594-641` drag, `919-945` tap | same gate (drag: also hit-target at both endpoints) |
| `interact.ts:322-433` type, `435-495` fill | editable gate before JS fill |
| All actions | new `force?: boolean` param → skips gate entirely (escape hatch, default false) |

**Retry consolidation (dead-code cleanup, same PR):**

- Delete interact-local `withRetry` (`interact.ts:1087-1099`) and
  `utils/retry.ts` `retryElementAction` (`:83-106`, unused) + generic
  `withRetry` (`:36-68`, unused); replace with ONE
  `utils/actionability.ts::retryWithLadder(fn, {timeout, ladder})`.
- `utils/wait.ts` `waitForCompletion` (`:112-215`, exported, unused): either
  wire it into `interact` post-action settle (replacing hand-rolled
  `waitForNetworkSettle` `interact.ts:29-66`) or delete. Decide during
  implementation — default: wire, it subsumes the network-settle poll.

**Config:** `CDP_AUTO_WAIT` (default `true`), read in `config.ts`; `false`
restores 5.0.3 behavior (belt for edge-case pages).

**Tests (unit):**
- Ladder timing: fake evaluate results sequence (not-visible×3 → visible) →
  assert poll delays match ladder shape and total < deadline.
- State matrix: disabled element → gate blocks click with actionable error
  naming the state; editable-only blocks fill; `force:true` bypasses.
- Hit-target: elementFromPoint returns other element → retry, then error
  `Errors.actionBlocked('obscured by …')` (new catalog entry).
- Regression: existing interact tests green unchanged with gate ON and
  force-compatible; zero-size error text unchanged.
**Live:** D365/SharePoint-style slow page (or any animation-heavy site):
click during entry animation → gate waits → click lands; `force` clicks
immediately. 
**Effort:** 2–3 sessions. **Risk:** injected-script edge cases (shadow DOM —
use `composedPath()` in hit-target check; note in code).

### A2. Raw mouse + wheel (small, high value)

**Problem:** no coordinate-based input; `scroll` is JS scrolling
(`interact.ts:643-699`), wheel events never dispatched; drag lacks HTML5 dnd
(`Input.dispatchDragEvent` unused).

**Design — new `interact` actions (add to `INTERACT_ACTIONS` map
`interact.ts:1239-1252` + schema enum):**

- `mouse_move {x, y, humanMode?}` → `Input.dispatchMouseEvent mouseMoved`
- `mouse_down {button?, modifiers?}` / `mouse_up` → `mousePressed`/`mouseReleased`
- `click_xy {x, y, button?, clickCount?, humanMode?}` → move+press+release
  (reuse bezier path generator `utils/helpers.ts:77-147` when humanMode)
- `wheel {deltaX, deltaY, x?, y?}` → `Input.dispatchMouseEvent
  type:'mouseWheel'` (viewport-coords optional; target the session — xy
  actions are viewport-based so main-frame session only; OOP-frame routing
  NOT needed here, but fix `getRefSession` dead code separately, see A5)

**Reuse:** `buttons` map (`interact.ts:244-245`), `modifierFlags`
(`interact.ts:1104-1116`), session getter (`interact.ts:952-954`).
**No actionability gate** (no element), but `click_xy` documents that
hit-target verification is the caller's job.

**Tests:** unit — action map wiring, schema validation, modifier bitmask;
live — canvas/map site: click_xy lands, wheel scrolls viewport.
**Effort:** 1 session.

### A3. storageState one-shot

**Problem:** cookies + web storage managed per-call; no auth-state snapshot.

**Design — new `storage` actions (switch `storage.ts:328-341` + enum `306`):**

- `export_state {includeSessionStorage?: boolean}` →
  `{ cookies: NetworkCookie[], origins: [{origin, localStorage: [{name,value}]}] }`
  (Playwright-compatible schema). Cookies via existing `Network.getCookies`
  (`storage.ts:22-26`); localStorage per origin via existing
  `buildGetStorageExpression('localStorage')` full-object form
  (`storage.ts:197-205`) — enumerate origins from cookie domains
  (https:// + host). Optional extension (behind the same action):
  `browserContextId` scoping via `Storage.getCookies {browserContextId}` —
  `AgentSession.browserContextId` already tracked (`session-manager.ts:22-23`,
  `dispatch.ts:77-88`) but unused in storage.ts; wire it for profile-scoped
  exports.
- `import_state {state | path, clearFirst?: boolean}` →
  `Network.setCookie` loop (existing `set_cookie` logic `storage.ts:40-71`,
  minus per-call enable) + per-origin `set_storage` loops. `clearFirst`
  runs `clear_cookies` + `clear_data` per origin first.
- File I/O: accept inline `state` object; `path` support via
  `utils/temp-files.ts`-adjacent fs helper (absolute paths only, matches
  upload/screenshot conventions).
- **IndexedDB: out of scope** (Playwright gates it behind opt-in too) — note
  in docs.

**Tests:** unit — round-trip export→clear→import on a synthetic page
(integration-style with real temp profile in `__tests__/integration` per
repo pattern), schema shape, clearFirst ordering; privacy — state file never
logged inline (60k cap guard).
**Live:** log into any site → export → clear cookies → import → still logged
in.
**Effort:** 1–1.5 sessions.

### A4. Device presets

**Design:** new `connection/../devices.ts`? No — `tools/device-presets.ts` +
JSON `tools/device-descriptors.json` (vendored Chromium-family subset:
Pixel/Galaxy/iPad-class descriptors from Playwright
`packages/isomorphic/deviceDescriptorsSource.json`, fields `userAgent,
viewport{width,height}, deviceScaleFactor, isMobile, hasTouch`; Apache-2.0
with attribution comment).

- `emulate` gains `device?: string` param (schema `emulate.ts:229-264`);
  resolves descriptor → `Emulation.setDeviceMetricsOverride` +
  `setTouchEmulationEnabled` (`emulate.ts:59-72` path) +
  `Emulation.setUserAgentOverride` (`emulate.ts:87-90` path) in one call.
- `reset` (`emulate.ts:34-56`) clears preset-applied overrides (they're the
  same override calls — already covered); conflict rule: explicit viewport/UA
  params override the preset when both given (document).
- `list` action? No — keep `emulate` shape; add `device: 'list'` sentinel
  returning descriptor names (cheap, no schema explosion).
- Must not fight `page.ts:452-471` fullPage-screenshot override path
  (separate concern — document).

**Tests:** unit — descriptor application calls the 3 emulation methods with
mapped args; unknown device → actionable error listing available names; reset
clears. Live: emulate.device 'Pixel 7' → responsive viewport + touch in a
responsive tester.
**Effort:** 1 session.

### A5. OOP-frame routing fix (drive-by, from the code map)

`getRefSession` (`tab-session-service.ts:153-155`) is defined but never
called; interact sends everything to the main session even for uids routed to
child sessions (`page.ts:324` stores `refRouting`). Fix: interact's
`getTabSession` consults `refRouting` → child session for OOP-frame uids.
This unblocks cross-frame interaction without the full iframe-piercing
project (5.2). **Effort:** 0.5 session. Tests: snapshot uid from OOP iframe →
click routes to child session (integration).

---

## Workstream B — CDP freshness

### B1. Capability report via `Schema.getDomains` (FIRST — everything keys off it)

- New `connection/capabilities.ts`: `getCapabilities(sess)` →
  `{ domains: Set<string>, has(name): boolean }` via `Schema.getDomains`;
  cached per session; invalidated on reconnect (`index.ts:92` path).
- `status` tool gains `CDP domains: N` + notable-missing line (WebAuthn,
  FedCm, WebMCP when absent).
- B3/B4/B5 items feature-detect through it (degrade with actionable error
  naming the missing domain + required Chrome version).
**Effort:** 0.5 session. **Tests:** mock send → report; missing-domain error.

### B2. FindInPage (small)

`page` actions `find {text, caseSensitive?}` / `find_next` / `find_stop` →
`FindInPage.findFirst/findNext/stop`; returns activeMatchOrdinal +
resultCount. Value: native find state + highlight without snapshot search.
**Effort:** 0.5 session.

### B3. Emulation additions

- `emulate` new props: `devicePosture: 'continuous'|'folded'` →
  `Emulation.setDevicePostureOverride`/`clearDevicePostureOverride`;
  `cpuPerformance: number` → `Emulation.setCPUPerformanceOverride`
  (Chrome 153/154 — feature-detect via B1, error names minimum version).
- Extend `reset` (`emulate.ts:34-56`) to clear both.
**Effort:** 0.5 session.

### B4. Network resilience

- `observe.request` large bodies: `Network.streamResourceContent` when
  `base64Encoded` body would exceed the 60k inline cap (stream → temp file,
  matching `utils/temp-files.ts` conventions).
- `observe` action `enable_durable_messages`? No — auto:
  `Network.configureDurableMessages` on session enable path (page.ts ensure)
  when capability present; makes response bodies survive cross-process
  navigation. Feature-detect, silent-off otherwise.
**Effort:** 1 session. **Tests:** oversized body → temp-file path; durable
flag sent when domain present.

### B5. Memory counters

`observe` action `memory` → `Memory.getDOMCounters` +
`getDOMCountersForLeakDetection` + `prepareForLeakDetection` (feature-detect).
Returns nodes/JS listeners/objects counts before/after. **Effort:** 0.5
session.

### B6. Spikes (timeboxed, may die)

- **S1 `Page.getAnnotatedPageContent`**: dump for a real page, compare token
  cost + signal vs our token-optimized snapshot (`snapshot/token-optimizer.ts`).
  Adopt as `page.content format:'annotated'` ONLY if competitive. 
- **S2 `Page.startScreenRecording/stopScreenRecording`**: capture → file via
  temp-files; evaluate reliability on Brave 153. Ship as experimental
  `page.record` actions only if solid. 
**Effort:** 0.5–1 session combined. Kill criteria: flaky, huge output, or
version-gated surprise.

---

## Sequencing (per phase discipline — live-verified before next)

| Order | Item | Effort | Why this order |
|---|---|---|---|
| 1 | B1 capability report | 0.5 | everything feature-detects through it |
| 2 | A2 raw mouse | 1 | small win, warm-up, no dependencies |
| 3 | A1 auto-wait gate | 2–3 | the big one; benefits from A2's Input familiarity |
| 4 | A3 storageState | 1–1.5 | independent |
| 5 | A4 device presets | 1 | independent |
| 6 | A5 OOP routing fix | 0.5 | drive-by with A1/A2 knowledge fresh |
| 7 | B2–B5 | 2 | small adds, all capability-gated |
| 8 | B6 spikes | 0.5–1 | last, killable |
| — | Release: bump → promote → tag `v5.1.0` | 0.5 | pipeline (5.0.3 pattern) |

Total: ~9–11 sessions. Interim commits after every item (conventional
commits, CHANGELOG [Unreleased] accumulates).

## Verification matrix (live, per relevant item)

| Item | Live check |
|---|---|
| A1 | animated page: click waits then lands; `force` bypasses; disabled button → named-state error |
| A2 | canvas/map: click_xy + wheel; humanMode path visible |
| A3 | login → export → clear → import → session survives |
| A4 | device preset on responsive tester + reset |
| A5 | OOP-iframe uid interaction routes correctly (any site with cross-origin iframe) |
| B1 | status shows domain count on Brave 153 vs Chrome (WebMCP presence differs) |
| B2 | find on a long page: ordinal/count updates |
| B3 | folded posture + CPU tier on 153+ |
| B4 | big-response page: body lands in temp file, not truncated inline |
| B5 | counters before/after navigation |
| Regression | flag+toggle connect unchanged; slim aliases map; 5.0.3 classifier messages unchanged |

## Risks

- **Injected-script fragility** (A1): shadow DOM/composed paths — mitigated
  by `composedPath()` + `force` escape + default-on flag kill-switch
  (`CDP_AUTO_WAIT=false`).
- **Descriptor drift** (A4): vendored JSON ages — acceptable; regenerate on
  demand from the Apache-2.0 source (clone at `D:\.development\Clones\Playwright`).
- **Feature-gated methods** (B3/B4/B5): capability-gated with version-named
  errors — no silent failures.
- **Scope creep on spikes** (B6): timebox enforced; kill criteria above.
- **Double-release interaction**: 5.1.0 touches `interact.ts` heavily — keep
  classifier/connect code (5.0.3) untouched; no mixed commits.
