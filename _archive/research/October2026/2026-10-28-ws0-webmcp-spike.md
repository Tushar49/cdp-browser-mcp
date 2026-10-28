# WS0 WebMCP live spike — 2026-10-28 — **GO** (outcome (a)-after-flags)

Target: Brave 153.1.95.104 portable (Chromium 153), approval-mode CDP.
Rig: localhost:8877/rig.html (this folder's scripts — `serve.mjs`,
`rig.html`, `probe.mjs` full-wire probe, `invoke.mjs` invoke E2E).
Probes hardcode the dev ws path + the portable `DevToolsActivePort`
location — adjust when re-running elsewhere.

## Findings

1. **Default Brave 153: page API ABSENT.** Pre-flag probe:
   `navigator.modelContext` absent, no registration possible — while
   `WebMCP.enable` answered OK. Exact FedCm pattern: domain alive,
   page side dead. Canary honesty confirmed: the canary proves the
   DOMAIN, never the page API.
2. **The API is flag-gated, and the flags exist on Brave 153.**
   `chrome://flags` (verified in-DOM via shadow-piercing probe):
   - `#enable-webmcp-testing` — "WebMCP for testing / Enables the WebMCP API."
   - `#devtools-webmcp-support` — "WebMCP support in DevTools."
   Both enabled by the maintainer (their consent, manual relaunch).
   BOTH were enabled together, so which one unlocked what is unverified;
   a future one-flag test can split it if it matters.
3. **API location has MOVED: `document.modelContext`** — NOT
   `navigator.modelContext` (navigator form deprecated in Chrome 150+;
   the July 2026 spec move). Brave 153: `document.modelContext` is an
   object; `navigator.modelContext` is absent. Registration method:
   **`registerTool`** (provideTools absent on this build).
   Feature-detect BOTH locations + BOTH methods in anything we ship
   or test (spec churn is real — declarative HTML annotations were
   removed from the spec 2026-10-08; only JS-registered tools remain).
4. **CDP wiring FULLY WORKS post-flags:**
   - `WebMCP.enable` **replays** currently-registered tools via
     `toolsAdded` (the at-load registration arrived in the replay).
   - Post-enable re-registration fires `toolsAdded` LIVE.
   - Event payload: `{name, description, inputSchema, frameId,
     stackTrace}` — matches the protocol verification exactly
     (no `annotations` seen on this tool; rig didn't set any).
   - `WebMCP.invokeTool(frameId, toolName, input)` → `invocationId` →
     `toolResponded({invocationId, status: "Completed", output})` —
     echoed `{hello: "ws0"}` came back intact. **E2E PASS.**
5. **Race lesson (cost us one misleading run):** attach the
   `toolsAdded` listener BEFORE `WebMCP.enable` — the replay event
   arrives in the same flush as the enable response; a
   listen-then-enable order swallows it and looks like "no events."
   WS3's registry MUST subscribe before enabling.
6. Probe bugs fixed in-flight: `waitEvent` timeout never resolved
   (hung the probe); the navigator-only API check (finding 3).

## Disposition

- WS0 verdict: **GO** — WS3 ships in 5.3 per plan, live-gated against
  this rig.
- Docs/README for WS3 MUST name both flags (Brave needs the user to
  enable them; we never relaunch — the flags are a one-time USER step,
  same lane as WS0 outcome (b)'s "flag-naming gate error").
- The maintainers's browser now has the flags on — WS3 live tests work
  in-session; a stock-Brave user without flags gets the
  capability-gate error (which now CAN name the flags as the remedy).
- Tab note: the designated spike tab is on the rig; cinecat tab was
  lost in the relaunch (session restore did not keep it).
