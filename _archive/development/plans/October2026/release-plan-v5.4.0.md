# Release plan — v5.4.0 cycle, shipped as two feature halves: 5.3.5 + 5.4.0 (created 2026-10-29)

Consultative base: metis pre-planning brief (intent + risks + user
questions), oracle binning/design brief, momus pre-draft rigor checklist.
Their findings were reconciled by the maintainer-flow author on 2026-10-29;
divergent points are labeled where they landed differently.

**Maintainer directive (governing):** *"we will release features in 2
halves, 5.3.5 and 5.4.0, so plan and divide work in similar areas into one
release post testing then next one."*

**Recorded deviation from repo convention (metis finding, resolved by the
directive):** historically `X.Y.5` = fixes only. The directive redefines
5.3.5 as the FIRST FEATURE HALF. Consequences, baked in below:
- `[5.3.5]` CHANGELOG **gets an Added section** (unconventional, deliberate).
- Docs never describe 5.3.5 as a bugfix release.
- The coord-sweep discipline still applies to both halves (momus T1-1).

Positioning (continuity from 5.3): attach-only real-browser raw-CDP MCP
server; never launches/closes browsers, tabs, or processes; zero
abstraction deps. Arc for 5.4: **make the browser state fully steerable
(controls), then make its costs fully legible (observability).**

## Law (unchanged from 5.3, two-lane clause added)

All work on dev; pnpm everywhere; tool contract additive-only; no new
runtime deps (ws + MCP SDK hard cap — all parsers hand-rolled, NO
trace/heap npm libs); never launch/relaunch/close browsers or tabs
autonomously; every workstream live-verified on Brave 153 BEFORE the next
starts (canaries before migration code — momus T1-3); interim conventional
commits; CHANGELOG [Unreleased] accumulates; promote via
`scripts/promote.mjs` from a clean tree; never tag past a red Guard main;
GitHub Release only after guard green. **Two-lane clause:** features are
planned into two releases (5.3.5 then 5.4.0), each release gets its own
count sweep + promote + tag + guard-green check; features never slide
LATE between halves once gates open — a missed 5.3.5 item lands in
5.4.0, never delays the 5.3.5 tag (trim order supplies the cut).

Live-gate discipline (AGENTS.md): one script = one CDP connection = one
Allow dialog; batteries archived under `_archive/research/October2026/` at
close-out; WebAuthn rigs assert-only forever (Bitwarden law).

## WS7 — WS0-style canaries, three batches (0.25–0.5, GATE for everything)

**RESULT (2026-10-29): LIVE-RECORDED. Batches A (2 connections + 1 CHIPS
debug) / B (2) / C (1) — evidence scripts + JSON in
`_archive/research/October2026/ws0-spike/probe-batch-*` + results json.
Outcomes per claim:**

- **A — ByRule: GO.** `Network.emulateNetworkConditionsByRule` live on
  Brave 153. Confirmed by BUILD (not JSON): empty body rejects (−32602
  "mandatory field missing at position 8" → `matchedNetworkConditions`
  required); `{urlPattern:'', latency, downloadThroughput, uploadThroughput}`
  accepted → `ruleIds[]` echo; 1200ms-latency rule moved a 11ms fetch to
  ~1238ms (throttle lands); `Network.requestWillBeSentExtraInfo` carries
  **`appliedNetworkConditionsId`** = ruleId echo; clear =
  `matchedNetworkConditions: []` (verified timing restored); **rules
  survive navigation** (A9) → `emulate reset` MUST clear explicitly;
  rule applies ACROSS Fetch intercept paused→continued (A5);
  `setBlockedURLs` coexistence inconclusive binary in batch A — WS8 gate
  must prove a blocked request while a rule is active (not a blocker:
  separate mechanisms).
- **A — overrideNetworkState: GO.** `offline:true` flipped
  navigator.onLine live; reset-by-default-values works. Tool-level
  clear semantics = the same call with neutral values.
