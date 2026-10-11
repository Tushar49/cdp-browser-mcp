# Tool Comparison: CDP Browser MCP vs Playwright MCP

> **Date**: July 2025
> **Purpose**: Side-by-side analysis for tool naming, design, and LLM optimization
> **Sources**: `MCP Server/src/tools/*.ts` (our v5 tools), `PlaywrightMCP.md` (Playwright MCP v0.0.70)

---

## 1. Tool Name Mapping

### Our Tools → Playwright Equivalents

| # | Our Tool | Actions | Playwright Equivalent(s) | Notes |
|---|----------|---------|--------------------------|-------|
| 1 | **tabs** | list, find, new, close, activate, info | `browser_tabs` (list, new, close, select) | We add `find`, `activate`, `info`. They use `select` (by index), we use `activate` (by tabId). We support profile-aware tab creation. |
| 2 | **page** | goto, back, forward, reload, snapshot, screenshot, content, set_content, wait, pdf, dialog, inject, add_style, bypass_csp, frames | `browser_navigate`, `browser_navigate_back`, `browser_snapshot`, `browser_take_screenshot`, `browser_wait_for`, `browser_handle_dialog`, `browser_pdf_save` | Our largest tool — 15 actions in 1. They split across 7+ separate tools. We add `content`, `set_content`, `inject`, `add_style`, `bypass_csp`, `frames`. |
| 3 | **interact** | click, hover, type, fill, select, press, drag, scroll, upload, focus, check, tap | `browser_click`, `browser_hover`, `browser_type`, `browser_press_key`, `browser_drag`, `browser_select_option`, `browser_file_upload` | 12 actions vs 7+ separate tools. We add `scroll`, `focus`, `check`, `tap`, `fill` (multi-field). We have `humanMode`, `autoSnapshot`, `typoRate` — unique. |
| 4 | **form** | fill, read, clear | `browser_fill_form` | **Key differentiator.** Our form is smarter: auto-detects field type from a11y role, handles combobox with char-by-char typing + dropdown selection, date pickers, file uploads, read & clear actions. Playwright's fill_form just fills text/checkbox/radio/combobox/slider. |
| 5 | **execute** | eval, script, call | `browser_evaluate`, `browser_run_code` | Similar. They add `browser_run_code` (arbitrary Playwright code) — we don't have an equivalent (our `script` is raw JS, not framework code). |
| 6 | **observe** | console, network, request, performance, downloads, har | `browser_console_messages`, `browser_network_requests` | We're more comprehensive: performance metrics, download tracking, HAR export, individual request body retrieval. They keep it minimal. |
| 7 | **emulate** | viewport, colorScheme, userAgent, geolocation, cpuThrottle, timezone, locale, visionDeficiency, autoDarkMode, idle, networkCondition, ignoreSSL, blockUrls, extraHeaders, reset | `browser_resize` (partial) | **Unique to us.** Playwright has `browser_resize` and some launch options but no runtime emulation tool. 15 emulation capabilities in one call. |
| 8 | **storage** | get_cookies, set_cookie, delete_cookies, clear_cookies, clear_data, quota | `browser_cookie_*` (opt-in `storage` capability) | More comprehensive. They have separate cookie tools + localStorage/sessionStorage tools, but require `--caps=storage` opt-in. We include by default. |
| 9 | **intercept** | enable, disable, continue, fulfill, fail, list | `browser_route`, `browser_unroute`, `browser_route_list` (opt-in `network` capability) | Both have network interception. They require `--caps=network` opt-in. Our intercept is request-level (CDP Fetch domain); theirs is route-based (Playwright routes). |
| 10 | **cleanup** | disconnect_tab, disconnect_all, clean_temp, status, list_sessions, session, reset | `browser_close` | **Much more comprehensive.** They just close. We manage multi-agent sessions, temp files, connection health, TTL, and graceful shutdown. |
| 11 | **browser** | profiles, connect, active | *(N/A — they launch their own)* | **Different model.** We connect to existing browsers; they launch/manage their own. Our approach preserves user state. |
| 12 | **debug** | enable, disable, set_breakpoint, remove_breakpoint, list_breakpoints, pause, resume, step_over, step_into, step_out, call_stack, evaluate_on_frame, list_scripts, get_source, override_resource, remove_override, list_overrides, set_dom_breakpoint, remove_dom_breakpoint, set_event_breakpoint, remove_event_breakpoint | `browser_highlight`, `browser_start_tracing` (opt-in `devtools` capability) | **Unique to us.** Full JS debugger with breakpoints, stepping, call stacks, resource overrides, DOM/event breakpoints. 21 actions — our most complex tool. They have basic devtools features via opt-in. |

