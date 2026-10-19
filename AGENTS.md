# cdp-browser-mcp — AGENTS.md

**Branches:** main (public) · dev (working) · **Version:** 5.0.1
Contributor + agent guide for this repo — identical file on both branches.
Short on purpose — details live in
CONTRIBUTING.md (workflow), README.md (product), CHANGELOG.md (history).

## Overview

Chrome CDP-based MCP server. Connects to the user's **real running browser**
(auth, cookies, sessions, extensions preserved) over a CDP WebSocket
(`--remote-debugging-port=9222`). Modular TypeScript, two runtime deps only
(`ws`, `@modelcontextprotocol/sdk`).

## Structure

├── AGENTS.md                  # this file — identical on main and dev
├── README.md / CHANGELOG.md / CONTRIBUTING.md / LICENSE
├── extension/                 # MV3 scaffold (bridge lands v5.1) — ships on main, code only
├── MCP Server/
│   ├── src/index.ts           # entry (VERSION const here) → dist/index.js
│   ├── src/connection/        # CDP client, health monitor, browser discovery
│   ├── src/session/           # session manager, tab ownership, modal state
│   ├── src/snapshot/          # accessibility snapshots, element refs, token optimizer
│   ├── src/tools/             # 14 tools / 90+ actions (registry.ts wires all)
│   ├── src/utils/             # wait, retry, errors, response builder
│   ├── src/__tests__/         # unit + integration + benchmarks
│   └── server.js              # REMOVED in v5 alpha.4 (parked: _archive/legacy-server-v4.js, dev-only)
│
│   NOTE: `_archive/legacy-server-v4.js` stays on dev only — promote.yml
│   strips `_archive/` at merge time, so main's tree/registry never sees it.
├── .github/workflows/         # ci.yml, guard-main.yml, promote.yml, release.yml
└── .github/ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE  # contributor templates
```

Dev-only material (`_archive/`, `.research/`, hooks, agent scratch) lives on
the **dev branch only** — it is deleted at every promote and never on main.

## Where to look

| Task | Location |
|---|---|
| Add/change a tool | `MCP Server/src/tools/<name>.ts` + `registry.ts`, follow `base-tool.ts` (`defineTool`) |
| Change connection/reconnect | `MCP Server/src/connection/{cdp-client,health-monitor,browser-discovery}.ts` |
| Change snapshots/element refs | `MCP Server/src/snapshot/{accessibility,element-resolver,token-optimizer}.ts` |
| Change session/tab locking | `MCP Server/src/session/{session-manager,tab-ownership,modal-state}.ts` |
| Change config surface | `MCP Server/src/config.ts` (only env reader) + `src/types.ts` |
| Cut a release | Tag main (`v*`); release.yml builds + publishes. Never release from dev. |
| Promote dev → main | Actions → "Promote dev to main" (or root AGENTS.md manual flow) |

## Commands

```bash
cd "MCP Server"
pnpm build             # tsc → dist/
pnpm typecheck          # tsc --noEmit (run before every commit — zero errors)
pnpm lint               # alias of typecheck
pnpm test               # unit (vitest)
pnpm test:integration   # needs a real browser — local/dev only, not CI
pnpm benchmark          # needs CDP + Playwright — local/dev only
```

Package manager: **pnpm** (canonical). npm works for script invocation, but lockfile and CI are pnpm.

## Development rules

Always:
1. `npm run typecheck` green before commit.
2. Conventional commits: `feat:` `fix:` `refactor:` `docs:` `chore:`.
3. User-facing change → CHANGELOG.md entry.
4. New/changed tool → README.md tool listing + agent-friendly description.
5. Version bumps only via release flow (package.json + `VERSION` in `src/index.ts` together).

Never:
1. Don't run `_archive/legacy-server-v4.js` (frozen, reference only).
2. No global mutable state — everything through `ServerContext` DI.
3. No swallowed errors — `ActionableError` with fix suggestions.
4. No `any` without a justifying comment.
5. Never close user tabs — cleanup default is detach.
6. No heavy deps — `ws` + `@modelcontextprotocol/sdk` only.
7. Integration/benchmark tests never run in CI (need a live browser).

## Branch policy (main vs dev)

- **main** = public. Ships: product code, `extension/` code, docs, workflows,
  templates. Never ships: `_archive/`, `.research/`, agent instructions,
  hooks, scratch. `.gitignore` on main enforces this; `guard-main.yml`
  fails any push/PR that breaks it.
- **dev** = working branch. Tracks everything main has PLUS `_archive/`
  (dev-only plans/research/diagnosis), `.research/` (active analysis being
  written now; parked under `_archive/` when done), `.githooks/` (pre-commit
  guard + installer), and keeps its own `.gitignore` (no `_archive/`/
  `.research/`/`.githooks/` rules). Dev never cuts releases; CI runs
  typecheck + build + unit tests on every dev push.
- **`.gitignore` is branch-divergent by design.** main's copy is what ships.
  While working on dev, edit the shadow copy `.main.gitignore` (tracked on
  dev only) instead of `.gitignore` — at promote time it is copied over
  main's file (only when it changed) and the shadow copy itself is deleted,
  so it never lands on main. If dev adds a *shared* rule, it belongs in
  `.main.gitignore`. `guard-main.yml` fails if `.main.gitignore` reappears
  on main.
- **Promote flow (dev → main):** Actions → "Promote dev to main" workflow,
  or manually: `git merge --no-ff --no-commit origin/dev` →
  sync `.gitignore` from `.main.gitignore` when it changed →
  `git rm -r _archive .research .githooks .main.gitignore .github/AGENTS.md .github/copilot-instructions.md`
  → restore main's `.gitignore` → verify `git status` shows no strays →
  commit `Merge dev → main: <version>`. `.gitignore` alone never blocks a
  merge (it only affects untracked files) — deletion is explicit, policy
  second. New files added on dev since the last promote land silently on
  merge; the promote script and `git status` check catch them.
- **Reference duty:** files that ship to main (README, CONTRIBUTING,
  extension docs, changelogs) must not reference dev-only paths
  (`_archive/`, `.research/`, agent scratch). Point at the concept
  ("full design ships on dev") instead of the path.
- First promote after this reorg also carries dev's `docs/`, `scripts/`,
  `.gitattributes`, `.githooks/` (absent on main today) — curate in review;
  dev-internal scripts belong in the promote strip list.
- **`.github/AGENTS.md` retired:** agent guidance lives here (root),
  Copilot rules in `.github/copilot-instructions.md` were retired too —
  do not recreate either under `.github/`. `guard-main.yml` fails if
  they reappear.
