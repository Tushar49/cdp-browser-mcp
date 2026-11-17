// 5.5.x live gate — interact type/fill/select inside a real OOPIF.
// ONE MCP process = ONE CDP connection = ONE Allow dialog.
// Rig: top at 127.0.0.1:8880, iframe at 127.0.0.2:8881 (different sites).
const sdk = 'file:///' + 'A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/'.replace(/ /g, '%20');
const { Client } = await import(sdk + 'index.js');
const { StdioClientTransport } = await import(sdk + 'stdio.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/dist/index.js'],
  env: { ...process.env, CDP_USER_DATA: 'A:\\Programs\\Browsers\\brave-portable\\data' },
});
const client = new Client({ name: 'live-oopif', version: '0.0.1' });
await client.connect(transport);
const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 140_000 });
const textOf = (res) => {
  const raw = (res && Array.isArray(res.content)) ? res.content.map((x) => (x && typeof x.text === 'string') ? x.text : '').join('\n') : String(res?.error?.message ?? res ?? '');
  return typeof raw === 'string' ? raw : String(raw);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const newTab = textOf(await call('tabs', { action: 'new', url: 'http://127.0.0.1:8880/oopif-top.html?gate=1' }));
const tabId = newTab.match(/\[([0-9A-F]{32})\]/)?.[1];
if (!tabId) { console.log(newTab); process.exit(1); }
console.log('gate tab:', tabId);
await call('tabs', { action: 'activate', tabId });

const evalTop = async (expression) => textOf(await call('execute', { action: 'eval', tabId, expression }));

// Wait for the child frame to load and post 'ready'.
let ready = false;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  const out = await evalTop(`JSON.stringify((window.__msgs||[]).filter(function(m){return m&&m.type==='ready';}))`);
  if (out.includes('ready')) { ready = true; break; }
}
check('child frame loaded and posted ready', ready);

// Non-vacuity: the TOP document has NO input, and exactly one iframe.
const pre = await evalTop(`JSON.stringify({inputs: document.querySelectorAll('input').length, iframes: document.querySelectorAll('iframe').length})`);
check('top document has no input (top-session fill cannot hit one)', pre.includes('"inputs":0'), pre.trim());
check('top document embeds exactly one iframe', pre.includes('"iframes":1'), pre.trim());

// OOPIF proof + uid: the snapshot must include a [frame N] section with a textbox ref.
const snapshot = textOf(await call('page', { action: 'snapshot', tabId }));
const frameMatch = /\[frame \d+\][^\n]*?textbox[^\n]*?\[ref=(\d+)\]/.exec(snapshot);
check('snapshot exposes the cross-origin iframe as a [frame N] section', snapshot.includes('[frame '));
check('snapshot yields a ref for the iframe textbox', !!frameMatch, frameMatch ? `ref=${frameMatch[1]}` : 'no frame textbox ref');
if (!frameMatch) {
  console.log('\n--- snapshot ---\n' + snapshot.slice(0, 2500));
  await call('tabs', { action: 'close', tabId });
  console.log('\nRESULT: GATE FAIL (precondition)');
  process.exit(1);
}
const uid = Number(frameMatch[1]);

// 1) Instant fill (the decisive path: old code read top-frame activeElement).
const instant = await call('interact', { tabId, action: 'type', uid, text: 'oopif-instant-123' });
console.log('instant:', textOf(instant).split('\n')[0]);
await sleep(350);
const inputMsgs = await evalTop(`JSON.stringify((window.__msgs||[]).filter(function(m){return m&&m.type==='input';}))`);
check('instant fill landed in the IFRAME input (input event from child)', inputMsgs.includes('oopif-instant-123'), inputMsgs.slice(0, 220));
const topInputs = await evalTop(`String(document.querySelectorAll('input').length)`);
check('top document still has no input after instant fill', topInputs.trim().endsWith('0'), topInputs.trim());

// 2) Per-keystroke typing (fixed delay) — key events must originate in the child session.
// Count events (never match the value: the secrets scrubber masks `key` fields).
await call('interact', { tabId, action: 'type', uid, text: 'delayXYZ', delay: 5 });
await sleep(350);
const keyCount = await evalTop(`String((window.__msgs||[]).filter(function(m){return m&&m.type==='key';}).length)`);
check('per-key dispatch reaches the iframe document (keydown events)', Number(keyCount.trim()) > 0, `key events: ${keyCount.trim()}`);
const lastInput = await evalTop(`(function(){var a=(window.__msgs||[]).filter(function(m){return m&&m.type==='input';});return a.length?a[a.length-1].value:'';})()`);
check('per-key typing produced the expected final value', lastInput.includes('delayXYZ'), lastInput.trim());

// 3) Submit Enter — same resolved session must trigger the iframe form.
const sub = await call('interact', { tabId, action: 'type', uid, text: 'sub', submit: true });
console.log('submit:', textOf(sub).split('\n')[0]);
await sleep(450);
const submitMsgs = await evalTop(`JSON.stringify((window.__msgs||[]).filter(function(m){return m&&m.type==='submit';}))`);
check('Enter submit fired inside the iframe form', submitMsgs.includes('"value":"sub"') || submitMsgs.includes('sub'), submitMsgs.slice(0, 220));

await call('tabs', { action: 'close', tabId });
console.log(`\nRESULT: ${failures === 0 ? 'GATE PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
