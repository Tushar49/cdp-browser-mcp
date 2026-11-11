// WSA live gate — ONE MCP connection (one CDP connection → one Allow dialog).
// Rig: wsa-rig.html (shadow-DOM widget, ambiguous buttons, late re-render).
// Asserts EVERY engine family end-to-end through the shipped tools, plus the
// strict-mode error shape and retry through a re-render.
const sdk = 'file:///' + 'A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/'.replace(/ /g, '%20');
const { Client } = await import(sdk + 'index.js');
const { StdioClientTransport } = await import(sdk + 'stdio.js');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/dist/index.js'],
  // This Brave is the PORTABLE build — its User Data dir is not in the
  // default candidate list, and the process scan is unreliable here, so
  // point discovery at the DevToolsActivePort file explicitly.
  env: { ...process.env, CDP_USER_DATA: 'A:\\Programs\\Browsers\\brave-portable\\data' },
});
const client = new Client({ name: 'live-wsa', version: '0.0.1' });
await client.connect(transport);
const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 140_000 });
const textOf = (res) => {
  const raw = (res && Array.isArray(res.content)) ? res.content.map((x) => (x && typeof x.text === 'string') ? x.text : '').join('\n') : String(res?.error?.message ?? res ?? '');
  return typeof raw === 'string' ? raw : String(raw);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (label, ok, detail = '', full = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) { failures++; if (full && full !== detail) console.log('   ↳ ' + full.replace(/\n/g, '\n   ↳ ')); }
};

const hits = async (tabId) => textOf(await call('execute', { tabId, action: 'eval', expression: 'window.__HITS.join(",")' })).trim();
const val = async (tabId, expr) => textOf(await call('execute', { tabId, action: 'eval', expression: expr })).trim();

const newTab = textOf(await call('tabs', { action: 'new', url: 'http://127.0.0.1:8877/wsa-rig.html?wsagate=1' }));
const tabId = newTab.match(/\[([0-9A-F]{32})\]/)?.[1];
console.log('gate tab:', tabId);
if (!tabId) { console.log(newTab); process.exit(1); }
// `tabs new` defaults to a BACKGROUND tab (activate:false) — input delivery
// and timers are throttled there, which breaks CDP clicks + late re-renders.
console.log('activate:', textOf(await call('tabs', { action: 'activate', tabId })).split('\n')[0]);
await sleep(300);

// Wait until the rig is actually parsed + its handlers exist (first-load warmup).
for (let i = 0; i < 40; i++) {
  const ready = await val(tabId, "document.readyState + ':' + (typeof window.hit) + ':' + !!document.getElementById('css-target')");
  if (ready === 'complete:function:true') break;
  await sleep(250);
}
console.log('rig ready:', await val(tabId, "document.readyState + ':' + (typeof window.hit) + ':' + !!document.getElementById('css-target')"));
await sleep(150);

const clickEngine = async (label, selector, expectedHit) => {
  const out = textOf(await call('interact', { tabId, action: 'click', selector }));
  let h = '';
  for (let i = 0; i < 12; i++) {
    h = await hits(tabId);
    if (h.split(',').includes(expectedHit)) break;
    await sleep(120);
  }
  check(`${label} click`, out.includes('Clicked') && h.split(',').includes(expectedHit), `${out.split('\n')[0]} | hits=${h}`, out);
};

// ── 1. every click engine ────────────────────────────────────────────
await clickEngine('css=', 'css=#css-target', 'css');
await clickEngine('xpath=', "xpath=//button[@id='xpath-target']", 'xpath');
await clickEngine('bare // xpath', "//button[@id='xpath-target']", 'xpath');
await clickEngine('text=', 'text=UniqueTextTarget', 'text');
await clickEngine('role=', 'role=tab', 'role');
await clickEngine('testid=', 'testid=submit-btn', 'testid');
await clickEngine('alt=', 'alt=Company Logo', 'alt');
await clickEngine('title=', 'title=Tooltip Button', 'title');
await clickEngine('shadow-pierce text=', 'text=ShadowButton', 'shadow');

