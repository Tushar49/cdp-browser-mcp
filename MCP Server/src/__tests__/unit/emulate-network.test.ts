/**
 * WS8 — emulate network Rules transport (Network.emulateNetworkConditionsByRule),
 * preset byte-compat, reset clears, networkRules param + validation,
 * overrideNetworkState — all against a mocked CDP send.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../tools/registry.js';
import { registerEmulateTools } from '../../tools/emulate.js';
import type { ServerContext } from '../../types.js';

function makeCtx(opts?: { byRule?: boolean }) {
  const send = vi.fn(async () => ({}));
  const caps = { has: vi.fn(async () => opts?.byRule ?? true) };
  const ctx = {
    sendCommand: send,
    capabilities: caps,
    config: { actionTimeout: 1000 },
    tabSessions: { getSession: vi.fn(async () => 'sess1') },
  } as unknown as ServerContext;
  return { ctx, send, caps };
}
function args(over: Record<string, unknown>) { return { tabId: 't1', _sessionId: 'sess1', ...over }; }
function textOf(res: { content?: Array<{ text?: string }> }) { return res.content?.[0]?.text ?? ''; }

describe('emulate WS8 — networkCondition ByRule transport', () => {
  let registry: ToolRegistry;
  beforeEach(() => { registry = new ToolRegistry(); registerEmulateTools(registry, {} as ServerContext); });

  it('schema exposes networkRules + overrideNetworkState', () => {
    const tool = registry.list().find((t) => t.name === 'emulate')!;
    expect(tool.inputSchema.properties.networkRules).toBeDefined();
    expect(tool.inputSchema.properties.overrideNetworkState).toBeDefined();
  });
  it('description documents the new operations', () => {
    const tool = registry.list().find((t) => t.name === 'emulate')!;
    expect(tool.description).toContain('- networkRules: Per-request throttle rules');
    expect(tool.description).toContain('- overrideNetworkState: Spoof navigator.onLine');
  });

  it('capable browser: preset emits ONE match-all ByRule rule (byte-compat numbers)', async () => {
    const { ctx, send } = makeCtx({ byRule: true });
    const res = await registry.dispatch('emulate', args({ networkCondition: 'slow3g' }), ctx);
    expect(textOf(res)).toContain('Network: slow3g');
    const rule = send.mock.calls.find((c) => c[0] === 'Network.emulateNetworkConditionsByRule')[1];
    expect(rule.matchedNetworkConditions).toHaveLength(1);
    expect(rule.matchedNetworkConditions[0].urlPattern).toBe('');
    expect(rule.matchedNetworkConditions[0].latency).toBe(2000);
    expect(rule.matchedNetworkConditions[0].downloadThroughput).toBe(50000);
    // legacy wire method NOT used on capable browsers
    expect(send.mock.calls.map((c) => c[0])).not.toContain('Network.emulateNetworkConditions');
  });

  it('capable browser: offline preset also restores navigator state spoof', async () => {
    const { ctx, send } = makeCtx({ byRule: true });
    await registry.dispatch('emulate', args({ networkCondition: 'offline' }), ctx);
    const state = send.mock.calls.find((c) => c[0] === 'Network.overrideNetworkState')[1];
    expect(state.offline).toBe(true);
  });

  it('capable browser: none preset CLEARS rules (empty array)', async () => {
    const { ctx, send } = makeCtx({ byRule: true });
    await registry.dispatch('emulate', args({ networkCondition: 'none' }), ctx);
    const rule = send.mock.calls.find((c) => c[0] === 'Network.emulateNetworkConditionsByRule')[1];
    expect(rule.matchedNetworkConditions).toEqual([]);
  });

  it('incapable browser: preset falls back to legacy transport silently', async () => {
    const { ctx, send } = makeCtx({ byRule: false });
    const res = await registry.dispatch('emulate', args({ networkCondition: 'slow3g' }), ctx);
    expect(textOf(res)).toContain('Network: slow3g'); // output shape unchanged
    const legacy = send.mock.calls.find((c) => c[0] === 'Network.emulateNetworkConditions');
    expect(legacy).toBeTruthy();
    expect(legacy[1].latency).toBe(2000);
    expect(send.mock.calls.map((c) => c[0])).not.toContain('Network.emulateNetworkConditionsByRule');
  });

  it('unknown preset gives the established actionable error', async () => {
    const { ctx } = makeCtx();
    const res = await registry.dispatch('emulate', args({ networkCondition: 'banana' }), ctx);
    expect(textOf(res)).toContain('Unknown network condition: banana');
  });
});

describe('emulate WS8 — networkRules param', () => {
  let registry: ToolRegistry;
  beforeEach(() => { registry = new ToolRegistry(); registerEmulateTools(registry, {} as ServerContext); });

  it('valid rules passthrough with urlPattern default empty', async () => {
    const { ctx, send } = makeCtx();
    const res = await registry.dispatch('emulate', args({
      networkRules: [{ latency: 100, downloadThroughput: 400000, uploadThroughput: 150000 }],
    }), ctx);
    expect(textOf(res)).toContain('Network rules: 1 rule(s), first-match-wins');
    const rule = send.mock.calls.find((c) => c[0] === 'Network.emulateNetworkConditionsByRule')[1];
    expect(rule.matchedNetworkConditions[0].urlPattern).toBe('');
  });

  it('multiple rules pass through in order', async () => {
    const { ctx, send } = makeCtx();
    await registry.dispatch('emulate', args({
      networkRules: [
        { urlPattern: 'https://example.com/*', latency: 10, downloadThroughput: -1, uploadThroughput: -1 },
        { latency: 500, downloadThroughput: 80000, uploadThroughput: -1 },
      ],
    }), ctx);
    const rule = send.mock.calls.find((c) => c[0] === 'Network.emulateNetworkConditionsByRule')[1];
    expect(rule.matchedNetworkConditions).toHaveLength(2);
    expect(rule.matchedNetworkConditions[0].urlPattern).toBe('https://example.com/*');
  });

  it('rejects a relative urlPattern with an actionable error', async () => {
    const { ctx } = makeCtx();
    const res = await registry.dispatch('emulate', args({
      networkRules: [{ urlPattern: '/css/*', latency: 1, downloadThroughput: -1, uploadThroughput: -1 }],
    }), ctx);
    expect(textOf(res)).toContain('must be an absolute URL pattern');
  });

  it('rejects malformed numbers', async () => {
    const { ctx } = makeCtx();
    const res = await registry.dispatch('emulate', args({
      networkRules: [{ latency: 'x', downloadThroughput: -1, uploadThroughput: -1 }],
    }), ctx);
    expect(textOf(res)).toContain('latency must be a finite number');
  });

  it('rejects out-of-range packetLoss', async () => {
    const { ctx } = makeCtx();
    const res = await registry.dispatch('emulate', args({
      networkRules: [{ latency: 1, downloadThroughput: -1, uploadThroughput: -1, packetLoss: 140 }],
    }), ctx);
    expect(textOf(res)).toContain('packetLoss must be a number 0-100');
  });

  it('rejects non-supporting browsers with the Chrome 152+ remedy', async () => {
    const { ctx } = makeCtx({ byRule: false });
    const res = await registry.dispatch('emulate', args({
      networkRules: [{ latency: 1, downloadThroughput: -1, uploadThroughput: -1 }],
    }), ctx);
    expect(textOf(res)).toContain('requires Chrome 152+');
  });
});

describe('emulate WS8 — overrideNetworkState + reset', () => {
  let registry: ToolRegistry;
  beforeEach(() => { registry = new ToolRegistry(); registerEmulateTools(registry, {} as ServerContext); });

  it('true = offline shape, false = neutral shape', async () => {
    const { ctx, send } = makeCtx();
    await registry.dispatch('emulate', args({ overrideNetworkState: true }), ctx);
    expect(send.mock.calls.find((c) => c[0] === 'Network.overrideNetworkState')[1]).toMatchObject({ offline: true });
    await registry.dispatch('emulate', args({ overrideNetworkState: false }), ctx);
    expect(send.mock.calls.filter((c) => c[0] === 'Network.overrideNetworkState')[1][1]).toMatchObject({ offline: false, downloadThroughput: -1 });
  });

  it('reset clears ByRule rules BEFORE legacy, on capable browsers', async () => {
    const { ctx, send } = makeCtx({ byRule: true });
    await registry.dispatch('emulate', args({ reset: true }), ctx);
    const methods = send.mock.calls.map((c) => c[0]);
    expect(methods).toContain('Network.emulateNetworkConditionsByRule');
    expect(methods).toContain('Network.overrideNetworkState');
    const clearIdx = methods.indexOf('Network.emulateNetworkConditionsByRule');
    const legacyIdx = methods.indexOf('Network.emulateNetworkConditions');
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(clearIdx).toBeLessThan(legacyIdx);
    expect(send.mock.calls[clearIdx][1].matchedNetworkConditions).toEqual([]);
    const state = send.mock.calls.find((c) => c[0] === 'Network.overrideNetworkState')[1];
    expect(state.offline).toBe(false);
  });

  it('reset on incapable browsers still resets legacy (no ByRule call)', async () => {
    const { ctx, send } = makeCtx({ byRule: false });
    await registry.dispatch('emulate', args({ reset: true }), ctx);
    expect(send.mock.calls.map((c) => c[0])).not.toContain('Network.emulateNetworkConditionsByRule');
    expect(send.mock.calls.map((c) => c[0])).toContain('Network.emulateNetworkConditions');
  });
});
