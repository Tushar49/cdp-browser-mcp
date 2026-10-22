# Modernization & Implementation Plan — October 2026

Repo: `Tushar49/cdp-browser-mcp` · package `cdp-mcp-server` (npm, 5.0.2 live,
`latest`, OIDC trusted publishing validated) · branch model: dev → main
promote; this plan lives on dev only.

Companion research (repo, dev-only): `_archive/research/October2026/` —
`research_plan.md`, `findings-routes-and-restrictions.md`,
`findings-playwright-internals.md`, `findings-transport-seam.md`,
`improvement-backlog.md`, `release-plan-v5.0.3.md`.

Reference clones (local, not in repo): `D:\.development\Clones\Playwright`
(Playwright monorepo, depth-1, latest main) and scratch copy
`A:\.devTools\cache\temp\pw-research\playwright` (`1.65.0-next` @ `89cd2a6`,
2026-10-20). Local installs for testing: `@playwright/mcp 0.0.83`,
`playwright-core 1.64.0-alpha` (dlx cache).

External snapshot (2026-10-21): CDP tot = 59 domains / 677 commands (39 of 53
browser domains experimental; viewer "1.3/stable" aliases tot). Chrome stable
cadence twice-monthly; Chrome for Testing stable `156.0.8078.47` (exempt from
the M136 default-profile debugging restriction).

## 1. Principles (every release)

1. Tool contract stays stable — 14 tools / 90+ actions keep working; new
   behavior is additive or flag-gated.
2. No new runtime deps (`ws` + `@modelcontextprotocol/sdk` only).
3. Everything through `ServerContext` DI; `config.ts` is the only env reader.
4. Experimental protocol surface follows the `intercept` pattern: marked
   experimental, browser-version notes, safe fallback.
5. Runtime capability detection via `Schema.getDomains` (new: `status`
   reports which CDP domains the connected browser supports) — the defense
   against twice-monthly Chrome churn.
6. Live-browser verification per AGENTS.md checklist (flag mode + toggle
   mode) before every promote.
7. Configuration surface = the launching client's per-server env block
   (OpenCode `environment`, Claude Desktop/Cursor `env`) — the MCP-universal
   mechanism; `config.ts` stays the only env reader. A global config file is
   a deferred possibility (5.1+), not a 5.0.x item.

## 2. Release ladder

### v5.0.3 — "Connection Intelligence" (next)

Full scope: `release-plan-v5.0.3.md`. Summary:

1. S2 exception preservation (refused / 404 / timeout evidence kept)
2. Connect-error classifier (M136 refused vs toggle-404 vs 403 origin vs
   generic) with exact fix commands in messages
3. ApprovalModeDiscovery — toggle support: `DevToolsActivePort` → WS
   `/devtools/browser`, skip `/json/version`, "click Allow" UX
4. Process command-line scan (default ON, `CDP_PROCESS_SCAN=false` to
   disable) — path-independent discovery for portable layouts
5. Dir-list extensions (Vivaldi/Opera), `CDP_USER_DATA` into config.ts,
   stale "15 tools" comment fix
6. Docs: README troubleshooting; AGENTS toggle test case; CHANGELOG

Exit criteria: all four failure modes produce correct actionable messages;
toggle-mode tabs list works live; zero behavior change on the flag path.

### v5.1.0 addendum — agent-friendliness (added 2026-10-23, SHIPPED on dev)

Other-agent CDP misfire diagnosis: harness partial catalogs (14 tools, 2 shown)
misled an agent into thinking only ping/status existed, and Connected: false
(connect-exempt health tools) read as a dead end one step before auto-connect.
Server-side fixes shipped (cd1e7f4):
- MCP Server options now send instructions in the handshake (tool roster,
  auto-connect behavior, approval/flag connection modes)
- ping/status append the auto-connect hint when disconnected

### v5.1.0 — "Engine + Protocol Freshness"

**Engine (Playwright gap closers, backlog items 6–9):**
- Auto-wait gate: injected visible/stable/enabled/editable checks, backoff
  ladder `[20,50,100,100,500]`, scrollIntoView cycling, elementFromPoint
  hit-target check; `force: true` escape hatch
- Raw mouse: `interact.mouse_move/down/up/click_xy/wheel` via
  `Input.dispatchMouseEvent`
- storageState one-shot: `storage.export_state` / `import_state`
  (Playwright-compatible JSON schema)
- Device presets: `emulate.device` from a Chromium-family subset of
  `deviceDescriptorsSource.json` (Apache-2.0, source attributed)

