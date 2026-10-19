# Contributing to CDP Browser MCP Server

## Quick Start

```bash
cd "MCP Server"
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## Development Workflow

1. Fork the repo
2. Create a branch: `git checkout -b feat/my-feature`
3. Make changes in `src/`
4. Run `npm run typecheck` (must pass)
5. Run `npm run test` (must pass)
6. Update docs if needed (README, CHANGELOG, tool descriptions)
7. Commit with conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`
8. Push and open a PR

## Architecture

See `AGENTS.md` (repo root) for the full contributor and agent guide.

Key principles:
- **DI via ServerContext** — no global mutable state
- **TypeScript strict mode** — no `any` without justification
- **Actionable errors** — every error tells the user how to fix it
- **Agent-friendly** — tool descriptions are the documentation
- **Minimal dependencies** — only `ws` and `@modelcontextprotocol/sdk`

## Adding a New Tool

1. Create `src/tools/my-tool.ts`
2. Use `defineTool()` from `./base-tool.js`
3. Export `registerMyToolTools(registry, ctx)`
4. Import and call in `src/index.ts`
5. Update README.md tool listing
6. Update CHANGELOG.md

## Running Tests

```bash
pnpm test                 # Unit tests
pnpm test:integration     # Integration tests (needs browser)
pnpm benchmark            # Speed benchmarks (needs CDP + Playwright)
```

## Code Style
- TypeScript strict mode
- No `any` without comment explaining why
- Actionable errors via `Errors.*` factories
- Tool descriptions include agent guidance
