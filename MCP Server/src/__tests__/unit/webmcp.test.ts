/**
 * 5.3 WS3 — WebMCP passthrough: event-driven registry, invoke round-trip,
 * cancel, gating (flag-naming error), untrusted-output labeling.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  applyWebMcpEvent,
  clearWebMcpState,
  handleWebMcpList,
  handleWebMcpCall,
  handleWebMcpCancel,
} from '../../tools/webmcp.js';
import type { ServerContext, WebMcpInvocation, WebMcpToolInfo } from '../../types.js';

interface SendRecord { method: string; params: Record<string, unknown> }

function makeCtx(opts: { hasWebMcp?: boolean; replayTools?: WebMcpToolInfo[] } = {}) {
  const sends: SendRecord[] = [];
  const webmcpTools = new Map<string, Map<string, WebMcpToolInfo>>();
  const webmcpInvocations = new Map<string, WebMcpInvocation>();
  const ctx = {
    tabSessions: { getSession: async () => 'sess-w' },
    cdpClient: {},
    capabilities: {
      require: async () => {
        if (opts.hasWebMcp === false) {
          throw new Error('This browser does not support the CDP "WebMCP" feature.');
        }
      },
    },
    sendCommand: async (method: string, params: Record<string, unknown> = {}) => {
      sends.push({ method, params });
      if (method === 'WebMCP.invokeTool') return { invocationId: 'inv-1' };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-main' } } };
      if (method === 'WebMCP.enable') {
        // Simulate the protocol: the enable response is followed by the
        // toolsAdded replay in the same flush.
        if (opts.replayTools?.length) {
          applyWebMcpEvent(ctx as ServerContext, 'WebMCP.toolsAdded', 'sess-w', { tools: opts.replayTools });
        }
        return {};
      }
      return {};
    },
    webmcpTools,
    webmcpInvocations,
  } as unknown as ServerContext & { webmcpTools: Map<string, Map<string, WebMcpToolInfo>>; webmcpInvocations: Map<string, WebMcpInvocation> };
  return { ctx: ctx as ServerContext, sends, webmcpTools, webmcpInvocations };
}

function textOf(r: { content?: Array<{ text?: string }> }): string {
  return (r.content ?? []).map((c) => c.text ?? '').join('\n');
}

const TOOL: WebMcpToolInfo = {
  name: 'page_echo',
  description: 'echoes input',
  inputSchema: { type: 'object' },
  frameId: 'frame-abcdef1234567890',
};

afterEach(() => { vi.useRealTimers(); });

describe('applyWebMcpEvent', () => {
  it('toolsAdded populates the per-session registry', () => {
    const { ctx, webmcpTools } = makeCtx();
    applyWebMcpEvent(ctx, 'WebMCP.toolsAdded', 'sess-w', { tools: [TOOL] });
    expect(webmcpTools.get('sess-w')?.get('page_echo')).toEqual(TOOL);
  });

  it('toolsRemoved deletes entries', () => {
    const { ctx, webmcpTools } = makeCtx();
    applyWebMcpEvent(ctx, 'WebMCP.toolsAdded', 'sess-w', { tools: [TOOL] });
    applyWebMcpEvent(ctx, 'WebMCP.toolsRemoved', 'sess-w', { tools: [{ name: 'page_echo' }] });
    expect(webmcpTools.get('sess-w')?.size ?? 0).toBe(0);
  });

  it('toolResponded resolves the pending invocation and clears state', () => {
    const { ctx, webmcpInvocations } = makeCtx();
    const resolve = vi.fn();
    const timer = setTimeout(() => {}, 10_000);
    webmcpInvocations.set('inv-9', { resolve, timer });
    const handled = applyWebMcpEvent(ctx, 'WebMCP.toolResponded', 'sess-w', {
      invocationId: 'inv-9', status: 'Completed', output: { echo: 1 },
    });
    expect(handled).toBe(true);
    expect(webmcpInvocations.has('inv-9')).toBe(false);
    expect(resolve).toHaveBeenCalledWith({ status: 'Completed', output: { echo: 1 }, errorText: undefined, exceptionDescription: undefined });
    clearTimeout(timer);
  });
});

describe('handleWebMcpList', () => {
  it('requires tabId flow through getTabSession (mocked) and gates absent domains with flag names', async () => {
    const { ctx } = makeCtx({ hasWebMcp: false });
    await expect(handleWebMcpList(ctx, { tabId: 't1' })).rejects.toThrow(/#enable-webmcp-testing/);
  });

  it('enables and dumps the replayed registry with annotations', async () => {
    const { ctx, sends } = makeCtx({
      replayTools: [{ ...TOOL, annotations: { readOnly: true } }],
    });
    const r = await handleWebMcpList(ctx, { tabId: 't1' });
    const text = textOf(r);
    expect(text).toContain('page_echo');
    expect(text).toContain('frame-abcdef'.slice(0, 8));
    expect(text).toContain('[annotations: {"readOnly":true}]');
    expect(sends.some((s) => s.method === 'WebMCP.enable')).toBe(true);
  });

  it('empty registry → helpful message naming the flags', async () => {
    const { ctx } = makeCtx();
    const text = textOf(await handleWebMcpList(ctx, { tabId: 't1' }));
    expect(text).toContain('No WebMCP tools');
    expect(text).toContain('#enable-webmcp-testing');
  });
});

describe('handleWebMcpCall', () => {
  it('requires name', async () => {
    const { ctx } = makeCtx();
    expect(textOf(await handleWebMcpCall(ctx, { tabId: 't1' }))).toContain("Provide 'name'");
  });

  it('invokes with the registry frameId and resolves Completed output (untrusted-labeled)', async () => {
    const { ctx, sends } = makeCtx({ replayTools: [TOOL] });
    // Pre-populate registry as if webmcp_list ran earlier
    applyWebMcpEvent(ctx, 'WebMCP.toolsAdded', 'sess-w', { tools: [TOOL] });
    const promise = handleWebMcpCall(ctx, { tabId: 't1', name: 'page_echo', input: { hi: 1 } });
    // Resolve the round-trip from the event side (async — let the invoke land first)
    await new Promise((r) => setTimeout(r, 10));
    applyWebMcpEvent(ctx, 'WebMCP.toolResponded', 'sess-w', { invocationId: 'inv-1', status: 'Completed', output: { echo: 'hi' } });
    const r = await promise;
    const text = textOf(r);
    expect(sends.find((s) => s.method === 'WebMCP.invokeTool')?.params).toEqual({
      frameId: 'frame-abcdef1234567890', toolName: 'page_echo', input: { hi: 1 },
    });
    expect(text).toContain('UNTRUSTED page-controlled output');
    expect(text).toContain('"echo": "hi"');
  });

  it('falls back to the main frame when the tool is not in the registry', async () => {
    const { ctx, sends } = makeCtx();
    const promise = handleWebMcpCall(ctx, { tabId: 't1', name: 'unknown_tool', input: {} });
    await new Promise((r) => setTimeout(r, 10));
    applyWebMcpEvent(ctx, 'WebMCP.toolResponded', 'sess-w', { invocationId: 'inv-1', status: 'Completed', output: null });
    await promise;
    const invoke = sends.find((s) => s.method === 'WebMCP.invokeTool');
    expect(invoke?.params.frameId).toBe('frame-main');
  });

  it('Error status surfaces the page-side error text', async () => {
    const { ctx } = makeCtx();
    const promise = handleWebMcpCall(ctx, { tabId: 't1', name: 'broken_tool' });
    await new Promise((r) => setTimeout(r, 10));
    applyWebMcpEvent(ctx, 'WebMCP.toolResponded', 'sess-w', { invocationId: 'inv-1', status: 'Error', errorText: 'boom inside page' });
    expect(textOf(await promise)).toContain('boom inside page');
  });

  it('times out (pending cleaned up)', async () => {
    const { ctx, webmcpInvocations } = makeCtx();
    const r = await handleWebMcpCall(ctx, { tabId: 't1', name: 'slow_tool', timeout: 20 });
    expect(textOf(r)).toContain('Timed out (20ms)');
    expect(webmcpInvocations.size).toBe(0);
  });
});

describe('handleWebMcpCancel', () => {
  it('requires invocationId', async () => {
    const { ctx } = makeCtx();
    expect(textOf(await handleWebMcpCancel(ctx, { tabId: 't1' }))).toContain("Provide 'invocationId'");
  });

  it('clears the pending resolver and sends cancelInvocation', async () => {
    const { ctx, webmcpInvocations, sends } = makeCtx();
    const resolve = vi.fn();
    const timer = setTimeout(() => {}, 10_000);
    webmcpInvocations.set('inv-2', { resolve, timer });
    const r = await handleWebMcpCancel(ctx, { tabId: 't1', invocationId: 'inv-2' });
    expect(textOf(r)).toContain('Cancellation requested');
    expect(webmcpInvocations.has('inv-2')).toBe(false);
    expect(sends.some((s) => s.method === 'WebMCP.cancelInvocation')).toBe(true);
    clearTimeout(timer);
  });
});

describe('clearWebMcpState (disconnect cleanup)', () => {
  it('resolves pendings as Disconnected and clears everything', () => {
    const { ctx, webmcpTools, webmcpInvocations } = makeCtx();
    applyWebMcpEvent(ctx, 'WebMCP.toolsAdded', 'sess-w', { tools: [TOOL] });
    const resolve = vi.fn();
    const timer = setTimeout(() => {}, 10_000);
    webmcpInvocations.set('inv-3', { resolve, timer });
    clearWebMcpState(ctx);
    expect(webmcpTools.size).toBe(0);
    expect(webmcpInvocations.size).toBe(0);
    expect(resolve).toHaveBeenCalledWith({ status: 'Disconnected' });
    clearTimeout(timer);
  });
});
