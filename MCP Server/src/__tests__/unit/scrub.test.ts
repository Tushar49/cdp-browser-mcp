/**
 * 5.3 WS1 O2 — secrets scrubber matrix.
 *
 * The choke point is registry.dispatch's return path: every result path
 * (ok()/fail()/success()/raw literals/wrapped errors) must come out masked.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../tools/registry.js';
import { success } from '../../tools/base-tool.js';
import { scrubText, scrubToolResult, NO_SCRUB } from '../../utils/scrub.js';
import type { ToolDefinition, ToolResult, ServerContext } from '../../types.js';

function makeCtx(): ServerContext {
  return {} as ServerContext;
}

function registerRaw(registry: ToolRegistry, name: string, result: ToolResult): void {
  const tool: ToolDefinition = {
    name,
    description: 'test',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => result,
  };
  registry.register(tool);
}

describe('scrubText', () => {
  it('masks JSON-style secret pairs', () => {
    expect(scrubText('{"apiKey":"sk-123","user":"bob"}'))
      .toBe('{"apiKey":"***","user":"bob"}');
  });

  it('masks plain key=value pairs', () => {
    expect(scrubText('password=hunter2&user=bob')).toBe('password=***&user=bob');
  });

  it('masks Authorization headers with Bearer values', () => {
    expect(scrubText('Authorization: Bearer abc.def.ghi')).toBe('Authorization: ***');
  });

  it('masks secret keys with suffixes (accessToken, credentialId)', () => {
    expect(scrubText('accessToken: xyz')).toBe('accessToken: ***');
    expect(scrubText('{"credentialId":"c-9"}')).toBe('{"credentialId":"***"}');
  });

  it('masks known-bearer cookie names', () => {
    expect(scrubText('session_token=abc123; Path=/')).toBe('session_token=***; Path=/');
  });

  it('leaves non-secret pairs alone', () => {
    expect(scrubText('name=SID; value=abc; HttpOnly')).toBe('name=SID; value=abc; HttpOnly');
    expect(scrubText('user: bob')).toBe('user: bob');
  });

  it('accepts documented over-reach: keyword matches the key fragment', () => {
    expect(scrubText('keyword: definition')).toBe('keyword: ***');
  });
});

describe('scrubToolResult (structured + text)', () => {
  it('scrubs text content items', () => {
    const result = { content: [{ type: 'text', text: 'token: abc' }] };
    const out = scrubToolResult(result);
    expect(out.content?.[0].text).toBe('token: ***');
  });

  it('masks string values under secret-bearing structured keys', () => {
    const result = {
      content: [{ type: 'text', text: 'dump' }],
      cookies: [{ name: 'SID', value: 'x' }],
    } as ToolResult & { auth?: Record<string, unknown> };
    (result as Record<string, unknown>).auth = { token: 'abc' };
    const out = scrubToolResult(result);
    expect((out as Record<string, unknown>).auth).toEqual({ token: '***' });
    expect((out as Record<string, unknown>).cookies).toEqual([{ name: 'SID', value: 'x' }]);
  });

  it('honors the _noScrub opt-out and consumes the marker', () => {
    const result = {
      content: [{ type: 'text', text: 'token: abc' }],
      [NO_SCRUB]: true,
    } as unknown as ToolResult;
    const out = scrubToolResult(result);
    expect(out.content?.[0].text).toBe('token: abc');
    expect((out as Record<string, unknown>)[NO_SCRUB]).toBeUndefined();
  });

  it('is idempotent', () => {
    const once = scrubText('password=abc');
    expect(scrubText(once)).toBe(once);
  });
});

describe('registry.dispatch choke point', () => {
  it('scrubs results flowing through success() (not ok())', async () => {
    const registry = new ToolRegistry();
    registerRaw(registry, 'header-dump', success('request headers:\nAuthorization: Bearer live-token\napiKey: k-9'));
    const out = await registry.dispatch('header-dump', {}, makeCtx());
    const text = out.content[0].text as string;
    expect(text).not.toContain('live-token');
    expect(text).toContain('Authorization: ***');
    expect(text).toContain('apiKey: ***');
  });

  it('scrubs ok()-path results', async () => {
    const registry = new ToolRegistry();
    registerRaw(registry, 'json-dump', {
      content: [{ type: 'text', text: '{"password":"letmein"}' }],
    });
    const out = await registry.dispatch('json-dump', {}, makeCtx());
    expect(out.content[0].text).toBe('{"password":"***"}');
  });

  it('scrubs wrapped errors (message text)', async () => {
    const registry = new ToolRegistry();
    const tool: ToolDefinition = {
      name: 'boomer',
      description: 'test',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => { throw new Error('failed to auth with token=supersecret'); },
    };
    registry.register(tool);
    const out = await registry.dispatch('boomer', {}, makeCtx());
    const text = out.content[0].text as string;
    expect(out.isError).toBe(true);
    expect(text).not.toContain('supersecret');
    expect(text).toContain('token=');
  });

  it('export_state-style results survive via _noScrub', async () => {
    const registry = new ToolRegistry();
    const tool: ToolDefinition = {
      name: 'export_state',
      description: 'test',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        content: [{ type: 'text', text: '{"token":"keep-me-for-import"}' }],
        [NO_SCRUB]: true,
      } as unknown as ToolResult),
    };
    registry.register(tool);
    const out = await registry.dispatch('export_state', {}, makeCtx());
    expect(out.content[0].text).toContain('keep-me-for-import');
  });
});
