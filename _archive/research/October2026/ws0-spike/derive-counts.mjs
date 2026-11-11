// Dev-only count derivation (WSE). Imports the BUILT registry and every
// registrar with a stub ctx (handlers never run), then prints action-enum
// lengths per tool so the README badge + table can be re-derived, not assumed.
const base = 'file:///A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP%20Server/dist/tools/';
const { ToolRegistry } = await import(base + 'registry.js');
const mods = ['tabs', 'page', 'interact', 'form', 'execute', 'observe', 'emulate', 'storage', 'webauthn', 'intercept', 'cleanup', 'browser', 'debug'];
const registry = new ToolRegistry();
const ctx = {};
for (const m of mods) {
  const mod = await import(base + m + '.js');
  const fn = Object.keys(mod).find((k) => k.startsWith('register') && k.endsWith('Tools'));
  if (!fn) { console.log('NO REGISTRAR in', m); continue; }
  mod[fn](registry, ctx);
}
const tools = registry.list();
let enumTotal = 0;
let singleHandler = 0;
const rows = [];
for (const t of tools) {
  const props = t.inputSchema?.properties ?? {};
  const action = props.action;
  const n = Array.isArray(action?.enum) ? action.enum.length : 0;
  if (n > 0) enumTotal += n; else singleHandler++;
  rows.push({ tool: t.name, actions: n || '—', params: Object.keys(props).length });
}
rows.sort((a, b) => (a.tool > b.tool ? 1 : -1));
for (const r of rows) console.log(`${r.tool.padEnd(12)} actions=${String(r.actions).padStart(3)}  params=${r.params}`);
console.log(`\ntools=${tools.length} | enum actions=${enumTotal} | single-handler=${singleHandler}`);
console.log(`candidate "sub-actions" badge: enum actions + single-handler tools = ${enumTotal + singleHandler}`);
console.log('note: ping/status are registered in index.ts and not counted here.');
