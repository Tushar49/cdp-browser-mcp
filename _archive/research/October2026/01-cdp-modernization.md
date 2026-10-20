# CDP Modernization — Legacy vs Modern, Without Breaking

**Status:** research only. **Date:** 2026-10-21. **Repo state:** v5.0.2 live on
npm (OIDC trusted publishing pipeline), dev branch.

## 1. The problem space

Three "worlds" now coexist in Chromium-land:

### A. Legacy CDP (what we do today)

- Browser launched with `--remote-debugging-port=N` (+ our requirement:
  explicit non-default `--user-data-dir`, because **Chromium 136+ refuses CDP
  on the default profile dir** — the port binds, then HTTP endpoints 404).
- Discovery contract: `GET /json/version` → `webSocketDebuggerUrl` → browser
  WS. `DevToolsActivePort` file written into the profile dir as a side effect.
- Verified working on Brave 153 portable (2026-10-21) with the flag + the
  portable data dir. Everything we ship (14 tools / 90+ actions) runs on this.

### B. Browser-hosted remote debugging (the new toggle)

- `chrome://inspect/#remote-debugging` → "Allow remote debugging for this
  browser instance" → "Server running at 127.0.0.1:9222".
- **Empirically (2026-10-21, Brave 153):** binds 9222, but `GET /json/version`,
  `/json/list`, `/json`, `/`, and `POST /mcp` all return **404**. No
  `DevToolsActivePort` file either. It is a gated interface built for the
  official chrome-devtools-mcp client; Chrome shows a permission dialog per
  connecting MCP server. Wire protocol undocumented for third parties.
- This is why "remote debugging on" ≠ "our server can connect" — an exact,
  reproducible case we must detect and message.

### C. chrome-devtools-mcp (Google's official MCP server)

- Ships as `npx chrome-devtools-mcp` (stdio MCP server). Internally talks CDP.
- Connect modes: `--autoConnect` (pairs with the B toggle), `--ws-endpoint
  http://127.0.0.1:<port>/devtools/browser` (explicit attach), or it launches
  its own Chrome with flag + temp profile.
- Competes with us on the "agent drives a browser" job, but it is Chrome-team
  tooling: keep it mapped, not feared. Its tool surface is narrower than ours
  (no real JS debugger, no resource overrides, no profile pinning).

## 2. What "support legacy or modern smartly" should mean

Principle: **the tool contract never changes** (14 tools, same inputs/outputs).
Only the transport beneath changes, selected by capability negotiation at
connect time.

### Phase 0 — smart detection + honest errors (small, do first)

Today's "Browser Not Connected" error is generic. Replace with a classifier
that distinguishes (all evidence already collectable):

1. **Nothing on port** → "no browser with debugging enabled" (current message).
2. **Port bound, `/json/version` 404, port owner is the browser binary** →
   new-toggle case (B) → message: "Your browser runs the new gated remote
   debugging (chrome://inspect toggle). It does not serve CDP. Relaunch with:
   `<browser.exe> --user-data-dir=<dir> --remote-debugging-port=9222`" —
   with the exact command we used successfully.
3. **Port bound, browser is on default user-data-dir, M136+** → the 136
   restriction case → same fix, plus explanation.
4. **Different browser version / stale DevToolsActivePort** → say so.

This alone removes 100% of today's confusion (we hit all four states by hand).

### Phase 1 — transport abstraction (the "no breaking" core)

Extract a `Transport` interface in `src/connection/`:

```
discover(): TransportInfo[]        // what's reachable
connect(info): BrowserConnection   // WS or otherwise
send / on / close
```

- `LegacyCdpTransport` = current behavior, default.
- Discovery becomes multi-source: DevToolsActivePort scan (exists) →
  `/json/version` probe (exists) → **process command-line scan** (new: we did
  this by hand with `Get-CimInstance` — the same trick as a best-effort
  fallback finds browsers launched with the flag but on odd ports).
- Everything above (`session/`, `snapshot/`, `tools/`) stays untouched —
  they already only see a CDP-like connection object.

### Phase 2 — modern stack options (decide later, watch items)

Ordered by realism:

1. **Documented-endpoint client**: if/when Google documents the toggle's wire
   protocol (watch `chrome-devtools-mcp` repo + chromium source
   `content/browser/devtools`), add `GatedRemoteDebuggingTransport`. The
   tool layer maps 1:1 onto our existing actions.
2. **chrome-devtools-mcp bridge**: optional adapter that spawns/drives
   chrome-devtools-mcp for the connect step only. Heavy, second MCP hop,
   awkward tool mapping — keep as last resort.
3. **WebDriver BiDi**: cross-browser protocol gaining Puppeteer/Playwright
   support. Out of scope (we are deliberately Chrome-family), but track it —
   if BiDi eating CDP ever happens, a BiDi transport reuses the same
   `Transport` seam.

### Explicit non-goals (for now)

- Bundling/launching browsers (product identity = attach to the user's real
  browser; owner's rule: never auto-launch).
- Chasing the undocumented toggle endpoint by reverse engineering — fragile
  across Chromium point releases, and it changes per-client permission UX.
- Supporting Firefox/WebKit (Playwright's game, not ours).

## 3. Risks / watch items

- **Brave/Chromium updates** can flip any of A/B/C behavior (Brave 153
  introduced B; Chromium 136 introduced the default-dir block). Our CI can't
  catch these — they need the live-browser checklist in AGENTS.md.
- **Portapps wrappers** strip/pin launch args (`--disable-brave-update`,
  pinned appcast) — launch-flag guidance must target the inner
  `app/<browser>.exe`, not the wrapper shortcut.
- **npm `0.0.0-stage` placeholder** stays on the package page after the
  staged-publish validation — cosmetic; optional unpublish later.

## 4. Immediate (no-code) hygiene while this matures

- Keep AGENTS.md's dev checklist as the regression net for connection bugs.
- When users hit case B, the tabs the user runs are preserved — our error
  text should quote the exact relaunch command (same data dir = logins kept).

## Sources

- chrome-devtools-mcp: https://github.com/ChromeDevTools/chrome-devtools-mcp
- DevTools MCP config/autoConnect:
  https://developer.chrome.com/docs/devtools/agents/get-started/configuration
- Chromium 136 default-profile CDP restriction: widely reported behavior,
  verified locally (404-on-bound-port with default dir, Oct 2026).
- Local empirical results: `_archive/research/October2026/README.md`.
