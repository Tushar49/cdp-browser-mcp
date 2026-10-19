/**
 * Parity with Playwright MCP browser_localstorage_* / browser_sessionstorage_*
 * — single-call equivalent. These tests cover the schema surface, dispatch
 * wiring for get_storage / set_storage / delete_storage, and the JS expression
 * builder used to read web storage via Runtime.evaluate.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../tools/registry.js';
import { registerStorageTools } from '../../tools/storage.js';
import { buildGetStorageExpression } from '../../tools/storage.js';
import type { ServerContext } from '../../types.js';

interface RecordedCall {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface MockCtx extends ServerContext {
  __calls: RecordedCall[];
  __nextResult: unknown;
}

function mockCtx(): MockCtx {
  const calls: RecordedCall[] = [];
  let nextResult: unknown = { result: { value: true } };
  const ctx = {
    __calls: calls,
    get __nextResult() { return nextResult; },
    set __nextResult(v: unknown) { nextResult = v; },
    sendCommand: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
      calls.push({ method, params, sessionId });
      return nextResult;
    },
  } as unknown as MockCtx;
  return ctx;
}

describe('storage — web storage R/W (Playwright parity)', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerStorageTools(registry, mockCtx());
  });

  it('exposes get_storage / set_storage / delete_storage in the action enum', () => {
    const tool = registry.list().find(t => t.name === 'storage')!;
    const props = (tool.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;
    const actions = props.action.enum ?? [];
    expect(actions).toContain('get_storage');
    expect(actions).toContain('set_storage');
    expect(actions).toContain('delete_storage');
  });

  it('declares storageType with local/session enum and key as a string', () => {
    const tool = registry.list().find(t => t.name === 'storage')!;
    const props = (tool.inputSchema.properties ?? {}) as Record<string, { enum?: string[]; type?: string }>;
    expect(props.storageType.enum).toEqual(['local', 'session']);
    expect(props.key.type).toBe('string');
  });

  it('mentions web storage in the description so agents can discover it', () => {
    const tool = registry.list().find(t => t.name === 'storage')!;
    expect(tool.description).toContain('localStorage');
    expect(tool.description).toContain('sessionStorage');
  });

  describe('buildGetStorageExpression()', () => {
    it('builds a key-specific localStorage getItem expression', async () => {
      const expr = await buildGetStorageExpression('localStorage', 'auth_token');
      expect(expr).toContain('localStorage.getItem("auth_token")');
    });

    it('builds a key-specific sessionStorage getItem expression', async () => {
      const expr = await buildGetStorageExpression('sessionStorage', 'csrf');
      expect(expr).toContain('sessionStorage.getItem("csrf")');
    });

    it('builds a whole-area dump expression when key is omitted', async () => {
      const expr = await buildGetStorageExpression('localStorage');
      expect(expr).toContain('localStorage.length');
      expect(expr).toContain('localStorage.key(i)');
      expect(expr).toContain('localStorage.getItem(k)');
    });

    it('properly escapes keys containing quotes and backslashes', async () => {
      const expr = await buildGetStorageExpression('localStorage', 'a"b\\c');
      // JSON.stringify produces "a\"b\\c"
      expect(expr).toContain('"a\\"b\\\\c"');
    });
  });

  describe('dispatch wiring', () => {
    it('routes get_storage to a Runtime.evaluate localStorage call by default', async () => {
      const ctx = mockCtx();
      ctx.__nextResult = { result: { value: 'hello' } };
      const reg = new ToolRegistry();
      registerStorageTools(reg, ctx);

      const result = await reg.dispatch(
        'storage',
        { action: 'get_storage', tabId: 't1', key: 'name', _sessionId: 's1' },
        ctx,
      );

      const last = ctx.__calls.at(-1);
      expect(last?.method).toBe('Runtime.evaluate');
      const expr = (last?.params as { expression: string }).expression;
      expect(expr).toContain('localStorage.getItem("name")');
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('localStorage["name"]');
      expect(text).toContain('"hello"');
    });

    it('routes get_storage with storageType=session to sessionStorage', async () => {
      const ctx = mockCtx();
      ctx.__nextResult = { result: { value: 'tok' } };
      const reg = new ToolRegistry();
      registerStorageTools(reg, ctx);

      await reg.dispatch(
        'storage',
        { action: 'get_storage', tabId: 't1', storageType: 'session', key: 'csrf', _sessionId: 's1' },
        ctx,
      );

      const expr = (ctx.__calls.at(-1)?.params as { expression: string }).expression;
      expect(expr).toContain('sessionStorage.getItem("csrf")');
    });

    it('rejects set_storage when key or value is missing', async () => {
      const ctx = mockCtx();
      const reg = new ToolRegistry();
      registerStorageTools(reg, ctx);

      const result = await reg.dispatch(
        'storage',
        { action: 'set_storage', tabId: 't1', _sessionId: 's1' },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain("'key'");
    });

    it('routes delete_storage without key to a clear() expression', async () => {
      const ctx = mockCtx();
      ctx.__nextResult = { result: { value: true } };
      const reg = new ToolRegistry();
      registerStorageTools(reg, ctx);

      await reg.dispatch(
        'storage',
        { action: 'delete_storage', tabId: 't1', _sessionId: 's1' },
        ctx,
      );

      const expr = (ctx.__calls.at(-1)?.params as { expression: string }).expression;
      expect(expr).toContain('localStorage.clear()');
    });
  });
});
