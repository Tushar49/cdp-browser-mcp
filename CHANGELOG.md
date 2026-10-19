# Changelog

All notable changes to CDP Browser MCP Server will be documented in this file.

## [5.0.0-alpha.4] - 2026-05-13

### Added
- `src/__tests__/agent-suite/`: scenario definitions for LinkedIn Easy Apply, Adobe Phenom, Hirist 403, Greenhouse w/ reCAPTCHA, Workday iframes, Google Forms phone country code. Runner stub awaiting activation (`runScenario`/`compareScenario` throw with pointer to BACKLOG E). Shape validation tests pass (20/20 in `unit/agent-suite-scenarios.test.ts`).

### Changed (slim mode)
- Tool descriptions further trimmed in slim mode (-43%): each `browser_*` tool now has a one-line description, per-property schema descriptions stripped where the name is self-documenting. Total slim `ListTools` JSON: 2,226 → 1,416 chars (-36%).
- Response messages shortened in slim mode: `Clicked <div> "Submit Application" at (320, 482)` → `Clicked` for click / hover / type / drag / scroll / focus / check / tap / press / select / upload. Saves ~30-60 chars per call (~350 chars per typical 10-action session).
- Default `page.snapshot` `maxLength` = 4000 in slim mode (was 20,000). Caps every snapshot at a 32K-context-friendly size; full mode default unchanged.
- Compact snapshot header in slim mode: `Page: ...\nURL: ...\nElements: N\n\n` → `[N elems] title\n\n` (-60 to -200 chars per snapshot).
- Compact frame breadcrumb in slim mode: `[frame N] ` → `[fN] ` (-5 chars per iframe node line).
- Shorter cap-truncation footer in slim mode (-40 chars when output is truncated).

### Added
- docs/CHROME_AUTOMATION_INFOBAR.md — explains the Chrome "is being controlled" infobar and why it cannot be hidden
- extension/: chrome.storage.local approval persistence (popup.js, background.js, manifest.json permission) — ready for extension graduation from stub
- Regression tests for slim mode output budgets(`src/__tests__/unit/slim-output-budget.test.ts`, 11 tests). Enforces: schema total < 1500 chars, synthetic complex-form snapshot < 6000 chars, slim click result < 80 chars.
- `isSlimMode()`, `slimify(verbose, slim)`, `defaultSnapshotMaxLength()` helpers exported from `src/tools/slim-mode.ts`.

### Added (Playwright parity)
- **`interact.click waitFor`** — Optional `{ selector | text | textGone, state, timeout }` on click. Wait-for-element runs in the same call, eliminating the separate `page.wait` round-trip after navigations triggered by a click. Parity with Playwright MCP `browser_click` followed by `browser_wait_for`. Tests: `src/__tests__/unit/interact-click-wait-for.test.ts`.
- **`storage` web storage R/W** — Three new actions on the `storage` tool: `get_storage`, `set_storage`, `delete_storage` with `storageType: "local" | "session"` (default `local`). Reads/writes individual `localStorage` / `sessionStorage` keys (or the whole area when `key` is omitted). Replaces the prior `execute.eval` workaround. Parity with Playwright MCP `browser_localstorage_*` and `browser_sessionstorage_*`. Tests: `src/__tests__/unit/storage-web-storage.test.ts`.
- **`observe.request urlFilter`** — Allow `urlFilter` (URL substring) as an alternative to `requestId`. Resolves to the most recent matching captured request and fetches its body in a single call, skipping the prior `observe.network` listing. Parity with Playwright MCP `browser_network_requests` inline-body return. Tests: `src/__tests__/unit/observe-request-url-filter.test.ts`.

### Fixed
- Profile-sticky sessions: tabs no longer open in user-focused browser when pinned profile is set

## [5.0.0-alpha.3] - 2026-05-12

### Added
- **Slim Mode** (`CDP_SLIM_MODE=true`) — 6 Playwright-compatible tools for small-context models (32K). Schema drops from ~8KB to ~1.5KB.
- **Interactive-only snapshots** — `page.snapshot({ interactive: true })` returns only buttons, inputs, links
- **Search in snapshots** — `page.snapshot({ search: "Login" })` filters to matching elements
- **Snapshot length cap** — `page.snapshot({ maxLength: 8000 })` with smart line-boundary truncation
- **Country code handler** — form.fill understands +91, India, IN for phone country code fields
- **Location autocomplete** — form.fill handles debounced address/location autocomplete inputs
- **Network settle after clicks** — Playwright-style waitForNetworkSettle after interactions

