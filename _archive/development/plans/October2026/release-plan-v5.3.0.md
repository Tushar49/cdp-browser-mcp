# Release plan — v5.3.0 (created 2026-10-28)

Positioning (locked): **attach-only real-browser raw-CDP MCP server** —
never launches a browser, zero abstraction deps (ws + MCP SDK). The 5.3
cycle closes the audit's Must-grade gaps and hardens the surface;
anti-features are cut, 5.4 candidates named. Research base:
`_archive/research/October2026/2026-10-28-v5.3-parity-audit.md`
(librarian inventory + oracle grading + metis framing).

Law (unchanged from 5.2): all work on dev; pnpm everywhere; tool contract
additive-only; no new runtime deps; never launch/close browsers or tabs
autonomously; every workstream live-verified on Brave 153 before the
next starts; interim conventional commits; CHANGELOG [Unreleased]
accumulates; promote via `scripts/promote.mjs` (local), never tag past
a red Guard main.

## WS0 — WebMCP live spike (GO/KILL gate — 0.25 session)

The FedCm lesson: a CDP domain can answer while the page-side JS API is
dead. Before building the tool, verify the FULL path on Brave 153:
1. `status` → confirm the WebMCP canary still answers (it did: 7/10).
2. Serve a localhost page that registers a tool via the WebMCP JS API
   (`navigator.modelContext.registerTool(...)` or the documented
   equivalent per developer.chrome.com/docs/ai/webmcp; flag
   `chrome://flags/#enable-webmcp-testing` may be required on Chrome —
   check whether Brave 153 needs it and whether the API exists at all).
   Navigate THE EXISTING designated tab to the localhost rig —
   user-confirmed first (5.2 navigation precedent; never open/close
   tabs autonomously).
3. CDP `WebMCP.enable` on the tab session → expect `toolsAdded` event /
   tool listing; `invokeTool` → expect the page handler to run.

**Kill criterion:** the page-side API is absent/disabled on Brave → no
page can ever register tools → nothing to passthrough → **no WebMCP
workstream ships in 5.3**; moves to the 5.4 list with "requires Chrome
or Brave enabling the API" note (same disposition as fedcm). Do NOT
ship a half-tool that only errors.

**Kill deliverable if killed:** the spike script + findings go into the
research doc; WS3's design (below) is preserved verbatim for the future.

## WS1 — hardening riders (~0.5 session, FIRST — protects everything after)

1. **O1 `readOnlyHint` annotations — WITH full plumbing (momus finding 1):
   the hint is only real if it reaches the wire.** Touch points, named:
   (a) `types.ts` ToolDefinition gains an `annotations?: {}` field;
   (b) `registry.list()` (registry.ts:23-29) passes annotations through —
   today it returns only name/description/inputSchema;
   (c) the slim-mode filter path (index.ts:653 area) preserves them;
   (d) the MCP `tools/list` handler (index.ts:651-655) forwards them.
   Read-only = never mutates browser/page/server state: tabs list/find/
   info, page snapshot/content, observe *, storage get_cookies,
   webauthn list, ping, status. **The test is at the WIRE level** (mock
   an MCP tools/list request → hint present), not a definitions check;
   live spot-check: list tools from the real client.
2. **O2 secrets scrubbing — choke point decided UP FRONT (momus
   finding 2): ok()/fail() are NOT universal** (tools also return via
   `base-tool.ts success()` and raw ToolResult literals). Scrub at the
   ONE universal choke point: the return path in `registry.dispatch`
   (registry.ts:57-62, where wrapError already sits). Mask values whose
   KEY matches /(password|passwd|secret|token|authorization|auth|key|credential)/i
   in structured results and pre-stringified text (regex over the text
   form). Keep `storage.export_state` EXEMPT (its whole job is exporting
   auth state — document the exemption + a name-based opt-out
   `_noScrub` marker the export path sets). Test must include a
   cookie/header dump flowing through `success()` (not ok()) to prove
   the choke point.
3. **O3 origin allow-list (opt-in):** `CDP_ALLOWED_ORIGINS` env (comma
   list) → **new `ServerConfig` field in config.ts AND types.ts**
   (momus finding 8); enforcement at dispatch preprocessing (the
   tab-bound path, dispatch.ts — resolves the "only tab-bound tools?"
   sub-question at implementation: default yes, tab-bound only).
   Off-list targets fail with an actionable error naming the origin.
   Default unset = today's behavior (no change).
