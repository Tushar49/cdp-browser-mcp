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

### 4. Process command-line scan (M, default ON)

- **Default ON**, kill-switch `CDP_PROCESS_SCAN=false`. Rationale: runs only
  on discovery-failure paths (never in the happy path), read-only,
  same-user/non-elevated, zero-config value for npm installs.
- Mechanism: query running `chrome/brave/msedge` processes' command lines
  (Windows: `Win32_Process` via PowerShell one-shot; macOS `ps`; Linux
  `/proc/*/cmdline`), extract `--user-data-dir` + `--remote-debugging-port`,
  feed dirs into the port-file scan and ports into the HTTP probe.
- **Privacy rule: never emit full command lines** into logs or tool
  responses — only the extracted dir/port.
- Config surface for npm users = the launching client's per-server env block
  (OpenCode `environment`, Claude Desktop/Cursor `env`). README documents
  every env key with copy-paste examples; a global config file is deferred
  (possible 5.1+ — env-via-client is the MCP-universal mechanism today).
- Acceptance: works for the portable Brave layout
  (`A:\Programs\...\data`) without `CDP_USER_DATA`; the disabled path is
  proven by test.

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

## Implementation phases & test matrix (detail)

Baseline rule for every phase: `pnpm typecheck` + `pnpm test` green before
commit; the happy path (flag-mode connect) stays byte-identical — each phase
adds a regression assertion for it. Live rows: the user launches/closes
browsers; the agent verifies outputs only (standing rule).

### Phase 0 — Baseline
- Branch dev; record current failure messages verbatim (before-goldens).
- Confirm full unit suite green.

### Phase 1 — S2 evidence preservation
- Change: S2 probe returns `{port, outcome: refused|404|timeout|200, detail}[]`
  instead of discarding errors; strategy order untouched.
- Unit: mock `fetch` per outcome → evidence shape; S1→S2→S3 order pinned;
  200 on first port short-circuits as today.
- Manual: all browsers closed → tool call → error lists probe evidence.

### Phase 2 — Connect-error classifier
- Change: `utils/connect-diagnostics.ts`, pure
  `classify(evidence) → {kind, message}`; kinds `NO_BROWSER`,
  `M136_DEFAULT_DIR`, `TOGGLE_MODE`, `ORIGIN_BLOCKED`, `PORT_FILE_MISSING`,
  `GENERIC`; replaces generic text at `health-monitor.ts:234-241`.
- Unit: table-driven signature→kind mapping; M136/TOGGLE messages contain
  the exact relaunch command; unknown input → GENERIC (never throws);
  synthetic 403-origin response → ORIGIN_BLOCKED.
- Live matrix (user executes, agent verifies message text):
  1. All closed → NO_BROWSER
  2. Chrome default profile + flag (M136) → refused → M136_DEFAULT_DIR
  3. Brave toggle ON, no flag → bound+404 → TOGGLE_MODE
  4. Flag + portable dir (working setup) → connects, unchanged path

### Phase 3 — ApprovalModeDiscovery (S4)
- Change: `discoverApprovalEndpoints(dirs)` — port file present + HTTP probe
  fails → candidate WS URL; health monitor S4 (after S3) connects directly,
  no `/json/version`; `connectionMode: 'approval'` exposed in ping/status;
  first-connect hint "click Allow (needs a visible window)".
- Unit: approval-format port file parsing pinned; S4 only after S3 miss;
  S4 skipped when S2 returns 200 (flag path never sees S4).
- Live:
  1. Toggle ON, no flag → dialog → Allow → ping `connected, mode: approval`
     → tabs list returns real tabs (validates browser-target + Target.*)
  2. Dialog denied → clean error naming the dialog
  3. Flag mode → S2 connects as before, no dialog

### Phase 4 — Process scan (default ON)
- Change: as in item 4 above; feeds dirs → port-file scan, ports → probe.
- Unit: parser handles quoted paths with spaces, multiple processes, dedupe;
  privacy — full command lines never appear in outputs; kill-switch
  `CDP_PROCESS_SCAN=false` → zero child_process calls (spy-asserted).
- Live:
  1. Portable Brave + flag, no CDP_USER_DATA → discovered + connected
  2. Portable Brave toggle-only → dir discovered → S4 → dialog → connected
  3. `CDP_PROCESS_SCAN=false` → old behavior + classifier message

### Phase 5 — Hygiene + docs
- Vivaldi/Opera dirs (table-driven + snapshot test); `CDP_USER_DATA` into
  `config.ts` (callers updated); stale "15 tools" comment; README
  troubleshooting (4 failure modes + env table incl. `CDP_PROCESS_SCAN`);
  AGENTS toggle test case; CHANGELOG.

### Phase 6 — Release pipeline
- Full suite + live matrix all green → slim-mode smoke → version bump
  (`MCP Server/package.json` + `VERSION` in `src/index.ts` together) →
  promote dev → main → tag `v5.0.3` → release.yml (OIDC) → verify
  `pnpm view` = 5.0.3, `pnpm dlx cdp-mcp-server@latest` smoke, npm README
  render, GitHub Release bundle.

Rule: a failing live row stops the phase — fix before the next phase; no
stacking unverified changes.

## Estimate

~1 focused dev session for items 1–2 + 5–6; item 3 ~half a session with the
live browser; item 4 platform-guarded, could slip to 5.1.0 without harm.
