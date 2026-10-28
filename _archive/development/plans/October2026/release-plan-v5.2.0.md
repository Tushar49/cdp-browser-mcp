# Release Plan — v5.2.0 "Authenticators + Federated Identity" (EXTREME DETAIL)

**Status:** planning complete 2026-10-27; WS0 live spike ALREADY RUN (verdicts
locked below). Implementation authorized to start at WS1.
**Decisions locked:** WebAuthn is the headline (Puppeteer-parity debt from
5.1.0); FedCm conditional on the demo-RP dialog test; annotated-content proto
parsing DEFERRED to v5.3 (metis recommendation upheld — field-map churn is
unbounded); no backlog-L items (iframe piercing, tracing-lite) in this
release. **Versioning:** semver minor → 5.2.0 at release.

Ground truth anchors: research doc
`_archive/research/October2026/2026-10-27-v5.2-webauthn-fedcm-research.md`
(remote, source-verified) and the code map of 2026-10-27 (file:line against
current dev tree — inline below). All paths relative to `MCP Server/`.

## 0. WS0 — live capability spike (RUN 2026-10-27, verdicts locked)

Raw CDP probes on tab `7227991B…` (localhost handbook, Brave 153 approval
mode, browser-level WS + `Target.attachToTarget flatten`) — no navigation,
no tabs launched, authenticator removed + domains disabled afterward:

| Probe | Verdict |
|---|---|
| `WebAuthn.enable {enableUI:false}` | OK |
| `addVirtualAuthenticator` ctap2/internal/hasResidentKey/hasUserVerification/isUserVerified/autoPresence | OK → `{authenticatorId}` |
| `getCredentials` on fresh authenticator | OK `[]` |
| 2nd `internal` authenticator same session | error `-32602 Chrome only supports one internal authenticator per environment` (matches webauthn_handler.cc:304-309) |
| Parallel `usb`-transport authenticator | OK |
| `setUserVerified` toggle | OK |
| `removeVirtualAuthenticator` + `disable` cleanup | OK |
| `FedCm.enable {disableRejectionDelay:true}` | **OK on Brave 153** — no Brave gate blocks enabling |
| `Performance.enable` (this session) | **OK — contradicts our 5.1.0 "Brave strips Performance" claim** (see WS3-E1) |
| `Memory.enable`, `Ads.getAdScripts` | absent — upstream `protocol_config.json`, not Brave |

**WS1 (webauthn): GO — PASSED live 2026-10-28 (see §WS1 verdicts).**
**WS2 (fedcm): KILLED 2026-10-28 — the live demo-RP test settled it.**
`FedCm.enable` answers via CDP, but Brave 153 disables the FedCM JS API
entirely at the browser level (demo page detects: `IdentityCredential`,
`HTMLIdentityCredentialElement`, `IdentityProvider` all absent from
window; page reports "Your browser does not support FedCM"). No site can
show a FedCM dialog on Brave by default → nothing to automate on the
primary target; the user would have to flip a browser-level setting (if
one even exists in Brave 153's flags — the flags page did not show one
readily) and relaunch. Per the locked kill deliverable: **no `fedcm`
tool ships in 5.2**; FedCm moves to the v5.3 deferred list (watch-only
in `status` remains what it is today). Do NOT backfill a substitute
feature. 5.3 re-evaluation note: the domain + dialog automation is
viable on stock Chrome (research doc §2) — worth testing there before
deciding.

## 0.1 Non-negotiable rules (carry forward from 5.1.0)

1. Tool contract additive-only; existing actions keep behavior.
2. No new runtime deps (proto parsing without protobufjs — one more reason
   it is deferred).
3. Every workstream live-verified on Brave 153 before the next starts.
4. Version bump only in the release commit; CHANGELOG [Unreleased]
   accumulates from the first workstream commit.
5. Attach identity: never launch/close tabs; virtual authenticators are
   in-memory per CDP session and die on disconnect — that is the
   user-profile safety guarantee, state it in README.
