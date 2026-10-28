/**
 * 5.3 WS2 — page.verify checks. Handler-flow tests against a mocked CDP
 * send: per-check PASS/FAIL, url modes, uid-routed probe, polling to pass,
 * validation errors. FAIL is a legitimate (non-error) answer.
 */
import { describe, it, expect } from 'vitest';
import { handleVerify } from '../../tools/page.js';
import type { ServerContext, ToolResult } from '../../types.js';

interface MockReply { method: string; value: unknown }

/**
 * sendCommand replies by method; consecutive calls to the same method
 * consume queued values in order (last one repeats).
 */
function makeCtx(replies: MockReply[], extra: Record<string, unknown> = {}) {
  const byMethod = new Map<string, unknown[]>();
  for (const r of replies) {
    const q = byMethod.get(r.method) ?? [];
    q.push(r.value);
    byMethod.set(r.method, q);
  }
  const lastUsed = new Map<string, unknown>();
  const ctx = {
    tabSessions: {
      getSession: async () => 'sess-parent',
      getRefSession: () => undefined,
    },
    sendCommand: async (method: string) => {
      const q = byMethod.get(method) ?? [];
      const v = q.length ? q.shift() : lastUsed.get(method);
      if (v !== undefined) lastUsed.set(method, v);
      return method === 'Runtime.evaluate' ? { result: { value: v } } : v;
    },
    elementResolvers: new Map<string, { resolve: (uid: number) => number | undefined }>(),
    ...extra,
  } as unknown as ServerContext;
  return ctx;
}

