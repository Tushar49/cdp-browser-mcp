# CDP Browser MCP Server — Complete Restructure Plan

> **Version:** 5.0.0 (target)
> **Current:** v4.13.0 — single-file monolith (`server.js`, 254KB, 4,867 lines)
> **Author:** Tushar Agarwal
> **Date:** July 2025
> **Status:** PLAN — Not yet implemented

---

## Table of Contents

1. [Vision & Positioning](#1-vision--positioning)
2. [Architecture Redesign](#2-architecture-redesign)
3. [Critical Fixes — Phase 1 (Week 1–2)](#3-critical-fixes--phase-1-week-12)
4. [Architecture Migration — Phase 2 (Week 3–4)](#4-architecture-migration--phase-2-week-34)
5. [New Features — Phase 3 (Week 5–8)](#5-new-features--phase-3-week-58)
6. [Performance Optimization — Phase 4 (Week 9–10)](#6-performance-optimization--phase-4-week-910)
7. [Testing Plan](#7-testing-plan)
8. [Migration Path](#8-migration-path)
9. [Risk Assessment](#9-risk-assessment)

---

## 1. Vision & Positioning

### What This Server Should Become

**The power user's browser MCP** — the only server that connects to your REAL browser (with your auth, cookies, profiles, extensions) while being as reliable and easy-to-use as Playwright MCP.

### The Unique Value Proposition

Every other browser MCP falls into one of two camps:

| Camp | Example | Limitation |
|------|---------|------------|
| **Fresh browser** | Playwright MCP, Puppeteer MCP | No cookies, no sessions, no extensions. Useless for real workflows. |
| **Existing browser** | mcp-chrome, Playwriter | Requires Chrome extension install. Limited API surface. |

**CDP Browser MCP Server is the only one that**:
1. Connects to the user's **already-running** Chrome/Edge/Brave — with all auth, cookies, profiles, extensions intact
2. Requires **zero extension installs** — just enable a Chrome flag
3. Provides **87+ automation actions** across 11 tools — the most comprehensive tool surface of any browser MCP
4. Offers **DevTools-level capabilities** no competitor has: JS debugger, request interception, resource overrides, DOM breakpoints, cookie CRUD, network throttling, HAR export
5. Starts **instantly** — WebSocket connect in milliseconds, no browser launch, no binary download
6. Has **2 dependencies** (`ws` + MCP SDK) — the smallest footprint in the ecosystem

### Target Users

1. **AI coding agents** (Copilot, Claude, Cursor) that need to interact with authenticated web apps
2. **Power users** who want full browser control without re-authenticating everywhere
3. **Enterprise teams** testing internal apps behind SSO (D365, SharePoint, Azure Portal)
4. **Job seekers** automating applications across Greenhouse, Lever, Workday, LinkedIn

### North Star Metrics

- **Zero-config startup**: Agent connects and works without any `browser.connect()` call
- **Single-call form filling**: Any form field (combobox, date picker, React select) works in ONE tool call
- **< 3s snapshot time**: Even for complex pages (Gmail, D365, LinkedIn)
- **< 5 stale ref errors per 100 interactions**: Stable element references
- **0 "tabs disappeared" incidents**: Tabs NEVER auto-close unless explicitly requested

### Competitive Positioning

```
                     SIMPLE                                    POWERFUL
                       │                                          │
   Browserbase ────────┤                                          │
   (6 tools, NL)       │                                          │
                       │     Playwright MCP ──────────────────────┤
                       │     (22 tools, a11y)                     │
                       │                                          │
                       │          Chrome DevTools MCP ────────────┤
                       │          (27 tools, perf)                │
                       │                                          │
                       │               CDP Browser MCP ───────────┤
                       │               (50+ tools, existing browser, DevTools)
                       │                                          │
   FRESH BROWSER ──────┼──────────────────────────────── EXISTING BROWSER
```

We are in the **top-right quadrant**: most powerful AND uses existing browser. Our challenge is making that power **accessible** — as easy to use as Playwright MCP.

---

## 2. Architecture Redesign

### Current State: The Problem

```
MCP Server/
├── server.js          ← 254,325 bytes, 4,867 lines, EVERYTHING in one file
└── package.json       ← 2 dependencies (ws, @modelcontextprotocol/sdk)
```

**Global mutable state**: 25+ `Map`/`Set` objects at module level. No encapsulation, no lifecycle management, impossible to test in isolation.

### Target Architecture

```
src/
├── index.ts                      # Entry point — MCP server setup, transport init
├── config.ts                     # All env vars, defaults, validation
├── types.ts                      # TypeScript interfaces & type definitions
│
├── connection/
│   ├── browser-discovery.ts      # Auto-detect Chrome/Edge/Brave via DevToolsActivePort
│   ├── cdp-client.ts             # CDP WebSocket client, message routing, callbacks
│   ├── cdp-session.ts            # Per-tab CDP session with domain enable/disable
│   ├── health-monitor.ts         # Ping/pong health checks, auto-reconnect
│   └── profile-manager.ts        # Profile-aware connections, instance switching
│
├── tools/
│   ├── registry.ts               # Tool registration system, schema generation
│   ├── base-tool.ts              # Base class/interface for all tools
│   ├── tabs.ts                   # Tab lifecycle (list, find, new, close, activate, info)
│   ├── page.ts                   # Navigation, snapshot, screenshot, content, wait, PDF, dialog
│   ├── interact.ts               # Click, hover, type, fill, select, press, drag, scroll, upload, focus, check, tap
│   ├── form.ts                   # Smart form filling engine (NEW — handles all field types)
│   ├── execute.ts                # JS eval, script, call-on-element
│   ├── observe.ts                # Console, network, request body, performance, downloads, HAR
│   ├── emulate.ts                # Viewport, color scheme, UA, geo, CPU, timezone, locale, network, SSL
│   ├── storage.ts                # Cookies, localStorage, indexedDB, cache, quota
│   ├── intercept.ts              # HTTP request interception via Fetch domain
│   ├── debug.ts                  # JS debugger, breakpoints, stepping, resource overrides, DOM/event breakpoints
│   ├── browser.ts                # Browser/profile management, instance switching
│   └── cleanup.ts                # Disconnect, temp file cleanup, session end, reset
│
├── session/
│   ├── session-manager.ts        # Agent session creation, lookup, TTL management
│   ├── tab-ownership.ts          # Tab locking (exclusive/shared), cleanup strategies
│   └── state-store.ts            # Global state maps (consoleLogs, networkReqs, etc.)
│
├── snapshot/
│   ├── accessibility.ts          # A11y tree capture via CDP Accessibility domain
│   ├── element-resolver.ts       # Stable element refs via backendNodeId → DOM.resolveNode
│   ├── incremental.ts            # Differential snapshots (before/after diffs)
│   └── token-optimizer.ts        # Reduce snapshot size: depth limits, role filtering, truncation
│
├── utils/
│   ├── wait.ts                   # Smart waiting: navigation, selector, text, networkidle
│   ├── retry.ts                  # Auto-retry with exponential backoff for stale elements
│   ├── temp-files.ts             # Temp file management with session-aware cleanup
│   ├── error-handler.ts          # Actionable error messages with fix suggestions
│   └── response-builder.ts       # Structured response formatting (markdown sections)
│
└── __tests__/
    ├── unit/
    │   ├── config.test.ts
    │   ├── cdp-client.test.ts
    │   ├── session-manager.test.ts
    │   ├── element-resolver.test.ts
    │   ├── token-optimizer.test.ts
    │   └── ...
    ├── integration/
    │   ├── tabs.test.ts
    │   ├── navigation.test.ts
    │   ├── form-filling.test.ts
    │   ├── interact.test.ts
    │   └── ...
    └── fixtures/
        ├── test-pages/            # Local HTML pages for testing
        └── snapshots/             # Expected snapshot outputs
```

### Key Architectural Decisions

#### 1. TypeScript Migration

**Why**: Type safety catches entire classes of bugs at compile time. The current server has subtle bugs from `undefined` values flowing through Maps. TypeScript also provides better IDE support and self-documentation.

**How**: Incremental migration. Start with `types.ts` and new modules. Convert existing code module-by-module.

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "node16",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
```

#### 2. Dependency Injection via Context Object

Replace 25+ global Maps with a single `ServerContext` object passed to all tools:

```typescript
interface ServerContext {
  config: ServerConfig;
  connection: CDPConnection;
  sessions: SessionManager;
  tabs: TabOwnership;
  state: StateStore;        // consoleLogs, networkReqs, refMaps, etc.
  health: HealthMonitor;
}

// Tool handler signature
type ToolHandler = (ctx: ServerContext, params: Record<string, unknown>) => Promise<ToolResult>;
```

**Why**: Testability (mock any dependency), encapsulation (no global leaks), lifecycle management (single place to clean up).

#### 3. Tool Registration System

```typescript
// tools/registry.ts
interface ToolDefinition {
  name: string;
  description: string;         // Self-documenting for LLMs
  inputSchema: JSONSchema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  handler: ToolHandler;
}

class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void { ... }
  list(): ToolDefinition[] { ... }
  dispatch(name: string, args: unknown): Promise<ToolResult> { ... }
}
```

#### 4. Event-Driven CDP Client

Replace raw WebSocket message handling with typed event emitter:

```typescript
class CDPClient extends EventEmitter {
  async send(method: string, params?: object, sessionId?: string): Promise<unknown>;
  on(event: 'Target.targetCreated', handler: (params: TargetCreatedParams) => void): this;
  on(event: 'Network.requestWillBeSent', handler: (params: RequestParams) => void): this;
  // ... typed for every CDP event we use
}
```

#### 5. Auto-Connect on First Tool Call

```typescript
// index.ts — in tool dispatch
async function handleToolCall(name: string, args: unknown): Promise<ToolResult> {
  // Auto-connect if not connected — transparent to the agent
  if (!ctx.connection.isConnected()) {
    await ctx.connection.autoConnect();  // Discovers browser, connects, no user action needed
  }
  return registry.dispatch(name, args);
}
```

---

## 3. Critical Fixes — Phase 1 (Week 1–2)

These are the top 10 user-identified issues that block core workflows. Fix them FIRST, even before the full architecture migration.

### Fix 1: Auto-Connect on Startup

**Problem**: Agents start fresh and immediately try `tabs.new()` without connecting. Server fails silently or returns "no target found". No tool says "you need to connect first".

**Solution**: Auto-connect on the first tool call. Discover the browser automatically using `DevToolsActivePort` file scanning (already implemented in `discoverChromeInstances()`).

```typescript
// Before EVERY tool call:
async function ensureConnected(ctx: ServerContext): Promise<void> {
  if (ctx.connection.isConnected()) return;

  // Try auto-connect: scan DevToolsActivePort files
  const instances = discoverChromeInstances();
  if (instances.length === 0) {
    throw new ActionableError(
      'No browser found with remote debugging enabled.',
      'Enable remote debugging: chrome://flags → #enable-remote-debugging → Enabled → Relaunch Chrome'
    );
  }

  // Prefer CDP_PROFILE env var match, then Chrome, then Edge, then Brave
  const target = instances.find(i => i.name === process.env.CDP_PROFILE)
    || instances.find(i => i.name === 'Chrome')
    || instances[0];

  await ctx.connection.connect(target.wsUrl);
}
```

**Files to change**: `connection/cdp-client.ts`, `index.ts`
**Tests**: Unit test for auto-discovery, integration test for first-call auto-connect

---

### Fix 2: Default `cleanupStrategy` to "detach"

**Problem**: Default `cleanupStrategy: "close"` kills ALL tabs when agent session ends. Users lose 35+ tabs of important work.

**Solution**: Change default from `"close"` to `"detach"`. Tabs stay open when session expires. Add a `CDP_CLEANUP_STRATEGY` env var for override.

```typescript
// config.ts
const DEFAULT_CLEANUP_STRATEGY = process.env.CDP_CLEANUP_STRATEGY || 'detach';  // was 'close'
```

**Also**: Add clear warning in tool descriptions:
```
cleanupStrategy: Tab cleanup when session expires.
  "detach" (default) — tabs stay open after session ends
  "close" — tabs are closed when session expires (USE WITH CAUTION)
  "none" — no cleanup at all
```

**Files to change**: `config.ts`, all tool schemas that reference cleanupStrategy
**Tests**: Verify tabs persist after session TTL expiry with default config

---

### Fix 3: Fix Fresh Tab `about:blank` Issue

**Problem**: `tabs.new({ url: "https://..." })` frequently opens `about:blank`. Auth cookies don't propagate to new tabs properly.

**Root Cause**: CDP `Target.createTarget` creates a new tab, but navigation happens before the tab's CDP session is fully attached. The `goto` races against session setup.

**Solution**: Two-phase tab creation with explicit wait:

```typescript
async function createTab(url: string, ctx: ServerContext): Promise<TabInfo> {
  // 1. Create tab without URL (avoids race condition)
  const { targetId } = await ctx.connection.send('Target.createTarget', {
    url: 'about:blank',
    newWindow: false,
    // If profile specified, use browserContextId
  });

  // 2. Attach to the new tab's CDP session
  const session = await ctx.connection.attachToTarget(targetId);

  // 3. Enable required domains FIRST
  await session.enableDomains(['Page', 'Runtime', 'Network', 'DOM']);

  // 4. NOW navigate — session is ready, cookies will propagate
  await session.send('Page.navigate', { url });

  // 5. Wait for load with smart timeout
  await waitForNavigation(session, { timeout: ctx.config.timeout });

  return { targetId, session, url };
}
```

**Files to change**: `tools/tabs.ts`
**Tests**: Integration test creating 10 tabs with authenticated URLs, verify none land on `about:blank`

---

### Fix 4: Stable Element Refs

**Problem**: Between taking a snapshot and clicking an element, refs change. "Element ref=284 not found" happens constantly. Agents fall back to JavaScript DOM queries.

**Current Implementation**: Uses `backendNodeId` (Chrome's internal DOM ID) which IS stable across snapshots. The issue is the `refMap` (uid → backendNodeId) gets cleared/rebuilt on every new snapshot, invalidating previously-seen uids.

**Solution**: Persist refMaps across snapshots within the same page:

```typescript
class ElementResolver {
  // Cumulative map — never cleared, only grows. Cleared on navigation.
  private globalRefMap = new Map<number, number>();  // uid → backendNodeId
  private nextUid = 1;

  // On new snapshot: assign uids to new backendNodeIds, reuse existing uids for known nodes
  assignRefs(nodes: AXNode[]): void {
    const backendIdToUid = new Map<number, number>();
    // Build reverse lookup from existing refs
    for (const [uid, bid] of this.globalRefMap) {
      backendIdToUid.set(bid, uid);
    }

    for (const node of nodes) {
      if (backendIdToUid.has(node.backendNodeId)) {
        node.uid = backendIdToUid.get(node.backendNodeId)!;  // Reuse existing uid
      } else {
        node.uid = this.nextUid++;                           // New uid
        this.globalRefMap.set(node.uid, node.backendNodeId);
        backendIdToUid.set(node.backendNodeId, node.uid);
      }
    }
  }

  // On page navigation — reset everything
  onNavigation(): void {
    this.globalRefMap.clear();
    this.nextUid = 1;
  }
}
```

**Key insight**: The `backendNodeId` from CDP's Accessibility domain IS stable. The problem is our uid assignment layer. By mapping backendNodeId → uid consistently, refs survive across multiple snapshot calls on the same page.

**Files to change**: `snapshot/element-resolver.ts`
**Tests**: Take snapshot, modify DOM, take new snapshot — verify same elements get same uids

---

### Fix 5: Smart Form Filling for React Comboboxes

**Problem**: Greenhouse, Lever, and LinkedIn use React comboboxes. `fill()` types text but dropdown doesn't select. Currently requires 5 tool calls for ONE dropdown: type → wait → snapshot → find option → click option.

**Solution**: New `form.smartFill()` action that handles all field types:

```typescript
async function smartFillCombobox(session: CDPSession, uid: number, value: string): Promise<void> {
  const node = await resolveElement(session, uid);

  // 1. Focus the combobox
  await session.send('DOM.focus', { backendNodeId: node.backendNodeId });

  // 2. Clear existing value
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers: 2 }); // Ctrl+A
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace' });

  // 3. Type the value character by character (triggers React's onChange)
  for (const char of value) {
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: char });
    await session.send('Input.dispatchKeyEvent', { type: 'char', text: char });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: char });
    await sleep(50); // Allow React to process each keystroke
  }

  // 4. Wait for dropdown options to appear (poll accessibility tree)
  const options = await waitForOptions(session, value, { timeout: 3000 });

  // 5. Find best match and click it
  if (options.length > 0) {
    const bestMatch = findBestMatch(options, value);
    await clickElement(session, bestMatch.backendNodeId);
  }
}
```

**Also add `interact.fill` action `fields` parameter for batch form filling**:

```typescript
// New: fill multiple fields in one call
{
  action: "fill",
  tabId: "...",
  fields: [
    { uid: 5, value: "John Doe", type: "text" },
    { uid: 8, value: "Bachelor's Degree", type: "combobox" },
    { uid: 12, value: "true", type: "checkbox" },
    { uid: 15, value: "2025-01-15", type: "date" }
  ]
}
```

**Files to change**: `tools/form.ts` (new), `tools/interact.ts` (add `fields` param)
**Tests**: Test against local HTML pages with React-style comboboxes, native `<select>`, checkboxes, date inputs

---

### Fix 6: Increase Default Timeout for SPAs

**Problem**: D365, SharePoint, enterprise apps take 60–90+ seconds to load. `CDP_TIMEOUT` of 30s causes constant failures. Multiple retry loops burn agent context.

**Solution**: Tiered timeout system:

```typescript
// config.ts
const config = {
  actionTimeout: parseInt(process.env.CDP_ACTION_TIMEOUT) || 10_000,      // Click, type, etc.
  navigationTimeout: parseInt(process.env.CDP_NAVIGATION_TIMEOUT) || 60_000, // Page.navigate
  snapshotTimeout: parseInt(process.env.CDP_SNAPSHOT_TIMEOUT) || 15_000,    // A11y tree capture
  globalTimeout: parseInt(process.env.CDP_TIMEOUT) || 60_000,              // Fallback (was 30000)
};
```

**Also**: The `page.goto` action should accept a `timeout` parameter to override per-call:

```typescript
// page.goto with custom timeout
{ action: "goto", tabId: "...", url: "https://d365.example.com", timeout: 120000 }
```

**Files to change**: `config.ts`, `tools/page.ts`
**Tests**: Verify navigation to slow page works with 60s default

---

### Fix 7: Reduce Snapshot Size with Token Optimization

**Problem**: Gmail, D365, LinkedIn snapshots are 30–40KB. Agents can't process them. Snapshots get saved to temp files, requiring extra grep round-trips.

**Solution**: Multi-strategy token optimization:

```typescript
class TokenOptimizer {
  // Strategy 1: Depth limiting — only expand nodes up to N levels deep
  static limitDepth(tree: AXNode, maxDepth: number = 5): AXNode { ... }

  // Strategy 2: Role filtering — skip decorative/structural roles
  static filterRoles(tree: AXNode): AXNode {
    const SKIP_ROLES = new Set([
      'generic', 'none', 'presentation', 'separator',
      'LineBreak', 'InlineTextBox', 'StaticText'  // Merge into parent
    ]);
    return filterTree(tree, node => !SKIP_ROLES.has(node.role));
  }

  // Strategy 3: Text truncation — cap long text content at 100 chars
  static truncateText(tree: AXNode, maxLen: number = 100): AXNode { ... }

  // Strategy 4: Collapse empty containers
  static collapseEmpty(tree: AXNode): AXNode {
    // Remove nodes with no name, no children, and a generic role
    return filterTree(tree, node => node.name || node.children?.length || isInteractive(node));
  }

  // Combined pipeline
  static optimize(tree: AXNode, budget: number = 20_000): string {
    let result = tree;
    result = this.filterRoles(result);
    result = this.collapseEmpty(result);
    result = this.truncateText(result);

    const serialized = serialize(result);
    if (serialized.length > budget) {
      result = this.limitDepth(result, 4);
    }
    return serialize(result);
  }
}
```

**Target**: Reduce average snapshot from 34KB to < 15KB without losing interactive elements.

**Files to change**: `snapshot/token-optimizer.ts` (new)
**Tests**: Optimize snapshots of Gmail, LinkedIn, D365 pages — verify all interactive elements are preserved

---

### Fix 8: Auto-Reconnect on Browser Disconnect

**Problem**: When browser restarts or debugging port changes, server silently fails. No reconnection attempt, no health check warning.

**Solution**: Auto-reconnect with exponential backoff:

```typescript
class HealthMonitor {
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  async onDisconnect(): Promise<void> {
    // Clear all state (already done)
    this.clearState();

    // Try to reconnect with backoff
    while (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 10000);
      await sleep(delay);

      try {
        await this.connection.autoConnect();
        this.reconnectAttempts = 0;
        return;
      } catch {
        // Will retry
      }
    }

    // After max attempts, give up but provide clear error
    this.status = 'disconnected';
  }
}
```

**Also**: Return connection status in tool error messages:

```
Error: Browser is disconnected. Attempted 5 reconnections, all failed.
Fix: Ensure Chrome is running with remote debugging enabled.
  chrome://flags → #enable-remote-debugging → Enabled → Relaunch Chrome
Status: Last connected 2 minutes ago. Browser may have been closed or restarted.
```

**Files to change**: `connection/health-monitor.ts`, `utils/error-handler.ts`
**Tests**: Simulate WebSocket close, verify auto-reconnect within 5 seconds

---

### Fix 9: Clear Actionable Error Messages

**Problem**: Errors like "No target found", "Session not found", "Cannot read properties of undefined" give agents no clue what to do.

**Solution**: Error wrapping with fix suggestions:

```typescript
class ActionableError extends Error {
  constructor(
    message: string,
    public readonly fix: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
  }

  toToolResult(): ToolResult {
    return {
      content: [{
        type: 'text',
        text: [
          `### Error`,
          this.message,
          ``,
          `### How to fix`,
          this.fix,
          this.context ? `\n### Context\n${JSON.stringify(this.context, null, 2)}` : ''
        ].join('\n')
      }],
      isError: true
    };
  }
}

// Error catalog
const ERRORS = {
  NO_BROWSER: (port: number) => new ActionableError(
    `Cannot connect to browser on port ${port}.`,
    `Enable remote debugging:\n  Chrome: chrome://flags → #enable-remote-debugging → Enabled → Relaunch\n  Edge: edge://flags → same setting\n  Brave: brave://flags → same setting`
  ),

  STALE_REF: (uid: number) => new ActionableError(
    `Element uid=${uid} not found — the page may have changed since the last snapshot.`,
    `Take a fresh snapshot with page.snapshot(), then use the new uid from the snapshot.`
  ),

  TAB_NOT_FOUND: (tabId: string) => new ActionableError(
    `Tab "${tabId}" not found. It may have been closed or its session expired.`,
    `Use tabs.list({ showAll: true }) to see all available tabs, then use the correct tabId.`
  ),

  SESSION_EXPIRED: (ttl: number) => new ActionableError(
    `Session expired after ${ttl / 1000}s of inactivity.`,
    `Sessions auto-renew on every tool call. If you need longer TTL, set CDP_SESSION_TTL env var (default: 300000ms = 5 min).`
  ),

  NAVIGATION_TIMEOUT: (url: string, timeout: number) => new ActionableError(
    `Navigation to "${url}" timed out after ${timeout / 1000}s.`,
    `The page may still be loading. Try:\n  1. page.wait({ timeout: 10000 }) then page.snapshot()\n  2. Increase timeout: page.goto({ url, timeout: 120000 })\n  3. Use waitUntil: "domcontentloaded" for faster (partial) load`
  ),

  COMBOBOX_FAILED: (value: string) => new ActionableError(
    `Could not select "${value}" from dropdown. No matching option found.`,
    `Try:\n  1. Type the value first: interact.type({ uid, text: "${value}" })\n  2. Wait for dropdown: page.wait({ timeout: 2000 })\n  3. Take snapshot to see options: page.snapshot()\n  4. Click the matching option by its uid`
  ),
};
```

**Files to change**: `utils/error-handler.ts` (new), wrap all existing error throws
**Tests**: Trigger each error scenario, verify fix text appears in response

---

### Fix 10: Console Error Filtering

**Problem**: Every tool response includes `### Console Errors` with Chrome extension errors (e.g., "TypeError: Failed to set innerHTML" from a Chrome extension). This adds noise and wastes context tokens.

**Solution**: Filter out extension-originating console errors by default:

```typescript
function filterConsoleErrors(logs: ConsoleLog[]): ConsoleLog[] {
  const EXTENSION_PATTERNS = [
    /chrome-extension:\/\//,
    /moz-extension:\/\//,
    /^Uncaught.*extension/i,
    /^Failed to load resource.*chrome-extension/,
    /^Denying load of chrome-extension/,
  ];

  return logs.filter(log => {
    // Keep non-error messages as-is
    if (log.level !== 'error') return true;
    // Filter out extension errors
    return !EXTENSION_PATTERNS.some(pat => pat.test(log.text) || pat.test(log.url || ''));
  });
}
```

**Also**: Add `console` parameter to snapshot tool to control inclusion:

```typescript
// page.snapshot({ console: "errors" })     — only page errors (default)
// page.snapshot({ console: "all" })         — everything including extensions
// page.snapshot({ console: "none" })        — suppress console section entirely
```

**Files to change**: `tools/observe.ts`, `tools/page.ts`
**Tests**: Inject extension-style console error, verify it's filtered from snapshot response

---

## 4. Architecture Migration — Phase 2 (Week 3–4)

### Migration Strategy: Incremental Extraction

The key constraint is **zero downtime** — the server must work at every commit. We extract modules one at a time from `server.js`, with each extraction being a self-contained PR.

### Step-by-Step Migration Order

```
Week 3:
  Day 1-2: Project setup (TypeScript, build pipeline, package.json updates)
  Day 3:   Extract types.ts + config.ts
  Day 4:   Extract connection/ (cdp-client.ts, browser-discovery.ts)
  Day 5:   Extract session/ (session-manager.ts, tab-ownership.ts, state-store.ts)

Week 4:
  Day 1:   Extract snapshot/ (accessibility.ts, element-resolver.ts)
  Day 2:   Extract utils/ (wait.ts, retry.ts, temp-files.ts, error-handler.ts)
  Day 3-4: Extract tools/ (one tool module per half-day)
  Day 5:   Extract index.ts (entry point), remove server.js, verify everything works
```

### Project Setup

```json
// package.json changes
{
  "name": "cdp-mcp-server",
  "version": "5.0.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsc --watch",
    "test": "vitest",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "@types/ws": "^8.0.0",
    "eslint": "^9.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "ws": "^8.0.0"
  }
}
```

### Module Extraction Pattern

For each module extraction:

1. **Create the new file** with the extracted code
2. **Add TypeScript types** to all function signatures
3. **Replace global state** with injected context parameters
4. **Update imports** in the remaining `server.js`
5. **Run the test suite** to verify no regressions
6. **Commit with clear message**: `refactor: extract {module} from server.js`

### Example: Extracting `config.ts`

```typescript
// src/config.ts
export interface ServerConfig {
  cdpHost: string;
  cdpPort: number;
  actionTimeout: number;
  navigationTimeout: number;
  snapshotTimeout: number;
  sessionTTL: number;
  debuggerTimeout: number;
  cleanupStrategy: 'close' | 'detach' | 'none';
  tempDir: string;
  maxTempFiles: number;
  maxTempAgeMs: number;
  maxInlineLen: number;
}

export function loadConfig(): ServerConfig {
  return {
    cdpHost: process.env.CDP_HOST || '127.0.0.1',
    cdpPort: parseInt(process.env.CDP_PORT || '9222'),
    actionTimeout: parseInt(process.env.CDP_ACTION_TIMEOUT || '10000'),
    navigationTimeout: parseInt(process.env.CDP_NAVIGATION_TIMEOUT || '60000'),
    snapshotTimeout: parseInt(process.env.CDP_SNAPSHOT_TIMEOUT || '15000'),
    sessionTTL: parseInt(process.env.CDP_SESSION_TTL || '300000'),
    debuggerTimeout: parseInt(process.env.CDP_DEBUGGER_TIMEOUT || '30000'),
    cleanupStrategy: (process.env.CDP_CLEANUP_STRATEGY as any) || 'detach',
    tempDir: process.env.CDP_TEMP_DIR || join(REPO_ROOT, '.temp'),
    maxTempFiles: 50,
    maxTempAgeMs: 30 * 60 * 1000,
    maxInlineLen: 60_000,
  };
}
```

### Backward Compatibility

During migration, maintain a **compatibility shim**:

```typescript
// server.js (during migration period)
// Re-exports from new modular code — maintains backward compatibility
import { createServer } from './dist/index.js';
createServer();
```

After full migration, `server.js` is replaced by `dist/index.js`.

### Testing Each Extraction

Every module extraction must pass:

1. **Compile check**: `tsc --noEmit` passes
2. **Existing behavior**: Manual smoke test — connect, list tabs, navigate, snapshot, click
3. **Unit tests**: New tests for the extracted module (target: 80% coverage per module)

---

## 5. New Features — Phase 3 (Week 5–8)

### Feature 1: Smart Form Filling Engine

**Priority**: CRITICAL — This is the #1 UX gap vs Playwright MCP.

A new `form` tool that handles ALL field types in a single call:

```typescript
// New tool: form
{
  name: "form",
  description: "Smart form filling — handles text, combobox, checkbox, radio, date, file, and multi-select fields. Automatically detects field type from accessibility role.",
  inputSchema: {
    action: "fill",     // fill | read | clear | validate
    tabId: "string",
    fields: [{
      uid: "number",           // Element ref from snapshot
      value: "string",         // Value to fill
      type: "auto"             // auto | text | combobox | checkbox | radio | date | select | file
    }]
  }
}
```

**Field type handling**:

| Type | Strategy |
|------|----------|
| `text`, `textarea` | `DOM.focus` → `Input.insertText` with React event simulation |
| `combobox` | Type → wait for dropdown → find best match → click option |
| `checkbox` | Toggle via click if current state ≠ desired state |
| `radio` | Click the radio button |
| `select` (native) | `DOM.setAttributeValue` + change event |
| `date` | Type in ISO format OR use date picker navigation |
| `file` | Trigger file chooser via CDP |
| `multi-select` | Click each option to toggle |

**Auto-detection**: Read the accessibility tree role (`textbox`, `combobox`, `checkbox`, `radio`, `listbox`, `spinbutton`, `slider`) and dispatch to the correct handler.

---

### Feature 2: Profile-Aware Tab Creation

**Problem**: Can't open tabs in a specific browser profile. Everything opens in whatever profile is focused.

```typescript
// tabs.new with profile targeting
{
  action: "new",
  url: "https://mail.google.com",
  profile: "Work"  // or email "john@company.com" or directory "Profile 2"
}
```

**Implementation**: Use `Target.createBrowserContext` with the target profile's cookies/storage, or use `browserContextId` from CDP's `Target.createTarget`.

---

### Feature 3: Lazy Initialization

**Problem**: Server initializes all domains and event listeners on connect, even if most tools won't be used.

**Solution**: Enable CDP domains only when the corresponding tool is first called:

```typescript
class LazyDomainManager {
  private enabled = new Set<string>();

  async ensure(session: CDPSession, domain: string): Promise<void> {
    if (this.enabled.has(domain)) return;
    await session.send(`${domain}.enable`);
    this.enabled.add(domain);
  }
}

// In observe tool:
async function handleConsole(ctx, params) {
  await ctx.domains.ensure(session, 'Runtime');  // Only enabled if console tool is used
  // ...
}
```

---

### Feature 4: Modal State System

**Inspired by**: Playwright MCP's modal state system (see PlaywrightMCP.md §6).

When a dialog or file chooser appears, block all tools except the one that handles it:

```typescript
interface ModalState {
  type: 'dialog' | 'fileChooser' | 'auth';
  description: string;
  clearedBy: string;  // Tool name that can handle this state
}

// In tool dispatch:
if (ctx.modalStates.length > 0 && !tool.clearsModalState) {
  const modal = ctx.modalStates[0];
  return error(
    `A ${modal.type} is blocking the page: "${modal.description}".`,
    `Handle it with: ${modal.clearedBy}`
  );
}
```

---

### Feature 5: Wait-for-Completion Tracking

**Inspired by**: Playwright MCP's `waitForCompletion()` pattern (see PlaywrightMCP.md §6).

After any click/type/fill action, track all requests fired and wait for them to settle:

```typescript
async function withCompletion(session: CDPSession, action: () => Promise<void>): Promise<void> {
  const pendingRequests = new Set<string>();

  // Track requests started during the action
  const listener = (params: any) => pendingRequests.add(params.requestId);
  session.on('Network.requestWillBeSent', listener);

  try {
    await action();
    await sleep(300);  // Brief pause for async effects
  } finally {
    session.off('Network.requestWillBeSent', listener);
  }

  // Wait for all tracked requests to complete (max 5s)
  const deadline = Date.now() + 5000;
  while (pendingRequests.size > 0 && Date.now() < deadline) {
    await sleep(100);
    // Check if any completed
    for (const reqId of pendingRequests) {
      // ... check if response received
    }
  }
}
```

This makes SPA navigations "just work" — the agent doesn't need manual `page.wait()` calls.

---

### Feature 6: Agent Guidance in Tool Descriptions

**Problem**: Tools don't explain themselves. Agents don't know about `cleanupStrategy: "detach"`, that LinkedIn needs JS clicks, or that comboboxes need multi-step workflows.

**Solution**: Rich, LLM-optimized tool descriptions:

```typescript
const tabsTool = {
  name: 'tabs',
  description: `Tab lifecycle management. List, find, create, close, and activate browser tabs.

IMPORTANT NOTES FOR AI AGENTS:
- Use showAll: true to see tabs from ALL profiles, not just this session
- New tabs inherit the browser's cookies and auth — no need to re-login
- Default cleanupStrategy is "detach" — tabs stay open after your session ends
- To open a tab in a specific Chrome profile, use the "profile" parameter

COMMON PATTERNS:
- Find an existing logged-in tab: tabs.find({ query: "gmail" })
- Open URL in specific profile: tabs.new({ url: "...", profile: "Work" })
- List everything: tabs.list({ showAll: true })`,
  // ...
};
```

---

### Feature 7: Smart Retry for Stale Elements

Wrap all element interactions in automatic retry logic:

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; retryOn?: (err: Error) => boolean } = {}
): Promise<T> {
  const { maxRetries = 2, retryOn = isStaleRefError } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries || !retryOn(err as Error)) throw err;
      // Re-resolve the element before retrying
      await refreshSnapshot();
      await sleep(200 * (attempt + 1));
    }
  }
  throw new Error('Unreachable');
}

