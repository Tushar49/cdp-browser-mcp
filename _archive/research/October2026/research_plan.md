# Research Plan — October 2026

**Status: COMPLETE (2026-10-21).** Method: librarian agents (chromium +
puppeteer + playwright source reads, official docs) + explore agent (local
code map); findings in `findings-*.md`. No product code changes.

## Research questions

### RQ-A — New browser-hosted debugging (the `chrome://inspect` toggle) — ✅ ANSWERED

- A1: ✅ Same DevTools HTTP server, approval mode (`kWithApprovalOnly`): serves
  ONLY `ws://…/devtools/browser[/<uuid>]`; `/json/*` hard-404 by explicit
  early return; `/mcp` does not exist in Chrome at all.
- A2: ✅ `--autoConnect` = read `DevToolsActivePort` from the data dir → raw WS
  connect; no HTTP probe. **The port file is still written in approval mode.**
- A3: ✅ Modal dialog per WS connection; no persistence (open request #825);
  no window → auto-deny; no policy auto-approve.
- A4: ✅ Usable with constraints → `ApprovalModeDiscovery` design in findings.

### RQ-B — Chromium 136+ default-profile CDP restriction — ✅ ANSWERED

- B1: ✅ Since Chrome 136, branding-gated check → server never constructed →
  **port NOT bound (ECONNREFUSED)**. Correction: bound-but-404 = toggle mode,
  a different signature.
- B2: ✅ Sanctioned: non-default `--user-data-dir`, Chrome for Testing, the
  toggle itself. `DevToolsRemoteDebuggingAllowed` only kills all debugging.
  `--disable-features=DevToolsDebuggingRestrictions` is FAKE (verified).
- B3: ✅ Signature table delivered (refused / bound-404 / 403 paths).

### RQ-C — Transport seam in our codebase (local) — ✅ ANSWERED

- C1: ✅ Full connect-flow map with file:line refs; S2 exception swallowing
  identified as the exact spot destroying classifier evidence.
- C2: ✅ Two insertion surfaces (socket-level `CDPClient.connect`, endpoint-level
  HealthMonitor strategies); consumer-required surface listed; one leak
  (`rawSocket` for ping); singletons documented.
- C3: ✅ Feasible as opt-in (`CDP_PROCESS_SCAN`); candidate-dir list captured.

### RQ-D — Playwright engine internals — ✅ ANSWERED

- D1: ✅ Actionability matrix + injected ElementState + backoff ladder
  [20,50,100,100,500] + hit-target interceptor → raw-CDP approximation sketched.
- D2: ✅ Everything is thin `Input.dispatchMouseEvent`/`insertText` — our
  mouse-xy seed is trivial.
- D3: ✅ Frame selector chain (`enter-frame`) + deviceDescriptorsSource.json
  fields captured.
- D4: ✅ storageState schema + restore semantics captured.

### RQ-E — Playwright MCP tool inventory (2026) — ✅ ANSWERED

- E1: ✅ 93 tools, capability-gated (core* default); merged into the playwright
  monorepo. Full inventory highlights listed.
- E2: ✅ run_code (vm sandbox, RCE-equivalent), recording codegen, tracing,
  video suite with chapter/action callouts.
- E3: ✅ Four modes; `--extension` = MV3 relay into the real profile — matches
  our `extension/` v5.1 scaffold direction.
- E4: ✅ Steal-list: response-as-codegen, verify family, hygiene switches,
  snapshot depth/boxes.

## Deliverables

| File | Covers |
|---|---|
| `findings-routes-and-restrictions.md` | RQ-A + RQ-B |
| `findings-playwright-internals.md` | RQ-D + RQ-E |
| `findings-transport-seam.md` | RQ-C (local code map) |
| this file | status per RQ |

## Acceptance

Every RQ ends with either an answer + source, or an explicit
"undocumented / blocked" with the evidence that establishes that.