// ── 2. fill engines (label=, placeholder=, shadow) ───────────────────
const fillOut = textOf(await call('interact', { tabId, action: 'fill', fields: [{ selector: 'label=Email Address', value: 'gate@example.com' }] }));
check('label= fill', fillOut.toLowerCase().includes('filled') || fillOut.includes('gate@example.com'), fillOut.split('\n')[0], fillOut);
check('label= value landed', (await val(tabId, "document.getElementById('label-target').value")) === 'gate@example.com', await val(tabId, "document.getElementById('label-target').value"));

const fillOut2 = textOf(await call('interact', { tabId, action: 'fill', fields: [{ selector: 'placeholder=Search Products', value: 'widgets' }] }));
check('placeholder= fill', fillOut2.toLowerCase().includes('filled') || fillOut2.includes('widgets'), fillOut2.split('\n')[0], fillOut2);
check('placeholder= value landed', (await val(tabId, "document.getElementById('placeholder-target').value")) === 'widgets', await val(tabId, "document.getElementById('placeholder-target').value"));

const fillOut3 = textOf(await call('interact', { tabId, action: 'fill', fields: [{ selector: 'placeholder=Shadow Search', value: 'shadow-val' }] }));
check('shadow placeholder= fill', fillOut3.toLowerCase().includes('filled') || fillOut3.includes('shadow-val'), fillOut3.split('\n')[0], fillOut3);
check(
  'shadow value landed',
  (await val(tabId, "document.getElementById('shadow-host').shadowRoot.getElementById('shadow-input').value")) === 'shadow-val',
  await val(tabId, "document.getElementById('shadow-host').shadowRoot.getElementById('shadow-input').value"),
);

// ── 3. strict mode: ambiguity fails fast + actionable ────────────────
const t0 = Date.now();
const ambiguous = textOf(await call('interact', { tabId, action: 'click', selector: 'text=Ambiguous', timeout: 8000 }));
const ambiguousMs = Date.now() - t0;
check('strict ambiguity error shape', /matched 2 elements \(strict mode\)/.test(ambiguous) && ambiguous.includes('>> nth=N'), ambiguous.split('\n')[0], ambiguous);
check('strict ambiguity fails fast (non-retriable, < 3s)', ambiguousMs < 3000, `${ambiguousMs}ms`);

// ── 4. disambiguation suffix ─────────────────────────────────────────
const nthOut = textOf(await call('interact', { tabId, action: 'click', selector: 'text=Ambiguous >> nth=1' }));
const h4 = await hits(tabId);
check('>> nth=1 picks the second match', nthOut.includes('Clicked') && h4.includes('dup1') && !h4.includes('dup0'), `${nthOut.split('\n')[0]} | hits=${h4}`, nthOut);

// ── 5. retry through a re-render (element appears after navigation) ──
const lateOut = textOf(await call('interact', { tabId, action: 'click', selector: 'text=LateButton', timeout: 8000 }));
await sleep(300);
const h5 = await hits(tabId);
check('retry survives a re-render (late element)', lateOut.includes('Clicked') && h5.includes('late'), `${lateOut.split('\n')[0]} | hits=${h5}`, lateOut);

// ── 6. wait tool rides the engines ───────────────────────────────────
const waitOut = textOf(await call('page', { tabId, action: 'wait', selector: 'text=LateButton', state: 'visible', timeout: 5000 }));
check('page.wait text= locator', !/Timed out/.test(waitOut), waitOut.split('\n')[0], waitOut);
const waitGone = textOf(await call('page', { tabId, action: 'wait', selector: 'text=NoSuchTextEver', state: 'detached', timeout: 2000 }));
check('page.wait detached text= locator', !/Timed out/.test(waitGone), waitGone.split('\n')[0], waitGone);

// ── 7. read probes ride the engines ──────────────────────────────────
const verifyOut = textOf(await call('page', { tabId, action: 'verify', selector: 'text=ShadowButton', check: 'visible' }));
check('page.verify text= locator', !/FAIL|not found/i.test(verifyOut), verifyOut.split('\n')[0], verifyOut);

// ── 8. execute selector path rides the engines ───────────────────────
const execOut = textOf(await call('execute', { tabId, action: 'call', selector: 'testid=submit-btn', function: 'function() { return this.id; }' }));
check('execute selector= locator', execOut.includes('testid-target'), execOut.split('\n')[0], execOut);

await call('tabs', { action: 'close', tabId });
console.log(`\nRESULT: ${failures === 0 ? 'GATE PASS' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);
