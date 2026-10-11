# Extension Mode Plan

> **Goal**: Allow CDP Browser MCP Server to connect to the user's browser **without** requiring `--remote-debugging-port` or `chrome://flags` — via a Chrome extension that bridges CDP commands.

---

## 1. Problem Statement

Today, users must launch Chrome with `--remote-debugging-port=9222` or enable the `chrome://flags/#enable-devtools-experiments` flag. This creates several pain points:

1. **Intimidating setup** — non-technical users don't know how to add CLI flags
2. **Security concerns** — `--remote-debugging-port` opens a network-accessible debug port
3. **Only one process** — the flag must be on the _first_ Chrome process; if Chrome is already running, users must close everything and relaunch
4. **No auto-discovery** — some corporate environments disable `DevToolsActivePort`

A Chrome extension solves all of these: install from Chrome Web Store → done.

---

## 2. Competitive Analysis

### How Playwright Does It

Playwright's browser extension ([playwright-crx](https://github.com/nicolo-ribaudo/playwright-crx)) uses:

- **`chrome.debugger` API** — attaches to tabs and sends CDP commands
- **Native Messaging Host** — a small native binary that communicates with the extension via stdin/stdout
- **Playwright connects to the native host** via `connectOverCDP()`

Pros: Full Playwright API compatibility
Cons: Requires a native messaging host binary (platform-specific install)

### How mcp-chrome Does It

