# CDP Browser MCP Server — Development Instructions

## Project Overview
This is a Chrome DevTools Protocol (CDP) based MCP server that connects to the user's real running browser. It's the only browser MCP that preserves auth, cookies, sessions, and extensions.

**Version:** 5.0.0-alpha.3
**Architecture:** TypeScript, modular (38 files in src/)
**Entry point:** `MCP Server/dist/index.js` (built from `MCP Server/src/index.ts`)
**Legacy fallback:** removed on dev (frozen v4 monolith parked at `_archive/legacy-server-v4.js`, reference only)

## Build & Test Commands
```bash
cd "MCP Server"
npm run build        # TypeScript compile (tsc)
npm run typecheck    # Type-check without emitting (tsc --noEmit)
npm run start        # Start new v5 server
npm run test         # Run vitest tests
npm run lint         # Typecheck (tsc --noEmit)
```

## Development Rules

### Always
1. Run `npm run typecheck` before committing — zero errors tolerance
2. Update CHANGELOG.md for any user-facing change
3. Use conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`
4. Update version in package.json for releases
5. Keep tool descriptions agent-friendly (they're the only docs agents see)
6. Update README.md when adding/changing tools
7. Add `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` to commits

### Never
1. Don't run `_archive/legacy-server-v4.js` (frozen v4, reference only)
2. Don't add global mutable state — use ServerContext DI
3. Don't swallow errors — use ActionableError with fix suggestions
4. Don't use `any` without a comment explaining why
5. Don't close user's browser tabs — default cleanup is "detach"
6. Don't add heavy dependencies — we have only 2 (ws, @modelcontextprotocol/sdk)

### Architecture
- All state flows through `ServerContext` (dependency injection)
- Tools are registered via `ToolRegistry.register(defineTool(...))`
- Each tool file exports `register*Tools(registry, ctx)` 
- CDP commands go through `ctx.cdpClient.send(method, params, sessionId)`
- Session management via `ctx.sessions` (SessionManager)
- Tab ownership via `ctx.tabOwnership` (TabOwnership)
- Element refs via `ctx.elementResolvers` (per-tab ElementResolver Map)
- Errors via `Errors.*` factories from `utils/error-handler.ts`

### Tool Design Principles
1. **Self-documenting** — tool description tells agents everything they need
2. **Auto-connect** — never require agents to call browser.connect first
3. **Actionable errors** — every error includes a "How to fix" section
4. **Single-call operations** — prefer one tool call over multi-step sequences
5. **Token-efficient** — keep responses under 20KB when possible
6. **Framework-agnostic** — handle React, Angular, Ember, vanilla DOM

### Key Files
| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point, MCP server setup, auto-connect |
| `src/types.ts` | All TypeScript interfaces |
| `src/config.ts` | Environment variable config |
| `src/tools/dispatch.ts` | Session routing, tab claiming, modal checks |
| `src/tools/form.ts` | Smart form filling engine |
| `src/tools/slim-mode.ts` | Slim mode — 6 Playwright-compatible tools for 32K models |
| `src/connection/cdp-client.ts` | CDP WebSocket client |
| `src/connection/health-monitor.ts` | Auto-reconnect |
| `src/utils/error-handler.ts` | 17 actionable error types |

### Slim Mode (`CDP_SLIM_MODE=true`)
- Exposes 6 tools: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_fill_form`, `browser_tabs`
- Schema size: ~1.5KB vs ~8KB for full tool set
- Tool names are Playwright-compatible for zero-learning-curve adoption
- `getSlimTools()` returns tool definitions; `mapSlimToFull()` maps slim→full tool calls

### Form Filling — Country Code & Location
- `type: 'country-code'` normalizes `+91` → "91", `IN` → "India", then uses combobox handler
- `type: 'location'` types slowly (100ms/char), waits 2s for API suggestions, selects first match
- Both use `fillCountryCode()` and `fillLocation()` in `src/tools/form.ts`

## Testing
- Unit tests: `src/__tests__/unit/` — test pure logic, no CDP
- Integration tests: `src/__tests__/integration/` — test with real/mock browser
- Benchmarks: `src/__tests__/benchmarks/` — speed comparison vs Playwright
- Run all: `npm run test`
- Add tests for any new module

## Release Process
1. Update version in `package.json`
2. Update `CHANGELOG.md` with new version section
3. Update README.md badges
4. Run full test suite: `npm run test`
5. Build: `npm run build`
6. Tag: `git tag v{version}`
7. Push: `git push && git push --tags`

## Issue Triage
- P0: Ship blocker — fix immediately
- P1: Significant bug — fix in current sprint
- P2: Improvement — schedule for next release
- P3: Nice-to-have — backlog
