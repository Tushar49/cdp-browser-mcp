<p align="center">
  <h1 align="center">CDP Browser MCP Server</h1>
  <p align="center">
    <strong>The only MCP server that connects to your real browser.</strong><br>
    Keep your cookies. Keep your sessions. Keep your extensions. Automate everything.
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-5.0.3-blue" alt="Version">
  <img src="https://img.shields.io/badge/tools-14-green" alt="Tools">
  <img src="https://img.shields.io/badge/sub--actions-90+-green" alt="Actions">
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node">
  <img src="https://img.shields.io/badge/license-MIT-yellow" alt="License">
</p>

---

## Why This Exists

Every other browser MCP server **launches a fresh browser** — no cookies, no login sessions, no extensions, no history. You end up automating a blank browser that can't access anything you're already logged into.

**CDP Browser MCP Server connects to your actual running Chrome.** Your Gmail is already open. Your LinkedIn is already logged in. Your corporate SSO just works. No re-authentication, no MFA prompts, no cookie imports.

### Instant Startup — No Browser Launch Overhead

Other browser automation tools need to **launch a browser process** — and that takes time. Puppeteer with 20+ tabs open can take **3–5 minutes** just to initialize. Playwright MCP downloads and installs browser binaries before first run.

CDP Browser MCP Server connects to your **already-running** browser over a WebSocket. Startup is **instantaneous** regardless of how many tabs you have open — 20 tabs or 100 tabs, it connects in milliseconds and starts working immediately. No browser launch, no binary downloads, no cold start penalty.

### The Problem with Other Approaches

| Approach | What breaks |
|----------|------------|
| Playwright MCP launches new browser | No cookies, no sessions, need to re-login everywhere. Downloads browser binaries first |
| Puppeteer MCP launches Chromium | Same — blank slate. 3–5 min startup with many tabs. Plus it's **deprecated** |
| Browserbase MCP uses cloud browser | Requires paid subscription + separate LLM API key |
| Browser Use needs Python + LLM key | Heavy framework, double LLM cost |
| BrowserTools MCP is read-only | Can observe but can't automate |

**This server**: connects to Chrome on `localhost:9222`, uses the real browser state, and gives you **100+ automation actions** across 15 tools — built as a modular TypeScript codebase with 2 dependencies. Geolocation spoofing automatically grants browser permissions so permission-based sites just work.

---

## What's New in v5.0.0

> **Complete architecture restructure** — from a single 254KB file to 38 TypeScript modules.

| Feature | Description |
|---------|-------------|
| 🏗️ **Modular Architecture** | 38 TypeScript files organized into `connection/`, `session/`, `snapshot/`, `tools/`, `utils/` — strict mode, fully typed |
| 📝 **Smart Form Filling** | New `form` tool — handles text, combobox, checkbox, radio, select, date in a single call. React/Greenhouse combobox support with smart matching |
| 🔌 **Auto-Connect** | Server discovers and connects to Chrome/Edge/Brave on first tool call — no more `browser.connect()` needed |
| 🎯 **Stable Element Refs** | UIDs persist across snapshots within the same page via cumulative ElementResolver |
| ⏱️ **60s Default Timeout** | SPA-friendly — D365, SharePoint, and heavy apps no longer time out |
| 📦 **Token-Optimized Snapshots** | Role filtering, depth limiting, text truncation. ~15KB average (down from 34KB) |
| 🔄 **Auto-Reconnect** | Exponential backoff reconnection on browser disconnect |
| 💡 **Actionable Errors** | 17 error types with "How to fix" suggestions — agents recover without human help |
| 🖱️ **JS-Click Fallback** | Click auto-falls back to `el.click()` for framework sites (LinkedIn, React, Angular) |
| 🚫 **Modal State System** | Dialogs and file choosers block other tools with recovery instructions |
| ⚡ **Lazy CDP Domains** | Domains enabled on first use, not at connect time — faster startup |
| 📊 **Snapshot Caching** | Per-tab cache for snapshot reuse — reduces redundant tree captures |
| 🤖 **Agent Guidance** | All 14 tool descriptions include usage guidance and common pitfalls |
| 🧹 **Default: Detach** | Tabs never auto-close when session expires — agents can't accidentally kill your tabs |
| 🖼️ **Cross-Origin Iframes** | OOP iframes auto-discovered via `Target.setAutoAttach` — visible in snapshots with `[frame N]` prefixes |
| 📂 **File Chooser Interception** | Programmatic uploads via `Page.handleFileChooser`, popup monitoring for Google Picker/Dropbox |
| 📌 **Profile-Sticky Sessions** | Sessions auto-pin to Chrome profile on first tab interaction — new tabs always open in the right profile |
| 🖥️ **Cross-Platform Support** | macOS, Linux, and Windows browser discovery for Chrome, Edge, Brave, Chromium |
| 🧩 **Chrome Extension** | Manifest V3 scaffold with service worker and popup UI (bridge coming in v5.1) |

---

## Comparison with Other Browser MCP Servers

