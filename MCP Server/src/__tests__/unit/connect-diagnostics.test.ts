import { describe, it, expect } from 'vitest';
import {
  classifyConnectFailure,
  type ClassifyInput,
  type PortProbeEvidence,
} from '../../utils/connect-diagnostics.js';

const base: ClassifyInput = {
  probes: [],
  portFilesFound: 0,
  connectErrors: [],
  processInfo: null,
  host: '127.0.0.1',
  primaryPort: 9222,
};

const refused = (port: number): PortProbeEvidence => ({
  port,
  outcome: 'refused',
});
const notFound404 = (port: number): PortProbeEvidence => ({
  port,
  outcome: 'not_found',
  status: 404,
});

describe('classifyConnectFailure()', () => {
  it('no_browser: nothing listening, no processes', () => {
    const d = classifyConnectFailure({
      ...base,
      probes: [refused(9222), refused(9229)],
      processInfo: { browsersRunning: [], flagPresent: false },
    });
    expect(d.kind).toBe('no_browser');
    expect(d.fix).toContain('--remote-debugging-port=9222');
    expect(d.fix).toContain('chrome://inspect/#remote-debugging');
  });

  it('no_browser fallback: probes refused with processInfo null', () => {
    const d = classifyConnectFailure({
      ...base,
      probes: [refused(9222)],
    });
    expect(d.kind).toBe('no_browser');
  });

  it('no_debug_flag: browser running, launched without the flag', () => {
    const d = classifyConnectFailure({
      ...base,
      probes: [refused(9222)],
      processInfo: { browsersRunning: ['brave'], flagPresent: false },
    });
    expect(d.kind).toBe('no_debug_flag');
    expect(d.fix).toContain('Fully exit the browser');
  });

  it('m136_default_dir: flag present but port refused (default-profile block)', () => {
    const d = classifyConnectFailure({
      ...base,
      probes: [refused(9222), refused(9229)],
      processInfo: { browsersRunning: ['chrome'], flagPresent: true },
    });
    expect(d.kind).toBe('m136_default_dir');
    expect(d.fix).toContain('--user-data-dir=');
    expect(d.fix).toContain('NON-DEFAULT');
  });

  it('toggle_mode: port bound, /json/version 404', () => {
    const d = classifyConnectFailure({
      ...base,
      probes: [notFound404(9222)],
    });
    expect(d.kind).toBe('toggle_mode');
    expect(d.fix).toContain('Allow');
    expect(d.headline).toContain('chrome://inspect/#remote-debugging');
  });

  it('approval_denied takes precedence: bound port + port file + connect failed', () => {
    const d = classifyConnectFailure({
      ...base,
      probes: [notFound404(9222)],
      portFilesFound: 1,
      connectErrors: ['Connection rejected'],
    });
    expect(d.kind).toBe('approval_denied');
  });

  it('origin_blocked: WS error mentions --remote-allow-origins', () => {
    const d = classifyConnectFailure({
      ...base,
      probes: [refused(9222)],
      connectErrors: [
        'Rejected an incoming WebSocket connection from the X origin. Use the command line flag --remote-allow-origins=...',
      ],
    });
    expect(d.kind).toBe('origin_blocked');
    expect(d.fix).toContain('--remote-allow-origins=');
  });

  it('approval_denied: port file found, connect failed, nothing bound', () => {
    const d = classifyConnectFailure({
      ...base,
      probes: [refused(9222)],
      portFilesFound: 2,
      connectErrors: ['WebSocket closed'],
    });
    expect(d.kind).toBe('approval_denied');
    expect(d.fix).toContain('permission dialog');
  });

  it('generic fallback never throws', () => {
    const d = classifyConnectFailure({ ...base });
    expect(d.kind).toBe('generic');
    expect(d.fix).toContain('--remote-debugging-port=9222');
  });

  it('messages include the exact relaunch command shape', () => {
    const d = classifyConnectFailure({
      ...base,
      probes: [refused(9222)],
    });
    expect(d.fix).toMatch(/--user-data-dir='<dir>' --remote-debugging-port=9222/);
  });

  it('non-local host is echoed in the relaunch command', () => {
    const d = classifyConnectFailure({
      ...base,
      probes: [refused(9222)],
      host: '192.168.1.50',
    });
    expect(d.fix).toContain(' 192.168.1.50');
  });
});
