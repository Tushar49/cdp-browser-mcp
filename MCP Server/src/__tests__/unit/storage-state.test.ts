import fs from 'fs';
/**
 * storageState one-shot (5.1.0 A3) — export_state / import_state schema,
 * dispatch wiring, and handler round-trip with a mocked CDP send.
 * Mock is method-keyed: responses route by CDP method name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../tools/registry.js';
import { registerStorageTools } from '../../tools/storage.js';
import type { ServerContext } from '../../types.js';

const ORIGIN = 'https://example.com';
const COOKIE = {
  name: 'sid', value: 'abc123', domain: '.example.com', path: '/',
  expires: 9999999999, httpOnly: true, secure: true, sameSite: 'Lax',
};

interface Queues {
  cookiesQ: unknown[];
  setCookieQ: unknown[];
  evalQ: unknown[];
}

function makeCtx(): { ctx: ServerContext; send: ReturnType<typeof vi.fn> } & Queues {
  const cookiesQ: unknown[] = [];
  const setCookieQ: unknown[] = [];
  const evalQ: unknown[] = [];
  const send = vi.fn(async (method: string) => {
    if (method === 'Network.getCookies') {
      const v = cookiesQ.shift();
      return v ?? { cookies: [] };
    }
    if (method === 'Network.setCookie') {
      const v = setCookieQ.shift();
      return v ?? { success: true };
    }
    if (method === 'Runtime.evaluate') {
      const v = evalQ.shift();
      return v ?? { result: { value: ORIGIN } };
    }
    return {};
  });
  const ctx = {
    sendCommand: send,
    config: { actionTimeout: 1000, autoWait: true },
    tabSessions: { getSession: vi.fn(async () => 'sess1') },
  } as unknown as ServerContext;
  return { ctx, send, cookiesQ, setCookieQ, evalQ };
}

function storageArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { action: 'export_state', tabId: 't1', _sessionId: 'sess1', ...over };
}

function textOf(res: unknown): string {
  return ((res as { content: Array<{ text: string }> }).content ?? [{}])[0].text ?? '';
}

describe('storage.export_state / import_state (5.1.0 A3)', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerStorageTools(registry, {} as ServerContext);
  });

  it('exposes both actions in the inputSchema enum', () => {
    const tool = registry.list().find((t) => t.name === 'storage')!;
    const action = (tool.inputSchema.properties as Record<string, { enum?: string[] }>).action;
    expect(action.enum).toContain('export_state');
    expect(action.enum).toContain('import_state');
  });

  it('describes the per-origin localStorage limitation so agents know', () => {
    const tool = registry.list().find((t) => t.name === 'storage')!;
    expect(tool.description).toContain('export_state');
    expect(tool.description).toContain('import_state');
    expect(tool.description).toContain('per-origin');
  });

  it('exports cookies + current origin localStorage as Playwright-shaped JSON', async () => {
    const { ctx, cookiesQ, evalQ } = makeCtx();
    cookiesQ.push({ cookies: [COOKIE] });
    evalQ.push({ result: { value: ORIGIN } });
    evalQ.push({ result: { value: { token: 't1' } } });
    const res = await registry.dispatch('storage', storageArgs(), ctx);
    const text = textOf(res);
    expect(text).toContain('1 cookie(s)');
    expect(text).toContain('"cookies"');
    expect(text).toContain('"origin": "https://example.com"');
    expect(text).toContain('"token": "t1"');
    expect(text).toContain('import_state');
  });

  it('includeSessionStorage captures sessionStorage too', async () => {
    const { ctx, cookiesQ, evalQ } = makeCtx();
    cookiesQ.push({ cookies: [] });
    evalQ.push({ result: { value: ORIGIN } });
    evalQ.push({ result: { value: {} } });
    evalQ.push({ result: { value: { flash: 'msg' } } });
    const res = await registry.dispatch(
      'storage', storageArgs({ includeSessionStorage: true }), ctx,
    );
    const text = textOf(res);
    expect(text).toContain('"sessionStorage"');
    expect(text).toContain('"flash": "msg"');
  });

  it('import_state without state → actionable failure', async () => {
    const { ctx } = makeCtx();
    const res = await registry.dispatch('storage', storageArgs({ action: 'import_state' }), ctx);
    expect(textOf(res)).toContain("Provide 'state'");
  });

  it('imports cookies (clearFirst) + same-origin localStorage', async () => {
    const { ctx, send, setCookieQ } = makeCtx();
    setCookieQ.push({ success: true });
    const res = await registry.dispatch('storage', storageArgs({
      action: 'import_state',
      clearFirst: true,
      state: {
        cookies: [COOKIE],
        origins: [{ origin: ORIGIN, localStorage: [{ name: 'theme', value: 'dark' }] }],
      },
    }), ctx);
    const text = textOf(res);
    expect(text).toContain('1 cookie(s) set');
    expect(text).toContain('1 localStorage entry applied');
    expect(send.mock.calls.some((c) => c[0] === 'Network.clearBrowserCookies')).toBe(true);
    const setCall = send.mock.calls.find((c) => c[0] === 'Network.setCookie');
    expect((setCall![1] as Record<string, unknown>).domain).toBe('.example.com');
  });

  it('reports other-origin localStorage as skipped with guidance', async () => {
    const { ctx } = makeCtx();
    const res = await registry.dispatch('storage', storageArgs({
      action: 'import_state',
      state: {
        cookies: [COOKIE],
        origins: [{ origin: 'https://other.com', localStorage: [{ name: 'x', value: 'y' }] }],
      },
    }), ctx);
    const text = textOf(res);
    expect(text).toContain('not applied');
    expect(text).toContain('https://other.com');
    expect(text).toContain('per-origin');
    expect(text).toContain('https://other.com');
    expect(text).toContain('per-origin');
  });

  it('sameSite None forces secure=true on import', async () => {
    const { ctx, send, setCookieQ } = makeCtx();
    setCookieQ.push({ success: true });
    await registry.dispatch('storage', storageArgs({
      action: 'import_state',
      state: {
        cookies: [{ ...COOKIE, sameSite: 'None', secure: undefined }],
        origins: [],
      },
    }), ctx);
    const setCall = send.mock.calls.find((c) => c[0] === 'Network.setCookie');
    expect((setCall![1] as Record<string, unknown>).secure).toBe(true);
  });
});