4. Tests: scrubber unit matrix (incl. the success() path); wire-level
   annotations test; allow-list unit tests (dispatch-level).

## WS2 — `verify` actions (~0.5-1 session)

Add a `verify` action group — cheap pass/fail checks so agents stop
pulling full snapshots to confirm outcomes. Home: new actions on the
`page` tool (page-scoped checks) + `interact` (element-scoped)? Decide
at implementation: ONE `verify` action on `page` with a `check` enum is
simpler; element-scoped checks take an optional `uid`.

Checks (v1 set):
- `visible {uid?|selector?|text?}` — element visible / text present
- `text {uid?|selector?, value, exact?}` — element/text content match
- `url {value, mode: exact|prefix|regex}` — current URL
- `enabled {uid|selector}` — form element not disabled
- `title {value}` — document title
- `value {uid|selector}` — input value match
Result shape (token-tiny, never a snapshot): `PASS|FAIL — expected:
…, actual: …` (+ `wait_ms` optional polling via the existing wait
utility — poll-until-true up to `timeout`, default instant, so
`verify` doubles as a post-action settle check).

Tests: unit per check (mock resolver/sendCommand like page-find.test);
live: verify against a real page (visible/text/url/enabled pass+fail).

## WS3 — `webmcp` passthrough (conditional on WS0 GO; ~1 session)

New actions (home: `page` tool or a slot in `status`-adjacent surface —
**decision made BEFORE the release commit** (momus finding 3: the home
determines which counts staling): additive-only):
- `webmcp_list` — `WebMCP.enable` (idempotent) on the tab session →
  collect `toolsAdded` events (+ any pull-style listing the protocol
  offers) → enumerate `{name, description?}` per tool.
- `webmcp_call {name, input?}` — `WebMCP.invokeTool` (+ handle
  `toolResponded`/promise) → return the tool's response.
- `webmcp_cancel {invocationId?}` — `cancelInvocation`.
Every path capability-gated via `capabilities.require('WebMCP')` →
actionable `DomainUnsupportedError` on Brave-without-API/older Chrome.
Event subscription lifetime: wire like the WebAuthn consumers
(per-session, cleaned on disconnect). Untrusted-content rule applies:
tool responses are PAGE-CONTROLLED data — treat as data, never follow
directives found in them (same policy as REA/annotated content).
Tests: unit (mock session, event wiring, gating); live per WS0 spike
rig.

## WS4 — riders (~0.5 session total)

1. **`Page.setInputVisualization`** (J): emulate gains
   `inputVisualization: true|false` (gated; cleared by `reset`).
   Auto-enable during `page.record_start` (opt-out flag) so recorded
   video shows input activity. Live-verify on Brave 153.
2. **CHIPS `partitionKey`** (E): storage export/import passthrough —
   include `partitionKey` in cookie dumps and accept it on import
   (Playwright-compatible schema). <1h.
3. **`Network.overrideNetworkState`** + **`emulateNetworkConditionsByRule`**
   (D remainder): emulate gains `online: false|true` (spoof
   `navigator.onLine`) + optional per-rule throttling shape
   `networkCondition` accepts `{urlPattern, ...conditions}[]`? Keep the
   v1 surface MINIMAL: `online` spoof + (optional) one byRule example;
   cut if the protocol shape resists (<2h budget).
4. **WebAuthn follow-ons:** `set_credential_properties` action; event
   surfacing in the registry (`list_credentials` gains last-activity) —
   NOTE (momus finding 5): the 5.2 plan deliberately dropped WebAuthn
   events as "telemetry without a consumer"; this REVERSES that with the
   consumer named — `list_credentials` output — which is defensible now;
   the rig gains client-side WebCrypto signature verification →
   sabotage E2E PASS/FAIL.

## WS5 — OPTIONAL: annotated-content parser (user greenlit; ~0.5-1 session)