6. **New rule from the 5.1 postmortem:** never tag past a red Guard main;
   promote via the workflow (it now hard-fails pre-push).

## 0.2 Cross-cutting corrections from the code map (apply in WS1, one commit)

Facts the 5.1 code map contradicted (verified against dev @ `57d8c01`):

- **`capabilities.has/require` are never called by any tool** — the shipped
  gating pattern is `isMethodMissingError` try/catch around the send
  (`emulate.ts:166-192`, `page.ts:943-955`). v5.2 tools become the FIRST
  callers of pre-call `require(...)`; to make errors render properly,
  `wrapError` (`utils/error-handler.ts:259-327`) gains an
  instanceof/name check for `DomainUnsupportedError` → actionable tool
  result (today it falls through to the generic fallback).
- **`ctx.findState` is keyed by CDP sessionId, not tabId**
  (`page.ts:867/899`; test asserts the key: `page-find.test.ts:40`). The
  tabId-keyed precedent is `modal-state.ts` (event-wired via
  `findTabBySession`, `index.ts:173-179`). New state managers key by
  **tabId** (modal-state precedent) — agents think in tabs.
- **No cleanup path clears per-tab state on tab close/detach** —
  `tabs.close` (`tabs.ts:374-384`), `cleanup` (`cleanup.ts:31-38, 166-196,
  222-258`) and the disconnect handler (`index.ts:92-102`) each clear only
  a fixed set. New state managers wire cleanup into ALL those paths (and
  optionally sweep `findState`/`modalStates` there too — same one-line
  pattern, fix the 5.1 debt while there).
- **Two parallel `ensureDomain` implementations exist** — tracked
  (`tab-session-service.ts:89-108`, `enabledDomains` set) and cheap-swallow
  (`page.ts:789-792`). FedCm auto-enable uses the TRACKED one (or a new
  state-manager method), never the cheap variant.
- **Tool-count comments are already inconsistent**: "14 tools"
  (`index.ts:597, 618`; `README.md:41, 80, 644`; `AGENTS.md:25`) vs stale
  "15 full tools" (`types.ts:69`) vs storage claiming 9 actions
  (`README.md:307`) while defining 11 (`storage.ts:430`). Reconcile all in
  one docs commit when adding the two tools (→ 16).

## WS1 — `webauthn` tool (headline)

**New files:** `src/tools/webauthn.ts`, `src/session/webauthn-state.ts`.
**Registry:** `registerWebauthnTools` called at `index.ts:596-610`; ctx field
`webauthnState: WebAuthnStateManager` (`types.ts:257-320` + init
`index.ts:462-485`).

### State (`session/webauthn-state.ts`)

`authenticatorId → { ownerTabId, cdpSessionId, options, createdAt }` plus
`Set<cdpSessionId>` of enabled sessions. Registry is for ROUTING and
OWNERSHIP only — `getCredentials` always queries CDP live, never caches
credentials. Keying note: Chromium's authenticator scope (per-session vs
browser-wide) was NOT resolvable from source — design makes it irrelevant
by routing every authenticatorId-taking command through the OWNING tab's
session (`ownerTabId → getTabSession`), which is correct in both worlds.
Record the live-verified answer in one comment line.

### Actions (11, one tool, action enum)

Defaults make the common flow zero-config; power params stay optional.
Live-validated defaults from WS0: `protocol:'ctap2'`, `transport:'internal'`,
`hasResidentKey:true`, `hasUserVerification:true`, `isUserVerified:true`,
`automaticPresenceSimulation:true`.