| Feature | **CDP Browser** (this) | **Playwright MCP** | **Browserbase** | **Puppeteer MCP** | **BrowserTools** |
|---|:---:|:---:|:---:|:---:|:---:|
| Connects to real browser | **Yes** | Via flag only | No (cloud) | No | Read-only |
| Preserves cookies/sessions | **Yes** | No | No | No | Yes |
| Works with extensions | **Yes** | No | No | No | Yes |
| Tool count | **15 tools, 100+ actions** | ~30 tools | ~10 tools | 7 tools | ~13 tools |
| Auto-connect | **Yes** (first tool call) | No | N/A | No | No |
| Auto-waiting after actions | **Yes** | Yes | Yes | No | N/A |
| Smart form filling | **Yes** (combobox, React Select) | Native `<select>` only | Via AI | No | No |
| Stable element refs | **Yes** (persist across snapshots) | Yes | No | No | No |
| Network interception | **Yes** (mock/block/modify) | No | No | No | Read-only |
| HTTP request mocking | **Yes** | No | No | No | No |
| Cookie/storage management | **Yes** (full CRUD) | File-based | Cloud profiles | User data dir | No |
| Device emulation | **Yes** (15 options) | Partial | Limited | No | No |
| Network throttling | **Yes** (6 presets) | No | No | No | No |
| Performance metrics | **Yes** (DOM, heap, paint) | No | No | No | Lighthouse |
| PDF export | **Yes** | Yes | No | No | No |
| File upload | **Yes** | Yes | No | No | No |
| Drag & drop | **Yes** | Yes | No | No | No |
| Console monitoring | **Yes** | Yes | Limited | Yes | Yes |
| Download tracking | **Yes** | No | No | No | No |
| Framework-aware inputs | **Yes** (React/Angular/MUI) | Yes | Via AI | No | No |
| JS-click fallback | **Yes** (auto for framework sites) | No | No | No | No |
| Per-agent session isolation | **Yes** (exclusive tab locks) | Yes | Yes | No | No |
| Tab ownership & locking | **Yes** (exclusive by default) | No | No | No | No |
| Chrome profile/instance mgmt | **Yes** (detect, switch, list) | No | Cloud profiles | No | No |
| Modal/dialog guards | **Yes** (blocks with recovery) | Yes | No | No | No |
| Snapshot caching | **Yes** (per-tab) | Yes | No | No | No |
| Token-optimized snapshots | **Yes** (~15KB avg) | No | No | No | No |
| Actionable error messages | **Yes** (17 types + fix tips) | Basic | No | No | No |
| Auto-reconnect | **Yes** (exponential backoff) | N/A | N/A | No | No |
| Requires paid service | **No** | No | Yes | No | No |
| Requires LLM API key | **No** | No | Yes | No | No |
| Dependencies | **2** (ws, MCP SDK) | Playwright + browsers | API key + subscription | Puppeteer + Chromium | 3-part install |
| Architecture | **38 TypeScript modules** | Multi-file package | Multi-file package | Multi-file | Multi-file |
| Status | **Active** | Active | Active | **Deprecated** | Active |
| Startup speed | **Instant** (WebSocket connect) | Slow (browser launch) | Slow (cloud API) | Slow (3-5 min w/ tabs) | N/A |

---

## Installation

### Prerequisites

