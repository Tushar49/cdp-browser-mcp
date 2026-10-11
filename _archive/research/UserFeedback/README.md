# User Feedback & Session Analysis

## Sources
- 5 chat session logs from real production use (2026-03 to 2026-04)
- Direct user quotes and frustration points
- Agent failure patterns and workarounds

## Key Patterns

### 1. Connection Confusion
Agents don't know how to connect. They try tabs.list() → fail → try to kill browser → hallucinate.
- Sessions: chat2, chat4
- Fix applied: Auto-connect on first tool call (v5.0.0)

### 2. Tab Loss
Tabs auto-close on session expiry. User loses 35+ tabs of important work.
- Sessions: chat2
- Fix applied: Default cleanup changed to "detach" (v5.0.0)

### 3. Form Filling Failures
React comboboxes (Greenhouse, Lever) need 5 tool calls per dropdown. Agents waste context.
- Sessions: chat5 (Stripe Greenhouse forms)
- Fix applied: Smart form engine with 1-call combobox handling (v5.0.0)

### 4. Framework Click Issues
LinkedIn Ember.js doesn't respond to CDP mouse events. Agents have to learn JS click workaround.
- Sessions: chat2
- Fix applied: JS-click fallback (v5.0.0)

### 5. Enterprise App Timeouts
D365, SharePoint take 60-90s to load. 30s timeout causes cascading failures.
- Sessions: chat5 (D365 mashtest)
- Fix applied: 60s default + tiered timeouts (v5.0.0)

### 6. Stale Element References
Refs change between snapshot and click. "Element ref=284 not found" constantly.
- Sessions: chat2 (Gmail), chat5 (Greenhouse)
- Fix applied: Cumulative ElementResolver (v5.0.0)

### 7. Playwright vs CDP (Direct Comparison)
User tested same D365 task with both. Playwright loaded in 60s and worked. CDP timed out repeatedly.
- Sessions: chat5
- Key difference: Playwright's waitForText is more reliable than CDP polling

## Direct User Quotes
> "it is extremely extremely behind other competitors like playwright mcp"
> "it autocloses all tabs user gets so frustrated"
> "it does nothing literally"
> "I think entire project needs to be re-made, restructured"
> "agents know how to use the mcp server, and doesn't be dumb"
> "We should support multiple diff browser connections right"
> "connecting, maintaining the fact that the tab shouldn't be opened in focused browser profile but the profile we wanna open it in and so on all are very very very bad"
> "See how CDP is so limited, how bad its structure, tool calling, everything is"

## Lessons Learned
1. Default settings must be safe (detach, not close)
2. Auto-connect is non-negotiable
3. Tool descriptions ARE the documentation for agents
4. One-call operations beat multi-step sequences every time
5. Framework-specific workarounds should be automatic, not manual
6. Enterprise apps need long timeouts by default
7. Error messages must tell agents WHAT TO DO, not just what went wrong