| # | Action | Params | CDP |
|---|---|---|---|
| 1 | `add_authenticator` | `tabId`, optional overrides: `protocol?, transport?, hasResidentKey?, hasUserVerification?, isUserVerified?, automaticPresenceSimulation?, extensions?{prf,largeBlob,credBlob,minPinLength,hmacSecret} passthrough`, `ctap2Version?` | lazy `enable` → `addVirtualAuthenticator`; register |
| 2 | `remove_authenticator` | `authenticatorId` | `removeVirtualAuthenticator` |
| 3 | `list_authenticators` | — | registry read (no CDP call): `{authenticatorId, ownerTabId, options}[]` |
| 4 | `add_credential` | `authenticatorId`, `credentialId(b64)`, `privateKey(b64 PKCS#8)`, `rpId`, `userHandle?(b64)`, `isResidentCredential?, signCount?, largeBlob?(b64), backupEligibility?, backupState?, userName?, userDisplayName?` | `addCredential` (rpId required by CDP when adding) |
| 5 | `list_credentials` | `authenticatorId` | `getCredentials` |
| 6 | `remove_credential` | `authenticatorId`, `credentialId` | `removeCredential` |
| 7 | `clear_credentials` | `authenticatorId` | `clearCredentials` |
| 8 | `set_user_verified` | `authenticatorId`, `isUserVerified?=true` | `setUserVerified` |
| 9 | `set_presence_simulation` | `authenticatorId`, `enabled?=true` | `setAutomaticPresenceSimulation` |
| 10 | `set_override_bits` | `authenticatorId`, `isBogusSignature?, isBadUV?, isBadUP?` | `setResponseOverrideBits` — the negative-testing knob |
| 11 | `reset` | `tabId?` (all owned by that tab; omit = all) | `removeVirtualAuthenticator` loop + state clear + `disable` |

Dropped deliberately (escalation triggers, named in code comments):
`getCredential` (singular — list covers it), `setCredentialProperties`
(backup/signCount mutation — add when a negative-testing SOP demands it),
WebAuthn EVENTS (credentialAdded/Asserted — telemetry without a consumer;
metis directive: no subscriptions; revisit only if a flow needs the
assertion log).

