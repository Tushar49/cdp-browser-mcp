/**
 * 5.3 WS1 O1 — tools/list WIRE contract (extracted from index.ts).
 * A mocked ListToolsRequest against listTools() IS the wire: annotations
 * must be present on read-only tools, absent on others, and must survive
 * the slim-mode filter path.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../tools/registry.js';
import { listTools } from '../../tools/list-tools.js';
import type { ToolDefinition } from '../../types.js';

function makeTool(name: string, annotations?: ToolDefinition['annotations']): ToolDefinition {
  return {
    name,
    description: `test: ${name}`,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ content: [{ type: 'text', text: name }] }),
    ...(annotations ? { annotations } : {}),
  };
}

describe('listTools (wire contract)', () => {
  it('passes annotations through in full mode', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('ping', { readOnlyHint: true }));
    registry.register(makeTool('page'));
    registry.register(makeTool('observe'));

    const listed = listTools(registry, false);
    expect(listed).toHaveLength(3);
    const ping = listed.find((t) => t.name === 'ping');
    expect(ping?.annotations).toEqual({ readOnlyHint: true });
    // mixed-action tools stay hint-less
    expect(listed.find((t) => t.name === 'page')?.annotations).toBeUndefined();
    expect(listed.find((t) => t.name === 'observe')?.annotations).toBeUndefined();
  });

  it('preserves annotations through the slim-mode filter path', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('ping', { readOnlyHint: true }));
    registry.register(makeTool('status', { readOnlyHint: true }));
    registry.register(makeTool('browser_test_helper'));
    registry.register(makeTool('page', { readOnlyHint: false }));

    const listed = listTools(registry, true);
    const names = listed.map((t) => t.name);
    expect(names).toContain('ping');
    expect(names).toContain('status');
    expect(names).toContain('browser_test_helper');
    expect(names).not.toContain('page');
    expect(listed.find((t) => t.name === 'ping')?.annotations).toEqual({ readOnlyHint: true });
  });

  it('never leaks the handler into the wire payload', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('ping', { readOnlyHint: true }));
    for (const t of listTools(registry, false)) {
      expect(t).not.toHaveProperty('handler');
    }
  });
});
