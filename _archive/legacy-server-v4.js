#!/usr/bin/env node

/**
 * CDP Browser Automation — MCP Server  v4.13.0
 *
 * 11 tools with 87+ sub-actions for full browser automation.
 * Features: stable element refs (backendNodeId), auto-waiting, incremental snapshots,
 * per-agent session isolation with tab locking, framework-aware inputs, modal guards,
 * human-like interaction mode, Chrome instance/profile management, JavaScript debugger
 * with breakpoints/stepping/call-stack inspection, resource overrides, DOM/event breakpoints,
 * auto-console-error reporting, connection health monitoring, download tracking,
 * cross-origin (OOP) iframe support via Target.setAutoAttach.
 *
 * Tools:
 *   tabs      — Tab lifecycle (list, find, new, close, activate, info)
 *   page      — Navigation, snapshot, screenshot, content, set_content, add_style, wait, PDF, dialog, inject
 *   interact  — Click, hover, type, fill, select, press, drag, scroll, upload, focus, check, tap
 *   execute   — JS eval, script, call-on-element
 *   observe   — Console, network, request body, performance metrics, downloads
 *   emulate   — Viewport, color, UA, geo, CPU, timezone, locale, vision, network, SSL, etc.
 *   storage   — Cookies, localStorage, indexedDB, cache, quota
 *   intercept — HTTP request interception, mocking, blocking via Fetch domain
 *   cleanup   — Disconnect sessions, clean temp files, status, list_sessions, session, reset
 *   browser   — Browser instance discovery (Chrome, Edge, Brave), profile listing, connection switching
 *   debug     — JS debugger (breakpoints, stepping, call stack), resource overrides, DOM/event breakpoints
 *
 * Setup:  chrome://flags/#enable-remote-debugging → Enabled → Relaunch (or edge://flags for Edge)
 *
 * Env vars:
 *   CDP_PORT              Browser debugging port            (default: 9222)
 *   CDP_HOST              Browser debugging host            (default: 127.0.0.1)
 *   CDP_TIMEOUT           Command timeout in ms             (default: 60000)
 *   CDP_SESSION_TTL       Agent session TTL in ms           (default: 300000)
 *   CDP_USER_DATA         Chrome User Data directory path
 *   CDP_PROFILE           Auto-connect to Chrome instance by name or path
 *   CDP_DEBUGGER_TIMEOUT  Debugger auto-resume timeout ms   (default: 30000)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ─── Config ─────────────────────────────────────────────────────────

const CDP_HOST = process.env.CDP_HOST || "127.0.0.1";
const CDP_PORT = process.env.CDP_PORT || "9222";
const CDP_TIMEOUT = parseInt(process.env.CDP_TIMEOUT) || 60000;
const SESSION_TTL = parseInt(process.env.CDP_SESSION_TTL) || 300000;
const LONG_TIMEOUT = 120_000;
const MAX_INLINE_LEN = 60_000;
const CDP_DEBUGGER_TIMEOUT = parseInt(process.env.CDP_DEBUGGER_TIMEOUT) || 30000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = dirname(__dirname); // up from MCP Server/ to repo root
const TEMP_DIR = process.env.CDP_TEMP_DIR || join(REPO_ROOT, ".temp");

// ─── Temp File Management ───────────────────────────────────────────

function ensureTempDir() {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
}

function writeTempFile(name, content, encoding = "utf8", sessionPrefix = null) {
  ensureTempDir();
  autoCleanupTempFiles();
  const fileName = sessionPrefix ? `${sessionPrefix.substring(0, 8)}_${name}` : name;
  const p = join(TEMP_DIR, fileName);
  writeFileSync(p, content, encoding);
  return p;
}

function cleanupTempFiles() {
  if (!existsSync(TEMP_DIR)) return 0;
  const files = readdirSync(TEMP_DIR);
  let count = 0;
  for (const f of files) {
    try { unlinkSync(join(TEMP_DIR, f)); count++; } catch { /* ok */ }
  }
  return count;
}

const MAX_TEMP_FILES = 50;
const MAX_TEMP_AGE_MS = 30 * 60 * 1000; // 30 minutes

function autoCleanupTempFiles() {
  if (!existsSync(TEMP_DIR)) return;
  const files = readdirSync(TEMP_DIR);
  if (files.length <= MAX_TEMP_FILES) return;
  // Sort by creation time and remove oldest
  const withStats = files.map(f => {
    const p = join(TEMP_DIR, f);
    try { return { path: p, mtime: statSync(p).mtimeMs }; } catch { return null; }
  }).filter(Boolean);
  withStats.sort((a, b) => a.mtime - b.mtime);
  // Remove files until we're at half the limit, OR remove files older than MAX_TEMP_AGE_MS
  const now = Date.now();
  let remaining = files.length;
  for (const { path, mtime } of withStats) {
    if (remaining <= MAX_TEMP_FILES / 2 && now - mtime < MAX_TEMP_AGE_MS) break;
    try { unlinkSync(path); remaining--; } catch {}
  }
}

// ─── Browser Connection ─────────────────────────────────────────────

let browserWs = null;
let overrideUserDataDir = null;         // browser.connect override — takes priority in getWsUrl()
let activeConnectionInfo = null;         // { name, userDataDir, port, wsUrl }
let lastResolvedUserDataDir = null;      // tracks which User Data dir getWsUrl() resolved from
let nextId = 1;
const callbacks = new Map();            // msgId → { resolve, reject }
const activeSessions = new Map();       // targetId → sessionId
const enabledDomains = new Map();       // sessionId → Set<domain>
const consoleLogs = new Map();          // sessionId → [ {level, text, ts} ]
const networkReqs = new Map();          // sessionId → Map<requestId, reqObj>
const eventListeners = new Map();       // sessionId → Set<string>

// v3: Dialog & Fetch interception state
const pendingDialogs = new Map();       // sessionId → [ {type, message, defaultPrompt, url, ts} ]
const pendingFetchRequests = new Map(); // sessionId → Map(requestId → requestInfo)
const fetchRules = new Map();           // sessionId → [ { pattern, action, response } ]
const injectedScripts = new Map();      // sessionId → [ { identifier, description } ]
const refMaps = new Map();              // sessionId → Map<uid, backendNodeId>
const lastSnapshots = new Map();        // sessionId → { snapshot, url, title }
const agentSessions = new Map();        // agentSessionId → { lastActivity, tabIds: Set<tabId>, cleanupStrategy: string }
const tabLocks = new Map();             // tabId → { sessionId, origin: "created"|"claimed" }
const processSessionId = randomUUID();  // auto-assigned per-process session ID

const downloads = new Map();              // sessionId → [{guid, url, suggestedFilename, state, receivedBytes, totalBytes}]
const pausedTabs = new Map();             // cdpSessionId → { reason, callFrames, hitBreakpoints, ts }
const parsedScripts = new Map();          // cdpSessionId → Map<scriptId, { url, startLine, endLine, hash }>
const activeBreakpoints = new Map();      // cdpSessionId → Map<breakpointId, { url, lineNumber, columnNumber, condition }>
const resourceOverrides = new Map();      // cdpSessionId → [{ urlPattern, responseCode, headers, body }]
const fetchPatterns = new Map();          // cdpSessionId → { request: [...], response: [...] }
const pendingFileChoosers = new Map();    // cdpSessionId → [handler functions waiting for file chooser]
const oopFrameSessions = new Map();       // parentCdpSessionId → Map<targetId, { sessionId, url }>
const refOopSessions = new Map();         // parentCdpSessionId → Map<uid, childCdpSessionId>

const NO_ENABLE = new Set(["Input", "Target", "Browser", "Accessibility", "DOM", "Emulation", "Storage", "Fetch"]);

// ─── Connection Health ──────────────────────────────────────────────

let connectionHealth = { status: "disconnected", lastPing: null, lastPong: null, failures: 0 };
let healthCheckTimer = null;

// ─── Network Throttle Presets ───────────────────────────────────────

const NETWORK_PRESETS = {
  offline:  { offline: true,  latency: 0,      downloadThroughput: 0,       uploadThroughput: 0 },
  slow3g:   { offline: false, latency: 2000,   downloadThroughput: 50000,   uploadThroughput: 50000 },
  fast3g:   { offline: false, latency: 562.5,  downloadThroughput: 180000,  uploadThroughput: 84375 },
  slow4g:   { offline: false, latency: 150,    downloadThroughput: 400000,  uploadThroughput: 150000 },
  fast4g:   { offline: false, latency: 50,     downloadThroughput: 1500000, uploadThroughput: 750000 },
  none:     { offline: false, latency: 0,      downloadThroughput: -1,      uploadThroughput: -1 },
};

// ─── WS URL Discovery ───────────────────────────────────────────────

function getWsUrl() {
  const paths = [
    overrideUserDataDir,  // browser.connect override — takes priority
    process.env.CDP_USER_DATA,
    join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data"),
    join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data"),
    join(process.env.LOCALAPPDATA || "", "BraveSoftware", "Brave-Browser", "User Data"),
  ].filter(Boolean);
  for (const p of paths) {
    try {
      const c = readFileSync(join(p, "DevToolsActivePort"), "utf8");
      const lines = c.trim().split("\n");
      lastResolvedUserDataDir = p;
      return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
    } catch { /* next */ }
  }
  lastResolvedUserDataDir = null;
  return `ws://${CDP_HOST}:${CDP_PORT}/devtools/browser/`;
}

/**
 * Discover running Chrome instances by scanning known User Data directories
 * for DevToolsActivePort files + optionally reading Local State for profile names.
 * @param {{ skipProfiles?: boolean }} opts - skip Local State parsing for faster lookups
 */
function discoverChromeInstances({ skipProfiles = false } = {}) {
  const candidates = [
    { name: "Chrome", path: join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data") },
    { name: "Chrome Beta", path: join(process.env.LOCALAPPDATA || "", "Google", "Chrome Beta", "User Data") },
    { name: "Chrome Canary", path: join(process.env.LOCALAPPDATA || "", "Google", "Chrome SxS", "User Data") },
    { name: "Chromium", path: join(process.env.LOCALAPPDATA || "", "Chromium", "User Data") },
    { name: "Edge", path: join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data") },
    { name: "Brave", path: join(process.env.LOCALAPPDATA || "", "BraveSoftware", "Brave-Browser", "User Data") },
  ];
  if (process.env.CDP_USER_DATA) {
    candidates.unshift({ name: "Custom", path: process.env.CDP_USER_DATA });
  }

  const instances = [];
  for (const { name, path: udPath } of candidates) {
    try {
      const portFile = readFileSync(join(udPath, "DevToolsActivePort"), "utf8").trim();
      const lines = portFile.split("\n");
      const port = parseInt(lines[0]);
      const wsPath = lines[1];

      // Read profile names from Local State (skip when only port/wsUrl matching is needed)
      let profiles = [];
      if (!skipProfiles) {
        try {
          const localState = JSON.parse(readFileSync(join(udPath, "Local State"), "utf8"));
          const cache = localState?.profile?.info_cache || {};
          profiles = Object.entries(cache).map(([dir, info]) => ({
            directory: dir,
            name: info.name || dir,
            gaiaName: info.gaia_name || "",
            email: info.user_name || "",
          }));
        } catch { /* Local State may not exist or be readable */ }
      }

      instances.push({
        name,
        userDataDir: udPath,
        port,
        wsPath,
        wsUrl: `ws://127.0.0.1:${port}${wsPath}`,
        profiles,
        connected: browserWs?.url === `ws://127.0.0.1:${port}${wsPath}`,
      });
    } catch { /* no DevToolsActivePort — Chrome not running with this user-data-dir */ }
  }
  return instances;
}

// ─── Browser Connection ─────────────────────────────────────────────

function connectBrowser() {
  if (browserWs?.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const wsUrl = getWsUrl();
    browserWs = new WebSocket(wsUrl, { perMessageDeflate: false });
    browserWs.once("open", () => {
      startHealthCheck();
      // Auto-detect which Chrome instance we connected to
      if (!activeConnectionInfo) {
        const wsUrl = browserWs.url;
        const instances = discoverChromeInstances({ skipProfiles: true });
        const match = instances.find(i => i.wsUrl === wsUrl);
        if (match) {
          activeConnectionInfo = { name: match.name, userDataDir: match.userDataDir, port: match.port, wsUrl };
        } else {
          const portMatch = wsUrl.match(/:(\d+)/);
          activeConnectionInfo = { name: "Auto-detected", userDataDir: lastResolvedUserDataDir, port: portMatch ? parseInt(portMatch[1]) : CDP_PORT, wsUrl };
        }
      } else {
        // Always refresh wsUrl — Chrome regenerates the GUID on every restart
        activeConnectionInfo.wsUrl = browserWs.url;
      }
      // Enable popup/new-tab detection via browser-level Target events
      cdp("Target.setDiscoverTargets", { discover: true }).catch(() => {});
      resolve();
    });
    browserWs.once("error", () =>
      reject(new Error(
        "Cannot connect to browser. Enable remote debugging:\n" +
        "Chrome: chrome://flags → #enable-remote-debugging → Enabled → Relaunch\n" +
        "Edge: edge://flags → #enable-remote-debugging → Enabled → Relaunch\n" +
        "Brave: brave://flags → #enable-remote-debugging → Enabled → Relaunch\n" +
        "Or launch with --remote-debugging-port=" + CDP_PORT
      ))
    );
    browserWs.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== undefined) {
        const cb = callbacks.get(msg.id);
        if (cb) {
          callbacks.delete(msg.id);
          msg.error ? cb.reject(new Error(msg.error.message)) : cb.resolve(msg.result);
        }
        return;
      }
      if (msg.method && msg.sessionId) {
        handleEvent(msg.sessionId, msg.method, msg.params);
      }
      // Browser-level events (no sessionId) — popup/new-window detection
      if (msg.method === "Target.targetCreated" && msg.params?.targetInfo?.type === "page") {
        const ti = msg.params.targetInfo;
        const openerId = ti.openerId;
        if (openerId) {
          // This is a popup opened by another page — log it
          const openerSess = activeSessions.get(openerId);
          if (openerSess) {
            const logs = consoleLogs.get(openerSess) || [];
            logs.push({
              level: "info",
              text: `[popup] New tab opened: ${ti.url || "about:blank"} [${ti.targetId}]`,
              ts: Date.now(),
              url: "",
            });
            consoleLogs.set(openerSess, logs);
          }
        }
      }
    });
    browserWs.on("close", () => {
      for (const { reject: r } of callbacks.values()) r(new Error("WebSocket closed"));
      callbacks.clear();
      activeSessions.clear();
      enabledDomains.clear();
      consoleLogs.clear();
      networkReqs.clear();
      eventListeners.clear();
      pendingDialogs.clear();
      pendingFetchRequests.clear();
      fetchRules.clear();
      injectedScripts.clear();
      refMaps.clear();
      lastSnapshots.clear();
      downloads.clear();
      pausedTabs.clear();
      parsedScripts.clear();
      activeBreakpoints.clear();
      resourceOverrides.clear();
      fetchPatterns.clear();
      pendingFileChoosers.clear();
      browserWs = null;
      activeConnectionInfo = null;
      overrideUserDataDir = null;
      stopHealthCheck();
    });
  });
}

// ─── Connection Health Check ────────────────────────────────────────

function startHealthCheck() {
  stopHealthCheck();
  connectionHealth = { status: "connected", lastPing: null, lastPong: null, failures: 0 };
  healthCheckTimer = setInterval(() => {
    if (!browserWs || browserWs.readyState !== WebSocket.OPEN) {
      connectionHealth.status = "disconnected";
      return;
    }
    connectionHealth.lastPing = Date.now();
    let pongReceived = false;
    const pongHandler = () => { pongReceived = true; connectionHealth.lastPong = Date.now(); connectionHealth.failures = 0; connectionHealth.status = "connected"; };
    browserWs.once("pong", pongHandler);
    try { browserWs.ping(); } catch { connectionHealth.status = "error"; return; }
    setTimeout(() => {
      if (!pongReceived) {
        connectionHealth.failures++;
        connectionHealth.status = "unhealthy";
        browserWs.removeListener("pong", pongHandler);
        if (connectionHealth.failures >= 2) {
          connectionHealth.status = "dead";
          try { browserWs.terminate(); } catch { /* ok */ }
          browserWs = null;
        }
      }
    }, 5000);
  }, 30000);
}

function stopHealthCheck() {
  if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
  connectionHealth.status = "disconnected";
}

// ─── CDP Event Handler ──────────────────────────────────────────────

function handleEvent(sessionId, method, params) {
  // ── Console messages ──
  if (method === "Runtime.consoleAPICalled") {
    const logs = consoleLogs.get(sessionId) || [];
    logs.push({
      level: params.type,
      text: params.args?.map(a => a.value ?? a.description ?? a.type).join(" ") || "",
      ts: Date.now(),
      url: params.stackTrace?.callFrames?.[0]?.url || "",
    });
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    consoleLogs.set(sessionId, logs);
  }

  if (method === "Runtime.exceptionThrown") {
    const logs = consoleLogs.get(sessionId) || [];
    logs.push({
      level: "error",
      text: params.exceptionDetails?.exception?.description ||
            params.exceptionDetails?.text || "Unknown exception",
      ts: Date.now(),
      url: params.exceptionDetails?.url || "",
    });
    consoleLogs.set(sessionId, logs);
  }

  // ── Network requests ──
  if (method === "Network.requestWillBeSent") {
    const reqs = networkReqs.get(sessionId) || new Map();
    reqs.set(params.requestId, {
      id: params.requestId,
      url: params.request.url,
      method: params.request.method,
      type: params.type || "Other",
      ts: Date.now(),
      status: null,
      mimeType: null,
      size: null,
    });
    if (reqs.size > 300) {
      const first = reqs.keys().next().value;
      reqs.delete(first);
    }
    networkReqs.set(sessionId, reqs);
  }
  if (method === "Network.responseReceived") {
    const reqs = networkReqs.get(sessionId);
    if (reqs?.has(params.requestId)) {
      const r = reqs.get(params.requestId);
      r.status = params.response.status;
      r.mimeType = params.response.mimeType;
    }
  }
  if (method === "Network.loadingFinished") {
    const reqs = networkReqs.get(sessionId);
    if (reqs?.has(params.requestId)) {
      reqs.get(params.requestId).size = params.encodedDataLength;
    }
  }

  // ── Dialog handling (v3) ──
  if (method === "Page.javascriptDialogOpening") {
    const dialogs = pendingDialogs.get(sessionId) || [];
    dialogs.push({
      type: params.type,
      message: params.message,
      defaultPrompt: params.defaultPromptText || "",
      url: params.url || "",
      ts: Date.now(),
    });
    pendingDialogs.set(sessionId, dialogs);

    // Auto-accept after 10s if not manually handled
    setTimeout(async () => {
      const current = pendingDialogs.get(sessionId);
      if (current?.length > 0) {
        try {
          await cdp("Page.handleJavaScriptDialog", { accept: true }, sessionId);
          current.shift();
        } catch { /* already handled */ }
      }
    }, 10000);
  }

  // ── Download tracking ──
  if (method === "Page.downloadWillBegin") {
    const dl = downloads.get(sessionId) || [];
    dl.push({
      guid: params.guid,
      url: params.url,
      suggestedFilename: params.suggestedFilename || "unknown",
      state: "inProgress",
      receivedBytes: 0,
      totalBytes: 0,
      ts: Date.now(),
    });
    if (dl.length > 100) dl.splice(0, dl.length - 100);
    downloads.set(sessionId, dl);
  }
  if (method === "Page.downloadProgress") {
    const dl = downloads.get(sessionId);
    if (dl) {
      const entry = dl.find(d => d.guid === params.guid);
      if (entry) {
        entry.receivedBytes = params.receivedBytes || 0;
        entry.totalBytes = params.totalBytes || 0;
        entry.state = params.state || entry.state; // inProgress, completed, canceled
      }
    }
  }

  // ── Fetch interception (v3) ──
  if (method === "Fetch.requestPaused") {
    // Response-stage pause (has responseStatusCode) — check resource overrides
    if (params.responseStatusCode !== undefined) {
      const overrides = resourceOverrides.get(sessionId) || [];
      const url = params.request?.url || "";
      const override = overrides.find(o => {
        try { return new RegExp(o.urlPattern, "i").test(url); } catch { return false; }
      });
      if (override) {
        (async () => {
          try {
            await cdp("Fetch.fulfillRequest", {
              requestId: params.requestId,
              responseCode: override.responseCode || 200,
              responseHeaders: override.headers || [{ name: "Content-Type", value: "text/html" }],
              body: Buffer.from(override.body ?? "").toString("base64"),
            }, sessionId);
          } catch { /* ok */ }
        })();
      } else {
        // No matching override — MUST continue or Chrome hangs
        (async () => {
          try { await cdp("Fetch.continueResponse", { requestId: params.requestId }, sessionId); } catch { /* ok */ }
        })();
      }
      return;
    }

    // Request-stage pause — existing fetchRules logic
    const pending = pendingFetchRequests.get(sessionId) || new Map();
    const info = {
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      headers: params.request.headers,
      resourceType: params.resourceType,
      ts: Date.now(),
    };

    // Check auto-rules first
    const rules = fetchRules.get(sessionId) || [];
    const matchingRule = rules.find(r => {
      try {
        const re = new RegExp(r.pattern.replace(/\*/g, ".*"), "i");
        return re.test(info.url);
      } catch { return false; }
    });

    if (matchingRule) {
      (async () => {
        try {
          if (matchingRule.action === "block") {
            await cdp("Fetch.failRequest", { requestId: params.requestId, reason: "BlockedByClient" }, sessionId);
          } else if (matchingRule.action === "mock" && matchingRule.response) {
            const r = matchingRule.response;
            await cdp("Fetch.fulfillRequest", {
              requestId: params.requestId,
              responseCode: r.status || 200,
              responseHeaders: r.headers || [{ name: "Content-Type", value: "application/json" }],
              body: Buffer.from(r.body || "").toString("base64"),
            }, sessionId);
          } else {
            await cdp("Fetch.continueRequest", { requestId: params.requestId }, sessionId);
          }
        } catch { /* ok */ }
      })();
      return;
    }

    pending.set(params.requestId, info);
    pendingFetchRequests.set(sessionId, pending);

    // Auto-continue after 10s to prevent hangs
    setTimeout(async () => {
      if (pending.has(params.requestId)) {
        try { await cdp("Fetch.continueRequest", { requestId: params.requestId }, sessionId); } catch { /* ok */ }
        pending.delete(params.requestId);
      }
    }, 10000);
  }

  // ── Debugger events ──
  if (method === "Debugger.scriptParsed") {
    const scripts = parsedScripts.get(sessionId) || new Map();
    if (params.url) {
      scripts.set(params.scriptId, {
        url: params.url,
        startLine: params.startLine,
        endLine: params.endLine,
        hash: params.hash || "",
      });
      parsedScripts.set(sessionId, scripts);
    }
  }

  if (method === "Debugger.paused") {
    const pauseTs = Date.now();
    pausedTabs.set(sessionId, {
      reason: params.reason,
      callFrames: params.callFrames,
      hitBreakpoints: params.hitBreakpoints || [],
      ts: pauseTs,
    });
    // Auto-resume after timeout to prevent permanently bricked tabs
    setTimeout(async () => {
      const entry = pausedTabs.get(sessionId);
      if (entry && entry.ts === pauseTs) {
        try { await cdp("Debugger.resume", {}, sessionId); } catch { /* ok */ }
        pausedTabs.delete(sessionId);
      }
    }, CDP_DEBUGGER_TIMEOUT);
  }

  if (method === "Debugger.resumed") {
    pausedTabs.delete(sessionId);
  }

  // ── OOP iframe auto-attach events ──
  if (method === "Target.attachedToTarget") {
    const childSessionId = params.sessionId;
    const targetInfo = params.targetInfo;
    if (targetInfo?.type === "iframe") {
      const frames = oopFrameSessions.get(sessionId) || new Map();
      frames.set(targetInfo.targetId, { sessionId: childSessionId, url: targetInfo.url || "" });
      oopFrameSessions.set(sessionId, frames);
      // Enable Runtime on the child session for JS execution
      cdp("Runtime.enable", {}, childSessionId, 5000).catch(() => {});
    }
  }

  if (method === "Target.detachedFromTarget") {
    const frames = oopFrameSessions.get(sessionId);
    if (frames) {
      for (const [tid, info] of frames) {
        if (params.sessionId === info.sessionId || params.targetId === tid) {
          frames.delete(tid);
          break;
        }
      }
    }
  }

  // ── File chooser events ──
  if (method === "Page.fileChooserOpened") {
    const handlers = pendingFileChoosers.get(sessionId) || [];
    for (const handler of handlers) {
      handler(sessionId, method, params);
    }
  }
}

// ─── CDP Command ────────────────────────────────────────────────────

async function cdp(method, params = {}, sessionId, timeout = CDP_TIMEOUT) {
  await connectBrowser();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      callbacks.delete(id);
      reject(new Error(`${method}: timed out (${timeout}ms)`));
    }, timeout);
    callbacks.set(id, {
      resolve(r) { clearTimeout(timer); resolve(r); },
      reject(e) { clearTimeout(timer); reject(e); },
    });
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    browserWs.send(JSON.stringify(msg));
  });
}

// ─── Per-Tab Session Management ─────────────────────────────────────

