/**
 * Slim mode reduces the tool surface for small-context models.
 * Instead of 15 tools with 90+ actions, expose 6 essential tools
 * with simplified schemas.
 *
 * Enable via: CDP_SLIM_MODE=true or { mode: "slim" } in config
 *
 * The 6 slim tools use Playwright-compatible naming so agents that
 * already know Playwright MCP can use them without learning new APIs.
 */

export interface SlimToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Returns the 6 essential tools with minimal schemas.
 *
 * v5.0.0-alpha.4: descriptions tightened to one-liners and per-property
 * descriptions stripped where the property name is self-documenting. Total
 * `ListTools` JSON dropped from ~2.2 KB → ~1.2 KB.
 */
export function getSlimTools(): SlimToolDef[] {
  return [
    {
      name: 'browser_navigate',
      description: 'Navigate to URL.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          tabId: { type: 'string' },
        },
        required: ['url'],
      },
    },
    {
      name: 'browser_snapshot',
      description: 'Page snapshot with element refs.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string' },
          maxLength: { type: 'number' },
          interactive: { type: 'boolean' },
          search: { type: 'string' },
        },
      },
    },
    {
      name: 'browser_click',
      description: 'Click element by ref.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'number' },
          tabId: { type: 'string' },
        },
        required: ['ref'],
      },
    },
    {
      name: 'browser_type',
      description: 'Type text into ref or focused element.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'number' },
          text: { type: 'string' },
          tabId: { type: 'string' },
          submit: { type: 'boolean' },
        },
        required: ['text'],
      },
    },
    {
      name: 'browser_fill_form',
      description: 'Fill multiple fields by ref. Handles text, dropdowns, checkboxes.',
      inputSchema: {
        type: 'object',
        properties: {
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ref: { type: 'number' },
                value: { type: 'string' },
              },
              required: ['ref', 'value'],
            },
          },
          tabId: { type: 'string' },
        },
        required: ['fields'],
      },
    },
    {
      name: 'browser_tabs',
      description: 'List, open or close tabs.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'new', 'close'] },
          url: { type: 'string' },
          tabId: { type: 'string' },
        },
      },
    },
  ];
}

// ─── Slim-mode helpers (v5.0.0-alpha.4) ─────────────────────────────

/**
 * Returns true when the server is running with `CDP_SLIM_MODE=true`.
 *
 * Read from the environment on every call rather than cached so tests can
 * toggle it without re-importing the module. The flag is intentionally
 * kept env-driven (matching `loadConfig()`) so handlers in `page.ts` and
 * `interact.ts` do not need to thread the full `ServerConfig` through.
 */
export function isSlimMode(): boolean {
  return process.env.CDP_SLIM_MODE === 'true';
}

/**
 * Pick a string based on slim mode.
 *
 * @example
 *   ok(slimify('Clicked <div> "Submit" at (320, 482)', 'Clicked'));
 */
export function slimify(verbose: string, slim: string): string {
  return isSlimMode() ? slim : verbose;
}

/** Default `page.snapshot` `maxLength` cap when caller does not specify one. */
export const SLIM_DEFAULT_SNAPSHOT_MAX_LENGTH = 4000;
export const FULL_DEFAULT_SNAPSHOT_MAX_LENGTH = 20_000;

/** Resolve the effective default snapshot cap based on the current mode. */
export function defaultSnapshotMaxLength(): number {
  return isSlimMode()
    ? SLIM_DEFAULT_SNAPSHOT_MAX_LENGTH
    : FULL_DEFAULT_SNAPSHOT_MAX_LENGTH;
}

/**
 * Maps slim tool calls to full tool calls.
 *
 * This allows slim tools to reuse the existing handler infrastructure
 * without duplicating any logic.
 */
export function mapSlimToFull(
  slimName: string,
  args: Record<string, unknown>,
): { tool: string; args: Record<string, unknown> } {
  switch (slimName) {
    case 'browser_navigate':
      return {
        tool: 'page',
        args: { action: 'goto', url: args.url, tabId: args.tabId },
      };
    case 'browser_snapshot':
      return {
        tool: 'page',
        args: {
          action: 'snapshot',
          tabId: args.tabId,
          maxLength: args.maxLength,
          interactive: args.interactive,
          search: args.search,
        },
      };
    case 'browser_click':
      return {
        tool: 'interact',
        args: { action: 'click', uid: args.ref, tabId: args.tabId },
      };
    case 'browser_type':
      return {
        tool: 'interact',
        args: {
          action: 'type',
          uid: args.ref,
          text: args.text,
          tabId: args.tabId,
          submit: args.submit,
        },
      };
    case 'browser_fill_form':
      return {
        tool: 'form',
        args: {
          action: 'fill',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bridging slim→full field shape
          fields: (args.fields as any[])?.map(f => ({ uid: f.ref, value: f.value })),
          tabId: args.tabId,
        },
      };
    case 'browser_tabs': {
      if (args.action === 'new')
        return { tool: 'tabs', args: { action: 'new', url: args.url } };
      if (args.action === 'close')
        return { tool: 'tabs', args: { action: 'close', tabId: args.tabId } };
      return { tool: 'tabs', args: { action: 'list', showAll: true } };
    }
    default:
      return { tool: slimName, args };
  }
}
