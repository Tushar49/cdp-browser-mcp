# Findings — Transport Seam Map in Our Codebase (RQ-C)

**Date:** 2026-10-21. Local code exploration of `MCP Server/src` (v5.0.2).
All paths relative to `MCP Server/src/`.

## C1 — Current connect flow (end-to-end)

**Startup** (`index.ts`): `loadConfig()` → `new CDPClient({commandTimeout})`
(disconnected, no I/O) → `new HealthMonitor(cdpClient, {cdpHost, cdpPort,
preferredProfile})` → `ctx: ServerContext` assembled at `index.ts:455-476`
(single DI container) → stdio transport live, still disconnected.

**First tool call → live WebSocket:**

1. `index.ts:580-601` tool handler; everything except
   `{ping, status, browser}` goes through `ensureConnected()`
   (`:482-492`, module-level `connectPromise` mutex `:480`).
2. `ensureConnected` → `HealthMonitor.autoConnect()` (`health-monitor.ts:172-185`,
   own mutex). `_doAutoConnect()` (`:188-242`) runs three strategies in order:
   - **S1** `:190-196` — retry `lastGoodWsUrl` (set on every success).
   - **S2** `:198-214` — HTTP probe `GET /json/version` on
     `COMMON_PORTS = [cdpPort, 9222, 9229, 9333, 9515]`, 2s timeout; uses
     `webSocketDebuggerUrl` from the response.
   - **S3** `:216-231` — `discoverBrowserInstances()` (DevToolsActivePort +
     `Local State` file scan); `findBestInstance` when `CDP_PROFILE` set.
3. `CDPClient.connect(wsUrl)` (`cdp-client.ts:98-127`) — the **only**
   `new WebSocket` in the client; `_attachListeners` (`:209-249`) routes
   `id`→resolve/reject, `method`→`emit('event')`.
4. All strategies fail → `ActionableError` with the generic
   "Could not find any browser with remote debugging enabled" text
   (`health-monitor.ts:234-241`).

**Per-tab sessions:** `tab-session-service.ts:35-67` — lazy
`Target.attachToTarget {flatten:true}` pooling + `setAutoAttach` for OOP
iframes. `session-manager.ts` is pure agent-session bookkeeping (TTL map),
never touches CDP.

**Error text locations** (for the Phase 0 classifier):

| Text | Where | Evidence available at that point |
|---|---|---|
| `## Browser Not Connected…` | `index.ts:595` | whatever `ensureConnected` threw |
| `Could not find any browser…` | `health-monitor.ts:234-241` | S2 exception type is **swallowed** — refused-vs-404 distinction (the key classifier signal, see `findings-routes-and-restrictions.md` B3) is discarded here |
| `Cannot connect to browser…` | `cdp-client.ts:117-124` | WS error event message |
| `Not connected to any Chrome instance.` | `tools/browser.ts:137` | `isConnected === false` |

## C2 — Seam design inputs

**Two insertion surfaces:**

1. **Socket-level:** `CDPClient.connect(wsUrl)` — the single `new WebSocket`.
   Transport contract = `connect(url)`, `send(json)`, `close()`, `terminate()`,
   `readyState`, events `open/message/close/error`.
2. **Endpoint-level:** wrap `HealthMonitor._doAutoConnect` strategies —
   discovery becomes per-transport. Recommended: **both** — a `Discovery`
   chain (S2/S3 generalized) returning candidate endpoints, then a
   `Transport` connecting to one.

**Required `CDPClient` surface by consumers** (`types.ts:243`,
`health-monitor.ts:60`, `tab-session-service.ts:35`): `extends EventEmitter`
with `'event' | 'connected' | 'disconnected' | 'error'`; `send(method, params?,
sessionId?, timeout?)`; `connect/disconnect/terminate`; `state`, `isConnected`,
`url`; session pool trio `getPooledSession/poolSession/unpoolSession`;
`getTargetsCached/invalidateTargetCache`.

**One WebSocket leak:** `rawSocket` getter (`cdp-client.ts:88`) is used only
by HealthMonitor ping/pong (`:252-288`). Transport interface needs an abstract
ping (e.g. `healthPing(): Promise<void>`) or HealthMonitor takes an optional
`HealthCheckable` — avoids socket coupling.

**Singletons to respect** (per AGENTS.md, DI holds for tools; these are the
exceptions): module-level `config/cdpClient/healthMonitor/…` in `index.ts:63-79`
(one CDPClient per process), `connectPromise` (`:480`), wiring flags
(`:83-84`), HealthMonitor's `lastGoodWsUrl`/`suppressAutoReconnect`
(`health-monitor.ts:62-68`). `Ctx.cdpClient` is typed as the concrete class —
extract an interface when introducing the seam.

## C3 — Discovery fallback feasibility

- Existing: HTTP probe on 5 ports (S2), `DevToolsActivePort` + `Local State`
  file scan (S3), `CDP_USER_DATA` env prepend (`browser-discovery.ts:174-177`,
  read directly from env, bypassing config.ts), `overrideDir` param.
- **No process listing, no raw TCP probe anywhere** (`child_process`/
  `netstat` absent from src). The `Get-CimInstance` technique from the Brave
  diagnosis would be a new, best-effort fallback: scan `brave/chrome/msedge`
  process command lines for `--remote-debugging-port` + `--user-data-dir`,
  then read the port file from that dir. Windows: `Get-CimInstance` ≈
  `wmic`/`Win32_Process`; needs child_process + platform guards — flag as
  opt-in (`CDP_PROCESS_SCAN=true`) to respect the no-surprise rule.
- Candidate dirs scanned today (`browser-discovery.ts:37-69`): Chrome,
  Chrome Beta, Canary, Chromium, Edge, Brave on win32/darwin/linux. Missing:
  Vivaldi, Opera, portable layouts (the user's `A:\Programs\...\data` case —
  only reachable via `CDP_USER_DATA` today), snap/flatpak variants.

## Verified tool inventory (14, full mode)

`ping`, `status`, `tabs`, `page`, `interact`, `execute`, `observe`, `emulate`,
`storage`, `intercept`, `cleanup`, `browser`, `debug`, `form`
(`index.ts:551-565`; comment there says "15 tools" — stale, fix opportunistically).
Slim mode re-exposes 6 Playwright-named aliases via `tools/slim-mode.ts`.

## Recommended seam shape (design note, no code yet)

1. Extract `interface Transport` (socket-level) + `interface Discovery`
   (endpoint-level); `LegacyHttpDiscovery` = S2, `PortFileDiscovery` = S3
   (extended with `CDP_USER_DATA` dirs + process-scan opt-in).
2. New `ApprovalModeDiscovery`: read `DevToolsActivePort` from candidate dirs
   → skip `/json/version` → WS `/devtools/browser` directly (toggle support;
   see `findings-routes-and-restrictions.md` A2/A4) — message the user to
   click Allow.
3. Classifier in `ensureConnected` failure path using S2 exception type
   (refused vs 404 vs timeout) → the B3 signature table.
4. Zero behavior change: legacy chain stays default, new transports activate
   only when legacy signatures match their failure modes (or via env).
