# Competitors & reference checkouts

Brief of every project we compare against or borrow from, plus the
checkout procedure. Pair with the parity audit:
`_archive/research/October2026/2026-10-28-v5.3-parity-audit.md`.

## Checkout procedure

- The maintainer keeps shallow clones of the reference repos on disk
  (location chosen per cycle — **ask where they live or where to
  clone; never hardcode a path in docs or code**).
- Refresh with plain `git pull` (shallow clones pull fine).
- If a pull/clone fails on repository ownership (safe.directory):
  **delete the folder and re-clone — do NOT add the directory to
  global git config.** Changing global git config requires the
  maintainer's explicit say-so (AGENTS.md).
- Repos cloned for the 5.3 cycle (2026-10-28): microsoft/playwright,
  microsoft/playwright-mcp, ChromeDevTools/chrome-devtools-mcp,
  ChromeDevTools/devtools-protocol, puppeteer/puppeteer.

## The set

### Playwright MCP (`@playwright/mcp`) — microsoft/playwright-mcp
The main competitor. v0.0.83 (Sep 2026), ~5.5M weekly downloads.
Snapshot + ref-based interaction model; `browser_find` (grep the
snapshot); `verify_*` assertion tools (caps=testing); codegen
recording; network routes (URLPattern); storage state; **real-browser
attach via extension mode + `browser.bind()` — our "attach-only" moat
is eroding**. What we borrow: verify-style checks, hardening patterns
(origin fencing, secrets handling). What we don't: codegen,
Playwright-code execution, launch-based flows.

### chrome-devtools-mcp — ChromeDevTools/chrome-devtools-mcp
Google's flagship agent surface (built on Puppeteer; ~70 tools,
v1.12.0 Oct 2026). Flagship: performance trace → structured insights;
plus Lighthouse audit (bundled engine, in-process on the same page —
deferred for us purely on the dependency cost), heap-snapshot analysis
(14 tools, 13 of them offline-capable),
extensions hot-reload, PWA install/launch, WebMCP list/execute, CSS
inspection, source-mapped console stacks. What we borrow: the WebMCP
shape, perf-trace direction (5.4). What we don't: Lighthouse (heavy
bundled dep), anything needing Puppeteer.

### Playwright (library) — microsoft/playwright
Reference for capability shapes: `expect` assertions, `routeFromHAR`
(record→replay), storage state incl. CHIPS `partitionKey` (since 1.54),
screencast with action annotations, WebMCP page API access (1.64).
Also hosts `@playwright/cli` (CLI+skills sibling for coding agents).

### devtools-protocol — ChromeDevTools/devtools-protocol
The protocol source of truth (`browser_protocol.json`/`js_protocol.json`).
Check here FIRST when a plan names a method/event: exact names, params,
experimental flags. 5.3 verification used HEAD ebca906 (2026-10-27).

### Puppeteer — puppeteer/puppeteer
No official MCP (both community MCPs deprecated mid-2025; the de-facto
one IS chrome-devtools-mcp). BiDi/Firefox support is out of our scope
by design. Reference only for protocol-behavior comparisons.

## The npm name-collision — `cdp-browser-mcp` (unrelated project!)

npm package `cdp-browser-mcp` (v0.2.0, Oct 2026, maintainer
`small-star-wei`) is a DIFFERENT, independent project (internally
"browser-devtools-mcp"): inspection-first (console/network/DOM/
performance/screenshot), live event stream, one-shot capture archive;
launches throwaway-profile browsers; Chrome+Edge ONLY ("Brave /
Opera / Chromium: not supported" — unverified, and Vivaldi's flatten
problem is documented). NOT derived from our code.

**The confusion vector:** their npm name matches OUR GitHub repo name
exactly (`Tushar49/cdp-browser-mcp`); our npm is `cdp-mcp-server`.
Anyone npm-searching `cdp-browser-mcp` finds them. Options (decide at
a release, not mid-cycle):
(a) leave it — different products, different niches;
(b) dual-publish ours under both names at each release (same dist, two
    packages — small sync cost, kills the confusion);
(c) rename our npm package to `cdp-browser-mcp` (breaking for existing
    installs; needs a deprecation alias on `cdp-mcp-server`).
Their live-event-stream design (subscribe → cursor long-poll/push) and
one-shot archive are genuinely interesting patterns — possible 5.4+
candidates.

## One-liner also-rans (no clones)

- **BrowserTools MCP** (v2.0.4): read-mostly via a DevTools-panel
  extension; 4 Lighthouse audits in a separate browser; MCP-resources
  pattern for big payloads. History: CVSS 9.8 RCE fixed in the 2.x
  security rewrite — our hardening riders cite it.
- **Browserbase MCP**: cloud sessions, Stagehand NL-primitives,
  session replay. Different market (hosted).
- **AgentQL MCP**: single NL-extraction tool. Not a platform.
