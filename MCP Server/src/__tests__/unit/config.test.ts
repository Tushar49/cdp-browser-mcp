import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../config.js';

describe('loadConfig()', () => {
  const envSnapshot: Record<string, string | undefined> = {};
  const envKeys = [
    'CDP_HOST', 'CDP_PORT', 'CDP_ACTION_TIMEOUT', 'CDP_NAVIGATION_TIMEOUT',
    'CDP_SNAPSHOT_TIMEOUT', 'CDP_TIMEOUT', 'CDP_SESSION_TTL',
    'CDP_DEBUGGER_TIMEOUT', 'CDP_CLEANUP_STRATEGY', 'CDP_TEMP_DIR', 'CDP_PROFILE',
    'CDP_USER_DATA', 'CDP_PROCESS_SCAN',
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      envSnapshot[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (envSnapshot[key] !== undefined) {
        process.env[key] = envSnapshot[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('returns defaults when no env vars set', () => {
    const cfg = loadConfig();
    expect(cfg.cdpHost).toBe('127.0.0.1');
    expect(cfg.cdpPort).toBe(9222);
    expect(cfg.maxInlineLen).toBe(60_000);
    expect(cfg.maxTempFiles).toBe(50);
    expect(cfg.maxTempAgeMs).toBe(30 * 60 * 1000);
  });

  it('defaultCleanupStrategy is "detach" by default', () => {
    const cfg = loadConfig();
    expect(cfg.defaultCleanupStrategy).toBe('detach');
  });

  it('processScan defaults to ON and can be disabled', () => {
    expect(loadConfig().processScan).toBe(true);
    process.env.CDP_PROCESS_SCAN = 'false';
    expect(loadConfig().processScan).toBe(false);
  });

  it('reads CDP_USER_DATA into userDataDir', () => {
    expect(loadConfig().userDataDir).toBe('');
    process.env.CDP_USER_DATA = 'A:\\Browsers\\data';
    expect(loadConfig().userDataDir).toBe('A:\\Browsers\\data');
  });

  it('globalTimeout is 60000 by default', () => {
    const cfg = loadConfig();
    expect(cfg.globalTimeout).toBe(60000);
  });

  it('respects env var overrides', () => {
    process.env.CDP_HOST = '192.168.1.1';
    process.env.CDP_PORT = '9333';
    process.env.CDP_TIMEOUT = '120000';
    process.env.CDP_CLEANUP_STRATEGY = 'close';
    process.env.CDP_PROFILE = 'MyProfile';

    const cfg = loadConfig();
    expect(cfg.cdpHost).toBe('192.168.1.1');
    expect(cfg.cdpPort).toBe(9333);
    expect(cfg.globalTimeout).toBe(120000);
    expect(cfg.defaultCleanupStrategy).toBe('close');
    expect(cfg.autoConnectProfile).toBe('MyProfile');
  });

  it('parses numeric env vars correctly (string → number)', () => {
    process.env.CDP_PORT = '9444';
    process.env.CDP_ACTION_TIMEOUT = '5000';
    process.env.CDP_NAVIGATION_TIMEOUT = '30000';
    process.env.CDP_SNAPSHOT_TIMEOUT = '8000';
    process.env.CDP_SESSION_TTL = '600000';
    process.env.CDP_DEBUGGER_TIMEOUT = '20000';

    const cfg = loadConfig();
    expect(cfg.cdpPort).toBe(9444);
    expect(typeof cfg.cdpPort).toBe('number');
    expect(cfg.actionTimeout).toBe(5000);
    expect(typeof cfg.actionTimeout).toBe('number');
    expect(cfg.navigationTimeout).toBe(30000);
    expect(cfg.snapshotTimeout).toBe(8000);
    expect(cfg.sessionTTL).toBe(600000);
    expect(cfg.debuggerTimeout).toBe(20000);
  });

  it('handles invalid numeric env vars gracefully (NaN fallback)', () => {
    process.env.CDP_PORT = 'not-a-number';
    const cfg = loadConfig();
    // parseInt('not-a-number', 10) returns NaN
    expect(cfg.cdpPort).toBeNaN();
  });

  it('returns all expected config keys', () => {
    const cfg = loadConfig();
    const keys = Object.keys(cfg);
    expect(keys).toContain('cdpHost');
    expect(keys).toContain('cdpPort');
    expect(keys).toContain('actionTimeout');
    expect(keys).toContain('navigationTimeout');
    expect(keys).toContain('snapshotTimeout');
    expect(keys).toContain('globalTimeout');
    expect(keys).toContain('sessionTTL');
    expect(keys).toContain('debuggerTimeout');
    expect(keys).toContain('defaultCleanupStrategy');
    expect(keys).toContain('maxInlineLen');
    expect(keys).toContain('tempDir');
    expect(keys).toContain('maxTempFiles');
    expect(keys).toContain('maxTempAgeMs');
    expect(keys).toContain('autoConnectProfile');
  });
});
