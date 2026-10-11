# Connection Token Investigation - 2026-05-13

## Question

User wants the chrome://debugging "Allow" allowance to persist across sessions
so agents don't re-prompt every time Chrome is restarted.

---

## TL;DR

**There is no token to persist.** Chrome does not issue or store any auth
token for raw CDP connections to `localhost:9222`. The "prompt" the user is
seeing is almost certainly Chrome's persistent **"Chrome is being controlled
by automated test software"** infobar, which is enforced by Chrome and cannot
be dismissed or persisted away from user code.

The most actionable fix is a **stable launcher script** so the same port +
user-data-dir is reused every session, plus documenting the infobar as
expected/unavoidable.

---

## Finding 1: Raw CDP on localhost has no auth

The MCP server connects via:

```
ws://127.0.0.1:9222/devtools/page/<targetId>
```

Reference: `MCP Server/src/connection/cdp-client.ts:104`

```ts
const socket = new WebSocket(wsUrl, { perMessageDeflate: false });
```

There is no Authorization header, no cookie, no token, no challenge/response.
Chrome accepts any local connection to the debug port. This is by design -
the assumption is that anything running on `127.0.0.1` is trusted.

Confirmed via Chrome DevTools Protocol docs
(<https://chromedevtools.github.io/devtools-protocol/tot/Browser/>): no method
in the `Browser.*` namespace deals with permission grants for the debug port
itself. `Browser.resetPermissions` is for site permissions (camera, location,
etc.), not for the CDP connection.

**Implication:** there is nothing to copy out of `User Data\Local State` or
`Preferences` because nothing is stored.

---

## Finding 2: Chrome's "is being controlled" infobar

When any process attaches via CDP (raw debug port OR `chrome.debugger`
extension API), Chrome shows a persistent yellow infobar:

> "Chrome is being controlled by automated test software"

This infobar:
- Is shown for the entire session a debugger is attached
- Is shown again every time you reattach
- **Cannot** be hidden by any user-supplied flag in stable Chrome builds
- `--disable-blink-features=AutomationControlled` removes the
  `navigator.webdriver` JS hint but does **not** remove the infobar
- `--disable-infobars` was removed from Chrome ~73 and is silently ignored
- The only way to remove it is a custom Chrome build that patches it out

This is a deliberate user-safety signal from the Chrome team. It is the most
likely "prompt" the user is referring to.

---

## Finding 3: SmartScreen / Defender warning on Chrome launch

If the user launches Chrome via a custom command line (e.g., a `.bat`
double-click), Windows SmartScreen may show a one-time "Run anyway" prompt
because the parent process is unusual. This persists per-binary - once the
user clicks "Run anyway" once, it should not reappear unless the Chrome
binary is updated.

**Action:** if the user is seeing a SmartScreen prompt, it is solved by
launching Chrome via a signed launcher (PowerShell with proper execution
policy, or a `.lnk` shortcut) instead of a raw `.bat`.

---

## Finding 4: Our extension has NO approval flow

`extension/manifest.json` (v0.1.0):

```json
{
  "manifest_version": 3,
  "name": "CDP Browser MCP Bridge",
  "version": "0.1.0",
  "permissions": ["debugger", "tabs", "activeTab"],
  "host_permissions": ["<all_urls>"]
}
```

`extension/background.js` is entirely stubs:

```js
// TODO: Phase B - implement WebSocket server for MCP connection
// TODO: Phase C - implement CDP command forwarding via chrome.debugger
// TODO: Phase D - auto-detection from MCP server side
```

`extension/popup.js`:

```js
status.textContent = '⏳ Extension loaded - MCP bridge coming soon';
```

There is **no approval flow at all** in the extension yet. So the prompt the
user is seeing cannot be from our extension. When Phase B is implemented,
**we should design the approval flow with `chrome.storage.local` persistence
from day one** (see Recommendation below).

Also relevant: when `chrome.debugger.attach()` is called by the extension on
a tab, Chrome shows its **own** yellow "is being debugged" infobar at the
top of that tab. That infobar is not dismissible. This is separate from any
extension UI we build.

---

## What the user is likely seeing (ranked by probability)

1. **Most likely:** Chrome's "is being controlled by automated test
   software" infobar appearing every session. **Cannot be persisted away.**
2. **Second:** They are launching Chrome with a fresh `--user-data-dir` each
   time (e.g., a new temp folder), so cookies, login state, and the
   "you've granted debugging access" UX state (if any extension stored it)
   are all wiped. **Fixable** with a stable launcher script.
3. **Third:** SmartScreen on Chrome launch. **One-time** after using a
   proper launcher.
4. **Unlikely:** A different extension (not ours) gating the connection.
   We have no such extension installed by default.

---

## Recommendation

### Action 1 (now): Document the infobar as expected

Add a one-paragraph note to `README.md` and the connection error message in
`cdp-client.ts` explaining that the "Chrome is being controlled by
automated test software" infobar is normal, expected, and cannot be hidden.
This sets the correct expectation and stops users from filing it as a bug.

### Action 2 (now): Ship a stable launcher script

Create `scripts/start-chrome.ps1` (Windows) and `scripts/start-chrome.sh`
(macOS/Linux) that:

- Always use the same `--remote-debugging-port=9222`
- Always use the same `--user-data-dir=<repo>/.chrome-profile` (or a
  user-supplied path persisted in `.env`)
- Skip launch if Chrome is already running on that port (probe `/json/version`)

This ensures the user's "I clicked Allow" state - whatever it is, even just
the SmartScreen approval - is preserved across sessions.

This is **deferred** to a follow-up task; it was not in scope for this
investigation.

### Action 3 (Phase B of extension): Design approval flow with persistence

When the extension's WebSocket bridge is implemented, the first time a
remote MCP server connects, prompt the user via the popup. Store the
approval as:

```js
await chrome.storage.local.set({
  approvedConnections: {
    [`${origin}:${port}`]: { approvedAt: Date.now() }
  }
});
```

On reconnect, check `chrome.storage.local.get('approvedConnections')`
before showing any prompt. `chrome.storage.local` survives extension
reload, browser restart, and Chrome updates. Only Chrome uninstall or
explicit `chrome.storage.local.clear()` wipes it.

### Action 4 (do NOT do): Fabricate a token storage mechanism

Do not invent a `.chrome-debug-token` file or anything similar. Chrome does
not issue a token. Anything we wrote would be cargo-cult and would not
actually be honored by Chrome.

---

## Closing the BACKLOG item

The BACKLOG item assumes a token exists. It does not. The closest
real-world fixes are:

- (immediate) accept the infobar; document it
- (small) ship a stable launcher; preserves whatever per-binary trust
  state Windows/Chrome already remember
- (later) when extension Phase B lands, persist approval in
  `chrome.storage.local`

This item is being closed as **investigated**; follow-up work to ship the
launcher script and update connection error messaging is captured as a new
BACKLOG entry below.
