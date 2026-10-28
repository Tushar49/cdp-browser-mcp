# Live agent-DX failures (2026-10-27/28) — tabId friction + text-only outputs

Observed in a REAL Code Mode session (agent driving `cdp-browser` against a
local app). Two failure classes, both reproducible and structural:

## A. `page({action:'goto', url})` without `tabId` → raw schema rejection

```
Invalid arguments for tool "cdp-browser_page":
  - tabId: Missing key
```

Root cause: `required: ['action','tabId']` in the tool schema — the MCP
CLIENT validates before the server runs, so our actionable-error system
never engages. The agent sees a validation error with no "How to fix" and
no list of open tabs. Agents reliably forget tabId because "navigate
somewhere" reads like a browser-level operation.

**Fix (E5):** make `tabId` optional at the schema layer across tab-bound
tools; auto-resolve in `preprocessToolCall` — exactly one open page tab →
inject it; zero → actionable "no tabs open"; multiple → actionable error
listing open tabs (id + URL) telling the agent to pick or use `tabs find`.
Action-aware: `tabs` list/find/new and authenticatorId-only webauthn
actions must NOT auto-resolve (tabs.list with 11 tabs must not start
erroring about tabId — the exact second failure below).

## B. `tabs({action:'list'})` returns formatted TEXT; agent did `tabs.find(...)`

```
TypeError: tabs.find is not a function. (line 2, col 17)
```

The agent treated the text result as an array. Two contributors:
1. Tools return text-only `ToolResult`s (MCP content model) — fine, but
   agents that want to PROGRAM over the result need machine-readable text.
2. `tabs` already HAS a `find` action (title/URL substring search) — the
   agent didn't look; a JSON option makes programmatic use natural.

**Fix (E6):** `tabs` list/find gain `format: 'text'|'json'` (default text;
json = parseable `[{id,url,title,profile}]`) and `list` gains an optional
`urlFilter` substring (server-side filter, mirrors the intent of the
agent's JS `.find` attempt). Update the tool description so agents see the
json option at handshake time.
