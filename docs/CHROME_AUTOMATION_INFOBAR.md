# About the "Chrome is being controlled by automated test software" Infobar

When you connect this MCP server (or any CDP client) to Chrome, Chrome shows a yellow infobar at the top:

> Chrome is being controlled by automated test software.

Many users ask if this can be hidden. **TL;DR: not in stable Chrome.**

## What this infobar means

Chrome shows it whenever ANY app has an active CDP debugging connection. It's a security feature, not a bug. The intent is to let users notice when their browser is being automated (legitimate tool or not).

## What does NOT work

| Approach | Result |
|---|---|
| `--disable-infobars` flag | Removed in Chrome 73 (Apr 2019). No longer recognized. |
| `--disable-blink-features=AutomationControlled` | Hides `navigator.webdriver` only. Infobar still appears. |
| `excludeSwitches: ['enable-automation']` Selenium trick | Hides infobar in some old combinations but unreliable on Chrome 100+. |
| Hex-patching the Chrome binary | Possible but breaks Chrome auto-update and signing. Not recommended. |
| Chrome enterprise policies | None of them disable the infobar. |

## What DOES work

| Approach | Result |
|---|---|
| Switch to **Chromium for Testing** (`@playwright/test`, official testing builds) | Doesn't show the infobar by design. |
| Switch to **Microsoft Edge** | Has the same infobar. |
| Switch to **Brave** | Has the same infobar. |
| Ignore the infobar | Bar takes ~30px of vertical space. Site works normally. |
| Hide it via OS-level window cropping | Possible but bizarre. |

## Why we can't remove it

Chrome's `chrome://flags` and command-line flags are deliberately curated. The team chose to keep the infobar visible because end users have been tricked by malware-controlled Chrome instances in the past. We cannot ship a fix.

## Working around it

Most users adapt by:

1. **Maximize the browser** so the 30px loss is unnoticeable.
2. **Use a dedicated profile** (`--user-data-dir=...isolated`) so it's clearly the automation Chrome, not your daily browser.
3. **Trust the workflow** - once you've seen the infobar a few times, your brain stops noticing.

## Investigation log

See `_archive/research/ConnectionTokenInvestigation.md` for the full investigation that led to this doc. Short version: there is no token, no flag, no policy that removes this infobar. We tried.
