// CDP Browser MCP Bridge — Chrome Extension Service Worker
// This extension provides zero-config CDP access without --remote-debugging-port

const DEFAULT_PORT = 9333;
let wsServer = null;
let connections = new Map(); // tabId → chrome.debugger session

console.log('[CDP MCP Bridge] Service worker started');

// TODO: Phase B — implement WebSocket server for MCP connection
// TODO: Phase C — implement CDP command forwarding via chrome.debugger
// TODO: Phase D — auto-detection from MCP server side

// For now, just a skeleton that logs tab activity
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    console.log(`[CDP MCP Bridge] Tab ${tabId} loaded: ${tab.url}`);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  connections.delete(tabId);
  console.log(`[CDP MCP Bridge] Tab ${tabId} closed`);
});

// Approval persistence (chrome.storage.local).
// Schema: { cdp_mcp_approvals: { [originOrId]: { approved: bool, timestamp: number } } }
// Listen for approval queries from content scripts or the MCP bridge.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'check_approval') {
    chrome.storage.local.get('cdp_mcp_approvals').then((data) => {
      const approvals = data.cdp_mcp_approvals || {};
      sendResponse({ approved: Boolean(approvals[msg.originOrId]?.approved) });
    });
    return true;
  }
  if (msg && msg.type === 'set_approval') {
    chrome.storage.local.get('cdp_mcp_approvals').then((data) => {
      const approvals = data.cdp_mcp_approvals || {};
      approvals[msg.originOrId] = { approved: msg.approved, timestamp: Date.now() };
      return chrome.storage.local.set({ cdp_mcp_approvals: approvals });
    }).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }
});