async function getTabSession(tabId) {
  const existing = activeSessions.get(tabId);
  if (existing) {
    try {
      await cdp("Runtime.evaluate", { expression: "1", returnByValue: true }, existing, 5000);
      return existing;
    } catch {
      // If dialogs are pending, the evaluate may have failed because JS is blocked
      // by a dialog — session is still valid, just needs the dialog dismissed.
      const oldPendingDialogs = pendingDialogs.get(existing);
      if (oldPendingDialogs?.length > 0) {
        return existing;
      }

      // Session truly dead — clean up all per-session state for the dead session ID
      activeSessions.delete(tabId);
      enabledDomains.delete(existing);
      pendingDialogs.delete(existing);
      consoleLogs.delete(existing);
      networkReqs.delete(existing);
      refMaps.delete(existing);
      lastSnapshots.delete(existing);
      injectedScripts.delete(existing);
      eventListeners.delete(existing);
      downloads.delete(existing);
      fetchRules.delete(existing);
      pendingFetchRequests.delete(existing);
      pausedTabs.delete(existing);
      parsedScripts.delete(existing);
      activeBreakpoints.delete(existing);
      resourceOverrides.delete(existing);
      fetchPatterns.delete(existing);
      pendingFileChoosers.delete(existing);
      oopFrameSessions.delete(existing);
      refOopSessions.delete(existing);
    }
  }

  const { sessionId } = await cdp("Target.attachToTarget", { targetId: tabId, flatten: true });

  // Ensure Runtime is enabled for both evaluate and event emission
  try {
    await cdp("Runtime.enable", {}, sessionId, LONG_TIMEOUT);
  } catch { /* some targets don't support it */ }

  activeSessions.set(tabId, sessionId);
  enabledDomains.set(sessionId, new Set(["Runtime"]));
  consoleLogs.set(sessionId, []);
  networkReqs.set(sessionId, new Map());

  // v3: Enable Page domain for dialog handling
  await ensureDomain(sessionId, "Page");

  // v4.12: Enable auto-attach for OOP (cross-origin) iframe discovery
  try {
    await cdp("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    }, sessionId);
  } catch { /* older Chrome versions may not support auto-attach on page sessions */ }

  return sessionId;
}

async function ensureDomain(sessionId, domain) {
  const domains = enabledDomains.get(sessionId) || new Set();
  if (domains.has(domain) || NO_ENABLE.has(domain)) return;
  try {
    await cdp(`${domain}.enable`, {}, sessionId, 10000);
    domains.add(domain);
    enabledDomains.set(sessionId, domains);
  } catch {
    domains.add(domain);
    enabledDomains.set(sessionId, domains);
  }
}

async function enableMonitoring(sessionId, what) {
  const listeners = eventListeners.get(sessionId) || new Set();
  if (what === "console" && !listeners.has("console")) {
    listeners.add("console");
  }
  if (what === "network" && !listeners.has("network")) {
    await ensureDomain(sessionId, "Network");
    listeners.add("network");
  }
  eventListeners.set(sessionId, listeners);
}

async function detachTab(tabId) {
  // Always clean lock and session refs first — even if no CDP session exists
  // (a tab created via tabs.new gets locked immediately but may never be interacted with)
  tabLocks.delete(tabId);
  for (const [, agentSession] of agentSessions) {
    agentSession.tabIds.delete(tabId);
  }
  const sid = activeSessions.get(tabId);
  if (!sid) return;
  try { await cdp("Target.detachFromTarget", { sessionId: sid }); } catch { /* ok */ }
  activeSessions.delete(tabId);
  enabledDomains.delete(sid);
  consoleLogs.delete(sid);
  networkReqs.delete(sid);
  eventListeners.delete(sid);
  pendingDialogs.delete(sid);
  pendingFetchRequests.delete(sid);
  fetchRules.delete(sid);
  injectedScripts.delete(sid);
  refMaps.delete(sid);
  lastSnapshots.delete(sid);
  downloads.delete(sid);
  pausedTabs.delete(sid);
  parsedScripts.delete(sid);
  activeBreakpoints.delete(sid);
  resourceOverrides.delete(sid);
  fetchPatterns.delete(sid);
  pendingFileChoosers.delete(sid);
  oopFrameSessions.delete(sid);
  refOopSessions.delete(sid);
}

// ─── Tab Listing ────────────────────────────────────────────────────

/**
 * Clean up a tab with the given strategy.
 * @param {string} tabId
 * @param {"close"|"detach"|"none"} strategy
 */
async function cleanupTab(tabId, strategy = "close") {
  if (strategy === "none") return; // "none" = no cleanup at all
  await detachTab(tabId); // also calls tabLocks.delete(tabId) internally
  if (strategy === "close") {
    try { await cdp("Target.closeTarget", { targetId: tabId }); } catch { /* ok */ }
  }
}

/**
 * Sweep stale agent sessions and clean up their owned tabs.
 * Shared function called from handleTool and periodic setInterval.
 */
async function sweepStaleSessions() {
  const now = Date.now();
  for (const [id, s] of agentSessions) {
    if (now - s.lastActivity > SESSION_TTL) {
      // "none" strategy = persist indefinitely — skip the entire sweep for this session
      if (s.cleanupStrategy === "none") continue;

      for (const tid of s.tabIds) {
        // Only cleanup tabs this session actually owns (locked to it)
        // Borrowed tabs (exclusive:false) should just be removed from tabIds, not closed/detached
        const lock = tabLocks.get(tid);
        if (lock?.sessionId === id) {
          if (lock.origin === "claimed") {
            // Pre-existing tabs: release lock + detach, never close
            try { await detachTab(tid); } catch { /* ok */ }
          } else {
            try { await cleanupTab(tid, s.cleanupStrategy); } catch { /* ok */ }
          }
        }
      }
      // Clear the session's tabIds (including borrowed refs) and delete session
      s.tabIds.clear();
      agentSessions.delete(id);
    }
  }
}

async function getTabs() {
  await connectBrowser();
  const { targetInfos } = await cdp("Target.getTargets", { filter: [{ type: "page" }] });
  return targetInfos || [];
}

/**
 * Resolve a profile name/email/directory to its browserContextId.
 * Cross-references Local State profile names with live tab browserContextId values.
 * @param {string} profileQuery - profile name, email, or directory (e.g. "Work", "mansha@gmail.com", "Profile 7")
 * @returns {Promise<{browserContextId: string, profileName: string}|null>}
 */
async function resolveProfileContext(profileQuery) {
  if (!profileQuery) return null;
  const q = profileQuery.toLowerCase();

  // Get live tabs to see which browserContextIds exist
  const tabs = await getTabs();
  const contextIds = new Set(tabs.map(t => t.browserContextId).filter(Boolean));
  if (contextIds.size === 0) return null;

  // Read Local State for profile metadata
  const udPath = activeConnectionInfo?.userDataDir || lastResolvedUserDataDir;
  if (!udPath) return null;
  let profileMap = []; // [{ directory, name, email, browserContextId? }]
  try {
    const localState = JSON.parse(readFileSync(join(udPath, "Local State"), "utf8"));
    const cache = localState?.profile?.info_cache || {};
    profileMap = Object.entries(cache).map(([dir, info]) => ({
      directory: dir,
      name: info.name || dir,
      gaiaName: info.gaia_name || "",
      email: info.user_name || "",
    }));
  } catch { return null; }

  // Chrome doesn't directly map profile directories to browserContextIds,
  // but each profile gets a unique context. If we have N profiles and N contexts,
  // we can match by ordering (Chrome assigns contexts in profile creation order).
  // More reliably: if a profile has ANY open tab, we can match it.
  // Strategy: group tabs by browserContextId, then match profiles by finding
  // a context whose tabs' URLs/titles align with the profile.
  // For exact matching: accept browserContextId directly as profileQuery.
  
  // Direct browserContextId match
  if (contextIds.has(profileQuery)) {
    const profile = profileMap.find(p => p.directory.toLowerCase() === q || p.name.toLowerCase() === q || p.email.toLowerCase() === q);
    return { browserContextId: profileQuery, profileName: profile?.name || profileQuery };
  }

  // Match by profile name, email, or directory
  const matchedProfile = profileMap.find(p =>
    p.name.toLowerCase() === q ||
    p.email.toLowerCase() === q ||
    p.directory.toLowerCase() === q ||
    p.gaiaName.toLowerCase() === q
  );
  if (!matchedProfile) return null;

  // If there's only one context, it must be this profile
  if (contextIds.size === 1) {
    const [ctxId] = contextIds;
    return { browserContextId: ctxId, profileName: matchedProfile.name };
  }

  // Multiple contexts — try to find which one belongs to this profile.
  // Group tabs by context, match profile index to context index as a heuristic.
  // Chrome typically assigns browserContextIds in profile creation order.
  const profileIndex = profileMap.indexOf(matchedProfile);
  const sortedContexts = [...contextIds].sort(); // consistent ordering
  if (profileIndex >= 0 && profileIndex < sortedContexts.length) {
    return { browserContextId: sortedContexts[profileIndex], profileName: matchedProfile.name };
  }

  // Fallback: return first available context with a warning
  return null;
}

// ─── Accessibility Tree / Snapshot ──────────────────────────────────

function collectFrameIds(frameTree) {
  const ids = [frameTree.frame.id];
  if (frameTree.childFrames) {
    for (const child of frameTree.childFrames) {
      ids.push(...collectFrameIds(child));
    }
  }
  return ids;
}

async function buildSnapshot(sessionId) {
  await ensureDomain(sessionId, "Accessibility");

  // Get frame tree for iframe support
  let frameIds = [];
  try {
    await ensureDomain(sessionId, "Page");
    const { frameTree } = await cdp("Page.getFrameTree", {}, sessionId);
    frameIds = collectFrameIds(frameTree);
  } catch {
    // Can't get frame tree — use root frame only (getFullAXTree without frameId)
    frameIds = [null];
  }

  const newRefMap = new Map(); // ref (number) → backendDOMNodeId
  let refCounter = 0;
  let allLines = [];

  for (const frameId of frameIds) {
    try {
      const params = {};
      if (frameId) params.frameId = frameId;
      const { nodes } = await cdp("Accessibility.getFullAXTree", params, sessionId);
      if (!nodes || nodes.length === 0) continue;

      // Build node lookup
      const nodeMap = new Map();
      for (const n of nodes) nodeMap.set(n.nodeId, n);

      // Find root nodes (no parentId or parent not in this set)
      const roots = nodes.filter(n => !n.parentId || !nodeMap.has(n.parentId));

      // Prefix for sub-frames
      const frameIndex = frameIds.indexOf(frameId);
      const prefix = frameIndex > 0 ? `[frame ${frameIndex}] ` : "";

      function renderNode(node, depth) {
        if (node.ignored) {
          // Still process children of ignored nodes (they may contain non-ignored content)
          const children = (node.childIds || []).map(id => nodeMap.get(id)).filter(Boolean);
          return children.map(c => renderNode(c, depth)).filter(Boolean).join("\n");
        }

        const role = node.role?.value;
        if (!role || role === "none" || role === "GenericContainer" || role === "InlineTextBox") {
          // Skip generic containers but recurse into children
          const children = (node.childIds || []).map(id => nodeMap.get(id)).filter(Boolean);
          return children.map(c => renderNode(c, depth)).filter(Boolean).join("\n");
        }

        const ref = ++refCounter;
        if (node.backendDOMNodeId) {
          newRefMap.set(ref, node.backendDOMNodeId);
        }

        const indent = "  ".repeat(depth);
        const name = node.name?.value || "";
        const nameStr = name ? ` "${name.replace(/[\n\r"\\]/g, " ").trim().substring(0, 120)}"` : "";

        // Collect properties
        const props = [];
        if (node.properties) {
          for (const p of node.properties) {
            const val = p.value?.value;
            if (val === undefined || val === null) continue;
            switch (p.name) {
              case "disabled": if (val) props.push("disabled"); break;
              case "checked": if (val === "true" || val === true) props.push("checked"); else if (val === "mixed") props.push("mixed"); break;
              case "expanded": props.push(val ? "expanded" : "collapsed"); break;
              case "selected": if (val) props.push("selected"); break;
              case "required": if (val) props.push("required"); break;
              case "readonly": if (val) props.push("readonly"); break;
              case "focused": if (val) props.push("focused"); break;
              case "pressed": if (val === "true" || val === true) props.push("pressed"); break;
              case "level": props.push("level=" + val); break;
              case "valuetext": props.push("value=" + JSON.stringify(String(val).substring(0, 80))); break;
              case "hasPopup": if (val && val !== "false") props.push("haspopup=" + val); break;
              case "autocomplete": if (val && val !== "none") props.push("autocomplete=" + val); break;
              case "modal": if (val) props.push("modal"); break;
              case "multiselectable": if (val) props.push("multiselectable"); break;
              case "orientation": if (val !== "none") props.push("orientation=" + val); break;
            }
          }
        }

        // Add value for inputs
        if (node.value?.value !== undefined && node.value.value !== "") {
          const v = String(node.value.value).substring(0, 80);
          if (!props.some(p => p.startsWith("value="))) {
            props.push("value=" + JSON.stringify(v));
          }
        }

        const propStr = props.length ? " [" + props.join(", ") + "]" : "";
        let line = `${indent}${prefix}- ${role}${nameStr}${propStr} [ref=${ref}]`;

        // Process children
        const children = (node.childIds || []).map(id => nodeMap.get(id)).filter(Boolean);
        const childLines = children.map(c => renderNode(c, depth + 1)).filter(Boolean);

        if (childLines.length > 0) {
          return line + "\n" + childLines.join("\n");
        }
        return line;
      }

      for (const root of roots) {
        const rendered = renderNode(root, 0);
        if (rendered) allLines.push(rendered);
      }
    } catch (e) {
      // If a sub-frame fails, continue with others
      if (frameId) allLines.push(`  - [frame error: ${e.message?.substring(0, 60)}]`);
    }
  }

  // ── OOP (cross-origin) iframe content via auto-attached child sessions ──
  const oopFrames = oopFrameSessions.get(sessionId);
  const newRouting = new Map();
  if (oopFrames?.size > 0) {
    let oopIndex = frameIds.length; // continue frame numbering
    for (const [targetId, { sessionId: childSess, url: frameUrl }] of oopFrames) {
      try {
        const { nodes } = await cdp("Accessibility.getFullAXTree", {}, childSess);
        if (!nodes || nodes.length === 0) continue;

        const nodeMap = new Map();
        for (const n of nodes) nodeMap.set(n.nodeId, n);
        const roots = nodes.filter(n => !n.parentId || !nodeMap.has(n.parentId));
        const prefix = `[frame ${oopIndex}] `;

        function renderOopNode(node, depth) {
          if (node.ignored) {
            const children = (node.childIds || []).map(id => nodeMap.get(id)).filter(Boolean);
            return children.map(c => renderOopNode(c, depth)).filter(Boolean).join("\n");
          }
          const role = node.role?.value;
          if (!role || role === "none" || role === "GenericContainer" || role === "InlineTextBox") {
            const children = (node.childIds || []).map(id => nodeMap.get(id)).filter(Boolean);
            return children.map(c => renderOopNode(c, depth)).filter(Boolean).join("\n");
          }
          const ref = ++refCounter;
          if (node.backendDOMNodeId) {
            newRefMap.set(ref, node.backendDOMNodeId);
            newRouting.set(ref, childSess); // route this uid to the child session
          }
          const indent = "  ".repeat(depth);
          const name = node.name?.value || "";
          const nameStr = name ? ` "${name.replace(/[\n\r"\\]/g, " ").trim().substring(0, 120)}"` : "";
          const props = [];
          if (node.properties) {
            for (const p of node.properties) {
              const val = p.value?.value;
              if (val === undefined || val === null) continue;
              switch (p.name) {
                case "disabled": if (val) props.push("disabled"); break;
                case "checked": if (val === "true" || val === true) props.push("checked"); else if (val === "mixed") props.push("mixed"); break;
                case "expanded": props.push(val ? "expanded" : "collapsed"); break;
                case "selected": if (val) props.push("selected"); break;
                case "required": if (val) props.push("required"); break;
                case "readonly": if (val) props.push("readonly"); break;
                case "focused": if (val) props.push("focused"); break;
                case "pressed": if (val === "true" || val === true) props.push("pressed"); break;
                case "level": props.push("level=" + val); break;
                case "valuetext": props.push("value=" + JSON.stringify(String(val).substring(0, 80))); break;
                case "hasPopup": if (val && val !== "false") props.push("haspopup=" + val); break;
                case "autocomplete": if (val && val !== "none") props.push("autocomplete=" + val); break;
                case "modal": if (val) props.push("modal"); break;
                case "multiselectable": if (val) props.push("multiselectable"); break;
                case "orientation": if (val !== "none") props.push("orientation=" + val); break;
              }
            }
          }
          if (node.value?.value !== undefined && node.value.value !== "") {
            const v = String(node.value.value).substring(0, 80);
            if (!props.some(p => p.startsWith("value="))) props.push("value=" + JSON.stringify(v));
          }
          const propStr = props.length ? " [" + props.join(", ") + "]" : "";
          let line = `${indent}${prefix}- ${role}${nameStr}${propStr} [ref=${ref}]`;
          const children = (node.childIds || []).map(id => nodeMap.get(id)).filter(Boolean);
          const childLines = children.map(c => renderOopNode(c, depth + 1)).filter(Boolean);
          if (childLines.length > 0) return line + "\n" + childLines.join("\n");
          return line;
        }

        for (const root of roots) {
          const rendered = renderOopNode(root, 0);
          if (rendered) allLines.push(rendered);
        }
        oopIndex++;
      } catch (e) {
        allLines.push(`  - [oop-frame error: ${e.message?.substring(0, 60)}]`);
      }
    }
  }
  refOopSessions.set(sessionId, newRouting);

  // Update ref map
  refMaps.set(sessionId, newRefMap);

  const snapshot = allLines.join("\n");

  // Get page metadata
  let url = "", title = "";
  try {
    const meta = await cdp("Runtime.evaluate", {
      expression: `({ url: location.href, title: document.title })`,
      returnByValue: true,
    }, sessionId);
    url = meta.result?.value?.url || "";
    title = meta.result?.value?.title || "";
  } catch {}

  return { snapshot, count: refCounter, url, title };
}

// ─── Helpers ────────────────────────────────────────────────────────

function ok(t) {
  const text = typeof t === "string" ? t : JSON.stringify(t, null, 2);
  if (text.length > MAX_INLINE_LEN) {
    const file = writeTempFile(`output-${Date.now()}.txt`, text);
    return {
      content: [{ type: "text", text: `Output too large (${text.length} chars). Saved to: ${file}\n\nFirst 2000 chars:\n${text.substring(0, 2000)}` }],
    };
  }
  return { content: [{ type: "text", text }] };
}

function fail(msg) {
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay(baseMs) {
  // Returns random value in range [baseMs, baseMs * 3]
  return baseMs + Math.random() * (baseMs * 2);
}

/**
 * Generate a natural-looking mouse path using a randomized cubic bezier curve.
 * Includes slight overshoot, speed variation, and jitter for anti-detection.
 * @param {{x,y}} from - start point
 * @param {{x,y}} to - end point
 * @param {number} [steps=20] - number of intermediate points
 * @param {number} [jitter=2] - max random pixel offset per point
 * @returns {{x:number, y:number}[]} array of {x, y} points along the path
 */
function generateBezierPath(from, to, steps = 20, jitter = 2) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  // Control point spread scales with distance
  const spread = Math.min(dist * 0.3, 100);
  const cp1 = {
    x: from.x + dx * 0.2 + (Math.random() - 0.5) * spread,
    y: from.y + dy * 0.2 + (Math.random() - 0.5) * spread,
  };
  const cp2 = {
    x: from.x + dx * 0.8 + (Math.random() - 0.5) * spread,
    y: from.y + dy * 0.8 + (Math.random() - 0.5) * spread,
  };
  // Slight overshoot past target
  const overshoot = 3 + Math.random() * 5;
  const angle = Math.atan2(dy, dx);
  const overshootTarget = {
    x: to.x + Math.cos(angle) * overshoot,
    y: to.y + Math.sin(angle) * overshoot,
  };
  const points = [];
  // Phase 1: Move to overshoot point (80% of steps)
  const mainSteps = Math.round(steps * 0.8);
  for (let i = 0; i <= mainSteps; i++) {
    const t = i / mainSteps;
    const mt = 1 - t;
    const x = mt*mt*mt * from.x + 3*mt*mt*t * cp1.x + 3*mt*t*t * cp2.x + t*t*t * overshootTarget.x;
    const y = mt*mt*mt * from.y + 3*mt*mt*t * cp1.y + 3*mt*t*t * cp2.y + t*t*t * overshootTarget.y;
    const jitterScale = Math.sin(t * Math.PI);
    points.push({
      x: x + (Math.random() - 0.5) * jitter * jitterScale,
      y: y + (Math.random() - 0.5) * jitter * jitterScale,
    });
  }
  // Phase 2: Correction from overshoot back to actual target
  const corrSteps = steps - mainSteps;
  for (let i = 1; i <= corrSteps; i++) {
    const t = i / corrSteps;
    points.push({
      x: overshootTarget.x + (to.x - overshootTarget.x) * t + (Math.random() - 0.5) * jitter * 0.3,
      y: overshootTarget.y + (to.y - overshootTarget.y) * t + (Math.random() - 0.5) * jitter * 0.3,
    });
  }
  return points;
}

// ─── QWERTY Keyboard Neighbors (for typo simulation) ───────────────

const QWERTY_NEIGHBORS = {
  q: "wa", w: "qeas", e: "wrds", r: "etfs", t: "rygs", y: "tuhj",
  u: "yijk", i: "uokl", o: "iplm", p: "ol",
  a: "qwsz", s: "weadxz", d: "ersfxc", f: "rtdgcv", g: "tyfhvb",
  h: "yugjbn", j: "uihknm", k: "iojlm", l: "opk",
  z: "asx", x: "zsdc", c: "xdfv", v: "cfgb", b: "vghn",
  n: "bhjm", m: "njk",
};

function getAdjacentKey(char) {
  const lower = char.toLowerCase();
  const neighbors = QWERTY_NEIGHBORS[lower];
  if (!neighbors) return char;
  const picked = neighbors[Math.floor(Math.random() * neighbors.length)];
  return char === char.toUpperCase() ? picked.toUpperCase() : picked;
}

/**
 * Wait for page ready state based on waitUntil strategy (like Playwright):
 * - "load": document.readyState === "complete" (default)
 * - "domcontentloaded": document.readyState !== "loading"
 * - "networkidle": readyState complete + no network activity for 500ms
 * - "commit": returns immediately (handled by caller)
 */
async function waitForReadyState(sess, waitUntil, timeout) {
  const start = Date.now();
  const target = waitUntil === "domcontentloaded" ? "interactive" : "complete";
  while (Date.now() - start < timeout) {
    try {
      const r = await cdp("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, sess, 3000);
      const state = r.result.value;
      if (target === "interactive" && state !== "loading") break;
      if (target === "complete" && state === "complete") break;
    } catch { /* page transitioning */ }
    await sleep(500);
  }
  // For networkidle, also wait for no pending requests for 500ms
  if (waitUntil === "networkidle") {
    const idleStart = Date.now();
    let lastActivity = Date.now();
    while (Date.now() - idleStart < Math.min(5000, timeout - (Date.now() - start))) {
      try {
        const r = await cdp("Runtime.evaluate", {
          expression: `performance.getEntriesByType('resource').filter(e => e.responseEnd === 0).length`,
          returnByValue: true,
        }, sess, 2000);
        if (r.result.value > 0) lastActivity = Date.now();
        if (Date.now() - lastActivity > 500) break;
      } catch { break; }
      await sleep(200);
    }
  }
}

// ─── Auto-Waiting (Playwright-inspired) ─────────────────────────────

/**
 * Wraps an action callback and waits for triggered network activity to settle.
 * Detects XHR/fetch/navigation requests fired by the action and waits for them to complete.
 * @param {string} sessionId - CDP session ID
 * @param {Function} actionFn - async function performing the action
 * @param {object} [opts] - options: { timeout: 5000 }
 * @returns {Promise<{result: any, networkEvents: string[]}>} action result + network events
 */
async function waitForCompletion(sessionId, actionFn, opts = {}) {
  const timeout = opts.timeout || 5000;
  const pendingRequests = new Map(); // requestId → { url, method, type, ts }
  const completedEvents = [];
  let navigationDetected = false;

  // Ensure network monitoring is active
  await enableMonitoring(sessionId, "network");

  // Snapshot current network request count to detect new ones
  const reqMap = networkReqs.get(sessionId) || new Map();
  const prevRequestIds = new Set(reqMap.keys());

  // Execute the action
  const result = await actionFn();

  // Wait a brief moment for triggered requests to start
  await sleep(150);

  // Collect new requests that appeared since the action
  const currentReqMap = networkReqs.get(sessionId) || new Map();
  for (const [reqId, req] of currentReqMap) {
    if (!prevRequestIds.has(reqId) && !req.status) {
      pendingRequests.set(reqId, req);
      if ((req.type || "").toLowerCase() === "document") {
        navigationDetected = true;
      }
    }
  }

  // If navigation detected, wait for page load (up to 10s)
  if (navigationDetected) {
    const navTimeout = Math.min(timeout * 2, 10000);
    const start = Date.now();
    while (Date.now() - start < navTimeout) {
      try {
        const r = await cdp("Runtime.evaluate", {
          expression: "document.readyState",
          returnByValue: true,
        }, sessionId, 3000);
        if (r.result.value === "complete") break;
      } catch { /* page transitioning */ }
      await sleep(300);
    }
    completedEvents.push("[NAV] Page navigation detected and loaded");
  }

  // Wait for pending XHR/fetch requests to complete (up to timeout)
  if (pendingRequests.size > 0) {
    const start = Date.now();
    while (Date.now() - start < timeout && pendingRequests.size > 0) {
      const updatedMap = networkReqs.get(sessionId) || new Map();
      for (const [reqId, req] of pendingRequests) {
        const updated = updatedMap.get(reqId);
        if (updated?.status) {
          completedEvents.push(`[${(updated.type || "XHR").toUpperCase()}] ${updated.method} ${updated.url.substring(0, 80)} → ${updated.status}`);
          pendingRequests.delete(reqId);
        }
      }
      if (pendingRequests.size > 0) await sleep(100);
    }

    // Report timed-out requests
    for (const [, req] of pendingRequests) {
      completedEvents.push(`[PENDING] ${req.method} ${req.url.substring(0, 80)} (still loading)`);
    }
  }

  // Extra settling pause if any network activity occurred
  if (completedEvents.length > 0) {
    await sleep(200);
  }

  return { result, networkEvents: completedEvents };
}

/**
 * Check element actionability: visible, enabled, stable position, non-zero size.
 * Returns the element info or throws a descriptive error.
 */
async function checkActionability(sessionId, uid, selector) {
  const el = await resolveElement(sessionId, uid, selector);

  // Check non-zero size
  if (el.w <= 0 || el.h <= 0) {
    throw new Error(`Element <${el.tag}> "${el.label}" has zero size (${el.w}x${el.h}) — it may be hidden or inside a collapsed section. Try scrolling to the element or expanding its parent container.`);
  }

  // Check actionability via backendNodeId or selector
  let objectId;
  let resolveSession = sessionId;
  if (uid !== undefined && uid !== null) {
    const map = refMaps.get(sessionId);
    const backendNodeId = map?.get(uid);
    if (backendNodeId) {
      resolveSession = getResolveSession(sessionId, uid);
      try {
        const { object } = await cdp("DOM.resolveNode", { backendNodeId }, resolveSession);
        objectId = object?.objectId;
      } catch {}
    }
  }
  if (!objectId && selector) {
    const finder = elementFinderExpr(selector);
    const res = await cdp("Runtime.evaluate", { expression: finder, returnByValue: false }, sessionId);
    objectId = res.result?.objectId;
  }

  if (objectId) {
    const checks = await cdp("Runtime.callFunctionOn", {
      functionDeclaration: `function() {
        if (this.disabled) return { error: "Element <" + this.tagName.toLowerCase() + "> '" + (this.getAttribute("aria-label") || this.textContent || "").trim().substring(0, 40) + "' is disabled — wait for it to become enabled or check if a prerequisite action is needed." };
        const s = getComputedStyle(this);
        if (s.visibility === "hidden" || s.display === "none") return { error: "Element is not visible (display: " + s.display + ", visibility: " + s.visibility + ") — it may be inside a collapsed section or behind a modal. Try dismissing overlays or expanding parent containers." };
        if (parseFloat(s.opacity) === 0) return { error: "Element has opacity: 0 — it may be hidden or animating in. Wait briefly and retry, or check for overlays." };
        if (s.pointerEvents === "none") return { error: "Element has pointer-events: none — it cannot be clicked. It may be covered by an overlay. Try dismissing modals or interacting with a parent element." };
        return { ok: true };
      }`,
      objectId,
      returnByValue: true,
    }, resolveSession);
    const v = checks.result?.value;
    if (v?.error) throw new Error(v.error);
  }

  // Hit-test: verify no other element is covering the click target
  try {
    await cdp("Runtime.evaluate", {
      expression: `(() => {
        const el = document.elementFromPoint(${Math.round(el.x)}, ${Math.round(el.y)});
        if (!el) return { clear: true };
        return { tag: el.tagName.toLowerCase(), class: el.className?.toString?.()?.substring(0, 60) || "" };
      })()`,
      returnByValue: true,
    }, sessionId);
    // We don't block on hit-test mismatch — just provide info
  } catch {}

  return el;
}

/**
 * Retry a function until it succeeds or timeout expires.
 * Used to wrap element resolution + actionability checks for Playwright-style auto-waiting.
 * @param {Function} fn - async function to retry
 * @param {object} opts - { timeout: 5000, interval: 200 }
 */
async function withRetry(fn, { timeout = 5000, interval = 200 } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (true) {
    try { return await fn(); }
    catch (e) {
      lastError = e;
      // Fast-fail on errors that will never recover with retries:
      // - Stale uid refs require a new snapshot (refMaps is static between snapshots)
      // - Missing input params are user errors, not transient failures
      const msg = e.message || "";
      if (msg.includes("ref=") && msg.includes("not found")) throw e;
      if (msg.includes("Provide either")) throw e;
      if (Date.now() + interval > deadline) throw lastError;
      await sleep(interval);
    }
  }
}

// ─── Key Mapping ────────────────────────────────────────────────────

const KEY_MAP = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  f1: { key: "F1", code: "F1", keyCode: 112 }, f2: { key: "F2", code: "F2", keyCode: 113 },
  f3: { key: "F3", code: "F3", keyCode: 114 }, f4: { key: "F4", code: "F4", keyCode: 115 },
  f5: { key: "F5", code: "F5", keyCode: 116 }, f6: { key: "F6", code: "F6", keyCode: 117 },
  f7: { key: "F7", code: "F7", keyCode: 118 }, f8: { key: "F8", code: "F8", keyCode: 119 },
  f9: { key: "F9", code: "F9", keyCode: 120 }, f10: { key: "F10", code: "F10", keyCode: 121 },
  f11: { key: "F11", code: "F11", keyCode: 122 }, f12: { key: "F12", code: "F12", keyCode: 123 },
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
};

function resolveKey(keyName) {
  const lower = keyName.toLowerCase();
  if (KEY_MAP[lower]) return KEY_MAP[lower];
  if (keyName.length === 1) {
    return { key: keyName, code: `Key${keyName.toUpperCase()}`, keyCode: keyName.toUpperCase().charCodeAt(0), text: keyName };
  }
  return { key: keyName, code: keyName, keyCode: 0 };
}

function modifierFlags(modifiers) {
  let flags = 0;
  if (!modifiers) return flags;
  for (const m of modifiers) {
    switch (m.toLowerCase()) {
      case "alt": flags |= 1; break;
      case "ctrl": case "control": flags |= 2; break;
      case "meta": case "cmd": case "command": flags |= 4; break;
      case "shift": flags |= 8; break;
    }
  }
  return flags;
}

// ─── Element Resolution (stable backendNodeId refs) ─────────────────

/** Determine which CDP session to use for a given uid (parent vs OOP child) */
function getResolveSession(parentSessionId, uid) {
  if (uid === undefined || uid === null) return parentSessionId;
  const routing = refOopSessions.get(parentSessionId);
  return routing?.get(uid) || parentSessionId;
}

/** Get the viewport offset of an OOP iframe in the parent page (for coordinate transformation) */
async function getOopIframeOffset(parentSessionId, uid) {
  const routing = refOopSessions.get(parentSessionId);
  const childSessionId = routing?.get(uid);
  if (!childSessionId) return null; // not an OOP iframe element

  // Find the frameId (targetId) for this child session
  const oopFrames = oopFrameSessions.get(parentSessionId);
  if (!oopFrames) return { x: 0, y: 0 };

  let frameId = null;
  for (const [tid, info] of oopFrames) {
    if (info.sessionId === childSessionId) {
      frameId = tid;
      break;
    }
  }
  if (!frameId) return { x: 0, y: 0 };

  try {
    const { backendNodeId } = await cdp("DOM.getFrameOwner", { frameId }, parentSessionId);
    const { object } = await cdp("DOM.resolveNode", { backendNodeId }, parentSessionId);
    if (object?.objectId) {
      const result = await cdp("Runtime.callFunctionOn", {
        functionDeclaration: `function() {
          const r = this.getBoundingClientRect();
          return { x: r.x, y: r.y };
        }`,
        objectId: object.objectId,
        returnByValue: true,
      }, parentSessionId);
      return result.result?.value || { x: 0, y: 0 };
    }
  } catch {}
  return { x: 0, y: 0 };
}

/** Build a JS expression that finds an element by CSS selector, piercing shadow DOM */
function elementFinderExpr(selector) {
  if (!selector) throw new Error("Provide a CSS 'selector' or take a snapshot and use 'uid' (ref number).");
  return `(() => {
    function deepQuery(root, sel) {
      const el = root.querySelector(sel);
      if (el) return el;
      for (const s of root.querySelectorAll('*')) {
        if (s.shadowRoot) {
          const found = deepQuery(s.shadowRoot, sel);
          if (found) return found;
        }
      }
      return null;
    }
    return deepQuery(document, ${JSON.stringify(selector)});
  })()`;
}

async function resolveElement(sessionId, uid, selector) {
  // Primary path: backendNodeId resolution (works for uid from snapshots)
  if (uid !== undefined && uid !== null) {
    const map = refMaps.get(sessionId);
    const backendNodeId = map?.get(uid);
    if (backendNodeId) {
      const resolveSession = getResolveSession(sessionId, uid);
      try {
        const { object } = await cdp("DOM.resolveNode", { backendNodeId }, resolveSession);
        if (object?.objectId) {
          const result = await cdp("Runtime.callFunctionOn", {
            functionDeclaration: `function() {
              this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
              const r = this.getBoundingClientRect();
              return {
                x: r.x + r.width / 2,
                y: r.y + r.height / 2,
                tag: this.tagName.toLowerCase(),
                label: (this.getAttribute("aria-label") || this.textContent || "").trim().substring(0, 60),
                w: r.width, h: r.height,
              };
            }`,
            objectId: object.objectId,
            returnByValue: true,
          }, resolveSession);
          if (!result.exceptionDetails && result.result.value) {
            const val = result.result.value;
            // For OOP iframe elements, transform coordinates to main viewport space
            if (resolveSession !== sessionId) {
              const offset = await getOopIframeOffset(sessionId, uid);
              if (offset) {
                val.x += offset.x;
                val.y += offset.y;
              }
            }
            return val;
          }
        }
      } catch {
        // backendNodeId stale — fall through
      }
    }
    // uid lookup failed — no CSS fallback since we don't set data-cdp-ref anymore
    throw new Error(`Element ref=${uid} not found — the page may have changed since the last snapshot. Take a new snapshot with page tool, action: snapshot.`);
  }

  // CSS selector path (with shadow DOM piercing)
  if (!selector) throw new Error("Provide either 'uid' (from snapshot ref) or 'selector' (CSS).");
  const finder = elementFinderExpr(selector);
  const result = await cdp("Runtime.evaluate", {
    expression: `(() => {
      const el = ${finder};
      if (!el) return { error: "Element not found (" + ${JSON.stringify(selector)} + ")" };
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = el.getBoundingClientRect();
      return {
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        tag: el.tagName.toLowerCase(),
        label: (el.getAttribute("aria-label") || el.textContent || "").trim().substring(0, 60),
        w: r.width, h: r.height,
      };
    })()`,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) throw new Error((result.exceptionDetails.exception?.description || "Element resolution failed") + " — take a new snapshot with page tool, action: snapshot.");
  const v = result.result.value;
  if (v?.error) throw new Error(v.error);
  return v;
}

/** Resolve uid/selector to a remote JS object ID (for callFunctionOn, etc.) */
async function resolveElementObjectId(sessionId, uid, selector) {
  // Primary path: backendNodeId resolution
  if (uid !== undefined && uid !== null) {
    const map = refMaps.get(sessionId);
    const backendNodeId = map?.get(uid);
    if (backendNodeId) {
      const resolveSession = getResolveSession(sessionId, uid);
      try {
        const { object } = await cdp("DOM.resolveNode", { backendNodeId }, resolveSession);
        if (object?.objectId) {
          // Scroll into view
          await cdp("Runtime.callFunctionOn", {
            functionDeclaration: `function() { this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); }`,
            objectId: object.objectId,
          }, resolveSession);
          return { objectId: object.objectId, resolvedSession: resolveSession };
        }
      } catch {
        // backendNodeId stale — fall through
      }
    }
    throw new Error(`Element ref=${uid} not found — the page may have changed since the last snapshot. Take a new snapshot with page tool, action: snapshot.`);
  }

  // CSS selector path (with shadow DOM piercing)
  if (!selector) throw new Error("Provide either 'uid' (from snapshot ref) or 'selector' (CSS).");
  const finder = elementFinderExpr(selector);
  const result = await cdp("Runtime.evaluate", {
    expression: `(() => {
      const el = ${finder};
      if (!el) throw new Error("Element not found (" + ${JSON.stringify(selector)} + ") — provide a valid CSS selector or take a snapshot first.");
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      return el;
    })()`,
    returnByValue: false,
  }, sessionId);
  if (result.exceptionDetails) throw new Error((result.exceptionDetails.exception?.description || "Element resolution failed") + " — take a new snapshot with page tool, action: snapshot.");
  return { objectId: result.result.objectId, resolvedSession: sessionId };
}

// ─── Tool Definitions (9 tools) ─────────────────────────────────────

const TOOLS = [
  // ── 1. tabs ──
  {
    name: "tabs",
    description: [
      "Manage browser tabs: list, search, create, close, activate, and inspect tabs.",
      "",
      "Operations:",
      "- list: List all open browser tabs with their IDs, URLs, and titles",
      "- find: Search tabs by title or URL substring (requires: query)",
      "- new: Open a new tab (optional: url — defaults to about:blank, activate — bring to foreground, default: false, profile — create in specific Chrome profile by name/email/directory)",
      "- close: Close a specific tab (requires: tabId)",
      "- activate: Bring a tab to the foreground (requires: tabId)",
      "- info: Get detailed info about a tab including URL, title, and connection status (requires: tabId)",
    ].join("\n"),
    annotations: {
      title: "Browser Tabs",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "find", "new", "close", "activate", "info"], description: "Tab action to perform." },
        query: { type: "string", description: "Search text for 'find' action." },
        tabId: { type: "string", description: "Tab ID for close/activate/info." },
        url: { type: "string", description: "URL for 'new' action." },
        activate: { type: "boolean", description: "Bring new tab to foreground (default: false — opens in background without stealing focus)." },
        profile: { type: "string", description: "Create tab in a specific Chrome profile (by name, email, or directory e.g. 'Work', 'mansha@gmail.com', 'Profile 7'). Requires the profile to have at least one open tab for context resolution." },
        showAll: { type: "boolean", description: "Show all browser tabs, not just session-owned ones (for list action)." },
        sessionId: { type: "string", description: "Agent session ID for tab ownership and isolation. Tabs are locked to sessions. Default: per-process UUID." },
        cleanupStrategy: { type: "string", enum: ["close", "detach", "none"], description: "Tab cleanup on session expiry. 'detach' (default) keeps tabs open, 'close' removes them, 'none' skips cleanup. Sticky per session." },
        exclusive: { type: "boolean", description: "Lock tab to this session (default: true). Set false to allow shared access." },
      },
      required: ["action"],
    },
  },

  // ── 2. page ──
  {
    name: "page",
    description: [
      "Page-level operations: navigation, accessibility snapshots, screenshots, content extraction, waiting, PDF export, dialog handling, script injection, CSS injection, and CSP bypass.",
      "",
      "Operations:",
      "- goto: Navigate to a URL and wait for page load (requires: tabId, url; optional: waitUntil[load|domcontentloaded|networkidle|commit], timeout)",
      "- back: Navigate back in browser history (requires: tabId; optional: waitUntil, timeout)",
      "- forward: Navigate forward in browser history (requires: tabId; optional: waitUntil, timeout)",
      "- reload: Reload the current page (requires: tabId; optional: ignoreCache, waitUntil, timeout)",
      "- snapshot: Capture accessibility tree snapshot with element refs for interaction (requires: tabId)",
      "- screenshot: Take a screenshot of the page or a specific element (requires: tabId; optional: fullPage, quality, uid, type[png|jpeg], path — absolute file path to save to disk)",
      "- content: Extract text or HTML content from the page or an element (requires: tabId; optional: uid, selector, format[text|html|full] — 'full' returns complete document HTML with doctype)",
      "- set_content: Set the page's HTML content directly (requires: tabId, html)",
      "- wait: Wait for condition or fixed delay (requires: tabId; provide text, textGone, selector for polling — or just timeout for fixed delay; optional: timeout[ms], state[visible|hidden|attached|detached] for selector waits)",
      "- pdf: Export page as PDF to temp file (requires: tabId; optional: landscape, scale, paperWidth, paperHeight, margin{top,bottom,left,right})",
      "- dialog: Handle a pending JavaScript dialog (alert/confirm/prompt) (requires: tabId; optional: accept[default:true], text for prompt response)",
      "- inject: Inject a script that runs on every new document load (requires: tabId, script)",
      "- add_style: Inject CSS into the page — either inline content or an external stylesheet URL (requires: tabId, css or cssUrl; optional: persistent — survives navigation)",
      "- bypass_csp: Enable/disable Content Security Policy bypass (requires: tabId; optional: enabled[default:true])",
      "",
      "Notes:",
      "- Always take a snapshot before interacting with elements — it provides uid refs needed by interact tools",
      "- The snapshot returns an accessibility tree with roles, names, and properties matching ARIA semantics",
      "- Wait actions poll every 300ms up to the timeout (default: 10000ms)",
      "- All timeouts are in MILLISECONDS (e.g. timeout: 3000 = 3 seconds). Use timeout alone for a fixed delay (like Playwright's waitForTimeout).",
      "- Screenshots: pass 'path' (absolute file path) to save to disk instead of inline base64. Use 'type' to control format (png default, jpeg for smaller size).",
    ].join("\n"),
    annotations: {
      title: "Page Operations",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["goto", "back", "forward", "reload", "snapshot", "screenshot", "content", "set_content", "wait", "pdf", "dialog", "inject", "add_style", "bypass_csp", "frames"], description: "Page action." },
        tabId: { type: "string", description: "Tab ID." },
        url: { type: "string", description: "URL for goto." },
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "networkidle", "commit"], description: "When to consider navigation complete (default: load). Matches Playwright conventions." },
        ignoreCache: { type: "boolean", description: "Ignore cache on reload." },
        fullPage: { type: "boolean", description: "Full-page screenshot." },
        quality: { type: "number", description: "JPEG quality 0-100 (automatically sets format to jpeg)." },
        type: { type: "string", enum: ["png", "jpeg"], description: "Image format (default: png). Use jpeg for smaller file size." },
        path: { type: "string", description: "Absolute file path to save screenshot to disk (e.g. 'C:/screenshots/step1.png'). Returns file path instead of base64 image." },
        uid: { type: "number", description: "Element uid for screenshot/content." },
        selector: { type: "string", description: "CSS selector for content/wait." },
        format: { type: "string", enum: ["text", "html", "full"], description: "Content format. 'text' (default) for visible text, 'html' for innerHTML, 'full' for complete document HTML with doctype." },
        text: { type: "string", description: "Text to wait for / dialog prompt text." },
        textGone: { type: "string", description: "Text to wait to disappear." },
        timeout: { type: "number", description: "Timeout in milliseconds. With text/textGone/selector: max polling time (default: 10000ms). Alone: fixed delay like Playwright's waitForTimeout. Max: 60000ms." },
        state: { type: "string", enum: ["visible", "hidden", "attached", "detached"], description: "Element state to wait for when using selector (default: attached). Matches Playwright's locator.waitFor states." },
        accept: { type: "boolean", description: "Accept (true) or dismiss (false) dialog." },
        landscape: { type: "boolean", description: "PDF landscape orientation." },
        scale: { type: "number", description: "PDF scale factor." },
        paperWidth: { type: "number", description: "PDF paper width in inches." },
        paperHeight: { type: "number", description: "PDF paper height in inches." },
        margin: { type: "object", description: "PDF margins {top, bottom, left, right} in inches.", properties: { top: { type: "number" }, bottom: { type: "number" }, left: { type: "number" }, right: { type: "number" } } },
        html: { type: "string", description: "HTML content for set_content action." },
        css: { type: "string", description: "CSS content for add_style action." },
        cssUrl: { type: "string", description: "URL of external stylesheet for add_style action." },
        persistent: { type: "boolean", description: "If true, style persists across page navigations (default: false). For add_style action." },
        script: { type: "string", description: "Script for inject action." },
        enabled: { type: "boolean", description: "Enable/disable for bypass_csp." },
        sessionId: { type: "string", description: "Agent session ID for tab ownership and isolation. Tabs are locked to sessions. Default: per-process UUID." },
        cleanupStrategy: { type: "string", enum: ["close", "detach", "none"], description: "Tab cleanup on session expiry. 'detach' (default) keeps tabs open, 'close' removes them, 'none' skips cleanup. Sticky per session." },
        exclusive: { type: "boolean", description: "Lock tab to this session (default: true). Set false to allow shared access." },
      },
      required: ["action", "tabId"],
    },
  },

  // ── 3. interact ──
  {
    name: "interact",
    description: [
      "Element interaction: click, hover, type text, fill forms, select dropdown options, press keys, drag & drop, scroll, upload files, focus elements, toggle checkboxes, and tap (touch).",
      "",
      "Operations:",
      "- click: Click an element (requires: tabId, uid or selector; optional: button[left|right|middle], clickCount — use 2 for double-click, modifiers[Control|Shift|Alt|Meta], timeout)",
      "- hover: Hover over an element to trigger tooltips or menus (requires: tabId, uid or selector; optional: modifiers[Control|Shift|Alt|Meta], timeout)",
      "- type: Type text into a focused input field (requires: tabId, text, uid or selector; optional: clear[default:true] — clears field first, submit — press Enter after typing, delay — fixed ms between keystrokes, charDelay — base ms between chars with randomized range [base, base*3] default 200ms, wordDelay — base ms between words with randomized range [base, base*3] default 800ms, timeout)",
      "- fill: Fill multiple form fields in one call (requires: tabId, fields — array of {uid or selector, value, type[text|checkbox|radio|select]}; optional: timeout)",
      "- select: Select an option from a <select> dropdown by value or visible text (requires: tabId, value, uid or selector; optional: timeout)",
      "- press: Press a keyboard key with optional modifiers (requires: tabId, key; optional: modifiers[Control|Shift|Alt|Meta])",
      "- drag: Drag an element to another element (requires: tabId, sourceUid or sourceSelector, targetUid or targetSelector; optional: timeout)",
      "- scroll: Scroll the page or a specific element (requires: tabId; optional: direction[up|down|left|right], amount[default:400px], x, y for absolute scroll, uid or selector for scrolling within an element, timeout)",
      "- upload: Upload files to a file input or intercept a file chooser dialog. With uid/selector: sets files directly on a <input type=file>. Without uid/selector: monitors for file chooser dialogs on BOTH the current page AND any popup windows that open (handles Google Drive Picker, Dropbox chooser, etc.) — also auto-detects hidden <input type=file> elements (requires: tabId, files — array of absolute file paths; optional: uid or selector, timeout — default 30s for popup detection)",
      "- focus: Focus an element and scroll it into view (requires: tabId, uid or selector; optional: timeout)",
      "- check: Set a checkbox to checked or unchecked (requires: tabId, checked[true|false], uid or selector; optional: timeout)",
      "- tap: Tap an element using touch events (requires: tabId, uid or selector; optional: timeout)",
      "",
      "Element Resolution: Provide either 'uid' (from a snapshot) or 'selector' (CSS selector). UIDs are preferred — they come from the accessibility snapshot and map to visible, interactive elements.",
      "",
      "Frame interaction: Use 'uid' from snapshots to interact with elements inside iframes — CSS selectors only find top-level elements. Snapshot includes iframe content with [frame N] prefixes.",
      "",
      "Auto-retry: All actions automatically retry element resolution and actionability checks until the element is found+actionable or timeout expires (default: 5000ms). Use 'timeout' to customize.",
      "",
      "Human-like mode: Set humanMode: true for realistic mouse paths (bezier curves, overshoot, jitter). Works with click, hover, drag. Combine with charDelay/wordDelay + typoRate for human typing.",
      "",
      "Auto-snapshot: Set autoSnapshot: true to get a before/after diff appended to the action response \u2014 shows what changed without a separate snapshot call.",
      "",
      "Keys for press: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Space, F1-F12, Insert",
    ].join("\n"),
    annotations: {
      title: "Element Interaction",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["click", "hover", "type", "fill", "select", "press", "drag", "scroll", "upload", "focus", "check", "tap"], description: "Interaction action." },
        tabId: { type: "string", description: "Tab ID." },
        uid: { type: "number", description: "Element uid from snapshot." },
        selector: { type: "string", description: "CSS selector." },
        button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button for click." },
        clickCount: { type: "number", description: "Click count (2 = double-click)." },
        modifiers: { type: "array", items: { type: "string", enum: ["Control", "Shift", "Alt", "Meta"] }, description: "Modifier keys held during click, hover, or press. Matches Playwright naming." },
        text: { type: "string", description: "Text to type." },
        clear: { type: "boolean", description: "Clear field before typing (default: true)." },
        submit: { type: "boolean", description: "Press Enter after typing." },
        fields: { type: "array", description: "Fields for fill: [{uid, selector, value, type}].", items: { type: "object", properties: { uid: { type: "number" }, selector: { type: "string" }, value: { type: "string" }, type: { type: "string", enum: ["text", "checkbox", "radio", "select"] } }, required: ["value"] } },
        value: { type: "string", description: "Value for select action." },
        key: { type: "string", description: "Key for press action." },
        delay: { type: "number", description: "Delay in ms between keystrokes for type action (enables char-by-char typing like Playwright's pressSequentially)." },
        charDelay: { type: "number", description: "Base delay in ms between characters within a word for human-like typing. Actual delay randomized in [charDelay, charDelay*3]. Default 200ms. Activates human-like mode." },
        wordDelay: { type: "number", description: "Base delay in ms between words (spaces/newlines) for human-like typing. Actual delay randomized in [wordDelay, wordDelay*3]. Default 800ms." },
        sourceUid: { type: "number", description: "Drag source uid." },
        sourceSelector: { type: "string", description: "Drag source selector." },
        targetUid: { type: "number", description: "Drag target uid." },
        targetSelector: { type: "string", description: "Drag target selector." },
        direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction." },
        amount: { type: "number", description: "Scroll pixels (default: 400)." },
        x: { type: "number", description: "Scroll-to X position." },
        y: { type: "number", description: "Scroll-to Y position." },
        files: { type: "array", items: { type: "string" }, description: "File paths for upload." },
        checked: { type: "boolean", description: "Desired checked state for check action." },
        timeout: { type: "number", description: "Retry timeout in ms for element resolution and actionability (default: 5000ms). Element is polled until found+actionable or timeout." },
        humanMode: { type: "boolean", description: "Enable human-like interaction: bezier curve mouse paths with overshoot and jitter for click/hover/drag. Combine with typoRate for typing." },
        autoSnapshot: { type: "boolean", description: "Take accessibility snapshots before and after the action, return a diff of changes. Shows what changed without a separate snapshot call." },
        typoRate: { type: "number", description: "Probability of typing a wrong character then correcting (0-1, e.g. 0.03 = 3% per char). Requires charDelay or wordDelay to be set." },
        sessionId: { type: "string", description: "Agent session ID for tab ownership and isolation. Tabs are locked to sessions. Default: per-process UUID." },
        cleanupStrategy: { type: "string", enum: ["close", "detach", "none"], description: "Tab cleanup on session expiry. 'detach' (default) keeps tabs open, 'close' removes them, 'none' skips cleanup. Sticky per session." },
        exclusive: { type: "boolean", description: "Lock tab to this session (default: true). Set false to allow shared access." },
      },
      required: ["action", "tabId"],
    },
  },

  // ── 4. execute ──
  {
    name: "execute",
    description: [
      "Execute JavaScript code on the page in three modes: inline expression evaluation, async script execution, and calling a function on a specific element.",
      "",
      "Operations:",
      "- eval: Evaluate a JavaScript expression and return its value (requires: tabId, expression)",
      "- script: Execute an async function body wrapped in an IIFE — use for multi-step JS logic (requires: tabId, code)",
      "- call: Call a JavaScript function with a specific page element as its argument (requires: tabId, function — e.g. '(el) => el.textContent', uid or selector)",
      "",
      "Notes:",
      "- eval returns the expression's value directly (must be JSON-serializable)",
      "- script wraps your code in: (async () => { <your code> })() — use 'return' to send a value back",
      "- call resolves the element first, then passes it as the first argument to your function",
    ].join("\n"),
    annotations: {
      title: "Execute JavaScript",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["eval", "script", "call"], description: "Execution mode." },
        tabId: { type: "string", description: "Tab ID." },
        expression: { type: "string", description: "JS expression for eval." },
        code: { type: "string", description: "JS function body for script (wrapped in async IIFE)." },
        function: { type: "string", description: "JS function for call, receives element as arg. E.g. '(el) => el.textContent'" },
        uid: { type: "number", description: "Element uid for call." },
        selector: { type: "string", description: "CSS selector for call." },
        sessionId: { type: "string", description: "Agent session ID for tab ownership and isolation. Tabs are locked to sessions. Default: per-process UUID." },
        cleanupStrategy: { type: "string", enum: ["close", "detach", "none"], description: "Tab cleanup on session expiry. 'detach' (default) keeps tabs open, 'close' removes them, 'none' skips cleanup. Sticky per session." },
        exclusive: { type: "boolean", description: "Lock tab to this session (default: true). Set false to allow shared access." },
      },
      required: ["action", "tabId"],
    },
  },

  // ── 5. observe ──
  {
    name: "observe",
    description: [
      "Monitor browser console messages, network requests, retrieve full request/response bodies, measure page performance metrics, and export HAR.",
      "",
      "Operations:",
      "- console: Retrieve captured console messages (requires: tabId; optional: level[all|error|warning|log|info|debug], last — return only last N entries, clear — clear after returning)",
      "- network: List captured network requests with URLs, methods, status codes, and timing (requires: tabId; optional: filter — URL substring, types — resource type filter array, last, clear)",
      "- request: Get the full request and response body for a specific network request (requires: tabId, requestId — from network listing)",
      "- performance: Collect page performance metrics including DOM size, JS heap, layout counts, and paint timing (requires: tabId)",
      "- downloads: List tracked file downloads with progress info (requires: tabId; optional: last, clear)",
      "- har: Export captured network requests as HAR 1.2 JSON (requires: tabId)",
      "",
      "Network Resource Types: xhr, fetch, document, script, stylesheet, image, font, media, websocket, other",
      "",
      "Notes:",
      "- Console and network monitoring starts automatically when first queried — no explicit enable needed",
      "- Popups/new windows opened by pages are auto-detected and logged to the opener tab's console as [popup] entries",
      "- Use 'clear: true' to reset captured data between test iterations",
    ].join("\n"),
    annotations: {
      title: "Observe Browser",
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["console", "network", "request", "performance", "downloads", "har"], description: "Observe action." },
        tabId: { type: "string", description: "Tab ID." },
        level: { type: "string", enum: ["all", "error", "warning", "log", "info", "debug"], description: "Console level filter." },
        filter: { type: "string", description: "Network URL filter." },
        types: { type: "array", items: { type: "string" }, description: "Network resource types filter: xhr, fetch, document, script, stylesheet, image, font, media, websocket, other." },
        clear: { type: "boolean", description: "Clear captured data after returning." },
        last: { type: "number", description: "Return only last N items." },
        requestId: { type: "string", description: "Request ID for full body retrieval." },
        sessionId: { type: "string", description: "Agent session ID for tab ownership and isolation. Tabs are locked to sessions. Default: per-process UUID." },
        cleanupStrategy: { type: "string", enum: ["close", "detach", "none"], description: "Tab cleanup on session expiry. 'detach' (default) keeps tabs open, 'close' removes them, 'none' skips cleanup. Sticky per session." },
        exclusive: { type: "boolean", description: "Lock tab to this session (default: true). Set false to allow shared access." },
      },
      required: ["action", "tabId"],
    },
  },

  // ── 6. emulate ──
  {
    name: "emulate",
    description: [
      "Emulate device characteristics and network conditions: viewport size, color scheme, user agent, geolocation, CPU throttle, timezone, locale, vision deficiency simulation, network throttling, SSL bypass, URL blocking, and custom headers. Pass 'reset: true' to clear all overrides.",
      "",
      "Operations (set any combination of properties in a single call):",
      "- viewport: Set viewport dimensions (optional: {width, height, deviceScaleFactor, mobile, touch, landscape})",
      "- colorScheme: Emulate preferred color scheme (optional: dark|light|auto)",
      "- userAgent: Override the browser user agent string (optional: string)",
      "- geolocation: Spoof geolocation (optional: {latitude, longitude, accuracy, altitude})",
      "- cpuThrottle: Throttle CPU speed — 1 = normal, 4 = 4x slower (optional: number)",
      "- timezone: Override timezone (optional: string, e.g. 'America/New_York')",
      "- locale: Override locale (optional: string, e.g. 'fr-FR')",
      "- visionDeficiency: Simulate vision impairment (optional: none|protanopia|deuteranopia|tritanopia|achromatopsia|blurredVision)",
      "- autoDarkMode: Force automatic dark mode (optional: boolean)",
      "- idle: Emulate idle/locked screen state (optional: active|locked)",
      "- networkCondition: Throttle network speed (optional: offline|slow3g|fast3g|slow4g|fast4g|none)",
      "- ignoreSSL: Bypass SSL certificate errors (optional: boolean)",
      "- blockUrls: Block requests matching URL patterns (optional: string array)",
      "- extraHeaders: Set extra HTTP headers on all requests (optional: object)",
      "- reset: Clear ALL emulation overrides (optional: true)",
      "",
      "Network Presets: offline (no connection), slow3g (2s latency, 50KB/s), fast3g (562ms, 180KB/s), slow4g (150ms, 400KB/s), fast4g (50ms, 1.5MB/s), none (remove throttling)",
    ].join("\n"),
    annotations: {
      title: "Device Emulation",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab ID." },
        viewport: { type: "object", description: "Viewport {width, height, deviceScaleFactor, mobile, touch, landscape}.", properties: { width: { type: "number" }, height: { type: "number" }, deviceScaleFactor: { type: "number" }, mobile: { type: "boolean" }, touch: { type: "boolean" }, landscape: { type: "boolean" } } },
        colorScheme: { type: "string", enum: ["dark", "light", "auto"], description: "Color scheme." },
        userAgent: { type: "string", description: "User agent string." },
        geolocation: { type: "object", properties: { latitude: { type: "number" }, longitude: { type: "number" }, accuracy: { type: "number", description: "GPS accuracy in meters (default: 100)." }, altitude: { type: "number", description: "Altitude in meters (optional)." } }, description: "Spoof geolocation: {latitude, longitude, accuracy?, altitude?}." },
        cpuThrottle: { type: "number", description: "CPU throttle rate (1 = normal)." },
        timezone: { type: "string", description: "Timezone, e.g. 'America/New_York'." },
        locale: { type: "string", description: "Locale, e.g. 'fr-FR'." },
        visionDeficiency: { type: "string", enum: ["none", "protanopia", "deuteranopia", "tritanopia", "achromatopsia", "blurredVision"], description: "Vision deficiency simulation." },
        autoDarkMode: { type: "boolean", description: "Auto dark mode." },
        idle: { type: "string", enum: ["active", "locked"], description: "Idle state." },
        networkCondition: { type: "string", enum: ["offline", "slow3g", "fast3g", "slow4g", "fast4g", "none"], description: "Network throttle preset." },
        ignoreSSL: { type: "boolean", description: "Ignore SSL certificate errors." },
        blockUrls: { type: "array", items: { type: "string" }, description: "URLs to block." },
        extraHeaders: { type: "object", description: "Extra HTTP headers." },
        reset: { type: "boolean", description: "Reset all emulation overrides." },
        sessionId: { type: "string", description: "Agent session ID for tab ownership and isolation. Tabs are locked to sessions. Default: per-process UUID." },
        cleanupStrategy: { type: "string", enum: ["close", "detach", "none"], description: "Tab cleanup on session expiry. 'detach' (default) keeps tabs open, 'close' removes them, 'none' skips cleanup. Sticky per session." },
        exclusive: { type: "boolean", description: "Lock tab to this session (default: true). Set false to allow shared access." },
      },
      required: ["tabId"],
    },
  },

  // ── 7. storage ──
  {
    name: "storage",
    description: [
      "Cookie and storage management: get, set, and delete cookies, clear browser storage, and check storage quota.",
      "",
      "Operations:",
      "- get_cookies: Retrieve cookies (requires: tabId; optional: urls — filter by URLs)",
      "- set_cookie: Set a cookie (requires: tabId, name, value; optional: domain, path, secure, httpOnly, sameSite[None|Lax|Strict], expires — epoch seconds)",
      "- delete_cookies: Delete specific cookies by name (requires: tabId, name; optional: url, domain, path)",
      "- clear_cookies: Clear all cookies for the browser profile (requires: tabId)",
      "- clear_data: Clear browser storage for an origin (requires: tabId; optional: origin, types — comma-separated: 'cookies,local_storage,indexeddb,cache_storage' or 'all')",
      "- quota: Check storage quota usage for the current page's origin (requires: tabId)",
    ].join("\n"),
    annotations: {
      title: "Cookie & Storage",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get_cookies", "set_cookie", "delete_cookies", "clear_cookies", "clear_data", "quota"], description: "Storage action." },
        tabId: { type: "string", description: "Tab ID." },
        urls: { type: "array", items: { type: "string" }, description: "URLs for get_cookies." },
        name: { type: "string", description: "Cookie name." },
        value: { type: "string", description: "Cookie value." },
        domain: { type: "string", description: "Cookie domain." },
        path: { type: "string", description: "Cookie path." },
        secure: { type: "boolean", description: "Secure flag." },
        httpOnly: { type: "boolean", description: "HttpOnly flag." },
        sameSite: { type: "string", enum: ["None", "Lax", "Strict"], description: "SameSite attribute." },
        expires: { type: "number", description: "Expiry as epoch seconds." },
        url: { type: "string", description: "URL for delete_cookies." },
        origin: { type: "string", description: "Origin for clear_data." },
        types: { type: "string", description: "Storage types: 'cookies,local_storage,indexeddb,cache_storage' or 'all'." },
        sessionId: { type: "string", description: "Agent session ID for tab ownership and isolation. Tabs are locked to sessions. Default: per-process UUID." },
        cleanupStrategy: { type: "string", enum: ["close", "detach", "none"], description: "Tab cleanup on session expiry. 'detach' (default) keeps tabs open, 'close' removes them, 'none' skips cleanup. Sticky per session." },
        exclusive: { type: "boolean", description: "Lock tab to this session (default: true). Set false to allow shared access." },
      },
      required: ["action", "tabId"],
    },
  },

  // ── 8. intercept ──
  {
    name: "intercept",
    description: [
      "HTTP request interception via CDP Fetch domain. Intercept, modify, mock, or block network requests in real-time.",
      "",
      "Operations:",
      "- enable: Start intercepting requests matching URL patterns (requires: tabId; optional: patterns — array of URL glob patterns, e.g. ['*.api.example.com/*'])",
      "- disable: Stop all request interception (requires: tabId)",
      "- continue: Resume a paused request, optionally modifying it (requires: tabId, requestId; optional: url, method, headers, postData)",
      "- fulfill: Respond to a paused request with a custom/mocked response (requires: tabId, requestId; optional: status, body, headers)",
      "- fail: Abort a paused request with a network error (requires: tabId, requestId; optional: reason)",
      "- list: List all currently paused/intercepted requests (requires: tabId)",
      "",
      "Failure Reasons: Failed, Aborted, TimedOut, AccessDenied, ConnectionClosed, ConnectionReset, ConnectionRefused, ConnectionAborted, ConnectionFailed, NameNotResolved, InternetDisconnected, AddressUnreachable, BlockedByClient, BlockedByResponse",
      "",
      "Notes:",
      "- Call 'enable' first with URL patterns to start intercepting",
      "- Intercepted requests are paused until you call continue, fulfill, or fail",
      "- Each intercepted request has a unique requestId shown in the 'list' output",
    ].join("\n"),
    annotations: {
      title: "Request Intercept",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["enable", "disable", "continue", "fulfill", "fail", "list"], description: "Intercept action." },
        tabId: { type: "string", description: "Tab ID." },
        patterns: { type: "array", items: { type: "string" }, description: "URL patterns to intercept, e.g. ['*.api.example.com/*']." },
        requestId: { type: "string", description: "Paused request ID." },
        url: { type: "string", description: "Override URL for continue." },
        method: { type: "string", description: "Override method for continue." },
        headers: { type: "object", description: "Override headers for continue/fulfill." },
        postData: { type: "string", description: "Override body for continue." },
        status: { type: "number", description: "Response status for fulfill." },
        body: { type: "string", description: "Response body for fulfill." },
        reason: { type: "string", enum: ["Failed", "Aborted", "TimedOut", "AccessDenied", "ConnectionClosed", "ConnectionReset", "ConnectionRefused", "ConnectionAborted", "ConnectionFailed", "NameNotResolved", "InternetDisconnected", "AddressUnreachable", "BlockedByClient", "BlockedByResponse"], description: "Failure reason." },
        sessionId: { type: "string", description: "Agent session ID for tab ownership and isolation. Tabs are locked to sessions. Default: per-process UUID." },
        cleanupStrategy: { type: "string", enum: ["close", "detach", "none"], description: "Tab cleanup on session expiry. 'detach' (default) keeps tabs open, 'close' removes them, 'none' skips cleanup. Sticky per session." },
        exclusive: { type: "boolean", description: "Lock tab to this session (default: true). Set false to allow shared access." },
      },
      required: ["action", "tabId"],
    },
  },

  // ── 9. cleanup ──
  {
    name: "cleanup",
    description: [
      "Disconnect browser sessions, clean up temporary files, and manage agent sessions.",
      "",
      "Operations:",
      "- disconnect_tab: Disconnect from a specific tab session without closing the tab (requires: tabId)",
      "- disconnect_all: Disconnect all active tab sessions owned by this session (no parameters)",
      "- clean_temp: Delete temporary files (screenshots, PDFs, response dumps) created by this session. Unprefixed legacy files are also cleaned. (no parameters)",
      "- status: Show current server status — active sessions, temp file count, connection state (no parameters)",
      "- list_sessions: List all active agent sessions with their TTL, idle time, cleanup strategy, and associated tabs (no parameters)",
      "- session: Explicitly end this agent session and clean up its owned tabs (optional: cleanupStrategy)",
      "- reset: Terminate ALL sessions and release all tab locks. Created tabs can optionally be closed (closeTabs: true), but pre-existing browser tabs are always preserved (optional: closeTabs)",
      "",
      "Session params (all tools): sessionId — agent session ID for tab ownership/isolation; cleanupStrategy — close|detach|none for tab cleanup on expiry (default: detach); exclusive — lock tabs to session (default: true)",
    ].join("\n"),
    annotations: {
      title: "Session Cleanup",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["disconnect_tab", "disconnect_all", "clean_temp", "status", "list_sessions", "session", "reset"], description: "Cleanup action." },
        tabId: { type: "string", description: "Tab ID for disconnect_tab." },
        closeTabs: { type: "boolean", description: "For reset: close tabs created by sessions (default: false). Pre-existing claimed tabs are NEVER closed." },
        sessionId: { type: "string", description: "Agent session ID for tab ownership and isolation. Tabs are locked to sessions. Default: per-process UUID." },
        cleanupStrategy: { type: "string", enum: ["close", "detach", "none"], description: "Tab cleanup on session expiry. 'detach' (default) keeps tabs open, 'close' removes them from browser, 'none' skips cleanup. Sticky per session." },
        exclusive: { type: "boolean", description: "Lock tab to this session (default: true). Set false to allow shared access." },
      },
      required: ["action"],
    },
  },

  // ── 10. browser ──
  {
    name: "browser",
    description: [
      "Browser instance and profile management. Detect running Chromium-based browsers (Chrome, Edge, Brave, etc.), switch connections, and view profile information.",
      "",
      "Operations:",
      "- profiles: List all detected browser instances with their profiles, ports, and connection status (no parameters)",
      "- connect: Switch to a different browser instance by name, port, or User Data directory path (requires: instance — name like 'Chrome', 'Edge', or 'Brave', or port number, or path to User Data dir)",
      "- active: Show the currently connected browser instance, port, profiles, and WebSocket URL (no parameters)",
      "",
      "Notes:",
      "- All Chromium-based browsers use the same CDP protocol — Chrome, Edge, Brave, Chromium all work",
      "- All profiles within one browser instance share a single debug port — you cannot connect to a specific profile, only to an instance",
      "- Each profile's tabs are distinguishable via browserContextId in tab info",
      "- Switching instances requires no other active agent sessions (use cleanup.session to end them first)",
      "- Set CDP_PROFILE env var to auto-connect to a specific User Data directory at startup",
    ].join("\n"),
    annotations: {
      title: "Browser Instance",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["profiles", "connect", "active"], description: "Browser action." },
        instance: { type: "string", description: "Browser instance to connect to — name (e.g. 'Chrome', 'Edge', 'Brave'), port number, or User Data directory path." },
      },
      required: ["action"],
    },
  },

  // ── 11. debug ──
  {
    name: "debug",
    description: [
      "JavaScript debugger, resource overrides, and DOM/event breakpoints. Uses CDP Debugger and DOMDebugger domains.",
      "",
      "Debugger operations:",
      "- enable: Enable JavaScript debugger for a tab — starts tracking scripts and allows breakpoints (requires: tabId)",
      "- disable: Disable the debugger for a tab (requires: tabId)",
      "- set_breakpoint: Set a breakpoint by URL pattern + line number (requires: tabId, url, lineNumber; optional: columnNumber, condition)",
      "- remove_breakpoint: Remove a breakpoint by ID (requires: tabId, breakpointId)",
      "- list_breakpoints: List all active breakpoints for a tab (requires: tabId)",
      "- pause: Pause JavaScript execution immediately (requires: tabId)",
      "- resume: Resume execution after a pause (requires: tabId)",
      "- step_over: Step over the current statement (requires: tabId)",
      "- step_into: Step into the next function call (requires: tabId)",
      "- step_out: Step out of the current function (requires: tabId)",
      "- call_stack: Get the current call stack with scope variables when paused (requires: tabId)",
      "- evaluate_on_frame: Evaluate an expression in a specific call frame (requires: tabId, expression; optional: frameIndex — default 0, top frame)",
      "- list_scripts: List all loaded scripts tracked by the debugger (requires: tabId)",
      "- get_source: Get the source code of a script by ID (requires: tabId, scriptId)",
      "",
      "Resource override operations:",
      "- override_resource: Pre-register a URL pattern + replacement response body. Pattern is a JS regex matched against response URLs. Matching responses are fulfilled automatically — no LLM round-trip (requires: tabId, urlPattern; optional: body, responseCode, headers)",
      "- remove_override: Remove a resource override by URL pattern (requires: tabId, urlPattern)",
      "- list_overrides: List all active resource overrides (requires: tabId)",
      "",
      "DOM/Event breakpoint operations:",
      "- set_dom_breakpoint: Break when a DOM node is modified (requires: tabId, uid, type — 'subtree-modified', 'attribute-modified', or 'node-removed')",
      "- remove_dom_breakpoint: Remove a DOM breakpoint (requires: tabId, uid, type)",
      "- set_event_breakpoint: Break on a specific event type like 'click', 'xhr', 'setTimeout' (requires: tabId, eventName)",
      "- remove_event_breakpoint: Remove an event breakpoint (requires: tabId, eventName)",
      "",
      "Notes:",
      "- Call 'enable' before setting breakpoints or listing scripts",
      "- When debugger pauses, ALL other tool calls on that tab are blocked until you resume/step",
      "- Auto-resume fires after 30s (CDP_DEBUGGER_TIMEOUT) to prevent permanently frozen tabs",
      "- Resource overrides work independently of the debugger — no need to call 'enable' first",
      "- Resource overrides coexist with request interception (intercept tool). Both can be active simultaneously",
      "- Performance: while overrides are active, ALL responses are routed through the handler for regex matching. Remove overrides when done to avoid unnecessary overhead on resource-heavy pages",
      "",
      "Session params (all tools): sessionId, cleanupStrategy, exclusive",
    ].join("\n"),
    annotations: {
      title: "Debug & Override",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "enable", "disable",
            "set_breakpoint", "remove_breakpoint", "list_breakpoints",
            "pause", "resume", "step_over", "step_into", "step_out",
            "call_stack", "evaluate_on_frame",
            "list_scripts", "get_source",
            "override_resource", "remove_override", "list_overrides",
            "set_dom_breakpoint", "remove_dom_breakpoint",
            "set_event_breakpoint", "remove_event_breakpoint",
          ],
          description: "Debug action.",
        },
        tabId: { type: "string", description: "Tab ID." },
        url: { type: "string", description: "URL pattern for set_breakpoint (matched by prefix)." },
        lineNumber: { type: "number", description: "Line number for set_breakpoint (0-based)." },
        columnNumber: { type: "number", description: "Column number for set_breakpoint (0-based, optional)." },
        condition: { type: "string", description: "Conditional breakpoint expression — break only when this evaluates to true." },
        breakpointId: { type: "string", description: "Breakpoint ID for remove_breakpoint." },
        expression: { type: "string", description: "JS expression for evaluate_on_frame." },
        frameIndex: { type: "number", description: "Call frame index for evaluate_on_frame (default: 0 = top frame)." },
        scriptId: { type: "string", description: "Script ID for get_source." },
        urlPattern: { type: "string", description: "URL regex pattern for override_resource / remove_override (JS regex syntax, e.g. 'example\\\\.com/api/.*')." },
        body: { type: "string", description: "Response body for override_resource." },
        responseCode: { type: "number", description: "HTTP status code for override_resource (default: 200)." },
        headers: { type: "object", description: "Response headers for override_resource (object of name→value)." },
        uid: { type: "number", description: "Element ref for set_dom_breakpoint / remove_dom_breakpoint." },
        type: { type: "string", enum: ["subtree-modified", "attribute-modified", "node-removed"], description: "DOM breakpoint type." },
        eventName: { type: "string", description: "Event name for set_event_breakpoint (e.g. 'click', 'xhr', 'setTimeout')." },
        sessionId: { type: "string", description: "Agent session ID for tab ownership and isolation." },
        cleanupStrategy: { type: "string", enum: ["close", "detach", "none"], description: "Tab cleanup on session expiry." },
        exclusive: { type: "boolean", description: "Lock tab to this session (default: true)." },
      },
      required: ["action", "tabId"],
    },
  },
];