Binary params: CDP `binary` = base64 in JSON — accept base64 strings only,
validate before send (`Buffer.from(x,'base64').toString('base64') !== x →
actionable error "expecting base64; PKCS#8 DER for privateKey"), pass
through untouched. Credential listings: when a listed credential's
`largeBlob` exceeds the 60k inline cap, instantiate the inline
`TempFileManager` (observe.ts:190-196 precedent) and return a file path
with preview + size — same convention as network bodies.

### Validation + error taxonomy (pre-call, first `require()` callers)

- Before first use per call: `capabilities.require(client, 'WebAuthn',
  minChrome, sess)` — page-scoped probe needs the tab session id
  (`capabilities.ts:81-85`). Add `DomainUnsupportedError` handling to
  `wrapError` (§0.2).
- Option-combination validation client-side (from handler source, fail
  before CDP): largeBlob/cmtgKey require hasResidentKey; credBlob/
  largeBlob/minPinLength require CTAP2.1; u2f+cable invalid; u2f ignores
  ctap2Version.
- `internal`-transport uniqueness: on `-32602 "one internal authenticator"`,
  actionable error listing existing internal authenticators from the
  registry + `remove_authenticator` hint.
- Unknown `authenticatorId` → `Errors`-catalog entry listing known ids.
- "Virtual environment not enabled" (owner session re-attached fresh) →
  actionable hint + lazy re-`enable` inside `add_authenticator` only.
- New `Errors` catalog entries in `utils/error-handler.ts:35-250`:
  `webauthnNotSupported`, `authenticatorNotFound`, `invalidBase64`,
  `internalAuthenticatorConflict`.

### Agent flow (the description + README example must show exactly this)

```
webauthn add_authenticator {tabId}            # zero-config defaults, auto-enables
page navigate {tabId, url: signup}            # agent drives the page; site calls
                                              # credentials.create → auto-approved
page navigate {tabId, url: login}             # credentials.get → auto-asserted+UV'd
webauthn list_credentials {authenticatorId}   # inspect signCount / which credential
```

Statelessness caveat (README, tool description): authenticator state lives
per CDP session — MCP disconnect (or tab detach) destroys it; create BEFORE
navigating to the passkey flow. Success signal for passkey flows is the
PAGE's state after the exchange — verify with snapshot/interact, not the
webauthn return value (say this explicitly; metis directive).

### Cleanup ownership (momus finding 4)

`webauthn-state` cleanup wiring (tabs.close / cleanup paths / disconnect
handler, §0.2 sites) lands INSIDE the WS1 commit — the WS1 live gate
includes the detach-owner-tab case, which needs it. WS3-E2 is then only
the 5.1-debt sweep (`findState`/`modalStates`).

### Tests

Unit (mirror `capabilities.test.ts` mock shape — `sendCommand` returning the
result envelope): option-combination validator matrix; internal-uniqueness
error mapping; base64 validator; lazy-enable idempotency; registry
routing (owner session resolution); `reset` scope; unknown-id error text.
State manager unit like `modal-state.test.ts` (no CDP mock).
**Live (after unit green):** webauthn.io full round-trip (signup with
virtual authenticator → credential appears in `list_credentials` → login
asserts); cross-tab scope verification (create on tab A, page B — records
the Chromium scope answer); `set_override_bits isBogusSignature:true` →
site's flow visibly fails; detach-owner-tab lifecycle case.
**Effort:** ~2 sessions code+unit, +0.5 live.

### WS1 live verification — RUN 2026-10-28 (verdicts locked)

Driven through the real tool against Brave 153 (webauthn.io + a local
rig page). Results fed BACK into the tool in the same cycle:

| Live check | Verdict |
|---|---|
| `add_authenticator` zero-config, live | ✅ defaults correct |
| Page `credentials.create` → interception → stored | ✅ local rig `CREATED`; webauthn.io probe `RESOLVED` |
| Page `credentials.get` (conditional UI) → assertion consumed | ✅ signCount 0→1→3 across loads |
| `list_credentials` live inspection | ✅ rpId/resident/signCount/user data all correct |
| `add_credential` (provision-then-login) | ✅ after fixes — see below |
| one-internal limit → actionable error | ✅ live |
| `set_override_bits` set/clear | ✅ tool-level; full E2E sabotage needs an RP that accepts our registration (webauthn.io's server-side username gate rejects invented credentials first) — follow-up |
| Cross-session visibility | ✅ `getCredentials` browser-wide (raw session saw MCP's credential); `addCredential` SESSION-BOUND (raw session: "Could not find a Virtual Authenticator") — owner-routing design vindicated |
| Lifecycle | refined: authenticators survive in-tab session re-attach (one-internal limit fired across a process swap) but die on full WS disconnect (fresh internal add succeeded after server restart) — README/CHANGELOG corrected |

Live failures → tool fixes (same cycle): (1) per-session virtual
environment dies on re-attach → every authenticator action best-effort
re-enables; (2) Chromium rejects unpadded/URL-safe base64 in binary
fields → normalize automatically; (3) resident credentials REQUIRE
`userHandle` ("The User Handle is required for Resident Credentials") →
auto-generate; (4) error regex widened to match "Virtual Authenticator
Environment has not been enabled".

Documented caveat (honest limitation): webauthn.io's page-load
conditional-mediation get() keeps a pending ceremony that can starve the
site's own registration create() with NotAllowedError once a matching
resident credential exists. Reload-first, or pre-provision with
`add_credential` and drive the login path. Not a tool bug — protocol-
level interplay; noted in README + tool description.

## WS2 — `fedcm` tool — **KILLED 2026-10-28** (Brave disables the FedCM JS API; §0 verdict)

**Recorded for 5.3** — the design below stays valid for a future cycle
where the target browser ships FedCM (e.g. stock Chrome).

**First item of this workstream — the dialog-flow spike** (needs navigating
one tab to `https://fedcm-demo-rp.dev`, seed: complete the IdP login once
in the profile manually; ask the user before navigating). Confirmed to
exist already: enable works on Brave (WS0). If the dialog never fires →
**kill WS2**, keep FedCm watch-only in `status`, ship in 5.3.

