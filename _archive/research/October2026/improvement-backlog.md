# Deep Comparison — cdp-browser vs Playwright (local ground truth) + Improvement Backlog

**Date:** 2026-10-21. Ground truth on this machine:

- `@playwright/mcp` **0.0.83** + `playwright-core` **1.64.0-alpha** (dlx cache)
- Playwright monorepo clone `1.65.0-next` @ `89cd2a6` (2026-10-20) in
  `A:\.devTools\cache\temp\pw-research\playwright` — the exact source read for
  `findings-playwright-internals.md`. Findings there are verified against what
  is actually installed/cloneable here, not just GitHub HEAD.

Partner docs: `findings-playwright-internals.md` (their internals),
`findings-transport-seam.md` (our code map), `findings-routes-and-restrictions.md`
(connect diagnostics).

## 1. Capability matrix (verdicts: LEAD / PARITY / LAG)

| Capability | Them | Us | Verdict |
|---|---|---|---|
| Browser acquisition | Own launcher; persistent profile default; `--extension` MV3 relay; `--cdp-endpoint` | Attach-only to the user's real browser; profiles, `CDP_USER_DATA`, flag guidance | **LEAD** (identity) |
| Connect diagnostics | Generic errors; autoConnect needs port file for known layouts | Generic error today; but full classifier design ready (B3 table) | **LAG → cheap win** |
| Gated/toggle debugging | `--autoConnect` reads port file | Not supported yet (S3 exists but gated behind `/json/version` failure) | **LAG → cheap win** (A2 unlock) |
| Snapshot | ARIA + refs, `depth`/`boxes` params | A11y + token optimizer + diff/search/interactive | **LEAD** (economics), PARITY (features) |
| Actionability/auto-wait | Injected ElementState checks, backoff ladder [20,50,100,100,500], scroll cycling, hit-target interceptor | Polling timeouts, per-action `waitFor` on click only | **LAG (P0)** — design sketched in findings D1 |
| Element interaction | uid/ref + locator | uid/ref + selector + jsClick + humanMode | PARITY (ours adds humanMode/jsClick) |
| Raw mouse/xy | `browser_mouse_*_xy`, wheel | None (element-only + scroll) | **LAG** — trivial on `Input.dispatchMouseEvent` (D2) |
| Keyboard | USKeyboardLayout mapping, keydown/keyup tools | `press` with modifiers, delays, typoRate (humanized) | PARITY (ours more human-like, theirs lower-level) |
| Forms | `fill_form` generic | `form` tool: type detection, country/location autocomplete, combobox strategies | **LEAD** |
| iFrames | Full piercing via selector chains | `page.frames` + per-frame workarounds | **LAG** |
| Network observe | requests + request body + clear | + per-request bodies, HAR 1.2 export, downloads tracking | **LEAD** |
| Network mock | `browser_route` glob + unroute + network_state_set | `intercept` (Fetch domain, experimental) + `override_resource` regex | **LEAD** power / **LAG** DX (experimental flag) |
| Console | messages + clear | messages + levels + popups | PARITY |
| Storage | cookies CRUD + webStorage + **storageState one-shot** | cookies CRUD + webStorage, no one-shot state file | **LAG** (small) |
| Debugging | `browser_resume` only | Full debugger: breakpoints, pause/step, call stack, evaluate-on-frame, scripts, source | **LEAD** (no competition) |
| Codegen | Response-as-code (`addCode`) + user-action recording | None | **LAG** |
| Tracing/video | start/stop tracing, video + chapters + action callouts | performance metrics + HAR only | **LAG** |
| Emulation | media, resize, network_state | viewport/UA/geo/locale/CPU/network/vision/idle/headers/blockUrls + reset | **LEAD** |
| Devices | Full descriptor registry | Manual viewport/UA | **LAG** (small — vendor JSON subset) |
| Assertions | `browser_verify_*` family | None (agent greps snapshots) | **LAG** (nice idea) |
| find/search in page | `browser_find` | `page.snapshot search` + maxLength | PARITY |
| Session model | Single page focus, tab tool | Session ownership, TTL, cleanup strategies, profile pinning | **LEAD** |
| Multi-engine | chromium/firefox/webkit | Chrome-family only | different by design (not a gap) |
| Install mgmt | `browser_install` | n/a (attach identity) | n/a |

## 2. Improvement backlog (everything worth doing, grouped)

S = ≤1 day, M = 2–4 days, L = >1 week. Numbers = suggested order.

### A. Connection intelligence (small, huge UX) — candidate next release

1. **S — S2 exception preservation** (`health-monitor.ts:198-214`): keep
   refused vs 404 vs timeout evidence; stop swallowing.
2. **S — Connect-error classifier** implementing the B3 signature table;
   exact relaunch commands in messages; toggle-aware guidance.
3. **M — ApprovalModeDiscovery** (toggle support): port-file-first WS connect
   to `/devtools/browser`, skip `/json/version`; works via existing
   `CDP_USER_DATA` + standard scan dirs; message "click Allow in the browser".
4. **M — Process command-line scan** (opt-in `CDP_PROCESS_SCAN=true`):
   read `--user-data-dir`/`--remote-debugging-port` from running
   browser processes → path-independent discovery (portable layouts).
5. **S — Extend candidate dirs** (Vivaldi/Opera + portable patterns) +
   fix stale "15 tools" comment (`index.ts:552`).

### B. Engine behavior (the real gap-closers) — next release(s)

6. **L — Auto-wait gate**: injected `checkElementStates` equivalent
   (visible/stable/enabled/editable), Playwright backoff ladder, scrollIntoView
   cycling, elementFromPoint hit-target check before click dispatch. Wire into
   `interact`/`form` behind a default-on flag with `force` escape.
7. **S — Raw mouse tools**: `interact` actions `mouse_move/mouse_down/up/
   click_xy/wheel` via `Input.dispatchMouseEvent` (+ drag bookkeeping lite).
8. **S — storageState one-shot**: `storage.export_state`/`import_state`
   (cookies + localStorage per origin, Playwright-compatible JSON schema).
9. **M — Device presets**: `emulate.device: "Pixel 8"` — vendor a Chromium-
   family subset of `deviceDescriptorsSource.json` (Apache-2.0).

### C. Agent-facing ergonomics — later

10. **M — verify/assertion family**: `browser_verify_*`-style structured
    pass/fail tools.
11. **M — response-as-codegen**: append equivalent script lines to tool
    responses (replayable sessions).
12. **L — iframe-piercing snapshots**: frame-qualified UIDs from merged
    per-frame a11y trees.
13. **L — tracing lite**: CDP screencast/tracing → webm + step-log JSON.
14. **M — DX for intercept**: promote out of experimental, glob patterns,
    unroute, docs.

### D. Ops/hygiene (ride along any release)

15. README: document the four connect failure modes + fixes (from B3).
16. AGENTS.md dev checklist: add a toggle-mode test case (approve dialog).
17. Extension relay study: read `playwright-core/src/tools/mcp/cdpRelay.ts`
    + `packages/extension` as design reference for our `extension/` v5.1
    scaffold (their relay is battle-tested; design only, no copying wrong
    licenses — verify Apache-2.0 terms before borrowing structure).

## 3. Explicitly NOT doing

- Multi-engine (Firefox/WebKit) — conflicts with attach identity.
- Bundled/managed browsers — product identity.
- Reverse-engineering beyond what Chromium source already documents — the
  approval-mode endpoint is now source-understood; nothing further needed.
- `run_code`-style server-process script exec — RCE surface we don't want.
