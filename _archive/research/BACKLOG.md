# CDP Browser Automation - Deferred Items

## 2026-05-13 — deferred from session

### A. Connection token persistence — INVESTIGATED 2026-05-13

**Finding:** There is no token. Chrome does not authenticate raw CDP
connections to `localhost:9222` (no header, no cookie, no challenge). The
"prompt" the user is seeing is almost certainly Chrome's persistent
"Chrome is being controlled by automated test software" infobar, which is
enforced by Chrome itself and cannot be dismissed or persisted away. Our
extension (`extension/v0.1.0`) is a stub with no approval flow at all, so
the prompt is not coming from us.

**Action taken:** None code-wise. Investigation report written; no
fabricated token storage was introduced.

**Remaining work (closed -> follow-ups):**
- **A.1 (new):** Ship `scripts/start-chrome.ps1` and `scripts/start-chrome.sh`
  that always use the same `--remote-debugging-port=9222` and a stable
  `--user-data-dir`, so per-binary trust state and the user's logged-in
  Chrome profile are preserved across sessions.
- **A.2 (new):** Update the connection error in `cdp-client.ts` and the
  README to document the "is being controlled" infobar as expected and
  unavoidable - this sets correct expectations.
- **A.3 (Phase B of extension):** When the extension's WebSocket bridge
  lands, persist the per-app approval flag in `chrome.storage.local`
  keyed by `${origin}:${port}` so users approve once and never again.

See `.research/ConnectionTokenInvestigation.md` for full investigation.

### A.1 — DONE 2026-05-13
Created scripts/start-chrome.{ps1,sh}. Both auto-detect Chrome path, no-op if port already in use, support --isolated for fresh profile, document the persistent infobar limitation inline.

Usage:
  pwsh -File scripts/start-chrome.ps1
  pwsh -File scripts/start-chrome.ps1 -Isolated
  bash scripts/start-chrome.sh
  ISOLATED=1 bash scripts/start-chrome.sh

This eliminates the "different port each session" problem - agents always know port 9222 is where Chrome lives.

### A.2 — DONE 2026-05-13
docs/CHROME_AUTOMATION_INFOBAR.md created. Explains the infobar is Chrome-enforced and cannot be hidden in stable builds. Documents what users have tried (none work) and how to work around it (maximize, dedicated profile, accept it).

### A.3 — STUBBED 2026-05-13
extension/popup.js + background.js now have chrome.storage.local approval persistence wired in. When the extension graduates from v0.1.0 stub, the persistence is already in place. STORAGE_KEY = "cdp_mcp_approvals", schema: { originOrId: { approved: bool, timestamp: number } }.

Remaining work for full activation:
- Wire MCP bridge handshake to check_approval before allowing first request
- UI for "Approve this client" prompt on unknown originOrId
- Optional: expiry policy (auto-revoke after 30 days)

---

### E — SCAFFOLDED 2026-05-13
Scenario files for 6 sites + types + runner stub + shape-validation test (20 passing).
See `MCP Server/src/__tests__/agent-suite/README.md` for activation plan.
Live runs deferred: need CI MCP servers, credentials, CAPTCHA solver. The scaffold
locks the `Scenario` shape and documents each site's known failure modes so a
future activation session can plug in the executor without re-deriving requirements.

### E (original). Agent test suite expansion (tough websites)
**Goal:** Test each tool on hard websites in parallel; compare against Playwright MCP.

**Sites to cover:**
- LinkedIn Easy Apply (Ember.js + iframes + dynamic forms)
- Adobe careers (Phenom ATS — multi-step, hidden fields)
- Hirist 403 overlay
- Greenhouse with reCAPTCHA
- Workday with cross-origin iframes
- Google Forms with country-code phone inputs

**Test framework:**
- Each test = a URL + a sequence of (action, expected outcome)
- Run agent in parallel: 1 with Playwright MCP, 1 with our CDP MCP
- Measure: time, tool-call count, success/failure, output token total
- Output: comparison table per test

**Files:**
- `MCP Server/src/__tests__/agent-suite/` (new dir)
- `MCP Server/src/__tests__/agent-suite/runner.ts` — orchestrates parallel runs
- `MCP Server/src/__tests__/agent-suite/sites/*.test.ts` — one per site

---

### F. Sync everything to code_backup branch (with .temp, .research, .prompts) [DONE 2026-05-13]
**Goal:** Make code_backup truly a full backup including ignored dirs.

**Findings:**
- `code_backup` already includes `.temp/`, `.research/`, `.prompts/` from a previous sync (`c175aa5`): 13 .temp files, 11 .research files, 12 .prompts files.
- `code_backup` uses the SAME `.gitignore` as dev (no branch-specific gitignore). Those files were force-added; future ignored-dir changes must be force-added on every sync.
- Branch-specific gitignore via `.git/info/exclude` is local-only and would not survive clones, so we keep one shared `.gitignore` and rely on `git add -f` in the sync script.
- Per-branch GitHub privacy is not possible. If user wants a private code_backup, a separate private repo with a second remote is required (e.g. `git remote add backup git@github.com:user/cdp-private-backup.git`, push code_backup there).

**Implemented:**
- `scripts/sync-to-code-backup.ps1` (PowerShell) and `scripts/sync-to-code-backup.sh` (bash) - merge current branch into code_backup, force-add the 3 ignored dirs (only those that exist on disk), commit, push, return to original branch. Supports `-DryRun`/`--dry-run` and `-NoPush`/`--no-push`.
- Dev working tree was dirty at task time (v5.0.0-alpha.4 work in progress including new `.research/BACKLOG.md`, `SlimModeMetrics-v5alpha4.md`, `ToolParityGaps-v5alpha4.md` and several modified `MCP Server/src/` files). Dry-run verified the script works; actual sync deferred to final-test-commit so it picks up all alpha.4 changes in one merge.

**Status:** Script in place. Run `pwsh -File scripts/sync-to-code-backup.ps1` after the alpha.4 commit lands on dev to push the full snapshot to code_backup.

---

### I. Public template branch (anyone can fork)
**Goal:** A `template` branch from main with empty user data, ready for anyone to fork.

**Process:**
1. From main, create `template` branch
2. Empty `Applications/` (keep .gitkeep)
3. Replace `data/tracker-active.json` and `data/tracker-closed.json` with `{ "$schema": "..." }` skeletons
4. Replace `candidate/cv.md` with `cv.template.md` (sample structure)
5. Replace `candidate/article-digest.md` with `article-digest.template.md`
6. Replace `candidate/current-status.json` with `current-status.template.json` (placeholders)
7. Empty `candidate/current/` (keep .gitkeep)
8. Replace `config/profile.yml` with `profile.template.yml` (already have profile.example.yml in vendored career-ops — port it)
9. Update `README.md` with "How to fork this template" section
10. Add `template/SETUP.md` with first-run walkthrough

**One-time work:** ~2-3 hours

---

### J. Update copilot/changelog/version everywhere
**Goal:** Whenever we touch ANY file, also update the matching CHANGELOG/instructions.

**Already partially done** — each task in this session updates CHANGELOG. The wider goal:
- [x] Add a pre-commit hook that warns if a code change has no CHANGELOG entry — **INSTALLED 2026-05-13** in `.githooks/pre-commit`. Non-blocking. Same logic copied to JobApplications repo. Installer: `bash .githooks/install.sh` or `pwsh -File .githooks/install.ps1`. Disable: `git config --unset core.hooksPath`.
- Add a doc-maintainer skill invocation to ralph workflows
- Auto-bump version in package.json on every dev push

**Owner:** continuous; use doc-maintainer skill more aggressively
