/**
 * B5: observe.memory — DOM counters before/after a forced GC sweep
 * (Memory.prepareForLeakDetection), with leak-detection counters merged
 * when the browser supports them and a skip list when it does not.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../tools/registry.js';
import { registerObserveTools } from '../../tools/observe.js';
import type { ServerContext } from '../../types.js';

interface MockCtx extends ServerContext {
  __calls: string[];
}

function makeCtx(counters: () => Record<string, number>, opts: { noCounters?: boolean; noLeak?: boolean } = {}): MockCtx {
  const calls: string[] = [];
  return {
    __calls: calls,
    config: {} as ServerContext['config'],
    sendCommand: async (method: string) => {
      calls.push(method);
      if (opts.noCounters && method === 'Memory.getDOMCounters') {
        throw new Error("'Memory.getDOMCounters' wasn't found");
      }
      if (opts.noLeak && method === 'Memory.getDOMCountersForLeakDetection') {
        throw new Error("'Memory.getDOMCountersForLeakDetection' wasn't found");
      }
      if (method === 'Memory.getDOMCounters') return counters();
      if (method === 'Memory.getDOMCountersForLeakDetection') {
        return { counters: [{ name: 'Node', count: 12 }, { name: 'Document', count: 2 }] };
      }
      return {};
    },
  } as unknown as MockCtx;
}

function registry(ctx: ServerContext): ToolRegistry {
  const reg = new ToolRegistry();
  registerObserveTools(reg, ctx);
  return reg;
}

describe('observe.memory — B5 counters', () => {
  it('returns before/after counter reads around the GC sweep with deltas', async () => {
    let reads = 0;
    const ctx = makeCtx(() => {
      reads += 1;
      return { documents: 1 * reads, nodes: 100 * reads, jsEventListeners: 5 * reads };
    });
    const reg = registry(ctx);
    const result = await reg.dispatch('observe', { action: 'memory', tabId: 't1', _sessionId: 's1' }, ctx);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.before).toEqual({ documents: 1, nodes: 100, jsEventListeners: 5 });
    expect(parsed.after).toEqual({ documents: 2, nodes: 200, jsEventListeners: 10 });
    expect(parsed.delta).toEqual({ documents: 1, nodes: 100, jsEventListeners: 5 });
    // GC sweep ran exactly once, between the two reads
    const sweepIdx = ctx.__calls.indexOf('Memory.prepareForLeakDetection');
    expect(sweepIdx).toBeGreaterThan(0);
    expect(ctx.__calls.filter(m => m === 'Memory.getDOMCounters')).toHaveLength(2);
    expect(ctx.__calls.indexOf('Memory.getDOMCounters')).toBeLessThan(sweepIdx);
    expect(ctx.__calls.indexOf('Memory.getDOMCounters', sweepIdx)).toBeGreaterThan(sweepIdx);
    expect(parsed.leakDetectors).toEqual([{ name: 'Node', count: 12 }, { name: 'Document', count: 2 }]);
  });

  it('fails actionably when the Memory domain is absent', async () => {
    const ctx = makeCtx(() => ({}), { noCounters: true });
    const reg = registry(ctx);
    const result = await reg.dispatch('observe', { action: 'memory', tabId: 't1', _sessionId: 's1' }, ctx);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Memory domain is not supported');
  });

  it('lists missing leak-detection support as skipped but still returns counters', async () => {
    const ctx = makeCtx(() => ({ documents: 1, nodes: 10, jsEventListeners: 2 }), { noLeak: true });
    const reg = registry(ctx);
    const result = await reg.dispatch('observe', { action: 'memory', tabId: 't1', _sessionId: 's1' }, ctx);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.after.nodes).toBe(10);
    expect(parsed.leakDetectors).toBeUndefined();
    expect(parsed.skipped).toContain('getDOMCountersForLeakDetection');
  });

  it('exposes the memory action in the observe inputSchema', () => {
    const ctx = makeCtx(() => ({}));
    const reg = registry(ctx);
    const tool = reg.list().find(t => t.name === 'observe')!;
    const props = (tool.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;
    expect(props.action.enum).toContain('memory');
    expect(tool.description).toContain('- memory:');
  });
});