**New files:** `src/tools/fedcm.ts`, `src/session/fedcm-state.ts`.
Deliberately NOT inside `modal-state`: a FedCM dialog does not pause page
JS and must not block other tool traffic on the tab (agent keeps filling
page fields while the chooser is up) — `checkBlocked` is NOT wired for it.

### Auto-enable (the crux — locked decision)

In `tab-session-service.getSession` post-attach hook (after the existing
`setAutoAttach` block at `tab-session-service.ts:71-80`): capability-gated
`FedCm.enable {disableRejectionDelay:true}` via the tracked
`enabledDomains` pattern, swallow-on-absent (silent-off, same shape as the
`Network.configureDurableMessages` auto-send). Rationale: dialogId exists
ONLY in `dialogShown` events; explicit-only enable leaves the "agent forgot
to enable before page load" hole. Chromium's late-enable REPLAY (verified
in fedcm_handler.cc: `Enable()` fires `DidShowDialog()` for a live dialog)
covers the pre-attach case — enabling late still delivers the live dialog.

### State (`session/fedcm-state.ts`)

tabId-keyed (modal-state precedent): `{ dialog: {dialogId, dialogType,
accounts[], title, subtitle, openedAt} | null, lastClosed? }`, fed by
`FedCm.dialogShown`/`dialogClosed` wired in `wireEventPipeline`
(`index.ts:202-457` pattern) with `findTabBySession` reverse lookup. Guards
against double-subscribe live inside the existing
`eventPipelineWired`/`modalEventsWired` blocks — never a fresh
subscription.

### Actions (6)

| # | Action | Params | CDP |
|---|---|---|---|
| 1 | `status` | `tabId` | none — state read: active dialog (type/accounts/title) or "no active dialog"; when none + previously-closed: mention late-enable replay + re-trigger guidance |
| 2 | `select` | `tabId`, `accountIndex`, `dialogId?` (resolved from state when omitted) | `selectAccount` |
| 3 | `dismiss` | `tabId`, `triggerCooldown?=false`, `dialogId?` | `dismissDialog` |
| 4 | `button` | `tabId`, `dialogButton: 'ConfirmIdpLoginContinue'\|'ErrorGotIt'\|'ErrorMoreDetails'` (exact enum from protocol — do not invent accept/reject), `dialogId?` | `clickDialogButton` |
| 5 | `open_url` | `tabId`, `accountIndex`, `accountUrlType: 'TermsOfService'\|'PrivacyPolicy'`, `dialogId?` | `openUrl` |
| 6 | `reset_cooldown` | `tabId` | `resetCooldown` |

Error when a dialog-requiring action is called with no active dialog:
actionable, pointing at `status` + the replay/re-trigger path. Dialogs
shown before MCP attach: covered by late-enable replay for dialogs open
at attach; for dialogs consumed natively while we were disconnected —
guidance copy only (protocol offers no query; do not pretend otherwise).

Identity note (tool description): this operates the REAL dialog shown to
the user's real profile — `select`/`dismiss` act on user-visible UI. Not a
law violation (no launching), but say it.

### Tests

Unit: state transitions, dialogId resolution/passthrough, closed-dialog
errors, auto-enable hook (tracked ensureDomain called once), event wiring
(fake event through the pipeline). Live: full `select` sign-in round-trip
on the demo RP, `dismiss` + `reset_cooldown`, pre-attach-dialog recovery.
**Effort:** spike 0.25 + ~1.5 sessions.

## WS3 — hygiene + corrections (one or two commits, ride along)

1. **E1 — Brave/upstream attribution errata — DONE 2026-10-28 (docs-only,
   no 5.1.1 patch).** Retest on the current Brave 153 build (fresh
   session): `observe performance` full metrics, `observe.memory` real
   counters via `Memory.getDOMCounters` — the 5.1.0 "failures" were
   stale-session artifacts (crashed test tab). Attribution settled by
   upstream `protocol_config.json` + brave-core (no CDP-stripping
   patches): Brave inherits Chromium's domain surface. Errata entry
   shipped in CHANGELOG [Unreleased]; the stock-Chrome A/B remains an
   optional confirmation, not a wording blocker (upstream sources are
   decisive).