[nicholasoxford/mcp-chrome](https://github.com/nicholasoxford/mcp-chrome) takes a radical approach:

- **Extension IS the MCP server** — the service worker handles MCP protocol directly
- **No Node.js process** — the extension itself serves tool calls via a WebSocket
- **`chrome.debugger.sendCommand`** — routes CDP through the extension

Pros: Zero external dependencies
Cons: Limited by service worker lifecycle (5-minute timeout), no filesystem access, can't run complex tool pipelines

### Our Approach: Hybrid

We keep the full Node.js MCP server (all 38 tools, filesystem access, complex pipelines) but route CDP commands through the extension instead of a raw WebSocket to the browser's debug port.

---

## 3. Architecture

```
┌─────────┐     STDIO      ┌────────────┐      WS       ┌──────────────────┐   chrome.debugger   ┌──────┐
│  Agent   │ ◄────────────► │ MCP Server │ ◄────────────► │ Chrome Extension │ ◄──────────────────► │ Tabs │
│ (Claude) │                │  (Node.js) │   port 9333   │  (Service Worker)│    attach/send      │      │
└─────────┘                └────────────┘                └──────────────────┘                     └──────┘
```

### Data Flow

1. Agent sends tool call via STDIO → MCP Server
2. MCP Server calls `ctx.cdpClient.send('DOM.querySelector', params, sessionId)`
3. `CDPClient` routes the command over WebSocket to the Chrome extension
4. Extension's service worker calls `chrome.debugger.sendCommand(target, method, params)`
5. CDP response flows back: extension → WS → CDPClient → tool → Agent

### Key Insight: CDPClient Abstraction

Our `CDPClient` class already abstracts the WebSocket transport. The extension mode simply swaps the WS endpoint:

```typescript
// Current: connects to browser's raw debug WS
ws://127.0.0.1:9222/devtools/browser/abc-123

// Extension mode: connects to extension's WS bridge
ws://127.0.0.1:9333/cdp-bridge
```

All 38 tools work unchanged because they go through `ctx.cdpClient.send()`.

---

## 4. Chrome Extension Design

### 4.1 Manifest V3

```json
{
  "manifest_version": 3,
  "name": "CDP Browser MCP Bridge",
  "version": "1.0.0",
  "description": "Bridges Chrome DevTools Protocol for CDP Browser MCP Server",
  "permissions": [
    "debugger",
    "tabs",
    "activeTab",
    "scripting"
  ],
  "background": {
    "service_worker": "service-worker.js",
    "type": "module"
  },
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },
  "action": {
    "default_popup": "popup.html",
    "default_icon": "icons/icon-48.png"
  },
  "host_permissions": [
    "<all_urls>"
  ]
}
```

### 4.2 Service Worker — WebSocket Server

The service worker runs a WebSocket server that the MCP server connects to:

```typescript
// service-worker.ts (extension side)

interface CDPRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string; // maps to tabId internally
}

interface CDPResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class CDPBridge {
  private ws: WebSocket | null = null;
  private attachedTabs = new Map<number, chrome.debugger.Debuggee>();
  private pendingRequests = new Map<number, (response: CDPResponse) => void>();

  async start(port = 9333) {
    // Service workers can't create WS servers directly.
    // We'll use a different approach — see Section 7 for alternatives.
  }

  async handleCommand(request: CDPRequest): Promise<CDPResponse> {
    const { id, method, params, sessionId } = request;

    try {
      // Map sessionId to tabId
      const tabId = sessionId ? parseInt(sessionId, 10) : await this.getActiveTabId();
      const debuggee: chrome.debugger.Debuggee = { tabId };

      // Ensure debugger is attached
      if (!this.attachedTabs.has(tabId)) {
        await chrome.debugger.attach(debuggee, '1.3');
        this.attachedTabs.set(tabId, debuggee);
      }

      // Send CDP command through chrome.debugger
      const result = await chrome.debugger.sendCommand(debuggee, method, params || {});
      return { id, result };
    } catch (error: any) {
      return {
        id,
        error: { code: -32000, message: error.message || 'CDP command failed' },
      };
    }
  }

  private async getActiveTabId(): Promise<number> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');
    return tab.id;
  }
}
```

### 4.3 Communication Strategy

Since Manifest V3 service workers **cannot** create WebSocket _servers_, we need an alternative transport. Three options:

#### Option A: Native Messaging (Recommended)

```
[MCP Server] ←stdin/stdout→ [Native Host (tiny)] ←Native Messaging→ [Extension]
```

The native host is a ~50 line Node.js script that:
1. Reads from stdin (MCP Server pipes CDP commands)
2. Forwards via Chrome Native Messaging to the extension
3. Returns responses to stdout

```typescript
// native-host.js (~50 lines)
import { stdin, stdout } from 'process';

function readMessage(): Promise<Buffer> {
  return new Promise(resolve => {
    stdin.once('readable', () => {
      const lenBuf = stdin.read(4);
      if (!lenBuf) return resolve(Buffer.alloc(0));
      const len = lenBuf.readUInt32LE(0);
      const msg = stdin.read(len);
      resolve(msg);
    });
  });
}

function writeMessage(msg: object) {
  const json = JSON.stringify(msg);
  const len = Buffer.byteLength(json);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(len, 0);
  stdout.write(header);
  stdout.write(json);
}
```

#### Option B: Polling via chrome.storage (Simpler but slower)

Extension polls `chrome.storage.local` for pending commands. MCP Server writes commands via a local HTTP endpoint that the popup page bridges.

#### Option C: WebSocket via Offscreen Document

Manifest V3 allows `offscreen` documents that can create WebSocket connections:

```json
{
  "permissions": ["offscreen"],
  // ...
}
```

```typescript
// offscreen.js — runs in an offscreen document (has DOM access)
const ws = new WebSocket('ws://127.0.0.1:9333');

ws.onmessage = (event) => {
  const request = JSON.parse(event.data);
  // Forward to service worker via chrome.runtime.sendMessage
  chrome.runtime.sendMessage({ type: 'cdp-request', ...request });
};

// Listen for responses from service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'cdp-response') {
    ws.send(JSON.stringify(msg));
  }
});
```

**Recommendation**: Start with **Option C** (offscreen WebSocket) for v1 — simplest to implement, no native binary needed. Upgrade to **Option A** (native messaging) for v2 if latency is an issue.

---

## 5. MCP Server Integration

### 5.1 Connection Mode Detection

```typescript
// src/connection/connection-mode.ts

export type ConnectionMode = 'debug-port' | 'extension';

export function detectConnectionMode(): ConnectionMode {
  // 1. Check if extension WS is available on port 9333
  // 2. Fall back to traditional DevToolsActivePort discovery
  return 'debug-port'; // default
}
```

### 5.2 CDPClient Extension Transport

```typescript
// Addition to src/connection/cdp-client.ts

export class CDPClient {
  // Existing: connectViaDebugPort(wsUrl: string)

  async connectViaExtension(port = 9333): Promise<void> {
    const wsUrl = `ws://127.0.0.1:${port}/cdp-bridge`;
    // Same WebSocket connection logic, different endpoint
    // The extension handles chrome.debugger routing internally

    this.ws = new WebSocket(wsUrl);
    // ... same event handlers as debug-port mode
  }
}
```

### 5.3 Auto-Detection Flow

```typescript
async function ensureConnected(ctx: ServerContext): Promise<void> {
  if (ctx.cdpClient.isConnected) return;

  // Try extension mode first (no setup required by user)
  try {
    await ctx.cdpClient.connectViaExtension();
    ctx.connectionMode = 'extension';
    return;
  } catch {
    // Extension not available, fall through
  }

  // Fall back to traditional debug port discovery
  const wsUrl = await resolveWsUrl(ctx.config);
  await ctx.cdpClient.connect(wsUrl);
  ctx.connectionMode = 'debug-port';
}
```

---

## 6. Session/Tab Mapping

In debug-port mode, CDP sessions map to browser targets (frames, workers).
In extension mode, we need to map our internal tab IDs to Chrome tab IDs:

```typescript
// Extension-mode session mapping
interface ExtensionTabMapping {
  // MCP Server's internal tab ID (from tab.list)
  mcpTabId: string;
  // Chrome's actual tab ID (from chrome.tabs)
  chromeTabId: number;
  // chrome.debugger session ID (if using Target.attachToTarget)
  debuggerSessionId?: string;
}
```

The extension maintains this mapping and translates on every CDP command.

---

## 7. Key Challenges

### 7.1 Debugger Warning Banner

When `chrome.debugger.attach()` is called, Chrome shows an infobar:
> "CDP Browser MCP Bridge started debugging this tab"

**Mitigations**:
- Add a clear message in the extension popup explaining this is expected
- Provide a "Dismiss All" button in the popup
- Use `chrome.debugger.attach` with `suppressDialogs` (if available in future Chrome versions)
- Users can dismiss with "Cancel" — the debugger stays attached

### 7.2 Service Worker Lifecycle

Manifest V3 service workers are terminated after ~5 minutes of inactivity.

**Mitigations**:
- Keep-alive via `chrome.alarms` API (minimum 1 minute interval)
- Offscreen document keeps the WebSocket alive
- On wake-up, re-attach debugger to previously tracked tabs

```typescript
// Keep service worker alive
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // Touch storage to prevent termination
    chrome.storage.session.set({ lastPing: Date.now() });
  }
});
```

### 7.3 Debugger Auto-Detach

Chrome detaches the debugger after 10 seconds of inactivity from the extension side.

**Mitigation**: Send periodic heartbeat CDP commands (e.g., `Runtime.evaluate({ expression: '1' })`).

### 7.4 WebSocket Security

The local WebSocket on port 9333 should only accept connections from localhost:

```typescript
// In offscreen document
const ws = new WebSocket('ws://127.0.0.1:9333');

