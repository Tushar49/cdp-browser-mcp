# Release plan — v5.5.1 (interact type wrong-session dispatch — OOPIF)

Status: PLAY-CLEAR after metis pre-planning + oracle source check + momus review
(3 findings folded: call-sequence classification, runnable selector stubs,
correct version-check paths). Branch: dev. Parent: v5.5.0 (released).

## Objective

Typing into an element inside an iframe (including an out-of-process iframe,
OOPIF) must dispatch to the session that owns the element. Today the element is
resolved and focused in `resolvedSession`, but key events and the instant fill
target the top-level page session (`sess`). Ship the fix as 5.5.1.

## Root cause (verified)

`MCP Server/src/tools/interact.ts`:
- `handleType` (~354-459): focus/clear use `resolvedSession`; typo (~389-392),
  Backspace (~396-403), char (~407-410), fixed-delay (~423-426) and submit Enter
  (~452-457) use `sess`; instant fill (~431-447) reads `document.activeElement`
  on `sess` (top document → the `<iframe>` element, or nothing).
- `resolveElementObjectId` (~1237-1261): uid → `getRefSession(sess, uid) ?? sess`
  (OOPIF child when applicable); selector → always `sess`.
- Adjacent same-class defect: `handleSelect` custom-dropdown fallback
  `Runtime.evaluate` (~581-597) queries the top `document` on `sess`.

## Decisions

- **Oracle (Chromium source):** `RenderFrameDevToolsAgentHost::AttachSession`
  registers `InputHandler` unconditionally, and `InputHandler::DispatchKeyEvent`
  focuses the child widget. OOPIF `type:"iframe"` targets therefore accept
  `Input.dispatchKeyEvent`. Route ALL element-scoped commands (DOM, Runtime,
  Input) through `resolvedSession`; keep element-less `handlePress` on `sess`.
- **Instant fill:** bind to the resolved `objectId` via `Runtime.callFunctionOn`
  on `resolvedSession` (mirror `handleFill`), preserving the native setter,
  contentEditable `execCommand('insertText')`, and `input`+`change` events.
  Never read top-frame `document.activeElement`.
- **Metis caution resolved:** the review's blanket "all dispatch must use
  resolvedSession" was unverified; oracle's source check confirms it for Input.

## Scope

MUST:
1. `handleType`: every key-dispatch path → `resolvedSession` (3 loops + submit).
2. `handleType`: instant fill → `Runtime.callFunctionOn(objectId, arguments,
   resolvedSession)`; no `Runtime.evaluate` activeElement.
3. `handleSelect`: custom-dropdown `Runtime.evaluate` → `resolvedSession`.
4. Code comment documenting session binding (child InputHandler).
5. New `src/__tests__/unit/interact-oopif-session.test.ts` (mock CDP).
6. Version 5.5.0→5.5.1 (`src/version.ts`, `MCP Server/package.json`);
   CHANGELOG `[5.5.1] - 2026-11-17` → `### Fixed`.
7. This plan file (dev-only).

OUT (separate issues; maintenance mode): observe perf_stop/heap_dump
delete-before-finalize; handleClick `DOM.describeNode` try/catch; CI
`continue-on-error`; helper refactor; Input fallback probe; live browser gate
(no cdp tooling; approval is per WebSocket connection).

## Test matrix (mock `ctx.sendCommand`; `config.autoWait=false`)

Fixture: `getSession→'page-sess'`; `getRefSession(_,42)→'child-sess'` (optional
off); `elementResolvers` resolve 42→501, 43→502; `DOM.resolveNode`→objectId by
backend (501→obj-1, 502→obj-2); geometry callFunctionOn (`getBoundingClientRect`)
→ geometry; other callFunctionOn → `{ok:true}` / select probe shapes; locator
stubs: `Runtime.evaluate`→`{result:{objectId:'arr-1'}}`,
`Runtime.getProperties`→one match (`obj-sel`), `DOM.describeNode`→777.

Classify calls by `functionDeclaration`, never raw counts:
fill = includes `dispatchEvent` AND not `.focus()` AND not `getBoundingClientRect`.

1. `type uid=42 clear:false` → exactly one fill `callFunctionOn` on child-sess
   with objectId `obj-1`; zero activeElement `Runtime.evaluate`; zero Input.
2. default clear → one focus call (`.focus()`, includes
   `nativeSetter.call(this, '')`) on child-sess; one fill call on child-sess;
   zero activeElement evaluate.
3. `delay:1` → all `Input.dispatchKeyEvent` share the focus call's session
   (child-sess); zero activeElement evaluate.
4. `submit:true` → Enter keyDown+keyUp on child-sess (coherence with focus).
5. `charDelay:1 wordDelay:1 typoRate:1` → all Input events child-sess.
6. no-OOPIF (`getRefSession→undefined`) → every recorded call uses page-sess
   (no hardcoded child id).
7. selector path (stubs above) → fill callFunctionOn on page-sess with
   `obj-sel`; zero activeElement evaluate (locator evaluate is legitimate).
8. fill two fields (42 child / 43 page) → each fill uses its own session.
9. select uid=42 custom dropdown → probe callFunctionOn child-sess; follow-up
   evaluate child-sess.

## Acceptance gates (offline, binary)

- Pre-fix RED: new test file fails ≥3 assertions; capture the output.
- `cd "MCP Server"; pnpm typecheck` → 0; `pnpm test` → 0 (new file green);
  `pnpm build` → 0.
- `git diff --stat`: only `interact.ts`, the new test, `src/version.ts`,
  `MCP Server/package.json`, `CHANGELOG.md` (+ this plan). No dep/lockfile/
  schema/README-count changes.
- Version check (real paths, positive):
  `Select-String '"version"' "MCP Server/package.json"` → 5.5.1;
  `Select-String VERSION "MCP Server/src/version.ts"` → 5.5.1; no 5.5.0.

## Release

1. Commit `fix(interact): ...` on dev; **push dev first** (promote merges
   `origin/dev`).
2. `node scripts/promote.mjs 5.5.1` → Guard main + CI green.
3. Tag `v5.5.1` (never past red Guard) → Release workflow → npm 5.5.1 latest.