function isStaleRefError(err: Error): boolean {
  return err.message.includes('not found') ||
         err.message.includes('stale') ||
         err.message.includes('No node with given id');
}
```

---

### Feature 8: Health Dashboard

New `cleanup.status` action returns comprehensive health info:

```typescript
{
  action: "status",
  response: {
    connection: {
      status: "connected",
      browser: "Chrome 127",
      profile: "Default",
      port: 9222,
      uptime: "2h 15m",
      lastPing: "200ms ago"
    },
    sessions: {
      active: 2,
      totalTabsOwned: 5,
      oldestSession: "45 minutes ago"
    },
    performance: {
      avgSnapshotTime: "1.2s",
      avgActionTime: "0.8s",
      totalToolCalls: 142,
      errorRate: "3.5%"
    }
  }
}
```

---

## 6. Performance Optimization — Phase 4 (Week 9–10)

### 1. Snapshot Caching & Diffing

Cache the last snapshot per tab. On subsequent snapshot requests, compare and return only changes:

```typescript
// page.snapshot({ diff: true })
// Returns:
{
  added: [{ uid: 45, role: "button", name: "Submit" }],
  removed: [{ uid: 12, role: "dialog" }],
  changed: [{ uid: 7, changes: { name: "Email (3 unread)" } }]
}
```

This reduces snapshot response size from 34KB to ~2KB for incremental updates.

### 2. Connection Pooling

For multi-tab workflows, maintain a pool of CDP sessions:

```typescript
class SessionPool {
  private sessions = new Map<string, CDPSession>();  // targetId → session
  private lastUsed = new Map<string, number>();