### Summary Count

| Metric | CDP Browser | Playwright MCP |
|--------|-------------|---------------|
| Total tools exposed | **12** | **21** core + ~30 opt-in |
| Total unique actions/operations | **~95** | **~21** (core) + ~30 (opt-in, 1:1 per tool) |
| Tools always enabled | 12 | 21 |
| Require opt-in | 0 | 6 capability groups |

---

## 2. Design Philosophy Comparison

### Architecture Model

| Aspect | CDP Browser (Ours) | Playwright MCP |
|--------|-------------------|----------------|
| **Pattern** | Action-dispatch (few tools, many actions) | One-tool-per-action (many tools, simple params) |
| **Tool count** | 12 tools | 21+ core tools |
| **Required `action` param** | Yes (all except `emulate`) | Only `browser_tabs` |
| **Schema complexity** | High per tool (union of all action params) | Low per tool (targeted params) |
| **Browser connection** | Connect to existing (preserves user state) | Launch own (clean environment) |
| **Capabilities** | All always available | Core + opt-in capabilities |
| **Session model** | Multi-agent with tab ownership/locks | Single-agent, single-context |
| **Tab addressing** | By `tabId` (CDP target ID) | By index (0, 1, 2...) |
| **Element refs** | `uid` (integer from AX tree) | `ref` (string like `s1e3`) |

### LLM Friendliness Analysis

**Playwright's approach (many simple tools):**
- ✅ LLM sees tool names that describe exactly what they do (`browser_click`, `browser_type`)
- ✅ Each tool has a small, focused parameter set — less confusion
- ✅ No need to remember `action` values — tool name IS the action
- ✅ Tool selection is the LLM's strongest skill (trained extensively on it)
- ❌ Long tool listing in system prompt (21+ tools × descriptions)
- ❌ Some tools are very similar (e.g., `browser_click` vs `browser_hover` differ by 1 param)

**Our approach (few tools with action dispatch):**
- ✅ Compact tool listing (12 entries vs 21+)
- ✅ Related actions grouped logically (all page ops together)
- ✅ Fewer tool calls for discovery ("what can I do with pages?" → read `page` description)
- ❌ Complex schemas — `interact` has 30+ params (most irrelevant per action)
- ❌ LLMs must remember action enum values AND which params go with which action
- ❌ Action descriptions stuffed into tool description, not visible during tool selection
- ❌ Token waste: irrelevant params serialized in every call schema

### Verdict

**For current-gen LLMs (GPT-4, Claude, etc.), Playwright's approach is marginally better for simple tasks.** LLMs are very good at tool selection but can struggle with complex union schemas. However, our approach has **lower schema overhead** and **better discoverability** for complex workflows.

The real cost is in the **description field** — our descriptions are 800-2000 chars each, Playwright's are 10-50 chars each. But Playwright puts usage guidance in the _response_ (structured markdown sections), not the schema.

---

## 3. Recommendations

### 3.1 Tool Splitting Candidates

| Candidate | Recommendation | Rationale |
|-----------|---------------|-----------|
| Split `navigate` from `page` | **No** | Navigation (goto/back/forward/reload) is tightly coupled with page state. Splitting would force users to learn two tools for the same workflow. |
| Split `snapshot` from `page` | **Consider** | `snapshot` is the #1 most-called action. A standalone `snapshot` tool would reduce schema weight on every call. But it adds one more tool to the listing. |
| Split `screenshot` from `page` | **No** | Low call frequency doesn't justify the extra tool. |
| Split `debug` into debugger + overrides | **Consider** | 21 actions is too many. Resource overrides are conceptually different from JS debugging. Could split into `debug` (14 actions) + `override` (3 actions). |
| Split `dialog` from `page` | **No** | Playwright does this, but dialog handling is rare and simple. |

### 3.2 Tool Merging Candidates

| Candidate | Recommendation | Rationale |
|-----------|---------------|-----------|
| Merge `form` into `interact` | **No** | `form` is our key differentiator with unique auto-detection logic. Keeping it separate gives it prominence in tool listings. |
| Merge `emulate` into `page` | **No** | Emulation is device/network-level, not page content. Different mental model. |
| Merge `browser` + `cleanup` | **Consider** | Both are "server management" tools. Combined they'd have 10 actions — manageable. But they serve different personas (setup vs teardown). |

### 3.3 Renaming for LLM Friendliness

