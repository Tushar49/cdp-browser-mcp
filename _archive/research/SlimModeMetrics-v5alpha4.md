# Slim Mode Metrics — v5.0.0-alpha.4 baseline

Measurements taken before the alpha.4 reductions, against `5.0.0-alpha.3` code.
All numbers are character counts unless stated otherwise.

## 1. Tool surface

| Metric                                  | Slim ON  | Slim OFF (full) |
|-----------------------------------------|----------|-----------------|
| Tools listed by MCP `ListTools`         | 8        | 14              |
| Tools registered in registry            | 12       | 14              |
| Total list-output JSON (name+desc+sch.) | 2,226    | 40,534          |

Slim is already ~94 % smaller than full. The remaining 2,226 chars in slim
break down as: 6 × tool name (~110), 6 × description (344), 6 × inputSchema
(1,538), JSON envelope (~234).

### Per-tool sizes (full mode)

| Tool      | desc | schema | total |
|-----------|------|--------|-------|
| tabs      | 1290 | 1377   | 2667  |
| page      | 2897 | 4187   | 7084  |
| interact  | 1136 | 4081   | 5217  |
| execute   |  872 | 1111   | 1983  |
| observe   | 1354 | 1321   | 2675  |
| emulate   | 1564 | 2396   | 3960  |
| storage   |  805 | 1590   | 2395  |
| intercept | 1326 | 1664   | 2990  |
| cleanup   | 1126 |  936   | 2062  |
| browser   | 1088 |  311   | 1399  |
| debug     | 2979 | 2364   | 5343  |
| form      |  747 | 1191   | 1938  |
| **TOTAL** |17184 |22529   |39713  |

### Per-tool sizes (slim mode)

| Tool               | desc | schema |
|--------------------|------|--------|
| browser_navigate   |  42  | 199    |
| browser_snapshot   |  86  | 335    |
| browser_click      |  38  | 143    |
| browser_type       |  49  | 293    |
| browser_fill_form  |  82  | 296    |
| browser_tabs       |  47  | 265    |
| **TOTAL**          | 344  |1538    |

## 2. Snapshot output overhead (default settings)

For a representative complex form (`__tests__/fixtures/test-pages/complex-form.html`,
which mimics a Greenhouse/LinkedIn Easy Apply page with ~30 interactive nodes):

- **Header:** `Page: <title>\nURL: <full url>\nElements: <n>\n\n` — typically 80–250 chars
- **Default `maxLength` when not specified:** 20,000 (same in slim and full)
- **Frame breadcrumb (multi-frame pages):** `[frame N] ` (10 chars) prefix on every
  frame node — for a page with 30 iframe nodes that is 300 chars of pure prefix
- **Truncation footer:** `\n\n... (truncated NNN chars. Use search parameter to
  find specific elements)` — about 70 chars

A typical optimised snapshot of complex-form.html serialises to roughly
4,500–6,000 characters before any cap is applied (single frame, after
`TokenOptimizer.optimize`). When wrapped in an iframe, the same content
balloons by ~10 %.

## 3. Response message overhead per interact call

| Action  | Current message                                                     | Bytes |
|---------|---------------------------------------------------------------------|-------|
| click   | `Clicked <div> "Submit Application" at (320, 482)`                  |  47   |
| click+net | `... \nNetwork: 3 request(s) completed`                           | +37   |
| hover   | `Hovering over <button> "Apply" at (X, Y)`                          |  ~45  |
| type    | `Typed "Tushar Agarwal" + Enter`                                    |  ~30  |
| select  | `Selected option successfully`                                      |  28   |
| press   | `Pressed Ctrl+Shift+K`                                              |  ~22  |
| drag    | `Dragged <div> "Source" → <div> "Target"`                           |  ~45  |
| scroll  | `Scrolled to (0, 1200)` / `Scrolled down by 500px`                  |  ~25  |
| upload  | `Uploaded 1 file(s) via file chooser: resume.pdf`                   |  ~50  |
| focus   | `Focused <input> "Email"`                                           |  ~25  |
| check   | `Checkbox: checked`                                                 |  18   |
| tap     | `Tapped <a> "Login" at (X, Y)`                                      |  ~32  |

Averaging ~35 bytes per interaction × ~10 interactions per session ≈ 350 bytes
of decoration that small models do not need to make decisions on.

## 4. Reduction opportunities (ranked by impact)

| # | Opportunity                                      | Estimated savings | Cost |
|---|--------------------------------------------------|-------------------|------|
| 1 | Default `maxLength = 4000` in slim (was 20,000)  | up to 16,000 chars per snapshot for noisy pages; -50–60 % typical | none |
| 2 | Strip per-property descriptions from slim schemas; tighter slim tool descriptions | -700 to -900 chars on every `ListTools` (-40 % of schema, -25 % of desc) | minor — properties remain self-documenting via name |
| 3 | Compact snapshot header + 1-char frame breadcrumb (`[f1] `) in slim | -100 to -300 chars per snapshot | none |
| 4 | Slim response messages (action-only) for click / hover / type / scroll / focus / check / tap / press / drag / upload / select | -25 to -60 chars per call → ~350 chars per typical session | none |
| 5 | Shorter cap-truncation footer in slim                                                  | -40 chars per truncated snapshot | none |

Wins 1, 3 and 4 are the top three (largest absolute savings, zero behaviour
loss, easy to gate on `CDP_SLIM_MODE`). Win 2 is implemented as a bonus
because it is a one-line change.

## 5. Implementation notes for v5.0.0-alpha.4

- All reductions are gated on `process.env.CDP_SLIM_MODE === 'true'` via a
  new `isSlimMode()` helper exported from `src/tools/slim-mode.ts`.
- A `slimify(verbose, slim)` helper picks the right string at call sites
  in `src/tools/interact.ts`.
- `src/tools/page.ts` switches header, frame prefix, and default
  `maxLength` based on the same flag.
- `src/snapshot/token-optimizer.ts.capLength` accepts an optional
  `slim: true` to emit the shorter footer.
- A regression test in `src/__tests__/unit/slim-output-budget.test.ts`
  enforces the budgets so future changes cannot quietly regress.

### Budget targets (regression test)

- Slim schema total **< 1500 chars** (current: 1538 → target: ~700)
- Synthetic complex-form snapshot output **< 6000 chars** when slim ON
- Slim click response message **< 80 chars** (currently up to ~85 with network suffix)