// ═══════════════════════════════════════════════════════════════════
//  HANDLER IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════

// ─── Tabs Handlers ──────────────────────────────────────────────────

async function handleTabsList(args) {
  const tabs = await getTabs();
  if (!tabs.length) return ok("No open tabs found.");
  const lines = tabs.map((t, i) => {
    const c = activeSessions.has(t.targetId) ? " [connected]" : "";
    const lockOwner = tabLocks.get(t.targetId);
    const lockTag = lockOwner?.sessionId && lockOwner.sessionId !== args._agentSessionId ? ` [locked by: ${lockOwner.sessionId.substring(0, 8)}…]` : "";
    return `${i + 1}. [${t.targetId}]${c}${lockTag}\n   ${t.title}\n   ${t.url}`;
  });
  return ok(`${tabs.length} tab(s):\n\n${lines.join("\n\n")}`);
}

async function handleTabsFind(args) {
  if (!args.query) return fail("Provide 'query' to search tabs.");
  const q = args.query.toLowerCase();
  const tabs = await getTabs();
  const hits = tabs.filter(t => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q));
  if (!hits.length) return ok(`No tabs matching "${args.query}".`);
  const lines = hits.map(t => {
    const c = activeSessions.has(t.targetId) ? " [connected]" : "";
    const lockOwner = tabLocks.get(t.targetId);
    const lockTag = lockOwner?.sessionId && lockOwner.sessionId !== args._agentSessionId ? ` [locked by: ${lockOwner.sessionId.substring(0, 8)}…]` : "";
    return `[${t.targetId}]${c}${lockTag} ${t.title}\n   ${t.url}`;
  });
  return ok(`${hits.length} match(es):\n\n${lines.join("\n\n")}`);
}

