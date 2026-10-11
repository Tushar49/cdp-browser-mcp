# Chrome DevTools MCP Server — Deep Research Document

> **Repository:** [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
> **Author:** Google LLC (Apache-2.0)
> **Version analyzed:** 0.21.0
> **NPM Package:** `chrome-devtools-mcp`
> **MCP Name:** `io.github.ChromeDevTools/chrome-devtools-mcp`

---

## Table of Contents

1. [Overview & Design Philosophy](#1-overview--design-philosophy)
2. [Architecture](#2-architecture)
3. [Tool System Design](#3-tool-system-design)
4. [Complete Tool Reference](#4-complete-tool-reference)
5. [Browser Connection & Launch](#5-browser-connection--launch)
6. [Snapshot System (A11y Tree)](#6-snapshot-system-a11y-tree)
7. [Interaction Model (uid System)](#7-interaction-model-uid-system)
8. [Page Management](#8-page-management)
9. [Performance & Tracing](#9-performance--tracing)
10. [Network & Console Monitoring](#10-network--console-monitoring)
11. [Emulation System](#11-emulation-system)
12. [Error Handling & Resilience](#12-error-handling--resilience)
13. [Session Management & Concurrency](#13-session-management--concurrency)
14. [Slim Mode](#14-slim-mode)
15. [Key Architectural Patterns](#15-key-architectural-patterns)
16. [Strengths & Weaknesses](#16-strengths--weaknesses)
17. [Opportunities for a Competing Server](#17-opportunities-for-a-competing-server)

---

## 1. Overview & Design Philosophy

Chrome DevTools MCP is Google's official MCP server that gives AI coding agents access to Chrome DevTools capabilities for browser automation, debugging, and performance analysis.

### Design Principles (from `docs/design-principles.md`)

| Principle | Description |
|-----------|-------------|
| **Agent-Agnostic API** | Use MCP standard. Don't lock into one LLM. |
| **Token-Optimized** | Return semantic summaries, not raw JSON. "LCP was 3.2s" > 50K lines of JSON. |
| **Small, Deterministic Blocks** | Give agents composable tools (Click, Screenshot), not magic buttons. |
| **Self-Healing Errors** | Return actionable errors with context and potential fixes. |
| **Human-Agent Collaboration** | Output readable by machines (structured) AND humans (summaries). |
| **Progressive Complexity** | Simple by default, advanced optional arguments for power users. |
| **Reference over Value** | For heavy assets (screenshots, traces), return file paths, not raw data. |

### Key Technology Stack

- **Runtime:** Node.js v20.19+ (TypeScript, built with `tsc` + Rollup for bundling)
- **Browser Automation:** Puppeteer (24.42.0) — NOT raw CDP
- **Performance:** Chrome DevTools Frontend (`chrome-devtools-frontend`) for trace parsing
- **Auditing:** Lighthouse (13.1.0) for accessibility/SEO/best-practices
- **MCP SDK:** `@modelcontextprotocol/sdk` 1.29.0
- **Schema Validation:** Zod (via MCP SDK's bundled zod)
- **Telemetry:** Custom ClearcutLogger (Google's analytics)

---

## 2. Architecture

### Directory Structure

```
src/
├── index.ts                    # Entry point — creates McpServer, registers tools
├── browser.ts                  # Browser launch/connect logic (Puppeteer)
├── McpContext.ts                # Central context object (27KB — largest file)
├── McpPage.ts                  # Per-page state wrapper
├── McpResponse.ts              # Response builder with token-aware formatting (35KB)
├── SlimMcpResponse.ts          # Simplified response for slim mode
├── PageCollector.ts            # Network/console data collection per page
├── DevToolsConnectionAdapter.ts # Bridges Puppeteer CDP sessions → DevTools frontend
├── DevtoolsUtils.ts            # DevTools universe manager
├── HeapSnapshotManager.ts      # Heap snapshot processing
├── WaitForHelper.ts            # Smart wait-after-action system
├── Mutex.ts                    # Simple FIFO mutex for tool serialization
├── logger.ts                   # Debug logger
├── types.ts                    # Core type definitions
├── version.ts                  # Version constant
│
├── tools/                      # All MCP tool definitions
│   ├── tools.ts                # Tool registry — imports & exports all tools
│   ├── ToolDefinition.ts       # Base types, definePageTool/defineTool helpers
│   ├── categories.ts           # Tool category enum
│   ├── input.ts                # click, hover, fill, drag, press_key, etc.
│   ├── pages.ts                # list_pages, select_page, navigate_page, etc.
│   ├── snapshot.ts             # take_snapshot, wait_for
│   ├── screenshot.ts           # take_screenshot
│   ├── script.ts               # evaluate_script
│   ├── console.ts              # list_console_messages, get_console_message
│   ├── network.ts              # list_network_requests, get_network_request
│   ├── performance.ts          # performance_start_trace, stop_trace, analyze_insight
│   ├── lighthouse.ts           # lighthouse_audit
│   ├── emulation.ts            # emulate
│   ├── memory.ts               # take_memory_snapshot, load_memory_snapshot
│   ├── screencast.ts           # Screen recording (experimental)
│   ├── extensions.ts           # Chrome extension management (experimental)
│   ├── inPage.ts               # In-page tool discovery
│   ├── webmcp.ts               # WebMCP protocol support
│   └── slim/tools.ts           # Minimal tool set for slim mode
│
├── formatters/                 # Response formatters
│   ├── SnapshotFormatter.ts    # A11y tree → text format
│   ├── ConsoleFormatter.ts     # Console messages → text
│   ├── NetworkFormatter.ts     # Network requests → text
│   ├── IssueFormatter.ts       # DevTools issues → text
│   └── HeapSnapshotFormatter.ts
│
├── trace-processing/           # Performance trace analysis
│   └── parse.ts                # Raw trace → insights (uses DevTools frontend)
│
├── telemetry/                  # Usage statistics
├── utils/                      # Helpers
│   ├── keyboard.ts             # Key parsing (modifiers, combos)
│   ├── pagination.ts           # Paginated results
│   ├── string.ts               # String utilities
│   ├── files.ts                # File extension helpers
│   └── types.ts
│
├── bin/                        # CLI entry points
└── third_party/                # Re-exports of Puppeteer, MCP SDK, DevTools, Lighthouse
```

### Core Architecture Pattern

```
┌─────────────────────────────────────────────────────────────┐
│                     MCP Client (LLM)                        │
└───────────────────────────┬─────────────────────────────────┘
                            │ MCP Protocol (stdio)
┌───────────────────────────▼─────────────────────────────────┐
│                      index.ts                               │
│  McpServer ──▶ registerTool() for each tool                 │
│  Mutex guard ──▶ ONE tool at a time (serialized)            │
│  getContext() ──▶ lazy browser connection                   │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────┐
│                    McpContext                                │
│  ┌──────────┐  ┌───────────────┐  ┌──────────────────┐      │
│  │ McpPage  │  │PageCollector  │  │UniverseManager   │      │
│  │ (per tab)│  │(net/console)  │  │(DevTools bridge) │      │
│  └──────────┘  └───────────────┘  └──────────────────┘      │
│  ┌──────────────┐  ┌───────────────────────┐                │
│  │HeapSnapshot  │  │ Emulation Settings    │                │
│  │Manager       │  │ (per page)            │                │
│  └──────────────┘  └───────────────────────┘                │
└───────────────────────────┬─────────────────────────────────┘
                            │ Puppeteer API
┌───────────────────────────▼─────────────────────────────────┐
│                   Chrome Browser (CDP)                       │
└─────────────────────────────────────────────────────────────┘
```

### Key Design Decision: Puppeteer Abstraction

Chrome DevTools MCP does **NOT** use raw CDP. It wraps everything through Puppeteer, which provides:
- Automatic wait/retry logic
- Locator-based element interaction
- High-level page management
- Built-in connection handling

This is a significant architectural choice — it adds a layer of abstraction but gains stability.

---

## 3. Tool System Design

### Tool Definition Pattern

Tools are defined using two helper functions:

```typescript
// For tools that operate globally (not page-specific)
defineTool({
  name: 'list_pages',
  description: '...',
  annotations: { category: ToolCategory.NAVIGATION, readOnlyHint: true },
  schema: { /* zod schema */ },
  handler: async (request, response, context) => { ... }
})

// For tools that operate on a specific page
definePageTool({
  name: 'click',
  description: '...',
  annotations: { category: ToolCategory.INPUT, readOnlyHint: false },
  schema: { uid: zod.string(), ... },
  handler: async (request, response, context) => {
    // request.page is automatically provided
  }
})
```

### Tool Annotations

Every tool has:
- **`category`**: One of `INPUT`, `NAVIGATION`, `EMULATION`, `PERFORMANCE`, `NETWORK`, `DEBUGGING`, `EXTENSIONS`, `IN_PAGE`, `MEMORY`
- **`readOnlyHint`**: Whether the tool modifies state
- **`conditions`** (optional): Feature flags like `computerVision`, `experimentalMemory`, `screencast`, etc.

### Tool Registration Flow

```
index.ts:createMcpServer()
  → createTools(args)           // tools/tools.ts
    → imports all tool modules
    → if args.slim → only slim tools
    → else → all tool modules
    → sorts by name alphabetically
  → for each tool: registerTool()
    → checks feature flags (args)
    → wraps handler with: mutex → logging → context resolution → error handling → telemetry
```

### Conditional Tool Loading

Tools can be disabled via CLI flags:
- `--no-category-emulation` → disables emulation tools
- `--no-category-performance` → disables performance tools
- `--no-category-network` → disables network tools
- `--no-category-extensions` → disables extension tools (off by default)
- `--no-category-in-page-tools` → disables in-page tool discovery
- `--experimental-vision` → enables coordinate-based click (click_at)
- `--experimental-memory` → enables memory exploration
- `--experimental-screencast` → enables screen recording

---

## 4. Complete Tool Reference

### Input Automation (9 tools)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `click` | `uid` (required), `dblClick?`, `includeSnapshot?` | Click element by uid |
| `click_at` | `x`, `y`, `dblClick?`, `includeSnapshot?` | Click at coordinates (experimental, needs `--experimental-vision`) |
| `hover` | `uid`, `includeSnapshot?` | Hover over element |
| `fill` | `uid`, `value`, `includeSnapshot?` | Fill input/textarea/select |
| `fill_form` | `elements[]` {uid, value}, `includeSnapshot?` | Fill multiple form fields at once |
| `type_text` | `text`, `submitKey?` | Type via keyboard into focused input |
| `press_key` | `key`, `includeSnapshot?` | Press key combo (e.g., "Control+A") |
| `drag` | `from_uid`, `to_uid`, `includeSnapshot?` | Drag and drop between elements |
| `upload_file` | `uid`, `filePath`, `includeSnapshot?` | Upload file via input or file chooser |

### Navigation (6 tools)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_pages` | (none) | List all open pages |
| `select_page` | `pageId`, `bringToFront?` | Select page as context |
| `new_page` | `url`, `background?`, `isolatedContext?`, `timeout?` | Open new tab |
| `close_page` | `pageId` | Close page (can't close last) |
| `navigate_page` | `type?`, `url?`, `ignoreCache?`, `handleBeforeUnload?`, `initScript?`, `timeout?` | Navigate/reload/back/forward |
| `wait_for` | `text[]`, `timeout?` | Wait for text to appear |

### Debugging (6 tools)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `take_snapshot` | `verbose?`, `filePath?` | Capture a11y tree snapshot |
| `take_screenshot` | `format?`, `quality?`, `uid?`, `fullPage?`, `filePath?` | Screenshot page or element |
| `evaluate_script` | `function`, `args?`, `dialogAction?` | Run JS in page context |
| `list_console_messages` | `pageSize?`, `pageIdx?`, `types?`, `includePreservedMessages?` | List console output |
| `get_console_message` | `msgid` | Get specific console message |
| `lighthouse_audit` | `mode?`, `device?`, `outputDirPath?` | Run Lighthouse (a11y, SEO, best practices) |

### Performance (4 tools)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `performance_start_trace` | `reload?`, `autoStop?`, `filePath?` | Start performance trace |
| `performance_stop_trace` | `filePath?` | Stop trace and get insights |
| `performance_analyze_insight` | `insightSetId`, `insightName` | Deep-dive into specific insight |
| `take_memory_snapshot` | `filePath` | Capture heap snapshot |

### Network (2 tools)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_network_requests` | `pageSize?`, `pageIdx?`, `resourceTypes?`, `includePreservedRequests?` | List captured requests |
| `get_network_request` | `reqid?`, `requestFilePath?`, `responseFilePath?` | Get request/response details |

### Emulation (2 tools)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `emulate` | `networkConditions?`, `cpuThrottlingRate?`, `geolocation?`, `userAgent?`, `colorScheme?`, `viewport?` | Emulate device/network |
| `resize_page` | `width`, `height` | Resize page viewport |

### Dialog Handling (1 tool, categorized under Input)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `handle_dialog` | `action` (accept/dismiss), `promptText?` | Handle alert/confirm/prompt |

### Total: ~29 tools in full mode, 3 in slim mode

---

## 5. Browser Connection & Launch

### Connection Modes (`src/browser.ts`)

The server supports two connection strategies:

#### 1. Launch a New Browser (`ensureBrowserLaunched`)
- Uses `puppeteer.launch()` with a dedicated user data directory
- Default profile dir: `~/.cache/chrome-devtools-mcp/chrome-profile`
- Supports `--headless`, `--isolated` (temp profile), `--channel` (stable/canary/beta/dev)
- Passes custom Chrome args via `--chrome-arg`
- Sets `pipe: true` for faster communication
- Sets `defaultViewport: null` to inherit system viewport
- `handleDevToolsAsPage: true` — can interact with DevTools windows themselves

#### 2. Connect to Existing Browser (`ensureBrowserConnected`)
- `--browser-url` → connect via HTTP (e.g., `http://127.0.0.1:9222`)
- `--ws-endpoint` → connect via WebSocket URL directly
- `--auto-connect` → auto-detect running Chrome by channel, reads `DevToolsActivePort` file from user data dir

#### Auto-Connect Mechanism
```typescript
// Reads DevToolsActivePort file from Chrome's user data dir
const portPath = path.join(userDataDir, 'DevToolsActivePort');
const [rawPort, rawPath] = fileContent.split('\n').map(line => line.trim());
const browserWSEndpoint = `ws://127.0.0.1:${port}${rawPath}`;
```

#### Target Filtering
```typescript
function makeTargetFilter(enableExtensions = false) {
  const ignoredPrefixes = new Set(['chrome://', 'chrome-untrusted://']);
  if (!enableExtensions) ignoredPrefixes.add('chrome-extension://');
  return (target) => {
    if (target.url() === 'chrome://newtab/') return true;
    for (const prefix of ignoredPrefixes)
      if (target.url().startsWith(prefix)) return false;
    return true;
  };
}
```

#### Display Detection (Linux)
Automatically detects `DISPLAY` environment variable on Linux for headless/headed mode switching.

#### Browser Singleton
Only one browser instance is maintained. If the browser is already connected, it is reused.

---

## 6. Snapshot System (A11y Tree)

### How Snapshots Work

The snapshot system is the **core interaction model**. It captures the accessibility tree of the page and assigns unique IDs (`uid`) to each element.

#### Data Structures (`src/types.ts`)

```typescript
interface TextSnapshotNode extends SerializedAXNode {
  id: string;                    // The uid (e.g., "1", "2", "3")
  backendNodeId?: number;        // Chrome's internal DOM node ID
  loaderId?: string;
  children: TextSnapshotNode[];
}

interface TextSnapshot {
  root: TextSnapshotNode;
  idToNode: Map<string, TextSnapshotNode>;  // Fast uid → node lookup
  snapshotId: string;                        // Auto-incrementing ID
  selectedElementUid?: string;               // Element selected in DevTools
  hasSelectedElement: boolean;
  verbose: boolean;
}
```

#### Snapshot Capture Flow

1. `take_snapshot` tool is called
2. `McpResponse.handle()` calls Puppeteer's `page.accessibility.snapshot()` to get `SerializedAXNode` tree
3. Each node is assigned a sequential `uid` (string "1", "2", "3", ...)
4. An `idToNode` map is built for O(1) lookup
5. Stored on `McpPage.textSnapshot`
6. Formatted via `SnapshotFormatter.toString()`

#### Snapshot Format (Output)

```
uid=1 WebPage "Google"
  uid=2 heading "Search"
  uid=3 textbox "Search" focused
  uid=4 button "Google Search"
  uid=5 button "I'm Feeling Lucky"
  uid=6 link "About"
```

Attributes include: `uid`, `role`, `name`, plus boolean attributes like `focused`, `disabled`, `expanded`, `selected`, etc. With `verbose: true`, all a11y attributes are included.

#### Key Design Decisions
- UIDs are **sequential integers as strings** — simple, human-readable
- **No CSS selectors** — all interaction is uid-based
- Snapshot is **stored on McpPage** and reused until next snapshot
- **Verbose mode** includes all a11y properties; default mode is minimal
- Selected element in DevTools Elements panel is annotated: `[selected in the DevTools Elements panel]`
- `filePath` parameter allows saving snapshot to disk instead of returning inline

#### `includeSnapshot` Pattern
Many interaction tools (click, fill, hover, etc.) accept an `includeSnapshot` parameter. When true, a fresh snapshot is taken *after* the action and appended to the response. This is optional (default false) to save tokens.

---

## 7. Interaction Model (uid System)

### Element Resolution

```typescript
// McpPage.getElementByUid()
async getElementByUid(uid: string): Promise<ElementHandle<Element>> {
  if (!this.textSnapshot) {
    throw new Error(`No snapshot found. Use take_snapshot to capture one.`);
  }
  const node = this.textSnapshot.idToNode.get(uid);
  if (!node) {
    throw new Error(`Element uid "${uid}" not found on page.`);
  }
  // Resolves the Puppeteer ElementHandle from the AXNode
  const handle = await node.elementHandle();
  if (!handle) {
    throw new Error(`Element with uid ${uid} no longer exists on the page.`);
  }
  return handle;
}
```

### Click Implementation

```typescript
handler: async (request, response) => {
  const uid = request.params.uid;
  const handle = await request.page.getElementByUid(uid);
  try {
    await request.page.waitForEventsAfterAction(async () => {
      await handle.asLocator().click({count: dblClick ? 2 : 1});
    });
    response.appendResponseLine('Successfully clicked on the element');
  } catch (error) {
    handleActionError(error, uid);
  } finally {
    void handle.dispose();  // Always dispose ElementHandle
  }
}
```

### Fill Implementation (Smart Select Handling)

The `fill` tool handles `<select>` elements specially:
1. Checks if the AXNode role is `combobox` with option children
2. If so, finds the matching option by text content
3. Gets the option's actual `value` attribute
4. Uses `handle.asLocator().fill(actualValue)`

For regular inputs: uses `handle.asLocator().fill(value)` with a timeout that scales with text length:
```typescript
const fillTimeout = page.pptrPage.getDefaultTimeout() + value.length * 10; // 10ms per char
```

### Fill Form (Batch)

Iterates through `elements[]` array, calling `fillFormElement()` for each — each wrapped in `waitForEventsAfterAction`.

### Key Interaction Patterns

1. **Always get ElementHandle from uid** → `getElementByUid(uid)`
2. **Convert to Locator** → `handle.asLocator()` for retry/wait logic
3. **Wrap in waitForEventsAfterAction** → handles potential navigation + DOM stability
4. **Dispose handles** → always in `finally` block
5. **Error mapping** → stale element → actionable error with uid reference

---

## 8. Page Management

### Page Model (`McpPage`)

Each browser tab is wrapped in an `McpPage` instance that holds:
- `pptrPage` — the Puppeteer Page object
- `id` — sequential integer ID (for LLM use)
- `textSnapshot` — latest a11y snapshot
- `emulationSettings` — current emulation state
- `dialog` — pending dialog (auto-captured via event listener)
- `inPageTools` — discovered in-page tool definitions

### Page Lifecycle

```
Browser creates target → McpContext detects via targetcreated event
→ Creates McpPage(page, nextPageId++)
→ Registers with NetworkCollector, ConsoleCollector
→ Stored in McpContext.#mcpPages Map<Page, McpPage>
```

### Page Selection

- `select_page(pageId)` sets `McpContext.#selectedPage`
- All page-scoped tools use `context.getSelectedMcpPage()`
- Optional `--experimental-page-id-routing` adds `pageId` parameter to all page-scoped tools

### Isolated Browser Contexts

`new_page` supports `isolatedContext` parameter:
```typescript
if (isolatedContextName !== undefined) {
  let ctx = this.#isolatedContexts.get(isolatedContextName);
  if (!ctx) {
    ctx = await this.browser.createBrowserContext(); // New incognito-like context
    this.#isolatedContexts.set(isolatedContextName, ctx);
  }
  page = await ctx.newPage();
}
```
Pages in the same named context share cookies/storage. Different contexts are fully isolated.

### Dialog Handling

Dialogs are auto-captured on every McpPage:
```typescript
this.#dialogHandler = (dialog: Dialog) => { this.#dialog = dialog; };
page.on('dialog', this.#dialogHandler);
```
The `handle_dialog` tool retrieves and accepts/dismisses the stored dialog.

---

## 9. Performance & Tracing

### Performance Trace System

#### Start Trace
1. Navigates to `about:blank` to clear state (if `reload: true`)
2. Starts tracing with DevTools-compatible categories (same as Chrome DevTools Timeline panel)
3. Navigates back to original URL
4. If `autoStop: true` → waits 5 seconds → auto-stops

#### Trace Categories
```typescript
const categories = [
  '-*', 'blink.console', 'blink.user_timing', 'devtools.timeline',
  'disabled-by-default-devtools.screenshot',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.invalidationTracking',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack',
  'disabled-by-default-v8.cpu_profiler',
  'disabled-by-default-v8.cpu_profiler.hires',
  'latencyInfo', 'loading', 'disabled-by-default-lighthouse',
  'v8.execute', 'v8',
];
```

#### Stop & Parse
1. Calls `page.tracing.stop()` → gets raw buffer
2. Optionally saves raw trace to file (`.json` or `.json.gz`)
3. Parses using `chrome-devtools-frontend` trace parser → extracts performance insights
4. Optionally fetches CrUX (Chrome User Experience Report) field data for comparison
5. Returns semantic summary with insights (not raw trace data)

### Lighthouse Integration

- Runs via Puppeteer's Lighthouse integration
- Categories: `accessibility`, `seo`, `best-practices` (NOT performance — uses trace for that)
- Supports `navigation` mode (reload + audit) and `snapshot` mode (current state)
- Generates HTML and JSON reports, saves to disk
- Returns structured summary with scores

### Heap Snapshots

- `take_memory_snapshot` → `page.captureHeapSnapshot({path: ...})`
- `load_memory_snapshot` (experimental) → loads saved snapshot, returns aggregated stats
- Uses `HeapSnapshotManager` for parsing/analysis via DevTools frontend code

---

## 10. Network & Console Monitoring

### PageCollector Pattern

Both network and console monitoring share a `PageCollector<T>` base class:

```typescript
class PageCollector<T> {
  // Per-page, per-navigation storage
  storage = new WeakMap<Page, Array<Array<T>>>();  // [newest_nav, ..., oldest_nav]
  maxNavigationSaved = 3;  // Keeps last 3 navigations

  // Auto-listens for new targets
  browser.on('targetcreated', this.#onTargetCreated);
  browser.on('targetdestroyed', this.#onTargetDestroyed);

  // Each item gets a stable sequential ID via symbol
  const stableIdSymbol = Symbol('stableIdSymbol');
}
```

### Key Features
- **Stable IDs**: Each network request / console message gets a monotonically increasing integer ID (`reqid`/`msgid`) that persists across tool calls
- **Navigation-aware**: On main frame navigation, data is split into a new bucket; old navigations are kept (up to 3)
- **Pagination**: `pageSize` + `pageIdx` parameters for large result sets
- **Filtering**: Network requests by `resourceTypes[]`, console messages by `types[]`
- **Preserved data**: `includePreservedRequests` / `includePreservedMessages` returns data across navigations

### Console Collection Extensions
- Regular console messages
- Uncaught errors (via `Runtime.exceptionThrown` CDP event)
- DevTools aggregated issues (via `IssueAggregator` from DevTools frontend)
- Source-mapped stack traces

### Network Collection
- Custom navigation splitting: on navigation, the navigation request itself stays with the new bucket
- Request/response bodies available via `get_network_request`
- Bodies can be saved to `.network-request` / `.network-response` files

---

## 11. Emulation System

### Single `emulate` Tool

All emulation is combined into one tool with optional parameters:
- **Network throttling**: Offline, Slow 3G, Fast 3G, Slow 4G, Fast 4G
- **CPU throttling**: 1x–20x slowdown factor
- **Geolocation**: `<lat>x<lon>` format (e.g., "37.7749x-122.4194")
- **User agent**: Arbitrary string
- **Color scheme**: dark/light/auto
- **Viewport**: `<w>x<h>x<dpr>[,mobile][,touch][,landscape]` format

### Emulation Persistence

Emulation settings are stored per-page on `McpPage.emulationSettings` and restored after operations that might reset them (e.g., Lighthouse audit).

### Adaptive Timeouts

When network/CPU throttling is active, wait timeouts are automatically scaled:
```typescript
this.#stableDomTimeout = 3000 * cpuTimeoutMultiplier;
this.#stableDomFor = 100 * cpuTimeoutMultiplier;
this.#navigationTimeout = 3000 * networkTimeoutMultiplier;
```

Network multipliers: Fast 4G → 1x, Slow 4G → 2.5x, Fast 3G → 5x, Slow 3G → 10x.

---

## 12. Error Handling & Resilience

### WaitForHelper — Smart Action Waiting

The `WaitForHelper` is a sophisticated system for waiting after actions:

```
Action (e.g., click)
  │
  ├── Concurrently: Wait for navigation to start (100ms window)
  │   └── If navigation detected: Wait for navigation complete
  │
  └── After action + optional navigation:
      └── Wait for DOM stability (MutationObserver settles for 100ms)
          └── Timeout: 3000ms * cpu_multiplier
```

#### DOM Stability Detection

Injects a `MutationObserver` into the page:
```typescript
const observer = new MutationObserver(callback);
observer.observe(document.body, {
  childList: true, subtree: true, attributes: true
});
// Resolves when no mutations for `stableDomFor` ms
```

### Error Patterns

1. **Stale Element**: `"Element with uid ${uid} no longer exists on the page."`
2. **No Snapshot**: `"No snapshot found for page. Use take_snapshot to capture one."`
3. **Element Not Found**: `"Element uid '${uid}' not found on page."`
4. **Action Timeout**: `"Failed to interact with element with uid ${uid}. The element did not become interactive within the configured timeout."`
5. **Browser Not Running**: `"Could not connect to Chrome. Check if Chrome is running..."`
6. **Dialog Auto-Handling**: `handleBeforeUnload` parameter on navigate_page accepts/dismisses dialogs

### Error Response Format

```typescript
catch (err) {
  return {
    content: [{ type: 'text', text: errorText }],
    isError: true,
  };
}
```

Errors include the `cause` chain for debugging.

### Resource Cleanup

- `ElementHandle.dispose()` is always called in `finally` blocks
- `McpPage.dispose()` removes dialog event listeners
- `PageCollector.dispose()` removes browser event listeners
- `AbortController` used in WaitForHelper for cleanup on errors

---

## 13. Session Management & Concurrency

### Tool Mutex (Serialization)

**Critical architectural decision**: All tool calls are serialized through a single FIFO mutex:

```typescript
const toolMutex = new Mutex();

// In registerTool:
const guard = await toolMutex.acquire();
try {
  // ... execute tool handler
} finally {
  guard.dispose(); // releases mutex
}
```

This means:
- Only one tool executes at a time
- No concurrent browser interactions
- No race conditions on shared state
- Simple but limits parallelism

### No Multi-Session Support

Chrome DevTools MCP has **NO session isolation concept**:
- Single browser instance
- Single `McpContext`
- Single selected page
- No tab locking
- No session IDs

This is a significant limitation for multi-agent scenarios.

### Page ID Routing (Experimental)

`--experimental-page-id-routing` adds a `pageId` parameter to all page-scoped tools, allowing tools to target specific pages without calling `select_page` first. But there's still no session isolation.

---

## 14. Slim Mode

Activated with `--slim` flag. Provides only 3 tools (~359 tokens for schema):

| Tool | Description |
|------|-------------|
| `screenshot` | Takes a screenshot (no parameters!) |
| `navigate` | Loads a URL (`url` parameter) |
| `evaluate` | Evaluates JS (`script` parameter) |

Slim mode:
- Uses `SlimMcpResponse` instead of `McpResponse`
- No snapshot system
- No uid-based interaction
- No network/console monitoring
- No emulation
- Minimal token footprint

---

## 15. Key Architectural Patterns

### 1. Response Builder Pattern (`McpResponse`)

The `McpResponse` class (35KB — largest file) is a response accumulator:
- Tools call methods like `appendResponseLine()`, `includeSnapshot()`, `setIncludeNetworkRequests()`
- After handler completes, `response.handle()` assembles final output
- Token-aware: truncates/summarizes based on output size
- Supports structured content (experimental)
- Manages image embedding vs file saving based on size (screenshots >2MB go to file)

### 2. Page-Scoped vs Global Tools

- `definePageTool` → receives `request.page` automatically (resolved from selected page or pageId)
- `defineTool` → receives only `request.params` and `context`

### 3. Factory Pattern for Conditional Tools

Tools can be defined as factories that receive CLI args:
```typescript
export const listPages = defineTool(args => {
  return {
    name: 'list_pages',
    description: `Get a list of pages${args?.categoryExtensions ? ' including extension service workers' : ''} open in the browser.`,
    ...
  };
});
```

### 4. DevTools Frontend Integration

The server bundles `chrome-devtools-frontend` code for:
- Performance trace parsing (same algorithm as DevTools Timeline panel)
- Issue aggregation
- CrUX data fetching
- Heap snapshot analysis

This is done via `PuppeteerDevToolsConnection` adapter that bridges Puppeteer's CDP sessions to DevTools frontend's expected interface.

### 5. Telemetry

Optional Google analytics via ClearcutLogger:
- Tool invocation counts and success rates
- Latency (bucketized)
- Client name detection
- Opt-out via `--no-usage-statistics`

---

## 16. Strengths & Weaknesses

### Strengths

| Area | Details |
|------|---------|
| **Deep Chrome integration** | Uses actual DevTools frontend code for trace parsing, issue aggregation |
| **Proven automation** | Built on Puppeteer with mature element interaction patterns |
| **Smart waiting** | WaitForHelper with DOM stability detection + navigation awareness |
| **Token optimization** | Semantic summaries, pagination, file offloading for large assets |
| **Lighthouse built-in** | Professional-grade auditing out of the box |
| **Emulation** | Comprehensive device/network/geo/color scheme emulation |
| **Error quality** | Actionable errors with context about what went wrong |
| **Multiple connection modes** | Launch, connect via URL, WebSocket, or auto-detect |
| **Preserved data** | Keeps last 3 navigations of network/console data |
| **Design principles** | Well-documented, intentional design decisions |

### Weaknesses

| Area | Details |
|------|---------|
| **No session isolation** | No multi-agent/multi-session support. Single selected page. |
| **No tab locking** | Any client can interact with any page |
| **Single mutex** | All tools serialized — no parallel tool execution |
| **Chrome-only** | Officially supports only Chrome (not Edge, Brave, etc.) |
| **No real-time monitoring** | No streaming of console/network events |
| **No request interception** | Can't mock/modify network requests |
| **No debugger** | No JavaScript breakpoints, stepping, call stack inspection |
| **No cookie management** | No get/set/delete cookies |
| **No storage management** | No localStorage/sessionStorage/IndexedDB access |
| **Heavy dependency** | Bundles Puppeteer + DevTools frontend + Lighthouse (~large package) |
| **No human-like interaction** | No mouse movement simulation, no typing delays |
| **Sequential-only fills** | fill_form processes fields sequentially |
| **Puppeteer abstraction tax** | Cannot directly use CDP for advanced features |

---

## 17. Opportunities for a Competing Server

Based on this analysis, a competing CDP-based MCP server can differentiate by providing:

### Must-Have Parity Features
1. ✅ A11y tree snapshots with uid-based interaction
2. ✅ Smart wait-after-action (navigation + DOM stability)
3. ✅ Element handle cleanup (dispose pattern)
4. ✅ Good error messages with context
5. ✅ Token-optimized responses
6. ✅ Screenshot with element/fullpage support
7. ✅ Console and network monitoring
8. ✅ Page management (list, select, new, close, navigate)
9. ✅ Emulation (viewport, network, geolocation, etc.)

### Differentiation Opportunities

| Feature | Chrome DevTools MCP | Opportunity |
|---------|-------------------|-------------|
| **Session isolation** | ❌ None | ✅ Full session/tab locking |
| **Multi-browser** | ❌ Chrome only | ✅ Chrome, Edge, Brave, all Chromium |
| **Request interception** | ❌ Not supported | ✅ Mock/modify/block requests |
| **JavaScript debugger** | ❌ Not supported | ✅ Breakpoints, stepping, call stack |
| **Cookie management** | ❌ Not supported | ✅ Full cookie CRUD |
| **Storage management** | ❌ Not supported | ✅ localStorage, IndexedDB, cache |
| **Human-like interaction** | ❌ Not supported | ✅ Bezier mouse paths, typing delays |
| **CDP direct access** | ❌ Puppeteer only | ✅ Direct CDP for advanced use |
| **Resource overrides** | ❌ Not supported | ✅ Override JS/CSS/HTML responses |
| **DOM breakpoints** | ❌ Not supported | ✅ Break on DOM mutation |
| **Parallel tool execution** | ❌ Single mutex | ✅ Per-tab concurrency |
| **Streaming events** | ❌ Not supported | ✅ Real-time console/network |
| **HAR export** | ❌ Not supported | ✅ Full HAR 1.2 export |
| **PDF export** | ❌ Not supported | ✅ Page to PDF |
| **CSS injection** | ❌ Not supported | ✅ Inject styles |
| **CSP bypass** | ❌ Not supported | ✅ Content Security Policy override |

### Tool Design Insights to Adopt

1. **`includeSnapshot` pattern** — optional post-action snapshot to save tokens
2. **`filePath` on heavy tools** — save to disk instead of inline return
3. **Pagination** — `pageSize` + `pageIdx` for large collections
4. **`includePreserved*`** — keep historical data across navigations
5. **Sequential uid** — simple integer IDs are more LLM-friendly than complex refs
6. **Category annotations** — enable/disable tool groups via flags
7. **Verb-based tool names** — `click`, `fill`, `hover` not `element_click`
8. **readOnlyHint** — tells LLM which tools are safe to call speculatively

### Architecture Insights to Adopt

1. **Response builder pattern** — accumulate response parts, assemble at end
2. **Per-page state** — emulation, snapshot, dialog stored on page wrapper
3. **Factory tools** — conditionally adjust tool descriptions based on config
4. **WaitForHelper** — the navigation detection + DOM stability pattern is excellent
5. **Throttle-aware timeouts** — auto-scale wait times based on emulation settings
6. **Target filtering** — ignore chrome://, extension pages by default
7. **Stable IDs with symbols** — WeakMap + Symbol for stable resource IDs

---

*Document generated for internal research purposes. Based on ChromeDevTools/chrome-devtools-mcp at commit ec895f1.*