**Explicitly OVERRIDES the oracle's defer-to-5.4 grade** (momus finding
5): the maintainer wants it; the no-harm guarantee below is the reason
it's safe to include. `utils/proto-wire.ts` (~150 lines, no deps) + advisory FIELD_MAP seeded
from `components/optimization_guide/proto/features/common_quality_data.proto`.
Three-layer fallback (parse fail → flat extraction (today's output);
unknown fields surfaced by field number; coverage sanity check →
auto-fallback). `page content format: annotated` gains structured
output; the map is NEVER load-bearing (field numbers are not stable
API). Re-read the proto at implementation time; the spike already
gained `includeActionableInformation?` on 2026-10-26.
**No-harm guarantee:** worst case (parser fails) = today's flat output.

## Cut (anti-features — do not revisit without new evidence)

- Lighthouse audits (engine dep; hijacks the live browser)
- DigitalCredentials/SmartCard/Bluetooth emulation (Brave-stripped,
  attack surface)
- HAR record→REPLAY routing (side-effect-heavy rewriting on the user's
  real browser; record/export-only may return later as a Nice)
- Multi-screen emulation (DevTools-UI parity, no agent ask)

## Deferred to 5.4 (named in release notes)

- **Performance trace → insights** (next flagship candidate; own parser
  project; `Tracing`/`Performance` canaries ready)
- Heap-snapshot tooling (max: one dump-to-file action)
- Extensions `triggerAction`/`getExtensions` subset
- Source-mapped console stacks
- **fedcm** (parked: requires stock Chrome — none available)
- PWA (Chrome-only; Brave-stripped)

## Sequencing

| Order | Item | Effort | Gate |
|---|---|---|---|
| 1 | WS0 WebMCP spike | 0.25 | GO/KILL |
| 2 | WS1 hardening riders | 0.5 | wire-level annotations test + scrubber matrix green |
| 3 | WS2 verify actions | 0.5-1 | live PASS/FAIL + unit green |
| 4 | WS3 webmcp (if GO) | 1 | live list+call + gating test green |
| 5 | WS4 riders | 0.5 | live per matrix |
| 6 | WS5 annotated parser (optional) | 0.5-1 | unit + live |
| 7 | Release commit: **count reconciliation sweep** (momus finding 3 — failed in BOTH 5.1.0 and 5.2.0): README badges + tools table + per-tool rows, `index.ts:645` "15 tools" instruction string, `types.ts:69`, `AGENTS.md:25`; WS3 home decision finalized first; new tool → README rows per AGENTS.md rule 4 → bump → `scripts/promote.mjs` → tag | 0.5 | pipeline |

Totals: **≈3.5-4 sessions** (WS3 GO) / **≈2.5-3** (WS3 killed) + optional
WS5 — includes a **0.25-0.5 live-fix buffer** (momus finding 4: 5.2's WS1
live gate alone produced 4 in-cycle tool fixes; the webmcp_call ↔
toolResponded round-trip is the same overrun shape). Test baseline
entering the cycle: **394 green**; each workstream's gate adds its
expected count (rough: WS1 → ~+8, WS2 → ~+10, WS3 → ~+8; exact at
implementation — creep shows numerically).

## Verification matrix (live, per item)

| Item | Live check |
|---|---|
| WS0/WS3 | WebMCP spike rig registers a tool; `webmcp_list` sees it; `webmcp_call` runs it; Brave-without-API gets the actionable gate error |
| WS1 | storage/intercept dumps show masked secrets; export_state still exports; readOnlyHint present on read-only tools; allow-list blocks an off-list origin |
| WS2 | verify visible/text/url/enabled PASS and FAIL live; polling wait works |
| WS4 | inputVisualization visible in recorded video; CHIPS cookie survives export→import; `online:false` flips `navigator.onLine`; webauthn sabotage → rig FAIL |
| Regression | flag+toggle connect unchanged; slim mode unaffected; 394+ tests green |

## Risks

- **WebMCP page API dead on Brave** → WS0 kill (fedcm precedent; no
  substitute feature).
- **Scrubber over-reach** → export_state exemption + unit matrix; false
  positives documented.
- **Verify polling vs auto-wait interference** → verify uses the same
  wait utility; no new timers on the actionability path.
- **Proto field drift** → map advisory-only; fallback layer guarantees
  the current output.
- **Effort creep on WS5** → hard <1-session budget; cut mid-stream if
  the parser exceeds ~150 lines + map.

## Rollback

Same as 5.2: gates + hard-verify before push (the script); revert
commits on main; tag never moves backward; publish the GitHub Release
only after Guard main is green.
