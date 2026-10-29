# WS0-Spike directory — live-gate rigs & stdio MCP-client scripts

Dev-only. This directory is stripped from main at promote time.

## What the "rig" is and why it exists

The rig is a **fake website hosted locally while live-testing the MCP server's
tools**. Tools like `interact click`, `page verify`, WebAuthn ceremonies and
WebMCP invocation need a page whose content and behavior are fully controlled.
Driving real user tabs (logged-in accounts) for that is unacceptable — so a
tiny static server is started for the duration of a gate, then killed.

Some tests *don't* need it: pages without origin requirements can be built
in-tab with `page content set_content`. Two features force a real
`http://localhost` origin, which is why the server exists at all:

- **WebAuthn** — rejects opaque origins (`data:`, `about:`) as an rp.id.
- **WebMCP** — page-registered tools need a persistent document.

## Files

| File | What it contains |
|---|---|
| `serve.mjs` | The 14-line static server. `node serve.mjs` → `http://127.0.0.1:8877/rig.html`. `PORT` env var to rebind. |
| `rig.html` | Main test page: verify-battery elements (visible/hidden/disabled/text/input), a WS0 `ws0_echo` WebMCP tool, slow tool for timeout tests. |
| `webauthn-rig.html` | WebAuthn test page (**assert-only** — `credentials.create` is deliberately ABSENT; the user's Bitwarden with passkey interception must never be triggered, and no rig may ever provision credentials into their vault). |
| `live-verify-ws*.mjs`, `live-ws{4,5,6}*.mjs` | One-shot stdio MCP **client** scripts (spawn `dist/index.js`, drive tools, assert, report). Harness tool schemas go stale — fresh-dist client scripts are the canonical live-gate medium. |
| `invoke.mjs` | Reusable client helper (spawn server → tools/call → print). |
| `probe*.mjs` | Raw CDP capability probes (WS0 canary style: check a feature exists on the current browser build before planning a workstream around it). |

## Operating rules for other agents

1. **One consolidated connection per gate.** Every fresh CDP client pops an
   "Allow" dialog in the user's browser — never spawn client scripts
   serially-per-check; put the whole battery in ONE script/connection.
2. **Never** use a rig that calls `navigator.credentials.create` (assert-only
   rig only). The user's password manager intercepts WebAuthn — a runaway
   ceremony loop once polluted their vault.
3. Start the rig only while a gate is running; kill it after. It is dev
   scaffolding, not a product artifact — never reference it from main-shipping
   docs (reference duty).
4. A mirror of the rig also lives in the maintainer's approved temp dir
   (`A:\.devTools\cache\temp\opencode\ws0\`); the archived copy here is the
   canonical one to restore from.

## History

Created during the v5.3.0 cycle (October 2026) for WS0–WS6 live verification.
Kept as the pattern/template for future cycles' live gates (5.4 carcass:
perf-trace, heap-snapshot, CHIPS partitionKey, mock camera — run a `probe-*`
WS0 pass before planning around a capability).
