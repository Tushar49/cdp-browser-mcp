/**
 * Storage tool — cookie and browser storage management.
 *
 * Actions: get_cookies, set_cookie, delete_cookies, clear_cookies, clear_data, quota.
 * Delegates to CDP Network and Storage domains.
 */

import type { ToolRegistry } from './registry.js';
import type { ServerContext, ToolResult } from '../types.js';
import { defineTool } from './base-tool.js';
import { ok, fail } from '../utils/helpers.js';

// ─── Action handlers ────────────────────────────────────────────────

async function handleGetCookies(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  await ctx.sendCommand('Network.enable', {}, sess);

  const cdpParams: Record<string, unknown> = {};
  const urls = params.urls as string[] | undefined;
  if (urls?.length) cdpParams.urls = urls;

  const result = (await ctx.sendCommand('Network.getCookies', cdpParams, sess)) as Record<string, unknown>;
  const cookies = (result.cookies ?? []) as Array<Record<string, unknown>>;

  if (!cookies.length) return ok('No cookies found.');

  const lines = cookies.map(c => {
    const flags = [c.httpOnly && 'HttpOnly', c.secure && 'Secure', c.sameSite].filter(Boolean).join(', ');
    const exp = (c.expires as number) > 0 ? new Date((c.expires as number) * 1000).toISOString() : 'session';
    const val = c.value as string;
    return `${c.name}=${val.substring(0, 60)}${val.length > 60 ? '...' : ''}\n  Domain: ${c.domain} | Path: ${c.path} | Expires: ${exp} | ${flags}`;
  });
  return ok(`${cookies.length} cookie(s):\n\n${lines.join('\n\n')}`);
}

async function handleSetCookie(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  if (!params.name || params.value === undefined) return fail("Provide 'name' and 'value'.");
  const sess = params._sessionId as string;
  await ctx.sendCommand('Network.enable', {}, sess);

  const cookieParams: Record<string, unknown> = {
    name: params.name as string,
    value: params.value as string,
  };
  if (params.domain) cookieParams.domain = params.domain;
  if (params.path) cookieParams.path = params.path;
  if (params.secure !== undefined) cookieParams.secure = params.secure;
  if (params.httpOnly !== undefined) cookieParams.httpOnly = params.httpOnly;
  if (params.sameSite) cookieParams.sameSite = params.sameSite;
  if (params.expires) cookieParams.expires = params.expires;

  // If no domain, get from current page
  if (!cookieParams.domain && !cookieParams.url) {
    const urlResult = (await ctx.sendCommand('Runtime.evaluate', {
      expression: 'location.href', returnByValue: true,
    }, sess)) as Record<string, unknown>;
    const r = urlResult.result as Record<string, unknown>;
    cookieParams.url = r.value as string;
  }

  const result = (await ctx.sendCommand('Network.setCookie', cookieParams, sess)) as Record<string, unknown>;
  const val = params.value as string;
  return ok(result.success ? `Cookie set: ${params.name}=${val.substring(0, 40)}` : 'Failed to set cookie.');
}

async function handleDeleteCookies(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  await ctx.sendCommand('Network.enable', {}, sess);

  const cdpParams: Record<string, unknown> = {};
  if (params.name) cdpParams.name = params.name;
  if (params.domain) cdpParams.domain = params.domain;
  if (params.url) cdpParams.url = params.url;

  if (!cdpParams.name) return fail("Provide 'name' to delete specific cookies.");

  // CDP requires at least url or domain
  if (!cdpParams.url && !cdpParams.domain) {
    const r = (await ctx.sendCommand('Runtime.evaluate', {
      expression: 'location.origin', returnByValue: true,
    }, sess)) as Record<string, unknown>;
    const origin = ((r.result as Record<string, unknown>)?.value as string) || '';
    if (origin && origin !== 'null') {
      cdpParams.url = origin;
      try { cdpParams.domain = new URL(origin).hostname; } catch { /* ok */ }
    }
  }

  await ctx.sendCommand('Network.deleteCookies', cdpParams, sess);
  return ok(`Deleted cookies matching: ${params.name}${params.domain ? ` (domain: ${params.domain})` : ''}`);
}

async function handleClearCookies(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  await ctx.sendCommand('Network.enable', {}, sess);
  await ctx.sendCommand('Network.clearBrowserCookies', {}, sess);
  return ok('All cookies cleared.');
}

async function handleClearData(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;

  let origin = params.origin as string | undefined;
  if (!origin) {
    const r = (await ctx.sendCommand('Runtime.evaluate', {
      expression: 'location.origin', returnByValue: true,
    }, sess)) as Record<string, unknown>;
    origin = (r.result as Record<string, unknown>).value as string;
  }

  const storageTypes = params.types === 'all'
    ? 'cookies,local_storage,indexeddb,cache_storage,service_workers'
    : ((params.types as string) || 'local_storage,indexeddb,cache_storage');

  await ctx.sendCommand('Storage.clearDataForOrigin', { origin, storageTypes }, sess);
  return ok(`Cleared storage for ${origin}: ${storageTypes}`);
}