  async getSession(targetId: string): Promise<CDPSession> {
    if (this.sessions.has(targetId)) {
      this.lastUsed.set(targetId, Date.now());
      return this.sessions.get(targetId)!;
    }
    // Create new session, reuse domains if possible
    const session = await this.createSession(targetId);
    this.sessions.set(targetId, session);
    return session;
  }

  // Evict sessions unused for > 5 minutes
  private evictStale(): void { ... }
}
```

### 3. Startup Time Optimization

Current startup: discover instances → connect WebSocket → enumerate targets → enable domains.

Optimized startup: connect WebSocket only. Defer everything else to first tool call.

```typescript
// Startup takes < 100ms (just MCP server init)
// First tool call: auto-connect + auto-discover (adds ~500ms to first call only)
```

### 4. Token Budget Management

Add a `tokenBudget` parameter to snapshot:

```typescript
// page.snapshot({ tokenBudget: 8000 })
// Server automatically:
// 1. Filters decorative roles
// 2. Truncates long text
// 3. Limits depth
// 4. Collapses empty containers
// Until output fits within budget
```

### 5. Parallel Domain Enable

Currently, domains are enabled sequentially. Enable them in parallel:

```typescript
await Promise.all([
  session.send('Page.enable'),
  session.send('Runtime.enable'),
  session.send('Network.enable'),
  session.send('DOM.enable'),
]);
// Saves ~200ms per tab attach
```

---

## 7. Testing Plan

### Unit Tests (per module)

| Module | Test Focus | Coverage Target |
|--------|-----------|-----------------|
| `config.ts` | Env var parsing, defaults, validation | 95% |
| `cdp-client.ts` | Message routing, callback management, error handling | 90% |
| `browser-discovery.ts` | DevToolsActivePort parsing, instance enumeration | 85% |
| `session-manager.ts` | Session lifecycle, TTL expiry, cleanup | 90% |
| `tab-ownership.ts` | Lock/unlock, exclusive vs shared, cleanup strategies | 90% |
| `element-resolver.ts` | Uid assignment, stability across snapshots, navigation reset | 95% |
| `token-optimizer.ts` | Role filtering, text truncation, depth limiting | 90% |
| `error-handler.ts` | Error catalog, actionable messages, fix suggestions | 85% |
| `wait.ts` | Navigation wait, selector wait, text wait, timeout | 85% |

### Integration Tests (with real browser)

| Test Suite | What It Tests |
|-----------|---------------|
| `tabs.test.ts` | Create, close, list, find, activate tabs |
| `navigation.test.ts` | Goto, back, forward, reload, SPA navigation, timeout handling |
| `snapshot.test.ts` | Full snapshot, incremental diff, token budget, element stability |
| `interact.test.ts` | Click, type, fill, select, hover, scroll, drag — on test pages |
| `form-filling.test.ts` | Text, combobox, checkbox, radio, select, date — all field types |
| `execute.test.ts` | JS eval, script execution, call-on-element |
| `network.test.ts` | Console capture, network listing, request body, HAR export |
| `emulate.test.ts` | Viewport, color scheme, geolocation, network throttling |
| `storage.test.ts` | Cookie CRUD, clear data, quota check |
| `intercept.test.ts` | Request interception, mocking, blocking |
| `debug.test.ts` | Breakpoints, stepping, resource overrides |
| `session.test.ts` | Session isolation, tab locking, TTL, cleanup strategies |
| `reconnect.test.ts` | Browser disconnect, auto-reconnect, state recovery |

### Competitive Benchmark Tests

Run identical tasks on CDP Browser MCP vs Playwright MCP and measure:

| Benchmark | Task | Metrics |
|-----------|------|---------|
| `bench-navigate.ts` | Navigate to 5 URLs, take snapshots | Total time, snapshot sizes |
| `bench-form.ts` | Fill a 10-field form (text, select, checkbox) | Total time, tool calls needed |
| `bench-gmail.ts` | Open Gmail, find email, read content | Total time, success rate |
| `bench-linkedin.ts` | Open LinkedIn, read messages | Total time, click success rate |
| `bench-startup.ts` | Server start to first successful snapshot | Startup time |

### Form Filling Test Suite

Local HTML test pages that replicate real-world form patterns:

| Test Page | Patterns |
|-----------|----------|
| `greenhouse.html` | React comboboxes, multi-step dropdowns, file upload |
| `lever.html` | Custom selects, conditional fields, rich text |
| `workday.html` | iframes, multi-page wizard, captcha handling |
| `linkedin.html` | Ember.js components, virtual scrolling, lazy load |
| `d365.html` | Slow-loading frames, cross-origin iframes, complex grids |

---

## 8. Migration Path

### Phase Transitions

```
v4.13.0 (current)     → v4.14.0 (Phase 1 fixes)
                            ↓
                       v4.15.0 (more fixes, prep for TS)
                            ↓
                       v5.0.0-alpha.1 (TypeScript, modular, backward-compat shim)
                            ↓
                       v5.0.0-alpha.N (incremental module extractions)
                            ↓
                       v5.0.0-beta.1 (all modules extracted, server.js removed)
                            ↓
                       v5.0.0-rc.1 (new features, full test suite)
                            ↓
                       v5.0.0 (stable release)
