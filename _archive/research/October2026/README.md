# Research — October 2026

Working research for the CDP modernization track. Dev-branch only; nothing here
ships to main. No code changes are planned from this folder yet.

| File | Topic |
|---|---|
| `01-cdp-modernization.md` | Legacy CDP vs the new browser-hosted remote debugging (chrome://inspect toggle / DevTools MCP era) — how to support both without breaking |
| `02-playwright-gap-analysis.md` | Where cdp-browser lags and leads vs Playwright / Playwright MCP |

## Context that triggered this

- Chromium 136+ blocks the legacy CDP HTTP endpoints on the **default**
  user-data-dir; a port can be bound by the browser yet serve 404s.
- Brave 153 (Chrome 153) ships `chrome://inspect/#remote-debugging` — a
  browser-hosted debug server ("Server running at 127.0.0.1:9222") that does
  **not** serve `/json/version` or `/json/list` (verified 2026-10-21 against
  Brave 153.1.95.104 / Chrome 153.0.8010.53). It targets the new
  chrome-devtools-mcp client, with per-client permission dialogs.
- Our attach path (launch flag + explicit non-default `--user-data-dir`) was
  verified working end-to-end the same day, same browser.

## Current verified stack (v5.0.2)

- Attach-only, raw CDP over WebSocket. No launcher, no bundled browser.
- Discovery: scan known User Data dirs for `DevToolsActivePort` files →
  resolve WS URL; fallback probe `GET /json/version` on `CDP_HOST:CDP_PORT`.
- Env surface: `CDP_HOST`, `CDP_PORT`, `CDP_PROFILE`, timeout family,
  `CDP_CLEANUP_STRATEGY`, `CDP_TEMP_DIR`, `CDP_SLIM_MODE`.
- 14 tools / 90+ actions. Two runtime deps (`ws`, `@modelcontextprotocol/sdk`).