| Current Name | Proposed Name | Reason |
|-------------|---------------|--------|
| `tabs` | Keep `tabs` | Clear, matches Playwright's `browser_tabs`. |
| `page` | Keep `page` | Concise. Could prefix `browser_page` for namespace consistency but adds verbosity. |
| `interact` | Keep `interact` | Good umbrella term. Alternative: `element` — but `interact` implies action. |
| `form` | Keep `form` | Clear, differentiating. |
| `execute` | Consider `eval` or `js` | Shorter, more intuitive. `execute` sounds like "run a program". `js` is 2 chars. |
| `observe` | Keep `observe` | Good for read-only monitoring. Alternative: `monitor`. |
| `emulate` | Keep `emulate` | Standard term. |
| `storage` | Keep `storage` | Clear. Matches Playwright's capability name. |
| `intercept` | Keep `intercept` | Clear. Maps to CDP Fetch domain. |
| `cleanup` | Consider `session` | Primary use is session management. `cleanup` sounds like housekeeping. |
| `browser` | Keep `browser` | Clear. |
| `debug` | Keep `debug` | Clear. |

**Overall: No urgent renames needed.** Names are already short and descriptive. The biggest improvement would be description optimization, not renaming.

### 3.4 Description Length Comparison

| Tool | Our Description (chars) | Playwright Equivalent (chars) | Our Ratio |
|------|------------------------|-------------------------------|-----------|
| tabs | 950 | 120 (`browser_tabs`) | 7.9× |
| page | 2,150 | 30 each × 7 tools = ~210 | 10.2× |
| interact | 2,400 | 50 each × 7 tools = ~350 | 6.9× |
| form | 850 | 150 (`browser_fill_form`) | 5.7× |
| execute | 750 | 100 (`browser_evaluate` + `browser_run_code`) | 7.5× |
| observe | 1,050 | 80 (`browser_console_messages` + `browser_network_requests`) | 13.1× |
| emulate | 1,100 | 50 (`browser_resize`) | 22× |
| storage | 650 | N/A (opt-in) | — |
| intercept | 950 | N/A (opt-in) | — |
| cleanup | 850 | 20 (`browser_close`) | 42.5× |
| browser | 800 | N/A | — |
| debug | 1,750 | N/A | — |

**Our descriptions are 6-42× longer than Playwright's.** This is a deliberate trade-off:
- **Playwright** keeps descriptions minimal because tool names are self-documenting
- **We** must pack all action documentation into the description since it's the only place LLMs learn about available actions

**Recommendation**: Consider moving detailed action docs to a separate `annotations.instructions` field (MCP spec supports this) and keeping the main description to 2-3 sentences. The action `enum` values themselves guide the LLM.

### 3.5 Parameter Naming Consistency

| Pattern | Ours | Playwright | Issue? |
|---------|------|-----------|--------|
| Tab identifier | `tabId` (string, CDP target ID) | Index-based (0, 1, 2) | Different model — ours is more robust |
| Element ref | `uid` (number) | `ref` (string, e.g. `s1e3`) | Both work. Ours is simpler. |
| Element fallback | `selector` (CSS) | *(hidden in MCP mode)* | We expose selectors; they force ref-only |
| Timeout | `timeout` (ms) | `timeout` (ms via Zod) | Consistent ✅ |
| Action param | `action` (string enum) | *(N/A — tool name IS action)* | Our pattern |
| Session | `sessionId` + `cleanupStrategy` + `exclusive` | *(N/A — single session)* | We add 3 params to every tool |

**Session param overhead**: Every tool schema includes `sessionId`, `cleanupStrategy`, and `exclusive` — 3 params that rarely change. This adds ~180 chars per tool schema × 12 tools = **~2,160 chars of repeated schema** that the LLM processes on every request.

**Recommendation**: Consider making session params implicit (read from request headers or MCP metadata) rather than explicit per-call params. Alternatively, only include them on tools where they matter (`tabs.new`, `cleanup.session`).

---

## 4. Feature Gap Analysis

### Features Playwright Has That We Don't