```

### Backward Compatibility Commitments

1. **All 11 tool names stay the same**: `tabs`, `page`, `interact`, `execute`, `observe`, `emulate`, `storage`, `intercept`, `cleanup`, `browser`, `debug`
2. **All existing action names stay the same**: `list`, `find`, `new`, `close`, `goto`, `snapshot`, `click`, `type`, `fill`, etc.
3. **All existing parameters stay the same**: No renames, no removed params
4. **New params are always optional**: Old agent prompts still work
5. **Env vars are backward-compatible**: `CDP_PORT`, `CDP_HOST`, `CDP_TIMEOUT` still work. New vars use `CDP_` prefix.

### Breaking Changes in v5.0.0

1. **Default cleanupStrategy**: `"close"` → `"detach"` (behavior change, but what users actually want)
2. **Default timeout**: 30s → 60s for navigation (allows SPA loading)
3. **Console error filtering**: Extension errors filtered by default (can opt-in with `console: "all"`)
4. **Entry point**: `server.js` → `dist/index.js` (npm `main` field change)
5. **Node.js requirement**: 18+ → 20+ (for better TypeScript support and `node:test` if needed)

### Versioning Strategy

- **v4.x.y**: Bug fixes and small improvements to current architecture
- **v5.0.0-alpha.x**: TypeScript migration, modular architecture (may have rough edges)
- **v5.0.0-beta.x**: All modules extracted, new features added
- **v5.0.0-rc.x**: Full test suite passing, documentation updated
- **v5.0.0**: Stable release with full modular architecture

---

## 9. Risk Assessment

### Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| TypeScript migration introduces regressions | Medium | High | Incremental extraction, test each module, keep server.js as fallback |
| Auto-connect breaks for non-standard setups | Medium | Medium | Fall back to manual `browser.connect()`, clear error message |
| Smart form filling is unreliable on complex sites | High | High | Extensive test suite, fallback to manual multi-step workflow |
| Snapshot optimization removes important elements | Medium | High | Conservative defaults, allow `verbose: true` override |
| Breaking changes break existing agent workflows | Low | High | Backward compatibility shim during migration |

### Organizational Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Scope creep — too many features at once | High | High | Strict phase gates, Phase 1 fixes before any new features |
| Solo developer bottleneck | High | Medium | Clear module boundaries enable future contributors |
| Competitor moves faster (Playwright MCP v2) | Medium | Medium | Focus on unique value prop (existing browser), not feature parity |

### Dependencies

| Dependency | Risk | Action |
|------------|------|--------|
| `@modelcontextprotocol/sdk` | Low — stable, Microsoft-backed | Pin to ^1.0.0, test on updates |
| `ws` | Very Low — mature, minimal | Pin to ^8.0.0 |
| Chrome CDP protocol | Low — backward compatible | Test against Chrome Stable + Beta |
| Node.js 20+ | Low | Test on Node 20 LTS and 22 LTS |

---

## Appendix A: File-by-File Extraction Map

How each section of the current `server.js` maps to the new modular architecture:

| server.js Lines (approx) | Current Section | Target Module |
|--------------------------|-----------------|---------------|
| 1–65 | Config, constants, imports | `config.ts`, `index.ts` |
| 65–110 | Temp file management | `utils/temp-files.ts` |
| 110–150 | Global state declarations | `session/state-store.ts` |
| 150–185 | WS URL discovery | `connection/browser-discovery.ts` |
| 185–240 | Chrome instance discovery | `connection/browser-discovery.ts` |
| 240–340 | Browser connection (WebSocket) | `connection/cdp-client.ts` |
| 340–400 | Health check | `connection/health-monitor.ts` |
| 400–600 | CDP message routing, session attach | `connection/cdp-session.ts` |
| 600–900 | Tool definitions (tabs, page) | `tools/tabs.ts`, `tools/page.ts` |
| 900–1200 | Snapshot & element resolution | `snapshot/accessibility.ts`, `snapshot/element-resolver.ts` |
| 1200–1800 | Interact tool (click, type, fill, etc.) | `tools/interact.ts` |
| 1800–2200 | Execute, observe tools | `tools/execute.ts`, `tools/observe.ts` |
| 2200–2600 | Emulate, storage, intercept | `tools/emulate.ts`, `tools/storage.ts`, `tools/intercept.ts` |
| 2600–3200 | Debug tool (breakpoints, stepping) | `tools/debug.ts` |
| 3200–3600 | Browser, cleanup tools | `tools/browser.ts`, `tools/cleanup.ts` |
| 3600–4000 | Session management, tab locking | `session/session-manager.ts`, `session/tab-ownership.ts` |
| 4000–4400 | Response formatting, console appending | `utils/response-builder.ts` |
| 4400–4867 | MCP server setup, tool registration | `index.ts`, `tools/registry.ts` |

---

## Appendix B: Competitive Feature Gap Analysis

Features we HAVE that competitors DON'T:

| Feature | Us | Playwright | Chrome DevTools | mcp-chrome |
|---------|:--:|:----------:|:---------------:|:----------:|
| Existing browser connection | ✅ | ⚠️ ext only | ✅ | ✅ ext |
| Request interception/mocking | ✅ | ❌ | ❌ | ❌ |
| JS debugger + breakpoints | ✅ | ❌ | ❌ | ❌ |
| Resource overrides | ✅ | ❌ | ❌ | ❌ |
| DOM/event breakpoints | ✅ | ❌ | ❌ | ❌ |
| Cookie CRUD | ✅ | ⚠️ file | ❌ | ❌ |
| Network throttling presets | ✅ | ❌ | ✅ | ❌ |
| HAR export | ✅ | ❌ | ❌ | ❌ |
| CSP bypass | ✅ | ❌ | ❌ | ❌ |
| Human-like interaction | ✅ | ❌ | ❌ | ❌ |
| Session isolation + tab locks | ✅ | ❌ | ❌ | ❌ |
| Multi-browser (Chrome/Edge/Brave) | ✅ | ❌ | ❌ | ❌ |
| Download tracking | ✅ | ❌ | ❌ | ❌ |

Features competitors HAVE that we DON'T (yet):

| Feature | Playwright | Chrome DevTools | mcp-chrome | Our Plan |
|---------|:----------:|:---------------:|:----------:|:--------:|
| Batch form fill | ✅ | ✅ | ✅ | Phase 3 |
| Lighthouse audits | ❌ | ✅ | ❌ | Future |
| Performance tracing | ❌ | ✅ | ❌ | Future |
| Heap snapshots | ❌ | ✅ | ❌ | Future |
| Semantic search across tabs | ❌ | ❌ | ✅ | Future |
| Code generation | ✅ | ❌ | ❌ | Future |
| Browser extension mode | ✅ | ❌ | ✅ | Future |

---

*This document is the source of truth for the v5.0.0 restructure. Update it as decisions are made and phases are completed.*