**CDP freshness (verified in tot, low risk):**
- `status` capability report via `Schema.getDomains`
- `FindInPage.findFirst/findNext/findPrev/stop`
- `Emulation.setDevicePostureOverride` + `setCPUPerformanceOverride`
  (Chrome 153/154 — feature-detect)
- `Network.configureDurableMessages` + `streamResourceContent`
- `Memory.getDOMCountersForLeakDetection` / `prepareForLeakDetection`
- Spikes: `Page.getAnnotatedPageContent` (vs our a11y snapshot — adopt only
  if token-competitive), `Page.startScreenRecording/stopScreenRecording`

### v5.2.0 — "Agent Ergonomics"

- verify/assertion family (structured pass/fail, not dumps)
- Response-as-codegen: equivalent script lines appended to tool responses
- iframe-piercing snapshots (frame-qualified UIDs from merged per-frame trees)
- Overlay highlight (`browser_highlight` parity)
- Intercept out of experimental: glob patterns, unroute, docs
- Screencast recording graduated from spike (if 5.1 spike succeeds)

### Watch list (no commitment)

- **WebMCP** (`WebMCP.enable/invokeTool`): Chrome 149+, behind
  `#devtools-webmcp-support` + `#enable-webmcp-testing`; Playwright ships
  `browser_webmcp_*` today. Revisit when unflagged; possible 5.2/6.0 env-gated
  spike.
- **FedCm** automation (`selectAccount/clickDialogButton/dismissDialog`):
  SSO dialog control — high value, auth-critical; sandbox spike before
  shipping.
- **WebAuthn** virtual authenticators (credential CRUD, UV simulation): MFA
  flow testing.
- **Extensions / PWA domains**: chrome-devtools-mcp docs mark categories
  pipe-connection-only — verify over WS attach before scoping; likely out of
  reach for our transport.
- **Ads metrics**, **DeviceAccess / BluetoothEmulation / SmartCardEmulation /
  DigitalCredentials** (hardware-class), **multi-screen Emulation**
  (headless-only): skip unless a concrete request appears.
- **Chrome for Testing** (156.x): document as recommended automation target.
- **Transport Phase 2**: approval-mode endpoint is source-understood; revisit
  only if Google documents a stability contract.
- **BiDi**: watch only (Chrome-family by design).

## 3. Sequencing & effort

| Release | Work | Est. |
|---|---|---|
| 5.0.3 | connection intelligence items 1–6 | 1–2 sessions |
| 5.1.0 | engine workstream | 3–5 sessions |
| 5.1.0 | CDP freshness workstream | 1–2 sessions |
| 5.2.0 | ergonomics | 2–4 sessions |

Rule: never mix connection-intelligence and engine-behavior changes in one
release — failure attribution and rollback stay clean.

## 4. Verification pipeline (every release)

1. `pnpm typecheck` + `pnpm test` green on dev
2. Live checklist: flag mode (legacy), toggle mode (approval dialog),
   default-profile failure (classifier message), `CDP_PROCESS_SCAN=true`
   (portable layout)
3. Slim-mode smoke (Playwright-named aliases still map)
4. Promote dev → main → bump version (package.json + `VERSION` together) →
   tag `vX.Y.Z` → release.yml (OIDC trusted publishing) → npm + GitHub
   Release
5. Post-release: `pnpm view` check, `pnpm dlx cdp-mcp-server@latest` smoke,
   README render check

## 5. Risks

- Twice-monthly Chrome stables → experimental domains churn; mitigated by
  `Schema.getDomains` detection + additive-only adoption.
- Toggle bridge has no stability contract → best-effort support, never the
  default path.
- Pipe-only domains (Extensions/PWA) → verify before scoping.
- Auth-adjacent features (FedCm/WebAuthn) → sandbox spikes only.
- npm staged publishes → trusted publisher validated; re-staging needs one
  approval click (documented).

## 6. Open decisions

**RESOLVED 2026-10-21 (owner):**
1. 5.1.0 packaging: **together** — engine + CDP freshness in one release
   (`release-plan-v5.1.0.md`).
2. FedCm/WebAuthn: **FedCm stays watch-only** (no competitor exposes it via
   MCP — Playwright MCP, Puppeteer, chrome-devtools-mcp all lack it);
   **WebAuthn moves to 5.2 planned** (Puppeteer has it via CDP — parity
   justifies; sandbox spike first, auth-critical).
3. README compatibility table: **done** — shipped with the 5.0.3 polish pass
   (browser × flag/toggle/process-scan matrix, tool-table drift fixed
   12→14 tools, badge 5.0.3, dev-only references removed).
4. Timing: **5.1.0 started immediately** after 5.0.3 release (2026-10-21).
