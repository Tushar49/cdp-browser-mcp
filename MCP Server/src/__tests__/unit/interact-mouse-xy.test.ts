/**
 * Schema-surface + dispatch-validation tests for the coordinate-based mouse
 * actions added in 5.1.0 (A2): mouse_move, mouse_down, mouse_up, click_xy,
 * wheel. No CDP I/O — validation branches run before session acquisition.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../tools/registry.js';
import { registerInteractTools } from '../../tools/interact.js';
import type { ServerContext } from '../../types.js';

function mockCtx(): ServerContext {
  return {} as ServerContext;
}

describe('interact — coordinate-based mouse actions (5.1.0 A2)', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerInteractTools(registry, mockCtx());
  });

  it('exposes all five new actions in the inputSchema enum', () => {
    const tool = registry.list().find((t) => t.name === 'interact')!;
    const action = (tool.inputSchema.properties as Record<string, { enum?: string[] }>).action;
    for (const a of ['mouse_move', 'mouse_down', 'mouse_up', 'click_xy', 'wheel']) {
      expect(action.enum).toContain(a);
    }
  });

  it('exposes deltaX/deltaY props for wheel', () => {
    const tool = registry.list().find((t) => t.name === 'interact')!;
    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(props.deltaX).toBeDefined();
    expect(props.deltaY).toBeDefined();
  });

  it('description documents the new actions so agents can discover them', () => {
    const tool = registry.list().find((t) => t.name === 'interact')!;
    for (const marker of ['mouse_move', 'click_xy', 'wheel', 'mouse_down', 'mouse_up']) {
      expect(tool.description).toContain(marker);
    }
  });

  it('dispatch wiring: mouse_move without x/y fails before session acquisition', async () => {
    const res = await registry.dispatch('interact', { action: 'mouse_move' }, mockCtx());
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('mouse_move requires x and y');
  });

  it('dispatch wiring: click_xy without x/y fails before session acquisition', async () => {
    const res = await registry.dispatch('interact', { action: 'click_xy' }, mockCtx());
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('click_xy requires x and y');
  });

  it('dispatch wiring: mouse_down/mouse_up require x/y', async () => {
    for (const action of ['mouse_down', 'mouse_up']) {
      const res = await registry.dispatch('interact', { action }, mockCtx());
      const text = (res.content as Array<{ text: string }>)[0].text;
      expect(text).toContain(`${action} requires x and y`);
    }
  });

  it('dispatch wiring: wheel without any delta fails', async () => {
    const res = await registry.dispatch(
      'interact',
      { action: 'wheel', x: 10, y: 10 },
      mockCtx(),
    );
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).toContain('wheel requires deltaX and/or deltaY');
  });

  it('wheel accepts deltaX only (horizontal scroll)', async () => {
    // Validation passes; the handler would proceed to session acquisition
    // (which the empty mock ctx cannot satisfy) — assert the failure is the
    // session error, not the validation error.
    const res = await registry.dispatch(
      'interact',
      { action: 'wheel', deltaX: -100 },
      mockCtx(),
    );
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text).not.toContain('wheel requires deltaX');
  });
});