### Fixed
- Auto-connect: 3-strategy connection (cached URL → port probe → file discovery)
- Connection errors now show EXACT fix steps (chrome://flags instruction)
- Combobox timing: 80ms char delay, 1s debounce, 5s poll (was 50ms/3s)
- Short-prefix retry for comboboxes when full value yields no results
- Tool descriptions trimmed 40% for lower token cost

### Changed
- Version: 5.0.0-alpha.3

## [Unreleased]

### Added
- `.githooks/` - pre-commit warning when code changes without CHANGELOG update. Non-blocking. Install with `bash .githooks/install.sh` or `pwsh -File .githooks/install.ps1`. Skip with `git commit --no-verify`. See `.githooks/README.md`.
- scripts/start-chrome.{ps1,sh} - consistent Chrome launcher for CDP debugging port. No-ops if already running. Supports --isolated for fresh automation profile.

## [5.0.0-alpha.2] - 2026-04-22

### Added
- **Cross-origin iframe support** — `Target.setAutoAttach` auto-discovers OOP iframe targets, multi-frame snapshots with `[frame N]` prefixes, frame-aware uid resolution
- **File chooser interception** — `Page.fileChooserOpened` → modal state blocking, `Page.handleFileChooser` for programmatic uploads, popup window monitoring for Google Picker/Dropbox, shadow DOM traversal for hidden inputs
- **CDP event pipeline** — Full event routing: console, network, downloads, dialogs, file choosers, debugger pause/resume, Target attach/detach all wired to ServerContext state stores
- **Profile-sticky sessions** — Sessions auto-pin to Chrome profile on first tab interaction. New tabs always open in pinned profile even when user manually switches profiles
- **`tabs.set_profile` action** — Explicitly switch a session's pinned Chrome profile
- **Snapshot diffing** — `page.snapshot({ diff: true })` returns only changes since last snapshot on the tab
- **Chrome extension scaffold** — `extension/` directory with Manifest V3, service worker, popup UI (bridge not yet implemented)
- **macOS/Linux browser discovery** — Cross-platform paths for Chrome, Edge, Brave, Chromium

### Fixed
- Modal event listener leak on reconnect (register once, reset on disconnect)
- JSON.parse crash on malformed CDP frames (try-catch guard)
- Snapshot cache now wired into page.snapshot (store, invalidate, diff)

### Changed
- Version bumped to 5.0.0-alpha.2
- Tests: 142 → 146 (profile pinning tests added)

## [5.0.0-alpha.1] — 2026-04-21

### 🚀 Complete Architecture Restructure

**Breaking Changes:**
- Entry point changed from `server.js` to `dist/index.js` (legacy `server.js` still works via `npm run start:legacy`)
- Default `cleanupStrategy` changed from `"close"` to `"detach"` — tabs now persist after session expiry
- Default timeout increased from 30s to 60s

### Added
- **Smart Form Filling** (`form` tool) — handles text, combobox, checkbox, radio, select, date in a single call. Auto-detects field type. React/Greenhouse combobox support with smart matching.
- **Auto-Connect** — server automatically discovers and connects to Chrome/Edge/Brave on first tool call. No more `browser.connect()` needed.
- **Stable Element Refs** — uids persist across snapshots within the same page (cumulative ElementResolver)
- **JS-Click Fallback** — click automatically falls back to JavaScript `el.click()` for framework sites (LinkedIn, React, Angular)
- **Token-Optimized Snapshots** — role filtering, depth limiting, text truncation. 34KB → ~15KB average.
- **Actionable Errors** — 17 error types with "How to fix" suggestions
- **Modal State System** — dialogs/file choosers block other tools with recovery instructions
- **Auto-Reconnect** — exponential backoff reconnection on browser disconnect
- **Lazy Domain Enablement** — CDP domains enabled on first use, not at connect time
- **Snapshot Caching** — per-tab cache with line-level diffing
- **Agent Guidance** — all 14 tool descriptions include usage guidance and common pitfalls
- **Dispatch Preprocessing** — session routing, tab claiming, modal checks on every tool call
- **Connection Mutex** — prevents concurrent socket opens
- **Tab Session Pooling** — reuse CDP sessions per tab
- **Response Builder** — progressive truncation for LLM token budgets
- **Profile-Aware Tabs** — `tabs.new({ profile: "Work" })` opens in specific browser profile

### Changed
- Architecture: 1 file (254KB) → 38 TypeScript modules (8,844 lines)
- TypeScript with strict mode
- Tiered timeouts: action=10s, navigation=60s, snapshot=15s
- Console errors from Chrome extensions automatically filtered
- `tabs.list()` auto-shows all tabs when session has none
- Session expiry warnings at <60s TTL

### Fixed
- Element refs going stale between snapshot and interaction
- React comboboxes not selecting values (Greenhouse, Lever)
- LinkedIn clicks not triggering (Ember.js framework)
- Fresh tabs opening to about:blank
- D365/SharePoint timing out at 30s
- 34KB+ snapshots overwhelming LLM context
- Agents not knowing how to connect
- Tabs auto-closing when session expires

## [4.13.0] — 2026-03-29

### Added — Popup-Aware File Upload
- **Multi-target upload detection** — `interact.upload` (without uid/selector) now monitors BOTH the current page AND any popup windows that open for file chooser dialogs or `<input type="file">` elements. Handles Google Drive Picker, Dropbox file chooser, and other popup-based upload workflows automatically
- **`findAndSetFileInput()` helper** — searches page DOM (including shadow DOMs) for file inputs and sets files directly via `DOM.setFileInputFiles`, bypassing the need for a native file dialog
- **Popup auto-attach** — when a popup/tab opens during an upload call, the server automatically attaches a lightweight CDP session, enables file chooser interception, and polls for file input elements as the popup loads
- **Improved error messages** — upload timeout errors now include actionable tips for popup-based upload scenarios

### Improved
- **Upload timeout** — default timeout for no-uid/no-selector uploads increased from 10s to 30s to accommodate popup loading time
- **Upload description** — tool schema description updated to document popup-aware behavior

## [4.12.1] — 2026-03-27

### Added — Profile-Aware Tab Creation
- **`tabs.new` `profile` parameter** — create new tabs in a specific Chrome profile by name, email, or directory (e.g. `profile: "Work"`, `profile: "mansha@gmail.com"`, `profile: "Profile 7"`). Resolves profile to `browserContextId` via cross-referencing `Local State` metadata with live tab contexts, then passes it to `Target.createTarget`
- **`resolveProfileContext()` helper** — new function maps profile name/email/directory to `browserContextId` by reading `Local State` profile cache and matching against live tab `browserContextId` values

### Improved
- **`browser.active` profile names** — tabs-by-profile section now shows human-readable profile names (with email) instead of truncated browserContextId hashes, by cross-referencing `Local State` profile cache

### Fixed
- **HAR creator version** — corrected stale `"4.11.0"` hardcoded version in HAR export to `"4.12.1"`
- **MCP server registration version** — corrected stale `"4.9.0"` to `"4.12.1"` in `Server` constructor

## [4.12.0] — 2026-03-16

### Added — Cross-Origin (OOP) Iframe Support
- **`Target.setAutoAttach` on page sessions** — every new tab session now calls `Target.setAutoAttach({ autoAttach: true, flatten: true })` to auto-discover cross-origin (Out-Of-Process) iframe targets that Chrome's Site Isolation runs in separate OS processes
- **OOP iframe snapshot content** — `page.snapshot` now captures accessibility tree content from cross-origin iframes (shown with `[frame N]` prefixes), making previously invisible content from sites like SharePoint Word/Excel Online, OAuth consent screens, and embedded payment forms fully visible
- **OOP iframe element interaction** — `interact` tool actions (click, type, fill, select, scroll, focus, check, upload, tap) now resolve `uid` refs from cross-origin iframe snapshots to the correct child CDP session, with automatic coordinate transformation for Input events
- **OOP iframe JS execution** — `execute.call` and `page.content` with `uid` now route `Runtime.callFunctionOn` to the correct cross-origin iframe session
- **`page.frames` action** — new action lists all frames in a page including same-origin frames from `Page.getFrameTree` and cross-origin OOP frames from auto-attached child sessions
- **`Target.attachedToTarget` / `Target.detachedFromTarget` event handling** — OOP iframe child sessions are tracked and cleaned up automatically on navigation or tab detach

## [4.11.1] — 2026-03-12

### Fixed
- **Unhandled Promise rejection crash** — `Target.setDiscoverTargets` call during browser connection now uses `.catch()` instead of try/catch around a floating Promise. Previously, if the CDP call failed, the rejected Promise was unhandled and could crash the Node.js process
- **`page.content` format:"full" guard** — now returns an explicit error when `uid` or `selector` is passed with `format: "full"` instead of silently ignoring them
- **Popup console log URL** — synthetic `[popup]` entries now use empty string for URL field instead of `"Target.targetCreated"` which could confuse URL-based filtering
- **Server header action count** — corrected "84+" to "86+" matching README badge

## [4.11.0] — 2026-03-12

### Added — Phase 6: Playwright Audit Priority B
- **`page.content` format: "full"** — new format option returns complete document HTML with doctype via `document.documentElement.outerHTML`. Existing `text` and `html` formats unchanged
- **`observe.har`** — new action exports captured network requests as HAR 1.2 JSON. Auto-saves to temp file when output exceeds 60KB
- **Snapshot overflow screenshot** — when `page.snapshot` output exceeds 60KB and spills to temp file, a JPEG screenshot is auto-captured alongside for visual context
- **Popup/new-window detection** — browser-level `Target.targetCreated` events are now monitored. Popups opened by pages are auto-logged to the opener tab's console as `[popup]` entries, visible via `observe.console`

## [4.10.1] — 2026-03-11

### Fixed
- **File chooser TDZ crash** — rewrote Promise pattern to extract handler variable outside constructor, fixing `ReferenceError: Cannot access 'chooserPromise' before initialization` that made the file chooser upload path 100% non-functional
- **Wrong CDP API for file chooser** — replaced `DOM.setFileInputFiles` with `Page.handleFileChooser({ action: "accept", files })`. `Page.fileChooserOpened` returns `{ frameId, mode }` not `backendNodeId`
- **File chooser race condition** — handler is now registered before `Page.setInterceptFileChooserDialog` is enabled, preventing missed events
- **`pendingFileChoosers.clear()` missing** — added to WebSocket close handler alongside the other 17 state map clears
- **Brave flag URL** — `brave://flags` added to connection error message alongside Chrome and Edge
- **README tables** — `tabs.new` row now shows `activate` parameter; `upload` row shows `uid`/`selector` as optional
- **CHANGELOG v4.10.0** — corrected false claim that `discoverChromeInstances()` was renamed

## [4.10.0] — 2026-03-11

### Added
- **Multi-browser support** — Edge and Brave added to auto-discovery and connection fallback paths alongside Chrome, Chrome Beta, Chrome Canary, and Chromium. Any Chromium-based browser at the configured port now works out of the box
- **File chooser dialog interception** — `interact.upload` can now be called without `uid`/`selector` to intercept the next OS file chooser dialog. Click the upload button first, then call upload with just `files` to handle custom upload buttons that trigger file choosers programmatically
- **Background tab creation** — `tabs.new` now opens tabs in the background by default (no focus stealing). Pass `activate: true` to bring the new tab to the foreground

### Changed
- Browser tool description and error messages updated from Chrome-specific to browser-agnostic
- `discoverChromeInstances()` now discovers all Chromium browsers (Edge, Brave added to candidates)
- Connection error message now shows Chrome, Edge, and Brave flag URLs

## [4.9.2] — 2026-03-11

### Fixed
- **Dialog branch regression** — session recovery in `getTabSession` now checks for pending dialogs *before* deleting per-session state. Previously the F5 fix (v4.9.1) unconditionally wiped all maps then tried to restore the session for dialog handling, leaving overrides, breakpoints, console logs, and network data irreversibly lost
- **Debugger disable→re-enable broken** — `handleDebugDisable` now removes `"Debugger"` from `enabledDomains` after calling `Debugger.disable`. Previously `ensureDomain` saw the stale entry and skipped re-enabling, making `set_breakpoint` fail silently after a disable→enable cycle
- **`pendingDialogs` orphan leak** — dead session IDs now have their `pendingDialogs` entry cleaned in the non-dialog recovery path
- **`refreshFetchPatterns` error handling** — `Fetch.enable` call now wrapped in try-catch matching the `Fetch.disable` path, preventing raw CDP errors from surfacing on stale sessions
- **CHANGELOG v4.9.1 count** — corrected "18 per-session state maps" to accurate count

## [4.9.1] — 2026-03-11

### Fixed
- **NaN env var parsing** — `CDP_TIMEOUT` and `CDP_DEBUGGER_TIMEOUT` now use `parseInt(val) || default` pattern (matching `CDP_SESSION_TTL`). Previously, non-numeric env values like `"abc"` produced NaN, causing instant timeouts or 1ms auto-resume
- **Session recovery state leak** — when a CDP session breaks and recovers, all per-session state maps are now cleaned for the dead session ID. Previously only `activeSessions` and `enabledDomains` were cleaned, orphaning console logs, network data, breakpoints, overrides, and fetch patterns under the dead ID
- **`Fetch` added to `NO_ENABLE` set** — prevents `ensureDomain(sess, "Fetch")` from issuing a bare `Fetch.enable({})` that would clobber the carefully constructed patterns from `refreshFetchPatterns()`
- **README emulate table** — added missing `autoDarkMode` and `idle` properties that were implemented but undocumented
- **README comparison table** — corrected emulate option count from 16 to 15

## [4.9.0] — 2026-03-10

### Added — Web Resource Debugging (Phase 5)

New `debug` tool (#11) with 21 actions for JavaScript debugging, resource overrides, and DOM/event breakpoints.

### Added
- **`debug` tool** — new tool #11 with JavaScript debugger, resource override, and DOM/event breakpoint capabilities
- **Debugger core** (14 actions): `enable`, `disable`, `set_breakpoint`, `remove_breakpoint`, `list_breakpoints`, `pause`, `resume`, `step_over`, `step_into`, `step_out`, `call_stack`, `evaluate_on_frame`, `list_scripts`, `get_source`
- **Resource overrides** (3 actions): `override_resource` (pre-register URL regex → response body for automatic fulfillment), `remove_override`, `list_overrides`
- **DOM/Event breakpoints** (4 actions): `set_dom_breakpoint`, `remove_dom_breakpoint`, `set_event_breakpoint`, `remove_event_breakpoint`
- **Debugger pause guard** — when debugger is paused, blocks all non-debug tool calls on that tab (allows `page.dialog` through for dialog handling)
- **Auto-resume safety timeout** — paused tabs auto-resume after 30s (`CDP_DEBUGGER_TIMEOUT` env var) to prevent permanently frozen tabs
- **5 new state maps**: `pausedTabs`, `parsedScripts`, `activeBreakpoints`, `resourceOverrides`, `fetchPatterns` — all cleaned up in `detachTab` + WebSocket close handler
- **Unified Fetch pattern registry** — `refreshFetchPatterns()` helper merges request-stage (intercept) and response-stage (override) patterns into a single `Fetch.enable` call. Response-stage uses `"*"` catch-all with JS regex matching in the event handler
- **Response-stage Fetch handling** — `handleEvent` now distinguishes request vs response stage pauses via `responseStatusCode` presence

### Changed
- **`handleInterceptEnable`** — refactored to use unified `fetchPatterns` map + `refreshFetchPatterns()` instead of direct `Fetch.enable`
- **`handleInterceptDisable`** — only clears request-stage patterns; response-stage overrides preserved if active
- **Bump version to 4.9.0**

## [4.8.1] — 2026-03-10

### Performance
- **Deferred Local State parsing** — `discoverChromeInstances()` now accepts `{ skipProfiles: true }` to skip parsing Chrome's `Local State` JSON (can be 5–20MB on heavy profiles). Used at boot (`CDP_PROFILE` check) and in `connectBrowser()` open handler where only port/wsUrl matching is needed. Profile data is only parsed when `browser.profiles` or `browser.active` explicitly request it.

## [4.8.0] — 2026-03-10

### Added — Security Hardening & Tab Origin Tracking

Session ID opacity, session-scoped temp files, tab origin tracking (`created` vs `claimed`), and master reset.

### Added
- **Tab origin tracking** — `tabLocks` now stores `{ sessionId, origin }` objects instead of bare session ID strings. Origin is `"created"` (opened via `tabs.new`) or `"claimed"` (pre-existing browser tab first referenced by a session)
- **`cleanup.reset` action** — master-clear that terminates ALL sessions and releases all tab locks. `closeTabs: true` closes agent-created tabs; pre-existing (claimed) tabs are **never** closed, always preserved
- **Origin-aware cleanup** — `cleanup.session`, TTL sweep (`sweepStaleSessions`), and `cleanup.reset` all respect tab origin: `claimed` tabs are detached only (never closed regardless of cleanup strategy), `created` tabs follow the configured strategy
- **`cleanup.list_sessions` origin tags** — tab listings now show `(created)` or `(claimed)` next to each tab for visibility into what would be preserved vs closed on reset
- **`closeTabs` parameter** on `cleanup.reset` — boolean flag to optionally close created tabs (default: false, detach only)

### Security
- **Session ID opacity** — session UUIDs are now treated as credentials and never exposed in full. All output paths truncate to first 8 chars: `cleanup.list_sessions`, `cleanup.session` response, `tabs.list` lock tags, `browser.connect` rejection messages
- **Session-scoped temp file cleanup** — `writeTempFile` accepts an optional session prefix; `handlePagePdf` and `handleObserveRequest` prefix filenames with session ID substring. `cleanup.clean_temp` only deletes the caller's prefixed files + unprefixed legacy files. Other sessions' temp artifacts are preserved
- **`cleanup.session` fail message** — no longer leaks the session ID

### Changed
- **`tabLocks` refactored** from `Map<tabId, string>` to `Map<tabId, { sessionId, origin }>` — all ~11 read sites updated to use `?.sessionId` optional chaining
- **`cleanup.disconnect_tab`** — plan snippet corrected to match hardened server code (no `exclusive:false` bypass for destructive ops)
- **Bump version to 4.8.0**

## [4.7.0] — 2026-03-07

### Added — Human-Like Interaction Consolidation

Bezier curve mouse paths, typo simulation, and auto-snapshot diffing for the `interact` tool.

### Added
- **`humanMode` flag on interact tool** — enables bezier curve mouse paths with overshoot, jitter, and variable speed for `click`, `hover`, and `drag` actions. Mouse movement follows a cubic bezier with randomized control points, overshoots by 3–8px, then corrects back. Speed varies: faster in the middle, slower near the target.
- **`generateBezierPath(from, to, steps, jitter)` helper** — produces natural-looking mouse paths. Control point spread scales with distance. Jitter peaks mid-movement, minimal at endpoints.
- **`autoSnapshot` flag on interact tool** — takes accessibility snapshots before and after any action, computes a line-level diff, and appends it to the response. Navigation fallback: if the action triggers navigation, shows the new page snapshot instead of a diff.
- **`typoRate` parameter for typing** — probability (0–1) of typing a wrong adjacent key then backspace-correcting. Uses QWERTY keyboard neighbor map. Requires `charDelay` or `wordDelay` to be active.
- **`getAdjacentKey(char)` + `QWERTY_NEIGHBORS` map** — returns a random adjacent key on QWERTY layout for realistic typo simulation
- **Mouse position tracking** — `lastMouseX`/`lastMouseY` stored on agent session so subsequent `humanMode` calls start from the actual last position instead of (0,0)
- **Bump version to 4.7.0**

### Fixed
- **`withRetry` stale-UID fast-fail** — errors containing `ref=` + `not found` now throw immediately instead of polling for 5 seconds (refMaps is static between snapshots)
- **DOM resolution race condition** — `resolveElementObjectId` now bundled inside `withRetry` alongside `checkActionability` in type/fill/select/check handlers to prevent crashes from mid-flight page re-renders

## [4.6.0] — 2026-03-06

### Added — Playwright Audit Priority A

Auto-retry with actionability checks, new page actions (`set_content`, `add_style`), touch events (`tap`), and frame interaction documentation.

### Added
- **`withRetry(fn, opts)` helper** — retries an async function until success or timeout (default 5000ms, 200ms interval). Used to wrap element resolution and actionability checks for Playwright-style auto-waiting
- **Auto-retry on ALL interact actions** — `click`, `hover`, `type`, `fill`, `select`, `drag`, `scroll`, `upload`, `focus`, `check`, `tap` all retry element resolution until found+actionable or `timeout` expires
- **`checkActionability` applied to all mutating actions** — previously only `click` checked visibility/disabled/size. Now `type`, `fill`, `select`, `check`, `tap`, `drag`, `upload`, `focus` all check actionability. `hover` and `scroll` use `resolveElement` retry (no actionability required, matching Playwright)
- **`timeout` parameter on `interact` tool** — configurable retry timeout per action (default: 5000ms). Matches Playwright's `locator.click({ timeout })` pattern
- **`page.set_content` action** — set page HTML content directly via `Page.setDocumentContent` (like Playwright's `page.setContent()`)
- **`page.add_style` action** — inject CSS into page via inline `css` or external `cssUrl`. Optional `persistent: true` survives page navigations via `Page.addScriptToEvaluateOnNewDocument` with DOMContentLoaded fallback for early execution safety
- **`interact.tap` action** — tap elements using `Input.dispatchTouchEvent` (touchStart + touchEnd). Includes actionability checks and auto-retry
- **Frame interaction docs** — interact tool description updated to document that uid refs from snapshots work cross-frame (via `DOM.resolveNode({ backendNodeId })`), while CSS selectors only find top-level elements

## [4.5.0] — 2026-03-06

### Added — Chrome Profile & Instance Selection

New `browser` tool (#10) for Chrome instance discovery, profile visibility, and connection switching.

### Added
- **`browser.profiles` action** — scans known User Data directories (Chrome, Beta, Canary, Chromium) for `DevToolsActivePort` files, reads `Local State` for profile names/emails, shows connection status
- **`browser.connect` action** — switch the server's WebSocket to a different Chrome instance by name, port, or path. Guards against active sessions, waits for clean close event (no race condition), uses `overrideUserDataDir` so Chrome GUID regeneration on restart doesn't break reconnection
- **`browser.active` action** — shows connected instance name, port, User Data dir, health, profiles from Local State, and tab count per `browserContextId` (profile grouping)
- **`discoverChromeInstances()` helper** — scans Chrome/Beta/Canary/Chromium User Data dirs, reads `DevToolsActivePort` + `Local State` profile metadata
- **`CDP_PROFILE` env var** — auto-connect to a specific Chrome instance at startup by name or path
- **`overrideUserDataDir` + `lastResolvedUserDataDir`** — `getWsUrl()` refactored with override support and User Data dir tracking
- **`activeConnectionInfo`** — server state tracking current Chrome instance, auto-detected on first connection, always refreshes `wsUrl` on reconnect
- **`tabs.info` shows `browserContextId`** — lets agents see which profile a tab belongs to
- **`cleanup.status` shows Chrome instance info** — name, port, User Data dir

### Changed
- **WebSocket close handler** clears `activeConnectionInfo` and `overrideUserDataDir` on disconnect
- **`connectBrowser()` open handler** auto-detects connection info by matching against discovered instances

---

## [4.4.0] — 2026-03-06

### Added — Session Exclusivity & Configurable Auto-Cleanup

Agent sessions now own tabs exclusively with automatic cleanup when sessions expire.

### Added
- **Exclusive tab locking** — tabs are locked to the first agent session that references them. Other sessions are rejected with a clear error unless `exclusive: false` is passed to share access
- **Tab ownership at creation** — `tabs.new` immediately registers the new tab in the session's ownership and locks it, eliminating the unowned-tab gap
- **`cleanupStrategy` parameter** — controls what happens when a session expires: `"close"` (default) removes tabs from the browser, `"detach"` drops the CDP session but keeps tabs open, `"none"` skips cleanup entirely
- **`cleanup.session` action** — explicitly end a session and run its cleanup strategy on demand, with `targetSessionId` to end a specific session
- **`sweepStaleSessions()` shared function** — replaced two duplicated TTL sweep blocks with a single function, fixing `handleCleanupListSessions` which previously deleted stale entries without detaching their tabs
- **`cleanupTab()` helper** — wraps `detachTab()` + optional `Target.closeTarget` based on cleanup strategy
- **Locked-tab annotations** — `tabs.list` (with `showAll: true`) and `tabs.find` now annotate tabs owned by other sessions with `[locked by: ...]`
- **`sessionId`, `cleanupStrategy`, `exclusive` parameters** — declared in all 9 tool schemas so agents discover them. `cleanupStrategy` is sticky per session
- **Enhanced `list_sessions` output** — shows cleanup strategy, owned vs. borrowed tabs, per-session TTL remaining

### Changed
- **`detachTab()` restructured** — lock cleanup (`tabLocks.delete`) and session reference removal now run **before** the `!sid` early-return guard, ensuring locks are always released even for tabs that were never interacted with
- **`disconnect_tab` / `disconnect_all` lock guards** — these handlers now check tab lock ownership before detaching, preventing agents from detaching tabs owned by other sessions
- **Borrowed-tab safety** — the TTL sweep and `cleanup.session` only clean up tabs the session actually owns (checks `tabLocks.get(tid) === sessionId`), never closing/detaching borrowed tabs

---

## [4.3.0] — 2026-02-20

### Added — Human-Like Typing with Word-Aware Delays

New `charDelay` and `wordDelay` parameters for the `interact` tool's `type` action enable randomized, human-like typing with separate control for character-level and word-level pauses.

### Added
- **`charDelay` parameter** — base delay in ms between characters within a word, randomized in range `[charDelay, charDelay*3]` (default 200ms)
- **`wordDelay` parameter** — base delay in ms between words (spaces, tabs, newlines), randomized in range `[wordDelay, wordDelay*3]` (default 800ms)
- **`randomDelay()` helper** — generates randomized delays in `[base, base*3]` range for natural typing variance
- Either `charDelay` or `wordDelay` activates human-like mode; omitted param uses its default
- Existing `delay` parameter unchanged for backward compatibility (fixed delay, no randomization)
- If both `delay` and `charDelay`/`wordDelay` are provided, human-like mode takes precedence

### Example
```json
{ "action": "type", "tabId": "ABC", "uid": 42, "text": "Hello world", "charDelay": 70, "wordDelay": 1500 }
```
Types each character with 70–210ms delay, each space with 1500–4500ms delay.

---

## [4.2.2] — 2026-02-18

### Changed — Temp directory moved to repo-local `.temp/`

- Temp files (PDFs, large outputs) now stored in `<repo>/.temp/` instead of system temp (`%TEMP%\.cdp-mcp\`)
- Path resolved via `import.meta.url` — works regardless of where the server is invoked from
- Override with `CDP_TEMP_DIR` env var if needed
- `.temp/` added to `.gitignore`

---

## [4.2.1] — 2026-02-18

### Fixed — Full-Page Screenshots on SPA Pages

Full-page screenshots on SPA sites (LinkedIn, Gmail, Twitter) now correctly capture **all loaded content** instead of blank space or skeleton placeholders.

### Fixed
- **Scroll-before-expand strategy** — scrolls through the SPA scroll container *while it's still scrollable* to trigger lazy loading, then expands it for capture. Previously expanded first (disabling scroll), so lazy content never loaded
- **Body overflow handling** — now also overrides `body { overflow: hidden }` which LinkedIn and other SPAs use to prevent document-level scroll
- **Infinite scroll safeguards** — capped at 30 scroll steps; monitors content growth every 5 steps and aborts if height exceeds 1.5x (runaway infinite scroll) or 16384px (Chrome GPU limit)
- **Post-capture stability** — increased settle times after viewport resize/restore to prevent timeout on subsequent screenshots

### Test Results
| Page | Viewport | Full Page |
|------|----------|----------|
| LinkedIn Profile | 1920×804 (105 KB) | 1536×4231 (709 KB) |
| LinkedIn Notifications | 1920×804 (161 KB) | 1520×1150 (128 KB) |
| Wikipedia article | 1920×804 | 1520×6044 (1064 KB) |

---

## [4.2.0] — 2026-02-14

### Playwright Alignment — Comprehensive API Audit & Improvements

This release brings the CDP Browser MCP Server's API surface in line with Playwright conventions. Users familiar with Playwright will find our params, naming, and behavior familiar and predictable.

### Changed
- **`page.wait` — merged `time` into `timeout`** — no more separate params. Use `timeout` alone for a fixed delay (like Playwright's `waitForTimeout`), or with `text`/`textGone`/`selector` as the polling cap. Legacy `time` still accepted silently
- **`page.screenshot` — renamed `savePath` to `path`** — matches Playwright's `path` convention. Legacy `savePath` still accepted silently
- **`interact.press/click/hover` modifiers — renamed `Ctrl` to `Control`** — matches Playwright's key naming. `Ctrl` still works internally via `modifierFlags()`
- **`page.goto/back/forward/reload` — navigation now uses `waitUntil`** — `load` (default), `domcontentloaded`, `networkidle`, `commit`. Plus optional `timeout`. Matches Playwright's `goto({ waitUntil })` pattern
- **`page.wait` selector — added `state` param** — `visible`, `hidden`, `attached` (default), `detached`. Matches Playwright's `locator.waitFor({ state })`

### Added
- **`modifiers` on `interact.click` and `interact.hover`** — `["Control", "Shift", "Alt", "Meta"]` for Ctrl+click, Shift+click, etc. Already existed on `press`, now available on click/hover too
- **`delay` on `interact.type`** — milliseconds between keystrokes for character-by-character typing (like Playwright's `pressSequentially`). Without delay, uses instant fill via `nativeInputValueSetter`
- **`type` param on `page.screenshot`** — `png` (default) or `jpeg`. JPEG produces smaller files for vision-model agents. Previously jpeg was only triggered by `quality` param
- **`waitForReadyState` helper** — shared navigation wait logic supporting all 4 `waitUntil` strategies including `networkidle` (waits for no pending requests for 500ms)

## [4.1.0] — 2026-02-14

### Added
- **Geolocation `accuracy` and `altitude` params** — `accuracy` (meters, default 100) and `altitude` (meters, optional) for realistic GPS spoofing
- **Automatic geolocation permission granting** — 3-tier fallback: `Browser.grantPermissions` → `Browser.setPermission` → JS API override injection. Permission-based sites (e.g. where-am-i.co) now work without manual user prompts
- **Auto-assigned per-process sessions** — each MCP server process gets a `crypto.randomUUID()` session automatically; no opt-in needed
- **Tab ownership enforcement** — `tabs.list` filters to session-owned tabs by default
- **`showAll` param for `tabs.list`** — bypasses session filtering to see all browser tabs
- **`sessionId` declared in all tool schemas** — visible and documented, not a hidden convention

### Changed
- Session isolation is now automatic — every tool call routes through a session (uses `args.sessionId` or auto-assigned process session)
- `detachTab` now removes tab from all `agentSessions` to prevent stale references
- Session expiry now calls `detachTab` for each owned tab, properly cleaning up CDP sessions, console logs, network captures, and ref maps

### Fixed
- Geolocation spoofing on permission-based sites — `Emulation.setGeolocationOverride` alone wasn't enough; browser permission grants are now handled automatically
- **`page.wait` time/timeout consistency** — both `time` and `timeout` are now in milliseconds (matching Playwright convention). Hard cap at 60000ms prevents runaway waits

### Added (post-release)
- **`savePath` param for `page.screenshot`** — pass an absolute file path to save screenshots directly to disk instead of returning base64. Creates parent directories automatically

## [4.0.0] — 2026-02-14

### Added
- **Stable element references** — `ref` numbers mapped to Chrome's `backendNodeId` (O(1) resolution, stable within session)
- **Auto-waiting after actions** — every click, type, fill, select, and press waits for triggered XHR/fetch and navigation to complete
- **Actionability checks** — verifies element dimensions, visibility, pointer-events, and disabled state before interaction
- **Framework-aware form filling** — works with React (`nativeInputValueSetter`), MUI Select, Ant Design Select, React Select, contenteditable, and native selects
- **Incremental snapshots** — line-level diffs reduce token usage by 60–80% on subsequent snapshots
- **Per-agent session isolation** — multiple AI agents share one Chrome instance with scoped tab visibility, independent logs, and TTL-based expiry
- **Modal/dialog guards** — blocks actions when a JS dialog is pending, returns clear message to handle it first
- **Console error auto-reporting** — last 5 console errors/warnings appended to every tool response
- **Smart error messages** — actionable recovery hints for stale refs, hidden elements, obscured click targets
- **Connection health monitoring** — WebSocket ping/pong every 30s, auto-cleanup on 2 consecutive failures
- **Rich tool descriptions** — comprehensive action documentation with parameter details and usage notes

### Changed
- Upgraded from sequential element counters to `backendNodeId`-based stable refs
- Snapshot format now shows `[ref=N]` instead of sequential IDs

## [3.0.0] — 2026-02-10

### Changed
- **Consolidated 19 tools into 9** with ~50 sub-actions using action-based dispatch
- Tools reorganized: `tabs`, `page`, `interact`, `execute`, `observe`, `emulate`, `storage`, `intercept`, `cleanup`

### Removed
- 19 individual flat tools replaced by 9 consolidated tools with sub-actions

## [2.0.0] — 2026-02-10

### Added
- Initial CDP Browser MCP Server
- 19 individual tools for browser automation
- Direct Chrome DevTools Protocol connection via WebSocket
- Tab management, navigation, screenshots, element interaction
- Network interception and monitoring
- Cookie and storage management
- Device and network emulation
- JavaScript execution
- Console and performance monitoring

---

[4.1.0]: https://github.com/Tushar49/cdp-browser-mcp-server/compare/v4.0.0...v4.1.0
[4.0.0]: https://github.com/Tushar49/cdp-browser-mcp-server/compare/v3.0.0...v4.0.0
[3.0.0]: https://github.com/Tushar49/cdp-browser-mcp-server/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/Tushar49/cdp-browser-mcp-server/releases/tag/v2.0.0
