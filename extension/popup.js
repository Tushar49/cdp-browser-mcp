// CDP MCP Connector - popup script
// Persists user approval state via chrome.storage.local.

const STORAGE_KEY = 'cdp_mcp_approvals';

async function getApprovals() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || {};
}

async function setApproval(originOrId, approved) {
  const approvals = await getApprovals();
  approvals[originOrId] = {
    approved,
    timestamp: Date.now(),
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: approvals });
}

async function isApproved(originOrId) {
  const approvals = await getApprovals();
  return Boolean(approvals[originOrId]?.approved);
}

function renderApprovals(approvals) {
  if (Object.keys(approvals).length === 0) {
    return '<p class="muted">No approvals yet. When an MCP client connects, it will appear here.</p>';
  }
  return Object.entries(approvals).map(([id, info]) => `
    <div class="approval-row">
      <span class="approval-id">${id}</span>
      <span class="approval-state">${info.approved ? '✓' : '✗'}</span>
      <button data-revoke="${id}">Revoke</button>
    </div>
  `).join('');
}

document.addEventListener('DOMContentLoaded', async () => {
  const status = document.getElementById('status');
  if (status) {
    status.textContent = '⏳ Extension loaded — MCP bridge coming soon';
  }

  const listEl = document.getElementById('approvals-list');
  if (!listEl) return;

  const approvals = await getApprovals();
  listEl.innerHTML = renderApprovals(approvals);

  listEl.addEventListener('click', async (e) => {
    const id = e.target.getAttribute('data-revoke');
    if (id) {
      await setApproval(id, false);
      window.location.reload();
    }
  });
});
