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
4. **`mockCamera: true`** param → `Browser.addMockCamera` (browser-domain,
   dies with CDP session, cleared by `reset`; geolocation auto-grant at
   emulate.ts:139–147 is the permission template). Rider — trim-able.
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
**Gate (binary, carried verbatim from carcass):** a partitioned cookie
set by a rig third-party iframe survives export → clear → import with
IDENTICAL partitionKey (object-equality assertion in gate script).

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

Trim order 5.3.5 (pre-declared): `overrideNetworkState` → `mockCamera` →
hold (ByRule migration, CHIPS, sweep, chores never trim).

## 5.4.0 — "observability" half (≈2.75–3.25 sessions)

### WS10 — perf insights flagship (1–1.5)

Home (locked): **`observe`, additive actions `perf_start` / `perf_stop`**
— NOT a new tool; dodges the 15-tools string/badges' tool-count half of
the sweep; observe's description already enumerates ops (momus T1-1).
- `perf_start` = `Tracing.start` with the Batch-B-verified category set,
  records session-state baseline; returns immediately.
- `perf_stop` = `Tracing.end` + accumulate `dataCollected` chunks in
  `utils/trace-insights.ts` until `tracingComplete`, aggregate, DISCARD
  raw events: last LCP candidate per frame (ms, size, tag hint); CLS
  (sum minus `hadRecentInput`, count, worst single); long tasks
  (count/total/worst-3 + attributable script); interaction delay max +
  count (INP-ish).
- Output token-capped: header (url, duration, dataLoss flag) + ≤ ~40
  lines; event-accumulation hard cap (~50k events) → degrades to a noted
  truncation, never OOM; no background timers.
- Optional raw-trace dump via the `TempFileManager` stream pattern
  (discoverable by `clean_temp`). Stretch — first in the 5.4.0 trim
  order after `heap_diff`.
- NO proto-wire reuse: trace events are JSON streams; footer parser
  needed is nothing like the binary wire reader — no pre-scaffolding.
- Effort budget at draft: ~150–250 lines + tests for the aggregator
  core; mid-stream cut rule applies (WS5 precedent) — if the LCP/CLS
  extraction exceeds budget, cut long-task attributions first, never
  ship raw-dump-only.

Unit delta ≈ +8 on synthetic `dataCollected` fixtures (no live deps):
happy path, cap, data-loss flag, stop-without-start error.
**Gate (binary):** rig recorded under a 5.3.5 ByRule `slow3g` rule (the
ByRule-first payoff) → `perf_stop` emits ≥1 insight in each class
{LCP, CLS, slow-block} on the named slow-rig page; unit fixtures green.

### WS11 — heap dump + offline summary (1)

Homes (locked): **`observe`** — additive actions `heap_dump`,
`heap_summary`.
- `heap_dump` (live): `HeapProfiler.takeHeapSnapshot`, stream chunks to
  a session temp file via `TempFileManager`; explicit `tabId` + OPT-IN
  lane (momus T3-14: dumps can carry auth-state material — the tool
  description states the temp-file location + lifecycle; files obey
  cleanup law: `clean_temp` removes them, nothing auto-deletes user
  disk state; no auto-dump ever).
- `heap_summary` (offline, pure-node): parse `.heapsnapshot`
  (JSON header + strings/nodes/edges tables) — rollup + top-N by
  retained/self size; streaming/incremental parse so a 100MB+ snapshot
  never materializes in RAM; one ~50MB generated fixture proves it.
- `heap_diff` = stretch (trim-first — least-asked-for; ~cheap ON TOP of
  summaries once they exist).
Unit delta ≈ +6 (synthetic `.heapsnapshot` fixture: parser rollup,
top-N, streaming fixture).
**Gate (binary):** committed synthetic fixture parses offline (unit);
live: dump the rig → offline summary states the known object count of a
distinctive test constructor with the exact count recorded from the rig
at dump time (ground-truth cross-check, no browser in the unit path).

### WS12 — slack / catch-up (0.25)

`overrideNetworkState` if it was trimmed from 5.3.5 and Batch A had
proven it; any in-cycle fixes; slim-mode schema budget re-check
(5.2's slim-output tests are the canary).

- **5.4.0 count sweep (full mode)** (momus T1-1, named touch points):
  README top badges (tool count likely STAYS 15 — verify `observe` did
  not grow a tool; sub-action count moves: ≥ +4 → recompute), README
  tools table + observe/emulate rows + per-action descriptions (rule 4),
  `index.ts` instruction string (:689 area — recompute the action listing
  even though the tool list is unchanged),
  `types.ts` roster line, AGENTS.md Structure line. Counts derived from
  `registry.ts` wiring, cross-checked against a SECOND source (the live
  `tools/list` output or a dispatch-allowlist test) and recorded in the
  release commit body. Sweep surface names BOTH README.md files (root +
  `MCP Server/README.md` — the miss shape of both failed releases).
- Release mechanics identical to 5.3.5's row with `[5.4.0]` CHANGELOG
  (Added: perf actions, heap actions; Changed: emulate rows if
  5.3.5-pending notes).

Trim order 5.4.0 (pre-declared): `heap_diff` → raw-trace file dump →
hold (flagship + heap core + sweep never trim; WS12 is the buffer).

## Sequencing (sequenced ties + gates)

| # | Workstream | Effort | Gate | Half |
|---|---|---|---|---|
| 1 | WS7 canaries (3 batches) | 0.25–0.5 | GO/KILL per batch recorded here | (both) |
| 2 | WS8 ByRule + riders | 0.5–1 | throttle PASS, fallback TRUE, reset clears | 5.3.5 |
| 3 | WS9 CHIPS round-trip | 0.25–0.5 | partitioned cookie survives export→import | 5.3.5 |
| 4 | WS4 rerun + npm decision + 5.3.5 sweep + release | 0.5 | sweep table empty, pipeline green | 5.3.5 |
| 5 | WS10 perf insights | 1–1.5 | insights ≥3 classes under throttling | 5.4.0 |
| 6 | WS11 heap dump + summary | 1 | summary matches rig ground truth | 5.4.0 |
| 7 | WS12 slack/catch-up | 0.25 | live param works | 5.4.0 |
| 8 | 5.4.0 sweep + release | 0.5 | sweep table empty, pipeline green | 5.4.0 |

Self-audit + buffer (momus T2-10): table total ≈ 4.0–5.25 sessions
(per-half headers sum to their own rows: 1.25–2.0 + 2.75–3.25).
Entering test baseline **479 green**; expected deltas ≈ +16 (5.3.5) and
+14 (5.4.0) → ≈ 509; plus 0.25–0.5 live-fix buffer (4 in-cycle fixes in
5.2, webmcp round-trip shape in 5.3). Self-audit line required at
close-out: table sum vs stated totals, per half.

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
| perf insights | rig under slow3g → 3 insight classes | +8 fixtures |
| heap dump/summary | dump rig → offline ground-truth count matches | +6 synthetic fixture + streaming |
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
- ByRule {limited-GO remainder} — moved to 5.5 if batch A is partial
  (rule-list editing UX is the plausible remainder, not transport).
- WS0 outcome (b)-shaped conditional inserts — same conditional-late-
  insert machinery as 5.3 applies to any KILL conversions.
- npm rename (if declined) — decision record filed, no work item.
- Heap live-diff browser-side (as opposed to offline) — noted-idea,
  not planned.
- Deferred-with-design from earlier cycles — see the 5.3 plan tail; its
  items remain claimed or killed there.