- **Node.js** 18+ ([download](https://nodejs.org/))
- **Google Chrome** (any recent version)

### Step 1: Enable Chrome Remote Debugging

**Option A — Chrome flag (recommended, persists across restarts):**

1. Open Chrome and navigate to `chrome://flags/#enable-remote-debugging`
2. Set to **Enabled**
3. Relaunch Chrome

**Option B — Launch with flag (one-time):**

```powershell
# Windows
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222
```

**Verify it works:** Open `http://localhost:9222/json/version` in a browser — you should see a JSON response.

### Step 2: Clone & Install

```bash
git clone https://github.com/Tushar49/cdp-browser-mcp.git
cd cdp-browser-mcp/MCP\ Server
pnpm install
pnpm build
```

Package manager is pnpm (`npm i -g pnpm` once, or `corepack enable`). npm works for scripts too, but pnpm is canonical.

That's it. Two dependencies: `ws` (WebSocket client) and `@modelcontextprotocol/sdk`.

> **Note:** The server auto-connects to your running browser on first tool call — no manual `browser.connect()` needed.

### Install from npm (no clone needed)

Requires Node.js 20+ only:

```bash
npm install -g cdp-mcp-server@latest
```

Or point your MCP client straight at npx:

```json
{
  "mcpServers": {
    "cdp-browser": {
      "command": "npx",
      "args": ["-y", "cdp-mcp-server@latest"]
    }
  }
}
```

### Step 3: Configure Your MCP Client

<details>
<summary><strong>VS Code (Copilot / Cline / Continue)</strong></summary>

Add to your `settings.json` or `mcp.json`:

```json
{
  "mcpServers": {
    "cdp-browser": {
      "command": "node",
      "args": ["/path/to/MCP Server/dist/index.js"],
      "env": {
        "CDP_PORT": "9222"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cdp-browser": {
      "command": "node",
      "args": ["/path/to/MCP Server/dist/index.js"],
      "env": {
        "CDP_PORT": "9222"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "cdp-browser": {
      "command": "node",
      "args": ["/path/to/MCP Server/dist/index.js"]
    }
  }
}
```

</details>

<details>
<summary><strong>Any MCP Client (stdio)</strong></summary>

```bash
node "MCP Server/dist/index.js"
```

The server communicates over stdio using the MCP protocol. Any MCP-compatible client can connect.

</details>

---

## Connection troubleshooting

When no browser is reachable, connect errors name the exact failure mode and print the exact fix command. Discovery also scans running browser processes' command lines to find `--user-data-dir` and `--remote-debugging-port`, so portable/custom installs are discovered with zero configuration — full command lines are never logged or returned, only the extracted directory/port. The server can additionally connect through the `chrome://inspect/#remote-debugging` toggle (approval mode) by reading the `DevToolsActivePort` file the browser writes; `ping` and `status` report the connection mode (`legacy` | `approval`).

| Symptom | Fix |
|---------|-----|
| **"no browser with debugging enabled"** — nothing listening on any debug port, no browser processes found | Launch your browser with the debug flag plus an explicit `--user-data-dir` |
| **Browser running, but launched without the debug flag** | Same launch guidance; Chrome/Brave 153+ can instead enable `chrome://inspect/#remote-debugging` → "Allow remote debugging for this browser instance" |
| **Debug port bound, but `http://localhost:9222/json/version` returns 404** — the browser is running the new gated remote-debugging (the `chrome://inspect` toggle) | Click **Allow** on Chrome's permission dialog when the server connects (needs a visible browser window), or relaunch with the flag + explicit non-default `--user-data-dir` |
| **Flag given, but connection refused** (Chrome 136+ default-profile restriction) | Pair `--remote-debugging-port` with an explicit **non-default** `--user-data-dir` (Chrome for Testing is exempt) |

The launch command that works for all four modes (per-OS paths in Step 1 above):

```bash
chrome --remote-debugging-port=9222 --user-data-dir="<a non-default directory>"
```

## Browser compatibility

| Browser | Flag mode | Toggle (approval) | Process scan | Notes |
|---------|-----------|-------------------|--------------|-------|
| Chrome 136+ | ✅ requires non-default `--user-data-dir` | ✅ Chrome 144+ | ✅ | default-profile restriction since Chrome 136 |
| Chrome Beta / Canary | ✅ | ✅ Chrome 144+ | ✅ | discovered as `Chrome Beta` / `Chrome Canary` |
| Chromium | ✅ | ✅ Chrome 144+ | ✅ | restriction is Chrome-branding-gated — usually off in plain Chromium |
| Brave | ✅ | ✅ (verified on 153) | ✅ (verified on 153) | portapps wrappers: launch inner `app\brave.exe`, not wrapper shortcut |
| Edge | ✅ | ✅ Chrome 144+ | ✅ | same Chromium behavior |
| Vivaldi | ✅ | ✅ Chrome 144+ | ✅ | discovery path added in 5.0.3 |
| Opera | ✅ | ✅ Chrome 144+ | ✅ | discovery path added in 5.0.3 |
| Chrome for Testing | ✅ no restriction | — | ✅ | recommended automated/CI setups |

Legend:

- **Flag mode** — launched with `--remote-debugging-port` (plus a non-default `--user-data-dir` where required)
- **Toggle (approval)** — the browser built-in remote-debugging switch (`chrome://inspect/#remote-debugging`); the server reads the `DevToolsActivePort` file and you approve the connection dialog — no launch flag needed (Chromium 144+)
- **Process scan** — the server reads running browser processes launch arguments to find custom/portable data dirs automatically (disable with `CDP_PROCESS_SCAN=false`)

When a connection fails, the server auto-detects the failure mode and prints the exact fix — see Connection troubleshooting above.

---

## Tools Overview

| Tool | Actions | Description |
|------|---------|-------------|
| `tabs` | 7 | Tab management — list, find, open, close, activate, info, set profile |
| `page` | 20 | Navigation, snapshots, screenshots, content extraction, PDF, dialogs, frames, find-in-page, screen recording (MP4) |
| `interact` | 12 | Click, hover, type, fill, select, press, drag, scroll, upload, focus, check, tap |
| `form` | 3 | Smart form filling engine — fill, read, clear; handles text, combobox, checkbox, radio, select, date in one call |
| `execute` | 3 | JavaScript evaluation — expressions, async scripts, element-scoped calls |
| `observe` | 7 | Console messages, network requests, performance metrics, memory counters, downloads, HAR export |
| `emulate` | 15 | Viewport, color scheme, geolocation, network throttling, timezone, vision deficiency, device posture, CPU performance tier |
| `storage` | 11 | Cookie CRUD, localStorage/sessionStorage management, storage clearing, quota inspection, auth-state export/import |
| `webauthn` | 11 | Passkey testing with virtual authenticators — create/inject credentials, presence + UV simulation, negative-testing override bits |
| `intercept` | 6 | HTTP request interception — mock, modify, block network requests |
| `cleanup` | 7 | Session management, disconnect, temp file cleanup, reset |
| `browser` | 3 | Chrome/Edge/Brave instance detection, profile listing, connection switching |
| `debug` | 21 | JS debugger, breakpoints, resource overrides, DOM/event breakpoints |
| `ping` | — | Health check — server version, connection status, connection mode |
| `status` | — | Server status — connection, config, sessions |

---

## Tools & Actions

### `tabs` — Tab Management

| Action | Description | Required | Optional |
|--------|-------------|----------|----------|
| `list` | List all open tabs with IDs, URLs, titles (optional `urlFilter` substring; `format:'json'` for parseable output) | — | `showAll`, `urlFilter`, `format` |
| `find` | Search tabs by title or URL substring | `query` | `format`(`text`\|`json`) |
| `new` | Open a new tab (background by default) | — | `url`, `activate`, `profile` |
| `close` | Close a tab | `tabId` | — |
| `activate` | Bring tab to foreground | `tabId` | — |
| `info` | Get tab details + connection status | `tabId` | — |
| `set_profile` | Pin session to a specific Chrome profile | `profile` | — |

### `page` — Page Operations

| Action | Description | Required | Optional |
|--------|-------------|----------|----------|
| `goto` | Navigate to URL, wait for load | `tabId`, `url` | `waitUntil`, `timeout` |
| `back` | Navigate back in history | `tabId` | `waitUntil`, `timeout` |
| `forward` | Navigate forward in history | `tabId` | `waitUntil`, `timeout` |
| `reload` | Reload page | `tabId` | `ignoreCache`, `waitUntil`, `timeout` |
| `snapshot` | Accessibility tree with element refs | `tabId` | `interactive`, `search`, `maxLength` |
| `screenshot` | Capture page or element as image (fullPage scrolls SPA containers to trigger lazy loading) | `tabId` | `fullPage`, `quality`, `uid`, `type`, `path` |
| `content` | Extract text, HTML, or full document source | `tabId` | `uid`, `selector`, `format`(`text`\|`html`\|`full`\|`annotated` - experimental: `Page.getAnnotatedPageContent` dump; flat ASCII signal, no refs) |
| `set_content` | Set page HTML content directly | `tabId`, `html` | — |
| `wait` | Wait for condition or fixed delay | `tabId` | `text`, `textGone`, `selector`, `state`, `timeout`(ms) |
| `pdf` | Export page as PDF | `tabId` | `landscape`, `scale`, `paperWidth`, `paperHeight`, `margin` |
| `dialog` | Handle JS alert/confirm/prompt | `tabId` | `accept`, `text` |
| `inject` | Inject script on every page load | `tabId`, `script` | — |
| `add_style` | Inject CSS (inline or external URL) | `tabId`, `css` or `cssUrl` | `persistent` |
| `bypass_csp` | Disable Content Security Policy | `tabId` | `enabled` |
| `frames` | List all frames with id, URL, origin, depth (same-origin + OOP iframes) | `tabId` | — |
| `find` / `find_next` / `find_stop` | Find text in page, cycle matches with wrap-around, stop (counts visible matches; `window.find` skips hidden text) | `tabId`, `text` (find) | `caseSensitive` |
| `record_start` / `record_stop` | Record the tab screen to an MP4 video (experimental, recent Chromium only) | `tabId` | `audio`, `path` (stop) |

### `interact` — Element Interaction

| Action | Description | Required | Optional |
|--------|-------------|----------|----------|
| `click` | Click an element (auto-retry until actionable) | `tabId`, `uid` or `selector` | `button`, `clickCount`, `modifiers`, `timeout`, `humanMode` |
| `hover` | Hover to trigger tooltips/menus | `tabId`, `uid` or `selector` | `modifiers`, `timeout`, `humanMode` |
| `type` | Type text into input field | `tabId`, `text`, `uid` or `selector` | `clear`, `submit`, `delay`, `charDelay`, `wordDelay`, `typoRate`, `timeout` |
| `fill` | Fill multiple form fields at once | `tabId`, `fields[]` | `timeout` |
| `select` | Select dropdown option | `tabId`, `value`, `uid` or `selector` | `timeout` |
| `press` | Press keyboard key | `tabId`, `key` | `modifiers` |
| `drag` | Drag element to target | `tabId`, source + target | `timeout`, `humanMode` |
| `scroll` | Scroll page or element | `tabId` | `direction`, `amount`, `x`, `y`, `uid`, `timeout` |
| `upload` | Upload files to file input, intercept file chooser, or auto-detect popup file inputs (Google Picker, etc.) | `tabId`, `files[]` | `uid`, `selector`, `timeout` |
| `focus` | Focus element + scroll into view | `tabId`, `uid` or `selector` | `timeout` |
| `check` | Toggle checkbox | `tabId`, `checked`, `uid` or `selector` | `timeout` |
| `tap` | Tap element using touch events | `tabId`, `uid` or `selector` | `timeout` |

**Global interact flags:** `humanMode` (bezier mouse paths), `typoRate` (typing errors)

### `form` — Smart Form Filling *(NEW in v5.0.0)*

Fill entire forms in a single call. Auto-detects field types and handles framework-specific inputs. Actions: `fill` (set values), `read` (get current values), `clear` (reset all fields).

| Parameter | Description | Required |
|-----------|-------------|----------|
| `tabId` | Target tab | Yes |
| `fields` | Array of `{ uid, value, type? }` — type auto-detected if omitted | Yes |
| `timeout` | Per-field timeout in ms (default: 10000) | No |

**Supported field types:** `text`, `combobox`, `checkbox`, `radio`, `select`, `date`, `country-code`, `location`

- **Combobox/React Select**: Types into the input, waits for dropdown, finds best match, selects it. Works with Greenhouse, Lever, MUI Autocomplete
- **Checkbox/Radio**: Sets checked state based on value (`"true"` / `"false"`)
- **Native `<select>`**: Selects option by visible text or value
- **Date inputs**: Sets value via native input setter with proper event dispatch
- **Country code**: Normalizes `+91`, `India`, or `IN` → searches country dropdown
- **Location**: Slow-types for API-driven autocomplete, waits for suggestions

### `execute` — JavaScript Execution

| Action | Description | Required | Optional |
|--------|-------------|----------|----------|
| `eval` | Evaluate JS expression, return value | `tabId`, `expression` | — |
| `script` | Run async IIFE (multi-step logic) | `tabId`, `code` | — |
| `call` | Call function on a specific element | `tabId`, `function`, `uid` or `selector` | — |

### `observe` — Monitoring

| Action | Description | Required | Optional |
|--------|-------------|----------|----------|
| `console` | Get captured console messages | `tabId` | `level`, `last`, `clear` |
| `network` | List network requests | `tabId` | `filter`, `types`, `last`, `clear` |
| `request` | Get full request/response body | `tabId`, `requestId` | — |
| `performance` | DOM size, JS heap, layout metrics | `tabId` | — |
| `memory` | DOM/JS memory counters before/after a forced GC sweep (Performance fallback when the Memory domain is unresponsive) | `tabId` | — |
| `downloads` | List tracked file downloads | `tabId` | `last`, `clear` |
| `har` | Export captured network data as HAR 1.2 JSON | `tabId` | — |

### `emulate` — Device & Network Emulation

Set any combination of properties in a single call:

| Property | Description | Values |
|----------|-------------|--------|
| `viewport` | Screen dimensions | `{width, height, deviceScaleFactor, mobile, touch, landscape}` |
| `colorScheme` | Color preference | `dark`, `light`, `auto` |
| `userAgent` | User agent override | string |
| `geolocation` | GPS spoofing (auto-grants permission) | `{latitude, longitude, accuracy, altitude}` |
| `cpuThrottle` | CPU slowdown | number (1 = normal, 4 = 4x slower) |
| `timezone` | Timezone override | e.g. `America/New_York` |
| `locale` | Locale override | e.g. `fr-FR` |
| `visionDeficiency` | Vision simulation | `protanopia`, `deuteranopia`, `tritanopia`, `achromatopsia`, `blurredVision` |
| `networkCondition` | Network throttle | `offline`, `slow3g`, `fast3g`, `slow4g`, `fast4g`, `none` |
| `ignoreSSL` | Bypass SSL errors | boolean |
| `blockUrls` | Block URL patterns | string array |
| `extraHeaders` | Set custom headers | object |
| `autoDarkMode` | Force automatic dark mode | boolean |
| `idle` | Emulate idle/locked screen state | `active`, `locked` |
| `devicePosture` | Foldable device posture (Chrome 153+) | `continuous`, `folded` |
| `cpuPerformance` | CPU performance tier (Chrome 153/154+) | `low`, `mid`, `high`, `ultra` |
| `reset` | Clear all overrides | `true` |

### `storage` — Cookie & Storage Management

| Action | Description | Required | Optional |
|--------|-------------|----------|----------|
| `get_cookies` | Retrieve cookies | `tabId` | `urls` |
| `set_cookie` | Set a cookie | `tabId`, `name`, `value` | `domain`, `path`, `secure`, `httpOnly`, `sameSite`, `expires` |
| `delete_cookies` | Delete cookies by name | `tabId`, `name` | `url`, `domain`, `path` |
| `clear_cookies` | Clear all cookies | `tabId` | — |
| `clear_data` | Clear storage by type | `tabId` | `origin`, `types` |
| `quota` | Check storage quota | `tabId` | — |
| `get_storage` | Read localStorage/sessionStorage (whole object as JSON when `key` omitted) | `tabId` | `key`, `storageType`(`local`\|`session`) |
| `set_storage` | Write a localStorage/sessionStorage key | `tabId`, `key`, `value` | `storageType`(`local`\|`session`) |
| `delete_storage` | Remove a key, or clear the whole storage area when `key` omitted | `tabId` | `key`, `storageType`(`local`\|`session`) |

### `webauthn` — Passkey Testing with Virtual Authenticators *(NEW in v5.2.0)*

Test passkey flows without a real security key. Create a virtual authenticator
on a tab, then drive the page normally — the browser intercepts
`navigator.credentials.create/get` and the authenticator auto-responds.
Authenticators live in browser memory only: nothing touches the user's real
keyring; they die when the tab closes, the browser exits, or the MCP server
disconnects, and they survive in-tab session re-attaches (process swaps)
orphaned from the registry — recreate to re-address them. Create the
authenticator BEFORE the page runs its WebAuthn calls.

Binary parameters take base64 (standard or URL-safe, padding optional —
normalized automatically). Resident credentials need a `userHandle` (one is
auto-generated when omitted). Caveat: pages using WebAuthn conditional
mediation (e.g. webauthn.io's page-load autofill setup) keep a pending
ceremony that can starve the site's own `credentials.create` with
NotAllowedError — reload and retry, or pre-provision credentials with
`add_credential` and drive the login path.

| Action | Description | Required | Optional |
|--------|-------------|----------|----------|
| `add_authenticator` | Create a virtual authenticator (defaults: ctap2/internal, resident keys, UV verified, auto-presence — a platform passkey that approves everything; re-enables the virtual environment automatically) | `tabId` | `protocol`(`ctap2`\|`u2f`), `transport`(`internal`\|`usb`\|`nfc`\|`ble`\|`cable`\|`hybrid`\|`smart-card`), `hasResidentKey`, `hasUserVerification`, `isUserVerified`, `automaticPresenceSimulation`, `ctap2Version`, `extensions`{`prf`,`largeBlob`,`credBlob`,`minPinLength`,`hmacSecret`,`cmtgKey`} |
| `remove_authenticator` | Remove an authenticator | `authenticatorId` | — |
| `list_authenticators` | List authenticators created by this server | — | — |
| `add_credential` | Inject a pre-made credential (privateKey = PKCS#8 DER of an ECDSA P-256 key, base64) | `authenticatorId`, `credentialId`(b64), `privateKey`(b64), `rpId` | `userHandle`(b64), `isResidentCredential`, `signCount`, `largeBlob`(b64), `backupEligibility`, `backupState`, `userName`, `userDisplayName` |
| `list_credentials` | List credentials stored on an authenticator | `authenticatorId` | — |
| `remove_credential` | Remove one credential | `authenticatorId`, `credentialId` | — |
| `clear_credentials` | Remove all credentials | `authenticatorId` | — |
| `set_user_verified` | Make user verification succeed/fail (fail = sites requiring UV get NotAllowedError) | `authenticatorId` | `isUserVerified` (default true) |
| `set_presence_simulation` | Auto-approve or hang user-presence tests (hang = test timeout paths) | `authenticatorId` | `enabled` (default true) |
| `set_override_bits` | Negative testing — sabotage the next response: zero signature / UV flag / UP flag | `authenticatorId` | `isBogusSignature`, `isBadUV`, `isBadUP` |
| `reset` | Remove ALL authenticators on a tab + disable the environment | `tabId` | — |

### `intercept` — HTTP Request Interception

| Action | Description | Required | Optional |
|--------|-------------|----------|----------|
| `enable` | Start intercepting requests | `tabId` | `patterns` (URL globs) |
| `disable` | Stop intercepting | `tabId` | — |
| `continue` | Resume paused request | `tabId`, `requestId` | `url`, `method`, `headers`, `postData` |
| `fulfill` | Mock response for request | `tabId`, `requestId` | `status`, `body`, `headers` |
| `fail` | Abort request with error | `tabId`, `requestId` | `reason` |
| `list` | List paused requests | `tabId` | — |

### `cleanup` — Session Management

| Action | Description | Required | Optional |
|--------|-------------|----------|----------|
| `disconnect_tab` | Disconnect from a tab | `tabId` | — |
| `disconnect_all` | Disconnect all sessions | — | — |
| `clean_temp` | Delete temp files (session-scoped) | — | — |
| `status` | Server status | — | — |
| `list_sessions` | List agent sessions with origin tags | — | — |
| `session` | End caller's session, cleanup owned tabs | — | `cleanupStrategy` |
| `reset` | Terminate ALL sessions. Created tabs optionally closed; pre-existing tabs always preserved | — | `closeTabs` |

### `browser` — Chrome Instance & Profile Management

| Action | Description | Required | Optional |
|--------|-------------|----------|---------|
| `profiles` | List all Chrome instances with profiles | — | — |
| `connect` | Switch to a different Chrome instance | `instance` | — |
| `active` | Show current connection info | — | — |

### `debug` — JavaScript Debugger & Resource Overrides

| Action | Description | Required | Optional |
|--------|-------------|----------|----------|
| `enable` | Enable JS debugger, start tracking scripts | `tabId` | — |
| `disable` | Disable debugger, clear breakpoints | `tabId` | — |
| `set_breakpoint` | Set breakpoint by URL + line | `tabId`, `url`, `lineNumber` | `columnNumber`, `condition` |
| `remove_breakpoint` | Remove a breakpoint | `tabId`, `breakpointId` | — |
| `list_breakpoints` | List active breakpoints | `tabId` | — |
| `pause` | Pause execution immediately | `tabId` | — |
| `resume` | Resume paused execution | `tabId` | — |
| `step_over` | Step over current statement | `tabId` | — |
| `step_into` | Step into function call | `tabId` | — |
| `step_out` | Step out of current function | `tabId` | — |
| `call_stack` | View call stack when paused | `tabId` | — |
| `evaluate_on_frame` | Evaluate expression in call frame | `tabId`, `expression` | `frameIndex` |
| `list_scripts` | List all loaded scripts | `tabId` | — |
| `get_source` | Get script source code | `tabId`, `scriptId` | — |
| `override_resource` | Register URL pattern → response body | `tabId`, `urlPattern` | `body`, `responseCode`, `headers` |
| `remove_override` | Remove a resource override | `tabId`, `urlPattern` | — |
| `list_overrides` | List active overrides | `tabId` | — |
| `set_dom_breakpoint` | Break on DOM node change | `tabId`, `uid`, `type` | — |
| `remove_dom_breakpoint` | Remove DOM breakpoint | `tabId`, `uid`, `type` | — |
| `set_event_breakpoint` | Break on event type | `tabId`, `eventName` | — |
| `remove_event_breakpoint` | Remove event breakpoint | `tabId`, `eventName` | — |

---

## Key Features

### Stable Element References

Elements are addressed by `ref` numbers mapped to Chrome's internal `backendNodeId`. Unlike sequential counters that break when the DOM changes, `backendNodeId` is stable within a session and resolves in O(1).

```
# Snapshot output
- button "Submit" [ref=42]
- textbox "Email" [ref=38]

# Use ref to interact
interact → { action: "click", tabId: "...", uid: 42 }
```

### Auto-Waiting After Actions

Every click, type, fill, select, and press action is wrapped in `waitForCompletion()`:
1. Captures pending network requests before the action
2. Executes the action  
3. Waits for triggered XHR/fetch requests to complete (5s cap)
4. Waits for page navigation if detected (10s cap)
5. Returns only after the page has settled

No more "click then pray" — the server knows when the action's side effects are done.

### Actionability Checks + Auto-Retry

Before interacting with any element, the server verifies:
- Element has non-zero dimensions
- Element is not `disabled`
- Element is visible (`display`, `visibility`, `opacity`)
- Element has `pointer-events` enabled

All interaction actions automatically **retry** element resolution and actionability checks until the element is found and actionable, or the timeout expires (default: 5000ms, configurable via `timeout` parameter). This matches Playwright's auto-waiting behavior — no manual polling needed.

If checks fail after retries, you get a descriptive error with recovery hints instead of a silent failure.

### Framework-Aware Form Filling

Works with React, Angular, Vue, and vanilla HTML:
- **Text inputs**: Uses `nativeInputValueSetter` to bypass React's synthetic event system
- **Custom dropdowns**: Detects MUI Select, Ant Design Select, React Select by role/class — clicks to open, finds matching option, clicks it
- **Contenteditable**: Uses `document.execCommand('insertText')` for undo-compatible insertion
- **Native selects**: Dispatches full event sequence (`mousedown → focus → change → mouseup → click`)

### Incremental Snapshots

After the first snapshot, subsequent calls return a line-level diff showing only what changed. Reduces token usage by 60–80% on pages with minor updates.

```
### Changes (2 added, 1 removed)
+ - status "Form submitted successfully" [ref=42]
- - button "Submit" [ref=15]
+ - button "Submit" [disabled] [ref=15]
```

### Per-Agent Session Isolation with Exclusive Tab Locks

Multiple AI agents can share the same Chrome instance without interfering. Each server process is **automatically assigned a session** via `crypto.randomUUID()` — no opt-in needed. Each agent gets:
- **Exclusive tab ownership** — tabs are locked to the session that created/claimed them. Other agents are blocked by default (`exclusive: false` to override)
- **Tab origin tracking** — tabs opened via `tabs.new` are tagged `created`; pre-existing browser tabs first referenced by an agent are tagged `claimed`. On cleanup, **claimed tabs are never closed** — only detached. This protects the user's existing browser tabs from agent cleanup
- Scoped tab visibility (agent A can't see agent B's tabs via `tabs.list`)
- Independent console/network logs
- **Configurable cleanup strategy** — `detach` (default: keeps tabs open on expiry), `close` (removes created tabs on expiry), or `none` (persist indefinitely)
- **`cleanup.reset`** — master-clear that terminates all sessions. `closeTabs: true` closes agent-created tabs; pre-existing tabs are always preserved
- TTL-based expiry with full CDP cleanup (default: 5 minutes, configurable via `CDP_SESSION_TTL`)
- **Session ID security** — session UUIDs are treated as credentials and never returned in full in any output. All diagnostic messages truncate to first 8 characters, making impersonation computationally infeasible (2¹²² possibilities)
- **Session-scoped temp files** — `cleanup.clean_temp` only deletes the calling session's temp files, preserving other sessions' screenshots and artifacts
- Use `showAll: true` on `tabs.list` to bypass filtering and see all tabs
- Use `cleanup.session` to explicitly end a session and clean up its tabs

Optionally pass a custom `sessionId` to reconnect to a specific session across restarts.

### Human-Like Interaction Mode

Set `humanMode: true` on any `interact` action for anti-detection mouse movement:
- **Bezier curve paths** — mouse follows a randomized cubic bezier curve instead of teleporting to the target
- **Overshoot + correction** — overshoots the target by 3–8px, then corrects back (natural hand movement)
- **Variable speed** — faster in the middle, slower near the target
- **Jitter** — slight pixel-level randomness, peaking mid-movement
- **Position tracking** — subsequent `humanMode` calls start from the actual last position

For typing, add `typoRate: 0.03` (3% chance per char) alongside `charDelay`/`wordDelay` — types adjacent QWERTY keys, pauses to "notice", then backspace-corrects.

### Chrome Profile & Instance Management

The `browser` tool detects all running Chrome instances (Chrome, Beta, Canary, Chromium) by scanning for `DevToolsActivePort` files. It reads `Local State` for profile names and emails.

- **`browser.profiles`** — list all instances with ports, profiles, and connection status
- **`browser.connect`** — switch to a different Chrome instance by name, port, or path
- **`browser.active`** — show current instance info, profiles, health, tabs per profile context
- **`tabs.new` with `profile`** — create tabs in a specific profile by name, email, or directory (e.g. `profile: "Work"`)
- **`tabs.info`** shows `browserContextId` for profile identification
- Set `CDP_PROFILE` env var to auto-connect to a matching Chrome instance on first tool call

### Modal/Dialog Guards

If a JavaScript `alert`, `confirm`, or `prompt` is pending on a tab, the server blocks all actions except `page.dialog` and returns a clear message telling the agent to handle the dialog first.

### Smart Error Messages

Errors include actionable recovery hints:
- *"Ref 15 not found — the page may have changed. Take a new snapshot with page.snapshot."*
- *"Element \<input\> 'Email' is not visible — it may be inside a collapsed section or behind a modal."*
- *"Click target is obscured — another element is covering it at the click coordinates."*

### Connection Health Monitoring

WebSocket ping/pong every 30 seconds. If 2 consecutive pings fail, the connection is marked dead and cleaned up. Connection status is visible via `cleanup.status`.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CDP_HOST` | `127.0.0.1` | Chrome DevTools Protocol host |
| `CDP_PORT` | `9222` | Chrome DevTools Protocol port |
| `CDP_TIMEOUT` | `60000` | Global command timeout in milliseconds |
| `CDP_ACTION_TIMEOUT` | `10000` | Element action timeout (click, type, wait, etc.) in milliseconds |
| `CDP_NAVIGATION_TIMEOUT` | `60000` | Page navigation timeout in milliseconds |
| `CDP_SNAPSHOT_TIMEOUT` | `15000` | Accessibility snapshot timeout in milliseconds |
| `CDP_SESSION_TTL` | `300000` | Agent session TTL in milliseconds (5 min) |
| `CDP_DEBUGGER_TIMEOUT` | `30000` | Debugger auto-resume timeout in milliseconds |
| `CDP_CLEANUP_STRATEGY` | `detach` | Default tab cleanup strategy: `close`, `detach`, or `none` |
| `CDP_TEMP_DIR` | *(cwd)/.temp* | Directory for temp files (screenshots, PDFs). Resolved at runtime from cwd if empty |
| `CDP_PROFILE` | — | Auto-connect to Chrome instance by name or User Data path on first tool call (lazy, not at startup) |
| `CDP_USER_DATA` | — | Extra User Data directory checked first during discovery |
| `CDP_PROCESS_SCAN` | `true` | Scan running browser processes' command lines for `--user-data-dir` / `--remote-debugging-port` during discovery. Set `false` to disable |
| `CDP_SLIM_MODE` | `false` | Enable slim mode: 6 Playwright-compatible tools instead of 14. Ideal for 32K-context models |

---

## Slim Mode

For models with small context windows (32K or less), enable **Slim Mode** to reduce the tool surface from 15 tools (~8KB of schemas) to just 6 essential tools (~1.5KB):

```json
{
  "mcpServers": {
    "cdp-browser": {
      "command": "node",
      "args": ["/path/to/MCP Server/dist/index.js"],
      "env": {
        "CDP_SLIM_MODE": "true"
      }
    }
  }
}
```

### Slim Mode Tools

| Slim Tool | Maps To | Description |
|-----------|---------|-------------|
| `browser_navigate` | `page.goto` | Navigate to URL |
| `browser_snapshot` | `page.snapshot` | Get accessibility tree (supports `interactive`, `search`, `maxLength`) |
| `browser_click` | `interact.click` | Click element by ref |
| `browser_type` | `interact.type` | Type text into element |
| `browser_fill_form` | `form.fill` | Fill multiple form fields |
| `browser_tabs` | `tabs.list/new/close` | Tab management |

Tool names are **Playwright-compatible** — agents that already know Playwright MCP can use them without learning new APIs. All slim tool calls are transparently mapped to the full tool handlers.

---

## Architecture

```
MCP Server/
├── src/
│   ├── index.ts                 # Main entry point
│   ├── config.ts                # Environment variables & constants
│   ├── types.ts                 # Shared type definitions
│   ├── connection/
│   │   ├── cdp-client.ts        # WebSocket CDP client
│   │   ├── browser-discovery.ts # Auto-detect Chrome/Edge/Brave
│   │   ├── domain-manager.ts    # Lazy CDP domain enablement
│   │   ├── health-monitor.ts    # Ping/pong + auto-reconnect
│   │   └── tab-session-service.ts # Per-tab CDP session pooling
│   ├── session/
│   │   ├── session-manager.ts   # Agent session lifecycle & TTL
│   │   ├── tab-ownership.ts     # Exclusive tab locks & tracking
│   │   └── modal-state.ts       # Dialog/file-chooser blocking
│   ├── snapshot/
│   │   ├── accessibility.ts     # Full AX tree capture
│   │   ├── element-resolver.ts  # Stable uid ↔ backendNodeId mapping
│   │   ├── cache.ts             # Per-tab snapshot caching + diffs
│   │   └── token-optimizer.ts   # Role filtering, depth limits, truncation
│   ├── tools/
│   │   ├── dispatch.ts          # Preprocessing (session, tab, modal checks)
│   │   ├── registry.ts          # Tool registration
│   │   ├── base-tool.ts         # Shared tool utilities
│   │   ├── tabs.ts              # Tab management
│   │   ├── page.ts              # Navigation, snapshots, content
│   │   ├── interact.ts          # Element interaction
│   │   ├── form.ts              # Smart form filling (NEW)
│   │   ├── execute.ts           # JavaScript execution
│   │   ├── observe.ts           # Console, network, performance
│   │   ├── emulate.ts           # Device & network emulation
│   │   ├── storage.ts           # Cookie & storage management
│   │   ├── intercept.ts         # HTTP request interception
│   │   ├── cleanup.ts           # Session management
│   │   ├── browser.ts           # Browser instance management
│   │   └── debug.ts             # JS debugger & resource overrides
│   └── utils/
│       ├── error-handler.ts     # 17 error types with fix suggestions
│       ├── response-builder.ts  # Progressive truncation for LLMs
│       ├── helpers.ts           # Shared utilities
│       ├── retry.ts             # Auto-retry with backoff
│       ├── wait.ts              # Wait-for-completion helpers
│       └── temp-files.ts        # Session-scoped temp file management
└── dist/                        # Compiled output (npm run build)
```

**Key design decisions:**

- **Browser-level WebSocket** — single connection multiplexes all tabs via `Target.attachToTarget`
- **Lazy tab attachment** — tabs are only attached when you interact with them, not on startup
- **Lazy domain enablement** — CDP domains (DOM, Network, etc.) enabled on first use per tab
- **Per-tab state isolation** — each attached tab gets independent console logs, network captures, dialog tracking, and download monitoring
- **Auto-connect** — browser discovered and connected on first tool call, no manual step needed
- **Connection mutex** — prevents concurrent WebSocket opens during auto-connect
- **No browser enumeration** — works with 50+ tabs without performance degradation
- **Direct CDP** — no abstraction layer (Playwright/Puppeteer), full protocol access

---

## Usage Examples

### Navigate and screenshot a page

```
1. tabs.new      → { url: "https://example.com" }
2. page.snapshot → see accessibility tree with [ref=N]
3. page.screenshot → captures as PNG
```

### Fill a form on a React app

```
1. page.snapshot → find form fields with ref numbers
2. form.fill → { tabId: "...", fields: [
     { uid: 10, value: "John" },
     { uid: 12, value: "john@email.com" },
     { uid: 14, value: "Engineering", type: "combobox" },
     { uid: 16, value: "true", type: "checkbox" }
   ]}
   → auto-detects field types, handles React selects
3. interact.click → { uid: 20 }  // Submit button
   → auto-waits for XHR to complete
```

### Mock an API response

```
1. intercept.enable  → { patterns: ["*/api/users*"] }
2. intercept.list    → see paused request with requestId
3. intercept.fulfill → { requestId: "...", status: 200,
                         body: '{"users": []}' }
```

### Test responsive design

```
1. emulate           → { viewport: { width: 375, height: 812, mobile: true },
                         networkCondition: "slow3g" }
2. page.screenshot   → see mobile layout under slow network
3. emulate           → { reset: true }
```

### Monitor network traffic

```
1. observe.network  → { filter: "api", types: ["xhr", "fetch"] }
   → see all API calls with status, size, timing
2. observe.request  → { requestId: "..." }
   → see full request/response body
```

---

## Tested Against

| Site | DOM Size | JS Heap | Result |
|------|----------|---------|--------|
| **LinkedIn** (React SPA) | 32,000 nodes | 155 MB | All features work |
| **Instagram** (React SPA) | Complex | Large | Scroll, navigate, screenshot |
| **Gmail** (Google Workspace) | 700+ a11y elements | Large | Inbox, search, email read |
| **W3Schools** forms | Standard | Light | Type, fill, submit |
| **DemoQA** React forms | React-based | Medium | Multi-field fill |
| **The Internet** (Herokuapp) | Standard | Light | Dropdowns, checkboxes |

---

## FAQ

**Q: Does this require Playwright or Puppeteer?**  
A: No. It connects directly to Chrome via CDP WebSocket. Only dependencies are `ws` and `@modelcontextprotocol/sdk`. Built as 38 TypeScript modules compiled to JS.

**Q: Can multiple AI agents use it simultaneously?**  
A: Yes. Each agent process is automatically assigned an isolated session — no configuration needed. Sessions auto-expire after 5 minutes. Pass a custom `sessionId` to reconnect to a previous session.

**Q: Does it work with Chrome profiles / corporate Chrome?**  
A: Yes. The `browser` tool detects all running Chrome instances and their profiles. Use `browser.profiles` to see available instances and `browser.connect` to switch between them. Use `tabs.new` with the `profile` parameter to create tabs in a specific profile (e.g. `profile: "Work"` or `profile: "mansha@gmail.com"`). Sessions auto-pin to a Chrome profile on first tab interaction — all new tabs opened by the session will stay in that profile, even if the user manually switches profiles. Use `tabs.set_profile` to explicitly change the pinned profile. All Chrome profiles within one instance share a single debug port — each profile's tabs are distinguishable via `browserContextId` in `tabs.info`.

**Q: What about iframes and Shadow DOM?**  
A: The snapshot uses `Accessibility.getFullAXTree()` which captures the full accessibility tree including shadow DOM and iframes. Cross-origin (OOP) iframes are auto-discovered via `Target.setAutoAttach` and appear in snapshots with `[frame N]` prefixes. Element refs (uid) work across frames — use `uid` from snapshots to interact with iframe elements. CSS selectors only find top-level elements.

**Q: Does it support touch events?**  
A: Yes. Use `interact.tap` to dispatch touch events (`touchStart` + `touchEnd`) on elements, with full actionability checks and auto-retry. Use `emulate` with `viewport: { touch: true }` to enable touch emulation.

**Q: Can I use it with Edge?**  
A: Edge (Chromium-based) works out of the box — same CDP protocol. Enable remote debugging the same way.

**Q: How is this different from Playwright MCP's `--cdp-endpoint` mode?**  
A: Playwright MCP's `--cdp-endpoint` still uses Playwright's abstraction layer, limiting you to its API surface. This server gives you raw CDP access — network interception, device emulation, storage management, performance metrics, and capabilities Playwright doesn't expose.

---

## License

MIT