2. **E2 — 5.1-debt state sweep — DONE 2026-10-28:** `findState` cleared
   on tab destroy (`Target.targetDestroyed` via tabSessions reverse
   lookup), `cleanup` detach, and browser disconnect; `modalStates`
   cleared on `tabs.close`, `Target.targetDestroyed`, and disconnect
   (new `ModalStateManager.clearAll()`; CDP does not re-emit an open
   dialog's event on re-attach, so kept entries would block tools
   forever). New state managers' own cleanup shipped inside WS1.
3. **E3 — stale count reconciliation (shrunk: WS1 already bumped
   14→15 everywhere incl. `AGENTS.md:25`, `index.ts:597,618`,
   `README.md:41,80,644`, `MCP Server/README.md:4`; WS2 killed → 15 is
   final; `types.ts:69`'s "15 full tools" is now accidentally correct):**
   remaining: storage row claims 9 actions (`README.md:307`) while
   defining 11 (`storage.ts:430`); verify no other stale counts.
   **DONE 2026-10-28:** README storage row corrected to 11 actions.
4. **E4 — `wrapError` gains `DomainUnsupportedError` handling** (unlocks
   `require()` as a first-class tool-time gate). **DONE 2026-10-27.**
5. **E5 — tabId auto-resolution (from live agent failures,
   `_archive/research/UserFeedback/2026-10-27-agent-dx-tabid-and-text-outputs.md`):**
   schemas drop `tabId` from `required`; `preprocessToolCall` auto-resolves
   for tab-bound (toolName, action) pairs — one open tab → inject; zero →
   `Errors.noOpenTabs()`; multiple → `Errors.tabIdRequired()` listing tabs.
   `tabs` info/close/activate + `webauthn` add_authenticator/reset included;
   tab-less actions excluded.
6. **E6 — tabs list/find `format:'json'` + `urlFilter`:** machine-readable
   tab output (agents were treating the formatted text as an array).

## WS4 — optional filler (cut unconditionally if WS1/WS2 slip)

- **Intercept DX promotion:** experimental → stable flag flip + docs +
  live re-verify (`intercept` tool). 0.25 session. Never a headline.

## Deferred to v5.3 (named in release notes — visible deferral, metis rule)

- **FedCm tool** — KILLED for 5.2 (Brave disables the FedCM JS API at the
  browser level; CDP domain present but nothing can trigger a dialog).
  Design preserved in WS2 for 5.3; test on stock Chrome there.
- **Annotated-content structured parsing:** design recorded for 5.3 —
  ~150-line hand-rolled proto wire parser (`utils/proto-wire.ts`,
  no deps) + advisory FIELD_MAP seeded from
  `components/optimization_guide/proto/features/common_quality_data.proto`
  (source: research doc §3), three-layer fallback (parse fail → flat
  extraction; unknown fields surfaced by number; coverage sanity check →
  auto-fallback). Field numbers are NOT stable API — map never
  load-bearing. New command shape gained `includeActionableInformation?`
  on 2026-10-26 — re-read the proto at implementation time.
- Assertion/verify family; iframe-piercing snapshots; tracing-lite;
  WebMCP tool exposure; WebAuthn event consumers; `setCredentialProperties`.

## Sequencing

| Order | Item | Effort | Gate |
|---|---|---|---|
| 1 | WS0 spike | done | — |
| 2 | WS3-E4 wrapError + gating fix (small, WS1 depends on it) | **done 2026-10-27** | 359 tests green |
| 3 | WS1 `webauthn` state + tool + cleanup + tests | **done 2026-10-27** | 393 tests green |
| 4 | WS1 live verification (webauthn.io + scope + override bits) | **done 2026-10-28** | interception round-trip proven; findings fed back into the tool |
| 5 | WS2 FedCm dialog spike (demo RP) | **KILLED** | Brave disables the FedCM JS API — no dialog possible |
| 6 | WS2 `fedcm` state + tool + tests + live | **cut with WS2** | — |
| 7 | WS3 hygiene commits | 0.5 | live spot-checks |
| 8 | WS4 intercept promotion (optional) | **done 2026-10-28** | E2E pass (pause→list→fulfill→mocked body rendered); 2 live-caught bugs fixed (dead list store; stale-session no-pause) |
| 9 | Release: bump → promote (workflow!) → tag `v5.2.0` | **done 2026-10-28** | pipeline |

Totals: **≈5.0 sessions** (WS2 killed; E4/WS1/live done in-cycle). Interim commits after every item (conventional
commits, CHANGELOG [Unreleased] accumulates; test baseline counts from
`pnpm test` at release time — momus finding 8 — the 358 figure is a
5.1.0 snapshot).

## Verification matrix (live, per item)

| Item | Live check |
|---|---|
| WS1 | webauthn.io signup+login round-trip; cross-tab credential use; bogus-signature override makes flow fail; internal-authenticator duplicate error is actionable |
| WS2 | demo RP: dialog appears (status shows accounts), select completes sign-in; dismiss+cooldown reset; pre-attach dialog recovery |
| WS3-E1 | stock Chrome: Performance/Memory canaries; observe.memory works/fails correctly after routing fix |
| WS3-E2 | close a tab with active authenticator/fedcm state → no stale registry entries |
| Regression | flag+toggle connect unchanged; slim mode unaffected (new tools auto-excluded — names don't match the `browser_*` filter, `index.ts:626`); 358 tests stay green |

## Risks

- **Authenticator scope unknown (per-session vs browser-wide):** design
  routes through the owner session — correct either way; the WS1 live
  cross-tab test records the answer for docs.
- **FedCm dialog unreachable on Brave:** kill criterion; watch-only
  fallback; no substitute feature.
- **Demo-RP dependence (WS2 live tests):** `fedcm-demo-rp.dev` is the only
  living public demo (glitch pair dead). If it dies mid-cycle: self-host
  the Chrome sample IdP/RP locally (Chrome 145+ config requirements noted
  in research doc §2) or kill WS2 — network-dependent live gates must not
  become flaky release blockers.
- **Proto/API drift:** WebAuthn/FedCm domains are experimental; option
  validation + canary gating keep failures actionable. Annotated parsing
  deferred precisely because of this.
- **Double-release interaction:** WS1 touches new files + error-handler +
  wrapError only; `interact.ts`/connect classifier (5.0.3) untouched; no
  mixed commits.

## Rollback (momus finding 9)

Workstream gates + the promote workflow + rule 6 cover prevention. If a
workstream breaks AFTER promote: revert its commits on main, re-push
(Guard re-verifies), tag never moves backward — a broken 5.2.0 tag
follows the 5.1.0 precedent (delete + re-point BEFORE publishing, and
publish the GitHub Release only after the guard is green).

## RELEASED — 2026-10-28 (v5.2.0 shipped)

- npm `latest: 5.2.0` (Release workflow run #40638404161: success, OIDC
  publish — the duplicate-version rejection that cost a rerun in 5.1.0
  did not recur).
- Promote: the workflow FAILED by design on the first attempt (leak
  check fired — see the promote.yml fix commit `91a7afb` for the full
  diagnosis: bare `git rm` aborts as a unit when a pathspec matches
  nothing and `2>/dev/null || true` hid the fatal; a modify/delete
  conflict on a 5.1-stray researched README also required `-f`).
  Promoted manually per the sanctioned flow at `f51c8bf` carrying the
  workflow fix; Guard main + build-and-test (20/22) all green before
  the tag.
- Tag `v5.2.0` on `f51c8bf`; tests at release: 394.
- GitHub Release: published by the user.