async function handleTabsNew(args) {
  const url = args.url || "about:blank";
  const background = args.activate === false || args.activate === undefined; // default: open in background
  const createParams = { url, background };
  // Profile-sticky sessions: use session's pinned profile if no explicit profile given
  if (args.profile) {
    // Explicit profile requested — resolve it
    const resolved = await resolveProfileContext(args.profile);
    if (!resolved) return fail(`Profile "${args.profile}" not found or has no open tabs. Use browser.active to see available profiles and their contexts.`);
    createParams.browserContextId = resolved.browserContextId;
  } else if (args._agentSession?.browserContextId) {
    // AUTO: use session's pinned profile (prevents profile drift when user switches)
    createParams.browserContextId = args._agentSession.browserContextId;
  }
  const { targetId } = await cdp("Target.createTarget", createParams);
  // Register ownership immediately so tabs.list shows it right away
  if (args._agentSession) {
    args._agentSession.tabIds.add(targetId);
    tabLocks.set(targetId, { sessionId: args._agentSessionId, origin: "created" });
  }
  // Pin profile to session if not already pinned
  if (args._agentSession && !args._agentSession.browserContextId) {
    try {
      const tabs = await getTabs();
      const newTab = tabs.find(t => t.targetId === targetId);
      if (newTab?.browserContextId) args._agentSession.browserContextId = newTab.browserContextId;
    } catch { /* best-effort */ }
  }
  return ok(`New tab: [${targetId}]\nURL: ${url}${background ? '' : ' (activated)'}`);
}

async function handleTabsClose(args) {
  if (!args.tabId) return fail("Provide 'tabId' to close.");
  // Guard: only allow closing tabs this session owns or unowned tabs
  const lockOwner = tabLocks.get(args.tabId);
  if (lockOwner?.sessionId && lockOwner.sessionId !== args._agentSessionId) {
    return fail(`Tab [${args.tabId}] is locked by another session. Cannot close.`);
  }
  await detachTab(args.tabId);
  await cdp("Target.closeTarget", { targetId: args.tabId });
  return ok("Tab closed.");
}

async function handleTabsActivate(args) {
  if (!args.tabId) return fail("Provide 'tabId' to activate.");
  await cdp("Target.activateTarget", { targetId: args.tabId });
  return ok("Tab activated (brought to foreground).");
}

async function handleTabsInfo(args) {
  if (!args.tabId) return fail("Provide 'tabId'.");
  const tabs = await getTabs();
  const tab = tabs.find(t => t.targetId === args.tabId);
  if (!tab) return fail("Tab not found.");
  const connected = activeSessions.has(args.tabId);
  const sid = activeSessions.get(args.tabId);
  const consoleCount = sid ? (consoleLogs.get(sid)?.length || 0) : 0;
  const netCount = sid ? (networkReqs.get(sid)?.size || 0) : 0;
  const contextId = tab.browserContextId ? `\nProfile context: ${tab.browserContextId}` : "";
  return ok(
    `Tab: ${tab.title}\nURL: ${tab.url}\nID: ${tab.targetId}` +
    contextId +
    `\nSession: ${connected ? "active" : "not connected"}\n` +
    `Console: ${consoleCount} messages | Network: ${netCount} requests`
  );
}

// ─── Page Handlers ──────────────────────────────────────────────────

