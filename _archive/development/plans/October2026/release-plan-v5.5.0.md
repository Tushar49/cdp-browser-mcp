# Release plan — v5.5.0 (FINAL planned development cycle)

**Repo:** cdp-browser-mcp · **Series:** 5.5.0 · **Status:** momus-reviewed
(REJECT → all 7 findings folded: R1 site inventory, R2 pinned injection
gate, R3 tail-closure reconciliation, R4 full-engine gate, R5 category
chain wording, R6 heap_diff attribution, R7 pass) → **PLAY-CLEAR — ready
to execute**. Same discipline as 5.4.0 (probe/gate-first, one CDP
connection per gate, live-rig verification per workstream).

> **POLICY (maintainer, 2026-10-30):** 5.5.0 is the **last planned
> development cycle**. Scope = complete ALL pending functionality. After
> 5.5.0 ships, the repo enters **maintenance mode** — no further planned
> cycles; the maintainer picks it up after ~1 month (or on issues/new
> feature requests) as they arrive.

---

## Inputs (everything that must close)

1. **5.4 carcass first-classes** (5.4 plan §5.5 bookkeeping):
   EventTiming/INP insights (retry-GO'd, input-gated), `heap_diff`,
   raw-trace file dump, ByRule rule-list UX, ByRule limited-GO remainder.
2. **NEW maintainer directive (2026-10-30): locator parity** — bring our
   element-locating ergonomics to Playwright level.
3. Count sweep + slim-budget canaries + release mechanics per the 5.4.0
   sweep table pattern.

---

## WSA — Locator parity flagship (1.5)

**Code-grounded gap (verified in repo, 2026-10-30; amended per momus R1):**
the selector surface is **≥5 CSS-only evaluate sites**, not one:

| Site | Path | Reach |
|---|---|---|
| `interact.ts:1180` | `resolveElement` geometry path | uid-less fallback |
| `interact.ts:1274` | `resolveElementObjectId` | **majority of actions** (click/fill/type/select/hover/check/tap/upload/eval via `resolveAndCheck`) |
| `page.ts:610` | `page.eval` selector→prop probe | eval |
| `page.ts:707` | `selectorProbeExpression` | `page.verify` |
| `utils/wait.ts:183-192` | `waitForSelector` (4 pinned exprs) | `waitFor` + click waitFor rider |

**Design (additive; no schema-count change — locator syntax rides the
existing `selector` string param everywhere it exists):**

1. **Engine-dispatched locator syntax** — one new shared module
   `utils/locators.ts` that turns a selector string into a single
   page-side IIFE emitting the same shape the uid path returns
   (`backendNodeId` route via `DOM.resolveNode` + geometry IIFE already
   proven in `resolveElement`). Engines:
   - default → `css` (today's behavior, byte-compatible)
   - `//…` or `xpath=` → XPath via `document.evaluate`
   - `text=` → text engine (matched spans; contains by default,
     `text="exact"` exact form — Playwright semantics)
   - `role=` → ARIA-lite role engine: role attr/tag→implicit-role
     mapping + accessible-name from `aria-label`/text; **honestly
     documented as aria-lite, NOT full ARIA semantics**
   - `label=`, `placeholder=`, `testid=`, `alt=`, `title=` → attribute
     engines (`testid` honors `data-testid` and configurable alt ids)
   - explicit `css=` prefix; everything pierces **open** shadow roots
     (documented; closed roots are out)
2. **Strict-mode-style disambiguation** — >1 match returns the count +
   first ≤5 matches as `uid`-less descriptors; `nth:`, `first:`,
   `last:` options pick. Zero matches → the existing actionable
   stale-ref error family.
3. **Auto-retry locator handles** — resolution is registered through the
   5.1.0 actionability gate: bounded re-resolve loop over
   `config.actionTimeout` (re-query on detach) so a locator is a
   *handle*, not a one-shot lookup.
4. **Unit strategy** — matcher predicates live as pure TS functions
   over fixture node-objects (repo tests are DOM-less today — keep
   that); emitted-expression templates pinned as exact strings. Tests:
   engine dispatch + template pins + predicate fixtures + strict-mode
   filter + retry-state machine (+12–16).
5. **STEP-0 (momus R1/R2, BINARY before any WSA code):**
   a. **Site-authorization row-scan:** `grep querySelector` /
      `selectorProbe` across `MCP Server/src` — every selector-evaluate
      site is then either (i) rewired to the `utils/locators.ts`
      backend, or (ii) declared "stays CSS-only" in the docs + tool
      descriptions VERBATIM. No third state. Default: rewire all five
      sites.
   b. **Pinned injection-fixture set (GO/NO-GO gate):** one
     `JSON.stringify`-escaped expected-string template per engine
     (css / `//…` / xpath= / text= / role= / label= / placeholder= /
     testid= / alt= / title=) **plus adversarial input pins**
     (`"//img[\"onerror\"]/parent::*"`-style, quote-broken and
     newline-bearing selectors). If any template prefixes `/` raw or
     escapes wrongly → NO-GO; `utils/locators.ts` is not written until
     the fixture set passes against its generator.
6. **Live gate `live-wsa.mjs`** — 1 connection: rig page containing
   shadow-DOM widget + ambiguous buttons; assert click/fill succeed
   via **EVERY engine family** (`role=`, `text=`, `xpath=`, `label=`,
   `placeholder=`, `alt=`, `title=`, `testid=`, explicit `css=` —
   momus R4: attribute engines share the lookup path, but the "ALL
   engines" claim is only upheld if each asserts), strict-mode error
   shape on the ambiguous case, retry handle lives through a
   re-render. Slow-rig/serve.mjs reused; 1 Allow dialog.

## WSB — EventTiming/INP insight class (0.5)

Retry-GO'd in 5.4 (B5): with real input the trace carried
`EventTiming ×14` + full per-interaction shapes (interactionId, dur,
nodeId, type=keydown, processingStart/End).

- `trace-insights.ts`: EventTiming becomes a shipped insight class —
  per-interaction latency table (top 3 by duration: type, `dur` ms,
  processing window), input-gated usage note appended in the
  `perf_start` output ("interact during the recording to capture
  interaction timing").
- No category change (momus R5 settled the chain from the batch
  artifacts: B1 `['devtools.timeline']` → EventTiming **×0**; B3/B5
  with `['v8']` → ×32/×14 — **`v8` is the operative category**).
  Insights are gated on the `categories: ['v8']` escalation-ON signal
  (`observe.ts:376-387` shipped surface); stated honestly when absent:
  "interaction insights require categories: ['v8'] + real input").
- Tests (+6): parse fixtures from B5 field shapes, top-3 ordering,
  input-note surfacing.
- Live gate (rides WSA's rig connection or its own): 1 click inside a
  traced window → insight line appears. 1 Allow dialog + maintainer
  click.

## WSC — heap_diff + raw-trace dump (1)

Both 5.4 carcass rows; maintainer directive = complete, so both land.

- `heap_diff` (additive `observe heap_diff`, `pathA`+`pathB`): reuses
  `summarizeHeapSnapshot`'s scanner twice; identity = **(constructor
  name, exact self-size)** — *deliberately REFINED from 5.4's bucket
  identity into exact to surface GROWN/SHRUNK within-constructor;
  never node-ids* (momus R6 wording) — plus a coarse **≈-labeled**
  byte-bucket rollup rendered separately, never mixed with the exact
  tables. Output: NEW / GONE / GROWN / SHRUNK classes, node-count
  delta, strings-table delta; honest header ("self-size diff; no
  dominator/retained claims"). Never commit fixtures: diff fixtures
  generated at test time by the committed seeded generator (5.4
  pattern) (+6).
- Two real dumps already exist (live WS11 `.temp` dump + WS7 batch-c
  artifact) → smoke the diff on those pre-code (dev-time only, never
  committed from `_archive`).
- **Raw-trace dump** (additive opt-in on `perf_start`: `keepRaw: true`):
  TempStreamWriter (5.11 fd-append) streams each `dataCollected` chunk
  verbatim (jsonl, one event per line) under the same append-discipline
  case; cap 50MB (over → abandoned `.partial`, actionable); `perf_stop`
  offers the finished path; aggregator unchanged. (+4 incl. cap + partial
  lifecycle pins).

## WSD — ByRule rule-list UX (0.5)

`networkRules` is full-replace (`emulate.ts:51` validate entry;
`reset` clears; rules survive navigation). Additive on `emulate`:

- `networkRulesList: true` → active rules rendered with indices +
  effective order (first-match).
- `networkRulesRemove: <idx>` → remove one rule, re-push the remainder
  in one ByRule call (atomicity preserved); `networkRulesAppend: {…}` →
  validated entry appended per the existing validator.
- Read-back lives in `emulate` (the rules' home), NOT observe.
- Tests (+5): list rendering, append/remove atomicity (one CDP call),
  invalid-index actionable error. Live: piggyback the WSA gate — set
  slow3g + list + remove-index round-trip on the same connection.

## WSE — sweep + slim + release (0.75)

- **Tail-closure reconciliation (momus R3, blocking):** the
  "deferred-not-dead" rows in the 5.3 plan tail (Lighthouse audits,
  multi-screen emulation, source-mapped console stacks, FedCM/PWA
  parked, DigitalCredentials/SmartCard/Bluetooth, HAR-replay
  revisit-on-ask) get an explicit disposition here — each maps to
  exactly one of `{LAND this cycle | CLOSE-VERB (maintenance-era:
  "issue-era item, routing condition X") | KEPT-ALIVE (standing idea)}` —
  written into the CHANGELOG's 5.5 entry. Maintenance mode begins with
  **zero unverb'd ideas** anywhere in the repo.
- Slim mode: new capabilities live in `observe`/`emulate` actions —
  verify the 6-tool slim subset mapping unchanged (canary:
  `slim-output-budget.test.ts` green, subset-of-daily-use law holds);
  any new slim-relevant flag decides at review, default keep-out.
- Count sweep: sub-action badge re-derivation via the stub-ctx script
  (WSA adds locator options, not action enum entries — expect 130
  unchanged; WSD adds nothing to the enum — verify, don't assume).
  Both READMEs + AGENTS.md counts move on the release commit.
- CHANGELOG `[5.5.0]` heading at the first WSA commit, undated until
  release; release row notes MAINTENANCE-MODE entry (README badge line +
  AGENTS.md one-liner: "maintenance mode since 5.5").
- `scripts/promote.mjs` 5.5.0 → Guard+CI → tag → npm. Note: promote.yml
  was fixed in-cycle (e8085c9/ce5ede2 actionlint-clean) — dispatch-based
  promote becomes viable if ever needed again.

---

## Sequencing

| # | WS | Effort | Gate (binary, live) | Target |
|---|----|--------|---------------------|--------|
| 0 | WSA locator design review (momus DONE — R1-R7 folded) + WSC dump-smoke (offline) | 0.25 | **step-0 gate: pinned injection-fixture set GO** (momus R2: engine templates + adversarial pins pass before `locators.ts` exists) + site row-scan (`grep querySelector` — 5 sites authorized) | 5.5.0 |
| 1 | WSA locator parity | 1.5 | ≥1 success per engine (`role/text/xpath/label/testid`) + strict-mode + retry through re-render | 5.5.0 |
| 2 | WSB EventTiming insights | 0.5 | ≥1 interaction insight line with a real maintainer click | 5.5.0 |
| 3 | WSC heap_diff + raw-trace dump | 1 | offline diff on two generated dumps; .partial lifecycle | 5.5.0 |
| 4 | WSD ByRule UX | 0.5 | list/append/remove round-trip on one connection | 5.5.0 |
| 5 | WSE sweep + release | 0.75 | counts derivable; promote/tag/npm | release |

Total ≈ 4.75 + live-fix buffer 0.5 → **≈5.25 sessions**.

**Dialog budget: 3** (WSA gate + WSB click-trace + piggybacks).

**Test baseline entering 5.5: 535.** Expected deltas: WSA +12–16, WSB +6,
WSC +10, WSD +5, WSE +0–2 → **≈568–574** (re-derive at WSA start).

**Carry-forward after 5.5:** none allowed — every remaining idea lands
or gets a closing verb (maintenance-mode era: new work arrives only as
issues, recorded as GitHub issues, not plan cycles).
