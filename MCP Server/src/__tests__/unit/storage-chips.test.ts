/**
 * WS9 — CHIPS partitionKey through the storage surface: set_cookie / delete_cookies
 * params, get_cookies partitioned line, export passthrough / import round-trip —
 * all against a mocked CDP send.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../tools/registry.js';
import { registerStorageTools } from '../../tools/storage.js';
import type { ServerContext } from '../../types.js';

function makeCtx(pageHref = 'http://localhost:8877/chips.html') {
  const send = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'Runtime.evaluate' && String(params.expression).includes('location'))
      return { result: { value: pageHref } };
    if (method === 'Network.getCookies' || method === 'Storage.getCookies')
      return { cookies: [] };
    if (method === 'Network.setCookie') return { success: true };
    return {};
  });
  const ctx = {
    sendCommand: send,
    config: { actionTimeout: 1000 },
    tabSessions: { getSession: vi.fn(async () => 'sess1') },
  } as unknown as ServerContext;
  return { ctx, send };
}
function args(over: Record<string, unknown>) { return { tabId: 't1', _sessionId: 'sess1', ...over }; }
function textOf(res: { content?: Array<{ text?: string }> }) { return res.content?.[0]?.text ?? ''; }

describe('storage WS9 — CHIPS partitionKey', () => {
  let registry: ToolRegistry;
  beforeEach(() => { registry = new ToolRegistry(); registerStorageTools(registry, {} as ServerContext); });

  it('schema exposes partitionKey', () => {
    const tool = registry.list().find((t) => t.name === 'storage')!;
    expect(tool.inputSchema.properties.partitionKey).toBeDefined();
  });

  it('set_cookie: string shorthand normalizes to {topLevelSite, hasCrossSiteAncestor:false} + auto-Secure', async () => {
    const { ctx, send } = makeCtx();
    await registry.dispatch('storage', args({ action: 'set_cookie', name: 'c1', value: 'v', partitionKey: 'http://localhost' }), ctx);
    const setParams = send.mock.calls.find((c) => c[0] === 'Network.setCookie')[1];
    expect(setParams.partitionKey).toEqual({ topLevelSite: 'http://localhost', hasCrossSiteAncestor: false });
    expect(setParams.secure).toBe(true);
  });

  it('set_cookie: object form passes topLevelSite through, trailing slashes stripped', async () => {
    const { ctx, send } = makeCtx();
    await registry.dispatch('storage', args({
      action: 'set_cookie', name: 'c1', value: 'v',
      partitionKey: { topLevelSite: 'https://a.example.com/', hasCrossSiteAncestor: true },
    }), ctx);
    const setParams = send.mock.calls.find((c) => c[0] === 'Network.setCookie')[1];
    expect(setParams.partitionKey).toEqual({ topLevelSite: 'https://a.example.com', hasCrossSiteAncestor: true });
  });

  it('set_cookie: bare host rejects with the origin remedy', async () => {
    const { ctx } = makeCtx();
    const res = await registry.dispatch('storage', args({ action: 'set_cookie', name: 'c1', value: 'v', partitionKey: 'localhost' }), ctx);
    expect(textOf(res)).toContain('partitionKey: partitionKey string must be an absolute origin');
  });

  it('set_cookie: explicit secure:false is respected (not overwritten)', async () => {
    const { ctx, send } = makeCtx();
    await registry.dispatch('storage', args({
      action: 'set_cookie', name: 'c1', value: 'v', secure: false, partitionKey: 'http://localhost',
    }), ctx);
    expect(send.mock.calls.find((c) => c[0] === 'Network.setCookie')[1].secure).toBe(false);
  });

  it('delete_cookies: partitionKey rides the CDP delete', async () => {
    const { ctx, send } = makeCtx();
    await registry.dispatch('storage', args({ action: 'delete_cookies', name: 'c1', url: 'http://localhost:8877/x', partitionKey: 'http://localhost' }), ctx);
    const delParams = send.mock.calls.find((c) => c[0] === 'Network.deleteCookies')[1];
    expect(delParams.partitionKey).toEqual({ topLevelSite: 'http://localhost', hasCrossSiteAncestor: false });
    expect(delParams.name).toBe('c1');
  });

  it('get_cookies: partitioned cookie prints the | partitioned suffix; plain does not', async () => {
    const { ctx } = makeCtx();
    (ctx.sendCommand as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') return { result: { value: 'http://localhost:8877/x' } };
      if (method === 'Network.enable' || method === 'Network.deleteCookies' || method === 'Network.setCookie') return {};
      return {
        cookies: [
          { name: 'plain', value: 'x', domain: '.localhost', path: '/', expires: -1, httpOnly: false, secure: false },
          { name: 'partitioned', value: 'y', domain: 'a.com', path: '/', expires: -1, secure: true,
            partitionKey: { topLevelSite: 'http://localhost', hasCrossSiteAncestor: false } },
        ],
      };
    });
    const res = await registry.dispatch('storage', args({ action: 'get_cookies' }), ctx);
    const out = textOf(res);
    expect(out).toContain('partitioned: http://localhost');
    expect(out).not.toContain('| partitioned: undefined');
  });

  it('import_state: partitionKey round-trips identically into the setCookie params', async () => {
    const { ctx, send } = makeCtx();
    const state = {
      cookies: [{ name: 'pk', value: '1', domain: 'a.com', path: '/', secure: true,
        partitionKey: { topLevelSite: 'http://localhost', hasCrossSiteAncestor: false } }],
      origins: [],
    };
    await registry.dispatch('storage', args({ action: 'import_state', state }), ctx);
    const setParams = send.mock.calls.find((c) => c[0] === 'Network.setCookie')[1];
    expect(setParams.partitionKey).toEqual({ topLevelSite: 'http://localhost', hasCrossSiteAncestor: false });
    expect(setParams.secure).toBe(true);
    const out = textOf(await registry.dispatch('storage', args({ action: 'import_state', state }), ctx));
    expect(out).toContain('1 cookie(s) set');
  });
});
