/**
 * Device presets (5.1.0 A4) - schema surface + descriptor application
 * with a mocked CDP send.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../tools/registry.js';
import { registerEmulateTools } from '../../tools/emulate.js';
import { DEVICE_PRESETS, listDeviceNames } from '../../tools/device-presets.js';
import type { ServerContext } from '../../types.js';
function makeCtx() {
  const send = vi.fn(async () => ({}));
  const ctx = { sendCommand: send, config: { actionTimeout: 1000 }, tabSessions: { getSession: vi.fn(async () => 'sess1') } } as unknown as ServerContext;
  return { ctx, send };
}
function emulateArgs(over) { return { tabId: 't1', _sessionId: 'sess1', ...over }; }
function textOf(res) { return ((res.content ?? [{}])[0]).text ?? ''; }
describe('emulate.device presets (5.1.0 A4)', () => {
  let registry;
  beforeEach(() => { registry = new ToolRegistry(); registerEmulateTools(registry, {} as ServerContext); });
  it('exposes device in the inputSchema', () => {
    const tool = registry.list().find((t) => t.name === 'emulate')!;
    expect((tool.inputSchema.properties).device).toBeDefined();
  });
  it('description documents the device operation', () => {
    const tool = registry.list().find((t) => t.name === 'emulate')!;
    expect(tool.description).toContain('device: Apply a device preset');
  });
  it('has a sensible preset catalog', () => {
    const names = listDeviceNames();
    expect(names).toContain('Pixel 7');
    expect(names).toContain('iPhone 15');
    expect(names).toContain('Desktop 1920x1080');
    expect(names.length).toBeGreaterThanOrEqual(8);
  });
  it('device list returns the catalog without touching CDP', async () => {
    const { ctx, send } = makeCtx();
    const res = await registry.dispatch('emulate', emulateArgs({ device: 'list' }), ctx);
    expect(textOf(res)).toContain('Pixel 7');
    expect(send).not.toHaveBeenCalled();
  });
  it('applies metrics + touch + UA for a mobile preset', async () => {
    const { ctx, send } = makeCtx();
    const res = await registry.dispatch('emulate', emulateArgs({ device: 'Pixel 7' }), ctx);
    expect(textOf(res)).toContain('412x915');
    const methods = send.mock.calls.map((c) => c[0]);
    expect(methods).toContain('Emulation.setDeviceMetricsOverride');
    expect(methods).toContain('Emulation.setTouchEmulationEnabled');
    expect(methods).toContain('Emulation.setUserAgentOverride');
    const metrics = send.mock.calls.find((c) => c[0] === 'Emulation.setDeviceMetricsOverride')[1];
    expect(metrics.width).toBe(412);
    expect(metrics.mobile).toBe(true);
  });
  it('desktop preset skips touch emulation', async () => {
    const { ctx, send } = makeCtx();
    await registry.dispatch('emulate', emulateArgs({ device: 'Desktop 1920x1080' }), ctx);
    expect(send.mock.calls.map((c) => c[0])).not.toContain('Emulation.setTouchEmulationEnabled');
  });
  it('unknown device gives an actionable error', async () => {
    const { ctx } = makeCtx();
    const res = await registry.dispatch('emulate', emulateArgs({ device: 'Nokia 3310' }), ctx);
    expect(textOf(res)).toContain('Unknown device preset: Nokia 3310');
  });
  it('explicit viewport overrides the preset', async () => {
    const { ctx, send } = makeCtx();
    await registry.dispatch('emulate', emulateArgs({ device: 'Pixel 7', viewport: { width: 500, height: 900 } }), ctx);
    const metrics = send.mock.calls.find((c) => c[0] === 'Emulation.setDeviceMetricsOverride')[1];
    expect(metrics.width).toBe(500);
  });
  it('descriptor shapes are complete', () => {
    for (const d of Object.values(DEVICE_PRESETS)) {
      expect(d.width).toBeGreaterThan(200);
      expect(d.userAgent).toContain('Mozilla/5.0');
    }
  });
});