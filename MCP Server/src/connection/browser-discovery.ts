/**
 * Browser auto-discovery — finds running Chromium-based browsers
 * by scanning known User Data directories for DevToolsActivePort files.
 *
 * Extracted from `discoverChromeInstances` and `getWsUrl` in server.js.
 */

import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import { join, basename } from 'path';
import { platform, homedir } from 'os';
import type { BrowserInstance, ProfileInfo } from '../types.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface DiscoverOptions {
  /** Skip Local State parsing for faster lookups (default false). */
  skipProfiles?: boolean;
  /** Additional User Data directory paths to check first. */
  extraPaths?: string[];
}

export interface WsUrlResult {
  wsUrl: string;
  userDataDir: string | null;
}

// Re-export for convenience
export type { BrowserInstance, ProfileInfo };

// ─── Candidate List ─────────────────────────────────────────────────

interface Candidate {
  name: string;
  path: string;
}

function getBrowserCandidates(): Candidate[] {
  const os = platform();
  const home = homedir();

  if (os === 'win32') {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const roaming = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    return [
      { name: 'Chrome', path: join(local, 'Google', 'Chrome', 'User Data') },
      { name: 'Chrome Beta', path: join(local, 'Google', 'Chrome Beta', 'User Data') },
      { name: 'Chrome Canary', path: join(local, 'Google', 'Chrome SxS', 'User Data') },
      { name: 'Chromium', path: join(local, 'Chromium', 'User Data') },
      { name: 'Edge', path: join(local, 'Microsoft', 'Edge', 'User Data') },
      { name: 'Brave', path: join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
      { name: 'Vivaldi', path: join(local, 'Vivaldi', 'User Data') },
      { name: 'Opera', path: join(roaming, 'Opera Software', 'Opera Stable') },
    ];
  } else if (os === 'darwin') {
    const appSupport = join(home, 'Library', 'Application Support');
    return [
      { name: 'Chrome', path: join(appSupport, 'Google', 'Chrome') },
      { name: 'Chrome Canary', path: join(appSupport, 'Google', 'Chrome Canary') },
      { name: 'Chromium', path: join(appSupport, 'Chromium') },
      { name: 'Edge', path: join(appSupport, 'Microsoft Edge') },
      { name: 'Brave', path: join(appSupport, 'BraveSoftware', 'Brave-Browser') },
      { name: 'Vivaldi', path: join(appSupport, 'Vivaldi') },
      { name: 'Opera', path: join(appSupport, 'com.operasoftware.Opera') },
    ];
  } else {
    // Linux
    return [
      { name: 'Chrome', path: join(home, '.config', 'google-chrome') },
      { name: 'Chromium', path: join(home, '.config', 'chromium') },
      { name: 'Edge', path: join(home, '.config', 'microsoft-edge') },
      { name: 'Brave', path: join(home, '.config', 'BraveSoftware', 'Brave-Browser') },
      { name: 'Vivaldi', path: join(home, '.config', 'vivaldi') },
      { name: 'Opera', path: join(home, '.config', 'opera') },
    ];
  }
}

function getCandidates(extraPaths: string[] = []): Candidate[] {
  const candidates: Candidate[] = [];

  // Extra paths (e.g. from CDP_USER_DATA or override) take priority
  for (const p of extraPaths) {
    if (p) candidates.push({ name: 'Custom', path: p });
  }

  // Platform-specific browser paths
  candidates.push(...getBrowserCandidates());

  return candidates;
}

// ─── Port File Parsing ──────────────────────────────────────────────

interface PortFileInfo {
  port: number;
  wsPath: string;
}

function readPortFile(userDataDir: string): PortFileInfo | null {
  try {
    const raw = readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf8').trim();
    const lines = raw.split('\n');
    return {
      port: parseInt(lines[0], 10),
      wsPath: lines[1] || '/devtools/browser/',
    };
  } catch {
    return null;
  }
}

// ─── Profile Parsing ────────────────────────────────────────────────

function readProfiles(userDataDir: string): ProfileInfo[] {
  try {
    const raw = readFileSync(join(userDataDir, 'Local State'), 'utf8');
    const localState = JSON.parse(raw) as {
      profile?: {
        info_cache?: Record<
          string,
          { name?: string; gaia_name?: string; user_name?: string }
        >;
      };
    };
    const cache = localState?.profile?.info_cache || {};
    return Object.entries(cache).map(([dir, info]) => ({
      directory: dir,
      name: info.name || dir,
      email: info.user_name || undefined,
    }));
  } catch {
    return [];
  }
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Scan the filesystem for running Chromium instances.
 * Returns all instances that have a valid DevToolsActivePort file.
 */
export function discoverBrowserInstances(
  opts: DiscoverOptions = {},
): BrowserInstance[] {
  const { skipProfiles = false, extraPaths = [] } = opts;
  const candidates = getCandidates(extraPaths);
  const instances: BrowserInstance[] = [];

  for (const { name, path: udPath } of candidates) {
    const portInfo = readPortFile(udPath);
    if (!portInfo) continue;

    const profiles = skipProfiles ? [] : readProfiles(udPath);

    instances.push({
      name,
      port: portInfo.port,
      wsUrl: `ws://127.0.0.1:${portInfo.port}${portInfo.wsPath}`,
      userDataDir: udPath,
      profiles,
    });
  }

  return instances;
}

/**
 * Resolve the WebSocket URL by scanning known User Data directories
 * for a DevToolsActivePort file. Falls back to constructing a URL
 * (caller should try /json/version at runtime) (P0-3).
 *
 * @param overrideDir   User Data dir override (e.g. from `browser.connect`)
 * @param extraPaths    Additional dirs to check first (CDP_USER_DATA,
 *                      process-scan results — configured upstream)
 * @param fallbackHost  Default host (from config)
 * @param fallbackPort  Default port (from config)
 */
export function resolveWsUrl(
  overrideDir: string | null,
  extraPaths: string[],
  fallbackHost: string,
  fallbackPort: number,
): WsUrlResult {
  const extra: string[] = [];
  if (overrideDir) extra.push(overrideDir);
  for (const p of extraPaths) if (p) extra.push(p);

  const candidates = getCandidates(extra);

  for (const { path: udPath } of candidates) {
    const portInfo = readPortFile(udPath);
    if (portInfo) {
      return {
        wsUrl: `ws://127.0.0.1:${portInfo.port}${portInfo.wsPath}`,
        userDataDir: udPath,
      };
    }
  }

  // P0-3: Last resort — construct URL (caller should try /json/version at runtime)
  return {
    wsUrl: `ws://${fallbackHost}:${fallbackPort}/devtools/browser/`,
    userDataDir: null,
  };
}

/**
 * Async variant that queries /json/version when file-based discovery fails.
 * P0-3 fix: Uses the HTTP endpoint to get the correct WebSocket URL
 * instead of guessing.
 */
export async function resolveWsUrlAsync(
  overrideDir: string | null,
  extraPaths: string[],
  fallbackHost: string,
  fallbackPort: number,
): Promise<WsUrlResult> {
  // Try synchronous file-based discovery first
  const syncResult = resolveWsUrl(overrideDir, extraPaths, fallbackHost, fallbackPort);
  if (syncResult.userDataDir) return syncResult;

  // File-based discovery failed — try HTTP /json/version endpoint
  try {
    const resp = await fetch(`http://${fallbackHost}:${fallbackPort}/json/version`);
    const data = (await resp.json()) as { webSocketDebuggerUrl?: string };
    if (data.webSocketDebuggerUrl) {
      return {
        wsUrl: data.webSocketDebuggerUrl,
        userDataDir: null,
      };
    }
  } catch {
    // /json/version unavailable — fall through
  }

  // Last resort — constructed URL (may not work)
  return syncResult;
}

/**
 * Find the best matching instance given user input (name, port, or path).
 * Returns null if no match is found.
 */
export function findBestInstance(
  instances: BrowserInstance[],
  input: string,
): BrowserInstance | null {
  const needle = input.trim().toLowerCase();

  return (
    instances.find(
      (i) =>
        i.name.toLowerCase() === needle ||
        i.port.toString() === needle ||
        i.userDataDir.toLowerCase() === needle,
    ) ?? null
  );
}

// ─── Process Command-Line Scan (5.0.3) ──────────────────────────────

/** Chromium-family browser executables we recognize (basename, lowercase, no ext). */
const KNOWN_BROWSERS = [
  'chrome',
  'brave',
  'msedge',
  'chromium',
  'vivaldi',
  'opera',
] as const;

export interface CommandLineInfo {
  /** Recognized browser basename (e.g. 'brave'), if the line is a browser. */
  browserName?: string;
  /** Extracted --user-data-dir value, if present. */
  userDataDir?: string;
  /** Extracted --remote-debugging-port value, if present. */
  port?: number;
}

export interface ProcessScanResult {
  /** Discovered User Data dirs (deduped, order-stable). */
  userDataDirs: string[];
  /** Discovered debug ports (deduped). */
  ports: number[];
  /** Recognized browser basenames seen running (deduped). */
  browsersRunning: string[];
}

/**
 * Parse one process command line. Extracts ONLY the two flags we need —
 * full command lines are never returned or logged (privacy rule).
 */
export function parseBrowserCommandLine(cmd: string): CommandLineInfo {
  // Executable may be quoted ("C:\Program Files\...\chrome.exe")
  const exeMatch = cmd.match(/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const firstToken = (exeMatch
    ? exeMatch[1] ?? exeMatch[2] ?? exeMatch[3]
    : ''
  ).toLowerCase();
  const base = basename(firstToken).replace(/\.exe$/, '');
  const browserName = KNOWN_BROWSERS.find((n) => base === n || base.startsWith(`${n}-`));

  const info: CommandLineInfo = {};
  if (!browserName) return info;
  info.browserName = browserName;

  const dirMatch = cmd.match(/--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  if (dirMatch) info.userDataDir = dirMatch[1] ?? dirMatch[2] ?? dirMatch[3];

  const portMatch = cmd.match(/--remote-debugging-port=(\d+)/);
  if (portMatch) info.port = parseInt(portMatch[1], 10);

  return info;
}

type ProcessRunner = (file: string, args: string[], timeoutMs: number) => Promise<string>;

function defaultRunner(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function buildProcessQueryCommand(os: string): { file: string; args: string[] } {
  if (os === 'win32') {
    const filter = ["Name='chrome.exe'", "Name='brave.exe'", "Name='msedge.exe'",
      "Name='chromium.exe'", "Name='vivaldi.exe'", "Name='opera.exe'"].join(' OR ');
    return {
      file: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object -ExpandProperty CommandLine`,
      ],
    };
  }
  // macOS + Linux: ps is universal enough for same-user processes
  return { file: 'ps', args: ['-axo', 'command'] };
}

/**
 * Scan running Chromium-family browser processes for their launch flags.
 * Read-only, same-user, non-elevated. Returns ONLY extracted fields —
 * never raw command lines (privacy rule).
 *
 * Controlled by `CDP_PROCESS_SCAN` (default ON, `false` disables) —
 * enforced by the caller.
 */
export async function scanBrowserProcesses(
  opts: { timeoutMs?: number; runner?: ProcessRunner; os?: string } = {},
): Promise<ProcessScanResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const runner = opts.runner ?? defaultRunner;
  const os = opts.os ?? platform();

  const result: ProcessScanResult = {
    userDataDirs: [],
    ports: [],
    browsersRunning: [],
  };

  const { file, args } = buildProcessQueryCommand(os);
  let stdout: string;
  try {
    stdout = await runner(file, args, timeoutMs);
  } catch {
    return result; // non-fatal: scan is best-effort
  }

  const dirs = new Set<string>();
  const ports = new Set<number>();
  const names = new Set<string>();

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const info = parseBrowserCommandLine(line);
    if (!info.browserName) continue;
    names.add(info.browserName);
    if (info.userDataDir) dirs.add(info.userDataDir);
    if (info.port !== undefined) ports.add(info.port);
  }

  result.userDataDirs = [...dirs];
  result.ports = [...ports];
  result.browsersRunning = [...names];
  return result;
}
