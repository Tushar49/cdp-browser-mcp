# Agent Test Suite

Scenarios for benchmarking CDP MCP vs Playwright MCP on tough real-world sites.

## What's here

- `scenarios/*.ts` — 6 scenario definitions (LinkedIn, Adobe, Hirist, Greenhouse, Workday, Google Forms)
- `runner.ts` — scaffold for actually running scenarios (currently throws — needs activation)
- `types.ts` — shared types (`Scenario`, `ScenarioStep`, `RunResult`)
- `index.ts` — aggregator (`allScenarios`)

The shape-validation test lives at `src/__tests__/unit/agent-suite-scenarios.test.ts` and runs as part of `npm test`.

## Status: SCAFFOLDED, NOT ACTIVATED

The scenarios are defined. Live runs need:

1. Network access (CI runner with internet)
2. Test credentials in env vars (`LINKEDIN_USER`, `WORKDAY_PASSWORD`, etc.)
3. CAPTCHA tokens (use 2captcha or similar) for the Greenhouse scenario
4. A Playwright MCP server alongside our CDP MCP server (for compare mode)

## The scenarios

| ID                    | Site                | What it stresses                                        |
| --------------------- | ------------------- | ------------------------------------------------------- |
| linkedin-easy-apply   | LinkedIn            | Ember.js click dispatch, `artdeco-modal` portals, opacity:0 inputs |
| adobe-phenom          | Adobe / Phenom ATS  | Hidden tracking fields, async-enabled buttons, custom dropzone |
| hirist-403-overlay    | Hirist.tech         | 403 overlay covering the a11y tree, JS dismissal       |
| greenhouse-recaptcha  | Greenhouse boards   | React comboboxes, reCAPTCHA v2 token injection         |
| workday-iframes       | Workday tenants     | Cross-origin iframes, per-tenant auth, aria-busy waits |
| google-forms-phone    | Google Forms        | Country-code combobox, /u/1/ vs /u/0/ account check    |

Each file documents the known failure modes from real production usage so the runner (and any agent reading the file) knows what to look out for.

## To activate

1. Stand up both MCP servers in CI (Docker compose)
2. Implement `runScenario()` and `compareScenario()` in `runner.ts`
3. Add a vitest config for integration tests (slow, network-bound)
4. Add `npm run test:agent-suite` script
5. Schedule weekly via GitHub Actions

## Why scaffold-only this session

Full activation is multi-session work. The scaffold lets us:

- Define WHAT we want to test (the scenarios)
- Lock the shape so additions are consistent (`Scenario` interface + shape test)
- Keep the test-shape regression test green (validates scenario format on every `npm test`)
- Hand off to a focused session later

See `_archive/research/BACKLOG.md` entry **E** for the activation plan.
