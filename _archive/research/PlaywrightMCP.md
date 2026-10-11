# Playwright MCP Server — Deep Architecture Research

> **Source**: `microsoft/playwright-mcp` v0.0.70 (wrapper) + `microsoft/playwright` (core implementation)
> **Research Date**: July 2025
> **Purpose**: Reference document for restructuring a competing CDP-based MCP server

---

## Table of Contents

1. [Repository Structure & Architecture](#1-repository-structure--architecture)
2. [Tool Design System](#2-tool-design-system)
3. [Browser Management & Lifecycle](#3-browser-management--lifecycle)
4. [Snapshot System & Element Refs](#4-snapshot-system--element-refs)
5. [Form Filling & Input Handling](#5-form-filling--input-handling)
6. [Error Handling & Modal States](#6-error-handling--modal-states)
7. [Session, Tab & Context Management](#7-session-tab--context-management)
8. [Response System & Output Design](#8-response-system--output-design)
9. [Performance & Lazy Initialization](#9-performance--lazy-initialization)
10. [Complete Tool Catalog](#10-complete-tool-catalog)
11. [Testing Infrastructure](#11-testing-infrastructure)
12. [Key Design Decisions & Takeaways](#12-key-design-decisions--takeaways)

---

## 1. Repository Structure & Architecture

### Monorepo Layout

```
microsoft/playwright-mcp/          ← Thin npm wrapper repo
├── packages/
│   ├── playwright-mcp/             ← @playwright/mcp npm package
│   │   ├── cli.js                  ← Entry point (delegates to playwright-core)
│   │   ├── index.js                ← Exports createConnection()
│   │   ├── package.json            ← Dependencies: playwright, playwright-core
│   │   └── src/README.md           ← "Source is in Playwright monorepo"
│   ├── extension/                  ← Chrome browser extension
│   └── playwright-cli-stub/        ← CLI stub package
└── package.json                    ← Root (workspaces: packages/*)

microsoft/playwright/               ← Actual source code lives here
└── packages/playwright-core/src/tools/
    ├── mcp/                        ← MCP server infrastructure
    │   ├── index.ts                ← createConnection() - main entry
    │   ├── browserFactory.ts       ← Browser launch/connect strategies
    │   ├── config.ts               ← Config resolution (CLI + env + file)
    │   ├── program.ts              ← CLI argument parsing
    │   ├── protocol.ts             ← Protocol version (currently 1)
    │   ├── extensionContextFactory.ts ← Browser extension connection
    │   ├── cdpRelay.ts             ← CDP relay for extension
    │   ├── log.ts                  ← Debug logging
    │   └── watchdog.ts             ← Process watchdog
    ├── backend/                    ← Tool implementations & core logic
    │   ├── browserBackend.ts       ← BrowserBackend class (tool dispatcher)
    │   ├── context.ts              ← Context class (browser context wrapper)
    │   ├── tab.ts                  ← Tab class (page wrapper)
    │   ├── tool.ts                 ← defineTool() / defineTabTool() helpers
    │   ├── tools.ts                ← Tool registry & filtering
    │   ├── response.ts             ← Response builder & serializer
    │   ├── snapshot.ts             ← Snapshot + click/hover/selectOption/drag
    │   ├── form.ts                 ← Form filling (browser_fill_form)
    │   ├── keyboard.ts             ← Type/press/pressSequentially
    │   ├── navigate.ts             ← Navigate/back/forward
    │   ├── tabs.ts                 ← Tab management (list/new/close/select)
    │   ├── evaluate.ts             ← JavaScript evaluation
    │   ├── runCode.ts              ← Run Playwright code snippets
    │   ├── screenshot.ts           ← Screenshot with auto-scaling
    │   ├── files.ts                ← File upload (fileChooser modal)
    │   ├── dialogs.ts              ← Dialog handling (alert/confirm/prompt)
    │   ├── network.ts              ← Network request listing
    │   ├── route.ts                ← Network mocking/routing
    │   ├── console.ts              ← Console message retrieval
    │   ├── cookies.ts              ← Cookie CRUD
    │   ├── storage.ts              ← Storage state save/restore
    │   ├── webstorage.ts           ← localStorage/sessionStorage
    │   ├── wait.ts                 ← Wait for text/time
    │   ├── common.ts               ← Close/resize browser
    │   ├── mouse.ts                ← Coordinate-based mouse (vision cap)
    │   ├── pdf.ts                  ← PDF generation (pdf cap)
    │   ├── devtools.ts             ← DevTools (highlight, tracing, video)
    │   ├── verify.ts               ← Test assertions (testing cap)
    │   ├── tracing.ts              ← Trace recording
    │   ├── video.ts                ← Video recording
    │   ├── config.ts               ← Config tool (config cap)
    │   ├── utils.ts                ← waitForCompletion() helper
    │   ├── logFile.ts              ← Console log file management
    │   └── sessionLog.ts           ← Session logging
    └── utils/mcp/
        ├── server.ts               ← MCP server creation & transport
        ├── tool.ts                 ← toMcpTool() schema conversion
        └── http.ts                 ← HTTP/SSE transport
```

### Key Architectural Insight

**The `@playwright/mcp` npm package is a thin wrapper.** All logic lives inside `playwright-core`:

```js
// packages/playwright-mcp/index.js — the ENTIRE module
const { tools } = require('playwright-core/lib/coreBundle');
module.exports = { createConnection: tools.createConnection };
```

This means the MCP server shares code with Playwright's testing framework — same browser management, same locator engine, same accessibility tree code.

---

## 2. Tool Design System

### Two Tool Types

Playwright MCP uses two tool definition patterns:

#### `defineTool()` — Context-level tools
For tools that don't require a specific page/tab (navigation, close, wait, tabs):

```typescript
const navigate = defineTool({
  capability: 'core-navigation',
  schema: {
    name: 'browser_navigate',
    title: 'Navigate to a URL',
    description: 'Navigate to a URL',
    inputSchema: z.object({
      url: z.string().describe('The URL to navigate to')
    }),
    type: 'action'           // action | readOnly | input | assertion
  },
  handle: async (context, params, response) => {
    const tab = await context.ensureTab();
    // ...
  }
});
```

#### `defineTabTool()` — Tab-level tools
For tools that operate on a specific page/tab. Includes automatic **modal state checking**:

```typescript
const click = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_click',
    title: 'Click',
    description: 'Perform click on a web page',
    inputSchema: clickSchema,
    type: 'input'
  },
  handle: async (tab, params, response) => {
    // tab is guaranteed to exist and have no blocking modal states
  },
  clearsModalState: undefined  // or 'dialog' or 'fileChooser'
});
```

The `defineTabTool` wrapper automatically:
1. Calls `context.ensureTab()` to get current tab
2. Checks for modal states (dialogs, file choosers)
3. **Blocks tools that don't handle modal state** when one is present
4. Only allows tools with matching `clearsModalState` to proceed

```typescript
// The defineTabTool wrapper implementation
function defineTabTool(tool) {
  return {
    ...tool,
    handle: async (context, params, response) => {
      const tab = await context.ensureTab();
      const modalStates = tab.modalStates().map(state => state.type);
      
      if (tool.clearsModalState && !modalStates.includes(tool.clearsModalState))
        response.addError(`Tool "${tool.schema.name}" can only be used when modal state is present.`);
      else if (!tool.clearsModalState && modalStates.length)
        response.addError(`Tool "${tool.schema.name}" does not handle the modal state.`);
      else
        return tool.handle(tab, params, response);
    }
  };
}
```

### Tool Type System

Each tool has a `type` field that maps to MCP annotations:

| Type | `readOnlyHint` | `destructiveHint` | Usage |
|------|---------------|-------------------|-------|
| `readOnly` | true | false | Snapshots, screenshots, console, network |
| `assertion` | true | false | Wait, verify tools |
| `input` | false | true | Click, type, fill, hover |
| `action` | false | true | Navigate, close, evaluate, tabs |

### Capability-Based Tool Filtering

Tools are grouped by capability strings. Only `core*` tools are enabled by default:

```typescript
function filteredTools(config) {
  return browserTools
    .filter(tool => 
      tool.capability.startsWith('core') || 
      config.capabilities?.includes(tool.capability)
    )
    .filter(tool => !tool.skillOnly)  // Filter out skill-only tools in MCP mode
    .map(tool => ({
      ...tool,
      schema: {
        ...tool.schema,
        // Remove 'selector' params from MCP tools (ref-only in MCP mode)
        inputSchema: tool.schema.inputSchema
          .extend({ selector: z.string(), startSelector: z.string(), endSelector: z.string() })
          .omit({ selector: true, startSelector: true, endSelector: true })
      }
    }));
}
```

Capabilities:
- `core`, `core-input`, `core-navigation`, `core-tabs` — Always enabled
- `vision` — Coordinate-based mouse tools (opt-in via `--caps=vision`)
- `pdf` — PDF generation (opt-in via `--caps=pdf`)
- `devtools` — DevTools features like highlight, tracing, video (opt-in via `--caps=devtools`)
- `testing` — Test assertion tools (opt-in via `--caps=testing`)
- `network` — Network mocking/routing (opt-in via `--caps=network`)
- `storage` — Cookie/localStorage/sessionStorage CRUD (opt-in via `--caps=storage`)
- `config` — Config introspection tool (opt-in via `--caps=config`)

### Schema System (Zod)

All schemas use **Zod** for validation. Conversion to MCP JSON Schema:

```typescript
function toMcpTool(tool) {
  const readOnly = tool.type === 'readOnly' || tool.type === 'assertion';
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema),  // Zod → JSON Schema
    annotations: {
      title: tool.title,
      readOnlyHint: readOnly,
      destructiveHint: !readOnly,
      openWorldHint: true
    }
  };
}
```

### Skill-Only Tools

Some tools are marked `skillOnly: true` and are excluded from MCP mode (available only in CLI/skill mode):
- `browser_check`, `browser_uncheck`
- `browser_navigate_forward`, `browser_reload`
- `browser_press_sequentially`
- `browser_keydown`, `browser_keyup`
- `browser_network_clear`

---

## 3. Browser Management & Lifecycle

### Four Browser Creation Strategies

```typescript
async function createBrowserWithInfo(config, clientInfo) {
  if (config.browser.remoteEndpoint)
    return await createRemoteBrowser(config);     // Connect to remote Playwright server
  if (config.browser.cdpEndpoint)
    return await createCDPBrowser(config);         // Connect via CDP
  if (config.browser.isolated)
    return await createIsolatedBrowser(config);    // Launch fresh, disposable
  if (config.extension)
    return await createExtensionBrowser(config);   // Connect to running browser via extension
  return await createPersistentBrowser(config);    // Default: persistent user data dir
}
```

#### 1. Persistent Browser (Default)
- Uses `browserType.launchPersistentContext(userDataDir, options)`
- User data dir is auto-computed: `mcp-{channel}-{hash(workspace)}`
- Stored in platform-specific cache directory
- **Profile lock detection**: checks for `lockfile` (Windows) or `SingletonLock` (Linux/Mac) up to 5 times with 1s intervals
- Allows `--ignore-default-args=["--disable-extensions"]` for browser extensions
- Error handling for: ProcessSingleton conflicts, missing executables, missing system deps

```typescript
async function createPersistentBrowser(config, clientInfo) {
  const userDataDir = config.browser.userDataDir ?? await createUserDataDir(config, clientInfo);
  const browserType = playwright[config.browser.browserName];
  
  const browserContext = await browserType.launchPersistentContext(userDataDir, {
    tracesDir,
    ...config.browser.launchOptions,
    ...config.browser.contextOptions,
    handleSIGINT: false,
    handleSIGTERM: false,
    ignoreDefaultArgs: ['--disable-extensions']
  });
  
  return browserContext.browser();
}
```

#### 2. Isolated Browser
- Uses `browserType.launch()` — no persistent state
- Each session is fresh; closing browser loses all state
- Can provide initial `storageState` via config
- Useful for testing/automation scenarios

#### 3. CDP Connection
- Uses `playwright.chromium.connectOverCDP(endpoint, { headers, timeout })`
- Connects to existing browser via Chrome DevTools Protocol
- Chromium-family only

#### 4. Remote Playwright Server
- Connects to a remote Playwright server endpoint
- Uses server registry to find and connect across versions

#### 5. Browser Extension
- Connects to running Chrome/Edge via the Playwright Extension
- Uses `extensionContextFactory.ts` and CDP relay

### User Data Dir Computation

```typescript
// Profile path: {cacheDir}/mcp-{browser}-{workspaceHash}
async function createUserDataDir(config, clientInfo) {
  const browserToken = config.browser.launchOptions?.channel ?? config.browser?.browserName;
  const rootPathToken = createHash(clientInfo.cwd); // SHA256, first 7 chars
  return path.join(registryDirectory, `mcp-${browserToken}-${rootPathToken}`);
}
```

Locations:
- Windows: `%USERPROFILE%\AppData\Local\ms-playwright\mcp-{channel}-{hash}`
- macOS: `~/Library/Caches/ms-playwright/mcp-{channel}-{hash}`
- Linux: `~/.cache/ms-playwright/mcp-{channel}-{hash}`

### Config Resolution

Config is resolved through a 3-layer merge:
1. **Default config** (action timeout 5s, navigation timeout 60s)
2. **Config file** (JSON or INI format, via `--config`)
3. **Environment variables** (all `PLAYWRIGHT_MCP_*`)
4. **CLI arguments** (highest priority)

Default browser is **Chromium with Chrome channel** (not raw Chromium):
```typescript
if (!browserName) {
  browserName = 'chromium';
  if (browser.launchOptions.channel === undefined)
    browser.launchOptions.channel = 'chrome';
}
```

Headless default: Only headless on Linux without `$DISPLAY`.

---

## 4. Snapshot System & Element Refs

### How Snapshots Work

The snapshot is Playwright's **accessibility tree** (`ariaSnapshot`) — a YAML-like structure representing the page's accessible elements:

```typescript
// Tab.captureSnapshot()
async captureSnapshot(selector, depth, relativeTo) {
  await this._initializedPromise;
  let tabSnapshot;
  
  const modalStates = await this._raceAgainstModalStates(async () => {
    // Uses Playwright's built-in ariaSnapshot with 'ai' mode
    const ariaSnapshot = selector
      ? await this.page.locator(selector).ariaSnapshot({ mode: 'ai', depth })
      : await this.page.ariaSnapshot({ mode: 'ai', depth });
    
    tabSnapshot = {
      ariaSnapshot,
      modalStates: [],
      events: []
    };
  });
  
  if (tabSnapshot) {
    tabSnapshot.consoleLink = await this._consoleLog.take(relativeTo);
    tabSnapshot.events = this._recentEventEntries;
    this._recentEventEntries = [];
  }
  
  return tabSnapshot ?? { ariaSnapshot: '', modalStates, events: [] };
}
```

Key insights:
- Uses `mode: 'ai'` which generates an **LLM-optimized** accessibility tree
- Can be scoped to a CSS selector subtree
- Can be depth-limited
- Races against modal states (dialogs) which block JS execution
- Returns YAML format, e.g.:
  ```yaml
  - navigation "Main Menu":
    - link "Home" [ref=s1e3]
    - link "About" [ref=s1e4]
  - main:
    - heading "Welcome" [level=1]
    - textbox "Email" [ref=s1e7]
    - button "Submit" [ref=s1e8]
  ```

### The Ref System

Elements get **refs** like `s1e3` (snapshot 1, element 3). These are used to locate elements:

```typescript
// Tab.refLocator() — resolves a ref to a Playwright locator
async refLocator(params) {
  if (params.selector) {
    // CSS/role selector path (only available in skill mode)
    const selector = locatorOrSelectorAsSelector('javascript', params.selector, testIdAttribute);
    return { locator: this.page.locator(selector), resolved: asLocator('javascript', selector) };
  } else {
    // Ref path (standard MCP mode)
    let locator = this.page.locator(`aria-ref=${params.ref}`);
    if (params.element)
      locator = locator.describe(params.element);
    const resolved = await locator.normalize();
    return { locator, resolved: resolved.toString() };
  }
}
```

**Critical**: The `aria-ref=` selector is a Playwright-internal selector engine that maps accessibility snapshot refs back to DOM elements. This is the bridge between the YAML snapshot and actual page interaction.

Error handling for stale refs:
```typescript
catch (e) {
  throw new Error(`Ref ${params.ref} not found in the current page snapshot. Try capturing new snapshot.`);
}
```

### Element Schema (Used by Most Interaction Tools)

```typescript
const elementSchema = z.object({
  element: z.string().optional().describe('Human-readable element description used to obtain permission'),
  ref: z.string().describe('Exact target element reference from the page snapshot'),
  selector: z.string().optional().describe('CSS or role selector when "ref" is not available')
});
```

**In MCP mode, `selector` is stripped from the schema** (only `ref` is exposed), keeping the LLM focused on using snapshot refs. Selectors are only available in skill/CLI mode.

### Snapshot Inclusion in Responses

Tools control when snapshots are included:
- `response.setIncludeSnapshot()` — include snapshot in this response (default mode from config)
- `response.setIncludeFullSnapshot(filename, selector, depth)` — explicit full snapshot
- Snapshot mode can be `'full'`, `'none'`, or `'explicit'`
- Snapshots are also returned when tab headers change (URL, title)
- Snapshot can be saved to file or returned inline as YAML code block

---

## 5. Form Filling & Input Handling

### browser_fill_form — The Unified Form Tool

This is the most versatile form interaction tool, handling ALL field types in a single call:

```typescript
const fillForm = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_fill_form',
    title: 'Fill form',
    description: 'Fill multiple form fields',
    inputSchema: z.object({
      fields: z.array(z.object({
        name: z.string().describe('Human-readable field name'),
        type: z.enum(['textbox', 'checkbox', 'radio', 'combobox', 'slider']).describe('Type of the field'),
        ref: z.string().describe('Exact target field reference from the page snapshot'),
        selector: z.string().optional(),
        value: z.string().describe('Value to fill. Checkbox: "true"/"false". Combobox: text of option.')
      })).describe('Fields to fill in')
    }),
    type: 'input'
  },
  
  handle: async (tab, params, response) => {
    for (const field of params.fields) {
      const { locator, resolved } = await tab.refLocator({
        element: field.name, ref: field.ref, selector: field.selector
      });
      
      if (field.type === 'textbox' || field.type === 'slider') {
        const secret = tab.context.lookupSecret(field.value);
        await locator.fill(secret.value, tab.actionTimeoutOptions);
      } 
      else if (field.type === 'checkbox' || field.type === 'radio') {
        await locator.setChecked(field.value === 'true', tab.actionTimeoutOptions);
      } 
      else if (field.type === 'combobox') {
        await locator.selectOption({ label: field.value }, tab.actionTimeoutOptions);
      }
    }
  }
});
```

### Why It's Effective

1. **Unified interface**: One tool call fills an entire form — textboxes, checkboxes, radios, dropdowns, sliders
2. **Type-aware**: The LLM specifies the field type from the snapshot, and the tool uses the correct Playwright method:
   - `textbox/slider` → `locator.fill()`
   - `checkbox/radio` → `locator.setChecked()`
   - `combobox` → `locator.selectOption({ label: value })`
3. **Secret handling**: Values are looked up against configured secrets to prevent LLM exposure
4. **Batch operation**: Multiple fields in one call reduces round-trips

### browser_type — Text Input

```typescript
handle: async (tab, params, response) => {
  const { locator, resolved } = await tab.refLocator(params);
  const secret = tab.context.lookupSecret(params.text);
  
  if (params.slowly) {
    // Character-by-character for triggering key handlers
    await locator.pressSequentially(secret.value, tab.actionTimeoutOptions);
  } else {
    // Fast fill (replaces entire content)
    await locator.fill(secret.value, tab.actionTimeoutOptions);
  }
  
  if (params.submit) {
    await locator.press('Enter', tab.actionTimeoutOptions);
  }
}
```

### File Upload — Modal State Pattern

File uploads use the **modal state** pattern. When a file chooser dialog opens:

1. Playwright emits a `filechooser` event
2. Tab pushes a `fileChooser` modal state
3. All other tools are BLOCKED until the file chooser is handled
4. Only `browser_file_upload` (with `clearsModalState: 'fileChooser'`) can proceed
5. It calls `fileChooser.setFiles(paths)` to upload

```typescript
// On page event
page.on('filechooser', chooser => {
  this.setModalState({
    type: 'fileChooser',
    description: 'File chooser',
    fileChooser: chooser,
    clearedBy: { tool: 'browser_file_upload', skill: 'upload' }
  });
});

// Upload tool
const uploadFile = defineTabTool({
  clearsModalState: 'fileChooser',  // Only this tool can handle file choosers
  handle: async (tab, params, response) => {
    const modalState = tab.modalStates().find(s => s.type === 'fileChooser');
    if (!modalState) throw new Error('No file chooser visible');
    tab.clearModalState(modalState);
    await modalState.fileChooser.setFiles(params.paths);
  }
});
```

---

## 6. Error Handling & Modal States

### Modal State System

This is one of the most clever patterns in the architecture. Modal states represent situations where the browser is blocked (dialog, file chooser) and normal tools can't work:

```typescript
interface ModalState {
  type: 'dialog' | 'fileChooser';
  description: string;
  dialog?: Dialog;
  fileChooser?: FileChooser;
  clearedBy: { tool: string; skill: string };
}
```

When a modal state exists:
- **Regular tools**: Get error message "Tool X does not handle the modal state"
- **Clearing tools**: Only the tool with matching `clearsModalState` can proceed
- **LLM guidance**: Response includes "Modal state: [File chooser] can be handled by browser_file_upload"

### Race Against Modal States

When capturing snapshots or performing actions, there's a race condition: a dialog might appear mid-action. The `_raceAgainstModalStates()` method handles this:

```typescript
async _raceAgainstModalStates(action) {
  if (this.modalStates().length)
    return this.modalStates();  // Already in modal state
  
  const promise = new ManualPromise();
  const listener = (modalState) => promise.resolve([modalState]);
  this.once(TabEvents.modalState, listener);
  
  return await Promise.race([
    action().then(() => {
      this.off(TabEvents.modalState, listener);
      return [];  // Action completed normally
    }),
    promise   // Modal state appeared during action
  ]);
}
```

### waitForCompletion()

After any action that might trigger navigation or network requests, tools use `waitForCompletion()`:

```typescript
async function waitForCompletion(tab, callback) {
  const requests = [];
  tab.page.on('request', request => requests.push(request));
  
  try {
    await callback();
    await tab.waitForTimeout(500);  // Brief pause for async effects
  } finally {
    tab.page.off('request', requestListener);
  }
  
  // If a navigation was triggered, wait for load
  const requestedNavigation = requests.some(r => r.isNavigationRequest());
  if (requestedNavigation) {
    await tab.page.mainFrame().waitForLoadState('load', { timeout: 10000 }).catch(() => {});
    return;
  }
  
  // Otherwise wait for pending fetch/xhr/script requests
  const promises = [];
  for (const request of requests) {
    if (['document', 'stylesheet', 'script', 'xhr', 'fetch'].includes(request.resourceType()))
      promises.push(request.response().then(r => r?.finished()).catch(() => {}));
    else
      promises.push(request.response().catch(() => {}));
  }
  
  const timeout = new Promise(resolve => setTimeout(resolve, 5000));
  await Promise.race([Promise.all(promises), timeout]);
  
  if (requests.length) await tab.waitForTimeout(500);
}
```

Key pattern: **tracks all requests during callback, then waits for them to complete** with a 5s timeout. This is why actions "just work" — the tool automatically waits for SPA transitions, AJAX calls, etc.

### Stale Element Handling

When a ref is not found:
```typescript
throw new Error(`Ref ${params.ref} not found in the current page snapshot. Try capturing new snapshot.`);
```

The LLM learns to take a fresh snapshot when refs go stale.

### Navigation Error Handling (Downloads)

Navigations that trigger downloads get special treatment:
```typescript
try {
  await this.page.goto(url, { waitUntil: 'domcontentloaded', ...this.navigationTimeoutOptions });
} catch (e) {
  const mightBeDownload = e.message.includes('net::ERR_ABORTED') || e.message.includes('Download is starting');
  if (!mightBeDownload) throw e;
  const download = await downloadEvent;  // Wait for download event
  if (!download) throw e;
  await new Promise(resolve => setTimeout(resolve, 500));
}
```

---

## 7. Session, Tab & Context Management

### Architecture Layers

```
MCP Server (server.ts)
  └── BackendManager
       └── BrowserBackend (browserBackend.ts)
            └── Context (context.ts)
                 └── Tab[] (tab.ts)
                      └── Page (Playwright Page)
```

### Context Class

The Context wraps a Playwright BrowserContext and manages all tabs:

```typescript
class Context {
  _tabs: Tab[] = [];
  _currentTab: Tab | undefined;
  _routes: RouteEntry[] = [];
  _browserContextPromise: Promise<BrowserContext> | undefined;
  
  // Lazy initialization — browser context is created on first use
  async ensureBrowserContext() {
    if (this._browserContextPromise) return this._browserContextPromise;
    this._browserContextPromise = this._initializeBrowserContext();
    return this._browserContextPromise;
  }
  
  // Tab management
  async ensureTab() {          // Create tab if none exists
    const ctx = await this.ensureBrowserContext();
    if (!this._currentTab) await ctx.newPage();
    return this._currentTab!;
  }
  
  async newTab() { ... }       // Create new tab
  async selectTab(index) { ... }  // Switch to tab by index
  async closeTab(index) { ... }   // Close tab
}
```

### Tab Class

Each Tab wraps a Playwright Page and manages:
- Console messages (via `LogFile`)
- Network requests (tracked in-memory)
- Modal states (dialogs, file choosers)
- Downloads (auto-saved to output dir)
- Event log (recent events for response)

```typescript
class Tab extends EventEmitter {
  constructor(context, page, onPageClose) {
    // Register all page event listeners
    page.on('console', event => this._handleConsoleMessage(...));
    page.on('pageerror', error => this._handleConsoleMessage(...));
    page.on('request', request => this._handleRequest(request));
    page.on('response', response => this._handleResponse(response));
    page.on('requestfailed', request => this._handleRequestFailed(request));
    page.on('close', () => this._onClose());
    page.on('filechooser', chooser => this.setModalState({...}));
    page.on('dialog', dialog => this._dialogShown(dialog));
    page.on('download', download => this._downloadStarted(download));
    
    // Timeout configuration
    this.actionTimeoutOptions = { timeout: context.config.timeouts?.action };      // 5s
    this.navigationTimeoutOptions = { timeout: context.config.timeouts?.navigation }; // 60s
  }
}
```

### Browser Context Initialization

Done lazily on first tool call:

```typescript
async _initializeBrowserContext() {
  // Set test ID attribute if configured
  if (this.config.testIdAttribute)
    selectors.setTestIdAttribute(this.config.testIdAttribute);
  
  // Setup request interception (allowed/blocked origins)
  await this._setupRequestInterception(browserContext);
  
  // Start tracing if configured
  if (this.config.saveTrace)
    await browserContext.tracing.start({ screenshots: true, snapshots: true, live: true });
  
  // Add init scripts
  for (const initScript of this.config.browser?.initScript || [])
    await browserContext.addInitScript({ path: initScript });
  
  // Register existing pages
  for (const page of browserContext.pages())
    this._onPageCreated(page);
  
  // Listen for new pages
  browserContext.on('page', page => this._onPageCreated(page));
}
```

### Tab Management (browser_tabs)

Simple unified tool:

```typescript
const browserTabs = defineTool({
  name: 'browser_tabs',
  inputSchema: z.object({
    action: z.enum(['list', 'new', 'close', 'select']),
    index: z.number().optional()
  }),
  handle: async (context, params, response) => {
    switch (params.action) {
      case 'list':   await context.ensureTab(); break;
      case 'new':    await context.newTab(); break;
      case 'close':  await context.closeTab(params.index); break;
      case 'select': await context.selectTab(params.index); break;
    }
    // Return list of all tabs
    const tabHeaders = await Promise.all(context.tabs().map(tab => tab.headerSnapshot()));
    response.addTextResult(renderTabsMarkdown(tabHeaders).join('\n'));
  }
});
```

Tab header format:
```markdown
- 0: (current) [Google](https://google.com)
- 1: [GitHub](https://github.com)
```

### Closing Behavior

When `browser_close` is called:
- Response sets `isClose: true`
- Server detects `isClose` and calls `backendManager.disposeBackend(backend)`
- Backend disposes context, tabs, stops video recording
- Backend promise is cleared — next tool call creates fresh backend

---

## 8. Response System & Output Design

### Response Builder Pattern

Every tool receives a `Response` object that builds structured markdown output:

```typescript
class Response {
  _results: string[] = [];
  _errors: string[] = [];
  _code: string[] = [];
  _imageResults: ImageResult[] = [];
  _includeSnapshot: 'none' | 'full' | 'explicit' = 'none';
  
  addTextResult(text) { ... }
  addError(error) { ... }
  addCode(code) { ... }
  setIncludeSnapshot() { ... }
  registerImageResult(data, imageType) { ... }
  async resolveClientFile(template, title) { ... }
}
```

### Response Serialization Format

The response is serialized into **structured markdown sections**:

```markdown
### Error
<error messages>

### Result
<text results>

### Ran Playwright code
```js
await page.getByRole('button', { name: 'Submit' }).click();
```

### Open tabs
- 0: (current) [Page Title](https://url.com)
- 1: [Other Tab](https://other.com)

### Page
- Page URL: https://url.com
- Page Title: My Page
- Console: 2 errors, 1 warnings

### Modal state
- ["alert" dialog with message "Are you sure?"]: can be handled by browser_handle_dialog

### Snapshot
```yaml
<accessibility tree YAML>
```

### Events
- New console entries: .playwright-mcp/console-1234.log
- Downloaded file report.pdf to "./downloads/report.pdf"
```

### Code Generation

Every tool call generates corresponding Playwright code:

```typescript
// In click handler
response.addCode(`await page.${resolved}.click(${optionsArg});`);

// In fill handler
response.addCode(`await page.${resolved}.fill(${secret.code});`);

// In navigate handler
response.addCode(`await page.goto('${url}');`);
```

This is controlled by `config.codegen` (default: `'typescript'`, can be `'none'`).

### Secret Redaction

Secrets are redacted in all response text:

```typescript
_redactSecrets(text) {
  for (const [secretName, secretValue] of Object.entries(this._context.config.secrets ?? {})) {
    text = text.replaceAll(secretValue, `<secret>${secretName}</secret>`);
  }
  return text;
}
```

### Screenshot Scaling

Screenshots are automatically scaled to fit MCP message limits:

```typescript
function scaleImageToFitMessage(buffer, imageType) {
  const image = imageType === 'png' ? PNG.sync.read(buffer) : jpegjs.decode(buffer);
  const pixels = image.width * image.height;
  const shrink = Math.min(
    1568 / image.width,
    1568 / image.height,
    Math.sqrt(1.15 * 1024 * 1024 / pixels)
  );
  if (shrink > 1) return buffer;  // Already small enough
  // Scale down...
}
```

Max dimensions: 1568×1568 pixels, ~1.15MP total.

### Snapshot Inclusion Logic

Snapshots are conditionally included:
1. **After actions** (click, type, navigate): `response.setIncludeSnapshot()` → uses config mode
2. **Explicit snapshot tool**: `response.setIncludeFullSnapshot()` → always full
3. **When tabs change**: If URL/title/console counts changed, include page info
4. **Tab list**: Only shown when multiple tabs exist

---

## 9. Performance & Lazy Initialization

### Lazy Backend Creation

The MCP server doesn't launch a browser until the first tool is called:

```typescript
// In server.ts — CallTool handler
if (!backendPromise) {
  backendPromise = initializeServer(server, factory, runHeartbeat).catch(e => {
    backendPromise = undefined;
    throw e;
  });
}
const backend = await backendPromise;
```

### Lazy Browser Context

Even after backend creation, the browser context is only initialized when needed:

```typescript
async ensureBrowserContext() {
  if (this._browserContextPromise) return this._browserContextPromise;
  this._browserContextPromise = this._initializeBrowserContext();
  return this._browserContextPromise;
}
```

### Lazy Tab Creation

Tabs are only created when explicitly needed:

```typescript
async ensureTab() {
  const ctx = await this.ensureBrowserContext();
  if (!this._currentTab) await ctx.newPage();
  return this._currentTab!;
}
```

### Heartbeat for Connection Health

```typescript
const startHeartbeat = (server) => {
  const beat = () => {
    Promise.race([
      server.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 5000))
    ]).then(() => setTimeout(beat, 3000))
      .catch(() => void server.close());
  };
  beat();
};
```

3-second ping interval, 5-second timeout.

### Text Part Merging

Multiple text parts are merged to reduce response overhead:

```typescript
function mergeTextParts(result) {
  const content = [];
  const textParts = [];
  for (const part of result.content) {
    if (part.type === 'text') { textParts.push(part.text); continue; }
    if (textParts.length > 0) {
      content.push({ type: 'text', text: textParts.join('\n') });
      textParts.length = 0;
    }
    content.push(part);
  }
  if (textParts.length > 0)
    content.push({ type: 'text', text: textParts.join('\n') });
  return { ...result, content };
}
```

### Request Tracking Efficiency

Network requests are tracked in-memory without heavy processing. Only rendered on demand:

```typescript
_handleRequest(request) {
  this._requests.push(request);  // Just push the Playwright request object
}
```

Console messages use a `LogFile` class that writes to disk asynchronously, keeping in-memory footprint small.

---

## 10. Complete Tool Catalog

### Core Tools (Always Enabled)

| Tool | Type | Category | Description |
|------|------|----------|-------------|
| `browser_snapshot` | readOnly | Snapshot | Accessibility tree capture |
| `browser_click` | input | Interaction | Click element by ref |
| `browser_hover` | input | Interaction | Hover over element |
| `browser_drag` | input | Interaction | Drag and drop between elements |
| `browser_select_option` | input | Interaction | Select dropdown option |
| `browser_type` | input | Input | Type text into element |
| `browser_press_key` | input | Input | Press keyboard key |
| `browser_fill_form` | input | Form | Fill multiple form fields |
| `browser_file_upload` | action | File | Upload files (modal state) |
| `browser_handle_dialog` | action | Dialog | Accept/dismiss dialogs (modal state) |
| `browser_navigate` | action | Navigation | Navigate to URL |
| `browser_navigate_back` | action | Navigation | Go back |
| `browser_tabs` | action | Tabs | List/new/close/select tabs |
| `browser_close` | action | Lifecycle | Close browser |
| `browser_resize` | action | Viewport | Resize browser window |
| `browser_evaluate` | action | JS | Evaluate JavaScript |
| `browser_run_code` | action | JS | Run Playwright code snippet |
| `browser_take_screenshot` | readOnly | Capture | Screenshot (viewport/element/fullpage) |
| `browser_console_messages` | readOnly | Debug | Get console messages |
| `browser_network_requests` | readOnly | Debug | List network requests |
| `browser_wait_for` | assertion | Wait | Wait for text/time |

### Opt-in Capabilities

| Capability | Tools |
|-----------|-------|
| `vision` | `browser_mouse_click_xy`, `browser_mouse_move_xy`, `browser_mouse_drag_xy`, `browser_mouse_down`, `browser_mouse_up`, `browser_mouse_wheel` |
| `pdf` | `browser_pdf_save` |
| `devtools` | `browser_highlight`, `browser_hide_highlight`, `browser_pick_locator`, `browser_resume`, `browser_start_tracing`, `browser_stop_tracing`, `browser_start_video`, `browser_stop_video`, `browser_video_chapter` |
| `testing` | `browser_generate_locator`, `browser_verify_element_visible`, `browser_verify_text_visible`, `browser_verify_list_visible`, `browser_verify_value` |
| `network` | `browser_route`, `browser_route_list`, `browser_unroute`, `browser_network_state_set` |
| `storage` | `browser_cookie_get`, `browser_cookie_set`, `browser_cookie_delete`, `browser_cookie_list`, `browser_cookie_clear`, `browser_localstorage_*`, `browser_sessionstorage_*`, `browser_storage_state`, `browser_set_storage_state` |
| `config` | `browser_get_config` |

### Skill-Only Tools (Not in MCP mode)

| Tool | Description |
|------|-------------|
| `browser_check` | Check checkbox/radio |
| `browser_uncheck` | Uncheck checkbox/radio |
| `browser_navigate_forward` | Navigate forward |
| `browser_reload` | Reload page |
| `browser_press_sequentially` | Type text key by key |
| `browser_keydown` | Press key down |
| `browser_keyup` | Press key up |
| `browser_network_clear` | Clear tracked network requests |

---

## 11. Testing Infrastructure

### Test Setup

```json
// packages/playwright-mcp/package.json
{
  "scripts": {
    "test": "playwright test",
    "ctest": "playwright test --project=chrome",
    "ftest": "playwright test --project=firefox",
    "wtest": "playwright test --project=webkit",
    "dtest": "MCP_IN_DOCKER=1 playwright test --project=chromium-docker"
  },
  "devDependencies": {
    "@playwright/test": "1.60.0-alpha-1776382637000",
    "@modelcontextprotocol/sdk": "^1.25.2"
  }
}
```

### Multi-Browser Testing

Tests run across:
- **Chrome** (default channel)
- **Firefox**
- **WebKit**
- **Chromium in Docker** (headless, no sandbox)

### Response Parsing for Tests

The `parseResponse()` function decomposes tool responses back into structured data:

```typescript
function parseResponse(response, cwd) {
  const sections = parseSections(text);  // Parse by "### " headers
  return {
    result: sections.get('Result'),
    error: sections.get('Error'),
    code: sections.get('Ran Playwright code'),
    tabs: sections.get('Open tabs'),
    page: sections.get('Page'),
    snapshot: /* loaded from file if path */,
    inlineSnapshot: /* from YAML block */,
    events: sections.get('Events'),
    modalState: sections.get('Modal state'),
    paused: sections.get('Paused'),
    isError: response.isError,
    attachments: response.content.slice(1),  // Images etc.
  };
}
```

---

## 12. Key Design Decisions & Takeaways

### 1. Accessibility Tree > Screenshots
- No vision models needed
- Deterministic element targeting
- Structured, parseable output
- Token-efficient (YAML vs base64 images)

### 2. Ref-Based Element Targeting
- Unique refs from snapshot (`s1e3`) map directly to DOM elements
- `aria-ref=` selector engine built into Playwright
- Stale refs → clear error message → LLM takes fresh snapshot
- **Selectors are hidden in MCP mode** to force ref usage

### 3. Modal State as a First-Class Concept
- Dialogs and file choosers BLOCK all other tools
- Only the designated handler tool can proceed
- LLM gets explicit guidance on what tool to use
- Prevents tool misuse and confusing errors

### 4. Auto-Completion Waiting
- Every mutating action tracks triggered requests
- Automatically waits for navigations, AJAX, etc.
- 500ms pause + up to 5s for request completion
- Eliminates need for explicit waits in most cases

### 5. Lazy Everything
- Browser not launched until first tool call
- Context not created until needed
- Tab not opened until needed
- MCP tool schemas loaded once at startup

### 6. Code Generation as Documentation
- Every tool call emits corresponding Playwright code
- Users get reproducible automation scripts
- Useful for test generation workflows

### 7. Structured Response Format
- Markdown sections with `### ` headers
- Machine-parseable (for testing/integration)
- Human-readable (for debugging)
- Consistent across all tools

### 8. Security Guardrails
- URL allow/block lists for network requests
- File access restricted to workspace/output dirs
- Secret redaction in all outputs
- No `file://` protocol by default

### 9. Tool Minimalism
- Only ~20 tools in default mode (core)
- Additional tools gated behind capabilities
- Each tool has a clear, focused purpose
- `browser_fill_form` as a single multi-field tool vs separate tools per field type

### 10. Configuration Layering
- Defaults → config file (JSON/INI) → env vars → CLI args
- Every option available via env var (`PLAYWRIGHT_MCP_*`)
- Config file supports full Playwright launch/context options
- Workspace-scoped browser profiles (different project = different profile)

---

## Comparison: Playwright MCP vs CDP-Based Approach

| Aspect | Playwright MCP | CDP-Based (like cdp-browser-mcp-server) |
|--------|---------------|--------------------------------------|
| Browser connection | Launch own or connect via CDP/extension | Connect to existing browser via CDP |
| Element targeting | Accessibility snapshot refs | CSS selectors, uid from accessibility tree |
| Snapshot format | YAML from `ariaSnapshot({ mode: 'ai' })` | Custom accessibility tree rendering |
| Tool count | ~20 core + opt-in | Larger tool surface |
| Form filling | Single `browser_fill_form` tool | Separate `fill`, `type`, `select`, `check` |
| Modal handling | First-class modal state system | Manual dialog/file handling |
| Action completion | `waitForCompletion()` auto-tracking | Manual wait strategies |
| Code gen | Built-in Playwright code output | Not included |
| Multi-browser | Chrome, Firefox, WebKit | Chrome/Chromium only (CDP) |
| Architecture | Lives inside Playwright core | Standalone server |
| Profile management | Auto-scoped by workspace hash | Manual profile path |

---

*End of research document*