| Playwright Feature | Their Tool | Gap Severity | Notes |
|-------------------|-----------|-------------|-------|
| Run framework code | `browser_run_code` | **Low** | Runs arbitrary Playwright JS. We have `execute.script` for raw JS. Framework code isn't applicable to CDP. |
| Forward navigation | `browser_navigate_forward` (skill-only) | **None** | We have `page.forward`. |
| Reload | `browser_reload` (skill-only) | **None** | We have `page.reload`. |
| Vision mouse tools | `browser_mouse_click_xy`, etc. (opt-in) | **Medium** | Coordinate-based mouse without element refs. Useful for canvas/game apps. We could add x/y to `interact.click`. |
| Tracing/video | `browser_start_tracing`, `browser_start_video` (opt-in) | **Low** | DevTools recording features. Nice-to-have, not essential. |
| Test assertions | `browser_verify_*` (opt-in) | **Low** | Testing-specific tools. Our `page.wait` + `execute.eval` cover most cases. |
| Locator generation | `browser_generate_locator`, `browser_pick_locator` (opt-in) | **Low** | DevTools helpers for test authoring. Niche. |
| localStorage/sessionStorage | `browser_localstorage_*`, `browser_sessionstorage_*` (opt-in) | **Medium** | We only have `storage.clear_data` for web storage. We lack read/write for localStorage. Could add to `storage` tool. |
| Storage state save/restore | `browser_storage_state`, `browser_set_storage_state` (opt-in) | **Low** | Serializes all cookies + storage to JSON. Nice for test setup. |
| Code generation | Every tool emits Playwright code | **Low** | Useful for test generation but doesn't affect browser automation. |
| Modal state blocking | `defineTabTool` auto-checks | **Medium** | When a dialog/file-chooser is open, Playwright blocks all tools except the handler. We don't enforce this. |
| Auto-completion waiting | `waitForCompletion()` after mutations | **Medium** | They auto-wait for network settle after clicks/types. We don't — agents must use `page.wait` manually. |
| Secret redaction | Response text scrubs configured secrets | **Low** | Security feature for sensitive data in responses. |
| Highlight element | `browser_highlight` (devtools opt-in) | **Low** | Visual debugging helper. |

### Features We Have That Playwright Doesn't

| Our Feature | Our Tool | Advantage Level | Notes |
|-------------|---------|----------------|-------|
| Connect to existing browser | `browser.connect` | **High** | Preserves user login state, bookmarks, extensions. Playwright always launches fresh. |
| Multi-agent sessions | `cleanup.list_sessions` | **High** | Tab ownership, locks, TTL. Playwright is single-agent only. |
| JS debugger | `debug` (21 actions) | **High** | Full breakpoint debugging — no equivalent in any other MCP server. |
| Resource overrides | `debug.override_resource` | **High** | Auto-replace responses by regex pattern — no LLM round-trip per request. |
| Network interception | `intercept` | **Medium** | More granular than Playwright's route-based approach (request-level vs pattern-level). |
| Device emulation | `emulate` (15 capabilities) | **High** | Runtime viewport, geolocation, timezone, locale, vision deficiency, network throttling, SSL bypass, URL blocking. |
| Performance metrics | `observe.performance` | **Medium** | DOM size, JS heap, layout counts — direct CDP Performance domain access. |
| HAR export | `observe.har` | **Medium** | Export captured traffic as HAR 1.2 JSON. |
| Download tracking | `observe.downloads` | **Low** | Track file download progress. |
| Smart combobox filling | `form.fill` (combobox) | **High** | Types char-by-char to trigger framework search, waits for dropdown, auto-selects match. Playwright's fill_form has basic combobox support. |
| Profile-aware tabs | `tabs.new` with `profile` | **Medium** | Create tabs in specific Chrome profiles. |
| Tab search | `tabs.find` | **Low** | Search tabs by title/URL. Playwright only lists by index. |
| CSP bypass | `page.bypass_csp` | **Medium** | Disable Content Security Policy for testing. |
| CSS/JS injection | `page.inject`, `page.add_style` | **Medium** | Inject persistent scripts and styles. |
| Content extraction | `page.content` | **Medium** | Get text/HTML/full-document content. Playwright has snapshot but not raw content extraction. |
| Storage quota | `storage.quota` | **Low** | Check storage usage and quota. |

---

## 5. LLM Token Cost Analysis

### Schema Size Comparison

Approximate character count of the JSON Schema for each tool's `inputSchema`:

| Our Tool | Schema Chars | Playwright Equivalent(s) | Total Schema Chars |
|----------|-------------|--------------------------|-------------------|
| tabs | ~1,200 | browser_tabs | ~250 |
| page | ~2,800 | 7 tools × ~200 avg | ~1,400 |
| interact | ~3,200 | 7 tools × ~300 avg | ~2,100 |
| form | ~800 | browser_fill_form | ~500 |
| execute | ~900 | browser_evaluate + browser_run_code | ~400 |
| observe | ~1,100 | browser_console_messages + browser_network_requests | ~400 |
| emulate | ~2,200 | browser_resize | ~150 |
| storage | ~1,200 | (opt-in, not counted) | — |
| intercept | ~1,400 | (opt-in, not counted) | — |
| cleanup | ~800 | browser_close | ~50 |
| browser | ~400 | (N/A) | — |
| debug | ~2,000 | (N/A) | — |
| **TOTAL** | **~18,000** | — | **~5,250** |

