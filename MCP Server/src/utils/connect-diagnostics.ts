/**
 * Connect-failure diagnostics — classifies why auto-connect failed and
 * produces a kind + human message with the exact fix.
 *
 * Failure signatures (source-verified, see _archive research 2026-10):
 *  - TCP refused on every port, no browser processes  → no browser / not launched
 *  - TCP refused, browser running WITH debug flag     → Chrome 136+ default-profile block
 *  - Port bound, /json/version → 404                  → gated remote-debugging (toggle)
 *  - WS rejected with --remote-allow-origins hint     → origin allowlist
 *  - Port file existed but WS connect failed          → approval dialog denied / stale file
 */

// ─── Types ──────────────────────────────────────────────────────────

/** Outcome of probing one HTTP debug port. */
export type PortProbeOutcome = 'refused' | 'not_found' | 'timeout' | 'ok' | 'error';

export interface PortProbeEvidence {
  port: number;
  outcome: PortProbeOutcome;
  /** HTTP status code when available (404 for gated mode). */
  status?: number;
  /** Short error detail (error message, never a full stack). */
  detail?: string;
}

/** What the (optional) process scan saw on the machine. */
export interface ProcessInfo {
  /** Browser process names seen running (e.g. 'brave', 'chrome'). */
  browsersRunning: string[];
  /** At least one browser was launched with --remote-debugging-port. */
  flagPresent: boolean;
}

export type ConnectFailureKind =
  | 'no_browser'
  | 'no_debug_flag'
  | 'm136_default_dir'
  | 'toggle_mode'
  | 'approval_denied'
  | 'origin_blocked'
  | 'generic';

export interface ConnectDiagnosis {
  kind: ConnectFailureKind;
  headline: string;
  fix: string;
}

export interface ClassifyInput {
  probes: PortProbeEvidence[];
  /** True when file-based discovery found at least one DevToolsActivePort. */
  portFilesFound: number;
  /** Error messages captured from failed WS connect attempts. */
  connectErrors: string[];
  /** Process-scan result, or null when scan disabled/unavailable. */
  processInfo: ProcessInfo | null;
  host: string;
  primaryPort: number;
}

// ─── Helpers ────────────────────────────────────────────────────────

const ANY_BOUND = (probes: PortProbeEvidence[]): boolean =>
  probes.some((p) => p.outcome === 'not_found' || p.outcome === 'ok');

const ALL_REFUSED = (probes: PortProbeEvidence[]): boolean =>
  probes.length > 0 && probes.every((p) => p.outcome === 'refused');

function relaunchCommand(host: string, port: number): string {
  const target = host === '127.0.0.1' || host === 'localhost' ? '' : ` ${host}`;
  return (
    `& '<browser.exe>' --user-data-dir='<dir>' --remote-debugging-port=${port}${target}`
  );
}

// ─── Classifier ─────────────────────────────────────────────────────