// Server-side (MCP Server or extension): validate origin
wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (origin && !origin.includes('127.0.0.1') && !origin.includes('localhost')) {
    ws.close(4001, 'Only localhost connections allowed');
    return;
  }
});
```

Additionally, implement a shared secret token:
1. Extension generates a random token on install
2. Token is displayed in the popup for the user to copy
3. MCP Server sends token in the WS handshake
4. Extension validates before accepting commands

### 7.5 Multiple Browser Windows

`chrome.debugger` can only attach to one tab per debuggee. Our `SessionManager` already handles multi-tab — we need to ensure the extension mirrors this:

```typescript
// Extension tracks all attached tabs
const attachedTabs = new Map<number, boolean>();

async function ensureAttached(tabId: number) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attachedTabs.set(tabId, true);
}
```

---

## 8. Implementation Phases

### Phase A: Extension Skeleton (1 week)

- [ ] Create Manifest V3 extension scaffold
- [ ] Implement popup UI (status, connection info)
- [ ] Service worker with `chrome.debugger` attach/detach
- [ ] Basic offscreen document with WebSocket client
- [ ] Manual testing: attach to tab, send `Runtime.evaluate`, get result

**Deliverable**: Extension that can attach to tabs and execute CDP commands via popup UI.

### Phase B: CDP Bridge Protocol (1 week)

- [ ] Define bridge protocol (JSON-RPC over WebSocket)
- [ ] Implement request/response routing in service worker
- [ ] Handle CDP events (DOM events, network events) forwarding
- [ ] Session multiplexing (multiple tabs)
- [ ] Error handling and reconnection

**Deliverable**: Extension that accepts CDP commands over WebSocket and returns responses.

### Phase C: MCP Server Integration (1 week)

- [ ] Add `connectViaExtension()` to `CDPClient`
- [ ] Implement auto-detection in `ensureConnected()`
- [ ] Map tab IDs between MCP Server and Chrome extension
- [ ] Test all 38 tools work via extension bridge
- [ ] Add `connectionMode` to `browser.info` tool output

**Deliverable**: Full MCP server working through extension — all tools functional.

### Phase D: Auto-Detection & Fallback (3 days)

- [ ] Auto-detect extension availability on startup
- [ ] Graceful fallback to debug-port mode
- [ ] Add `CDP_PREFER_EXTENSION=true/false` config option
- [ ] Health monitoring for extension connection
- [ ] Reconnection logic when extension restarts

**Deliverable**: Seamless experience — server picks the best available mode automatically.

### Phase E: Polish & Distribution (1 week)

- [ ] Chrome Web Store listing
- [ ] Extension icon and branding
- [ ] User guide and setup documentation
- [ ] Performance benchmarks (extension vs debug-port latency)
- [ ] Edge Add-ons store listing
- [ ] Security audit of the WebSocket bridge

**Deliverable**: Published extension on Chrome Web Store, updated README.

---

## 9. Comparison Table

| Feature                      | CDP Browser MCP (Extension) | Playwright Extension     | mcp-chrome               |
|------------------------------|-----------------------------|--------------------------|--------------------------|
| **Setup complexity**         | Install extension           | Install extension + host | Install extension        |
| **Native binary required**   | No (v1)                     | Yes (native messaging)   | No                       |
| **Node.js required**         | Yes (MCP server)            | Yes (Playwright)         | No                       |
| **Number of tools**          | 38                          | ~10 (Playwright API)     | ~5                       |
| **Auth/cookies preserved**   | ✅ Yes                      | ✅ Yes                   | ✅ Yes                   |
| **Extensions preserved**     | ✅ Yes                      | ✅ Yes                   | ✅ Yes                   |
| **Service worker timeout**   | Mitigated (keepAlive)       | N/A (native host)        | 5-min limit              |
| **Filesystem access**        | ✅ Yes (Node.js)            | ✅ Yes                   | ❌ No                    |
| **Multi-tab support**        | ✅ Yes                      | ✅ Yes                   | ⚠️ Limited               |
| **CDP event streaming**      | ✅ Yes                      | ✅ Yes                   | ⚠️ Limited               |
| **Accessibility snapshots**  | ✅ Optimized (TokenOptimizer)| ❌ Raw only              | ❌ No                    |
| **Form filling engine**      | ✅ Smart (multi-field)      | ⚠️ Basic (Playwright)    | ❌ No                    |
| **Latency overhead**         | ~5ms (WS hop)               | ~2ms (native messaging)  | ~1ms (direct)            |
| **Security model**           | Localhost + token           | Chrome-verified host     | Extension-only           |
| **Browser support**          | Chrome, Edge, Brave         | Chrome only              | Chrome only              |

---

## 10. File Structure

```
extension/
├── manifest.json
├── service-worker.ts        # Main logic, chrome.debugger bridge
├── offscreen.html           # Offscreen document shell
├── offscreen.ts             # WebSocket client in offscreen context
├── popup.html               # Status UI
├── popup.ts                 # Popup logic
├── bridge-protocol.ts       # Shared types for CDP bridge messages
├── tab-manager.ts           # Tab tracking and session mapping
├── keep-alive.ts            # Service worker keep-alive logic
├── icons/
│   ├── icon-16.png
│   ├── icon-48.png
│   └── icon-128.png
├── tsconfig.json
└── build.ts                 # esbuild config for extension
```

---

## 11. Security Considerations

1. **Localhost-only WebSocket** — bind to 127.0.0.1, reject non-localhost origins
2. **Authentication token** — shared secret between extension and MCP server
3. **Tab permission model** — extension only debugs tabs the user explicitly allows (via popup toggle)
4. **No data exfiltration** — extension never sends data to external servers
5. **CSP compliance** — strict Content Security Policy in manifest
6. **Audit logging** — extension logs all CDP commands for user inspection (viewable in popup)

---

## 12. Open Questions

1. **Should the extension auto-attach to all tabs or require explicit opt-in per tab?**
   - Auto-attach is more seamless but shows the debugger banner on every tab
   - Per-tab opt-in is more controlled but requires user interaction

2. **Should we support Firefox via WebExtensions API?**
   - Firefox has `browser.debugger` but with different semantics
   - Defer to Phase F if there's demand

3. **How to handle iframes?**
   - `chrome.debugger` attaches to top-level targets
   - Need `Target.attachToTarget` for iframe isolation
   - Our existing `dispatch.ts` session routing should handle this

4. **Chrome Web Store review concerns?**
   - `debugger` permission triggers enhanced review
   - Need clear privacy policy and justification
   - "Developer tool for AI-assisted browser automation" framing

---

## References

- [Chrome Extensions Manifest V3](https://developer.chrome.com/docs/extensions/mv3/)
- [chrome.debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Offscreen Documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Playwright CRX](https://github.com/nicolo-ribaudo/playwright-crx)
- [mcp-chrome](https://github.com/nicholasoxford/mcp-chrome)