- **A — Browser.addMockCamera: KILL (ghost #2).** `-32601` on Brave 153.
  No camera rider in 5.3.5; design preserved for 5.5 carcass
  (condition: Chromium ≥ the version that ships the method).
- **A — CHIPS: GO (re-shaped gate).** Page-JS writes of 3P cookies ALL
  dropped by Brave shield (partitioned-secure, partitioned,
  plain — three shapes recorded, `document.cookie` silently no-ops) —
  standing Brave caveat in tool docs. CDP path WORKS: `Network.setCookie`
  + `partitionKey` REQUIRES `secure: true` (else "Sanitizing cookie
  failed") and `hasCrossSiteAncestor` is MANDATORY on this build;
  accepted with `topLevelSite: 'http://localhost'` (site form, no
  trailing slash); `Storage.getCookies` returns the full partitionKey
  object back; `Network.deleteCookies` takes the partitionKey param.
  WS9's live gate is now: CDP-set partitioned cookie → `get_cookies`
  shows it with its partitionKey → export → clear → import → identical
  partitionKey object equality. (Non-blocking sub-check repeatable at
  WS9 gate: setCookie via CDP with mismatching topLevelSite behavior.)
- **B — Tracing: THEY LIVE (expectations reshaped).**
  `recordMode: recordAsMuchAsPossible` REQUIRED — `recordUntilFull`
  truncated at ~63KB and lost the render-driven events (B1). Winning
  category set is a SINGLE string `'loading'` (B2-3: captures
  `largestContentfulPaint::Candidate` WITH args.data (nodeName, size,
  candidateIndex, isMainFrame, navigationId) AND `LayoutShift` WITH
  `had_recent_input:false`, `cumulative_score`, impacted node rects;
  `'devtools.timeline,devtools.timeline.frame'` captured only LCP — NOT
  CLS); combined `['devtools.timeline','loading']` also works (B2-4).
  `tracingComplete` = `{dataLossOccurred}` only; chunk pacing small
  (13–15 chunks/trace); EventTiming (×32) surfaced ONLY with `'v8'`
  included (B3) — interaction-delay class needs a WS10-stage probe on
  the shipping category set; LongTask/RunTask ABSENT in every category
  combination probed = bound risk: WS10 ships LCP/CLS first-class,
  long-task class flagged limited-GO pending its WS10 probe (possible:
  requires `v8` or `devtools.timeline` + JS sampling categories).
  Thread-write re-check also owed: real navigation trace (B4) stayed
  dataLoss-free.
- **C — HeapProfiler: GO.** `takeHeapSnapshot` streamed 13 chunks /
  12.63MB in 540ms for the rig; `reportHeapSnapshotProgress` events with
  final `{done, total, finished:true}`; `addHeapSnapshotChunk` head is
  the `.heapsnapshot` JSON meta header (node_fields incl
  `detachedness` — newer format than classic wikis); session stayed
  LIVE after the snapshot (C5, evaluate answered — no stall on this rig
  size); full snapshot persisted at
  `batch-c-snapshot.heapsnapshot` for parser development + ground-truth
  marker present ×3. WS11's committed unit fixture stays synthetic,
  this is the live-format sanity sample.
- **C9 regression: PASS-with-note.** Fresh-dist spawn → v5.3.0 up in
  7ms, ping OK; `Connected:false` is the correct pre-first-browser-tool
  state; the connect-mode strings check stays the AGENTS.md local-
  verification checklist (user's live session already exercises it).

**Sequencing constraint discharged — WS8/WS9/WS10/WS11 code may start.

Rig extensions built WITH the canaries: (a) slow-rig page — eager LCP
candidate + a CLS-generating layout shift (`hadRecentInput:false` path) +
a 200ms+ long task; (b) rig iframe section — third-party iframe for
partitioned cookies. Rig home: `_archive/research/October2026/ws0-spike/`
(extend `serve.mjs` dir content; README already documents the pattern).

**Batch A — network / emulation / CHIPS** (connection 1):
- `Network.emulateNetworkConditionsByRule`: method existence, param shape,
  response echo — evidence from the LIVE build, never the protocol JSON
  (inputVisualization precedent). Must include the equivalence check:
  does a match-all rule produce the throughput/latency profile of
  `Network.emulateNetworkConditions` as measured by timing the rig?
- Clear transaction: does empty-rules reset clear, or is a dedicated
  clear method required? (Decides `emulate reset` design.)
- Coexistence: ByRule + `Network.setBlockedURLs` (expect yes — different
  mechanism); ByRule + Fetch-domain intercept (paused→continued request
  still rule-matched? `requestWillBeSentExtraInfo` echoes pre- or
  post-rewrite URL?).
- `Network.overrideNetworkState`: existence, params (offline/onLine spoof).
- `Browser.addMockCamera`: call shape (browser-level session like
  `Browser.grantPermissions`?), returned id, does rig `getUserMedia` see
  it, permission grant needed, clear method name.
- CHIPS: `Network.setCookie` accepts `partitionKey` on Brave 153;
  `getCookies` returns it; `deleteCookies` filters by it; partitioned
  set rejects when `topLevelSite` mismatches the tab's top-level site.
Outcome per claim: GO / limited-GO (ships behind an actionable gate error
naming the build requirement — inputVisualization shape) / KILL (design
preserved verbatim below, moves to 5.5 carcass, no half-tool).

**Batch B — Tracing** (connection 2):
- `Tracing.start` category sweep: exact category strings that carry
  `largestContentfulPaint::Candidate`, `LayoutShift` (with
  `hadRecentInput`), long tasks (`RunTask`/`LongTask`), EventTiming /
  interaction-delay on Brave 153 → the shipped category set.
- `dataCollected` chunk size/pacing; `tracingComplete` timing;
  `dataLossOccurred` flag behavior; trace survival across same-tab
  navigation; per-target build exclusions (inputVisualization class of
  ghost).

**Batch C — HeapProfiler + regression piggyback** (connection 3):
- `HeapProfiler.enable` behavior; `takeHeapSnapshot` chunk/progress event
  shapes; realistic snapshot size for the rig; whether a snapshot stalls
  other-tab traffic (the `raceBounded` precedent class — observe.ts).
- Piggyback the standing regression spot-checks on the same connection:
  flag+toggle connect, ping/status mode strings.

All three batches: one script each, archived per gate discipline at
close-out. Sequencing constraint (hard): **no WS8/WS9/WS10/WS11 code is
written before its batch's outcome is recorded in this file.**

## 5.3.5 — "controls" half (≈1.25–2.0 sessions)

**CLOSE-OUT (2026-10-30): SHIPPED as v5.3.5.** npm + GitHub Release published,
Guard+CI green at tag. Lines below record the per-row results:
- **WS8 — DONE** (`7842537`): code + 16 unit tests (baseline 479 → 495) +
  live gate **9/9 PASS** (live-ws8.mjs: baseline 7ms → slow3g 2039ms →
  networkRules precedence 316ms → navigator offline spoof → reset
  un-throttles + restores onLine). `mockCamera` was already KILL by WS7 —
  the trim-order rider never existed to cut.
- **WS9 — DONE** (`16dde09`): code + 8 unit tests (495 → 503) + live gate
  **8/8 PASS** (live-ws9.mjs: shorthand set → `| partitioned:` shown →
  export passthrough → clear → import → **object-equality round-trip** →
  partition-scoped delete; a bonus cross-check: the WS7-era `ws7_v1`
  cookie still round-tripped identically). Harness smoke on the 5.3.5
  dist: same story (second-source cross-check COMPLETE: live tools/list
  + unit registry agree — schema carries networkRules/overrideNetworkState/
  partitionKey).
- **WS4 battery rerun — DONE — GATE PASS 7/7** on the maintainer's
  running CDP Brave (no profile change; Bitwarden stands). 6/7 by the
  letter, then the 7th surfaced a REAL product bug, not a rig problem:
  the WS1 scrubber's PLAIN_PAIR masked `credentialId: …` to `***`
  (SECRET_KEY matches "credential"), defeating fullIds' contract. Fixed
  forward with the scoped `_noScrub` opt-out on list_credentials
  (export_state precedent; listings carry identifiers, never key
  material); unit test pins the unmasked full id; rerun → **PASS**.
  The page-level create-path assertion stays Bitwarden-routed (standing
  caveat per WS4 rule — the re-declared PASS basis for the CDP path is
  the alternative-verified route). Bitwarden was never disabled.
- **npm decision — DONE** (kept `cdp-mcp-server`, recorded above).
- **5.3.5 count sweep (verification mode) — DONE** at the release commit
  (`f722c8b`): tools **15 unchanged**; badge **130+ unchanged**;
  README tools table — emulate 16→18 (networkRules + overrideNetworkState
  property rows), storage 11 with CHIPS notes; instruction string
  unchanged (no new tool names); both README files touched; second
  source (live tools/list of the 5.3.5 dist) agrees.
- **Self-audit (T2-10):** planned ≈1.25–2.0 sessions; actual — canaries
  3 batch-scripts + 5.3.5 feature rows + rerun + release ≈ 2.0 sessions
  (within plan; the +0.25–0.5 live-fix buffer ABSORBED the scrubber
  bug — it worked).

### WS8 — emulate: ByRule migration + emulation riders (0.5–1)

Homes (locked pre-release, momus T1-16): all in `emulate`.
1. **Backward-compatible transport swap** for `networkCondition` presets:
   tool-level param names/semantics/outputs unchanged; capable browsers
   emit one match-all ByRule rule (first-match-wins ⟹ exactly one match);
   method-missing → silent legacy `Network.emulateNetworkConditions`
   fallback (`isMethodMissingError` pattern, devicePosture precedent at
   emulate.ts:171). Branch decided once per session, cached like
   capability checks.
2. **Additive `networkRules: [...]`** param — CDP NetworkConditions
   shape passthrough, first-match-wins. Precedence locked: if both
   `networkRules` and `networkCondition` present for the network key,
   `networkRules` win.
3. **`emulate reset` grows a ByRule clear step** (emulate.ts:52–57
   today only knows legacy presets-none). The clear transaction from
   Batch A decides shape. A rule surviving reset = gate FAIL.
4. **`mockCamera: true`** param → STRUCK — WS7 KILL: `Browser.addMockCamera`
   absent on Brave 153 (ghost #2, `-32601`). Nothing ships; design
   preserved in the 5.5 line below.
5. **`overrideNetworkState` action** (navigator.onLine/connection spoof,
   carcass spec, ~30 lines) — if Batch A proves it. Rider — trim-able
   FIRST.
6. Opt-in lane (metis T2-9): `mockCamera` ships in the opt-in utility
   lane (device-spoofing niche); its unreachable-state gate error names
   the exact remedy. ByRule+networkRules = normal surface.
7. Fetch-intercept caveat text (tool description + README row) is
   WRITTEN AFTER Batch A, never assumed.

Unit delta ≈ +10 (preset→rule mapping, fallback branch, reset ordering,
precedence, validation: throughput −1 sentinel, packetLoss bounds).
**Gate (binary):** live rig under a ByRule rule shows throttle-shaped
timing; `isMethodMissingError` fallback TRUE on an injected miss;
`emulate reset` leaves zero live rules (extraInfo echo silent).

### WS9 — storage: CHIPS partitionKey round-trip (0.25–0.5)

Carcass spec carried over (`StateCookie.partitionKey?: string |
{ topLeft… topLevelSite, hasCrossSiteAncestor }` — export passes the raw
CDP object untouched; import accepts the CDP object AND a Playwright
`sourceOrigin` string shorthand normalized to
`{topLevelSite, hasCrossSiteAncestor:false}`); new optional
`partitionKey` params on `set_cookie` / `delete_cookies`.
- Security note (momus T3-14): partitioned cookies flow through the
  `_noScrub` `export_state` exemption unscrubbed, by design — the tool
  description says so. Legacy state JSON imports unchanged (absent
  partitionKey takes the old path).
- Visible-output delta (goes in CHANGELOG Changed):
  `get_cookies` lines gain a `| partitioned: <topLevelSite>` suffix when
  present.
Unit delta ≈ +6 (normalize string form, object form, reject-no-domain
cookie, export passthrough, round-trip on fake model).
**Gate (binary, reshaped at WS7):** a partitioned cookie SET VIA the CDP
protocol path (`secure: true` + mandatory `hasCrossSiteAncestor` — Brave
shield silently drops page-JS third-party writes) survives export →
clear → import with IDENTICAL partitionKey (object-equality assertion in
gate script).

### Chores (folded into the 5.3.5 release rows)

- **WS4 battery rerun on the maintainer's CDP-enabled Brave** (momus
  T1-5; carries the 5.3 open item): precondition — none new; the
  running Brave instance stays as-is (never-relaunch law; no new
  profile). One dedicated connection; battery =
  `_archive/research/October2026/ws0-spike/live-ws4-cdp.mjs` +
  `webauthn-rig.html` via fresh dist; expected re-assertions:
  genuine→VALID, `isBogusSignature`→INVALID, restore→VALID at the CDP
  level; page-level `credentials.create` path may stay Bitwarden-routed
  (`webAuthenticationProxy`, the maintainer's standing choice). On any
  BLOCKED outcome the close-out re-declares PASS as the
  alternative-verified path and sharpens the CAVEAT text
  (inputVisualization rule). If the maintainer happens to disable
  Bitwarden for the gate window, full page-level validation happens —
  their call, at gate time.
- **npm name-collision decision** — DEADLINE: before the 5.3.5 tag
  (packaging metadata attaches to the tag). **Decision (2026-10-29,
  maintainer): KEEP `cdp-mcp-server`.** Arms considered: rename to the
  natural sibling `cdp-browser-mcp` — impossible, occupied by an
  unrelated product; rename to any other name — breaks install lines,
  docs, repo-config comments for marginal gain on an established
  7-version package. No work item; the 5.3-era name-collision note in
  competitors.md is closed.
- **5.3.5 count sweep (verification mode)** (momus T1-1/T1-4d): confirm
  NO counts moved: badges + tools table in BOTH README.md files (root +
  `MCP Server/README.md` — the miss shape of both failed releases),
  `index.ts` instruction-string "15 tools" + its action listing,
  `types.ts` roster line, AGENTS.md Structure line. One tool (emulate)
  row changes shape (+1 action only if `overrideNetworkState` lands) —
  re-derive action total from `registry.ts` wiring and cross-check
  against a SECOND source (live `tools/list` output or a
  dispatch-allowlist test).
- Release mechanics: bump `package.json` + `VERSION` const together →
  `[5.3.5]` CHANGELOG (Added for WS8/WS9 features, Changed for the
  get_cookies line + CAVEAT text, Fixed for any in-cycle fixes) →
  release commit → `promote.mjs v5.3.5` → Guard+CI green → tag → npm.

Trim order 5.3.5 (pre-declared): `overrideNetworkState` → hold (ByRule
migration, CHIPS, sweep, chores never trim; mockCamera already killed by
WS7).

## 5.4.0 — "observability" half (≈2.75–3.25 sessions)

### WS10 PROBE RESULT (Batch B3/B4 — 2026-10-30, Brave 153 as-is, Bitwarden stands)

Scripts: `probe-batch-b3-tracing.mjs` (+ `batch-b3-results.json`), refined
self-diagnosing rerun `probe-batch-b4-tracing.mjs` (+ `batch-b4-results.json`).
One connection each; 2 Allow dialogs of the 3-dialog budget spent. Refinement
context: b3's first [loading] trace was COLD (316 events, zero paint classes —
the B2-day pattern where trace #1 is a dud) — but warm traces ALSO came up
empty while the b4 volume probe `[v8, loading]` captured everything. Recorded
chirally — per-class decisions per the pre-declared binary rule:

| Class | Verdict | Evidence |
|---|---|---|
| LCP | **GO** | B2-day `[loading]`: full shape (`candidateIndex, isMainFrame, nodeId, nodeName, performanceTimelineNavigationId, size, type` + frame) — B4-day `[v8, loading]`: `largestContentfulPaint::Candidate` ×1 again (even with page HIDDEN — browser-side metric pipeline, not paged paint) |
| CLS | **GO** | B2-day `[loading]` full shape: `cumulative_score, had_recent_input, frame_max_distance, impacted_nodes[{node_id,old_rect,new_rect}]` — B4-day: `LayoutShift` ×1 |
| LongTask | **KILL** | Rig ground-truth PROVED 250ms busy tasks ran (`__PERF.longTasks` ×2 page-side) — trace surfaced ZERO named `LongTask` events across every combo tried over two days (`devtools.timeline`, `v8`, `+devtools.timeline.frame`, `+disabled-by-default-devtools.timeline`, pristine & busy-driven). The 3575 `RunTask` events (`disabled-by-default-devtools.timeline`) are scheduler-generic with NO long-task semantics — unusable as an insight (would be fake). Non-negotiable: no LongTask row ships in 5.4. |
| EventTiming / INP | **KILL** | B1-day ×32 (in a `[devtools.timeline, v8]` context) — ZERO today across 3 configs incl. v8+loading and the full busy overlay. Input-dependent; the rig cannot synthesize user input. |
| v8 event volume | moot | v8 does NOT ship (no surviving class needs it). For the record: worst observed 637 warmup / 5477 busy-overlay total, maxChunk 405 — parse-once safe with enormous margin. |

**Architecture decisions locked by this result:**
1. **Category set = the single string `'loading'`** (lightest, and the ONLY
   set with complete field shapes for BOTH shipped classes). `'v8'` re-enters
   only if a carcass class revives.
2. **Aggregator = parse-once at stop** (`perf_stop` aggregates all
   `dataCollected` chunks arriving before `tracingComplete`). No incremental
   redesign — volumes are 2-3 orders of magnitude under the 50k cap.
3. **Flush-lag constraint (NEW, from the b4 diagnostics):** paint-gated metric
   events are emitted by the browser-side pipeline on a lagged flush cadence
   (b4's `__PERF` showed page-side shifts at 2.3s that the same window's
   `[loading]` trace missed, while a LATER trace captured them). The
   aggregator MUST include every chunk up to `tracingComplete` (it will), and
   the live gate runs under slow3g throttling — the stretched load window
   (2s+) is exactly where flush coverage aligns. `perf_start` description
   should note capture quality depends on page rendering activity.
4. Probe-script artifact on record: `Runtime.evaluate` boot-checks printed
   "undefined" BOTH days even when trace capture worked — never chased; NOT a
   product signal (the raw-response report in b4 confirmed the evaluations
   actually returned strings).

**Open maintainer input at WS12 (only if the bounded retry is pursued):**
EventTiming's one retry needs a REAL user-driven input event on the rig
(page observers can't fake it) — says so in the WS12 row if it ever runs.

**GATE RESULT ADDENDUM (2026-10-30, ~17:00 local) — WS10 gate PASS with a
material behavioral discovery.** The gate (`live-ws10.mjs`) ran live via
the shipped tool path (stdio MCP client → 5.3.5 dist with the new
actions): attempt A (default `['loading']`, slow3g ByRule via the
`emulate` tool, reload, 8s window) captured **LCP at 552ms (rig
`H1 id='lcp'`, 49619B) + 4 LayoutShifts through the complete flush**,
second-stop contract PASS. `dataLoss=false`, "trace complete". Verdict:
**GATE PASS, shipping category set = `['loading']`** (the restricted
`categories: ['v8']` escalation shipped unexercised; kept as the
pre-declared escalation path).

- **Nondeterminism finding (recorded honestly):** across the SEVEN
  instrumented gate attempts (multiple flows — reload, mid-trace page
  death, escalated `v8`, 12-20s windows, user-focus kept), the per-frame
  paint-metric classes surfaced on SOME runs and not others — including
  a PASS with the audited page state `vis=hidden|focus=false`
  (falsifying the earlier foreground-surface hypothesis). On zero-class
  runs the trace DID receive chunks (up to 10) but only the UMA/flush
  variants (`NavStartToLargestContentfulPaint::AllFrames::UMA`,
  `MetricsWebContentsObserver::UpdateTiming`,
  `PageTimingMetricsSender::SendNow`...). This is browser-side emission
  behavior we cannot force; the tool's zero-class hint names the
  nondeterminism + retry (and the plan's earlier "throttled window
  aligns the flush" prediction is NOT what the gate showed).
- The diagnostic instrumentation added during the hunt stays: every
  output row carries chunk/append stats + zero-class names — token-cheap,
  honesty-positive.
- Dialog spend for WS10 total: 7 (probes 2 + gate attempts 5); the
  revised budget line (4) was blown by the hunt — recorded for the
  close-out self-audit.
- Artifact: `live-ws10-output.json` (all attempts' raw outputs),
  `batch-b3/b4-results.json` (probe phase).

### WS10 — perf insights flagship (1–1.5)

**STEP ZERO — DONE (result recorded above, printed before the WS11
section; all pre-conditions decided by live evidence, no code has been
written against an unproven category set).**

Home (locked): **`observe`, additive actions `perf_start` / `perf_stop`**
— NOT a new tool; dodges the 15-tools string/badges' tool-count half of
the sweep; observe's description already enumerates ops (momus T1-1).
- `perf_start` = `Tracing.start` with `recordMode:
  recordAsMuchAsPossible` and the probe-PROVEN category set (pristine
  `'loading'` captures LCP candidate + LayoutShift with
  `had_recent_input` on Brave 153; alone `devtools.timeline…` variants
  did NOT). Shipping any category set NOT proven live at gate time is
  prohibited. Records session-state baseline; returns immediately.
- `perf_stop` = `Tracing.end` + accumulate `dataCollected` chunks until
  `tracingComplete`, aggregate (architecture per probe outcome above),
  DISCARD raw events. Insight classes exact per probe RESULT:
  LCP (last candidate per frame: ms, size, tag hint); CLS (sum minus
  `hadRecentInput`, count, worst single); long tasks / interaction
  delay / slow-block classes ONLY if the probe GOes them.
- Output token-capped: header (url, duration, **dataLossOccurred —
  present even when insights extracted fine**; B4 honesty signal) +
  ≤ ~40 lines; event-accumulation hard cap (~50k events) → degrades to
  a noted truncation, never OOM; no background timers.
- Optional raw-trace dump via the `TempFileManager` stream pattern
  (discoverable by `clean_temp`). Stretch — first in the 5.4.0 trim
  order after `heap_diff`.
- NO proto-wire reuse: trace events are JSON streams; footer parser
  needed is nothing like the binary wire reader — no pre-scaffolding.
- Effort budget at draft: ~150–250 lines + tests for the aggregator
  core; mid-stream cut rule applies (WS5 precedent) — if the LCP/CLS
  extraction exceeds budget, cut long-task attributions first, never
  ship raw-dump-only.

**State contracts (first stateful/long-lived actions in `observe`; all
pull-based today):**
- Event subscriptions (`dataCollected` / `tracingComplete`) live in the
  runtime event pipeline (`index.ts`, the `consoleLogs`/`networkReqs`
  slot), keyed per session — `index.ts` edits are named, not surprises.
  Chunks append SYNCHRONOUSLY in the dispatch path (same invariant WS11
  needs); async hops are the only real reorder risk.
- Re-attach (renderer process swap) → trace CONTINUES (5.2 precedent +
  WS7 B4 dataLoss-free navigation); full WS disconnect → `perf_stop`
  maps `Tracing.end` failure to actionably "recording lost — session
  ended; restart recording", prunes the entry, never hangs.
- Double `perf_start` → fail-with-state ("recording already in progress,
  started at <ts>"). Two tabs recording concurrently is safe (per-target
  sessions) — say so in the description text.
- Session-expiry hook best-effort `Tracing.end` + discard: abandoned
  in-flight traces leak browser memory (`recordAsMuchAsPossible` is
  unbounded on the USER's browser) — this is server-owned subscription
  cleanup, not tab lifecycle.
- **Scrubber decision (FIXED): default scrub stays; NO `_noScrub`**
  opt-out for `perf_stop` output — trace insights are untrusted page
  data (webmcp UNTRUSTED precedent); the `list_credentials`
  identifier-not-secret carve-out does NOT apply; scrubber over-reach
  (`keyword`→`***`) accepted cost per O2. Pinned by a matrix test: a
  fixture URL containing `token=X` MUST come out masked.
  (`heap_dump` writes bypass the scrubber — disk lane, covered by its
  opt-in description.)

Unit delta ≈ +9–10 on synthetic `dataCollected` fixtures (no live
deps): happy path, cap, data-loss flag, stop-without-start error,
last-LCP-per-frame dedup, CLS `hadRecentInput` exclusion, worst-3
attribution selection, malformed-chunk tolerance, double-start
fail-with-state, session-death actionable failure.
**Gate-script inventory (momus T1-2): `live-ws10.mjs` and
`live-ws11.mjs` DO NOT exist — to be written, home
`_archive/research/October2026/ws0-spike/` (siblings of live-ws8/9.mjs;
mirror their absolute file:/// SDK-import pattern — tried-and-proven).
Probe template = the
existing `probe-batch-b*.mjs`; WS10's standalone probe output JSON
joins the `batch-*-results.json` set.**
**Gate (binary):** rig recorded under a live 5.3.5 `slow3g` ByRule rule
set via the SHIPPED `emulate` tool surface (not raw CDP — ByRule-first
payoff + WS8 regression check double-duty) → `perf_stop` emits ≥1
insight in every SURVIVING class on the named slow-rig page; unit
fixtures green. Assert PRESENCE, not equality (throttle inflates
LCP); the optional tight cross-check (rig `window.__PERF` vs trace)
runs unthrottled. Killed classes never appear in the gate.

### WS11 — heap dump + offline summary (1)

Homes (locked): **`observe`** — additive actions `heap_dump`,
`heap_summary`.
- `heap_dump` (live): `HeapProfiler.takeHeapSnapshot`, stream chunks to
  a session temp file via `TempFileManager`; explicit `tabId` + OPT-IN
  lane (momus T3-14: dumps can carry auth-state material — the tool
  description states the temp-file location + lifecycle; files obey
  cleanup law: `clean_temp` removes them, nothing auto-deletes user
  disk state; no auto-dump ever).
  **Streaming contract (momus T1 contract #2 — MANDATORY test):**
  chunks append synchronously in the event-dispatch path in arrival
  order; unit fixture drives synthetic chunks through the pipeline and
  asserts the final file is byte-equal to the ordered concatenation, plus
  one gap-then-complete case; a mid-stream abort (session error / tab
  close before `{finished:true}`) leaves the partial file marked
  `.partial` and never advertised as complete; result errors actionably.
  **TempFileManager gains an fd-append (open once, never per-chunk
  `writeFileSync` — O(file)){ + hard size cap ~500MB that aborts with an
  actionable note rather than filling the user's disk. This append lands
  in WS11 regardless of trims — heap core, not trim-able.**
  (WS10's optional raw-trace dump reuses the same append primitive.)
- `heap_summary` (offline, pure-node): parse `.heapsnapshot`
  (JSON header + strings/nodes/edges parallel tables — one flat array
  each; nodes/edges resolved by cumulative edge_count offset arithmetic;
  **column indices resolved from `node_fields` NAMES, never hard-coded**
  — Batch C confirms the detachedness-era 6-field format; classic wiki
  offsets are wrong). **Retained-size semantics decided: SELF-size top-N
  + bounded-depth GC-root BFS path hints. NO dominator tree — true
  retained size without Lengauer-Tarjan is fake; the word "retained" is
  not shipped unless dominators ship.** Bonus: `detachedness` surfaces
  detached-context leaks (rhymes with `observe.memory` counters).
  Streaming/incremental parse (incremental typed-array conversion,
  ~150 hand-rolled lines, zero deps) so a 100MB+ snapshot never
  materializes in RAM.
- **Streaming cut rule (WS10's mid-stream analogue):** if the parser
  overruns budget, cut summary columns (retained-hint depth first,
  ranking last) — never ship a non-streaming parse; the ~50MB generated
  fixture is the over-budget canary.
- `heap_diff` = stretch (trim-first — least-asked-for). Identity by
  (constructor-name, self-size bucket), NEVER node ids (they differ
  across dumps); name-level deltas only.
- **Fixture policy:** the ~50MB fixture is GENERATED at test time from a
  seeded committed script — no 50MB artifact ever committed; NO unit test
  references `_archive/…` paths (stripped at promote; guard-main
  backstop). `batch-c-snapshot.heapsnapshot` (13.24MB) stays the
  dev-time format sanity sample only.

Unit delta ≈ +6 (synthetic `.heapsnapshot` fixture: parser rollup,
top-N, streaming fixture, chunk append-discipline, .partial handling).
**Gate (binary):** committed synthetic fixture parses offline (unit);
live: dump the rig → offline summary states the known object count of a
distinctive test constructor — evaluated via `Runtime.evaluate`
IMMEDIATELY before `takeHeapSnapshot` in the same script, with the rig
batch-creating the objects so the count is stable (ground-truth
cross-check, no browser in the unit path).

### WS12 — slack / catch-up (0.25)

**DONE 2026-10-30.** (1) The ONE bounded retry ran for EventTiming
(`probe-batch-b5-eventtiming.mjs`, ONE connection + the maintainer's two
deliberate clicks inside a 7s trace window): **GO** — the trace carried
`EventTiming ×14` with full per-interaction shapes (interactionId,
duration, nodeId, type=keydown, processingStart/End, enqueue time) plus
`Responsiveness.Renderer.UserInteraction ×1` (interactionType keyboard)
and `SoftNavigationContext::OnInputOrScroll ×6`. Verdict recorded to the
5.5 carcass: **EventTiming/INP = FIRST-CLASS in 5.5** (real-input
required; usage note in the tool description when it ships). NO product
change inside 5.4.0 (no budget — retry only finalizes bookkeeping; the
"never a third attempt" rule spent this attempt with a GO outcome).
(2) slim-mode schema budget re-check: the full suite incl.
`slim-output-budget.test.ts` is green with the observe description at 11
operation bullets — no change needed. (3) In-cycle fixes: none beyond
the WS10 scrubber gap (already recorded as its own Fixed entry).

- **5.4.0 count sweep (full mode)** — expected-value table (momus T1-1,
  values pre-computed from disk; re-derive at sweep time):
  | Touch point | Before | After expected |
  |---|---|---|
  | `observe.ts` action enum | 7 (console, network, request, performance, memory, downloads, har) | **11** (+ perf_start, perf_stop, heap_dump, heap_summary) |
  | observe "Operations:" description block | 7 bullets | 11 bullets (shipped doc surface — rule 4) |
  | Tool count | 15 | **15 unchanged** (`index.ts:689` name list + `:667` "all 15" — verify no-op) |
  | Sub-action badge "130+" | 130+ | re-derive from `registry.ts` total (+4); both README badges move |
  | observe dispatch-fail string (`observe.ts:486` area) | 7-action enumeration | 11-action enumeration — **sweep second source** alongside live `tools/list` + a dispatch-allowlist test |
  | `types.ts:70` roster line | unchanged | expected no-op (verify) |
  | AGENTS.md "15 tools / 130+ actions" | — | sub-action half moves (AGENTS.md is identical-on-main-and-dev — this edit rides the release commit, NOT dev-only) |
  | README tools table | observe 7 rows | observe 11 rows + terse per-action descriptions (rule 4) |

  ⚠️ Reference fix: `index.ts:689` enumerates TOOL names only — it has
  NO per-action listing to recompute (the earlier "recompute the action
  listing inside it" claim was inaccurate). The action-listing surfaces
  are the enum + Operations block + table row above.
  Counts derived from `registry.ts` wiring, cross-checked against a
  SECOND source (the live `tools/list` output of the fresh dist AND/OR
  the dispatch-allowlist test) and recorded in the release commit body.
  Sweep surface names BOTH README.md files (root +
  `MCP Server/README.md` — the miss shape of both failed releases).
- Release mechanics identical to 5.3.5's row. **CHANGELOG: create the
  undated `[5.4.0]` heading at the FIRST WS10 commit** (5.3.5
  precedent: dated-release-only blocks, no `[Unreleased]` accumulation);
  every user-facing change mirrored per WS commit (rules 3+4);
  `Added`: perf/heap actions + any probe-GOed classes; `Changed`:
  expected EMPTY (no planned line-shape deltas — if the probe adds no
  classes, nothing lands there). Sequence: bump `package.json` + the
  `VERSION` const in `index.ts` together → `[5.4.0]` dated → release
  commit carries the sweep + second-source cross-check → clean-tree
  check → `promote.mjs v5.4.0` → hard-verify strip (watch the NEW
  `live-ws10/11.mjs` + probe/gate JSONs under `_archive` — the v5.1.0
  two-file leak shape) → Guard+CI green → tag → GitHub Release → npm
  (package stays `cdp-mcp-server`, decided 2026-10-29; note the ~60s
  `npm view` propagation lag — Release run log tgz notice is proof).

Trim order 5.4.0 (pre-declared): `heap_diff` → raw-trace file dump →
hold. **Hold set (explicit): {`perf_start`/`perf_stop` core,
`heap_dump`, `heap_summary`, the TempFileManager fd-append (heap core),
count sweep, WS12's bounded retry} never trim.** Killed probe classes
exit via GO/KILL before any draft — they trim NOTHING (they get
§5.5 carcass verbs instead). Flagship + heap core + sweep never trim;
WS12 is the buffer.

**Dialog budget (FINAL for the cycle so far): probes 2 + WS10 gate
attempts 5 + WS11 gate 1 = 8** (the original 3-dialog estimate was
rewritten twice: budget line 4 at probe close, blown by the WS10
flush-nondeterminism hunt; WS11 was first-try). Recorded for the
close-out self-audit — 5.3.5's canary churn was comparable.

## Sequencing (sequenced ties + gates)

| # | Workstream | Effort | Gate | Half |
|---|---|---|---|---|
| 1 | WS7 canaries (3 batches) | 0.25–0.5 | GO/KILL per batch recorded here | (both) |
| 2 | WS8 ByRule + riders | 0.5–1 | throttle PASS, fallback TRUE, reset clears | 5.3.5 |
| 3 | WS9 CHIPS round-trip | 0.25–0.5 | partitioned cookie survives export→import | 5.3.5 |
| 4 | WS4 rerun + npm decision + 5.3.5 sweep + release | 0.5 | sweep table empty, pipeline green | 5.3.5 |
| 5 | WS10 probe (standalone, step zero) | 0.25 | **DONE 2026-10-30** — RESULT block recorded: LCP+CLS GO, LongTask+EventTiming KILL, parse-once, set=`'loading'` | 5.4.0 |
| 6 | WS10 perf insights | 1–1.5 | **GATE PASS 2026-10-30** — LCP (552ms, rig H1) + 4 shifts recorded via live slow3g + `['loading']` through the tool path; second-stop contract PASS; class capture is run-nondeterministic (see PROBE RESULT addendum) | 5.4.0 |
| 7 | WS11 heap dump + summary | 1 | **GATE PASS 2026-10-30** — ground-truth `HeapGateMarker ×421` exact in the offline summary of the live 9.1MB rig dump (86,543 nodes / 385k edges); opt-in gate + streaming finalize + honest header all PASS | 5.4.0 |
| 8 | WS12 slack/catch-up | 0.25 | **DONE** — EventTiming retry GO → 5.5 first-class; slim-mode re-check green (no change) | 5.4.0 |
| 9 | 5.4.0 sweep + release | 0.5 | sweep table empty, pipeline green | 5.4.0 |

Self-audit + buffer (momus T2-10): table total ≈ 4.25–5.5 sessions
(5.3.5 actual ≈ 2.0; 5.4.0 headers sum to their rows, incl. the
re-located probe). **Entering 5.4.0 baseline = 504 green (re-derived at WS10 start);
WS10 delta actual = +18 (planned +9–10: three extra from the categories
override contract, the dispatch-fail double-source pin, and the
scrubber URL-token matrix that turned into a real Fixed entry —
504 → 522). WS11 delta actual = +11 (planned +6 — the streaming-append
temp-writer contracts grew beyond the parser fixtures: append
discipline, .partial lifecycle, cap-abort, shuffled-fields resolver,
500k-row streaming fixture, wiring batch) → **533 green at the WS11
close**. WS12 + bounded-retry delta TBD (0 if empty). (5.3.5 actuals: 479 → 504 = +25 vs planned +16.) Plus
0.25–0.5 live-fix buffer (4 in-cycle fixes in 5.2, webmcp round-trip
shape in 5.3, scrubber/`_noScrub` in 5.3.5). Self-audit line required
at close-out: table sum vs stated totals, per half, plus where the
probe landed session-wise.

Decisions made by the directives in this plan (no further maintainer
input needed unless flagged below): binning = controls/observability
(oracle; metis's semver-pure alternate retained as the record of the
deviation only); ByRule behavioral delta accepted with auto-fallback +
KILL path; new tool avoided (observe homes); `getStorageItems` KILLED
for both halves (oracle) — twice-survived stretch logic; superseded by
5.3's `list_credentials` + lifecycle events; re-validate only on a
concrete ask. **Open maintainer inputs (resolved 2026-10-29):** (1) npm
name — KEPT `cdp-mcp-server`; (2) getStorageItems kill — accepted;
(3) WS4 rerun profile — the maintainer's running CDP Brave, no new
profile; optional Bitwarden-disable at gate time is the maintainer's
call.

## Test matrix / verification matrix (momus T3-13)

| Item | Live check | Unit check |
|---|---|---|
| ByRule migration | rig timing under rule; fallback on injected miss; reset clears | +10 mapping/fallback/reset/precedence |
| mockCamera | rig getUserMedia sees fake camera; reset clears | param validation (subset of the 10) |
| overrideNetworkState | onLine spoof reflects in-rig | validation |
| CHIPS | partitioned cookie survives export→import identically | +6 normalize/passthrough/round-trip |
| perf insights | rig under live slow3g (via `emulate`) → gate PASS: LCP + shifts through the `['loading']` tool path (emission nondeterminism recorded) | +18 fixtures (state contracts, categories override, token=X scrub matrix, aggregation semantics) |
| heap dump/summary | dump rig → **GATE PASS** — exact ground-truth ×421 (count evaluated pre-dump; retained in `window.__HEAP_KEEP`) | +11 fixtures (append-discipline, .partial, cap, shuffled-fields resolver, 500k-row streaming, wiring) |
| WS4 rerun | 3 re-assertions on the maintainer's running CDP Brave (Bitwarden stands; caveat re-declaration rule) | existing 5.3 battery unchanged |
| Regression | flag+toggle connect unchanged; slim mode unaffected; baseline+ΣN green | existing suite |

Risks → absorbing gate (momus T3-15): ByRule misbehaves → WS7 Batch A
(limited-GO/KILL); trace category ghosts → Batch B; snapshot stall →
Batch C; interleave chaos → per-WS ordering + two-release halves;
sweep staleness → named rows 4 and 8. Rollback: gates + promote script
hard-verify pre-push; revert on main only; tag never moves backward;
Release only after Guard green.

Competitor checkouts: procedure in `_archive/development/competitors.md`;
`git pull` before use; ownership failure → delete + re-clone; never
touch global git config. Reference duty: README/CONTRIBUTING changes in
either half never reference `_archive/`/`.research/` paths (concept
pointers only); batteries archived under `_archive/research/October2026/`
on dev and stripped at promote (guard-main is the backstop — names both
halves' release rows).

## 5.5 carcass bookkeeping (momus T2-7; every non-landing item gets a verb)

- KB candidates carried: none currently besides rides below.
- `getStorageItems` — KILLED (superseded; revalidate on concrete ask).
- `Browser.addMockCamera` — KILLED at WS7 (absent on Brave 153, `-32601`
  — ghost #2). Design preserved verbatim (WS8 rider row hidden below):
  emulate-scoped opt-in param, browser-domain call, reset clear,
  geolocation auto-grant permission template; revalidate when a build
  ships the method.
- ByRule {limited-GO remainder} — moved to 5.5 if batch A is partial
  (rule-list editing UX is the plausible remainder, not transport).
- WS0 outcome (b)-shaped conditional inserts — same conditional-late-
  insert machinery as 5.3 applies to any KILL conversions.
- npm rename (if declined) — decision record filed, no work item.
- Heap live-diff browser-side (as opposed to offline) — noted-idea,
  not planned.
- **5.4 probe rows — flipped at WS10 close-out (2026-10-30), per PROBE
  RESULT**:
  - LongTask/RunTask insight class — **KILLED** (momus T2-7 verb:
    "revalidate when a Chromium build ships perf events the probe could
    capture — both days exhausted every category combo; rig ground
    truth proves the tasks RAN but the trace never carried them").
  - EventTiming/INP interaction-delay class — **= 5.5 FIRST-CLASS
    (flipped at the WS12 bounded retry, 2026-10-30):** with real user
    input the trace carried EventTiming ×14 with complete per-
    interaction shapes (B5 artifacts). Verb: "implement in 5.5 as a
    perf_stop insight class gated on REAL input events (usage note in
    perf_start/tool description: record during interactions); the WS12
    bounded retry is SPENT — no further probes."
  - `heap_diff` (if trimmed) — verb: "implement as a follow-on once two
    real dumps exist to diff."
  - Raw-trace file dump (if trimmed) — verb: "follow-on behind demand;
    the TempFileManager fd-append it would reuse ships in WS11
    regardless." Both conditional rows deleted if they land.
- Deferred-with-design from earlier cycles — see the 5.3 plan tail; its
  items remain claimed or killed there.
