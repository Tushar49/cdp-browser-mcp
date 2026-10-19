/**
 * Parity with Playwright MCP browser_network_requests inline-body return —
 * single-call equivalent. observe.request now accepts urlFilter as an
 * alternative to requestId so agents can grab a response body without
 * first calling observe.network to look up the requestId.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../tools/registry.js';
import { registerObserveTools } from '../../tools/observe.js';
import type { NetworkRequestEntry, ServerContext } from '../../types.js';

interface RecordedCall {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

interface MockCtx extends ServerContext {
  __calls: RecordedCall[];
}

function entry(id: string, url: string, ts: number, status: number | null = 200): NetworkRequestEntry {
  return { id, url, method: 'GET', type: 'xhr', ts, status, mimeType: 'application/json', size: 100 };
}

function mockCtxWithNetwork(reqMap: Map<string, NetworkRequestEntry>): MockCtx {
  const calls: RecordedCall[] = [];
  const networkReqs = new Map<string, Map<string, NetworkRequestEntry>>();
  networkReqs.set('s1', reqMap);

  const responses: Record<string, unknown> = {
    'Network.getResponseBody': { body: '{"ok":true}', base64Encoded: false },
    'Network.getRequestPostData': { postData: 'q=1' },
    'Network.enable': {},
  };

  return {
    __calls: calls,
    networkReqs,
    sendCommand: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
      calls.push({ method, params, sessionId });
      return responses[method] ?? {};
    },
  } as unknown as MockCtx;
}

describe('observe.request — urlFilter (Playwright parity)', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerObserveTools(registry, mockCtxWithNetwork(new Map()));
  });

  it('exposes urlFilter in the observe tool inputSchema', () => {
    const tool = registry.list().find(t => t.name === 'observe')!;
    const props = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
    expect(props.urlFilter).toBeDefined();
    expect(props.urlFilter.type).toBe('string');
  });

  it('mentions urlFilter in the request action description', () => {
    const tool = registry.list().find(t => t.name === 'observe')!;
    expect(tool.description).toContain('urlFilter');
  });

  it('rejects request with neither requestId nor urlFilter', async () => {
    const ctx = mockCtxWithNetwork(new Map());
    const reg = new ToolRegistry();
    registerObserveTools(reg, ctx);
    const result = await reg.dispatch(
      'observe',
      { action: 'request', tabId: 't1', _sessionId: 's1' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('urlFilter');
  });

  it('reports an error when no captured requests match urlFilter', async () => {
    const reqMap = new Map([['1', entry('1', 'https://x.com/a', 1)]]);
    const ctx = mockCtxWithNetwork(reqMap);
    const reg = new ToolRegistry();
    registerObserveTools(reg, ctx);
    const result = await reg.dispatch(
      'observe',
      { action: 'request', tabId: 't1', urlFilter: 'no-match', _sessionId: 's1' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('no-match');
  });

  it('resolves urlFilter to the most recent matching requestId and fetches its body', async () => {
    const reqMap = new Map([
      ['1', entry('1', 'https://api.example.com/users', 100)],
      ['2', entry('2', 'https://api.example.com/users', 200)], // newer — should win
      ['3', entry('3', 'https://api.example.com/orders', 150)],
    ]);
    const ctx = mockCtxWithNetwork(reqMap);
    const reg = new ToolRegistry();
    registerObserveTools(reg, ctx);

    const result = await reg.dispatch(
      'observe',
      { action: 'request', tabId: 't1', urlFilter: 'users', _sessionId: 's1' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const bodyCall = ctx.__calls.find(c => c.method === 'Network.getResponseBody');
    expect(bodyCall?.params?.requestId).toBe('2');

    const text = (result.content[0] as { text: string }).text;
    // Result is JSON-stringified by ok() when given an object
    expect(text).toContain('"requestId"');
    expect(text).toContain('"matchedFrom"');
    expect(text).toContain('"users"');
  });

  it('still honors explicit requestId when both are passed', async () => {
    const reqMap = new Map([['7', entry('7', 'https://api.example.com/users', 1)]]);
    const ctx = mockCtxWithNetwork(reqMap);
    const reg = new ToolRegistry();
    registerObserveTools(reg, ctx);

    await reg.dispatch(
      'observe',
      { action: 'request', tabId: 't1', requestId: '99', urlFilter: 'users', _sessionId: 's1' },
      ctx,
    );

    const bodyCall = ctx.__calls.find(c => c.method === 'Network.getResponseBody');
    expect(bodyCall?.params?.requestId).toBe('99');
  });
});
