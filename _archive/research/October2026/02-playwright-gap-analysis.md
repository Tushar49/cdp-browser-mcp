# Playwright Gap Analysis — where cdp-browser lags / leads

**Status:** research only. **Date:** 2026-10-21. No roadmap commitments.

Baseline: cdp-browser v5.0.2 (14 tools / 90+ actions, attach-only raw CDP) vs
Playwright MCP (≈23 core tools, `microsoft/playwright-mcp`) and the Playwright
framework's engine underneath it.

## 1. Where we LEAD (differentiators — protect these)

| Area | Us | Playwright MCP |
|---|---|---|
| Real browser attach | The whole product: user's actual Chrome/Brave/Edge with cookies, logins, extensions. Zero launcher. | Owns/launches its browser; real-profile attach exists but is secondary and sandbox-y |
| JS debugger | `debug` tool: breakpoints, pause/step, call stack, evaluate-on-frame, script listing | None |
| Resource overrides | `debug.override_resource` regex-fulfilled responses, independent of interception | `browser_route`-style mocking only |
| Smart forms | `form` tool: country-code normalization, location + autocomplete, per-type strategies | Generic fill_form |
| Snapshot economics | A11y snapshots with token optimizer, `diff`, `search`, `interactive` filters | ARIA snapshot, solid but no token budgeting |
| Session model | Tab ownership, per-session locks, cleanup strategies (detach default), profile pinning | Single tab context focus |
| Observability | console + network + per-request bodies + HAR 1.2 export + performance metrics + download tracking, one tool | console + network; HAR via code |

## 2. Parity (both fine)

Navigation & history, screenshots (full-page/element), PDF, dialogs, evaluate/
script execution, cookie/storage get-set-clear, emulation (viewport, UA, geo,
colorScheme, CPU/network throttle — ours actually broader), tabs management,
file upload (incl. file-chooser monitoring), key press, drag between elements.

## 3. Where we LAG (honest list, priority-ordered)

### P0 — felt by every user

1. **Auto-wait engine.** Playwright locators wait for visibility, stability,
   enabled, and receive-events recursively before acting. We poll with
   `CDP_ACTION_TIMEOUT` and offer `waitFor` on some actions. Our snapshot→act
   loop needs the agent to retry manually on stale UIDs.
   *Seed:* central actionability gate inside `interact`/`form` (force, vs
   visible, vs attached), stale-UID auto-re-resolution from the same a11y
   snapshot cache.
2. **Error ergonomics on connect** (see `01-cdp-modernization.md` Phase 0 —
   classified connection errors with exact fix commands).

### P1 — daily-driver gaps

3. **Raw mouse at coordinates.** Playwright has `mouse_move/click/drag(x, y)`,
   wheel with delta, hit-target verification. We only act on elements
   (uid/selector) — canvas/map/_virtualized-UI apps suffer.
   *Seed:* `interact` actions `mouse_move/mouse_clickxy/wheel` on
   `Input.dispatchMouseEvent` — cheap on raw CDP, genuinely hard for us to do
   wrong (no locator needed).
4. **iFrame ergonomics.** We list frames (`page.frames`) but element refs come
   from the main-frame a11y tree; cross-frame interaction means goto-per-frame
   workarounds. Playwright pierces frames transparently.
   *Seed:* per-frame snapshot merge with frame-qualified UIDs.
5. **storageState one-shot.** Export/import full auth state (cookies +
   localStorage) as one file. We have granular pieces only.
   *Seed:* `storage.export_state` / `storage.import_state` — wraps existing
   ops, trivial on CDP.
6. **Device presets.** `emulate` takes manual viewport/UA; Playwright ships
   the device registry (iPhone 15, Pixel 8…).
   *Seed:* bundle device descriptor JSON, `emulate.device: "Pixel 8"`.

### P2 — power/tester features

7. **Trace/video.** Playwright: trace viewer (screenshots + DOM snapshots +
   network per step) and video recording. We have HAR + performance metrics.
   *Seed (lite):* `CDP Tracing`/screencast domain capture → webm; step-log
   JSON per tool call as "poor-man's trace".
8. **Codegen.** Playwright Inspector records → test code. Nothing equivalent.
   *Seed:* record tool-call stream → emit a runnable script (CDP or Playwright
   syntax as an option) — big differentiator if it lands first.
9. **Network mock DX.** Playwright `route()` with glob + HAR replay is DX-nice;
   ours (intercept + override_resource) is more powerful but experimental-
   flagged and lower-level. Promote out of experimental once hardened.
10. **Run code with Playwright semantics** (`browser_run_code` executes
    Playwright code client-side). We have `execute` (page JS) — different
    thing. Optional later.

## 4. Strategic read

- Playwright MCP converging on our niche (persistent profile, extension mode)
  validates the category — but their core still owns a managed browser; our
  identity (the user's real session) stays defensible.
- Cheap wins first: P0 auto-wait + connection classifier, then P1 mouse-xy,
  storageState, device presets — all pure-CDP, no new deps, no contract
  changes.
- Do not chase multi-engine (Firefox/WebKit): conflicts with the real-browser
  attach identity and doubles the transport problem (see `01`).

## Sources

- https://github.com/microsoft/playwright-mcp
- https://playwright.dev/docs/getting-started-mcp
- Ecosystem state: https://currents.dev/posts/state-of-playwright-ai-ecosystem-in-2026
- Tool inventory: https://www.morphllm.com/playwright-mcp (23 core tools)