async function handlePageGoto(args) {
  if (!args.url) return fail("Provide 'url' for navigation.");
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Page");
  const result = await cdp("Page.navigate", { url: args.url }, sess);
  if (result.errorText) return fail(`Navigation failed: ${result.errorText}`);
  const waitUntil = args.waitUntil || "load";
  if (waitUntil === "commit") {
    // Navigation already committed at this point
    const title = await cdp("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sess);
    return ok(`Navigated to: ${args.url}\nTitle: ${title.result.value}`);
  }
  const navTimeout = args.timeout || 30000;
  await waitForReadyState(sess, waitUntil, navTimeout);
  const title = await cdp("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sess);
  return ok(`Navigated to: ${args.url}\nTitle: ${title.result.value}`);
}

async function handlePageBack(args) {
  const sess = await getTabSession(args.tabId);
  const { currentIndex, entries } = await cdp("Page.getNavigationHistory", {}, sess);
  if (currentIndex > 0) {
    await cdp("Page.navigateToHistoryEntry", { entryId: entries[currentIndex - 1].id }, sess);
    const waitUntil = args.waitUntil || "load";
    const navTimeout = args.timeout || 15000;
    if (waitUntil !== "commit") await waitForReadyState(sess, waitUntil, navTimeout);
    else await sleep(300);
    const r = await cdp("Runtime.evaluate", { expression: "document.title + ' — ' + location.href", returnByValue: true }, sess);
    return ok(`Navigated back → ${r.result.value}`);
  }
  return ok("Already at the beginning of history.");
}

async function handlePageForward(args) {
  const sess = await getTabSession(args.tabId);
  const { currentIndex, entries } = await cdp("Page.getNavigationHistory", {}, sess);
  if (currentIndex < entries.length - 1) {
    await cdp("Page.navigateToHistoryEntry", { entryId: entries[currentIndex + 1].id }, sess);
    const waitUntil = args.waitUntil || "load";
    const navTimeout = args.timeout || 15000;
    if (waitUntil !== "commit") await waitForReadyState(sess, waitUntil, navTimeout);
    else await sleep(300);
    const r = await cdp("Runtime.evaluate", { expression: "document.title + ' — ' + location.href", returnByValue: true }, sess);
    return ok(`Navigated forward → ${r.result.value}`);
  }
  return ok("Already at the end of history.");
}

async function handlePageReload(args) {
  const sess = await getTabSession(args.tabId);
  await cdp("Page.reload", { ignoreCache: args.ignoreCache || false }, sess);
  const waitUntil = args.waitUntil || "load";
  const navTimeout = args.timeout || 15000;
  if (waitUntil !== "commit") await waitForReadyState(sess, waitUntil, navTimeout);
  else await sleep(300);
  return ok("Page reloaded.");
}

async function handlePageFrames(args) {
  const sess = await getTabSession(args.tabId);
  const frames = [];

  // Same-origin frames from Page.getFrameTree
  try {
    await ensureDomain(sess, "Page");
    const { frameTree } = await cdp("Page.getFrameTree", {}, sess);
    let idx = 0;
    function collectFrames(tree, depth) {
      frames.push({
        index: idx++,
        id: tree.frame.id,
        url: tree.frame.url,
        securityOrigin: tree.frame.securityOrigin || "",
        type: depth === 0 ? "main" : "same-origin",
        depth,
      });
      if (tree.childFrames) {
        for (const child of tree.childFrames) collectFrames(child, depth + 1);
      }
    }
    collectFrames(frameTree, 0);
  } catch {}

  // OOP (cross-origin) frames from auto-attached child sessions
  const oopFrames = oopFrameSessions.get(sess);
  if (oopFrames?.size > 0) {
    let oopIdx = frames.length;
    for (const [targetId, { sessionId: childSess, url }] of oopFrames) {
      frames.push({
        index: oopIdx++,
        id: targetId,
        url,
        securityOrigin: "",
        type: "cross-origin (OOP)",
        depth: 1,
        sessionId: childSess,
      });
    }
  }

  if (frames.length === 0) return ok("No frames found.");
  const lines = frames.map(f =>
    `[frame ${f.index}] ${f.type} | ${f.url.substring(0, 120)}${f.type === "cross-origin (OOP)" ? " (auto-attached)" : ""}`
  );
  return ok(`${frames.length} frame(s):\n\n${lines.join("\n")}`);
}

async function handlePageSnapshot(args) {
  const sess = await getTabSession(args.tabId);
  const snap = await buildSnapshot(sess);
  const header = `Page: ${snap.title}\nURL: ${snap.url}\nElements: ${snap.count}\n\n`;

  // Compute incremental diff if previous snapshot exists
  const prev = lastSnapshots.get(sess);
  lastSnapshots.set(sess, { snapshot: snap.snapshot, url: snap.url, title: snap.title });

  let fullText;
  if (prev && prev.url === snap.url) {
    const prevLines = prev.snapshot.split("\n");
    const currLines = snap.snapshot.split("\n");
    const diff = computeSnapshotDiff(prevLines, currLines);
    if (diff.changed && diff.lines.length < currLines.length * 0.8) {
      fullText = header +
        `### Changes (${diff.added} added, ${diff.removed} removed)\n` +
        diff.lines.join("\n") +
        `\n\n### Full Snapshot\n` +
        snap.snapshot;
    }
  }
  if (!fullText) fullText = header + snap.snapshot;

  // If snapshot overflows, auto-capture a screenshot for visual context
  if (fullText.length > MAX_INLINE_LEN) {
    try {
      const { data } = await cdp("Page.captureScreenshot", { format: "jpeg", quality: 60 }, sess);
      const screenshotPath = writeTempFile(`snapshot-overflow-${Date.now()}.jpg`, Buffer.from(data, "base64"), null, args._agentSessionId);
      fullText += `\n\n[Screenshot saved for visual context: ${screenshotPath}]`;
    } catch { /* screenshot failed — don't break the snapshot */ }
  }

  return ok(fullText);
}

/** Compute a simple line-level diff between two snapshots */
function computeSnapshotDiff(prevLines, currLines) {
  const prevSet = new Set(prevLines);
  const currSet = new Set(currLines);
  const lines = [];
  let added = 0, removed = 0;

  for (const line of currLines) {
    if (!prevSet.has(line)) {
      lines.push("+ " + line);
      added++;
    }
  }
  for (const line of prevLines) {
    if (!currSet.has(line)) {
      lines.push("- " + line);
      removed++;
    }
  }

  return { changed: added > 0 || removed > 0, lines, added, removed };
}

async function handlePageScreenshot(args) {
  const sess = await getTabSession(args.tabId);
  const params = {};
  // Format: explicit type > quality implies jpeg > default png
  if (args.quality !== undefined) {
    params.format = "jpeg";
    params.quality = args.quality;
  } else if (args.type === "jpeg") {
    params.format = "jpeg";
    params.quality = 80;
  } else {
    params.format = args.type || "png";
  }

  // Element-level screenshot via uid
  if (args.uid !== undefined) {
    const el = await resolveElement(sess, args.uid);
    const r = el;
    params.clip = { x: r.x - r.w / 2, y: r.y - r.h / 2, width: r.w, height: r.h, scale: 1 };
  } else if (args.fullPage) {
    // Full-page screenshot: scroll to trigger lazy loading, expand SPA containers,
    // resize viewport to full content, capture, then restore everything.
    await ensureDomain(sess, "Page");
    const m = await cdp("Page.getLayoutMetrics", {}, sess);
    let { width, height } = m.cssContentSize || m.contentSize;
    const viewport = m.cssVisualViewport || m.visualViewport || {};
    const origWidth = viewport.clientWidth || width;
    const origHeight = viewport.clientHeight || height;
    const maxDim = 16384; // Chrome's max GPU texture dimension

    // SPA detection: find the main scrollable container (LinkedIn, Gmail, Twitter use
    // nested scroll containers instead of document-level scroll).
    let spaContainer = null;
    let spaExpanded = false;
    if (height <= origHeight * 1.1) {
      try {
        const r = await cdp("Runtime.evaluate", {
          expression: `(() => {
            let best = null, bestArea = 0;
            for (const el of document.querySelectorAll('*')) {
              const s = getComputedStyle(el);
              if ((s.overflowY === 'auto' || s.overflowY === 'scroll' || s.overflowY === 'overlay') && el.scrollHeight > el.clientHeight + 50) {
                const area = el.scrollHeight * el.clientWidth;
                if (area > bestArea) { bestArea = area; best = el; }
              }
            }
            if (!best) return null;
            best.dataset._cdpFullpage = '1';
            return { scrollHeight: best.scrollHeight, clientHeight: best.clientHeight };
          })()`,
          returnByValue: true,
        }, sess, 5000);
        if (r.result?.value) spaContainer = r.result.value;
      } catch { /* proceed without SPA detection */ }
    }

    // Step 1: Scroll through the page BEFORE expanding to trigger lazy loading.
    // Must scroll inside the SPA container (while it's still scrollable) or window.
    // Safeguard: cap at 30 scroll steps AND track if content keeps growing (infinite scroll).
    // For infinite scroll pages, we stop once height stabilizes or exceeds maxDim.
    const scrollTarget = spaContainer ? 'spa' : (height > origHeight * 1.2 ? 'window' : null);
    const totalHeight = spaContainer ? spaContainer.scrollHeight : height;

    if (scrollTarget && totalHeight > origHeight * 1.2) {
      try {
        let prevHeight = totalHeight;
        const maxScrollSteps = 30; // cap to prevent runaway on infinite scroll
        const step = origHeight;
        let scrolls = Math.min(Math.ceil(totalHeight / step), maxScrollSteps);
        for (let i = 1; i <= scrolls; i++) {
          const scrollY = Math.min(i * step, prevHeight);
          if (scrollTarget === 'spa') {
            await cdp("Runtime.evaluate", {
              expression: `document.querySelector('[data-_cdp-fullpage="1"]').scrollTop = ${scrollY}`,
              returnByValue: true,
            }, sess, 3000);
          } else {
            await cdp("Runtime.evaluate", {
              expression: `window.scrollTo(0, ${scrollY})`,
              returnByValue: true,
            }, sess, 3000);
          }
          await sleep(250);
          // Every 5 steps, check if content is growing (infinite scroll detection)
          if (i % 5 === 0 && i < scrolls) {
            const check = await cdp("Runtime.evaluate", {
              expression: scrollTarget === 'spa'
                ? `document.querySelector('[data-_cdp-fullpage="1"]').scrollHeight`
                : `Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)`,
              returnByValue: true,
            }, sess, 3000);
            const newH = check.result?.value || prevHeight;
            if (newH > prevHeight * 1.5 || newH > maxDim) {
              // Content is growing rapidly (infinite scroll) — stop and use what we have
              break;
            }
            if (newH > prevHeight) {
              prevHeight = newH;
              scrolls = Math.min(Math.ceil(prevHeight / step), maxScrollSteps);
            }
          }
        }
        // Scroll back to top
        if (scrollTarget === 'spa') {
          await cdp("Runtime.evaluate", {
            expression: `document.querySelector('[data-_cdp-fullpage="1"]').scrollTop = 0`,
            returnByValue: true,
          }, sess, 3000);
        } else {
          await cdp("Runtime.evaluate", { expression: `window.scrollTo(0, 0)`, returnByValue: true }, sess, 3000);
        }
        await sleep(200);
      } catch { /* proceed */ }
    }

    // Step 2: Now expand the SPA container for capture (after lazy content has loaded)
    if (spaContainer) {
      try {
        const r = await cdp("Runtime.evaluate", {
          expression: `(() => {
            const el = document.querySelector('[data-_cdp-fullpage="1"]');
            if (!el) return null;
            el._origStyles = { maxHeight: el.style.maxHeight, height: el.style.height, overflow: el.style.overflow };
            el.style.maxHeight = 'none';
            el.style.height = el.scrollHeight + 'px';
            el.style.overflow = 'visible';
            // Expand ancestors that clip with overflow
            let p = el.parentElement;
            while (p && p !== document.body && p !== document.documentElement) {
              const ps = getComputedStyle(p);
              if (ps.overflowY === 'hidden' || ps.overflowY === 'auto' || ps.overflowY === 'scroll') {
                p.dataset._cdpFullpageParent = '1';
                p._origStyles = { maxHeight: p.style.maxHeight, height: p.style.height, overflow: p.style.overflow };
                p.style.maxHeight = 'none';
                p.style.height = 'auto';
                p.style.overflow = 'visible';
              }
              p = p.parentElement;
            }
            // Also handle body overflow:hidden (common in SPAs)
            if (getComputedStyle(document.body).overflow === 'hidden' || getComputedStyle(document.body).overflowY === 'hidden') {
              document.body.dataset._cdpFullpageParent = '1';
              document.body._origStyles = { overflow: document.body.style.overflow, overflowY: document.body.style.overflowY };
              document.body.style.overflow = 'visible';
            }
            return { scrollHeight: el.scrollHeight };
          })()`,
          returnByValue: true,
        }, sess, 5000);
        if (r.result?.value?.scrollHeight) {
          spaExpanded = true;
          await sleep(200);
          // Re-measure with expansion
          const m2 = await cdp("Page.getLayoutMetrics", {}, sess);
          const c2 = m2.cssContentSize || m2.contentSize;
          width = c2.width;
          height = c2.height;
        }
      } catch { /* proceed */ }
    }

    if (height > maxDim) height = maxDim;

    // Step 3: Resize viewport to full content so Chrome renders everything
    await cdp("Emulation.setDeviceMetricsOverride", {
      width: Math.ceil(width),
      height: Math.ceil(height),
      deviceScaleFactor: viewport.scale || 1,
      mobile: false,
    }, sess);
    await sleep(400); // Let full re-layout and paint happen

    params.clip = { x: 0, y: 0, width, height, scale: 1 };
    params.captureBeyondViewport = true;
    let captureData;
    try {
      const result = await cdp("Page.captureScreenshot", params, sess);
      captureData = result.data;
    } finally {
      // Restore original viewport
      await cdp("Emulation.clearDeviceMetricsOverride", {}, sess).catch(() => {});
      await sleep(100); // Let viewport restore settle

      // Restore SPA container styles and clean up markers
      if (spaContainer) {
        await cdp("Runtime.evaluate", {
          expression: `(() => {
            const el = document.querySelector('[data-_cdp-fullpage="1"]');
            if (el) {
              if (el._origStyles) {
                el.style.maxHeight = el._origStyles.maxHeight || '';
                el.style.height = el._origStyles.height || '';
                el.style.overflow = el._origStyles.overflow || '';
                delete el._origStyles;
              }
              delete el.dataset._cdpFullpage;
            }
            document.querySelectorAll('[data-_cdp-fullpage-parent="1"]').forEach(p => {
              if (p._origStyles) {
                if (p._origStyles.overflow !== undefined) p.style.overflow = p._origStyles.overflow || '';
                if (p._origStyles.overflowY !== undefined) p.style.overflowY = p._origStyles.overflowY || '';
                if (p._origStyles.maxHeight !== undefined) p.style.maxHeight = p._origStyles.maxHeight || '';
                if (p._origStyles.height !== undefined) p.style.height = p._origStyles.height || '';
                delete p._origStyles;
              }
              delete p.dataset._cdpFullpageParent;
            });
          })()`,
        }, sess, 5000).catch(() => {});
      }
    }

    // Return the full-page capture
    const saveTo = args.path || args.savePath;
    if (saveTo) {
      const buf = Buffer.from(captureData, "base64");
      const dir = saveTo.replace(/[\\/][^\\/]+$/, "");
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(saveTo, buf);
      return ok(`Screenshot saved to: ${saveTo}\nSize: ${(buf.length / 1024).toFixed(1)} KB${spaExpanded ? " (SPA container expanded)" : ""}`);
    }
    return { content: [{ type: "image", data: captureData, mimeType: params.format === "jpeg" ? "image/jpeg" : "image/png" }] };
  }
  const { data } = await cdp("Page.captureScreenshot", params, sess);
  // Save to disk if path provided (also accept legacy savePath)
  const saveTo = args.path || args.savePath;
  if (saveTo) {
    const buf = Buffer.from(data, "base64");
    const dir = saveTo.replace(/[\\/][^\\/]+$/, "");
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(saveTo, buf);
    return ok(`Screenshot saved to: ${saveTo}\nSize: ${(buf.length / 1024).toFixed(1)} KB`);
  }
  return { content: [{ type: "image", data, mimeType: params.format === "jpeg" ? "image/jpeg" : "image/png" }] };
}

async function handlePageContent(args) {
  const sess = await getTabSession(args.tabId);
  // format: "full" returns complete document HTML with doctype (ignores uid/selector)
  if (args.format === "full") {
    if (args.uid !== undefined || args.selector) {
      return fail("format: 'full' returns the entire document \u2014 uid/selector not supported. Use format: 'html' for element HTML.");
    }
    const result = await cdp("Runtime.evaluate", {
      expression: `(document.doctype ? new XMLSerializer().serializeToString(document.doctype) + '\n' : '') + document.documentElement.outerHTML`,
      returnByValue: true,
    }, sess);
    return ok(result.result.value ?? "(empty)");
  }
  const prop = args.format === "html" ? "innerHTML" : "innerText";
  if (args.uid !== undefined || args.selector) {
    const { objectId, resolvedSession } = await resolveElementObjectId(sess, args.uid, args.selector);
    const result = await cdp("Runtime.callFunctionOn", {
      functionDeclaration: `function() { return this[${JSON.stringify(prop)}]; }`,
      objectId,
      returnByValue: true,
    }, resolvedSession);
    return ok(result.result.value ?? "(empty)");
  }
  // Default: body
  const result = await cdp("Runtime.evaluate", {
    expression: `document.body.${prop}`,
    returnByValue: true,
  }, sess);
  return ok(result.result.value ?? "(empty)");
}

async function handlePageWait(args) {
  // Fixed delay: just timeout with no condition (like Playwright's waitForTimeout)
  if (args.timeout && !args.selector && !args.text && !args.textGone) {
    const timeMs = Math.min(args.timeout, 60000);
    await sleep(timeMs);
    return ok(`Waited ${timeMs}ms.${args.timeout > 60000 ? ` (capped from ${args.timeout}ms)` : ""}`);
  }
  // Legacy support: accept 'time' param but treat as timeout-only delay
  if (args.time && !args.selector && !args.text && !args.textGone) {
    const timeMs = Math.min(args.time, 60000);
    await sleep(timeMs);
    return ok(`Waited ${timeMs}ms.`);
  }
  if (!args.selector && !args.text && !args.textGone) {
    return fail("Provide 'text', 'textGone', or 'selector' for conditional wait — or just 'timeout' for a fixed delay.");
  }
  const sess = await getTabSession(args.tabId);
  const timeout = args.timeout || 10000;
  const start = Date.now();
  const state = args.state || "attached";
  while (Date.now() - start < timeout) {
    let expr;
    if (args.textGone) expr = `!document.body.innerText.includes(${JSON.stringify(args.textGone)})`;
    else if (args.text) expr = `document.body.innerText.includes(${JSON.stringify(args.text)})`;
    else {
      // Selector wait with state support (matches Playwright's waitFor states)
      switch (state) {
        case "detached":
          expr = `!document.querySelector(${JSON.stringify(args.selector)})`;
          break;
        case "hidden":
          expr = `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); return !el || el.offsetParent === null || getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).display === 'none'; })()`;
          break;
        case "visible":
          expr = `(() => { const el = document.querySelector(${JSON.stringify(args.selector)}); return el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none'; })()`;
          break;
        default: // "attached"
          expr = `!!document.querySelector(${JSON.stringify(args.selector)})`;
      }
    }
    const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true }, sess, 5000);
    if (r.result.value === true) {
      const what = args.textGone ? `"${args.textGone}" disappeared` : args.text ? `"${args.text}" appeared` : `${args.selector} ${state}`;
      return ok(`${what} (${Date.now() - start}ms)`);
    }
    await sleep(300);
  }
  return fail(`Timed out (${timeout}ms) waiting for ${args.textGone || args.text || args.selector}${args.selector ? ` [state: ${state}]` : ""}`);
}

async function handlePagePdf(args) {
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Page");
  const pdfParams = {
    printBackground: true,
    landscape: args.landscape || false,
    scale: args.scale || 1,
    paperWidth: args.paperWidth || 8.5,
    paperHeight: args.paperHeight || 11,
    marginTop: args.margin?.top ?? 0.4,
    marginBottom: args.margin?.bottom ?? 0.4,
    marginLeft: args.margin?.left ?? 0.4,
    marginRight: args.margin?.right ?? 0.4,
  };
  const { data } = await cdp("Page.printToPDF", pdfParams, sess, LONG_TIMEOUT);
  const buf = Buffer.from(data, "base64");
  ensureTempDir();
  const prefix = args._agentSessionId ? `${args._agentSessionId.substring(0, 8)}_` : "";
  const path = join(TEMP_DIR, `${prefix}page-${Date.now()}.pdf`);
  writeFileSync(path, buf);
  return ok(`PDF saved to: ${path}\nSize: ${(buf.length / 1024).toFixed(1)} KB`);
}

async function handlePageDialog(args) {
  const sess = await getTabSession(args.tabId);
  const dialogs = pendingDialogs.get(sess) || [];

  if (dialogs.length === 0) {
    return ok("No pending dialog.");
  }

  const dialog = dialogs[0];
  const accept = args.accept !== undefined ? args.accept : true;
  const dialogParams = { accept };
  if (args.text !== undefined) dialogParams.promptText = args.text;

  await cdp("Page.handleJavaScriptDialog", dialogParams, sess);
  dialogs.shift();

  return ok(`Dialog handled: ${dialog.type} "${dialog.message.substring(0, 100)}"\nAction: ${accept ? "accepted" : "dismissed"}${args.text ? ` with text: "${args.text}"` : ""}`);
}

async function handlePageInject(args) {
  if (!args.script) return fail("Provide 'script' to inject.");
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Page");
  const { identifier } = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: args.script }, sess);
  const scripts = injectedScripts.get(sess) || [];
  scripts.push({ identifier, description: args.script.substring(0, 80) });
  injectedScripts.set(sess, scripts);
  return ok(`Script injected (id: ${identifier}). Will run on every new document load.\nPreview: ${args.script.substring(0, 120)}`);
}

async function handlePageBypassCsp(args) {
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Page");
  const enabled = args.enabled !== undefined ? args.enabled : true;
  await cdp("Page.setBypassCSP", { enabled }, sess);
  return ok(`Content Security Policy bypass: ${enabled ? "enabled" : "disabled"}`);
}

async function handlePageSetContent(args) {
  if (!args.html) return fail("Provide 'html' content.");
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Page");

  // Get the root frame ID
  const { frameTree } = await cdp("Page.getFrameTree", {}, sess);
  const frameId = frameTree.frame.id;

  await cdp("Page.setDocumentContent", { frameId, html: args.html }, sess);

  // Wait for the content to be ready
  await sleep(200);

  return ok(`Page content set (${args.html.length} chars).`);
}

async function handlePageAddStyle(args) {
  if (!args.css && !args.cssUrl) return fail("Provide 'css' (inline content) or 'cssUrl' (external stylesheet URL).");
  const sess = await getTabSession(args.tabId);

  if (args.persistent) {
    // Use Page.addScriptToEvaluateOnNewDocument to inject CSS on every load.
    // IMPORTANT: addScriptToEvaluateOnNewDocument runs before DOM is constructed,
    // so document.head may be null. Must defer to DOMContentLoaded if head doesn't exist yet.
    await ensureDomain(sess, "Page");
    const code = args.css
      ? `(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(args.css)}; const insert = () => (document.head || document.documentElement).appendChild(s); if (document.head) insert(); else document.addEventListener('DOMContentLoaded', insert); })()`
      : `(() => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = ${JSON.stringify(args.cssUrl)}; const insert = () => (document.head || document.documentElement).appendChild(l); if (document.head) insert(); else document.addEventListener('DOMContentLoaded', insert); })()`;
    const { identifier } = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: code }, sess);
    // Also execute immediately on current page (head exists here since page is already loaded)
    await cdp("Runtime.evaluate", { expression: code }, sess);
    const scripts = injectedScripts.get(sess) || [];
    scripts.push({ identifier, description: `[CSS] ${(args.css || args.cssUrl).substring(0, 60)}` });
    injectedScripts.set(sess, scripts);
    return ok(`Style injected (persistent, id: ${identifier}).`);
  }

  // Non-persistent — inject into current page only
  const code = args.css
    ? `(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(args.css)}; document.head.appendChild(s); return { ok: true }; })()`
    : `(() => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = ${JSON.stringify(args.cssUrl)}; document.head.appendChild(l); return { ok: true }; })()`;

  const result = await cdp("Runtime.evaluate", { expression: code, returnByValue: true }, sess);
  if (result.exceptionDetails) return fail("Failed to inject style: " + (result.exceptionDetails.exception?.description || "unknown error"));

  return ok(`Style injected${args.css ? ` (${args.css.length} chars)` : ` (${args.cssUrl})`}.`);
}

// ─── Interact Handlers ──────────────────────────────────────────────

async function handleInteractClick(args) {
  const sess = await getTabSession(args.tabId);
  const retryTimeout = args.timeout || 5000;
  const el = await withRetry(() => checkActionability(sess, args.uid, args.selector), { timeout: retryTimeout });
  const button = args.button || "left";
  const clicks = args.clickCount || 1;
  // CDP buttons bitmask: 1=left, 2=right, 4=middle
  const buttonsMap = { left: 1, right: 2, middle: 4 };
  const buttons = buttonsMap[button] || 1;

  // Resolve objectId for potential JS click fallback (web components / Shadow DOM)
  let objectId;
  const clickResolveSession = getResolveSession(sess, args.uid);
  if (args.uid !== undefined && args.uid !== null) {
    const map = refMaps.get(sess);
    const backendNodeId = map?.get(args.uid);
    if (backendNodeId) {
      try {
        const { object } = await cdp("DOM.resolveNode", { backendNodeId }, clickResolveSession);
        objectId = object?.objectId;
      } catch {}
    }
  }
  if (!objectId && args.selector) {
    try {
      const finder = elementFinderExpr(args.selector);
      const res = await cdp("Runtime.evaluate", { expression: finder, returnByValue: false }, sess);
      objectId = res.result?.objectId;
    } catch {}
  }

  // Check pre-click state for popup/toggle elements (aria-expanded, open attribute)
  let preState = null;
  if (objectId && button === "left") {
    try {
      const check = await cdp("Runtime.callFunctionOn", {
        functionDeclaration: `function() {
          return {
            expanded: this.getAttribute("aria-expanded"),
            hasPopup: this.hasAttribute("aria-haspopup") || this.hasAttribute("popovertarget"),
            open: this.hasAttribute("open") || this.closest("details")?.hasAttribute("open"),
            isWebComponent: !!this.closest("[data-catalyst]") || !!this.getRootNode()?.host || this.tagName.includes("-"),
          };
        }`,
        objectId,
        returnByValue: true,
      }, clickResolveSession);
      preState = check.result?.value;
    } catch {}
  }

  const mods = modifierFlags(args.modifiers);

  const { networkEvents } = await waitForCompletion(sess, async () => {
    if (args.humanMode) {
      // Human-like: bezier curve mouse path with overshoot and jitter
      const startX = args._agentSession?.lastMouseX || 0;
      const startY = args._agentSession?.lastMouseY || 0;
      const path = generateBezierPath({ x: startX, y: startY }, { x: el.x, y: el.y });
      for (let i = 0; i < path.length; i++) {
        await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: path[i].x, y: path[i].y, modifiers: mods }, sess);
        const progress = i / path.length;
        const delay = progress > 0.7 ? 15 + Math.random() * 20 : 5 + Math.random() * 10;
        await sleep(delay);
      }
      await sleep(30 + Math.random() * 50); // pre-click hesitation
    } else {
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: el.x, y: el.y, modifiers: mods }, sess);
      await sleep(50);
    }
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: el.x, y: el.y, button, clickCount: clicks, buttons, modifiers: mods }, sess);
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: el.x, y: el.y, button, clickCount: clicks, modifiers: mods }, sess);
  });

  // Track last mouse position for subsequent humanMode calls
  if (args._agentSession) {
    args._agentSession.lastMouseX = el.x;
    args._agentSession.lastMouseY = el.y;
  }

  // Smart JS click fallback: if the element is a web component or popup trigger
  // and the CDP mouse events didn't change its state, dispatch element.click() via JS.
  // This handles GitHub's <action-menu>, Popover API, and custom Web Components
  // that only listen for the 'click' event rather than raw mousedown/mouseup.
  if (objectId && button === "left" && preState) {
    const needsFallback = preState.hasPopup || preState.isWebComponent || preState.expanded === "false";
    if (needsFallback) {
      try {
        await sleep(100); // Let any CDP-triggered handlers settle first
        const postCheck = await cdp("Runtime.callFunctionOn", {
          functionDeclaration: `function() {
            return {
              expanded: this.getAttribute("aria-expanded"),
              open: this.hasAttribute("open") || this.closest("details")?.hasAttribute("open"),
            };
          }`,
          objectId,
          returnByValue: true,
        }, clickResolveSession);
        const postState = postCheck.result?.value;
        // If state didn't change, dispatch full pointer+mouse event sequence as fallback.
        // Many modern frameworks (React, GitHub Primer, etc.) listen for PointerEvents,
        // not just click — so we need to dispatch the complete event chain.
        const stateChanged = (preState.expanded === "false" && postState?.expanded === "true") ||
                             (!preState.open && postState?.open);
        if (!stateChanged) {
          await cdp("Runtime.callFunctionOn", {
            functionDeclaration: `function() {
              const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
              this.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1 }));
              this.dispatchEvent(new MouseEvent('mousedown', opts));
              this.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1 }));
              this.dispatchEvent(new MouseEvent('mouseup', opts));
              this.dispatchEvent(new MouseEvent('click', opts));
            }`,
            objectId,
          }, clickResolveSession);
          await sleep(200); // Let event handlers process
        }
      } catch {}
    }
  }

  let msg = `Clicked <${el.tag}> "${el.label}" at (${Math.round(el.x)}, ${Math.round(el.y)})`;
  if (networkEvents.length) msg += "\n\nNetwork activity:\n" + networkEvents.join("\n");
  return ok(msg);
}

async function handleInteractHover(args) {
  const sess = await getTabSession(args.tabId);
  const retryTimeout = args.timeout || 5000;
  const el = await withRetry(() => resolveElement(sess, args.uid, args.selector), { timeout: retryTimeout });
  const mods = modifierFlags(args.modifiers);
  if (args.humanMode) {
    const startX = args._agentSession?.lastMouseX || 0;
    const startY = args._agentSession?.lastMouseY || 0;
    const path = generateBezierPath({ x: startX, y: startY }, { x: el.x, y: el.y });
    for (const pt of path) {
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y, modifiers: mods }, sess);
      await sleep(5 + Math.random() * 15);
    }
  } else {
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: el.x, y: el.y, modifiers: mods }, sess);
  }
  // Track last mouse position
  if (args._agentSession) {
    args._agentSession.lastMouseX = el.x;
    args._agentSession.lastMouseY = el.y;
  }
  return ok(`Hovering over <${el.tag}> "${el.label}" at (${Math.round(el.x)}, ${Math.round(el.y)})${args.humanMode ? " (human path)" : ""}`);
}

async function handleInteractType(args) {
  if (!args.text) return fail("Provide 'text' to type.");
  const sess = await getTabSession(args.tabId);
  const retryTimeout = args.timeout || 5000;
  // Bundle actionability + object resolution in one retry block to avoid race conditions
  // (page re-render between the two calls would crash resolveElementObjectId)
  const { objectId, resolvedSession } = await withRetry(async () => {
    await checkActionability(sess, args.uid, args.selector);
    return resolveElementObjectId(sess, args.uid, args.selector);
  }, { timeout: retryTimeout });
  const clearCode = args.clear !== false
    ? `if ('value' in this) {
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                          || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(this, '');
        else this.value = '';
        this.dispatchEvent(new Event('input', {bubbles:true}));
      } else if (this.isContentEditable) { this.textContent = ''; }`
    : "";
  const focused = await cdp("Runtime.callFunctionOn", {
    functionDeclaration: `function() { this.scrollIntoView({block:"center"}); this.focus(); ${clearCode} return {ok:true}; }`,
    objectId,
    returnByValue: true,
  }, resolvedSession);
  if (focused.result.value?.error) return fail(focused.result.value.error);

  const { networkEvents } = await waitForCompletion(sess, async () => {
    if (args.charDelay || args.wordDelay) {
      // Human-like typing: randomized per-char and per-word delays
      const charBase = args.charDelay || 200;
      const wordBase = args.wordDelay || 800;

      for (const char of args.text) {
        // Typo simulation: occasionally type wrong char then backspace-correct
        if (args.typoRate && args.typoRate > 0 && Math.random() < args.typoRate && char.match(/[a-zA-Z]/)) {
          const wrongChar = getAdjacentKey(char);
          await cdp("Input.dispatchKeyEvent", { type: "keyDown", text: wrongChar, key: wrongChar, unmodifiedText: wrongChar }, sess);
          await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: wrongChar }, sess);
          await sleep(randomDelay(charBase * 2)); // pause — "noticing" the mistake
          const bk = resolveKey("Backspace");
          await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: bk.key, code: bk.code, windowsVirtualKeyCode: bk.keyCode, nativeVirtualKeyCode: bk.keyCode }, sess);
          await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: bk.key, code: bk.code, windowsVirtualKeyCode: bk.keyCode, nativeVirtualKeyCode: bk.keyCode }, sess);
          await sleep(randomDelay(charBase * 0.5)); // quick correction
        }

        await cdp("Input.dispatchKeyEvent", { type: "keyDown", text: char, key: char, unmodifiedText: char }, sess);
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: char }, sess);

        if (char === ' ' || char === '\t') {
          // Word boundary — longer pause
          await sleep(randomDelay(wordBase));
        } else if (char === '\n') {
          // Newline — use word delay (natural pause at line breaks)
          await sleep(randomDelay(wordBase));
        } else {
          // Regular character within a word
          await sleep(randomDelay(charBase));
        }
      }
    } else if (args.delay && args.delay > 0) {
      // Legacy: fixed delay per keystroke (backward compatible)
      for (const char of args.text) {
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", text: char, key: char, unmodifiedText: char }, sess);
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: char }, sess);
        await sleep(args.delay);
      }
    } else {
      // Instant fill using nativeInputValueSetter for React/Angular compatibility
      await cdp("Runtime.evaluate", {
        expression: `(() => {
          const el = document.activeElement;
          if (!el) return;
          const val = ${JSON.stringify(args.text)};
          if ('value' in el) {
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                              || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            if (nativeSetter) nativeSetter.call(el, val);
            else el.value = val;
          } else if (el.isContentEditable) {
            document.execCommand('insertText', false, val);
          }
          el.dispatchEvent(new Event('input', {bubbles:true}));
          el.dispatchEvent(new Event('change', {bubbles:true}));
        })()`,
      }, sess);
    }
  });

  if (args.submit) {
    const k = resolveKey("Enter");
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...k }, sess);
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...k }, sess);
  }

  const display = args.text.length > 60 ? args.text.substring(0, 60) + "..." : args.text;
  let msg = `Typed "${display}"${args.submit ? " + Enter" : ""}`;
  if (networkEvents.length) msg += "\n\nNetwork activity:\n" + networkEvents.join("\n");
  return ok(msg);
}

async function handleInteractFill(args) {
  if (!args.fields?.length) return fail("Provide 'fields' array.");
  const sess = await getTabSession(args.tabId);
  const retryTimeout = args.timeout || 5000;
  const results = [];

  const { networkEvents } = await waitForCompletion(sess, async () => {
    for (const field of args.fields) {
      try {
        // Bundle actionability + object resolution in one retry block
        const { objectId, resolvedSession: fieldSession } = await withRetry(async () => {
          await checkActionability(sess, field.uid, field.selector);
          return resolveElementObjectId(sess, field.uid, field.selector);
        }, { timeout: retryTimeout });
        const fieldType = field.type || "text";
        const r = await cdp("Runtime.callFunctionOn", {
          functionDeclaration: `function() {
            this.scrollIntoView({ block: "center" });
            const type = ${JSON.stringify(fieldType)};
            const val = ${JSON.stringify(field.value)};
            if (type === "checkbox") {
              const wanted = val === "true" || val === "1";
              if (this.checked !== wanted) this.click();
              return { ok: true, value: String(this.checked) };
            }
            if (type === "radio") { this.click(); return { ok: true, value: val }; }
            if (type === "select") {
              let opt = Array.from(this.options).find(o => o.value === val || o.textContent.trim() === val);
              if (!opt) return { error: "Option not found: " + val };
              const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
              if (nativeSetter) nativeSetter.call(this, opt.value);
              else this.value = opt.value;
              this.dispatchEvent(new Event('input', {bubbles:true}));
              this.dispatchEvent(new Event('change', {bubbles:true}));
              return { ok: true, value: opt.textContent.trim() };
            }
            this.focus();
            if ('value' in this) {
              const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                                || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
              if (nativeSetter) nativeSetter.call(this, val);
              else this.value = val;
            } else if (this.isContentEditable) {
              this.textContent = val;
            }
            this.dispatchEvent(new Event('input', {bubbles:true}));
            this.dispatchEvent(new Event('change', {bubbles:true}));
            return { ok: true, value: val.substring(0, 40) };
          }`,
          objectId,
          returnByValue: true,
        }, fieldSession);
        results.push({ field: field.uid ?? field.selector, ...(r.result.value || { error: "eval failed" }) });
      } catch (e) {
        results.push({ field: field.uid ?? field.selector, error: e.message });
      }
    }
  });

  const response = { filled: results };
  if (networkEvents.length) response.networkActivity = networkEvents;
  return ok(response);
}

