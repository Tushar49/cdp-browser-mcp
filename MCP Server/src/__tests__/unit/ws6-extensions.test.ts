/**
 * 5.3 WS6 — extensions listing + opt-in toolbar trigger guardrails.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../tools/registry.js';
import { registerBrowserTools } from '../../tools/browser.js';
import type { ServerContext, ToolResult } from '../../types.js';

interface Call { method: string; params?: Record<string, unknown> }

function textOf(r: ToolResult): string {
  return ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('\n');
}

function baseCtx(calls: Call[], config: Record<string, unknown> = {}, send?: (m: string, p?: Record<string, unknown>) => Promise<unknown>): ServerContext {
  return {
    sendCommand: send ?? (async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      return {};
    }),
    capabilities: { require: async () => {}, has: async () => true },
    config: { extensionTriggerAllowlist: [], ...config },
    cdpClient: { url: 'ws://127.0.0.1:9222' },
  } as unknown as ServerContext;
}

const dispatch = async (ctx: ServerContext, action: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
  const registry = new ToolRegistry();
  registerBrowserTools(registry, ctx);
  return registry.dispatch('browser', { action, ...args }, ctx);
};

describe('browser extensions listing (5.3 WS6)', () => {
  it('formats unpacked extensions with id/name/version/path/enabled', async () => {
    const calls: Call[] = [];
    const ctx = baseCtx(calls, {}, async (method) => {
      calls.push({ method });
      if (method === 'Extensions.getExtensions') {
        return {
          extensions: [
            { id: 'abc123', name: 'WS6 Test Extension', version: '1.0', path: 'C:\\temp\\test-ext', enabled: true },
            { id: 'def456', name: 'Broken One', version: '0.9', path: 'C:\\temp\\broken', enabled: false },
          ],
        };
      }
      return {};
    });
    const r = await dispatch(ctx, 'extensions');
    const text = textOf(r);
    expect(text).toContain('Unpacked extensions (2)');
    expect(text).toContain('WS6 Test Extension v1.0 [enabled] id=abc123');
    expect(text).toContain('Broken One v0.9 [DISABLED] id=def456');
    expect(text).toContain('path: C:\\temp\\test-ext');
    expect(calls[0].method).toBe('Extensions.getExtensions');
  });

  it('empty list is the expected stock-profile outcome, not an error', async () => {
    const ctx = baseCtx([], {}, async (method) =>
      method === 'Extensions.getExtensions' ? { extensions: [] } : {});
    const r = await dispatch(ctx, 'extensions');
    const text = textOf(r);
    expect(text).toContain('0 unpacked extensions');
    expect(text).toContain('EXPECTED');
    expect(text).toContain('Load unpacked');
  });

  it('method-missing → actionable fail', async () => {
    const ctx = baseCtx([], {}, async (method) => {
      if (method === 'Extensions.getExtensions') throw new Error("'Extensions.getExtensions' wasn't found");
      return {};
    });
    const r = await dispatch(ctx, 'extensions');
    expect(textOf(r)).toContain('not supported on this browser');
  });
});

describe('browser trigger_extension guardrails (metis-mandatory)', () => {
  const extId = 'abcdefghijklmnopabcdefghijklmnop';

  it('requires exact id and tabId, never inferred', async () => {
    const ctx = baseCtx([], { extensionTriggerAllowlist: [extId] });
    const noId = await dispatch(ctx, 'trigger_extension', { tabId: 'T1' });
    expect(textOf(noId)).toContain('exact extension ID');
    const noTab = await dispatch(ctx, 'trigger_extension', { id: extId });
    expect(textOf(noTab)).toContain("Provide 'tabId'");
  });

  it('default (empty allow-list) → fail with the env remedy; listing unaffected', async () => {
    const calls: Call[] = [];
    const ctx = baseCtx(calls, { extensionTriggerAllowlist: [] });
    const r = await dispatch(ctx, 'trigger_extension', { id: extId, tabId: 'T1' });
    const text = textOf(r);
    expect(text).toContain('not allow-listed');
    expect(text).toContain('CDP_EXTENSION_TRIGGER_ALLOWLIST');
    expect(calls.find((c) => c.method === 'Extensions.triggerAction')).toBeUndefined();
  });

  it('allow-listed id fires triggerAction with exact params + untrusted note', async () => {
    const calls: Call[] = [];
    const ctx = baseCtx(calls, { extensionTriggerAllowlist: [extId] }, async (method, params) => {
      calls.push({ method, params });
      if (method === 'Target.getTargets') {
        if (Array.isArray(params?.filter)) {
          return { targetInfos: [{ targetId: 'TABT-1', type: 'tab', url: 'https://example.com/' }] };
        }
        return { targetInfos: [{ targetId: 'TABBIE', type: 'page', url: 'https://example.com/', parentId: 'TABT-1' }] };
      }
      return {};
    });
    const r = await dispatch(ctx, 'trigger_extension', { id: extId, tabId: 'TABBIE' });
    expect(calls.find((c) => c.method === 'Extensions.triggerAction')?.params).toEqual({ id: extId, targetId: 'TABT-1' });
    const text = textOf(r);
    expect(text).toContain('equivalent to a user clicking the toolbar icon');
    expect(text).toContain('UNTRUSTED');
  });

  it('resolves the tab target by unique URL when parentId is absent', async () => {
    const calls: Call[] = [];
    const ctx = baseCtx(calls, { extensionTriggerAllowlist: [extId] }, async (method, params) => {
      calls.push({ method, params });
      if (method === 'Target.getTargets') {
        if (Array.isArray(params?.filter)) {
          return { targetInfos: [{ targetId: 'TABT-2', type: 'tab', url: 'https://example.com/x' }] };
        }
        return { targetInfos: [{ targetId: 'TABBIE', type: 'page', url: 'https://example.com/x' }] };
      }
      return {};
    });
    await dispatch(ctx, 'trigger_extension', { id: extId, tabId: 'TABBIE' });
    expect(calls.find((c) => c.method === 'Extensions.triggerAction')?.params).toEqual({ id: extId, targetId: 'TABT-2' });
  });

  it('ambiguous tab targets (same URL) are never inferred — actionable fail', async () => {
    const calls: Call[] = [];
    const ctx = baseCtx(calls, { extensionTriggerAllowlist: [extId] }, async (method, params) => {
      calls.push({ method, params });
      if (method === 'Target.getTargets') {
        if (Array.isArray(params?.filter)) {
          return { targetInfos: [
            { targetId: 'TABT-A', type: 'tab', url: 'https://example.com/x' },
            { targetId: 'TABT-B', type: 'tab', url: 'https://example.com/x' },
          ] };
        }
        return { targetInfos: [{ targetId: 'TABBIE', type: 'page', url: 'https://example.com/x' }] };
      }
      return {};
    });
    const r = await dispatch(ctx, 'trigger_extension', { id: extId, tabId: 'TABBIE' });
    expect(textOf(r)).toContain('Could not resolve a tab-type target');
    expect(calls.find((c) => c.method === 'Extensions.triggerAction')).toBeUndefined();
  });

  it('a page-type target with the same URL never counts as the tab target', async () => {
    const calls: Call[] = [];
    const ctx = baseCtx(calls, { extensionTriggerAllowlist: [extId] }, async (method, params) => {
      calls.push({ method, params });
      if (method === 'Target.getTargets') {
        if (Array.isArray(params?.filter)) {
          // Brave's filtered result includes pages as well — only ONE tab-type
          // target matches, but a page-type twin must not add ambiguity.
          return { targetInfos: [
            { targetId: 'TABT-2', type: 'tab', url: 'https://example.com/x' },
            { targetId: 'TABBIE', type: 'page', url: 'https://example.com/x' },
          ] };
        }
        return { targetInfos: [{ targetId: 'TABBIE', type: 'page', url: 'https://example.com/x' }] };
      }
      return {};
    });
    await dispatch(ctx, 'trigger_extension', { id: extId, tabId: 'TABBIE' });
    expect(calls.find((c) => c.method === 'Extensions.triggerAction')?.params).toEqual({ id: extId, targetId: 'TABT-2' });
  });

  it('a DIFFERENT allow-listed id does not authorize another id', async () => {
    const calls: Call[] = [];
    const ctx = baseCtx(calls, { extensionTriggerAllowlist: ['otherid'.repeat(5)] });
    const r = await dispatch(ctx, 'trigger_extension', { id: extId, tabId: 'T1' });
    expect(textOf(r)).toContain('not allow-listed');
    expect(calls.find((c) => c.method === 'Extensions.triggerAction')).toBeUndefined();
  });
});
