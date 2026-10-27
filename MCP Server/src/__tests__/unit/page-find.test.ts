/**
 * B2: page find / find_next / find_stop — JS window.find based find-in-page
 * (the native FindInPage CDP domain returns empty values, so match state can
 * only come from JS). These tests exercise the handler flow against a mocked
 * CDP send: counting pass, first-match selection, next/wrap, lost state.
 */
import { describe, it, expect } from 'vitest';
import { handleFind, handleFindNext, handleFindStop } from '../../tools/page.js';
import type { ServerContext, ToolResult } from '../../types.js';

function makeCtx(evaluateResult: unknown) {
  const findState = new Map<string, { text: string; caseSensitive: boolean; count: number; ordinal: number }>();
  const ctx = {
    tabSessions: {
      getSession: async () => 'sess-parent',
    },
    sendCommand: async () => evaluateResult,
    findState,
  } as unknown as ServerContext & { findState: Map<string, { text: string; caseSensitive: boolean; count: number; ordinal: number }> };
  return { ctx, findState };
}

function textOf(r: ToolResult): string {
  const content = (r as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

describe('page.find (B2, JS window.find)', () => {
  it('requires text', async () => {
    const { ctx } = makeCtx({ result: { value: { count: 3, ordinal: 1 } } });
    const r = await handleFind(ctx, { tabId: 't1' });
    expect(textOf(r)).toContain("Provide 'text'");
  });

  it('reports count and selects the first match, storing state', async () => {
    const { ctx, findState } = makeCtx({ result: { value: { count: 3, ordinal: 1 } } });
    const r = await handleFind(ctx, { tabId: 't1', text: 'lorem' });
    expect(textOf(r)).toContain('Found 3 match(es)');
    expect(textOf(r)).toContain('match 1/3');
    expect(findState.get('sess-parent')).toEqual({ text: 'lorem', caseSensitive: false, count: 3, ordinal: 1 });
  });

  it('reports zero matches and clears state', async () => {
    const { ctx, findState } = makeCtx({ result: { value: { count: 0, ordinal: 0 } } });
    findState.set('sess-parent', { text: 'old', caseSensitive: false, count: 2, ordinal: 2 });
    const r = await handleFind(ctx, { tabId: 't1', text: 'zzz' });
    expect(textOf(r)).toContain('No matches');
    expect(findState.size).toBe(0);
  });

  it('find_next advances and wraps', async () => {
    const { ctx, findState } = makeCtx({ result: { value: { wrapped: false } } });
    findState.set('sess-parent', { text: 'lorem', caseSensitive: false, count: 3, ordinal: 1 });
    const r1 = await handleFindNext(ctx, { tabId: 't1' });
    expect(textOf(r1)).toContain('Match 2/3');
    findState.set('sess-parent', { text: 'lorem', caseSensitive: false, count: 3, ordinal: 3 });
    const wrapped = await makeCtx({ result: { value: { wrapped: true } } });
    wrapped.findState.set('sess-parent', { text: 'lorem', caseSensitive: false, count: 3, ordinal: 3 });
    const r2 = await handleFindNext(wrapped.ctx, { tabId: 't1' });
    expect(textOf(r2)).toContain('Match 1/3');
    expect(textOf(r2)).toContain('wrapped');
  });

  it('find_next fails actionably without an active session', async () => {
    const { ctx } = makeCtx({ result: { value: {} } });
    const r = await handleFindNext(ctx, { tabId: 't1' });
    expect(textOf(r)).toContain('No active find session');
  });

  it('find_stop clears state and selection', async () => {
    const { ctx, findState } = makeCtx({ result: { value: true } });
    findState.set('sess-parent', { text: 'lorem', caseSensitive: false, count: 3, ordinal: 2 });
    const r = await handleFindStop(ctx, { tabId: 't1' });
    expect(textOf(r)).toContain('Find session stopped');
    expect(findState.size).toBe(0);
  });
});