async function handleInteractSelect(args) {
  if (!args.value) return fail("Provide 'value' to select.");
  const sess = await getTabSession(args.tabId);
  const retryTimeout = args.timeout || 5000;
  // Bundle actionability + object resolution in one retry block to avoid race conditions
  const { objectId, resolvedSession } = await withRetry(async () => {
    await checkActionability(sess, args.uid, args.selector);
    return resolveElementObjectId(sess, args.uid, args.selector);
  }, { timeout: retryTimeout });

  const { networkEvents } = await waitForCompletion(sess, async () => {
    const result = await cdp("Runtime.callFunctionOn", {
      functionDeclaration: `function() {
        const sel = this;

        // Native <select> handling with proper event sequence
        if (sel.tagName === "SELECT") {
          const targetVal = ${JSON.stringify(args.value)};
          let opt = Array.from(sel.options).find(o => o.value === targetVal);
          if (!opt) opt = Array.from(sel.options).find(o => o.textContent.trim() === targetVal);
          if (!opt) return { error: "Option not found: " + targetVal + ". Available: " + Array.from(sel.options).map(o => o.textContent.trim()).join(", ") };

          const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(sel, opt.value);
          else sel.value = opt.value;

          sel.dispatchEvent(new Event("input", { bubbles: true }));
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return { selected: opt.textContent.trim(), value: opt.value };
        }

        // Custom dropdown detection (combobox, listbox, MUI, Ant Design, React Select)
        const role = sel.getAttribute("role");
        const isCustomDropdown = role === "combobox" || role === "listbox" ||
          sel.getAttribute("aria-haspopup") ||
          sel.classList.toString().match(/MuiSelect|ant-select|react-select|Select/i);

        if (isCustomDropdown) {
          sel.scrollIntoView({ block: "center" });
          sel.click();
          return { customDropdown: true, message: "Custom dropdown opened — click the matching option" };
        }

        return { error: "Not a <select> element and not a recognized custom dropdown. Element: <" + sel.tagName.toLowerCase() + ">" };
      }`,
      objectId,
      returnByValue: true,
    }, resolvedSession);
    const v = result.result.value;
    if (v?.error) throw new Error(v.error);

    // If custom dropdown was opened, wait for options to appear and click matching one
    if (v?.customDropdown) {
      await sleep(300); // Wait for dropdown animation
      const clickResult = await cdp("Runtime.evaluate", {
        expression: `(() => {
          const val = ${JSON.stringify(args.value)};
          // Look for option elements in open dropdowns
          const options = document.querySelectorAll('[role="option"], [role="listitem"], li[data-value], .MuiMenuItem-root, .ant-select-item, [class*="option"]');
          for (const opt of options) {
            const text = opt.textContent.trim();
            const value = opt.getAttribute("data-value") || opt.getAttribute("value") || "";
            if (text === val || value === val || text.toLowerCase() === val.toLowerCase()) {
              opt.scrollIntoView({ block: "center" });
              opt.click();
              return { selected: text, value: value || text };
            }
          }
          return { error: "Option not found in custom dropdown: " + val + ". Visible options: " + Array.from(options).slice(0, 10).map(o => o.textContent.trim()).join(", ") };
        })()`,
        returnByValue: true,
      }, sess);
      const cv = clickResult.result.value;
      if (cv?.error) throw new Error(cv.error);
      return cv;
    }
    return v;
  });

  let msg = `Selected option successfully`;
  if (networkEvents.length) msg += "\n\nNetwork activity:\n" + networkEvents.join("\n");
  return ok(msg);
}

async function handleInteractPress(args) {
  if (!args.key) return fail("Provide 'key' to press.");
  const sess = await getTabSession(args.tabId);
  const k = resolveKey(args.key);
  const mods = modifierFlags(args.modifiers);

  const { networkEvents } = await waitForCompletion(sess, async () => {
    await cdp("Input.dispatchKeyEvent", {
      type: "keyDown", key: k.key, code: k.code,
      windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode,
      modifiers: mods, text: k.text,
    }, sess);
    await cdp("Input.dispatchKeyEvent", {
      type: "keyUp", key: k.key, code: k.code,
      windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode,
      modifiers: mods,
    }, sess);
  });

  const modStr = args.modifiers?.length ? args.modifiers.join("+") + "+" : "";
  let msg = `Pressed ${modStr}${args.key}`;
  if (networkEvents.length) msg += "\n\nNetwork activity:\n" + networkEvents.join("\n");
  return ok(msg);
}

async function handleInteractDrag(args) {
  const sess = await getTabSession(args.tabId);
  const retryTimeout = args.timeout || 5000;
  const src = await withRetry(() => resolveElement(sess, args.sourceUid, args.sourceSelector), { timeout: retryTimeout });
  const tgt = await withRetry(() => resolveElement(sess, args.targetUid, args.targetSelector), { timeout: retryTimeout });

  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: src.x, y: src.y }, sess);
  await sleep(50);
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: src.x, y: src.y, button: "left", clickCount: 1 }, sess);
  await sleep(100);
  if (args.humanMode) {
    const path = generateBezierPath({ x: src.x, y: src.y }, { x: tgt.x, y: tgt.y }, 25, 3);
    for (const pt of path) {
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y }, sess);
      await sleep(10 + Math.random() * 15);
    }
  } else {
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      const px = src.x + (tgt.x - src.x) * (i / steps);
      const py = src.y + (tgt.y - src.y) * (i / steps);
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py }, sess);
      await sleep(20);
    }
  }
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: tgt.x, y: tgt.y, button: "left", clickCount: 1 }, sess);
  // Track last mouse position
  if (args._agentSession) {
    args._agentSession.lastMouseX = tgt.x;
    args._agentSession.lastMouseY = tgt.y;
  }
  return ok(`Dragged <${src.tag}> "${src.label}" → <${tgt.tag}> "${tgt.label}"${args.humanMode ? " (human path)" : ""}`);
}

async function handleInteractScroll(args) {
  const sess = await getTabSession(args.tabId);
  const amount = args.amount || 400;
  const retryTimeout = args.timeout || 5000;

  // scrollTo absolute position
  if (args.x !== undefined || args.y !== undefined) {
    const scrollX = args.x ?? 0;
    const scrollY = args.y ?? 0;
    if (args.uid !== undefined || args.selector) {
      const { objectId, resolvedSession } = await withRetry(() => resolveElementObjectId(sess, args.uid, args.selector), { timeout: retryTimeout });
      await cdp("Runtime.callFunctionOn", {
        functionDeclaration: `function() { this.scrollTo({left:${scrollX},top:${scrollY},behavior:'smooth'}); }`,
        objectId,
        returnByValue: true,
      }, resolvedSession);
    } else {
      await cdp("Runtime.evaluate", {
        expression: `window.scrollTo({left:${scrollX},top:${scrollY},behavior:'smooth'})`,
        returnByValue: true,
      }, sess);
    }
    return ok(`Scrolled to (${scrollX}, ${scrollY})`);
  }

  // scrollBy with direction
  const dir = args.direction || "down";
  let deltaX = 0, deltaY = 0;
  switch (dir) {
    case "up": deltaY = -amount; break;
    case "down": deltaY = amount; break;
    case "left": deltaX = -amount; break;
    case "right": deltaX = amount; break;
  }

  if (args.uid !== undefined || args.selector) {
    const { objectId, resolvedSession } = await withRetry(() => resolveElementObjectId(sess, args.uid, args.selector), { timeout: retryTimeout });
    await cdp("Runtime.callFunctionOn", {
      functionDeclaration: `function() { this.scrollBy({left:${deltaX},top:${deltaY},behavior:'smooth'}); }`,
      objectId,
      returnByValue: true,
    }, resolvedSession);
  } else {
    await cdp("Runtime.evaluate", {
      expression: `window.scrollBy({left:${deltaX},top:${deltaY},behavior:'smooth'})`,
      returnByValue: true,
    }, sess);
  }
  return ok(`Scrolled ${dir} by ${amount}px`);
}

/**
 * Search for <input type="file"> in a page (including shadow DOMs) and set files directly.
 * Returns true if files were successfully set, false if no file input found.
 * @param {string} sessId - CDP session ID
 * @param {string[]} files - Array of absolute file paths
 */
async function findAndSetFileInput(sessId, files) {
  try {
    const inputObj = await cdp("Runtime.evaluate", {
      expression: `(() => {
        function find(root) {
          const el = root.querySelector('input[type="file"]');
          if (el) return el;
          for (const s of root.querySelectorAll('*')) {
            if (s.shadowRoot) { const f = find(s.shadowRoot); if (f) return f; }
          }
          return null;
        }
        return find(document);
      })()`,
      returnByValue: false,
    }, sessId, 3000);

    if (!inputObj.result?.objectId) return false;

    const { node } = await cdp("DOM.describeNode", { objectId: inputObj.result.objectId }, sessId);
    await cdp("DOM.setFileInputFiles", { files, backendNodeId: node.backendNodeId }, sessId);

    // Dispatch change+input events as safety measure (some frameworks listen directly)
    await cdp("Runtime.callFunctionOn", {
      functionDeclaration: `function() {
        this.dispatchEvent(new Event('change', { bubbles: true }));
        this.dispatchEvent(new Event('input', { bubbles: true }));
      }`,
      objectId: inputObj.result.objectId,
    }, sessId).catch(() => {});

    return true;
  } catch {
    return false;
  }
}

async function handleInteractUpload(args) {
  if (!args.files?.length) return fail("Provide 'files' array with absolute file paths.");
  const sess = await getTabSession(args.tabId);
  const retryTimeout = args.timeout || 5000;

  // No element specified — smart multi-target file upload
  // Monitors main page AND popup windows for file chooser dialogs or file inputs.
  // Handles popup-based upload flows (Google Drive Picker, Dropbox chooser, etc.)
  if (!args.uid && !args.selector) {
    const uploadTimeout = args.timeout || 30000;
    const managedSessions = new Map(); // cdpSessionId → { targetId, isPopup }
    const popupSessionIds = []; // popup CDP sessions we attached to (need cleanup)
    let done = false;
    let masterResolve, masterReject;

    const masterPromise = new Promise((resolve, reject) => {
      masterResolve = resolve;
      masterReject = reject;
    });

    const masterTimer = setTimeout(() => {
      if (!done) {
        done = true;
        masterReject(new Error(
          `No file input or file chooser dialog found within ${uploadTimeout / 1000}s.\n` +
          "If a popup window opened (e.g. Google Drive Picker):\n" +
          "• Use tabs.list to find the popup window\n" +
          "• Snapshot the popup to find its file input or upload button\n" +
          "• Use interact.upload with uid/selector targeting the file input in the popup"
        ));
      }
    }, uploadTimeout);

    function succeed(result) {
      if (!done) {
        done = true;
        clearTimeout(masterTimer);
        masterResolve(result);
      }
    }

    // Universal file chooser handler — fires for ANY monitored session
    const fileChooserHandler = (sid, method, params) => {
      if (method === "Page.fileChooserOpened" && managedSessions.has(sid) && !done) {
        succeed({ sessionId: sid, via: "fileChooser" });
      }
    };

    // Add file chooser monitoring to a CDP session
    async function addMonitoring(sessId, targetId, isPopup) {
      if (managedSessions.has(sessId) || done) return;
      managedSessions.set(sessId, { targetId, isPopup });
      const pending = pendingFileChoosers.get(sessId) || [];
      pending.push(fileChooserHandler);
      pendingFileChoosers.set(sessId, pending);
      try { await cdp("Page.setInterceptFileChooserDialog", { enabled: true }, sessId); } catch { /* ok */ }
    }

    // 1. Monitor main page session for file chooser
    await addMonitoring(sess, args.tabId, false);

    // 2. Quick check: is there already a <input type="file"> on this page?
    if (await findAndSetFileInput(sess, args.files)) {
      succeed({ sessionId: sess, via: "directInput" });
    }

    // 3. Record current tabs to detect new popups
    const seenTargets = new Set((await getTabs()).map(t => t.targetId));

    // 4. Poll for new popup windows + scan them for file inputs
    const pollTimer = setInterval(async () => {
      if (done) return;
      try {
        const tabs = await getTabs();
        for (const tab of tabs) {
          if (seenTargets.has(tab.targetId) || done) continue;
          seenTargets.add(tab.targetId);

          // New popup/tab — attach lightweight CDP session and monitor
          try {
            const { sessionId: psid } = await cdp("Target.attachToTarget", {
              targetId: tab.targetId, flatten: true
            });
            popupSessionIds.push(psid);
            await cdp("Runtime.enable", {}, psid, 5000).catch(() => {});
            await cdp("Page.enable", {}, psid, 5000).catch(() => {});
            await addMonitoring(psid, tab.targetId, true);
          } catch { /* failed to attach — popup may have closed */ }
        }

        // Retry file input search on all popup sessions (content may have loaded)
        for (const psid of popupSessionIds) {
          if (done) break;
          if (await findAndSetFileInput(psid, args.files)) {
            succeed({ sessionId: psid, via: "popupDirectInput" });
          }
        }
      } catch { /* ignore polling errors */ }
    }, 1000);

    try {
      const result = await masterPromise;

      if (result.via === "fileChooser") {
        await cdp("Page.handleFileChooser", { action: "accept", files: args.files }, result.sessionId);
        const where = managedSessions.get(result.sessionId)?.isPopup ? " (from popup window)" : "";
        return ok(`Uploaded ${args.files.length} file(s) via file chooser${where}: ${args.files.map(f => f.split(/[/\\]/).pop()).join(", ")}`);
      }

      if (result.via === "popupDirectInput") {
        await sleep(1000); // let the popup process the files (e.g. Google Drive upload)
        return ok(`Uploaded ${args.files.length} file(s) via popup file input: ${args.files.map(f => f.split(/[/\\]/).pop()).join(", ")}`);
      }

      // directInput on main page
      return ok(`Uploaded ${args.files.length} file(s) via file input: ${args.files.map(f => f.split(/[/\\]/).pop()).join(", ")}`);
    } catch (err) {
      return fail(err.message);
    } finally {
      clearInterval(pollTimer);
      clearTimeout(masterTimer);

      // Clean up file chooser handlers
      for (const [sid] of managedSessions) {
        const pending = pendingFileChoosers.get(sid) || [];
        pendingFileChoosers.set(sid, pending.filter(h => h !== fileChooserHandler));
        try { await cdp("Page.setInterceptFileChooserDialog", { enabled: false }, sid); } catch { /* ok */ }
      }

      // Detach from popup sessions and clean up their event data
      for (const psid of popupSessionIds) {
        try { await cdp("Target.detachFromTarget", { sessionId: psid }); } catch { /* ok */ }
        consoleLogs.delete(psid);
        networkReqs.delete(psid);
        pendingDialogs.delete(psid);
        pendingFileChoosers.delete(psid);
      }
    }
  }

  // Element specified — use direct file input approach
  const { objectId, resolvedSession } = await withRetry(() => resolveElementObjectId(sess, args.uid, args.selector), { timeout: retryTimeout });

  // Describe node to get backendNodeId for setFileInputFiles
  const { node } = await cdp("DOM.describeNode", { objectId }, resolvedSession);
  await cdp("DOM.setFileInputFiles", { files: args.files, backendNodeId: node.backendNodeId }, resolvedSession);

  return ok(`Uploaded ${args.files.length} file(s): ${args.files.map(f => f.split(/[/\\]/).pop()).join(", ")}`);
}

async function handleInteractFocus(args) {
  const sess = await getTabSession(args.tabId);
  const retryTimeout = args.timeout || 5000;
  const { objectId, resolvedSession } = await withRetry(() => resolveElementObjectId(sess, args.uid, args.selector), { timeout: retryTimeout });
  const result = await cdp("Runtime.callFunctionOn", {
    functionDeclaration: `function() {
      this.scrollIntoView({ block: "center" });
      this.focus();
      return { tag: this.tagName.toLowerCase(), label: (this.getAttribute("aria-label") || this.textContent || "").trim().substring(0, 60) };
    }`,
    objectId,
    returnByValue: true,
  }, resolvedSession);
  const v = result.result.value;
  if (v?.error) return fail(v.error);
  return ok(`Focused <${v.tag}> "${v.label}"`);
}

async function handleInteractCheck(args) {
  if (args.checked === undefined) return fail("Provide 'checked' (true/false).");
  const sess = await getTabSession(args.tabId);
  const retryTimeout = args.timeout || 5000;
  // Bundle actionability + object resolution in one retry block to avoid race conditions
  const { objectId, resolvedSession } = await withRetry(async () => {
    await checkActionability(sess, args.uid, args.selector);
    return resolveElementObjectId(sess, args.uid, args.selector);
  }, { timeout: retryTimeout });

  const { networkEvents } = await waitForCompletion(sess, async () => {
    const result = await cdp("Runtime.callFunctionOn", {
      functionDeclaration: `function() {
        this.scrollIntoView({ block: "center" });
        const desired = ${args.checked === true};
        if (this.checked !== desired) {
          this.click();
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { checked: this.checked, label: (this.getAttribute("aria-label") || this.labels?.[0]?.textContent || "").trim().substring(0, 60) };
      }`,
      objectId,
      returnByValue: true,
    }, resolvedSession);
    const v = result.result.value;
    if (v?.error) throw new Error(v.error);
    return v;
  });

  let msg = `Checkbox: ${args.checked ? "checked" : "unchecked"}`;
  if (networkEvents.length) msg += "\n\nNetwork activity:\n" + networkEvents.join("\n");
  return ok(msg);
}

async function handleInteractTap(args) {
  const sess = await getTabSession(args.tabId);
  const retryTimeout = args.timeout || 5000;
  const el = await withRetry(() => checkActionability(sess, args.uid, args.selector), { timeout: retryTimeout });

  // Auto-enable touch emulation — required for Input.dispatchTouchEvent to work
  try { await cdp("Emulation.setTouchEmulationEnabled", { enabled: true }, sess); } catch { /* ok */ }

  const { networkEvents } = await waitForCompletion(sess, async () => {
    await cdp("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: Math.round(el.x), y: Math.round(el.y) }],
    }, sess);
    await sleep(50);
    await cdp("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    }, sess);
  });

  let msg = `Tapped <${el.tag}> "${el.label}" at (${Math.round(el.x)}, ${Math.round(el.y)})`;
  if (networkEvents.length) msg += "\n\nNetwork activity:\n" + networkEvents.join("\n");
  return ok(msg);
}

// ─── Execute Handlers ───────────────────────────────────────────────

async function handleExecuteEval(args) {
  if (!args.expression) return fail("Provide 'expression' to evaluate.");
  const sess = await getTabSession(args.tabId);
  const result = await cdp("Runtime.evaluate", {
    expression: args.expression,
    returnByValue: true,
    awaitPromise: true,
    generatePreview: true,
    userGesture: true,
  }, sess);
  if (result.exceptionDetails) {
    return fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Evaluation error");
  }
  const v = result.result;
  if (v.type === "undefined") return ok("undefined");
  if (v.value !== undefined) return ok(typeof v.value === "string" ? v.value : JSON.stringify(v.value, null, 2));
  return ok(v.description || String(v));
}

async function handleExecuteScript(args) {
  if (!args.code) return fail("Provide 'code' for script body.");
  const sess = await getTabSession(args.tabId);
  const wrapped = `(async () => { ${args.code} })()`;
  const result = await cdp("Runtime.evaluate", {
    expression: wrapped,
    returnByValue: true,
    awaitPromise: true,
    generatePreview: true,
    userGesture: true,
  }, sess, LONG_TIMEOUT);
  if (result.exceptionDetails) {
    return fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Script error");
  }
  const v = result.result;
  if (v.type === "undefined") return ok("Script completed (no return value).");
  if (v.value !== undefined) return ok(typeof v.value === "string" ? v.value : JSON.stringify(v.value, null, 2));
  return ok(v.description || "Script completed.");
}

