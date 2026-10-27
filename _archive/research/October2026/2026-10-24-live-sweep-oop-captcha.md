# Live capability sweep — 2026-10-24 (dev, v5.0.3 build + 5.1.0 work-in-progress)

Environment: Brave 153 portable (`A:\Programs\Browsers\brave-portable\app\brave.exe`), approval-mode
connection, real profile. Comparison baseline: `@playwright/mcp` 0.0.83 launching its own isolated
Brave instance via `PLAYWRIGHT_MCP_EXECUTABLE_PATH`.

## What works (verified live)

- **Connection**: approval mode, health `connected (failures: 0)`, process scan on.
- **Sannysoft (bot.sannysoft.com)**: all rows green — WebDriver missing (passed), plugins 7,
  WebGL Vendor/Renderer "Brave" (real GPU, no SwiftShader). Real-profile driving is undetected
  at the fingerprint level.
- **A4 device presets**: `emulate.device "Pixel 7"` swapped UA (`Android 14; Pixel 7 … Chrome/130
  Mobile`), DSF 2.625, screen 3840x2160; `reset` clean. Sannysoft still green under emulation.
- **A3 storageState**: `export_state` returns correct Playwright-shaped JSON (cookies + origins).
- **click_xy into OOP iframes**: dispatches cleanly (page gains focus); reCAPTCHA checkbox click
  landed — evidence: `bframe` challenge frame loads afterward (also reproduced independently by
  Playwright clicking the same checkbox).
- **Screenshots**: normal operation outside the quirk below.

## Bugs / gaps found (feed into 5.1.0)

1. **Snapshot does not pierce iframes** (the big one). reCAPTCHA widget surfaces as
   `IframePresentational "reCAPTCHA" [ref=22]` with no children — the checkbox gets no uid, so
   ref-based interaction is impossible; only coordinate clicks work. Playwright MCP pierces frames:
   `iframe [ref=e27]: checkbox "I'm not robot" [ref=f1e7]` (frame-scoped refs `f1e*`).
   **RESOLVED same day (A5b, two-part):** (a) the reCAPTCHA iframe is actually same-origin
   (www.google.com on www.google.com) — no OOPIF target exists; the multi-frame snapshot path was
   gated on OOP child sessions and never ran — gate removed, always-on per-frame capture.
   (b) OOPIF wiring: `Target.setAutoAttach` fired but nothing consumed `Target.attachedToTarget` —
   event listener added to TabSessionService. Also fixed: uid→session routing was populated before
   uids existed (always empty), and frame-relative bounding rects were dispatched as main-viewport
   coordinates (fixed via `window.frameElement` offset walk inside the resolve script).
   Live-verified: checkbox `[checked, focused]` after ref-based click.
2. **`Page.captureScreenshot` hangs after in-OOPIF clicks** (observed 2x on reCAPTCHA demo after
   `click_xy` into the widget; both cleared by reload). Hypothesis: challenge `bframe` OOPIF
   overlay/spinner blocks main-surface capture. Workaround today: reload. Needs investigation
   (capture flags, fromSurface, or detect-and-retry with surface refresh).
3. **`observe.network` `clear: true` permanently disables monitoring for the tab** — even after a
   fresh `goto`, "No network requests captured yet". Monitoring does not re-arm after clear.
   Fix in observe/network capture lifecycle.
4. **B1 `Schema.getDomains` unavailable** on Brave 153 (confirmed live: `'Schema.getDomains'
   wasn't found`). The `Schema` domain was removed from Chrome years ago. Redesign probe as
   multi-canary command probing (or `Browser.getVersion` heuristics) instead of Schema.

## Playwright MCP comparison notes (baseline)

- Runs without extension when `PLAYWRIGHT_MCP_EXECUTABLE_PATH` is set (opencode config now points
  at the portable Brave exe; `--extension` flag removed). Own isolated profile, not the user's.
- Click output includes the generated Playwright code + updated snapshot + console deltas
  (agent-friendly, but verbose; 3 artifacts per action vs our one-line result).
- Frame click executed as
  `page.locator('iframe[name=…]').contentFrame().getByRole('checkbox', …).click()` — exactly the
  ref-path A5b enables.
- No device presets / storageState / debugger / intercept / HAR / human-mode surface.
- Confirmed real-profile attach (our approval mode) is something Playwright cannot do here
  without the Chrome extension.

## Conclusion

A5 routing (done) + A5b snapshot piercing (todo) closes the OOP-iframe interaction gap that
Playwright currently covers. Items 2–4 above are cheap targeted fixes worth landing in 5.1.0
alongside the B-track.
