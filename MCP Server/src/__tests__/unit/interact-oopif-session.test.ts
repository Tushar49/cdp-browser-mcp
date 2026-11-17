/**
 * 5.5.1 — interact type/fill/select session routing for iframe (OOPIF) elements.
 *
 * Regression pins for the bug where `handleType` resolved + focused an element
 * in its own (child) CDP session but dispatched keys / instant-filled against
 * the top-level page session. Assertions classify calls by their function
 * body and check session/objectId COHERENCE — never raw call counts (the
 * geometry + focus calls already exist and would mask a broken fill).
 *
 * No CDP I/O: `sendCommand` is a recording mock.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../tools/registry.js';
import { registerInteractTools } from '../../tools/interact.js';
import type { ServerContext } from '../../types.js';

interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface MockOptions {
  /** When false, no uid routes to a child session (all same-page). */
  oopif?: boolean;
}

function makeCtx(opts: MockOptions = {}) {
  const calls: RecordedCall[] = [];
  const backendFor = (uid: number): number | undefined =>
    uid === 42 ? 501 : uid === 43 ? 502 : undefined;
  const objectFor = (backendNodeId: unknown): string =>
    backendNodeId === 502 ? 'obj-2' : 'obj-1';

  const sendCommand = async (
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> => {
    calls.push({ method, params, sessionId });
    switch (method) {
      case 'DOM.resolveNode':
        return { object: { objectId: objectFor(params.backendNodeId) } };
      case 'DOM.describeNode':
        return { node: { backendNodeId: 777 } };
      case 'Runtime.getProperties':
        return {
          result: [{ name: '0', value: { objectId: 'obj-sel', description: 'input' } }],
        };
      case 'Runtime.evaluate': {
        const expr = String(params.expression ?? '');
        // Select custom-dropdown follow-up vs. the locator match expression
        // (both legitimately contain querySelectorAll).
        if (expr.includes('Option not found in custom dropdown')) {
          return { result: { value: { selected: 'x', value: 'x' } } };
        }
        return { result: { objectId: 'arr-1' } };
      }
      case 'Runtime.callFunctionOn': {
        const fn = String(params.functionDeclaration ?? '');
        if (fn.includes('getBoundingClientRect')) {
          return {
            result: { value: { x: 50, y: 10, w: 100, h: 20, tag: 'input', label: 'field' } },
          };
        }
        if (fn.includes('customDropdown')) {
          return { result: { value: { customDropdown: true } } };
        }
        return { result: { value: { ok: true } } };
      }
      default:
        return {};
    }
  };

  const ctx = {
    sendCommand,
    cdpClient: {},
    config: { autoWait: false, actionTimeout: 500 },
    tabSessions: {
      getSession: async () => 'page-sess',
      getRefSession: (_sess: string, uid: number) =>
        uid === 42 && opts.oopif !== false ? 'child-sess' : undefined,
    },
    elementResolvers: new Map([
      [
        'tab-1',
        {
          resolve: (uid: number) => backendFor(uid),
        },
      ],
    ]),
  } as unknown as ServerContext;

  return { ctx, calls };
}

const fnText = (c: RecordedCall): string => String(c.params.functionDeclaration ?? '');
const isFill = (c: RecordedCall): boolean =>
  c.method === 'Runtime.callFunctionOn'
  && fnText(c).includes('dispatchEvent')
  && !fnText(c).includes('.focus()')
  && !fnText(c).includes('getBoundingClientRect');
const isFocus = (c: RecordedCall): boolean =>
  c.method === 'Runtime.callFunctionOn' && fnText(c).includes('.focus()');
const activeElementEvaluates = (calls: RecordedCall[]): RecordedCall[] =>
  calls.filter(
    (c) => c.method === 'Runtime.evaluate'
      && String(c.params.expression ?? '').includes('document.activeElement'),
  );

function textOf(res: { content?: Array<{ text?: string }> }): string {
  return res.content?.[0]?.text ?? '';
}

describe('5.5.1 interact — iframe/OOPIF session routing', () => {
  let registry: ToolRegistry;
  beforeEach(() => {
    registry = new ToolRegistry();
    registerInteractTools(registry, {} as ServerContext);
  });

  function typeArgs(over: Record<string, unknown> = {}) {
    return { action: 'type', tabId: 'tab-1', uid: 42, text: 'hi', ...over };
  }

  it('instant fill is object-scoped on the child session (clear:false)', async () => {
    const { ctx, calls } = makeCtx();
    const res = await registry.dispatch('interact', typeArgs({ clear: false }), ctx);
    expect(textOf(res)).toContain('Typed');

    const fills = calls.filter(isFill);
    expect(fills).toHaveLength(1);
    expect(fills[0].sessionId).toBe('child-sess');
    expect(fills[0].params.objectId).toBe('obj-1');
    const fillArgs = fills[0].params.arguments as Array<{ value: string }>;
    expect(fillArgs[0].value).toBe('hi');

    expect(activeElementEvaluates(calls)).toHaveLength(0);
    expect(calls.some((c) => c.method === 'Input.dispatchKeyEvent')).toBe(false);
  });

  it('default clear keeps the clear in the focus call, then fills on the child session', async () => {
    const { ctx, calls } = makeCtx();
    await registry.dispatch('interact', typeArgs(), ctx);

    const focus = calls.filter(isFocus);
    expect(focus).toHaveLength(1);
    expect(focus[0].sessionId).toBe('child-sess');
    expect(fnText(focus[0])).toContain("nativeSetter.call(this, '')");

    const fills = calls.filter(isFill);
    expect(fills).toHaveLength(1);
    expect(fills[0].sessionId).toBe('child-sess');
    expect(fills[0].params.objectId).toBe('obj-1');
    expect(activeElementEvaluates(calls)).toHaveLength(0);
  });

  it('fixed-delay key dispatch follows the focused element session', async () => {
    const { ctx, calls } = makeCtx();
    await registry.dispatch('interact', typeArgs({ text: 'ab', delay: 1 }), ctx);

    const focus = calls.find(isFocus);
    expect(focus?.sessionId).toBe('child-sess');
    const keys = calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
    expect(keys.length).toBeGreaterThanOrEqual(4); // 2 chars × down/up
    expect(keys.every((k) => k.sessionId === focus?.sessionId)).toBe(true);
    expect(activeElementEvaluates(calls)).toHaveLength(0);
  });

  it('submit Enter is dispatched on the focused element session', async () => {
    const { ctx, calls } = makeCtx();
    await registry.dispatch('interact', typeArgs({ text: 'a', submit: true }), ctx);

    const keys = calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
    // Instant fill emits no char key events; submit adds Enter down/up.
    const enterKeys = keys.filter((k) => k.params.key === 'Enter');
    expect(enterKeys).toHaveLength(2); // down + up
    expect(enterKeys.every((k) => k.sessionId === 'child-sess')).toBe(true);
    expect(keys.every((k) => k.sessionId === 'child-sess')).toBe(true);
  });

  it('humanized typing (charDelay/wordDelay/typoRate) stays on the child session', async () => {
    const { ctx, calls } = makeCtx();
    await registry.dispatch(
      'interact',
      typeArgs({ text: 'ab', charDelay: 1, wordDelay: 1, typoRate: 1 }),
      ctx,
    );
    const keys = calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.sessionId === 'child-sess')).toBe(true);
  });

  it('no-OOPIF elements never get a hardcoded child session', async () => {
    const { ctx, calls } = makeCtx({ oopif: false });
    await registry.dispatch('interact', typeArgs({ delay: 1 }), ctx);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.sessionId === 'page-sess')).toBe(true);
  });

  it('selector path stays on the page session and is object-scoped', async () => {
    const { ctx, calls } = makeCtx();
    const res = await registry.dispatch(
      'interact',
      { action: 'type', tabId: 'tab-1', selector: 'input', text: 'hi' },
      ctx,
    );
    expect(textOf(res)).toContain('Typed');

    const fills = calls.filter(isFill);
    expect(fills).toHaveLength(1);
    expect(fills[0].sessionId).toBe('page-sess');
    expect(fills[0].params.objectId).toBe('obj-sel');
    expect(activeElementEvaluates(calls)).toHaveLength(0);
  });

  it('fill routes each field to its own session (guards the already-correct path)', async () => {
    const { ctx, calls } = makeCtx();
    await registry.dispatch(
      'interact',
      {
        action: 'fill',
        tabId: 'tab-1',
        fields: [
          { uid: 42, value: 'child-value' },
          { uid: 43, value: 'page-value' },
        ],
      },
      ctx,
    );

    const fills = calls.filter((c) => c.method === 'Runtime.callFunctionOn' && fnText(c).includes('dispatchEvent'));
    const childFill = fills.find((c) => c.params.objectId === 'obj-1');
    const pageFill = fills.find((c) => c.params.objectId === 'obj-2');
    expect(childFill?.sessionId).toBe('child-sess');
    expect(pageFill?.sessionId).toBe('page-sess');
  });

  it('select custom-dropdown probe and follow-up both use the element session', async () => {
    const { ctx, calls } = makeCtx();
    await registry.dispatch(
      'interact',
      { action: 'select', tabId: 'tab-1', uid: 42, value: 'x' },
      ctx,
    );

    const probe = calls.find(
      (c) => c.method === 'Runtime.callFunctionOn' && fnText(c).includes('customDropdown'),
    );
    expect(probe?.sessionId).toBe('child-sess');

    const followUp = calls.find(
      (c) => c.method === 'Runtime.evaluate'
        && String(c.params.expression ?? '').includes('querySelectorAll'),
    );
    expect(followUp?.sessionId).toBe('child-sess');
  });
});
