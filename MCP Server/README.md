# CDP Browser MCP Server

Connects AI agents to your **real running Chrome** — your cookies, logins, and
extensions stay intact. 14 tools / 90+ actions over the Chrome DevTools
Protocol: navigation, accessibility snapshots, element interaction, smart form
filling, network interception, device emulation, cookies/storage, and a full
JS debugger.

## Install

```bash
npm install -g cdp-mcp-server
```

Or reference it directly in any MCP client (no global install needed):

```json
{
  "mcpServers": {
    "cdp-browser": {
      "command": "npx",
      "args": ["-y", "cdp-mcp-server@latest"]
    }
  }
}
```

## One-time Chrome setup

Chrome must expose the DevTools protocol. Pick one:

1. Open `chrome://flags/#enable-remote-debugging`, set **Enabled**, relaunch
   (persists across restarts — recommended)
2. Or launch Chrome with the flag:
   `chrome.exe --remote-debugging-port=9222`

Verify it works: open `http://localhost:9222/json/version` — you should see
JSON output.

The server auto-connects to Chrome on your first tool call. Edge and Brave
work the same way (same protocol).

## Highlights

- Stable element refs that survive DOM changes
- Smart form filling (React/Greenhouse comboboxes, country codes, dates)
- Auto-waiting after every action (no "click and pray")
- Token-optimized accessibility snapshots (~15KB)
- Multi-agent safe: per-agent session isolation + exclusive tab locks
- Network mocking via request interception
- Playwright-compatible slim mode for small-context models

## Documentation

Full tool reference, environment variables, and guides:
https://github.com/Tushar49/cdp-browser-mcp#readme

## License

MIT