function textOf(r: ToolResult): string {
  const content = (r as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

describe('handleVerify (WS2)', () => {
  it('requires a valid check', async () => {
    const ctx = makeCtx([]);
    expect(textOf(await handleVerify(ctx, { tabId: 't1' }))).toContain("Provide 'check'");
    expect(textOf(await handleVerify(ctx, { tabId: 't1', check: 'nope' }))).toContain('one of:');
  });

  it('url: exact PASS and FAIL', async () => {
    const ctx = makeCtx([{ method: 'Runtime.evaluate', value: 'https://example.com/a' }]);
    const pass = await handleVerify(ctx, { tabId: 't1', check: 'url', value: 'https://example.com/a' });
    expect(textOf(pass)).toMatch(/^PASS — url:/);
    expect((pass as { isError?: boolean }).isError).toBeUndefined();
    const failCase = await handleVerify(makeCtx([{ method: 'Runtime.evaluate', value: 'https://example.com/a' }]), {
      tabId: 't1', check: 'url', value: 'https://other.com',
    });
    expect(textOf(failCase)).toContain('FAIL — expected: exact: https://other.com');
    expect((failCase as { isError?: boolean }).isError).toBeUndefined();
  });

  it('url: prefix and regex modes', async () => {
    const ctx = makeCtx([{ method: 'Runtime.evaluate', value: 'https://example.com/list?page=2' }]);
    expect(textOf(await handleVerify(ctx, { tabId: 't1', check: 'url', value: 'https://example.com/list', mode: 'prefix' }))).toMatch(/^PASS/);
    expect(textOf(await handleVerify(ctx, { tabId: 't1', check: 'url', value: '\\?page=2$', mode: 'regex' }))).toMatch(/^PASS/);
    expect(textOf(await handleVerify(ctx, { tabId: 't1', check: 'url', value: '\\?page=9$', mode: 'regex' }))).toMatch(/^FAIL/);
  });

  it('title: PASS and FAIL', async () => {
    const ctx = makeCtx([{ method: 'Runtime.evaluate', value: 'My Page' }]);
    expect(textOf(await handleVerify(ctx, { tabId: 't1', check: 'title', value: 'My Page' }))).toMatch(/^PASS — title:/);
    expect(textOf(await handleVerify(makeCtx([{ method: 'Runtime.evaluate', value: 'My Page' }]), {
      tabId: 't1', check: 'title', value: 'Other',
    }))).toContain('actual: My Page');
  });

  it('text: page substring PASS, exact FAIL, requires value', async () => {
    const ctx = makeCtx([{ method: 'Runtime.evaluate', value: 'lorem ipsum dolor' }]);
    expect(textOf(await handleVerify(ctx, { tabId: 't1', check: 'text', value: 'ipsum' }))).toMatch(/^PASS — text:/);
    const exact = await handleVerify(makeCtx([{ method: 'Runtime.evaluate', value: 'lorem ipsum dolor' }]), {
      tabId: 't1', check: 'text', value: 'ipsum', exact: true,
    });
    expect(textOf(exact)).toMatch(/^FAIL/);
    expect(textOf(await handleVerify(makeCtx([]), { tabId: 't1', check: 'text' }))).toContain("Provide 'value'");
  });

  it('visible: selector probe PASS and element-not-found FAIL', async () => {
    const ctx = makeCtx([{ method: 'Runtime.evaluate', value: { found: true, visible: true } }]);
    expect(textOf(await handleVerify(ctx, { tabId: 't1', check: 'visible', selector: '#ok' }))).toMatch(/^PASS — visible: visible/);
    const missing = await handleVerify(makeCtx([{ method: 'Runtime.evaluate', value: { found: false } }]), {
      tabId: 't1', check: 'visible', selector: '#gone',
    });
    expect(textOf(missing)).toContain('actual: element not found');
  });

  it('visible: requires uid or selector', async () => {
    const ctx = makeCtx([]);
    expect(textOf(await handleVerify(ctx, { tabId: 't1', check: 'visible' }))).toContain("Provide 'uid' or 'selector'");
  });

  it('enabled: disabled element FAILs, enabled PASSes', async () => {
    const ctx = makeCtx([{ method: 'Runtime.evaluate', value: { found: true, visible: true, disabled: true } }]);
    expect(textOf(await handleVerify(ctx, { tabId: 't1', check: 'enabled', selector: 'button' }))).toContain('actual: disabled');
    const okCtx = makeCtx([{ method: 'Runtime.evaluate', value: { found: true, visible: true, disabled: false } }]);
    expect(textOf(await handleVerify(okCtx, { tabId: 't1', check: 'enabled', selector: 'button' }))).toMatch(/^PASS — enabled: enabled/);
  });

  it('value: matches input value', async () => {
    const ctx = makeCtx([{ method: 'Runtime.evaluate', value: { found: true, value: 'harry' } }]);
    expect(textOf(await handleVerify(ctx, { tabId: 't1', check: 'value', selector: 'input', value: 'harry' }))).toMatch(/^PASS/);
    const wrong = await handleVerify(makeCtx([{ method: 'Runtime.evaluate', value: { found: true, value: 'hermione' } }]), {
      tabId: 't1', check: 'value', selector: 'input', value: 'harry',
    });
    expect(textOf(wrong)).toContain('actual: hermione');
  });

  it('uid probes route through resolver + callFunctionOn', async () => {
    const resolver = { resolve: (uid: number) => (uid === 5 ? 101 : undefined) };
    const ctx = makeCtx(
      [
        { method: 'DOM.resolveNode', value: { object: { objectId: 'obj-1' } } },
        // resolveElement's own metadata callFunctionOn
        { method: 'Runtime.callFunctionOn', value: { result: { value: { x: 10, y: 10, w: 5, h: 5, tag: 'button', label: 'ok' } } } },
        // the probe callFunctionOn
        { method: 'Runtime.callFunctionOn', value: { result: { value: { found: true, visible: true } } } },
      ],
      { elementResolvers: new Map([['t1', resolver]]) },
    );
    const r = await handleVerify(ctx, { tabId: 't1', check: 'visible', uid: 5 });
    expect(textOf(r)).toMatch(/^PASS — visible: visible/);
  });

  it('polls until pass when timeout is set', async () => {
    // First probe: fail. Second probe: pass.
    const ctx = makeCtx([
      { method: 'Runtime.evaluate', value: { found: true, visible: false } },
      { method: 'Runtime.evaluate', value: { found: true, visible: true } },
    ]);
    const r = await handleVerify(ctx, { tabId: 't1', check: 'visible', selector: '#x', timeout: 2000 });
    const text = textOf(r);
    expect(text).toMatch(/^PASS/);
    expect(text).toContain('2 attempts');
  });
});
