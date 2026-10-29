// WS7 Batch A canary — network emulation / override state / mock camera / CHIPS.
// ONE script = ONE CDP connection = one Allow dialog.
// EVERY method shape probed comes from the live build's answers, never assumed:
// documented-but-unimplemented is the inputVisualization failure shape and this
// script exists to catch it BEFORE WS8/WS9 code is written.
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const WebSocket = require('A:/Projects/Browser/mcp-servers/cdp-browser-mcp/MCP Server/node_modules/ws');

const RIG = 'http://localhost:8877';
const results = { probes: [], startedAt: new Date().toISOString() };
const note = (name, verdict, evidence) => {
  results.probes.push({ name, verdict, evidence });
  console.log(`[${verdict}] ${name}\n    ${evidence}`);
};

const [port, ...rest] = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/);
const browserPath = rest.join('').trim();

let id = 0;
const pending = new Map();
const eventLog = [];
function send(method, params = {}, sessionId) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(msgId, {
      resolve: (r) => resolve(r),
      reject: (e) => reject(new Error(method + ' → ' + JSON.stringify(e))),
    });
    ws.send(JSON.stringify({ id: msgId, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
// best-effort: method-existence probes swallow "unsupported method" errors
const trySend = async (method, params = {}, sessionId) => {
  try { return { ok: true, result: await send(method, params, sessionId) }; }
  catch (e) { return { ok: false, error: e.message }; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`, { maxPayload: 256 * 1024 * 1024, perMessageDeflate: false });
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.reject(msg.error) : p.resolve(msg.result);
  } else if (msg.method) eventLog.push(msg);
});
const evAll = (method) => eventLog.filter((m) => m.method === method);
const evAllSince = (method, idx) => eventLog.slice(idx).filter((m) => m.method === method);

async function timedFetch(evalContext, url, n = 2) {
  const exp = `(async () => { const out=[]; for (let i=0;i<${n};i++){ const t=performance.now(); await fetch('${url}', {mode:'no-cors', cache:'no-store'}); out.push(+(performance.now()-t).toFixed(0)); } return out; })()`;
  const r = await send('Runtime.evaluate', { expression: exp, awaitPromise: true, returnByValue: true }, evalContext);
  return r.result.value;
}

ws.on('open', async () => {
  try {
    // own battery tab: created here, closed at the end (battery-tab precedent)
    const bt = await send('Target.createTarget', { url: RIG + '/chips.html' });
    const tabId = bt.targetId;
    await sleep(500);
    const { sessionId: s } = await send('Target.attachToTarget', { targetId: tabId, flatten: true });
    await send('Page.enable', {}, s);
    await send('Runtime.enable', {}, s);
    await send('Network.enable', {}, s);
    await sleep(1200); // chips.html + its iframe boot

    // 1 ── ByRule availability + ruleIds echo ─────────────────────────────
    const noopRule = await trySend('Network.emulateNetworkConditionsByRule', {}, s);
    note('A1 emulateNetworkConditionsByRule (empty body)',
      noopRule.ok ? 'EXISTS (empty body accepted?)' : 'reject=' + JSON.stringify(noopRule.error),
      noopRule.ok ? JSON.stringify(noopRule.result) : JSON.stringify(noopRule.error));
    const withRule = await trySend('Network.emulateNetworkConditionsByRule', {
      matchedNetworkConditions: [{ urlPattern: '', latency: 0, downloadThroughput: -1, uploadThroughput: -1 }],
    }, s);
    note('A1b match-all no-op rule → ruleIds', withRule.ok ? 'OK' : 'reject',
      withRule.ok ? JSON.stringify(withRule.result) : JSON.stringify(withRule.error));

    // 2 ── throttle equivalence vs legacy + appliedNetworkConditionsId ────
    const base = await timedFetch(s, RIG + '/slow-rig.html', 2);
    const idx0 = eventLog.length;
    const throttle = await trySend('Network.emulateNetworkConditionsByRule', {
      matchedNetworkConditions: [{ urlPattern: '', latency: 1200, downloadThroughput: 80000, uploadThroughput: -1 }],
    }, s);
    const ruleId = throttle.ok ? throttle.result.ruleIds?.[0] : null;
    await sleep(300);
    const throttled = await timedFetch(s, RIG + '/slow-rig.html', 2);
    const extra = evAllSince('Network.requestWillBeSentExtraInfo', idx0)
      .filter((m) => 'appliedNetworkConditionsId' in m.params)
      .map((m) => ({ id: m.params.appliedNetworkConditionsId, t: m.params.timestamp }));
    note('A2 rule throttle 1200ms latency',
      throttled.some((t) => t > base[0] + 800) ? 'THROTTLE APPLIES' : 'NO THROTTLE OBSERVED',
      `baseline=${JSON.stringify(base)} throttled=${JSON.stringify(throttled)} ruleId=${ruleId} extraInfoEcho=${JSON.stringify(extra)}`);

    // 3 ── clear transaction: empty rules array ───────────────────────────
    const clearTry = await trySend('Network.emulateNetworkConditionsByRule', { matchedNetworkConditions: [] }, s);
    await sleep(300);
    const cleared = await timedFetch(s, RIG + '/slow-rig.html', 2);
    const clearedOk = clearTry.ok && cleared.some((t) => t < base[0] + 400);
    note('A3 clear via matchedNetworkConditions:[]',
      clearedOk ? 'CLEARS' : 'DID NOT CLEAR',
      `clear=${clearTry.ok} post=${JSON.stringify(cleared)} baseline=${JSON.stringify(base)}`);

    // 4 ── setBlockedURLs coexistence ──────────────────────────────────────
    const reThrottle = await trySend('Network.emulateNetworkConditionsByRule', {
      matchedNetworkConditions: [{ urlPattern: '', latency: 800, downloadThroughput: -1, uploadThroughput: -1 }],
    }, s);
    await send('Network.setBlockedURLs', { urls: ['*blocked-probe-asset*'] }, s);
    const idx1 = eventLog.length;
    // blocked request: watch its response state from the events, not the page fetch
    // (blocked fetches reject fast; the wire state is the binary evidence)
    send('Page.navigate', { url: RIG + '/slow-rig.html?blockedprobe=1' }, s).catch(() => {});
    await sleep(2500);
    const failedReqs = evAllSince('Network.loadingFailed', idx1).map((m) => ({
      url: (evAllSince('Network.requestWillBeSent', idx1).find((r) => r.params.requestId === m.params.requestId)?.params.request.url || '').slice(0, 70),
      blockedPh: m.params.blockedReasons || m.params.errorText,
    }));
    const stillRuled = evAllSince('Network.requestWillBeSentExtraInfo', idx1).filter((m) => 'appliedNetworkConditionsId' in m.params).length;
    note('A4 ByRule + setBlockedURLs coexistence',
      failedReqs.some((f) => /blocked/i.test(JSON.stringify(f.blockedPh))) && stillRuled > 0
        ? 'BOTH ACTIVE SIMULTANEOUSLY' : 'record for review',
      `failed=${JSON.stringify(failedReqs)} ruledEchoCount=${stillRuled} reThrottle=${JSON.stringify(reThrottle.ok ? reThrottle.result?.ruleIds : reThrottle)}`);
    await send('Network.setBlockedURLs', { urls: [] }, s);

    // 5 ── Fetch intercept coexistence (paused → continued still ruled?) ──
    await send('Fetch.enable', { patterns: [{ urlPattern: '*fetchprobe*' }] }, s);
    const idx2 = eventLog.length;
    // fire the fetch WITHOUT awaiting, then continue from the paused event —
    // ordering bug fixed: the page fetch stalls until continueRequest.
    const fetchPromise = send('Runtime.evaluate', {
      expression: `(async () => { const t = performance.now(); try { await fetch('${RIG}/slow-rig.html?fetchprobe=1', {cache:'no-store'}); return 'ok:' + (performance.now() - t).toFixed(0); } catch (e) { return 'err:' + e.message.slice(0, 60); } })()`,
      awaitPromise: true, returnByValue: true,
    }, s).then((r) => r.result?.value).catch((e) => 'evalErr:' + e.message.slice(0, 80));
    let pausedEv = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      pausedEv = evAllSince('Fetch.requestPaused', idx2).at(-1);
      if (pausedEv) break;
    }
    if (pausedEv) {
      await send('Fetch.continueRequest', { requestId: pausedEv.params.requestId }, s);
      const fetchOut = await fetchPromise;
      const echoed = evAllSince('Network.requestWillBeSentExtraInfo', idx2).filter((m) => 'appliedNetworkConditionsId' in m.params);
      note('A5 ByRule + Fetch intercept', echoed.length ? 'RULE APPLIES ACROSS INTERCEPT' : 'no extraInfo echo on intercepted request',
        `pausedUrl=${pausedEv.params.request.url.slice(0, 60)} fetch=${fetchOut} echo=${JSON.stringify(echoed.map((m) => m.params.appliedNetworkConditionsId))}`);
    } else {
      const fetchOut = await fetchPromise;
      note('A5 ByRule + Fetch intercept', 'requestPaused NEVER FIRED', `dangerous: intercept coexistence unproven; fetch=${fetchOut}`);
    }
    await send('Fetch.disable', {}, s);
    await trySend('Network.emulateNetworkConditionsByRule', { matchedNetworkConditions: [] }, s);
    await trySend('Network.emulateNetworkConditionsByRule', { matchedNetworkConditions: [] }, s);
    await send('Network.setBlockedURLs', { urls: [] }, s);

    // 6 ── overrideNetworkState ────────────────────────────────────────────
    const onEval = (exp) => send('Runtime.evaluate', { expression: exp, returnByValue: true }, s).then((r) => r.result.value);
    const onlineBefore = await onEval(`navigator.onLine + '|' + (navigator.connection?.effectiveType ?? 'none')`);
    const onState = await trySend('Network.overrideNetworkState', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, s);
    const onlineAfter = await onEval(`navigator.onLine + '|' + (navigator.connection?.effectiveType ?? 'none')`);
    note('A6 overrideNetworkState(navigator spoof)', onState.ok ? 'OK' : 'reject',
      `before=${onlineBefore} after=${onlineAfter} state=${onState.ok ? 'applied' : JSON.stringify(onState.error)}`);
    const resetState = await trySend('Network.overrideNetworkState', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, s);
    note('A6b overrideNetworkState reset-by-default-values', resetState.ok ? 'OK' : 'reject',
      `online reset=${await onEval('navigator.onLine')}`);

    // 7 ── mock camera (browser-level) ────────────────────────────────────
    const cam = await trySend('Browser.addMockCamera', { deviceId: 'ws7-batchA-mock' });
    note('A7 Browser.addMockCamera', cam.ok ? 'ADDED' : 'reject', cam.ok ? JSON.stringify(cam.result) : JSON.stringify(cam.error));
    for (const m of ['Browser.removeMockCamera', 'Browser.clearMockCameras', 'Browser.removeAllMockCameras']) {
      const r = await trySend(m, { deviceId: 'zz-never-existed' });
      if (r.ok) note('A7b camera removal method found', 'EXISTS: ' + m, JSON.stringify(r.result));
      else if (!/Method not found|\-32601/i.test(r.error)) note('A7b camera removal method found', 'EXISTS (rejected on bad id): ' + m, String(r.error).slice(0, 200));
    }
    if (!results.probes.some((p) => p.name === 'A7b camera removal method found' && p.verdict.startsWith('EXISTS')))
      note('A7b camera removal methods', 'NONE FOUND — removal = session disconnect only', 'probed 3 plausible names; job says die with session');
    // devices enumeration WITHOUT prompting: only query, no getUserMedia
    const devices = await onEval(`(async()=>{ try { const d = await navigator.mediaDevices.enumerateDevices(); return d.map(x=>x.kind+':'+x.deviceId.slice(0,6)+':'+ (x.label||'(no-label)')).join(' ; ') } catch(e){ return 'ERR '+e.message } })()`);
    note('A7c enumerateDevices (labels)', String(devices).includes('videoinput') ? 'camera entries listed' : 'no videoinput | raw=' + JSON.stringify(devices).slice(0, 120), String(devices).slice(0, 260));
    const camPerm = await onEval(`(async()=>{ try { const p = await navigator.permissions.query({name:'camera'}); return p.state } catch(e){ return 'ERR '+e.message } })()`);
    note('A7d camera permission state on localhost', 'observed (getUserMedia NOT triggered)', String(camPerm));

    // 8 ── CHIPS ground truth: what the iframe did ────────────────────────
    const chipsTop = await onEval(`window.__CHIPS_TOP || 'MISSING'`);
    note('A8 chips.html iframe report', chipsTop.startsWith('iframe reports') ? 'REPORTED' : 'MISSING',
      String(chipsTop).replace(/\s+/g, ' ').slice(0, 400));
    const allCookies = await trySend('Storage.getCookies', {});
    const probeCookies = allCookies.ok
      ? allCookies.result.cookies.filter((c) => /chips/.test(c.name)).map((c) => ({ name: c.name, domain: c.domain, partitionKey: c.partitionKey ?? null }))
      : 'error: ' + allCookies.error;
    note('A8b Storage.getCookies (partitionKey field present)', Array.isArray(probeCookies) && probeCookies.length ? 'COOKIE SEEN' : 'none/Error',
      JSON.stringify(probeCookies).slice(0, 500));
    const netCookies = await trySend('Network.getCookies', { urls: ['http://127.0.0.1/', 'http://localhost/'] }, s);
    note('A8c Network.getCookies urls-filter version', netCookies.ok ? 'OK (else Storage path wins)' : 'reject',
      JSON.stringify((netCookies.ok ? netCookies.result.cookies : netCookies.error).slice ? (netCookies.ok ? netCookies.result.cookies.filter((c) => /chips/.test(c.name)) : String(netCookies.error).slice(0, 200)) : null).slice(0, 400));

    // CDP-side: set кольцо partitioned cookie with protocol-level partitionKey
    const setPk = await trySend('Network.setCookie', {
      name: 'chips_cdpset', value: 'ws7', url: RIG + '/chips.html',
      partitionKey: { topLevelSite: 'http://localhost', hasCrossSiteAncestor: false },
    }, s);
    note('A8d Network.setCookie with protocol partitionKey', setPk.ok && setPk.result.success ? 'ACCEPTED' : 'rejected',
      setPk.ok ? JSON.stringify(setPk.result) : JSON.stringify(setPk.error).slice(0, 300));
    const mismatch = await trySend('Network.setCookie', {
      name: 'chips_cdpset_mismatch', value: 'ws7', url: RIG + '/chips.html',
      partitionKey: { topLevelSite: 'http://127.0.0.1', hasCrossSiteAncestor: true },
    }, s);
    note('A8e partitionKey mismatch top-site accept/reject', mismatch.ok ? 'RECORDED (accept/reject=' + JSON.stringify(mismatch.result) + ')' : 'error recorded',
      mismatch.error ? String(mismatch.error).slice(0, 240) : '(accepted — check effort)');
    const delPk = await trySend('Network.deleteCookies', {
      name: 'chips_cdpset_mk', url: RIG + '/chips.html',
    }, s);
    note('A8f Network.deleteCookies basic shape', delPk.ok ? 'OK' : 'reject', delPk.ok ? 'clean' : JSON.stringify(delPk.error).slice(0, 240));

    // 9 ── rule survival across cross-process navigation (bonus) ──────────
    const keep = await trySend('Network.emulateNetworkConditionsByRule', {
      matchedNetworkConditions: [{ urlPattern: '', latency: 1000, downloadThroughput: -1, uploadThroughput: -1 }],
    }, s);
    const nav = await send('Page.navigate', { url: RIG + '/rig.html' }, s).catch((e) => ({ err: e.message }));
    await sleep(1500);
    const kept = await timedFetch(s, RIG + '/slow-rig.html?navkeep=1', 1).catch(() => null);
    note('A9 rule survival across navigation', kept && kept[0] > 800 ? 'SURVIVES' : 'RESET/lost',
      `nav=${nav.err ? nav.err.slice(0, 60) : 'ok'} timing=${JSON.stringify(kept)}`);
    await trySend('Network.emulateNetworkConditionsByRule', { matchedNetworkConditions: [] }, s);

    // teardown: our own tab
    await send('Target.closeTarget', { targetId: tabId }).catch(() => {});
    console.log('\nbattery tab closed (ours). Browser state left untouched otherwise.');
  } catch (e) {
    console.log('FATAL:', e.message);
  }
  fs.writeFileSync(new URL('./batch-a-results.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), JSON.stringify(results, null, 2));
  process.exit(0);
});
ws.on('error', (e) => { console.log('WS ERROR:', e.message); process.exit(1); });