async function handleExecuteCall(args) {
  if (!args.function) return fail("Provide 'function' declaration, e.g. '(el) => el.textContent'.");
  const sess = await getTabSession(args.tabId);
  const { objectId, resolvedSession } = await resolveElementObjectId(sess, args.uid, args.selector);

  const result = await cdp("Runtime.callFunctionOn", {
    functionDeclaration: args.function,
    objectId,
    arguments: [{ objectId }],
    returnByValue: true,
    awaitPromise: true,
  }, resolvedSession);

  if (result.exceptionDetails) {
    return fail(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Call error");
  }
  const v = result.result;
  if (v.type === "undefined") return ok("undefined");
  if (v.value !== undefined) return ok(typeof v.value === "string" ? v.value : JSON.stringify(v.value, null, 2));
  return ok(v.description || String(v));
}

// ─── Observe Handlers ───────────────────────────────────────────────

async function handleObserveConsole(args) {
  const sess = await getTabSession(args.tabId);
  await enableMonitoring(sess, "console");

  let logs = consoleLogs.get(sess) || [];
  if (args.level && args.level !== "all") logs = logs.filter(l => l.level === args.level);
  if (args.last) logs = logs.slice(-args.last);
  if (args.clear) consoleLogs.set(sess, []);
  if (!logs.length) return ok("No console messages captured yet. Interact with the page to generate console output.");

  const lines = logs.map(l => {
    const ts = new Date(l.ts).toLocaleTimeString();
    return `[${ts}] [${l.level.toUpperCase()}] ${l.text.substring(0, 200)}`;
  });
  return ok(`${logs.length} console message(s):\n\n${lines.join("\n")}`);
}

async function handleObserveNetwork(args) {
  const sess = await getTabSession(args.tabId);
  await enableMonitoring(sess, "network");

  const reqMap = networkReqs.get(sess) || new Map();
  let reqs = Array.from(reqMap.values());

  if (args.filter) {
    const f = args.filter.toLowerCase();
    reqs = reqs.filter(r => r.url.toLowerCase().includes(f));
  }
  if (args.types?.length) {
    const types = new Set(args.types.map(t => t.toLowerCase()));
    reqs = reqs.filter(r => types.has((r.type || "").toLowerCase()));
  }
  if (args.last) reqs = reqs.slice(-args.last);
  if (args.clear) networkReqs.set(sess, new Map());
  if (!reqs.length) return ok("No network requests captured yet. Navigate or interact to start capturing.");

  const lines = reqs.map(r => {
    const status = r.status || "pending";
    const size = r.size != null ? `${(r.size / 1024).toFixed(1)}KB` : "?";
    return `[${r.id}] ${r.method} ${status} ${size} ${r.type} ${r.url.substring(0, 120)}`;
  });
  return ok(`${reqs.length} request(s):\n\n${lines.join("\n")}`);
}

async function handleObserveRequest(args) {
  if (!args.requestId) return fail("Provide 'requestId' (from network listing).");
  const sess = await getTabSession(args.tabId);
  await enableMonitoring(sess, "network");

  const reqMap = networkReqs.get(sess) || new Map();
  const reqInfo = reqMap.get(args.requestId);

  const result = { requestId: args.requestId };
  if (reqInfo) {
    result.url = reqInfo.url;
    result.method = reqInfo.method;
    result.status = reqInfo.status;
    result.type = reqInfo.type;
  }

  // Get response body
  try {
    const resp = await cdp("Network.getResponseBody", { requestId: args.requestId }, sess);
    if (resp.base64Encoded) {
      const decoded = Buffer.from(resp.body, "base64");
      if (decoded.length > MAX_INLINE_LEN) {
        const path = writeTempFile(`response-${Date.now()}.bin`, decoded, null, args._agentSessionId);
        result.responseBody = `[Binary, ${decoded.length} bytes, saved to: ${path}]`;
      } else {
        result.responseBody = decoded.toString("utf8");
      }
    } else {
      result.responseBody = resp.body;
    }
  } catch (e) {
    result.responseBody = `[Not available: ${e.message}]`;
  }

  // Get request post data
  try {
    const post = await cdp("Network.getRequestPostData", { requestId: args.requestId }, sess);
    result.requestBody = post.postData;
  } catch {
    result.requestBody = null;
  }

  return ok(result);
}

async function handleObservePerformance(args) {
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Performance");
  const { metrics } = await cdp("Performance.getMetrics", {}, sess);

  const m = {};
  for (const { name, value } of metrics) m[name] = value;

  const fmt = (bytes) => {
    if (bytes > 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
    if (bytes > 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${bytes}B`;
  };

  const lines = [
    `Documents: ${m.Documents || 0} | Frames: ${m.Frames || 0}`,
    `DOM Nodes: ${m.Nodes || 0} | JS Listeners: ${m.JSEventListeners || 0}`,
    `JS Heap: ${fmt(m.JSHeapUsedSize || 0)} / ${fmt(m.JSHeapTotalSize || 0)}`,
    `Layout: ${m.LayoutCount || 0} recalcs, ${((m.LayoutDuration || 0) * 1000).toFixed(1)}ms total`,
    `Style Recalc: ${m.RecalcStyleCount || 0} recalcs, ${((m.RecalcStyleDuration || 0) * 1000).toFixed(1)}ms total`,
    `Scripts: ${((m.ScriptDuration || 0) * 1000).toFixed(1)}ms total`,
    `Tasks: ${((m.TaskDuration || 0) * 1000).toFixed(1)}ms total`,
  ];
  return ok(`Performance Metrics:\n\n${lines.join("\n")}`);
}

async function handleObserveDownloads(args) {
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Page");

  let dl = downloads.get(sess) || [];
  if (args.last) dl = dl.slice(-args.last);
  if (args.clear) downloads.set(sess, []);
  if (!dl.length) return ok("No downloads tracked yet. Downloads are captured automatically when they occur.");

  const lines = dl.map(d => {
    const pct = d.totalBytes > 0 ? ` ${((d.receivedBytes / d.totalBytes) * 100).toFixed(1)}%` : "";
    const size = d.totalBytes > 0 ? ` ${(d.totalBytes / 1024).toFixed(1)}KB` : "";
    return `[${d.state}]${pct}${size} ${d.suggestedFilename} — ${d.url.substring(0, 120)}`;
  });
  return ok(`${dl.length} download(s):\n\n${lines.join("\n")}`);
}

async function handleObserveHar(args) {
  const sess = await getTabSession(args.tabId);
  await enableMonitoring(sess, "network");

  const reqMap = networkReqs.get(sess) || new Map();
  const reqs = Array.from(reqMap.values());
  if (!reqs.length) return ok("No network requests captured yet. Navigate or interact first.");

  // Build HAR 1.2 structure
  const entries = reqs.map(r => ({
    startedDateTime: new Date(r.ts).toISOString(),
    time: 0,
    request: {
      method: r.method || "GET",
      url: r.url,
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      queryString: [],
      headersSize: -1,
      bodySize: -1,
    },
    response: {
      status: r.status || 0,
      statusText: "",
      httpVersion: "HTTP/1.1",
      cookies: [],
      headers: [],
      content: {
        size: r.size || 0,
        mimeType: r.mimeType || "",
      },
      redirectURL: "",
      headersSize: -1,
      bodySize: r.size || -1,
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
  }));

  const har = {
    log: {
      version: "1.2",
      creator: { name: "CDP Browser MCP Server", version: "4.13.0" },
      entries,
    },
  };

  const json = JSON.stringify(har, null, 2);
  if (json.length > MAX_INLINE_LEN) {
    const path = writeTempFile(`har-${Date.now()}.json`, json, "utf8", args._agentSessionId);
    return ok(`HAR exported (${entries.length} entries, ${json.length} chars).\nSaved to: ${path}`);
  }
  return ok(json);
}

// ─── Emulate Handler ────────────────────────────────────────────────

async function handleEmulate(args) {
  const sess = await getTabSession(args.tabId);
  const results = [];

  // Reset all overrides
  if (args.reset) {
    try { await cdp("Emulation.clearDeviceMetricsOverride", {}, sess); } catch { /* ok */ }
    try { await cdp("Emulation.setEmulatedMedia", { features: [] }, sess); } catch { /* ok */ }
    try { await cdp("Emulation.clearGeolocationOverride", {}, sess); } catch { /* ok */ }
    try { await cdp("Emulation.setCPUThrottlingRate", { rate: 1 }, sess); } catch { /* ok */ }
    try { await cdp("Emulation.setTimezoneOverride", { timezoneId: "" }, sess); } catch { /* ok */ }
    try { await cdp("Emulation.setLocaleOverride", { locale: "" }, sess); } catch { /* ok */ }
    try { await cdp("Emulation.setEmulatedVisionDeficiency", { type: "none" }, sess); } catch { /* ok */ }
    try { await cdp("Emulation.clearIdleOverride", {}, sess); } catch { /* ok */ }
    try { await cdp("Emulation.setUserAgentOverride", { userAgent: "" }, sess); } catch { /* ok */ }
    try { await cdp("Emulation.setAutoDarkModeOverride", {}, sess); } catch { /* ok */ }
    try {
      await ensureDomain(sess, "Network");
      await cdp("Network.emulateNetworkConditions", NETWORK_PRESETS.none, sess);
      await cdp("Network.setBlockedURLs", { urls: [] }, sess);
      await cdp("Network.setExtraHTTPHeaders", { headers: {} }, sess);
    } catch { /* ok */ }
    try {
      await ensureDomain(sess, "Security");
      await cdp("Security.setIgnoreCertificateErrors", { ignore: false }, sess);
    } catch { /* ok */ }
    return ok("All emulation overrides reset.");
  }

  if (args.viewport) {
    const v = args.viewport;
    const width = v.landscape ? (v.height || 720) : (v.width || 1280);
    const height = v.landscape ? (v.width || 1280) : (v.height || 720);
    await cdp("Emulation.setDeviceMetricsOverride", {
      width, height,
      deviceScaleFactor: v.deviceScaleFactor || 1,
      mobile: v.mobile || false,
    }, sess);
    if (v.touch) {
      await cdp("Emulation.setTouchEmulationEnabled", { enabled: true }, sess);
    }
    results.push(`Viewport: ${width}x${height}${v.mobile ? " (mobile)" : ""}${v.touch ? " (touch)" : ""}`);
  }

  if (args.colorScheme) {
    if (args.colorScheme === "auto") {
      await cdp("Emulation.setEmulatedMedia", { features: [] }, sess);
    } else {
      await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: args.colorScheme }] }, sess);
    }
    results.push(`Color scheme: ${args.colorScheme}`);
  }

  if (args.userAgent) {
    await cdp("Emulation.setUserAgentOverride", { userAgent: args.userAgent }, sess);
    results.push(`User agent: ${args.userAgent.substring(0, 60)}`);
  }

  if (args.geolocation) {
    const geoParams = {
      latitude: args.geolocation.latitude,
      longitude: args.geolocation.longitude,
      accuracy: args.geolocation.accuracy ?? 100,
    };
    if (args.geolocation.altitude !== undefined) geoParams.altitude = args.geolocation.altitude;
    await cdp("Emulation.setGeolocationOverride", geoParams, sess);
    // Auto-grant geolocation permission so navigator.geolocation works in JS
    let permGranted = false;
    try {
      const { result: originResult } = await cdp("Runtime.evaluate", { expression: "location.origin", returnByValue: true }, sess);
      const origin = originResult?.value;
      // Get browserContextId for the tab to scope the permission grant correctly
      let browserContextId;
      try {
        const { targetInfo } = await cdp("Target.getTargetInfo", { targetId: args.tabId });
        browserContextId = targetInfo?.browserContextId;
      } catch { /* ok */ }
      const grantParams = { permissions: ["geolocation"] };
      if (origin && origin !== "null") grantParams.origin = origin;
      if (browserContextId) grantParams.browserContextId = browserContextId;
      await cdp("Browser.grantPermissions", grantParams);
      // Verify the permission was actually granted
      const { result: permCheck } = await cdp("Runtime.evaluate", {
        expression: "navigator.permissions.query({name:'geolocation'}).then(r=>r.state)",
        returnByValue: true, awaitPromise: true,
      }, sess);
      permGranted = permCheck?.value === "granted";
    } catch { /* ok */ }
    if (!permGranted) {
      // Fallback: try Browser.setPermission (Chrome 93+)
      try {
        const { result: originResult2 } = await cdp("Runtime.evaluate", { expression: "location.origin", returnByValue: true }, sess);
        const origin2 = originResult2?.value;
        const setPermParams = { permission: { name: "geolocation" }, setting: "granted" };
        if (origin2 && origin2 !== "null") setPermParams.origin = origin2;
        await cdp("Browser.setPermission", setPermParams);
        const { result: permCheck2 } = await cdp("Runtime.evaluate", {
          expression: "navigator.permissions.query({name:'geolocation'}).then(r=>r.state)",
          returnByValue: true, awaitPromise: true,
        }, sess);
        permGranted = permCheck2?.value === "granted";
      } catch { /* ok */ }
    }
    if (!permGranted) {
      // Final fallback: inject JS geolocation override directly
      const geoScript = `(function(){
        const _lat=${geoParams.latitude},_lng=${geoParams.longitude},_acc=${geoParams.accuracy},_alt=${geoParams.altitude !== undefined ? geoParams.altitude : 'null'};
        const _pos={coords:{latitude:_lat,longitude:_lng,accuracy:_acc,altitude:_alt,altitudeAccuracy:null,heading:null,speed:null},timestamp:Date.now()};
        const _origGCP=navigator.geolocation.getCurrentPosition.bind(navigator.geolocation);
        const _origWP=navigator.geolocation.watchPosition.bind(navigator.geolocation);
        navigator.geolocation.getCurrentPosition=function(s,e,o){setTimeout(()=>s(_pos),0);};
        navigator.geolocation.watchPosition=function(s,e,o){setTimeout(()=>s(_pos),0);return 1;};
      })();`;
      try {
        await cdp("Runtime.evaluate", { expression: geoScript }, sess);
        // Also inject into new documents
        await ensureDomain(sess, "Page");
        await cdp("Page.addScriptToEvaluateOnNewDocument", { source: geoScript }, sess);
      } catch { /* ok */ }
    }
    let geoMsg = `Geolocation: ${args.geolocation.latitude}, ${args.geolocation.longitude} (accuracy: ${geoParams.accuracy}m`;
    if (geoParams.altitude !== undefined) geoMsg += `, altitude: ${geoParams.altitude}m`;
    geoMsg += ")";
    results.push(geoMsg);
  }

  if (args.cpuThrottle) {
    await cdp("Emulation.setCPUThrottlingRate", { rate: args.cpuThrottle }, sess);
    results.push(`CPU throttle: ${args.cpuThrottle}x`);
  }

  if (args.timezone) {
    await cdp("Emulation.setTimezoneOverride", { timezoneId: args.timezone }, sess);
    results.push(`Timezone: ${args.timezone}`);
  }

  if (args.locale) {
    await cdp("Emulation.setLocaleOverride", { locale: args.locale }, sess);
    results.push(`Locale: ${args.locale}`);
  }

  if (args.visionDeficiency) {
    await cdp("Emulation.setEmulatedVisionDeficiency", { type: args.visionDeficiency }, sess);
    results.push(`Vision deficiency: ${args.visionDeficiency}`);
  }

  if (args.autoDarkMode !== undefined) {
    await cdp("Emulation.setAutoDarkModeOverride", { enabled: args.autoDarkMode }, sess);
    results.push(`Auto dark mode: ${args.autoDarkMode}`);
  }

  if (args.idle) {
    if (args.idle === "active") {
      await cdp("Emulation.setIdleOverride", { isUserActive: true, isScreenUnlocked: true }, sess);
    } else {
      await cdp("Emulation.setIdleOverride", { isUserActive: false, isScreenUnlocked: false }, sess);
    }
    results.push(`Idle state: ${args.idle}`);
  }

  if (args.networkCondition) {
    const preset = NETWORK_PRESETS[args.networkCondition];
    if (!preset) return fail(`Unknown network condition: ${args.networkCondition}. Use: ${Object.keys(NETWORK_PRESETS).join(", ")}`);
    await ensureDomain(sess, "Network");
    await cdp("Network.emulateNetworkConditions", preset, sess);
    results.push(`Network: ${args.networkCondition}`);
  }

  if (args.ignoreSSL !== undefined) {
    await ensureDomain(sess, "Security");
    await cdp("Security.setIgnoreCertificateErrors", { ignore: args.ignoreSSL }, sess);
    results.push(`Ignore SSL: ${args.ignoreSSL}`);
  }

  if (args.blockUrls) {
    await ensureDomain(sess, "Network");
    await cdp("Network.setBlockedURLs", { urls: args.blockUrls }, sess);
    results.push(`Blocked URLs: ${args.blockUrls.length} pattern(s)`);
  }

  if (args.extraHeaders) {
    await ensureDomain(sess, "Network");
    await cdp("Network.setExtraHTTPHeaders", { headers: args.extraHeaders }, sess);
    results.push(`Extra headers: ${Object.keys(args.extraHeaders).join(", ")}`);
  }

  return ok(results.length ? results.join("\n") : "No emulation changes applied.");
}

// ─── Storage Handlers ───────────────────────────────────────────────

async function handleStorageGetCookies(args) {
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Network");
  const params = {};
  if (args.urls?.length) params.urls = args.urls;
  const { cookies } = await cdp("Network.getCookies", params, sess);

  if (!cookies?.length) return ok("No cookies found.");

  const lines = cookies.map(c => {
    const flags = [c.httpOnly && "HttpOnly", c.secure && "Secure", c.sameSite].filter(Boolean).join(", ");
    const exp = c.expires > 0 ? new Date(c.expires * 1000).toISOString() : "session";
    return `${c.name}=${c.value.substring(0, 60)}${c.value.length > 60 ? "..." : ""}\n  Domain: ${c.domain} | Path: ${c.path} | Expires: ${exp} | ${flags}`;
  });
  return ok(`${cookies.length} cookie(s):\n\n${lines.join("\n\n")}`);
}

async function handleStorageSetCookie(args) {
  if (!args.name || args.value === undefined) return fail("Provide 'name' and 'value'.");
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Network");

  const cookieParams = { name: args.name, value: args.value };
  if (args.domain) cookieParams.domain = args.domain;
  if (args.path) cookieParams.path = args.path;
  if (args.secure !== undefined) cookieParams.secure = args.secure;
  if (args.httpOnly !== undefined) cookieParams.httpOnly = args.httpOnly;
  if (args.sameSite) cookieParams.sameSite = args.sameSite;
  if (args.expires) cookieParams.expires = args.expires;

  // If no domain, get from current page
  if (!cookieParams.domain && !cookieParams.url) {
    const urlResult = await cdp("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sess);
    cookieParams.url = urlResult.result.value;
  }

  const { success } = await cdp("Network.setCookie", cookieParams, sess);
  return ok(success ? `Cookie set: ${args.name}=${args.value.substring(0, 40)}` : "Failed to set cookie.");
}

async function handleStorageDeleteCookies(args) {
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Network");

  const params = {};
  if (args.name) params.name = args.name;
  if (args.domain) params.domain = args.domain;
  if (args.url) params.url = args.url;

  if (!params.name) return fail("Provide 'name' to delete specific cookies.");
  // CDP requires at least url or domain
  if (!params.url && !params.domain) {
    const r = await cdp("Runtime.evaluate", { expression: "location.origin", returnByValue: true }, sess);
    const origin = r.result?.value;
    if (origin && origin !== "null") {
      params.url = origin;
      try { params.domain = new URL(origin).hostname; } catch { /* ok */ }
    }
  }
  await cdp("Network.deleteCookies", params, sess);
  return ok(`Deleted cookies matching: ${args.name}${args.domain ? ` (domain: ${args.domain})` : ""}`);
}

async function handleStorageClearCookies(args) {
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Network");
  await cdp("Network.clearBrowserCookies", {}, sess);
  return ok("All cookies cleared.");
}

async function handleStorageClearData(args) {
  const sess = await getTabSession(args.tabId);

  let origin = args.origin;
  if (!origin) {
    const r = await cdp("Runtime.evaluate", { expression: "location.origin", returnByValue: true }, sess);
    origin = r.result.value;
  }

  const storageTypes = args.types === "all"
    ? "cookies,local_storage,indexeddb,cache_storage,service_workers"
    : (args.types || "local_storage,indexeddb,cache_storage");

  await cdp("Storage.clearDataForOrigin", { origin, storageTypes }, sess);
  return ok(`Cleared storage for ${origin}: ${storageTypes}`);
}

async function handleStorageQuota(args) {
  const sess = await getTabSession(args.tabId);

  let origin;
  const r = await cdp("Runtime.evaluate", { expression: "location.origin", returnByValue: true }, sess);
  origin = r.result.value;

  const { usage, quota, usageBreakdown } = await cdp("Storage.getUsageAndQuota", { origin }, sess);

  const fmt = (b) => {
    if (b > 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
    if (b > 1048576) return `${(b / 1048576).toFixed(2)} MB`;
    if (b > 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${b} B`;
  };

  let text = `Storage for ${origin}:\n  Usage: ${fmt(usage)} / ${fmt(quota)} (${(usage / quota * 100).toFixed(2)}%)`;
  if (usageBreakdown?.length) {
    text += "\n\nBreakdown:";
    for (const { storageType, usage: u } of usageBreakdown) {
      if (u > 0) text += `\n  ${storageType}: ${fmt(u)}`;
    }
  }
  return ok(text);
}

// ─── Intercept Handlers ─────────────────────────────────────────────

/**
 * Re-issue Fetch.enable with the unified set of request-stage + response-stage patterns.
 * CDP Fetch.enable REPLACES the entire config — it is NOT additive.
 * Request-stage patterns use CDP glob syntax (from intercept.enable).
 * Response-stage always uses "*" catch-all — JS regex matching in handleEvent does precision filtering.
 */
async function refreshFetchPatterns(sess) {
  const p = fetchPatterns.get(sess) || { request: [], response: [] };
  const allPatterns = [
    ...p.request.map(url => ({ urlPattern: url, requestStage: "Request" })),
    ...(p.response.length > 0 ? [{ urlPattern: "*", requestStage: "Response" }] : []),
  ];
  if (allPatterns.length === 0) {
    try { await cdp("Fetch.disable", {}, sess); } catch { /* ok */ }
  } else {
    try { await cdp("Fetch.enable", { patterns: allPatterns }, sess); } catch { /* session may be stale */ }
  }
}

async function handleInterceptEnable(args) {
  const sess = await getTabSession(args.tabId);
  const patterns = args.patterns || ["*"];

  // Save to unified pattern store (request-stage)
  const p = fetchPatterns.get(sess) || { request: [], response: [] };
  p.request = patterns;
  fetchPatterns.set(sess, p);

  // Re-issue Fetch.enable with ALL patterns (request + response)
  await refreshFetchPatterns(sess);

  if (!pendingFetchRequests.has(sess)) pendingFetchRequests.set(sess, new Map());
  if (!fetchRules.has(sess)) fetchRules.set(sess, []);

  return ok(`Request interception enabled.\nPatterns: ${patterns.join(", ")}\nPaused requests will auto-continue after 10s if not handled.`);
}

async function handleInterceptDisable(args) {
  const sess = await getTabSession(args.tabId);

  // Only clear request-stage patterns — response-stage overrides may still be active
  const p = fetchPatterns.get(sess);
  if (p) p.request = [];
  await refreshFetchPatterns(sess);

  pendingFetchRequests.delete(sess);
  fetchRules.delete(sess);

  const overrideCount = resourceOverrides.get(sess)?.length || 0;
  return ok("Request interception disabled." + (overrideCount ? ` ${overrideCount} response override(s) still active.` : ""));
}

async function handleInterceptContinue(args) {
  if (!args.requestId) return fail("Provide 'requestId'.");
  const sess = await getTabSession(args.tabId);

  const params = { requestId: args.requestId };
  if (args.url) params.url = args.url;
  if (args.method) params.method = args.method;
  if (args.postData) params.postData = Buffer.from(args.postData).toString("base64");
  if (args.headers) {
    params.headers = Object.entries(args.headers).map(([name, value]) => ({ name, value: String(value) }));
  }

  await cdp("Fetch.continueRequest", params, sess);

  const pending = pendingFetchRequests.get(sess);
  if (pending) pending.delete(args.requestId);

  return ok(`Request ${args.requestId} continued${args.url ? ` (redirected to ${args.url})` : ""}.`);
}

async function handleInterceptFulfill(args) {
  if (!args.requestId) return fail("Provide 'requestId'.");
  const sess = await getTabSession(args.tabId);

  const params = {
    requestId: args.requestId,
    responseCode: args.status || 200,
  };

  if (args.headers) {
    params.responseHeaders = Object.entries(args.headers).map(([name, value]) => ({ name, value: String(value) }));
  } else {
    params.responseHeaders = [{ name: "Content-Type", value: "application/json" }];
  }

  if (args.body !== undefined) {
    params.body = Buffer.from(args.body).toString("base64");
  }

  await cdp("Fetch.fulfillRequest", params, sess);

  const pending = pendingFetchRequests.get(sess);
  if (pending) pending.delete(args.requestId);

  return ok(`Request ${args.requestId} fulfilled with status ${params.responseCode}.`);
}

async function handleInterceptFail(args) {
  if (!args.requestId) return fail("Provide 'requestId'.");
  const sess = await getTabSession(args.tabId);

  const reason = args.reason || "Failed";
  await cdp("Fetch.failRequest", { requestId: args.requestId, reason }, sess);

  const pending = pendingFetchRequests.get(sess);
  if (pending) pending.delete(args.requestId);

  return ok(`Request ${args.requestId} failed with reason: ${reason}.`);
}

async function handleInterceptList(args) {
  const sess = await getTabSession(args.tabId);
  const pending = pendingFetchRequests.get(sess) || new Map();

  if (pending.size === 0) return ok("No pending intercepted requests.");

  const lines = Array.from(pending.values()).map(r => {
    const age = ((Date.now() - r.ts) / 1000).toFixed(1);
    return `[${r.requestId}] ${r.method} ${r.url.substring(0, 100)} (${r.resourceType}, ${age}s ago)`;
  });
  return ok(`${pending.size} pending request(s):\n\n${lines.join("\n")}`);
}

// ─── Debug Handlers ─────────────────────────────────────────────────

async function handleDebugEnable(args) {
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Debugger");
  return ok("Debugger enabled. Scripts are being tracked. Set breakpoints with set_breakpoint.");
}

async function handleDebugDisable(args) {
  const sess = await getTabSession(args.tabId);
  try { await cdp("Debugger.disable", {}, sess); } catch { /* ok */ }
  const doms = enabledDomains.get(sess);
  if (doms) doms.delete("Debugger");
  pausedTabs.delete(sess);
  parsedScripts.delete(sess);
  activeBreakpoints.delete(sess);
  return ok("Debugger disabled.");
}

async function handleDebugSetBreakpoint(args) {
  if (args.url === undefined || args.lineNumber === undefined) return fail("Provide 'url' and 'lineNumber'.");
  const sess = await getTabSession(args.tabId);
  await ensureDomain(sess, "Debugger");
  const params = { url: args.url, lineNumber: args.lineNumber };
  if (args.columnNumber !== undefined) params.columnNumber = args.columnNumber;
  if (args.condition) params.condition = args.condition;
  const result = await cdp("Debugger.setBreakpointByUrl", params, sess);
  const bps = activeBreakpoints.get(sess) || new Map();
  bps.set(result.breakpointId, { url: args.url, lineNumber: args.lineNumber, columnNumber: args.columnNumber, condition: args.condition });
  activeBreakpoints.set(sess, bps);
  const locs = (result.locations || []).map(l => `  ${l.scriptId}:${l.lineNumber}:${l.columnNumber || 0}`).join("\n");
  return ok(`Breakpoint set: ${result.breakpointId}\nResolved locations:\n${locs || "  (none yet — will resolve when matching script loads)"}`);
}

async function handleDebugRemoveBreakpoint(args) {
  if (!args.breakpointId) return fail("Provide 'breakpointId'.");
  const sess = await getTabSession(args.tabId);
  await cdp("Debugger.removeBreakpoint", { breakpointId: args.breakpointId }, sess);
  const bps = activeBreakpoints.get(sess);
  if (bps) bps.delete(args.breakpointId);
  return ok(`Breakpoint removed: ${args.breakpointId}`);
}

async function handleDebugListBreakpoints(args) {
  const sess = await getTabSession(args.tabId);
  const bps = activeBreakpoints.get(sess) || new Map();
  if (bps.size === 0) return ok("No active breakpoints.");
  const lines = [...bps.entries()].map(([id, bp]) => {
    const cond = bp.condition ? ` [if: ${bp.condition}]` : "";
    return `[${id}] ${bp.url}:${bp.lineNumber}${bp.columnNumber !== undefined ? `:${bp.columnNumber}` : ""}${cond}`;
  });
  return ok(`${bps.size} breakpoint(s):\n\n${lines.join("\n")}`);
}

async function handleDebugPause(args) {
  const sess = await getTabSession(args.tabId);
  await cdp("Debugger.pause", {}, sess);
  return ok("Pause requested. Execution will halt at the next statement.");
}

async function handleDebugResume(args) {
  const sess = await getTabSession(args.tabId);
  await cdp("Debugger.resume", {}, sess);
  pausedTabs.delete(sess);
  return ok("Resumed execution.");
}

async function handleDebugStepOver(args) {
  const sess = await getTabSession(args.tabId);
  await cdp("Debugger.stepOver", {}, sess);
  return ok("Stepped over. Waiting for next pause...");
}

async function handleDebugStepInto(args) {
  const sess = await getTabSession(args.tabId);
  await cdp("Debugger.stepInto", {}, sess);
  return ok("Stepped into. Waiting for next pause...");
}

async function handleDebugStepOut(args) {
  const sess = await getTabSession(args.tabId);
  await cdp("Debugger.stepOut", {}, sess);
  return ok("Stepped out. Waiting for next pause...");
}

async function handleDebugCallStack(args) {
  const sess = await getTabSession(args.tabId);
  const paused = pausedTabs.get(sess);
  if (!paused) return fail("Debugger is not paused. Use 'pause' or set a breakpoint first.");
  const frames = paused.callFrames || [];
  if (!frames.length) return ok("Paused but no call frames available.");
  const sections = frames.slice(0, 10).map((f, i) => {
    let section = `#${i} ${f.functionName || "(anonymous)"}\n  ${f.url}:${f.location.lineNumber}:${f.location.columnNumber || 0}`;
    if (i < 3 && f.scopeChain) {
      const localScope = f.scopeChain.find(s => s.type === "local");
      if (localScope && localScope.object?.objectId) {
        section += "\n  Local vars: (use evaluate_on_frame to inspect)";
      }
    }
    return section;
  });
  const hitBps = paused.hitBreakpoints?.length ? `\nHit breakpoints: ${paused.hitBreakpoints.join(", ")}` : "";
  return ok(`Paused: ${paused.reason}${hitBps}\n\nCall stack (${frames.length} frames):\n\n${sections.join("\n\n")}`);
}

async function handleDebugEvaluateOnFrame(args) {
  if (!args.expression) return fail("Provide 'expression'.");
  const sess = await getTabSession(args.tabId);
  const paused = pausedTabs.get(sess);
  if (!paused) return fail("Debugger is not paused.");
  const frameIndex = args.frameIndex || 0;
  const frame = paused.callFrames?.[frameIndex];
  if (!frame) return fail(`Frame index ${frameIndex} out of range (${paused.callFrames?.length || 0} frames).`);
  const result = await cdp("Debugger.evaluateOnCallFrame", {
    callFrameId: frame.callFrameId,
    expression: args.expression,
    returnByValue: true,
  }, sess);
  if (result.exceptionDetails) {
    return fail(`Evaluation error: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
  }
  const val = result.result;
  let display;
  if (val.type === "object" && val.value !== undefined) {
    display = JSON.stringify(val.value, null, 2);
  } else if (val.type === "undefined") {
    display = "undefined";
  } else {
    display = val.description || val.value?.toString() || val.type;
  }
  return ok(`[frame #${frameIndex}] ${args.expression} = ${display}`);
}

async function handleDebugListScripts(args) {
  const sess = await getTabSession(args.tabId);
  const scripts = parsedScripts.get(sess) || new Map();
  if (scripts.size === 0) return ok("No scripts tracked. Call 'enable' first, then reload the page.");
  const entries = [...scripts.entries()].filter(([, s]) => s.url);
  const lines = entries.slice(0, 50).map(([id, s]) => `[${id}] ${s.url} (lines ${s.startLine}-${s.endLine})`);
  return ok(`${entries.length} script(s)${entries.length > 50 ? " (showing first 50)" : ""}:\n\n${lines.join("\n")}`);
}

async function handleDebugGetSource(args) {
  if (!args.scriptId) return fail("Provide 'scriptId'.");
  const sess = await getTabSession(args.tabId);
  const result = await cdp("Debugger.getScriptSource", { scriptId: args.scriptId }, sess);
  const source = result.scriptSource || "";
  return ok(`Script ${args.scriptId} (${source.length} chars):\n\n${source}`);
}

// ── Resource Override Handlers ──

async function handleDebugOverrideResource(args) {
  if (!args.urlPattern) return fail("Provide 'urlPattern' (regex pattern to match response URLs).");
  const sess = await getTabSession(args.tabId);
  try { new RegExp(args.urlPattern, "i"); } catch (e) { return fail(`Invalid regex: ${e.message}`); }
  const override = {
    urlPattern: args.urlPattern,
    responseCode: args.responseCode || 200,
    headers: args.headers
      ? Object.entries(args.headers).map(([name, value]) => ({ name, value: String(value) }))
      : [{ name: "Content-Type", value: "text/html" }],
    body: args.body || "",
  };
  const overrides = resourceOverrides.get(sess) || [];
  const idx = overrides.findIndex(o => o.urlPattern === args.urlPattern);
  if (idx >= 0) overrides[idx] = override;
  else overrides.push(override);
  resourceOverrides.set(sess, overrides);
  const p = fetchPatterns.get(sess) || { request: [], response: [] };
  if (!p.response.includes(args.urlPattern)) {
    p.response.push(args.urlPattern);
    fetchPatterns.set(sess, p);
  }
  await refreshFetchPatterns(sess);
  return ok(`Resource override registered.\nPattern: ${args.urlPattern}\nStatus: ${override.responseCode}\nBody: ${override.body.length} chars\nMatching responses will be replaced automatically.`);
}

async function handleDebugRemoveOverride(args) {
  if (!args.urlPattern) return fail("Provide 'urlPattern'.");
  const sess = await getTabSession(args.tabId);
  const overrides = resourceOverrides.get(sess) || [];
  const idx = overrides.findIndex(o => o.urlPattern === args.urlPattern);
  if (idx < 0) return fail(`No override found for pattern: ${args.urlPattern}`);
  overrides.splice(idx, 1);
  const p = fetchPatterns.get(sess);
  if (p) {
    p.response = p.response.filter(pat => pat !== args.urlPattern);
    await refreshFetchPatterns(sess);
  }
  return ok(`Override removed: ${args.urlPattern}\n${overrides.length} override(s) remaining.`);
}

async function handleDebugListOverrides(args) {
  const sess = await getTabSession(args.tabId);
  const overrides = resourceOverrides.get(sess) || [];
  if (overrides.length === 0) return ok("No active resource overrides.");
  const lines = overrides.map((o, i) => `${i + 1}. ${o.urlPattern} → ${o.responseCode} (${o.body.length} chars)`);
  return ok(`${overrides.length} override(s):\n\n${lines.join("\n")}`);
}

// ── DOM/Event Breakpoint Handlers ──

async function handleDebugSetDomBreakpoint(args) {
  if (args.uid === undefined) return fail("Provide 'uid' (element ref from snapshot).");
  if (!args.type) return fail("Provide 'type': 'subtree-modified', 'attribute-modified', or 'node-removed'.");
  const sess = await getTabSession(args.tabId);
  const map = refMaps.get(sess);
  const backendNodeId = map?.get(args.uid);
  if (!backendNodeId) return fail(`Element ref=${args.uid} not found. Take a fresh snapshot.`);
  await cdp("DOM.getDocument", { depth: 0 }, sess);
  const { nodeIds } = await cdp("DOM.pushNodesByBackendIds", { backendNodeIds: [backendNodeId] }, sess);
  const nodeId = nodeIds?.[0];
  if (!nodeId) return fail(`Cannot resolve DOM nodeId for ref=${args.uid}. The element may have been removed.`);
  await cdp("DOMDebugger.setDOMBreakpoint", { nodeId, type: args.type }, sess);
  return ok(`DOM breakpoint set: ${args.type} on ref=${args.uid} (nodeId=${nodeId})\nExecution will pause when this node is ${args.type === "subtree-modified" ? "or its children are modified" : args.type === "attribute-modified" ? "has attributes changed" : "removed from DOM"}.`);
}

async function handleDebugRemoveDomBreakpoint(args) {
  if (args.uid === undefined) return fail("Provide 'uid'.");
  if (!args.type) return fail("Provide 'type'.");
  const sess = await getTabSession(args.tabId);
  const map = refMaps.get(sess);
  const backendNodeId = map?.get(args.uid);
  if (!backendNodeId) return fail(`Element ref=${args.uid} not found. Take a fresh snapshot.`);
  await cdp("DOM.getDocument", { depth: 0 }, sess);
  const { nodeIds } = await cdp("DOM.pushNodesByBackendIds", { backendNodeIds: [backendNodeId] }, sess);
  const nodeId = nodeIds?.[0];
  if (!nodeId) return fail(`Cannot resolve DOM nodeId for ref=${args.uid}.`);
  await cdp("DOMDebugger.removeDOMBreakpoint", { nodeId, type: args.type }, sess);
  return ok(`DOM breakpoint removed: ${args.type} on ref=${args.uid}`);
}

async function handleDebugSetEventBreakpoint(args) {
  if (!args.eventName) return fail("Provide 'eventName' (e.g. 'click', 'xhr', 'setTimeout').");
  const sess = await getTabSession(args.tabId);
  await cdp("DOMDebugger.setEventListenerBreakpoint", { eventName: args.eventName }, sess);
  return ok(`Event breakpoint set: ${args.eventName}\nExecution will pause when a '${args.eventName}' event fires.`);
}

async function handleDebugRemoveEventBreakpoint(args) {
  if (!args.eventName) return fail("Provide 'eventName'.");
  const sess = await getTabSession(args.tabId);
  await cdp("DOMDebugger.removeEventListenerBreakpoint", { eventName: args.eventName }, sess);
  return ok(`Event breakpoint removed: ${args.eventName}`);
}

// ─── Browser Handlers ───────────────────────────────────────────────

async function handleBrowserProfiles() {
  const instances = discoverChromeInstances();
  if (!instances.length) {
    return ok("No Chrome instances found with remote debugging enabled.\nLaunch Chrome with --remote-debugging-port=9222 or enable chrome://flags/#enable-remote-debugging");
  }
  const sections = instances.map(inst => {
    const connTag = inst.connected ? " [CONNECTED]" : "";
    let section = `${inst.name}${connTag}\n  Port: ${inst.port}\n  User Data: ${inst.userDataDir}`;
    if (inst.profiles.length) {
      section += `\n  Profiles (${inst.profiles.length}):`;
      for (const p of inst.profiles) {
        const email = p.email ? ` (${p.email})` : "";
        section += `\n    ${p.directory}: ${p.name}${email}`;
      }
    }
    return section;
  });
  return ok(`Chrome instances: ${instances.length}\n\n${sections.join("\n\n")}`);
}

async function handleBrowserConnect(args) {
  if (!args.instance) return fail("Provide 'instance' — name (e.g. 'Chrome'), port number (e.g. '9333'), or User Data directory path.");

  // Guard: reject if other agent sessions are active
  const otherSessions = [...agentSessions.entries()].filter(([id]) => id !== args._agentSessionId);
  const activeSids = otherSessions.filter(([, s]) => s.tabIds.size > 0);
  if (activeSids.length > 0) {
    const ids = activeSids.map(([id, s]) => `${id.substring(0, 8)}… (${s.tabIds.size} tabs)`).join(", ");
    return fail(`Cannot switch — ${activeSids.length} other session(s) with active tabs: ${ids}. End them first with cleanup.session.`);
  }

  // Find the target instance
  const instances = discoverChromeInstances();
  const input = args.instance.toString().trim();
  const target = instances.find(inst =>
    inst.name.toLowerCase() === input.toLowerCase() ||
    inst.port.toString() === input ||
    inst.userDataDir.toLowerCase() === input.toLowerCase()
  );
  if (!target) {
    const available = instances.map(i => `${i.name} (port ${i.port})`).join(", ") || "none found";
    return fail(`Chrome instance "${input}" not found. Available: ${available}`);
  }
  if (target.connected) {
    return ok(`Already connected to ${target.name} (port ${target.port}).`);
  }

  // Clear caller's session state — tabs from old browser are invalid
  const callerSession = agentSessions.get(args._agentSessionId);
  if (callerSession) {
    callerSession.tabIds.clear();
    agentSessions.delete(args._agentSessionId);
  }
  tabLocks.clear();
  agentSessions.clear();

  // Disconnect current browser — wait for close event, not a blind timer
  if (browserWs && browserWs.readyState !== WebSocket.CLOSED) {
    const oldWs = browserWs;
    await new Promise(resolve => {
      oldWs.once("close", resolve);
      oldWs.close();
    });
  }

  // Connect to new instance — override the User Data dir, NOT the full WS URL
  overrideUserDataDir = target.userDataDir;
  await connectBrowser();
  activeConnectionInfo = { name: target.name, userDataDir: target.userDataDir, port: target.port, wsUrl: browserWs?.url };

  return ok(`Connected to ${target.name}\nPort: ${target.port}\nUser Data: ${target.userDataDir}\nProfiles: ${target.profiles.map(p => p.name).join(", ") || "unknown"}`);
}

async function handleBrowserActive() {
  if (!browserWs || browserWs.readyState !== WebSocket.OPEN) {
    return ok("Not connected to any Chrome instance.");
  }

  const info = activeConnectionInfo || {};
  let text = `Connected to: ${info.name || "unknown"}\n`;
  text += `Port: ${info.port || "unknown"}\n`;
  text += `User Data: ${info.userDataDir || "unknown"}\n`;
  text += `WebSocket: ${info.wsUrl || browserWs.url || "unknown"}\n`;
  text += `Health: ${connectionHealth.status}\n`;

  // Show profiles from Local State
  if (info.userDataDir) {
    try {
      const localState = JSON.parse(readFileSync(join(info.userDataDir, "Local State"), "utf8"));
      const cache = localState?.profile?.info_cache || {};
      const profiles = Object.entries(cache).map(([dir, p]) => `${p.name || dir}${p.user_name ? ` (${p.user_name})` : ""}`);
      if (profiles.length) text += `Profiles: ${profiles.join(", ")}\n`;
    } catch { /* ok */ }
  }

  // Show tab count per browserContextId (profile grouping) with profile name resolution
  try {
    const { targetInfos } = await cdp("Target.getTargets", { filter: [{ type: "page" }] });
    if (targetInfos?.length) {
      const byContext = {};
      for (const t of targetInfos) {
        const ctx = t.browserContextId || "default";
        byContext[ctx] = (byContext[ctx] || 0) + 1;
      }
      // Try to map browserContextIds to profile names
      let profileNames = {};
      if (info.userDataDir) {
        try {
          const ls = JSON.parse(readFileSync(join(info.userDataDir, "Local State"), "utf8"));
          const cache = ls?.profile?.info_cache || {};
          const profiles = Object.entries(cache).map(([dir, p]) => ({ dir, name: p.name || dir, email: p.user_name || "" }));
          const sortedContexts = Object.keys(byContext).sort();
          for (let i = 0; i < Math.min(profiles.length, sortedContexts.length); i++) {
            profileNames[sortedContexts[i]] = profiles[i].name + (profiles[i].email ? ` (${profiles[i].email})` : "");
          }
        } catch { /* ok */ }
      }
      text += `\nTabs by profile:\n`;
      for (const [ctx, count] of Object.entries(byContext)) {
        const pName = profileNames[ctx] || ctx.substring(0, 12) + "…";
        text += `  ${pName} — ${count} tab(s) [context: ${ctx.substring(0, 12)}…]\n`;
      }
    }
  } catch { /* ok */ }

  return ok(text);
}

// ─── Cleanup Handlers ───────────────────────────────────────────────

async function handleCleanupDisconnectTab(args) {
  if (!args.tabId) return fail("Provide 'tabId'.");
  // Only allow disconnecting tabs this session owns or unowned tabs
  // No exclusive:false override — detaching is destructive (kills CDP session + clears all state)
  const lockOwner = tabLocks.get(args.tabId);
  if (lockOwner?.sessionId && lockOwner.sessionId !== args._agentSessionId) {
    return fail(`Tab [${args.tabId}] is locked by another session. Cannot disconnect.`);
  }
  await detachTab(args.tabId);
  return ok("Detached from tab.");
}

async function handleCleanupDisconnectAll(args) {
  const ids = [...activeSessions.keys()];
  let count = 0;
  let skipped = 0;
  for (const id of ids) {
    // Only disconnect tabs caller owns or unowned tabs
    const lockOwner = tabLocks.get(id);
    if (!lockOwner || lockOwner.sessionId === args._agentSessionId) {
      await detachTab(id);
      count++;
    } else {
      skipped++;
    }
  }
  return ok(`Disconnected from ${count} tab(s).${skipped ? ` ${skipped} locked tab(s) skipped.` : ""}`);
}

async function handleCleanupCleanTemp(args) {
  if (!existsSync(TEMP_DIR)) return ok("No temp directory.");
  const prefix = args._agentSessionId ? args._agentSessionId.substring(0, 8) + "_" : null;
  const files = readdirSync(TEMP_DIR);
  let count = 0;
  for (const f of files) {
    // Only delete files belonging to this session, or unprefixed legacy files
    if (!prefix || f.startsWith(prefix) || !f.match(/^[a-f0-9]{8}_/)) {
      try { unlinkSync(join(TEMP_DIR, f)); count++; } catch { /* ok */ }
    }
  }
  return ok(`Cleaned up ${count} temp file(s) from ${TEMP_DIR}`);
}

async function handleCleanupListSessions() {
  // Expire stale sessions first (with proper cleanup)
  await sweepStaleSessions();
  if (agentSessions.size === 0) return ok("No active agent sessions.");

  // Fetch all tabs once for URL lookup
  let allTabs = [];
  try { allTabs = await getTabs(); } catch { /* ok */ }
  const tabMap = new Map();
  for (const t of allTabs) tabMap.set(t.targetId, t);

  const now = Date.now();
  const sections = [];
  for (const [id, s] of agentSessions) {
    const age = ((now - s.lastActivity) / 1000).toFixed(0);
    const ttl = Math.max(0, ((SESSION_TTL - (now - s.lastActivity)) / 1000)).toFixed(0);
    const ownedTabs = [...s.tabIds].filter(tid => tabLocks.get(tid)?.sessionId === id);
    const borrowedTabs = [...s.tabIds].filter(tid => tabLocks.get(tid)?.sessionId !== id);
    let section = `Session: ${id.substring(0, 8)}\u2026\n  Last activity: ${age}s ago | TTL remaining: ${ttl}s\n  Cleanup strategy: ${s.cleanupStrategy || "detach"}\n  Owned tabs: ${ownedTabs.length}`;
    if (ownedTabs.length) {
      for (const tid of ownedTabs) {
        const tab = tabMap.get(tid);
        const lock = tabLocks.get(tid);
        const originTag = lock ? ` (${lock.origin})` : "";
        section += `\n    [${tid}]${originTag} ${tab ? tab.url : "(unknown)"}`;
      }
    }
    if (borrowedTabs.length) {
      section += `\n  Borrowed tabs: ${borrowedTabs.length}`;
      for (const tid of borrowedTabs) {
        const tab = tabMap.get(tid);
        section += `\n    [${tid}] ${tab ? tab.url : "(unknown)"}`;
      }
    }
    sections.push(section);
  }
  return ok(
    `Agent sessions: ${agentSessions.size}\n` +
    `Session TTL: ${SESSION_TTL / 1000}s\n\n` +
    sections.join("\n\n")
  );
}

/**
 * Explicitly end an agent session and clean up its owned tabs.
 * Self-terminate only — sessions cannot terminate other sessions.
 * TTL sweep handles cleanup of expired sessions automatically.
 * browser.connect wipes all sessions when switching Chrome instances.
 */
async function handleCleanupSession(args) {
  // Always terminate caller's own session — targetSessionId is removed
  // to prevent cross-session termination in multi-subagent workflows
  const sid = args._agentSessionId;
  const session = agentSessions.get(sid);
  if (!session) return fail(`No session found.`);

  const strategy = args.cleanupStrategy || session.cleanupStrategy || "detach";
  let cleaned = 0;
  for (const tid of session.tabIds) {
    const lock = tabLocks.get(tid);
    if (!lock || lock.sessionId !== sid) continue; // skip borrowed

    if (lock.origin === "claimed") {
      // Pre-existing tabs: release lock + detach, never close
      await detachTab(tid);
      cleaned++;
    } else {
      // Created tabs: apply cleanup strategy
      if (strategy === "none") {
        // "none" means don't detach or close, but we MUST release the lock
        // since the session is being explicitly destroyed — otherwise ghost locks
        tabLocks.delete(tid);
      } else {
        try { await cleanupTab(tid, strategy); } catch { /* ok */ }
      }
      cleaned++;
    }
  }
  // Clear all tab references (including borrowed) and delete session
  session.tabIds.clear();
  agentSessions.delete(sid);
  return ok(`Session ${sid.substring(0, 8)}\u2026 ended. ${cleaned} owned tab(s) ${strategy === "close" ? "closed" : strategy === "none" ? "released (tabs preserved)" : "detached"}.`);
}

/**
 * Reset: terminate ALL sessions and release all tab locks.
 * Created tabs can optionally be closed; pre-existing (claimed) tabs are NEVER closed.
 */
async function handleCleanupReset(args) {
  const closeTabs = args.closeTabs || false;
  let closedCount = 0, detachedCount = 0, preservedCount = 0;

  for (const [id, s] of agentSessions) {
    for (const tid of s.tabIds) {
      const lock = tabLocks.get(tid);
      if (!lock || lock.sessionId !== id) continue; // skip borrowed or unowned

      if (lock.origin === "claimed") {
        // NEVER close pre-existing tabs — release lock + detach only
        await detachTab(tid);
        preservedCount++;
      } else if (lock.origin === "created" && closeTabs) {
        try { await cleanupTab(tid, "close"); } catch { /* ok */ }
        closedCount++;
      } else {
        await detachTab(tid);
        detachedCount++;
      }
    }
    s.tabIds.clear();
  }
  const sessionCount = agentSessions.size;
  agentSessions.clear();
  tabLocks.clear();

  return ok(`Reset complete. ${sessionCount} session(s) cleared.\n` +
    `Created tabs: ${closeTabs ? closedCount + " closed" : detachedCount + " detached"}\n` +
    `Pre-existing tabs: ${preservedCount} preserved (never closed)`);
}

async function handleCleanupStatus() {
  const tabs = await getTabs();
  const connInfo = activeConnectionInfo
    ? `Chrome instance: ${activeConnectionInfo.name} (port ${activeConnectionInfo.port})\n  User Data: ${activeConnectionInfo.userDataDir}`
    : `Chrome instance: auto-detected (port ${CDP_PORT})`;
  const tabList = tabs.slice(0, 10).map(t => {
    const c = activeSessions.has(t.targetId) ? " [connected]" : "";
    return `  ${t.targetId}${c} — ${t.title || "(untitled)"}`;
  }).join("\n");
  const more = tabs.length > 10 ? `\n  ... and ${tabs.length - 10} more` : "";
  return ok(
    `${connInfo}\n` +
    `Browser tabs: ${tabs.length}\n` +
    `Connected sessions: ${activeSessions.size}\n` +
    `Pending dialogs: ${[...pendingDialogs.values()].reduce((s, d) => s + d.length, 0)}\n` +
    `Pending intercepts: ${[...pendingFetchRequests.values()].reduce((s, m) => s + m.size, 0)}\n` +
    `Active downloads: ${[...downloads.values()].reduce((s, d) => s + d.filter(x => x.state === "inProgress").length, 0)}\n` +
    `Connection health: ${connectionHealth.status} (failures: ${connectionHealth.failures})\n` +
    `Temp dir: ${TEMP_DIR}\n` +
    `Temp files: ${existsSync(TEMP_DIR) ? readdirSync(TEMP_DIR).length : 0}\n` +
    `\nRecent tabs:\n${tabList}${more}`
  );
}

// ═══════════════════════════════════════════════════════════════════
//  HANDLER DISPATCH MAP
// ═══════════════════════════════════════════════════════════════════

const HANDLERS = {
  tabs: {
    list: handleTabsList,
    find: handleTabsFind,
    new: handleTabsNew,
    close: handleTabsClose,
    activate: handleTabsActivate,
    info: handleTabsInfo,
  },
  page: {
    goto: handlePageGoto,
    back: handlePageBack,
    forward: handlePageForward,
    reload: handlePageReload,
    snapshot: handlePageSnapshot,
    screenshot: handlePageScreenshot,
    content: handlePageContent,
    wait: handlePageWait,
    pdf: handlePagePdf,
    dialog: handlePageDialog,
    inject: handlePageInject,
    add_style: handlePageAddStyle,
    bypass_csp: handlePageBypassCsp,
    set_content: handlePageSetContent,
    frames: handlePageFrames,
  },
  interact: {
    click: handleInteractClick,
    hover: handleInteractHover,
    type: handleInteractType,
    fill: handleInteractFill,
    select: handleInteractSelect,
    press: handleInteractPress,
    drag: handleInteractDrag,
    scroll: handleInteractScroll,
    upload: handleInteractUpload,
    focus: handleInteractFocus,
    check: handleInteractCheck,
    tap: handleInteractTap,
  },
  execute: {
    eval: handleExecuteEval,
    script: handleExecuteScript,
    call: handleExecuteCall,
  },
  observe: {
    console: handleObserveConsole,
    network: handleObserveNetwork,
    request: handleObserveRequest,
    performance: handleObservePerformance,
    downloads: handleObserveDownloads,
    har: handleObserveHar,
  },
  emulate: handleEmulate,
  storage: {
    get_cookies: handleStorageGetCookies,
    set_cookie: handleStorageSetCookie,
    delete_cookies: handleStorageDeleteCookies,
    clear_cookies: handleStorageClearCookies,
    clear_data: handleStorageClearData,
    quota: handleStorageQuota,
  },
  intercept: {
    enable: handleInterceptEnable,
    disable: handleInterceptDisable,
    continue: handleInterceptContinue,
    fulfill: handleInterceptFulfill,
    fail: handleInterceptFail,
    list: handleInterceptList,
  },
  cleanup: {
    disconnect_tab: handleCleanupDisconnectTab,
    disconnect_all: handleCleanupDisconnectAll,
    clean_temp: handleCleanupCleanTemp,
    status: handleCleanupStatus,
    list_sessions: handleCleanupListSessions,
    session: handleCleanupSession,
    reset: handleCleanupReset,
  },
  browser: {
    profiles: handleBrowserProfiles,
    connect: handleBrowserConnect,
    active: handleBrowserActive,
  },
  debug: {
    enable: handleDebugEnable,
    disable: handleDebugDisable,
    set_breakpoint: handleDebugSetBreakpoint,
    remove_breakpoint: handleDebugRemoveBreakpoint,
    list_breakpoints: handleDebugListBreakpoints,
    pause: handleDebugPause,
    resume: handleDebugResume,
    step_over: handleDebugStepOver,
    step_into: handleDebugStepInto,
    step_out: handleDebugStepOut,
    call_stack: handleDebugCallStack,
    evaluate_on_frame: handleDebugEvaluateOnFrame,
    list_scripts: handleDebugListScripts,
    get_source: handleDebugGetSource,
    override_resource: handleDebugOverrideResource,
    remove_override: handleDebugRemoveOverride,
    list_overrides: handleDebugListOverrides,
    set_dom_breakpoint: handleDebugSetDomBreakpoint,
    remove_dom_breakpoint: handleDebugRemoveDomBreakpoint,
    set_event_breakpoint: handleDebugSetEventBreakpoint,
    remove_event_breakpoint: handleDebugRemoveEventBreakpoint,
  },
};

async function handleTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) return fail(`Unknown tool: ${name}`);

  // ── Per-agent session routing (auto-assigned per process, or explicit) ──
  const sessionId = args.sessionId || processSessionId;
  delete args.sessionId; // don't pass down to handlers
  const cleanupStrategy = args.cleanupStrategy;
  delete args.cleanupStrategy;
  const exclusive = args.exclusive;
  delete args.exclusive;
  const now = Date.now();

  // Expire stale sessions and clean up their owned tabs
  await sweepStaleSessions();

  // Get or create session
  let session = agentSessions.get(sessionId);
  if (!session) {
    session = { lastActivity: now, tabIds: new Set(), cleanupStrategy: cleanupStrategy || "detach", browserContextId: null };
    agentSessions.set(sessionId, session);
  }
  session.lastActivity = now;
  // Update cleanup strategy if provided (sticky — persists for session lifetime)
  if (cleanupStrategy) session.cleanupStrategy = cleanupStrategy;

  // Inject session context into args for handlers that need it (e.g. handleTabsNew, handleCleanupSession)
  args._agentSession = session;
  args._agentSessionId = sessionId;
  // Re-inject stripped values so cleanup handlers can use them for per-call overrides
  if (cleanupStrategy) args.cleanupStrategy = cleanupStrategy;
  if (exclusive !== undefined) args.exclusive = exclusive;

  // Track tab association with exclusive lock check
  if (args.tabId) {
    const lockOwner = tabLocks.get(args.tabId);
    if (lockOwner?.sessionId && lockOwner.sessionId !== sessionId && exclusive !== false) {
      delete args._agentSession;
      delete args._agentSessionId;
      return fail(`Tab [${args.tabId}] is locked by another agent session. Use exclusive:false to override.`);
    }
    session.tabIds.add(args.tabId);
    // Only set lock if tab is unowned — never overwrite another session's lock
    if (!lockOwner) {
      tabLocks.set(args.tabId, { sessionId, origin: "claimed" });
    }
    // Auto-detect profile: pin session to Chrome profile of first claimed tab
    if (!session.browserContextId) {
      try {
        const tabs = await getTabs();
        const tab = tabs.find(t => t.targetId === args.tabId);
        if (tab?.browserContextId) session.browserContextId = tab.browserContextId;
      } catch { /* best-effort profile detection */ }
    }
  }

  // For tab listing, enforce session ownership (filter to session tabs unless showAll)
  if (name === "tabs" && args.action === "list" && session.tabIds.size > 0 && !args.showAll) {
    const allTabs = await getTabs();
    const ownedTabs = allTabs.filter(t => session.tabIds.has(t.targetId));
    if (!ownedTabs.length) {
      delete args._agentSession;
      delete args._agentSessionId;
      return ok("No session-owned tabs. Use showAll: true to see all browser tabs.");
    }
    const lines = ownedTabs.map((t, i) => {
      const c = activeSessions.has(t.targetId) ? " [connected]" : "";
      const lockOwner = tabLocks.get(t.targetId);
      const lockTag = lockOwner?.sessionId && lockOwner.sessionId !== sessionId ? ` [locked by: ${lockOwner.sessionId.substring(0, 8)}…]` : "";
      return `${i + 1}. [${t.targetId}]${c}${lockTag}\n   ${t.title}\n   ${t.url}`;
    });
    delete args._agentSession;
    delete args._agentSessionId;
    return ok(`[session: ${sessionId.substring(0, 8)}…] ${ownedTabs.length} tab(s):\n\n${lines.join("\n\n")}`);
  }

  // ── Modal state guard ──
  // If a JavaScript dialog is pending on the target tab, block all actions except page.dialog
  if (args.tabId) {
    const sid = activeSessions.get(args.tabId);
    if (sid) {
      const dialogs = pendingDialogs.get(sid) || [];
      if (dialogs.length > 0 && !(name === "page" && args.action === "dialog")) {
        const d = dialogs[0];
        delete args._agentSession;
        delete args._agentSessionId;
        return fail(
          `A JavaScript dialog is blocking the page. Handle it first.\n` +
          `Dialog: ${d.type} "${d.message.substring(0, 100)}"\n` +
          `→ Use page tool with action: 'dialog', tabId: '${args.tabId}', accept: true/false`
        );
      }
    }
  }

  // ── Debugger pause guard ──
  // If debugger is paused on the target tab, block non-debug tool calls
  // Allow ALL debug actions (read-only inspection + override management are debugger-independent)
  // Also allow page.dialog since dialogs can fire while paused and must be dismissible
  if (args.tabId) {
    const sid = activeSessions.get(args.tabId);
    if (sid) {
      const paused = pausedTabs.get(sid);
      if (paused && name !== "debug" && !(name === "page" && args.action === "dialog")) {
        const topFrame = paused.callFrames?.[0];
        const location = topFrame ? `\nPaused at: ${topFrame.url}:${topFrame.location.lineNumber}` : "";
        delete args._agentSession;
        delete args._agentSessionId;
        return fail(
          `Debugger is paused on this tab. Handle it first.${location}\n` +
          `Reason: ${paused.reason}\n` +
          `→ Use debug tool with action: 'resume', 'step_over', 'step_into', 'step_out', 'call_stack', or 'evaluate_on_frame'\n` +
          `Auto-resume in ${CDP_DEBUGGER_TIMEOUT / 1000}s if not handled.`
        );
      }
    }
  }

  // ── Auto-snapshot: capture before-snapshot if requested ──
  let _beforeSnapshot = null;
  if (name === "interact" && args.autoSnapshot && args.tabId) {
    try {
      const snapSess = activeSessions.get(args.tabId);
      if (snapSess) {
        _beforeSnapshot = await buildSnapshot(snapSess);
      }
    } catch { /* ok — will just skip the diff */ }
  }

  let result;
  // Single-function handler (emulate)
  if (typeof handler === "function") {
    result = await handler(args);
  } else {
    // Action-based dispatch
    const action = args.action;
    if (!action) {
      delete args._agentSession;
      delete args._agentSessionId;
      return fail(`Missing 'action' parameter for tool '${name}'.`);
    }
    const fn = handler[action];
    if (!fn) {
      delete args._agentSession;
      delete args._agentSessionId;
      return fail(`Unknown action '${action}' for tool '${name}'. Available: ${Object.keys(handler).join(", ")}`);
    }
    result = await fn(args);
  }

  // ── Auto-snapshot: capture after-snapshot and append diff ──
  if (_beforeSnapshot && args.tabId && result && !result.isError) {
    try {
      const afterSess = activeSessions.get(args.tabId);
      if (afterSess) {
        const afterSnap = await buildSnapshot(afterSess);
        let snapInfo = "";
        if (_beforeSnapshot.url !== afterSnap.url) {
          snapInfo = `\n\n### Navigation Detected\n${_beforeSnapshot.url} \u2192 ${afterSnap.url}\n\n### New Page Snapshot\n${afterSnap.snapshot}`;
        } else {
          const diff = computeSnapshotDiff(_beforeSnapshot.snapshot.split("\n"), afterSnap.snapshot.split("\n"));
          if (diff.changed && diff.lines.length > 0) {
            snapInfo = `\n\n### Snapshot Changes (${diff.added} added, ${diff.removed} removed)\n${diff.lines.join("\n")}`;
          } else {
            snapInfo = "\n\n### No visible changes detected";
          }
        }
        if (result.content?.[0]?.type === "text") {
          result.content[0].text += snapInfo;
        }
        lastSnapshots.set(afterSess, { snapshot: afterSnap.snapshot, url: afterSnap.url, title: afterSnap.title });
      }
    } catch { /* snapshot failed — don't break the action result */ }
  }

  // Strip internal fields before returning
  delete args._agentSession;
  delete args._agentSessionId;
  delete args.cleanupStrategy;
  delete args.exclusive;

  return appendConsoleErrors(result, args.tabId);
}

/**
 * Auto-include recent console errors/warnings in tool responses.
 * Appends any new error/warning messages that appeared since the last call.
 */
const EXTENSION_PATTERNS = [
  /chrome-extension:\/\//,
  /moz-extension:\/\//,
  /^Uncaught.*extension/i,
  /^Failed to load resource.*chrome-extension/,
];

function isExtensionError(log) {
  return EXTENSION_PATTERNS.some(pat =>
    pat.test(log.text || '') || pat.test(log.url || '') || pat.test(log.source || '')
  );
}

function appendConsoleErrors(result, tabId) {
  if (!tabId || result.isError) return result;
  const sid = activeSessions.get(tabId);
  if (!sid) return result;

  const logs = consoleLogs.get(sid) || [];
  const recentErrors = logs
    .filter(l => (l.level === "error" || l.level === "warning") && !isExtensionError(l))
    .slice(-5) // last 5 errors/warnings
    .map(l => `[${l.level.toUpperCase()}] ${l.text.substring(0, 150)}`);

  if (recentErrors.length > 0 && result.content?.[0]?.type === "text") {
    result.content[0].text += "\n\n### Console Errors\n" + recentErrors.join("\n");
  }
  return result;
}

// ─── MCP Server Setup ───────────────────────────────────────────────

const server = new Server(
  { name: "cdp-browser", version: "4.13.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await handleTool(request.params.name, request.params.arguments || {});
  } catch (e) {
    return fail(e.message);
  }
});

// ─── Periodic Session Cleanup ────────────────────────────────────────

setInterval(async () => {
  try { await sweepStaleSessions(); } catch { /* ok */ }
}, 60_000); // sweep every 60s

// ─── CDP_PROFILE Auto-Connect ──────────────────────────────────────────

if (process.env.CDP_PROFILE) {
  const instances = discoverChromeInstances({ skipProfiles: true });
  const target = instances.find(i =>
    i.name.toLowerCase() === process.env.CDP_PROFILE.toLowerCase() ||
    i.userDataDir.toLowerCase() === process.env.CDP_PROFILE.toLowerCase()
  );
  if (target) {
    overrideUserDataDir = target.userDataDir;
    activeConnectionInfo = { name: target.name, userDataDir: target.userDataDir, port: target.port, wsUrl: target.wsUrl };
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
