/**
 * tools/list shaping (5.3 WS1 O1).
 *
 * Extracted from index.ts so the WIRE format (annotations passthrough +
 * slim-mode filtering) is unit-testable: a mocked ListToolsRequest against
 * this function IS the wire contract.
 */

import type { ToolRegistry } from './registry.js';

/** Build the tools/list response payload. */
export function listTools(
  registry: ToolRegistry,
  slimMode: boolean,
): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}> {
  const all = registry.list();
  if (!slimMode) return all;
  return all.filter(
    (t) => t.name.startsWith('browser_') || t.name === 'ping' || t.name === 'status',
  );
}
