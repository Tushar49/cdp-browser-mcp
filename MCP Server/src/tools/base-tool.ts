/**
 * Helpers for defining tools with less boilerplate.
 *
 * - defineTool()      — typed factory that produces a ToolDefinition
 * - COMMON_PARAMS     — reusable JSON-Schema fragments (tabId, sessionId, …)
 * - withCommonParams  — merges COMMON_PARAMS into an inputSchema
 * - success / imageResult — quick ToolResult builders
 */

import type { ToolDefinition, ToolHandler, ToolResult } from '../types.js';

// ─── Tool Factory ───────────────────────────────────────────────────

/** Create a ToolDefinition with inferred types. */
export function defineTool(opts: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
  annotations?: ToolDefinition['annotations'];
}): ToolDefinition {
  return {
    name: opts.name,
    description: opts.description,
    inputSchema: opts.inputSchema,
    handler: opts.handler,
    ...(opts.annotations ? { annotations: opts.annotations } : {}),
  };
}

// ─── Common Input-Schema Properties ─────────────────────────────────

/** Standard JSON-Schema fragments reused across many tools (mirrors server.js patterns). */
export const COMMON_PARAMS = {
  tabId: {
    type: 'string' as const,
    description: 'Tab ID from tabs.list or tabs.new.',
  },
  sessionId: {
    type: 'string' as const,
    description: 'Agent session ID for tab ownership. Default: auto-generated per process.',
  },
  cleanupStrategy: {
    type: 'string' as const,
    enum: ['close', 'detach', 'none'] as const,
    description:
      "Tab cleanup on session expiry. 'detach' (default) keeps tabs open, 'close' removes them, 'none' skips cleanup.",
  },
  exclusive: {
    type: 'boolean' as const,
    description: 'Lock tab to this session (default: true). Set false for shared access.',
  },
  timeout: {
    type: 'number' as const,
    description: 'Timeout in milliseconds. Overrides default for this call.',
  },
} as const;

/**
 * Merge selected COMMON_PARAMS into an input schema's properties.
 *
 * @example
 * withCommonParams(
 *   { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
 *   'tabId', 'sessionId',
 * )
 */
export function withCommonParams(
  schema: Record<string, unknown>,
  ...params: (keyof typeof COMMON_PARAMS)[]
): Record<string, unknown> {
  const existing = (schema.properties ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...existing };
  for (const p of params) {
    merged[p] = COMMON_PARAMS[p];
  }
  return { ...schema, properties: merged };
}

// ─── Result Builders ────────────────────────────────────────────────

/** Build a text-only success ToolResult. */
export function success(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** Build an image ToolResult (e.g. screenshots). */
export function imageResult(
  base64: string,
  mimeType: string = 'image/png',
): ToolResult {
  return { content: [{ type: 'image', data: base64, mimeType }] };
}