export function classifyConnectFailure(input: ClassifyInput): ConnectDiagnosis {
  const { probes, portFilesFound, connectErrors, processInfo, host, primaryPort } =
    input;

  const originError = connectErrors.find((e) =>
    e.includes('--remote-allow-origins'),
  );
  if (originError) {
    return {
      kind: 'origin_blocked',
      headline: 'The browser rejected this WebSocket origin.',
      fix:
        `Relaunch the browser with:\n` +
        `  --remote-allow-origins=${host === '127.0.0.1' ? '*' : host}\n` +
        `Or connect from the same origin the browser expects.`,
    };
  }

  // Most specific: a port file was found and a WS connect was attempted but
  // failed (approval dialog denied, stale file, no visible window).
  if (portFilesFound > 0 && connectErrors.length > 0) {
    return {
      kind: 'approval_denied',
      headline:
        'A DevToolsActivePort file was found but the WebSocket connection ' +
        'was rejected.',
      fix:
        `Likely causes:\n` +
        `  1. The permission dialog was dismissed or no browser window was ` +
        `visible (approval mode auto-denies without a window).\n` +
        `  2. The port file is stale (browser restarted on another port). ` +
        `Retry after the browser settles.\n` +
        `  3. Or relaunch with the flag: ${relaunchCommand(host, primaryPort)}`,
    };
  }

  // Gated remote-debugging: port bound but the legacy HTTP API is absent.
  const gated = probes.find(
    (p) => p.outcome === 'not_found' && p.status === 404,
  );
  if (gated) {
    return {
      kind: 'toggle_mode',
      headline:
        'Your browser is running the new gated remote-debugging ' +
        '(chrome://inspect/#remote-debugging toggle). It does not serve the ' +
        'legacy HTTP discovery API.',
      fix:
        `Do ONE of these:\n` +
        `  1. Look at your browser — a permission dialog may be waiting. ` +
        `Click "Allow" (needs a visible browser window).\n` +
        `  2. Or relaunch with the flag (same data dir keeps your logins):\n` +
        `     ${relaunchCommand(host, primaryPort)}\n` +
        `  3. Or keep the toggle and make sure the browser's User Data dir ` +
        `is discoverable (CDP_USER_DATA env or process scan).`,
    };
  }

  if (ALL_REFUSED(probes)) {
    const browsers = processInfo?.browsersRunning ?? [];
    if (browsers.length === 0) {
      return {
        kind: 'no_browser',
        headline: 'Could not find any browser with remote debugging enabled.',
        fix:
          `To fix, do ONE of these:\n` +
          `  1. Launch your browser with the debug flag:\n` +
          `     ${relaunchCommand(host, primaryPort)}\n` +
          `  2. Or enable the chrome://inspect/#remote-debugging toggle ` +
          `(Chrome/Brave 144+)\n` +
          `  3. Or set CDP_PORT env var if using a non-standard port\n\n` +
          `The server will auto-connect once debugging is enabled.`,
      };
    }

    if (processInfo?.flagPresent) {
      // Flag present but nothing listening → Chrome 136+ default-profile block
      return {
        kind: 'm136_default_dir',
        headline:
          'The debug port was requested but Chromium 136+ refuses CDP on the ' +
          'DEFAULT User Data directory.',
        fix:
          `Relaunch with an explicit NON-DEFAULT data dir (your logins stay ` +
          `if you reuse the same dir):\n` +
          `  ${relaunchCommand(host, primaryPort)}\n` +
          `Note: Chrome for Testing is exempt from this restriction.`,
      };
    }

    return {
      kind: 'no_debug_flag',
      headline: 'A browser is running, but without remote debugging enabled.',
      fix:
        `Do ONE of these:\n` +
        `  1. Fully exit the browser, then relaunch with:\n` +
        `     ${relaunchCommand(host, primaryPort)}\n` +
        `  2. Or enable the chrome://inspect/#remote-debugging toggle ` +
        `(Chrome/Brave 144+) — the server will ask for permission on connect.`,
    };
  }

  // Port file existed but connect failed without a recognizable signature —
  // handled above; this branch is unreachable but kept for safety.
  if (portFilesFound > 0 && connectErrors.length > 0) {
    return {
      kind: 'approval_denied',
      headline:
        'A DevToolsActivePort file was found but the WebSocket connection ' +
        'was rejected.',
      fix:
        `Likely causes:\n` +
        `  1. The permission dialog was dismissed or no browser window was ` +
        `visible (approval mode auto-denies without a window).\n` +
        `  2. The port file is stale (browser restarted on another port). ` +
        `Retry after the browser settles.\n` +
        `  3. Or relaunch with the flag: ${relaunchCommand(host, primaryPort)}`,
    };
  }

  return {
    kind: 'generic',
    headline: 'Could not connect to any browser.',
    fix:
      `Launch the browser with:\n` +
      `  ${relaunchCommand(host, primaryPort)}\n` +
      `Or enable the chrome://inspect/#remote-debugging toggle.`,
  };
}
