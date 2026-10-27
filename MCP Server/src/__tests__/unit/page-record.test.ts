/**
 * B6 spikes: page.record_start / record_stop (Page.startScreenRecording →
 * IO.StreamHandle → IO.read drain → temp file) and content format
 * 'annotated' (Page.getAnnotatedPageContent binary-proto dump).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Buffer } from 'buffer';
import { ToolRegistry } from '../../tools/registry.js';
import { registerPageTools } from '../../tools/page.js';
import { handleRecordStart, handleRecordStop } from '../../tools/page.js';
import type { ServerContext, ToolResult } from '../../types.js';

interface MockCtx extends ServerContext {
  __calls: Array<{ method: string; params?: Record<string, unknown> }>;
  __throwOn: Set<string>;
  __recordStartMissing?: boolean;
}

let tempRoot: string | null = null;
const newTempRoot = (): string => {
  tempRoot = mkdtempSync(join(tmpdir(), 'cdp-b6-'));
  return tempRoot;
};

afterEach(() => {
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

function makeCtx(ioChunks: Array<{ data?: string; eof?: boolean }> = []): MockCtx {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const ctx = {
    __calls: calls,
    tabSessions: { getSession: async () => 'sess-1' },
    config: {} as ServerContext['config'],
    sendCommand: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'Page.startScreenRecording' && (ctx as unknown as { __recordStartMissing?: boolean }).__recordStartMissing) {
        throw new Error("'Page.startScreenRecording' wasn't found");
      }
      if (method === 'Page.stopScreenRecording') return { stream: 'h1' };
      if (method === 'IO.read') return ioChunks.shift() ?? { eof: true };
      if (method === 'Page.getAnnotatedPageContent') {
        return { content: Buffer.from('proto-junk-1234\nTitle: Example Domain\nmore-binary-07\n', 'utf8').toString('base64') };
      }
      return {};
    },
  } as unknown as MockCtx;
  (ctx as unknown as { config: unknown }).config = { tempDir: tempRoot ?? newTempRoot(), maxTempFiles: 20, maxTempAgeMs: 3600_000 };
  return ctx;
}

function textOf(r: ToolResult): string {
  const content = (r as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

describe('page.record_* (B6 S2, experimental)', () => {
  it('start sends startScreenRecording with defaults and reports state', async () => {
    const ctx = makeCtx();
    const r = await handleRecordStart(ctx, { tabId: 't1' });
    expect(textOf(r)).toContain('Screen recording started (audio: off');
    const start = ctx.__calls.find(c => c.method === 'Page.startScreenRecording');
    expect(start?.params).toMatchObject({ audio: false, frameRate: 25, maxWidth: 1920, maxHeight: 1080 });
  });

  it('start fails actionably when the method is missing', async () => {
    const ctx = makeCtx();
    (ctx as unknown as { __recordStartMissing?: boolean }).__recordStartMissing = true;
    const r = await handleRecordStart(ctx, { tabId: 't1' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('not supported on this browser');
  });

  it('stop drains the IO stream into a webm temp file', async () => {
    const ctx = makeCtx([
      { data: Buffer.from('chunk-one-').toString('base64'), eof: false },
      { data: Buffer.from('chunk-two').toString('base64'), eof: true },
    ]);
    const r = await handleRecordStop(ctx, { tabId: 't1' });
    expect(textOf(r)).toContain('Recording saved to:');
    expect(textOf(r)).toContain('.webm');
    // Both chunks concatenated in order
    const file = textOf(r).match(/Recording saved to: (.+\.webm)/)![1];
    expect(readFileSync(file, 'utf8')).toBe('chunk-one-chunk-two');
    expect(ctx.__calls.some(c => c.method === 'IO.close')).toBe(true);
  });

  it('stop without a recording stream fails actionably', async () => {
    const ctx = makeCtx();
    ctx.sendCommand = (async (method: string) => {
      ctx.__calls.push({ method });
      if (method === 'Page.stopScreenRecording') return {};
      return {};
    }) as MockCtx['sendCommand'];
    const r = await handleRecordStop(ctx, { tabId: 't1' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('was record_start called');
  });
});

describe("content format 'annotated' (B6 S1 spike)", () => {
  it('dumps size + extracted ASCII strings from the binary proto', async () => {
    const ctx = makeCtx();
    const reg = new ToolRegistry();
    registerPageTools(reg, ctx);
    const result = await reg.dispatch('page', { action: 'content', tabId: 't1', format: 'annotated', _sessionId: 'sess-1' }, ctx);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.spike).toBe(true);
    expect(parsed.contentBytes).toBe(53);
    expect(parsed.asciiStrings).toContain('Title: Example Domain');
    expect(parsed.asciiStringCount).toBeGreaterThan(0);
    const call = ctx.__calls.find(c => c.method === 'Page.getAnnotatedPageContent');
    expect(call?.params).toMatchObject({ includeActionableInformation: true });
  });

  it('fails actionably when getAnnotatedPageContent is missing', async () => {
    const ctx = makeCtx();
    ctx.sendCommand = (async (method: string) => {
      ctx.__calls.push({ method });
      if (method === 'Page.getAnnotatedPageContent') throw new Error("'Page.getAnnotatedPageContent' wasn't found");
      return {};
    }) as MockCtx['sendCommand'];
    const reg = new ToolRegistry();
    registerPageTools(reg, ctx);
    const result = await reg.dispatch('page', { action: 'content', tabId: 't1', format: 'annotated', _sessionId: 'sess-1' }, ctx);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not supported on this browser');
  });
});
