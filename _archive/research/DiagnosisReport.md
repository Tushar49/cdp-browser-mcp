# Diagnosis Report: Real Failure Patterns from User Sessions

Compiled from 5 production chat session logs (2026-03 to 2026-04), UserFeedback analysis, and codebase audit.

---

## Category 1: Connection Failures

### 1.1 Auto-Connect Not Working (P0)
- **Sessions:** chat2, chat3, chat4
- **Pattern:** Agents call `tabs.list()` as first action → fails because no browser connected → agent hallucinates a fix (tries to kill browser, restart, etc.)
- **Root Cause:** v4 required manual `browser.connect` before any tool call. Agents never read docs.
- **User Quote:** _"connecting, maintaining the fact that the tab shouldn't be opened in focused browser profile but the profile we wanna open it in and so on all are very very very bad"_
- **Fix Applied:** Auto-connect on first tool call (v5.0.0) — `ensureConnected()` mutex in `src/index.ts:480`
- **Remaining Risk:** If Chrome isn't running with `--remote-debugging-port`, auto-connect still fails. Error message needs actionable fix instructions.

### 1.2 Wrong Profile Connection
- **Sessions:** chat3
- **Pattern:** User wants to connect to a specific Chrome profile but MCP connects to the default/wrong one. Auth cookies, sessions, extensions are missing.
- **Root Cause:** No profile selection in v4. `CDP_PROFILE` env var added in v5 but agents can't change it mid-session.
- **Fix Applied:** `autoConnectProfile` config in `src/config.ts:41`, browser discovery in health-monitor.

### 1.3 WebSocket Disconnects
- **Pattern:** CDP WebSocket drops mid-operation (Chrome update, tab crash, sleep/wake). All subsequent calls fail silently.
- **Fix Applied:** `HealthMonitor` with auto-reconnect in `src/connection/health-monitor.ts`. Domain state cleared on disconnect (`src/index.ts:84-93`).

---

## Category 2: Tab Management Failures

### 2.1 Tabs Auto-Close on Session Expiry (P0)
- **Sessions:** chat2
- **Pattern:** User has 35+ important tabs open. MCP session expires → all tabs auto-closed. User loses work.
- **User Quote:** _"it autocloses all tabs user gets so frustrated"_
- **Root Cause:** v4 default cleanup strategy was `"close"`.
- **Fix Applied:** Default changed to `"detach"` in v5 (`src/config.ts:33`). Tabs survive session expiry.

### 2.2 Tab Ownership Conflicts
- **Pattern:** Multiple agent sessions fight over the same tab. One session's actions interfere with another's.
- **Fix Applied:** `TabOwnership` with exclusive locking in `src/session/tab-ownership.ts`.

---

## Category 3: Form Filling Failures

### 3.1 React/Ember Combobox Multi-Step Nightmare
- **Sessions:** chat5 (Stripe Greenhouse forms)
- **Pattern:** Filling a single dropdown requires 5+ tool calls: click to open → type to filter → wait for options → click option → verify. Agents waste entire context windows on one field.
- **Root Cause:** No high-level form abstraction. Each CDP interaction was manual.
- **Fix Applied:** Smart form engine in `src/tools/form.ts` — single-call combobox handling with framework detection.

