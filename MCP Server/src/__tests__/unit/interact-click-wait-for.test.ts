/**
 * Parity with Playwright MCP browser_click — single-call equivalent of
 * `browser_click` followed by `browser_wait_for { text | textGone | time }`.
 *
 * These tests cover the schema surface and dispatch wiring for the new
 * `waitFor` parameter on interact.click. They do not exercise CDP I/O.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../tools/registry.js';
import { registerInteractTools } from '../../tools/interact.js';
import type { ServerContext } from '../../types.js';

function mockCtx(): ServerContext {
  return {} as ServerContext;
}

describe('interact.click — waitFor parameter (Playwright parity)', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerInteractTools(registry, mockCtx());
  });

  it('exposes waitFor in the interact tool inputSchema', () => {
    const tool = registry.list().find(t => t.name === 'interact');
    expect(tool).toBeDefined();
    const props = (tool!.inputSchema.properties ?? {}) as Record<string, unknown>;
    expect(props.waitFor).toBeDefined();
    const waitFor = props.waitFor as { type: string; properties: Record<string, unknown> };
    expect(waitFor.type).toBe('object');
    expect(waitFor.properties.selector).toBeDefined();
    expect(waitFor.properties.text).toBeDefined();
    expect(waitFor.properties.textGone).toBeDefined();
    expect(waitFor.properties.state).toBeDefined();
    expect(waitFor.properties.timeout).toBeDefined();
  });

  it('declares the four canonical selector states on waitFor.state', () => {
    const tool = registry.list().find(t => t.name === 'interact')!;
    const props = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
    const waitFor = props.waitFor as { properties: Record<string, { enum?: string[] }> };
    expect(waitFor.properties.state.enum).toEqual(['visible', 'hidden', 'attached', 'detached']);
  });

  it('mentions waitFor in the tool description so agents can discover it', () => {
    const tool = registry.list().find(t => t.name === 'interact')!;
    expect(tool.description).toContain('waitFor');
  });

  it('does not require waitFor (still optional for click)', () => {
    const tool = registry.list().find(t => t.name === 'interact')!;
    const required = (tool.inputSchema.required ?? []) as string[];
    expect(required).not.toContain('waitFor');
  });
});
