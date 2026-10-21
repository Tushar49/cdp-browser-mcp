import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthMonitor, type HealthMonitorOptions } from '../../connection/health-monitor.js';
import type { CDPClient } from '../../connection/cdp-client.js';
import { ActionableError } from '../../utils/error-handler.js';
import type { BrowserInstance } from '../../types.js';

// ─── Fakes ──────────────────────────────────────────────────────────

interface FetchSpec {
  /** Matches by substring of the request URL. */
  match: string;
  /** 'ok' → 200 + body, otherwise the numeric status. */
  status: number | 'ok';
  body?: unknown;
}

function makeFakeClient(opts: { connectError?: Error; url?: string } = {}): CDPClient {
  let connected = false;
  const client = {
    connect: vi.fn(async () => {
      if (opts.connectError) throw opts.connectError;
      connected = true;
    }),
    get isConnected() {
      return connected;
    },
    url: opts.url ?? 'ws://127.0.0.1:9222/devtools/browser/test',
    rawSocket: null,
    terminate: vi.fn(),
  };
  return client as unknown as CDPClient;
}

function stubFetch(specs: FetchSpec[]): void {
  const fn = vi.fn(async (url: string | URL) => {
    const target = String(url);
    const spec = specs.find((s) => target.includes(s.match));
    if (!spec) throw new Error(`fetch: no spec for ${target}`);
    if (spec.status === 'ok') {
      return {
        ok: true,
        status: 200,
        json: async () => spec.body,
      };
    }
    return { ok: false, status: spec.status, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fn);
}

function instance(port: number, wsPath = '/devtools/browser/test'): BrowserInstance {
  return {
    name: 'Test',
    port,
    wsUrl: `ws://127.0.0.1:${port}${wsPath}`,
    userDataDir: `C:\\fake\\${port}`,
    profiles: [],
  };
}

function makeMonitor(
  client: CDPClient,
  opts: Partial<HealthMonitorOptions> & {
    discoverResult?: BrowserInstance[];
    scanResult?: { userDataDirs: string[]; ports: number[]; browsersRunning: string[] };
  } = {},
): HealthMonitor {
  return new HealthMonitor(client, {
    cdpHost: '127.0.0.1',
    cdpPort: 9222,
    pingIntervalMs: 60_000,
    discoverFn: vi.fn(() => opts.discoverResult ?? []),
    scanFn: vi.fn(async () =>
      opts.scanResult ?? { userDataDirs: [], ports: [], browsersRunning: [] },
    ),
    processScan: opts.processScan ?? true,
    extraUserDataDirs: opts.extraUserDataDirs ?? [],
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('HealthMonitor._doAutoConnect() strategies (5.0.3)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('S2 legacy: /json/version 200 → connects, mode=legacy, discovery not called', async () => {
    stubFetch([
      { match: '/json/version', status: 'ok', body: { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' } },
    ]);
    const client = makeFakeClient();
    const monitor = makeMonitor(client, {
      discoverResult: [instance(9223)],
    });
    await monitor.autoConnect();
    expect(client.connect).toHaveBeenCalledWith('ws://127.0.0.1:9222/devtools/browser/abc');
    expect(monitor.connectionMode).toBe('legacy');
    expect(monitor.health.status).toBe('connected');
  });

  it('S3 approval: /json/version 404 everywhere + port file found → file-based connect, mode=approval', async () => {
    // /json/version probes → 404; the mode-detection probe after connect → 404 too
    stubFetch([{ match: '/json/version', status: 404 }]);
    const client = makeFakeClient();
    const monitor = makeMonitor(client, {
      discoverResult: [instance(9223, '/devtools/browser/uuid-1')],
    });
    await monitor.autoConnect();
    expect(client.connect).toHaveBeenCalledWith('ws://127.0.0.1:9223/devtools/browser/uuid-1');
    expect(monitor.connectionMode).toBe('approval');
  });

  it('S2 ok short-circuits: discovery + scan never called', async () => {
    stubFetch([
      { match: '/json/version', status: 'ok', body: { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/x' } },
    ]);
    const client = makeFakeClient();
    const monitor = makeMonitor(client, {
      discoverResult: [instance(9223)],
      scanResult: { userDataDirs: ['C:\\x'], ports: [9300], browsersRunning: ['brave'] },
    });
    await monitor.autoConnect();
    expect((monitor as unknown as { discoverFn: ReturnType<typeof vi.fn> }).discoverFn)
      .not.toHaveBeenCalled();
    expect((monitor as unknown as { scanFn: ReturnType<typeof vi.fn> }).scanFn)
      .not.toHaveBeenCalled();
  });

  it('S4 enriched probe: scan finds a port whose /json/version works → legacy connect', async () => {
    stubFetch([
      { match: ':9222/json/version', status: 503 },   // base probe fails (non-404 → 'error')
      { match: '/json/version', status: 'ok', body: { webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/browser/y' } },
    ]);
    const client = makeFakeClient();
    const monitor = makeMonitor(client, {
      scanResult: { userDataDirs: [], ports: [9333], browsersRunning: ['chrome'] },
    });
    await monitor.autoConnect();
    expect(client.connect).toHaveBeenCalledWith('ws://127.0.0.1:9333/devtools/browser/y');
    expect(monitor.connectionMode).toBe('legacy');
  });

  it('S4 enriched dirs: scan finds a data dir with a port file → file-based connect', async () => {
    stubFetch([{ match: '/json/version', status: 404 }]);
    const client = makeFakeClient();
    const monitor = makeMonitor(client, {
      scanResult: {
        userDataDirs: ['C:\\portable\\data'],
        ports: [],
        browsersRunning: ['brave'],
      },
      discoverResult: [instance(9224, '/devtools/browser/portable')],
    });
    await monitor.autoConnect();
    expect(client.connect).toHaveBeenCalledWith('ws://127.0.0.1:9224/devtools/browser/portable');
  });

  it('processScan disabled → scanFn never called', async () => {
    stubFetch([{ match: '/json/version', status: 404 }]);
    const client = makeFakeClient();
    const monitor = makeMonitor(client, { processScan: false });
    await expect(monitor.autoConnect()).rejects.toBeInstanceOf(ActionableError);
    expect((monitor as unknown as { scanFn: ReturnType<typeof vi.fn> }).scanFn)
      .not.toHaveBeenCalled();
  });

  it('classifies no_browser when all refused and nothing running', async () => {
    stubFetch([]); // every fetch throws → refused
    const client = makeFakeClient();
    const monitor = makeMonitor(client, {
      scanResult: { userDataDirs: [], ports: [], browsersRunning: [] },
    });
    const err = await monitor.autoConnect().catch((e) => e);
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.context.kind).toBe('no_browser');
    expect(err.fix).toContain('--remote-debugging-port=9222');
  });

  it('classifies m136_default_dir when flag present but all ports refused', async () => {
    stubFetch([]);
    const client = makeFakeClient();
    const monitor = makeMonitor(client, {
      scanResult: { userDataDirs: [], ports: [9222], browsersRunning: ['chrome'] },
    });
    const err = await monitor.autoConnect().catch((e) => e);
    expect(err.context.kind).toBe('m136_default_dir');
  });

  it('classifies no_debug_flag when browser runs without the flag', async () => {
    stubFetch([]);
    const client = makeFakeClient();
    const monitor = makeMonitor(client, {
      scanResult: { userDataDirs: ['C:\\ud'], ports: [], browsersRunning: ['brave'] },
    });
    const err = await monitor.autoConnect().catch((e) => e);
    expect(err.context.kind).toBe('no_debug_flag');
  });

  it('classifies toggle_mode on bound-404 with no port file', async () => {
    stubFetch([{ match: '/json/version', status: 404 }]);
    const client = makeFakeClient();
    const monitor = makeMonitor(client, {
      scanResult: { userDataDirs: [], ports: [], browsersRunning: ['brave'] },
    });
    const err = await monitor.autoConnect().catch((e) => e);
    expect(err.context.kind).toBe('toggle_mode');
  });

  it('classifies approval_denied when port file exists but WS connect fails', async () => {
    stubFetch([{ match: '/json/version', status: 404 }]);
    const client = makeFakeClient({ connectError: new Error('Unexpected server response: 403') });
    const monitor = makeMonitor(client, {
      discoverResult: [instance(9223)],
    });
    const err = await monitor.autoConnect().catch((e) => e);
    expect(err.context.kind).toBe('approval_denied');
    expect(err.fix).toContain('permission dialog');
  });

  it('classifies origin_blocked from the WS error text', async () => {
    stubFetch([{ match: '/json/version', status: 404 }]);
    const client = makeFakeClient({
      connectError: new Error('Rejected an incoming WebSocket connection. Use --remote-allow-origins=...'),
    });
    const monitor = makeMonitor(client, {
      discoverResult: [instance(9223)],
    });
    const err = await monitor.autoConnect().catch((e) => e);
    expect(err.context.kind).toBe('origin_blocked');
  });

  it('evidence is preserved: refused vs 404 outcomes both recorded (P1 regression)', async () => {
    const spy = vi.fn(async (url: string | URL) => {
      if (String(url).includes(':9222/')) {
        throw new Error('ECONNREFUSED');
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', spy);
    const client = makeFakeClient();
    const monitor = makeMonitor(client, { processScan: false });
    const err = (await monitor.autoConnect().catch((e) => e)) as ActionableError;
    expect(err).toBeInstanceOf(ActionableError);
    const probes = err.context?.probes as Array<{
      port: number;
      outcome: string;
    }>;
    expect(probes).toBeDefined();
    expect(probes).toContainEqual(expect.objectContaining({ port: 9222, outcome: 'refused' }));
    expect(probes!.some((p) => p.outcome === 'not_found')).toBe(true);
  });
});