### 3.2 Country Code Dropdown ("+91" Pattern)
- **Pattern:** Phone number country code selectors (like LinkedIn's) are comboboxes with 200+ options. Agent types "+91" but can't select India because:
  - Dropdown doesn't filter by typed text
  - Need to scroll through options
  - Option text is "India (+91)" not "+91"
- **Root Cause:** Combobox handling needs search-then-select, not just type.
- **Fix Needed:** Form engine should handle country code selectors as a special case — search by partial match.

### 3.3 LinkedIn Ember.js Click Failures
- **Sessions:** chat2
- **Pattern:** LinkedIn uses Ember.js framework. Standard CDP `Input.dispatchMouseEvent` clicks are ignored because Ember binds events via its own event delegation system.
- **Root Cause:** CDP mouse events don't trigger Ember's synthetic event handlers.
- **Fix Applied:** JS-click fallback in interact tools (`element.click()` via `Runtime.callFunctionOn`).

---

## Category 4: Stale Element References

### 4.1 "Element ref=X not found" (P1)
- **Sessions:** chat2 (Gmail), chat5 (Greenhouse)
- **Pattern:** Agent takes snapshot → gets ref=284 → page re-renders (React, SPA navigation) → clicks ref=284 → "not found". Happens constantly on dynamic pages.
- **Root Cause:** v4 generated new refs on every snapshot. SPAs re-render frequently.
- **Fix Applied:** Cumulative `ElementResolver` in `src/snapshot/element-resolver.ts` — refs persist across snapshots via `backendNodeId` stability. Old refs remain valid as long as the DOM element exists.

---

## Category 5: Timeout Failures

### 5.1 Enterprise App Timeouts (D365, SharePoint)
- **Sessions:** chat5 (D365 mashtest)
- **Pattern:** D365/SharePoint pages take 60-90s to load. 30s default timeout → navigation fails → agent retries → fails again → cascading context waste.
- **User Quote:** _"it is extremely extremely behind other competitors like playwright mcp"_
- **Root Cause:** Single 30s timeout for all operations.
- **Fix Applied:** Tiered timeouts in v5 (`src/config.ts:22-26`):
  - Action: 10s (clicks, types)
  - Snapshot: 15s
  - Navigation: 60s
  - Global: 60s

### 5.2 Playwright vs CDP Direct Comparison
- **Sessions:** chat5
- **Pattern:** User tested same D365 task with Playwright MCP and CDP MCP. Playwright loaded in 60s. CDP timed out repeatedly.
- **Key Difference:** Playwright's `waitForText` uses MutationObserver. CDP polling every 300ms is less reliable on slow pages.

---

## Category 6: Context/Token Exhaustion

### 6.1 Tool Schema Bloat
- **Pattern:** 15 tools × large schemas = ~8KB+ ListTools response. Small models (32K context) spend 25%+ of context on tool definitions alone.
- **Root Cause:** Each tool has detailed descriptions + many optional parameters.
- **Fix Needed:** Slim mode — 6 essential tools with minimal schemas for small models.

### 6.2 Snapshot Size
- **Pattern:** Full accessibility trees on complex pages (Gmail, D365) can be 30-50KB. Small models can't fit snapshot + tool schemas + conversation history.
- **Root Cause:** Token optimizer helps but doesn't have an interactive-only mode or hard cap.
- **Fix Needed:** `interactive` filter mode, `search` mode, and `maxLength` cap.

---

## Category 7: Agent Comprehension Failures

### 7.1 Tool Description Confusion
- **Pattern:** Agents don't understand the action-based dispatch model. They try `browser.snapshot()` instead of `page({ action: 'snapshot', tabId: '...' })`.
- **Root Cause:** Tool descriptions are the only docs agents see. Complex action-enum tools are harder to discover.
- **Fix Needed:** Slim mode exposes flat tool names (`browser_snapshot`, `browser_click`) that match Playwright MCP conventions agents already know.

### 7.2 Error Messages Not Actionable
- **Pattern:** Agent gets "Connection refused" → doesn't know to tell user to start Chrome with `--remote-debugging-port=9222`.
- **Fix Applied:** `ActionableError` with "How to fix" sections in `src/utils/error-handler.ts` (17 error types).

---

## Summary: Fix Status

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1.1 | Auto-connect | P0 | ✅ Fixed (v5) |
| 1.2 | Wrong profile | P1 | ✅ Fixed (v5) |
| 1.3 | WebSocket drops | P1 | ✅ Fixed (v5) |
| 2.1 | Tab auto-close | P0 | ✅ Fixed (v5) |
| 2.2 | Tab conflicts | P1 | ✅ Fixed (v5) |
| 3.1 | Combobox 5-call | P1 | ✅ Fixed (v5) |
| 3.2 | Country code | P2 | ⚠️ Partial |
| 3.3 | Ember clicks | P1 | ✅ Fixed (v5) |
| 4.1 | Stale refs | P1 | ✅ Fixed (v5) |
| 5.1 | Enterprise timeouts | P1 | ✅ Fixed (v5) |
| 5.2 | Playwright parity | P2 | ⚠️ Gap remains |
| 6.1 | Schema bloat | P2 | 🔧 Fixing now (slim mode) |
| 6.2 | Snapshot size | P2 | 🔧 Fixing now (interactive/search/cap) |
| 7.1 | Tool discovery | P2 | 🔧 Fixing now (slim mode) |
| 7.2 | Error messages | P1 | ✅ Fixed (v5) |
