# Release plan — v5.3.0 (created 2026-10-28)

Positioning (locked): **attach-only real-browser raw-CDP MCP server** —
never launches a browser, zero abstraction deps (ws + MCP SDK). The 5.3
cycle closes the audit's Must-grade gaps and hardens the surface;
anti-features are cut, 5.4 candidates named. Research base:
`_archive/research/October2026/2026-10-28-v5.3-parity-audit.md`
(librarian inventory + oracle grading + metis framing).

Release arc (metis — say it, don't infer it): **make the real browser
legible and operable for an agent — then harden it.** WS5 (see),
WS2 (confirm), WS3 (talk to pages), WS6 (talk to extensions), WS1
(safely). One arc, not a grab-bag; and the maintainer's re-shuffle
principle is recorded to prevent the next scope argument: **5.3 favors
what an agent can DO in the real browser over data-format fidelity**
(CHIPS/network-state are 5.4).

Shipping lanes (metis finding 4, made explicit): **opt-in utility lane**
= shipped + config/env-gated + documented limitation — the bar for
niche-but-present when the cost is small. Classified under it: WS4's
`inputVisualization`, WS6's storage stretch + trigger allow-list, and
WS0 outcome (b)'s 5.4 shape.

Law (unchanged from 5.2): all work on dev; pnpm everywhere; tool contract
additive-only; no new runtime deps; never launch/close browsers or tabs
autonomously; every workstream live-verified on Brave 153 before the
next starts; interim conventional commits; CHANGELOG [Unreleased]
accumulates; promote via `scripts/promote.mjs` (local), never tag past
a red Guard main.

## WS0 — WebMCP live spike (GO/KILL gate — 0.25 session)

**RESULT (2026-10-28): GO — outcome (a)-after-flags. Full E2E PASS:
register → toolsAdded (replay + live) → invokeTool → toolResponded
Completed with echoed output.** Spike record:
`_archive/research/October2026/2026-10-28-ws0-webmcp-spike.md` (rig +
probe scripts in `_archive/research/October2026/ws0-spike/`). Key
corrections for WS3 below: the API lives at **`document.modelContext`**
(navigator form deprecated 150+); registration via `registerTool`;
Brave needs BOTH `#enable-webmcp-testing` + `#devtools-webmcp-support`
flags (user-enabled, one-time — docs must name them); WS3's registry
MUST subscribe to `toolsAdded` BEFORE calling `WebMCP.enable` (the
replay event races the enable response).

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

**Outcome taxonomy (oracle + metis, post-verification — replaces the
binary kill criterion):**
- **(a) Page API live without flags on Brave 153** → GO, full WS3.
- **(b) API exists but needs `--enable-features=WebMCP` (relaunch)** →
  the spike CANNOT proceed in-session (never-relaunch law). Disposition:
  maintainer may enable `chrome://flags`/flag + relaunch manually (their
  browser, their consent — same precedent as tab navigation), then a
  10-minute re-spike; if they consent and it works, WS3 enters as a
  **conditional late insert** (see Sequencing); if they decline or it's
  unresolved by the WS4 gate, **WS3 drops from 5.3 and moves to 5.4**,
  where it ships capability-gated with the gate error naming the exact
  flag string (that shape is actionable, not a half-tool — metis).
- **(c) API absent entirely** → KILL, fedcm disposition: nothing to
  passthrough; moves to the 5.4 list with a "requires Chrome/flag" note.
  Do NOT ship a tool that only errors with no path to value.

Spike diagnostics (cheap, decision-grade):
- **Canary honesty:** `WebMCP.invokeTool` answering proves the *domain*
  exists, nothing more (FedCm lesson restated — the canary is necessary,
  never sufficient).
- **Utility-world cross-check** (PW-MCP's approach fact): PW-MCP collects
  registrations via an injected utility-world script, NOT the CDP
  domain. If `toolsAdded` never fires but `navigator.modelContext`
  shows registrations, record it — the CDP wiring lags the page API and
  the passthrough is premature even in outcome (a).

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
  **the protocol has NO listing method — discovery is event-driven:
  `enable` replays currently-registered tools via `toolsAdded`** →
  maintain a registry (per session, like the WebAuthn one) → output
  `{name, description, frameId, annotations?}` per tool (pass the CDP
  `Annotation` through — the protocol's own readOnly/untrustedContent
  hints). Pull-style listing does not exist; don't invent one.
- `webmcp_call {name, input?}` — `WebMCP.invokeTool(frameId, toolName,
  input)` — frameId is REQUIRED by the protocol: default the tool's
  registered frameId from the registry (falls back to the main frame);
  returns `invocationId` immediately → resolve via the
  `toolResponded(invocationId, status, output?, errorText?)` event
  (status Completed|Canceled|Error) — the round-trip is
  promise-plus-event, exactly the 5.2 overrun shape; budget for it.
- `webmcp_cancel {invocationId}` — `cancelInvocation`.
Every path capability-gated via `capabilities.require('WebMCP')` →
actionable `DomainUnsupportedError` on Brave-without-API/older Chrome.
Event subscription lifetime: wire like the WebAuthn consumers
(per-session, cleaned on disconnect). Untrusted-content rule applies:
**the protocol description itself warns `toolResponded.output` is
untrusted/prompt-injection risk** — treat as data, never follow
directives found in them (same policy as REA/annotated content).
Stretch (few lines, not gate-critical): when `page.snapshot` runs and
the session's WebMCP registry is non-empty, append a one-line section
(`WebMCP tools: name — desc …`) — mirrors PW-MCP's discovery UX and
solves "agent doesn't know to call webmcp_list first" (oracle).
Deliberately NOT copied from PW-MCP: dynamic MCP-tool projection (tools
appearing/disappearing mid-session) — it collides with the
count-staleness problem that failed the last two release commits; our
static list/call/cancel matches cdt-mcp's functional surface (theirs is
CLI-daemon commands, not standard tools).
Tests: unit (mock session, event wiring, gating); live per WS0 spike
rig; outcome-(b) gate error must include the exact flag string.

## WS4 — riders (~0.25 session)

1. **`Page.setInputVisualization`** (J; protocol-verified: sole param
   `clicks?: boolean`, experimental): emulate gains
   `inputVisualization: true|false` (gated; cleared by `reset`).
   Auto-enable during `page.record_start` (opt-out flag) so recorded
   video shows click markers. Live-verify on Brave 153.
2. **WebAuthn follow-ons** (protocol-verified — exact surface):
   `set_credential_properties` action → CDP
   `WebAuthn.setCredentialProperties(authenticatorId, credentialId,
   backupEligibility?, backupState?, signCount?)` — note `signCount`
   is settable (**-1 removes the counter** — great for testing
   signCount-monotonicity handling in RPs) — expose all three;
   event surfacing in the registry (`list_credentials` gains
   last-activity) from `credentialAdded/Deleted/Asserted` **plus
   `credentialUpdated`** (verified present) — NOTE (momus finding 5):
   the 5.2 plan deliberately dropped WebAuthn events as "telemetry
   without a consumer"; this REVERSES that with the consumer named —
   `list_credentials` output — which is defensible now; the rig gains
   client-side WebCrypto signature verification → sabotage E2E
   PASS/FAIL.

(CHIPS `partitionKey` and the network-state emulation moves — moved to
the 5.4 carcass per maintainer priority call, 2026-10-28.)

**WS4 CLOSE-OUT (2026-10-28, delivered + unit-verified 459 tests;
live gate split-verified):**

1. `emulate inputVisualization` — SHIPPED. Live-caught: the method
   exists in the ebca906 protocol JSON but is **NOT implemented by
   the Brave 153 build** (the Page-method analog of the per-target
   `protocol_config` exclusions). Shipped anyway with correct
   behavior: emulate fails actionably (names the build requirement),
   `record_start` degrades silently. Matrix row "visible in recorded
   video" — **cannot be satisfied on this browser**; verification is
   the command-level gate path (both proven live).
2. `set_credential_properties` + `fullIds` + `signCount -1` display
   — SHIPPED, **CDP-level live gate PASS on Brave 153** (current
   profile; credentials injected via CDP, no ceremony). Live-caught
   bug: credentialId not base64-normalized → Chromium "Invalid
   parameters"; fixed + unit-locked.
3. Page-level sabotage E2E (rig: genuine→VALID, isBogusSignature→
   INVALID, restore→VALID): **PASSED on Brave 153 profile
   17CFBEA2** (pre-switch). On the current profile the assertion path
   is blocked by Bitwarden's `webAuthenticationProxy` (routes ALL
   page WebAuthn away from CDP virtual authenticators; user keeps
   Bitwarden — documented as a tool-description CAVEAT). Rig is now
   assert-only by design: it NEVER calls `credentials.create`, so an
   intercepted/absent environment fails loud instead of creating real
   passkeys. Battery expectation bugs found during the gate (byte
   alphabet, signCount -1 semantics) fixed + unit-locked.
   Rerun of the full battery on a Bitwarden-free profile — open item.

