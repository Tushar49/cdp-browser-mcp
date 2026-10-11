# CDP Browser MCP Bridge — Chrome Extension

Zero-config browser access for CDP Browser MCP Server.

## Status: Scaffold (v0.1.0)
This is the extension skeleton. The actual CDP bridge is planned for v5.1.0.

## How It Will Work
1. Install this extension in Chrome/Edge/Brave
2. The MCP Server auto-detects the extension
3. No chrome://flags or --remote-debugging-port needed

## Development
Active bridge work happens on the `dev` branch; the full design doc ships there.

## Phases
- [x] Phase A: Extension skeleton (manifest, service worker, popup)
- [ ] Phase B: WebSocket bridge (CDP command forwarding)
- [ ] Phase C: MCP Server integration (extension-client.ts)
- [ ] Phase D: Auto-detection fallback chain
- [ ] Phase E: Polish (settings, status UI)
