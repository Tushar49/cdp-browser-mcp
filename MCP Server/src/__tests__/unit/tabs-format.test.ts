/**
 * Agent-DX E6 (v5.2): tabs list/find — parseable JSON output + URL filter.
 * Motivated by a live agent failure: it tried JS `.find()` on the formatted
 * text result and crashed.
 */
import { describe, it, expect } from 'vitest';
import { handleList, handleFind } from '../../tools/tabs.js';
import type { ServerContext, ToolResult } from '../../types.js';

function textOf(r: ToolResult): string {
  const content = (r as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

function makeCtx(targetInfos: Array<Record<string, unknown>>) {
  const ctx = {
    sendCommand: async () => ({ targetInfos }),
    tabOwnership: {
      getLock: () => undefined,
    },
  } as unknown as ServerContext;
  return ctx;
}

const TABS = [
  { targetId: 'aaa', url: 'http://localhost:9091/app', title: 'App', type: 'page' },
  { targetId: 'bbb', url: 'https://example.com', title: 'Example', type: 'page', browserContextId: 'ctx12345678' },
];

describe('tabs list/find (E6)', () => {
  it("list format:'json' returns a parseable array", async () => {
    const ctx = makeCtx(TABS);
    const r = await handleList(ctx, { format: 'json' });
    const parsed = JSON.parse(textOf(r)) as Array<{ id: string; url: string; title: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('aaa');
    expect(parsed[0].url).toBe('http://localhost:9091/app');
    expect(parsed[1].title).toBe('Example');
  });

  it('list urlFilter narrows server-side', async () => {
    const ctx = makeCtx(TABS);
    const r = await handleList(ctx, { urlFilter: '9091' });
    expect(textOf(r)).toContain('1 tab(s)');
    expect(textOf(r)).toContain('aaa');
    expect(textOf(r)).not.toContain('example.com');
  });

  it('list urlFilter with no match reports it', async () => {
    const ctx = makeCtx(TABS);
    const r = await handleList(ctx, { urlFilter: 'nothing-matches' });
    expect(textOf(r)).toContain('No tabs with URL containing');
  });

  it("find format:'json' returns parseable hits", async () => {
    const ctx = makeCtx(TABS);
    const r = await handleFind(ctx, { query: 'example' });
    expect(textOf(r)).toContain('1 match(es)');
    const rJson = await handleFind(ctx, { query: 'example', format: 'json' });
    const parsed = JSON.parse(textOf(rJson)) as Array<{ id: string }>;
    expect(parsed).toEqual([{ id: 'bbb', url: 'https://example.com', title: 'Example', profile: 'ctx12345' }]);
  });
});
