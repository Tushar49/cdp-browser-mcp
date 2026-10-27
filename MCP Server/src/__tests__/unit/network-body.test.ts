/**
 * B4 network resilience: large bodies overflow to a temp file instead of
 * inlining, unretained bodies retry via Network.streamResourceContent, and
 * durable messages are configured best-effort on the Network.enable path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Buffer } from 'buffer';
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
  __responses: Record<string, unknown>;
  __throwOn: Set<string>;
}

function entry(id: string, url: string, ts: number): NetworkRequestEntry {
  return { id, url, method: 'GET', type: 'xhr', ts, status: 200, mimeType: 'application/json', size: 100 };
}

let tempRoot: string | null = null;

function makeCtx(opts: {
  body?: { body: string; base64Encoded?: boolean };
  bodyThrows?: boolean;
  streamed?: string;
  streamThrows?: boolean;
}): MockCtx {
  tempRoot = mkdtempSync(join(tmpdir(), 'cdp-b4-'));
  const calls: RecordedCall[] = [];
  const ctx: MockCtx = {
    __calls: calls,
    __responses: {},
    __throwOn: new Set<string>(),
    networkReqs: new Map([['s1', new Map([['1', entry('1', 'https://api.example.com/big', 1)]])]]),
    downloads: new Map(),
    pendingDialogs: new Map(),
    consoleEntries: new Map(),
    config: {
      tempDir: tempRoot,
      maxTempFiles: 20,
      maxTempAgeMs: 3600_000,
    } as ServerContext['config'],
    sendCommand: async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
      calls.push({ method, params, sessionId });
      if (method === 'Network.getResponseBody' && opts.bodyThrows) throw new Error('No resource with given identifier found');
      if (method === 'Network.streamResourceContent') {
        if (opts.streamThrows) throw new Error('Streaming not available');
        return { bufferedData: opts.streamed ?? '' };
      }
      if (method === 'Network.getResponseBody') return opts.body ?? {};
      return {};
    },
  } as unknown as MockCtx;
  return ctx;
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

afterEach(() => {
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('observe.request — B4 body resilience', () => {
  it('returns small bodies inline', async () => {
    const ctx = makeCtx({ body: { body: '{"ok":true}' } });
    const reg = new ToolRegistry();
    registerObserveTools(reg, ctx);
    const result = await reg.dispatch('observe', { action: 'request', tabId: 't1', requestId: '1', _sessionId: 's1' }, ctx);
    expect(result.isError).toBeFalsy();
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.requestId).toBe('1');
    expect(body.responseBody).toBe('{"ok":true}');
  });

  it('writes oversized bodies to a temp file with a preview', async () => {
    const big = 'x'.repeat(80_000);
    const ctx = makeCtx({ body: { body: b64(big), base64Encoded: true } });
    const reg = new ToolRegistry();
    registerObserveTools(reg, ctx);
    const result = await reg.dispatch('observe', { action: 'request', tabId: 't1', requestId: '1', _sessionId: 's1' }, ctx);
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text) as {
      responseBodyFile: string;
      responseBodyPreview: string;
      responseBodySize: number;
    };
    expect(parsed.responseBodyFile).toBeDefined();
    expect(parsed.responseBodyPreview).toBe('x'.repeat(2_000));
    expect(parsed.responseBodySize).toBe(80_000);
    // No raw inline dump of the 80k body
    expect(text.length).toBeLessThan(10_000);

    const file = parsed.responseBodyFile;
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(big);
    expect(statSync(file).size).toBe(80_000);
  });

  it('falls back to streamResourceContent when the body is not retained', async () => {
    const ctx = makeCtx({ bodyThrows: true, streamed: b64('{"streamed":true}') });
    const reg = new ToolRegistry();
    registerObserveTools(reg, ctx);
    const result = await reg.dispatch('observe', { action: 'request', tabId: 't1', requestId: '1', _sessionId: 's1' }, ctx);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.responseBody).toBe('{"streamed":true}');
    expect(parsed.bodySource).toBe('stream');
    // A stream attempt happened
    expect(ctx.__calls.some(c => c.method === 'Network.streamResourceContent')).toBe(true);
  });

  it('reports a readable error when both body paths fail', async () => {
    const ctx = makeCtx({ bodyThrows: true, streamThrows: true });
    const reg = new ToolRegistry();
    registerObserveTools(reg, ctx);
    const result = await reg.dispatch('observe', { action: 'request', tabId: 't1', requestId: '1', _sessionId: 's1' }, ctx);
    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain('[Not available:');
  });

  it('configures durable messages best-effort on the request path', async () => {
    const ctx = makeCtx({ body: { body: 'x' } });
    const reg = new ToolRegistry();
    registerObserveTools(reg, ctx);
    await reg.dispatch('observe', { action: 'request', tabId: 't1', requestId: '1', _sessionId: 's1' }, ctx);
    const durable = ctx.__calls.find(c => c.method === 'Network.configureDurableMessages');
    expect(durable).toBeDefined();
    expect(durable?.sessionId).toBe('s1');
  });
});
