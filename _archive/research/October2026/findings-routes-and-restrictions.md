# Findings — New Debugging Routes & the M136 Restriction (RQ-A, RQ-B)

**Date:** 2026-10-21. Sources: chromium source (main), puppeteer source,
chrome-devtools-mcp source (pinned `bf8c6d9`), developer.chrome.com, issue
trackers. This file supersedes the "empirical only" notes in
`01-cdp-modernization.md` §1B — the toggle endpoint is now source-understood.

## RQ-A — What the toggle actually serves (A1–A4: ANSWERED)

### A1. It is the same DevTools HTTP server, in approval mode

- Toggle = local-state pref `kDevToolsRemoteDebuggingEnabled`; starts/stops the
  `DevToolsHttpHandler` in mode `RemoteDebuggingServerMode::kWithApprovalOnly`
  ([remote_debugging_server.cc#L188-191](https://github.com/chromium/chromium/blob/main/chrome/browser/devtools/remote_debugging_server.cc#L188-L191)).
- **Serves exactly one thing:** WS at `ws://127.0.0.1:<port>/devtools/browser[/<uuid>]`
  ([devtools_http_handler.cc#L79](https://github.com/chromium/chromium/blob/main/content/browser/devtools/devtools_http_handler.cc#L79)).
- **`/json/*` hard-404s by explicit early return** in approval mode
  ([#L596-601](https://github.com/chromium/chromium/blob/main/content/browser/devtools/devtools_http_handler.cc#L596-L601));
  discovery page `/` and frontend resources also 404. `POST /mcp` 404s because
  **Chrome has no /mcp HTTP endpoint at all** — the MCP layer lives in
  chrome-devtools-mcp, which speaks CDP over the browser WS. Our Oct 21 probe
  results are fully explained.
- Connection is **browser-target only**; page access via `Target.*` from that
  session (chrome-devtools-mcp works this way — maintainer-confirmed:
  [issue #2283](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/2283)).

### A2. Discovery contract — the key unlock for us

- In approval mode the server **still writes `DevToolsActivePort`** (line 1 =
  port, line 2 = ws path) into the **user data dir**
  ([devtools_http_handler.cc#L309-319](https://github.com/chromium/chromium/blob/main/content/browser/devtools/devtools_http_handler.cc#L309-L319)).
- chrome-devtools-mcp `--autoConnect` never probes HTTP: it reads
  `DevToolsActivePort` for the channel's default data dir → builds the WS URL
  → connects raw (puppeteer
  [BrowserConnector.ts#L109-159](https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/common/BrowserConnector.ts#L109-L159)).
  Missing file → `Could not find DevToolsActivePort for chrome at <path>`.
- Port fallback when the file is absent: `kDefaultDevToolsPort` = 9222.
- **Implication:** our Phase 1 transport can support the toggle with a small
  change — **skip the `/json/version` gate and use the port file directly**.
  Our existing S3 strategy (file scan) already parses this format
  (`readPortFile`, `browser-discovery.ts:92-103`); it failed on the user's
  Brave only because the portable data dir (`A:\Programs\...\data`) is not a
  scanned candidate path and S2's HTTP probe 404s. `CDP_USER_DATA` env already
  prepends custom dirs — this path exists today.

### A3. Permission dialog

- **Every incoming WS connection** triggers a browser-modal dialog
  (Allow / Cancel / "disable" → navigates to the toggle page). No cached
  approval; persistence is an open request
  ([chrome-devtools-mcp#825](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/825)).
- **No browser window → auto-DENY**
  ([devtools_connection_dialog.cc#L36-40](https://github.com/chromium/chromium/blob/main/chrome/browser/devtools/devtools_connection_dialog.cc#L36-L40))
  — headless/hidden sessions cannot be approved.
- No policy or flag auto-approves; `DevToolsRemoteDebuggingAllowed` policy only
  gates whether the server exists. While connected, a global
  "Chrome is being controlled" infobar shows.
- Our UX consequence: connecting through the toggle needs one human click per
  MCP server process — acceptable interactively, hostile to CI. Message it.

### A4. Verdict

**Usable, semi-documented, stable-in-practice (Chrome 144→153).** Recipe:
read `DevToolsActivePort` → `ws://127.0.0.1:<port><path>` → user approves →
browser-level CDP session → `Target.getTargets`/`setAutoAttach` for pages.
Contractually undocumented (CDP docs still only describe legacy `/json/*`);
treat as best-effort transport with the legacy flag path as default.

## RQ-B — Chromium 136+ default-profile restriction (B1–B3: ANSWERED)

### B1. Mechanics — and a correction to our notes

- Since **Chrome 136**: `--remote-debugging-port`/`--remote-debugging-pipe`
  ignored for the default data dir
  ([official blog](https://developer.chrome.com/blog/remote-debugging-port)).
- Implementation: `IsUsingDefaultDataDirectory()` → mode
  `kDisabledByDefaultUserDataDir` → **server never constructed — the port is
  NOT bound at all** (`ECONNREFUSED`), no `DevToolsActivePort`
  ([remote_debugging_server.cc#L162-186](https://github.com/chromium/chromium/blob/main/chrome/browser/devtools/remote_debugging_server.cc#L162-L186);
  [crbug 417456892](https://issues.chromium.org/issues/417456892)).
- **Correction:** "port binds but endpoints 404" is the *toggle approval-mode
  signature*, NOT the M136 restriction. Two distinct failure modes.
- Scope: check compiled only for `GOOGLE_CHROME_BRANDING` — vendors opt in;
  Edge documented affected; Brave observed affected (our Brave 153 tests),
  treat as upstream-parity, not documented. Headless/headed: no difference.
  Chrome for Testing exempt.

### B2. Escape hatches (sanctioned)

1. Explicit non-default `--user-data-dir` — the documented fix (what we do).
2. Chrome for Testing (recommended for automation).
3. The chrome://inspect toggle itself — the sanctioned route **for the default
   real profile** (approval mode bypasses the default-dir block).
4. `DevToolsRemoteDebuggingAllowed=false` only kills debugging entirely; it
   does NOT bypass the dir check.
5. **`--disable-features=DevToolsDebuggingRestrictions` is FAKE** — no such
   feature exists in `features.cc`; do not repeat the claim from
   browser-use#1520.

### B3. Failure-signature classifier (feeds Phase 0)

| Signature | Meaning | Message |
|---|---|---|
| TCP **refused** on debug port, flag was passed | M136 default-dir block | "relaunch with explicit `--user-data-dir`" |
| Port **bound**, `/json/version` → **404** | Toggle approval-mode server | "new gated debugging detected; either approve via our toggle-transport (click Allow) or relaunch with flag" |
| WS → `403 "Connection rejected"` | Wrong WS path or denied dialog | path/approval guidance |
| WS → `403 …--remote-allow-origins=…` | Origin allowlist | quote the flag |
| `Could not find DevToolsActivePort …` (puppeteer wording) | toggle off or dir unknown | point at toggle + `CDP_USER_DATA` |
| Nothing listening, no flag | debugging off | current generic message |

Note: health-monitor S2 currently swallows the exception type
(`health-monitor.ts:198-214`) — the refused-vs-404 distinction is exactly the
evidence it throws away (see `findings-transport-seam.md`).