### Description Size Comparison

| Our Tool | Desc Chars | Playwright Equivalents | Total Desc Chars |
|----------|-----------|------------------------|-----------------|
| tabs | ~950 | browser_tabs | ~120 |
| page | ~2,150 | 7 tools × ~30 avg | ~210 |
| interact | ~2,400 | 7 tools × ~60 avg | ~420 |
| form | ~850 | browser_fill_form | ~200 |
| execute | ~750 | 2 tools × ~80 avg | ~160 |
| observe | ~1,050 | 2 tools × ~50 avg | ~100 |
| emulate | ~1,100 | browser_resize | ~40 |
| storage | ~650 | (opt-in) | — |
| intercept | ~950 | (opt-in) | — |
| cleanup | ~850 | browser_close | ~25 |
| browser | ~800 | (N/A) | — |
| debug | ~1,750 | (N/A) | — |
| **TOTAL** | **~14,250** | — | **~1,275** |

### Total Schema + Description Overhead

| Metric | CDP Browser (Ours) | Playwright MCP (Core) |
|--------|-------------------|----------------------|
| Total tools | 12 | 21 |
| Schema chars | ~18,000 | ~5,250 |
| Description chars | ~14,250 | ~1,275 |
| **Total chars** | **~32,250** | **~6,525** |
| **Approx tokens** (÷4) | **~8,060** | **~1,630** |
| Token overhead per LLM call | ~8K tokens | ~1.6K tokens |

### Analysis

Our tool schemas consume **~5× more tokens** than Playwright's core tools. Key drivers:

1. **Description verbosity** (~14K chars vs ~1.3K): We embed full documentation in descriptions. Playwright keeps descriptions minimal and puts usage info in responses.

2. **Session params** (~2.2K chars): `sessionId`, `cleanupStrategy`, `exclusive` repeated across 12 tools adds ~180 chars × 12 = ~2,160 chars.

3. **Union schemas**: Each tool carries params for ALL its actions. `interact` has 30+ params even though `click` only needs 4.

4. **Additional features**: We have 5 tools with no Playwright equivalent (emulate, storage, intercept, browser, debug) — ~7,800 chars of schema with no comparison.

### Optimization Opportunities

| Optimization | Token Savings | Effort |
|-------------|--------------|--------|
| Trim descriptions to 2-3 lines + move docs to annotations | ~10K chars (~2,500 tokens) | Medium |
| Make session params implicit / header-based | ~2.2K chars (~550 tokens) | High |
| Split `debug` into 2 tools with focused schemas | ~400 chars (~100 tokens) | Low |
| Use conditional schema (only show relevant params) | ~5K chars (~1,250 tokens) | Very High (MCP spec limitation) |
| **Total achievable savings** | **~12.6K chars (~3,150 tokens)** | — |

After optimization, we'd be at **~19.6K chars (~4,900 tokens)** — still 3× Playwright but with **5× the capabilities**.

---

## 6. Key Takeaways

### What We Do Better
1. **Connect to existing browsers** — preserves user state, no cold start
2. **Multi-agent session management** — production-ready for concurrent agents
3. **Full JS debugger** — no other MCP server offers breakpoint debugging
4. **Device/network emulation** — comprehensive runtime emulation suite
5. **Smart form filling** — combobox auto-detection is a genuine differentiator
6. **Network interception** — request-level control with CDP Fetch domain

### What Playwright Does Better
1. **Minimal schema overhead** — LLMs process 5× fewer tokens
2. **Self-documenting tool names** — `browser_click` needs no description
3. **Auto-completion waiting** — no manual `wait()` after actions
4. **Modal state enforcement** — prevents tool misuse during dialogs
5. **Code generation** — every action emits reproducible Playwright code
6. **Cross-browser support** — Chrome, Firefox, WebKit

### Recommended Actions (Priority Order)

1. **[High] Trim descriptions** — Move detailed docs to `annotations.instructions`. Keep descriptions ≤3 lines.
2. **[High] Add auto-wait** — After `interact.click/type/fill`, auto-wait for network settle (like Playwright's `waitForCompletion`).
3. **[Medium] Add modal state checking** — Block tools when dialogs/file-choosers are pending.
4. **[Medium] Add localStorage read/write** — Parity gap in `storage` tool.
5. **[Low] Consider splitting `debug`** — Into `debug` (JS debugger) + `override` (resource overrides).
6. **[Low] Consider standalone `snapshot`** — Most-called action; could reduce per-call schema weight.