async function handleQuota(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;

  const r = (await ctx.sendCommand('Runtime.evaluate', {
    expression: 'location.origin', returnByValue: true,
  }, sess)) as Record<string, unknown>;
  const origin = (r.result as Record<string, unknown>).value as string;

  const quotaResult = (await ctx.sendCommand('Storage.getUsageAndQuota', { origin }, sess)) as Record<string, unknown>;
  const usage = quotaResult.usage as number;
  const quota = quotaResult.quota as number;
  const usageBreakdown = quotaResult.usageBreakdown as Array<{ storageType: string; usage: number }> | undefined;

  const fmt = (b: number): string => {
    if (b > 1073741824) return `${(b / 1073741824).toFixed(2)} GB`;
    if (b > 1048576) return `${(b / 1048576).toFixed(2)} MB`;
    if (b > 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${b} B`;
  };

  let text = `Storage for ${origin}:\n  Usage: ${fmt(usage)} / ${fmt(quota)} (${(usage / quota * 100).toFixed(2)}%)`;
  if (usageBreakdown?.length) {
    text += '\n\nBreakdown:';
    for (const { storageType, usage: u } of usageBreakdown) {
      if (u > 0) text += `\n  ${storageType}: ${fmt(u)}`;
    }
  }
  return ok(text);
}

// ─── Web Storage helpers ────────────────────────────────────────────

/**
 * Resolve the JS storage area name from the storageType param.
 * Defaults to localStorage when omitted.
 */
function storageArea(params: Record<string, unknown>): 'localStorage' | 'sessionStorage' {
  return (params.storageType as string) === 'session' ? 'sessionStorage' : 'localStorage';
}

/**
 * Eval an expression in the page and return its `.result.value` (typed).
 */
async function evalAndGet<T>(
  ctx: ServerContext,
  sess: string,
  expression: string,
): Promise<T> {
  const r = (await ctx.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: true,
  }, sess)) as { result: { value: T } };
  return r.result.value;
}

/**
 * Parity with Playwright MCP browser_localstorage_get / browser_sessionstorage_get
 * — single-call equivalent. Without `key`, returns the whole storage as JSON.
 */
export async function buildGetStorageExpression(
  area: 'localStorage' | 'sessionStorage',
  key?: string,
): Promise<string> {
  if (key) {
    return `(() => { try { return ${area}.getItem(${JSON.stringify(key)}); } catch (e) { return { __err: String(e) }; } })()`;
  }
  return `(() => { try { const o = {}; for (let i = 0; i < ${area}.length; i++) { const k = ${area}.key(i); if (k !== null) o[k] = ${area}.getItem(k); } return o; } catch (e) { return { __err: String(e) }; } })()`;
}

async function handleGetStorage(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  const area = storageArea(params);
  const key = params.key as string | undefined;
  const expr = await buildGetStorageExpression(area, key);

  const value = await evalAndGet<unknown>(ctx, sess, expr);
  if (value && typeof value === 'object' && '__err' in (value as object)) {
    return fail(`${area} access failed: ${(value as { __err: string }).__err}`);
  }

  if (key) {
    if (value === null) return ok(`${area}["${key}"] is null (key not set).`);
    return ok(`${area}["${key}"] = ${JSON.stringify(value)}`);
  }

  const obj = (value ?? {}) as Record<string, string>;
  const entries = Object.entries(obj);
  if (!entries.length) return ok(`${area} is empty.`);
  const lines = entries.map(([k, v]) => `  ${k} = ${(v ?? '').substring(0, 200)}${(v ?? '').length > 200 ? '...' : ''}`);
  return ok(`${area} (${entries.length} key(s)):\n${lines.join('\n')}`);
}

/**
 * Parity with Playwright MCP browser_localstorage_set / browser_sessionstorage_set
 * — single-call equivalent.
 */
async function handleSetStorage(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  if (!params.key || params.value === undefined) return fail("Provide 'key' and 'value' for set_storage.");
  const sess = params._sessionId as string;
  const area = storageArea(params);
  const key = params.key as string;
  const value = String(params.value);

  const expr = `(() => { try { ${area}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}); return true; } catch (e) { return { __err: String(e) }; } })()`;
  const result = await evalAndGet<unknown>(ctx, sess, expr);
  if (result && typeof result === 'object' && '__err' in (result as object)) {
    return fail(`${area} set failed: ${(result as { __err: string }).__err}`);
  }

  return ok(`${area}["${key}"] set (${value.length} chars).`);
}

/**
 * Parity with Playwright MCP browser_localstorage_clear / browser_sessionstorage_clear
 * — single-call equivalent. Omit `key` to clear the entire storage area.
 */
async function handleDeleteStorage(
  ctx: ServerContext,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const sess = params._sessionId as string;
  const area = storageArea(params);
  const key = params.key as string | undefined;

  const expr = key
    ? `(() => { try { ${area}.removeItem(${JSON.stringify(key)}); return true; } catch (e) { return { __err: String(e) }; } })()`
    : `(() => { try { ${area}.clear(); return true; } catch (e) { return { __err: String(e) }; } })()`;

  const result = await evalAndGet<unknown>(ctx, sess, expr);
  if (result && typeof result === 'object' && '__err' in (result as object)) {
    return fail(`${area} delete failed: ${(result as { __err: string }).__err}`);
  }

  return ok(key ? `${area}["${key}"] removed.` : `${area} cleared.`);
}

// ─── Registration ───────────────────────────────────────────────────

export function registerStorageTools(
  registry: ToolRegistry,
  _ctx: ServerContext,
): void {
  registry.register(
    defineTool({
      name: 'storage',
      description: [
        'Use this to manage cookies and browser storage — inspect auth tokens, set test cookies, read/write localStorage or sessionStorage, or clear site data for a clean state.',
        '',
        'Operations:',
        '- get_cookies: Retrieve cookies (requires: tabId; optional: urls — filter by URLs)',
        '- set_cookie: Set a cookie (requires: tabId, name, value; optional: domain, path, secure, httpOnly, sameSite[None|Lax|Strict], expires — epoch seconds)',
        '- delete_cookies: Delete specific cookies by name (requires: tabId, name; optional: url, domain, path)',
        '- clear_cookies: Clear all cookies for the browser profile (requires: tabId)',
        "- clear_data: Clear browser storage for an origin (requires: tabId; optional: origin, types — comma-separated: 'cookies,local_storage,indexeddb,cache_storage' or 'all')",
        "- quota: Check storage quota usage for the current page's origin (requires: tabId)",
        "- get_storage: Read localStorage/sessionStorage. Without 'key' returns the whole object as JSON (requires: tabId; optional: storageType[local|session, default local], key)",
        '- set_storage: Write a localStorage/sessionStorage key (requires: tabId, key, value; optional: storageType[local|session, default local])',
        '- delete_storage: Remove a key (or clear all when omitted) from localStorage/sessionStorage (requires: tabId; optional: storageType[local|session, default local], key)',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get_cookies', 'set_cookie', 'delete_cookies', 'clear_cookies', 'clear_data', 'quota', 'get_storage', 'set_storage', 'delete_storage'], description: 'Storage action.' },
          tabId: { type: 'string', description: 'Tab ID.' },
          urls: { type: 'array', items: { type: 'string' }, description: 'URLs for get_cookies.' },
          name: { type: 'string', description: 'Cookie name.' },
          value: { type: 'string', description: 'Cookie value or web-storage value (set_cookie / set_storage).' },
          domain: { type: 'string', description: 'Cookie domain.' },
          path: { type: 'string', description: 'Cookie path.' },
          secure: { type: 'boolean', description: 'Secure flag.' },
          httpOnly: { type: 'boolean', description: 'HttpOnly flag.' },
          sameSite: { type: 'string', enum: ['None', 'Lax', 'Strict'], description: 'SameSite attribute.' },
          expires: { type: 'number', description: 'Expiry as epoch seconds.' },
          url: { type: 'string', description: 'URL for delete_cookies.' },
          origin: { type: 'string', description: 'Origin for clear_data.' },
          types: { type: 'string', description: "Storage types: 'cookies,local_storage,indexeddb,cache_storage' or 'all'." },
          storageType: { type: 'string', enum: ['local', 'session'], description: "Web storage area for get_storage/set_storage/delete_storage. 'local' (default) = localStorage, 'session' = sessionStorage." },
          key: { type: 'string', description: 'Key for get_storage/set_storage/delete_storage. Omit on get/delete to operate on the whole storage area.' },
          sessionId: { type: 'string', description: 'Agent session ID for tab ownership and isolation. Tabs are locked to sessions. Default: per-process UUID.' },
          cleanupStrategy: { type: 'string', enum: ['close', 'detach', 'none'], description: "Tab cleanup on session expiry. 'detach' (default) keeps tabs open, 'close' removes them, 'none' skips cleanup. Sticky per session." },
          exclusive: { type: 'boolean', description: 'Lock tab to this session (default: true). Set false to allow shared access.' },
        },
        required: ['action', 'tabId'],
      },
      handler: async (ctx, params) => {
        const action = params.action as string;
        switch (action) {
          case 'get_cookies':     return handleGetCookies(ctx, params);
          case 'set_cookie':      return handleSetCookie(ctx, params);
          case 'delete_cookies':  return handleDeleteCookies(ctx, params);
          case 'clear_cookies':   return handleClearCookies(ctx, params);
          case 'clear_data':      return handleClearData(ctx, params);
          case 'quota':           return handleQuota(ctx, params);
          case 'get_storage':     return handleGetStorage(ctx, params);
          case 'set_storage':     return handleSetStorage(ctx, params);
          case 'delete_storage':  return handleDeleteStorage(ctx, params);
          default:                return fail(`Unknown storage action: "${action}". Use: get_cookies, set_cookie, delete_cookies, clear_cookies, clear_data, quota, get_storage, set_storage, delete_storage`);
        }
      },
    }),
  );
}
