# Release Plan — v5.0.3 "Connection Intelligence"

**Status:** planned (2026-10-21). Scope source: `improvement-backlog.md`
group A + D hygiene. Versioning: **semver stays** (decision 2026-10-21) —
5.0.3 next; CalVer revisit possible at a 6.0.0 boundary.

Theme: make connecting **work and explain itself** in every observed failure
mode — default-profile block (M136), toggle approval mode, portable layouts,
stale ports — with zero behavior change for the already-working path.

## In scope (items 1–5 + docs)

### 1. Preserve connect evidence (S)

- `health-monitor.ts:198-214` (S2): stop discarding the exception. Capture
  per-port outcome: `refused | 404 | timeout | other`.
- Acceptance: unit test asserting outcome types are surfaced on failure.

### 2. Connect-error classifier (S)

- `ensureConnected` failure path → new `utils/connect-diagnostics.ts`:
  classify via the B3 signature table
  (`findings-routes-and-restrictions.md`):
  - TCP refused + flag implied → M136 default-dir block → message with the
    exact relaunch command (host, port, user-data-dir).
  - Port bound + `/json/version` 404 → toggle approval mode → message:
    either approve via toggle transport (item 3) or relaunch with flag.
  - 403 with origin hint → quote `--remote-allow-origins` fix.
  - Port file missing → point at `CDP_USER_DATA` + toggle.
- Replace the generic `Could not find any browser…` text
  (`health-monitor.ts:234-241`) with classified output.
- Acceptance: unit tests per signature; manual matrix on Brave flag/toggle.

### 3. ApprovalModeDiscovery — toggle support (M)

- New discovery strategy S4 (after S3): read `DevToolsActivePort`
  (line 1 port, line 2 ws-path) from candidate dirs → connect
  `ws://127.0.0.1:<port><path>` directly, **skipping `/json/version`**.
- Triggered when: S2 returns 404-family (bound-but-silent) or S3 finds a port
  file whose HTTP probe fails but whose WS path exists.
- UX: on first connect through this path, tool response hints:
  "Look at your browser — click **Allow** on the debugging permission dialog
  (needs a visible window)."
- Constraints honored: browser-target session only (page access via
  `Target.*` — verify tabs list works through `Target.getTargets`);
  per-connection dialog; no-window auto-deny surfaced as a clear error.
- Acceptance: live test on Chrome/Brave 153+ with toggle ON; tabs list works;
  ping reports connection mode (`legacy | approval`).

### 4. Process command-line scan (M, opt-in)

- Env `CDP_PROCESS_SCAN=true` → best-effort scan of running
  `chrome/brave/msedge` processes for `--user-data-dir` +
  `--remote-debugging-port`; feed discovered dirs/ports into S3/S4.
- Windows first (`Win32_Process` via PowerShell one-shot or WMIC), guarded,
  non-fatal when unavailable; documented as opt-in (no surprise spawning).
- Acceptance: works for the portable Brave layout
  (`A:\Programs\...\data`) without `CDP_USER_DATA`.

### 5. Hygiene (S)

- Extend `getBrowserCandidates` (`browser-discovery.ts:37-69`): Vivaldi,
  Opera; keep list table-driven.
- Fix stale "15 tools" comment (`index.ts:552` → 14).
- `CDP_USER_DATA` read moves into `config.ts` (currently env-read directly in
  browser-discovery — AGENTS.md's "config.ts is the only env reader").

### 6. Docs (S)

- README: new "Connection troubleshooting" section = the four failure modes
  + fixes + `CDP_USER_DATA`/`CDP_PROCESS_SCAN`/`CDP_PORT` table rows.
- AGENTS.md dev checklist: add toggle-mode test case (approve the dialog).
- CHANGELOG entry under 5.0.3.

## Explicitly deferred (not 5.0.3)

- Auto-wait gate, mouse-xy, storageState, device presets → **5.1.0**
  (backlog items 6–9).
- verify-family, response-codegen, iframe piercing, tracing, intercept DX
  promotion → 5.1.x+ (items 10–14).
- Extension relay design study → when `extension/` v5.1 work starts.

## Rollout (standard pipeline)

1. Implement on dev, `pnpm typecheck` + `pnpm test` green + live checklist
   (flag mode AND toggle mode) per AGENTS.md.
2. Promote dev → main (workflow or manual flow).
3. Bump version in `MCP Server/package.json` + `VERSION` in `src/index.ts`
   **together** → merge to main → tag `v5.0.3` → release.yml publishes
   (OIDC, trusted publisher — now validated) npm + GitHub Release.
4. Verify: `pnpm view cdp-mcp-server version` → 5.0.3; `pnpm dlx`
   smoke test; README renders.

## Estimate

~1 focused dev session for items 1–2 + 5–6; item 3 ~half a session with the
live browser; item 4 platform-guarded, could slip to 5.1.0 without harm.
