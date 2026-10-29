/**
 * Tool registration and dispatch system for the CDP Browser MCP Server.
 *
 * Mirrors the pattern from server.js (TOOLS array + handleTool dispatcher)
 * but replaces the imperative approach with a typed registry that tools
 * self-register into at startup.
 */

import type { ToolDefinition, ToolResult, ServerContext } from '../types.js';

export class ToolRegistry {  private tools = new Map<string, ToolDefinition>();

  /** Register a tool definition. Throws if a duplicate name is registered. */
  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, tool);
  }

  /** List all registered tools in MCP ListTools response format. */
  list(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: ToolDefinition['annotations'];
  }> {
    return Array.from(this.tools.values()).map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
    }));
  }

  /**
   * Dispatch a tool call by name.
   *
   * Matches the server.js handleTool() pattern:
   *   1. Look up the handler by name
   *   2. Run it with the shared ServerContext
   *   3. Catch errors and wrap them via wrapError → ActionableError.toToolResult()
   */
  async dispatch(
    name: string,
    args: Record<string, unknown>,
    ctx: ServerContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      const { scrubToolResult } = await import('../utils/scrub.js');
      return scrubToolResult({
        content: [
          {
            type: 'text',
            text: `Unknown tool: "${name}". Available: ${Array.from(this.tools.keys()).join(', ')}`,
          },
        ],
        isError: true,
      });
    }

    try {
      const result = await tool.handler(ctx, args);
      // 5.3 WS1 O2: the ONE universal scrub choke point — every result path
      // (ok()/fail()/success()/raw literals) returns through here.
      const { scrubToolResult } = await import('../utils/scrub.js');
      return scrubToolResult(result);
    } catch (error: unknown) {
      const { wrapError } = await import('../utils/error-handler.js');
      const wrapped = wrapError(error).toToolResult();
      const { scrubToolResult } = await import('../utils/scrub.js');
      return scrubToolResult(wrapped);
    }
  }

  /** Check whether a tool is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size;
  }
}