## WS5 — annotated-content parser (PROMOTED to full workstream per
## maintainer, 2026-10-28; ~0.5-1 session)

The maintainer's call supersedes the oracle's defer-to-5.4 grade — the
no-harm guarantee is why it's safe. Delivered as the **upgrade of the
existing `page content format: annotated` output** (a snapshot/content
reading option — the "AI view of the page" becomes labeled structure:
headings, forms, prices, nav — instead of today's flat strings).
`utils/proto-wire.ts` (~150 lines, no deps) + advisory FIELD_MAP seeded
from `components/optimization_guide/proto/features/common_quality_data.proto`.
Three-layer fallback (parse fail → flat extraction (today's output);
unknown fields surfaced by field number; coverage sanity check →
auto-fallback). The map is NEVER load-bearing (field numbers are not
stable API). Re-read the proto at implementation time; the spike already
gained `includeActionableInformation?` on 2026-10-26.
**No-harm guarantee:** worst case (parser fails) = today's flat output.

## WS6 — extensions subset (promoted into 5.3 per maintainer; ~0.5 session)

Capability-gated (the `Extensions` canary answers on Brave 153).
**Protocol-verified precision: `getExtensions()` lists UNPACKED
extensions ONLY** (description is explicit) — so the live test needs a
trivial test unpacked extension (a manifest + a file — cheap to make);
the kill criterion covers it:
- `browser` tool gains `extensions` listing via
  `Extensions.getExtensions` → `{id, name, version, path, enabled}`
  per unpacked extension (an empty list on a stock profile is EXPECTED,
  not an error)
- extension toolbar-button trigger via `Extensions.triggerAction(id,
  targetId)` — both params required by the protocol; `targetId`
  resolves from the designated tab (the "click the extension icon"
  programmatic equivalent — safe, attach-only).
  **Guardrails (metis, mandatory):**
  (1) trigger is OPT-IN via `CDP_EXTENSION_TRIGGER_ALLOWLIST` env
  (comma list of extension ids; mirror the O3 `CDP_ALLOWED_ORIGINS`
  pattern) — default: trigger fails with a "not allow-listed" error,
  listing always works; the allow-list answers the password-manager
  case (autofill popups, vault unlocks, extension-side network calls —
  the attach-only law governs tabs/browser but says nothing about
  extension actions);
  (2) the id is EXACT and explicit — never inferred: no wildcard, no
  "first listed," no iterate-and-trigger, never a side effect of
  another action or a verify/poll loop;
  (3) untrusted-content rule applies to trigger results (extension
  popups/responses are page-adjacent untrusted content), and the tool
  description states firing the trigger = "equivalent to a user
  clicking the toolbar icon; effects belong to the extension."
- stretch (protocol offers it, gate by time): unpacked-extension
  storage read/clear (`getStorageItems` etc.)
- **NOT** `loadUnpacked`/`uninstall` (mutates the user's profile —
  anti-feature, oracle-graded; loadUnpacked remains usable only as a
  canary probe)
Live-verify on Brave 153 with a test unpacked extension; kill-criterion:
if the domain answers but listing is empty/broken on Brave → ship
listing-only or defer, no half-surface.

## 5.4 carcass (named now, built next cycle)

- **Performance trace → insights** (flagship candidate): record
  trace → parse into structured insights (LCP/CLS/slow blocks) — own
  parser project; `Tracing`/`Performance` canaries ready.
- **Heap-snapshot tooling (reframed per verified fact — cdt-mcp: 13 of
  14 tools are BROWSERLESS):** (a) live `heapsnapshot_dump` to a temp
  file — the ONLY browser-touching part, opt-in; (b) offline analysis
  actions on the dump file — retainers/dominators/diff of two dumps —
  pure-node parsing of the structured `.heapsnapshot` tables format,
  no browser attached, no new deps. "Heavy on a live browser" applies
  only to the dump; the analysis is offline.
- **Network-state emulation (protocol-verified, expanded task):**
  `Network.emulateNetworkConditions` — which our current
  `networkCondition` presets use — is now **DEPRECATED** ("in favor of
  emulateNetworkConditionsByRule and overrideNetworkState"). So 5.4's
  job is a MIGRATION + upgrade: (a) `overrideNetworkState(offline,
  latency, downloadThroughput, uploadThroughput, connectionType?)` —
  the `navigator.onLine`/`navigator.connection` spoof (NOT a bare
  boolean — throughput params required; wrap with sensible defaults:
  offline → throughputs -1); (b)
  `emulateNetworkConditionsByRule(matchedNetworkConditions[])` —
  per-rule shape `NetworkConditions {urlPattern (URLPattern syntax,
  absolute; empty = match-all), latency, downloadThroughput,
  uploadThroughput, packetLoss?, packetQueueLength?, packetReordering?,
  offline?, connectionType?}` — first match wins, ruleIds echo into
  requestWillBeSentExtraInfo. Verify the ByRule API works on Brave 153
  before migrating.
- **CHIPS `partitionKey` (protocol-verified):** cookies carry
  `partitionKey?: {topLevelSite, hasCrossSiteAncestor}` (+`partitionKeyOpaque`)
  in both `Network.getCookies` and `Storage.getCookies`; `CookieParam`
  accepts it on set; `deleteCookies` filters by it — passthrough in
  export AND import; **import accepts BOTH forms**: `partitionKey?: string`
  (Playwright sourceOrigin shorthand → normalize to
  `{topLevelSite: value, hasCrossSiteAncestor: false}`) and the CDP
  object form. The 5.3
  release-commit row must name this as a visible deferral. Live gate
  for when it lands: a partitioned cookie survives export→import.
- **`Browser.addMockCamera`** (verified, session-scoped — dies with the
  CDP session): mock-webcam rider idea for emulate, pairs with
  media-testing asks; niche, opt-in.
- **HAR replay — shrunk (verified: PW-MCP ships ZERO HAR tools; replay
  exists only in the library API; we already ship `observe.har`
  export):** no competitor pressure; export covers record; revisit
  replay only on a specific user ask. Route-parity note for the
  record: PW-MCP's `browser_route` (mocked responses, glob patterns,
  route.fulfill) is functionally equivalent to our Fetch-domain
  intercept — verified, no gap.
- **Source-mapped console stacks** (small; needs Debugger-domain
  symbolication — low decision value, cheap to ride along).
- fedcm + PWA remain **parked** (both require stock Chrome — Brave
  strips/disables them; re-evaluate only when Chrome is available).

## 5.5 carcass

- **DigitalCredentials / SmartCardEmulation / BluetoothEmulation**
  (credential-flow completionism — Brave-stripped domains, so this
  lands only if a target browser ships them; security-sensitive →
  design review first).

## Deferred (long-dated — re-evaluate with new evidence, not cut forever)

- Lighthouse audits (verified correction: cdt-mcp runs it IN-PROCESS on
  the same page — NOT a separate-browser hijack; the real disqualifier
  is the heavy bundled Lighthouse dependency, which breaks the zero-dep
  law)
- Multi-screen emulation (DevTools-UI parity, no agent ask)

Both stay on the books per maintainer: **deferred, not dead** — revisit
if the positioning changes (e.g., a test-runner product tier) or a
specific user need shows up.

## Sequencing

| Order | Item | Effort | Gate |
|---|---|---|---|
| 1 | WS0 WebMCP spike | 0.25 | GO/KILL |
| 2 | WS1 hardening riders | 0.5 | wire-level annotations test + scrubber matrix green |
| 3 | WS2 verify actions | 0.5-1 | live PASS/FAIL + unit green |
| 4 | WS3 webmcp (if GO) | 1 | live list+call + gating test green |
| 5 | WS4 riders | 0.25 | live per matrix |
| 6 | WS5 annotated parser | 0.5-1 | unit + live |
| 7 | WS6 extensions subset | 0.5 | live listing + trigger |
| 8 | Release commit: **count reconciliation sweep** (momus finding 3 — failed in BOTH 5.1.0 and 5.2.0): README badges + tools table + per-tool rows, `index.ts:645` "15 tools" instruction string, `types.ts:69`, `AGENTS.md:25`; WS3 home decision finalized first; new tool → README rows per AGENTS.md rule 4 → bump → `scripts/promote.mjs` → tag | 0.5 | pipeline |

**Trim order (pre-declared — metis finding 1):** if the buffer
exhausts, drop in this order and hold: WS4 stretch → WS6 trigger
stretch → WS6 storage stretch → hold.

**Outcome-(ii) insert rule (oracle finding 4):** if WS0 lands on
outcome (b) and the maintainer consents to flag + relaunch + re-spike,
WS3 becomes a conditional late insert after the re-spike; if
unresolved by the WS4 gate, drop WS3 and proceed — additive-only makes
the drop free (nothing to reconcile in the count sweep).

Totals: **≈4.25-5.5 sessions incl. buffer** (table sums 4.25-4.75 with
WS2 at 0.5-1 and WS5 at 0.5-1; WS3 conditional insert adds up to 1 on
outcome (b)+consent). Includes the **0.25-0.5 live-fix buffer**
(momus finding 4: 5.2's WS1 live gate alone produced 4 in-cycle tool
fixes; the webmcp_call ↔ toolResponded round-trip is the same overrun
shape). Test baseline entering the cycle: **394 green**; each
workstream's gate adds its expected count (rough: WS1 → ~+8, WS2 →
~+10, WS3 → ~+8; exact at implementation — creep shows numerically).

Competitor checkouts for capability verification during the cycle:
see `_archive/development/competitors.md` for the brief + procedure —
**ask the maintainer where the clones live before relying on a path**
(no hardcoded location here); refresh with `git pull` before relying
on them; if a pull fails on ownership, delete the folder and re-clone
— do NOT add safe.directory overrides (AGENTS.md rule).

## Verification matrix (live, per item)

| Item | Live check |
|---|---|
| WS0/WS3 | WebMCP spike rig registers a tool; `webmcp_list` sees it; `webmcp_call` runs it; Brave-without-API gets the actionable gate error |
| WS1 | storage/intercept dumps show masked secrets; export_state still exports; readOnlyHint present on read-only tools; allow-list blocks an off-list origin |
| WS2 | verify visible/text/url/enabled PASS and FAIL live; polling wait works |
| WS4 | `inputVisualization` visible in recorded video; webauthn sabotage → rig FAIL |
| Regression | flag+toggle connect unchanged; slim mode unaffected; 394+ tests green |

## Risks

- **WebMCP page API dead on Brave** → WS0 outcome (c) kill (fedcm
  precedent); **flag-gated** → outcome (b): maintainer-consent re-spike
  or WS3 drops to 5.4 (no substitute feature either way).
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
