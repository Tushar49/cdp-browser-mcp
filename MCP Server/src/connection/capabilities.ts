/**
 * CDP domain capability report (5.1.0 B1, redesigned as multi-canary probing).
 *
 * `Schema.getDomains` — the original probe — was removed from Chrome years ago:
 * on any modern Chrome/Brave it replies "'Schema.getDomains' wasn't found"
 * (confirmed live on Brave 153, approval mode). There is no domain-enumeration
 * command anymore, so presence is now probed per domain with a real canary
 * command whose empty-params call is either read-only or rejected by parameter
 * validation before any handler runs — a probe never mutates meaningful state.
 *
 * Classification:
 * - `"'X' wasn't found"` → domain/method absent
 * - any other outcome (success / Invalid parameters / domain-specific error)
 *   → domain present
 *
 * Cache lives on the instance and is invalidated on disconnect
 * (wired in index.ts next to the other per-connection caches).
 */
import type { CDPClient } from './cdp-client.js';

/** Domains whose absence is worth surfacing in `status` output. */
export const NOTABLE_DOMAINS = [
  'WebAuthn',
  'FedCm',
  'WebMCP',
  'Preload',
  'Ads',
  'Extensions',
  'PWA',
  'FindInPage',
  'Tracing',
  'Overlay',
] as const;

export type NotableDomain = (typeof NOTABLE_DOMAINS)[number];

/**
 * Canary command per domain (method names verified against the Chromium
 * browser-protocol surface shipped with Playwright 1.65):
 *
 * - requires parameters → `{}` is rejected with "Invalid parameters" before
 *   the handler runs (zero side effect): WebAuthn.addVirtualAuthenticator
 *   (options), FedCm.selectAccount (dialogId+accountIndex),
 *   WebMCP.invokeTool (frameId+toolName+input), Extensions.loadUnpacked
 *   (path), PWA.getOsAppState (manifestId), FindInPage.findFirst (query),
 *   Overlay.setInspectMode (mode)
 * - read-only with no required params → succeeds harmlessly:
 *   Ads.getAdScripts, Tracing.getCategories
 * - Preload.enable is the one intentional soft exception: it succeeds and
 *   merely enables speculative preloading for the session (the browser's
 *   own default behavior).
 */
const CANARIES: Record<NotableDomain, string> = {
  WebAuthn: 'WebAuthn.addVirtualAuthenticator',
  FedCm: 'FedCm.selectAccount',
  WebMCP: 'WebMCP.invokeTool',
  Preload: 'Preload.enable',
  Ads: 'Ads.getAdScripts',
  Extensions: 'Extensions.loadUnpacked',
  PWA: 'PWA.getOsAppState',
  FindInPage: 'FindInPage.findFirst',
  Overlay: 'Overlay.setInspectMode',
  Tracing: 'Tracing.getCategories',
};

/** True when a CDP error means "domain or method not implemented". */
export function isMethodMissingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /wasn'?t found|not found/i.test(msg);
}

export class DomainCapabilities {
  /** Probe key (domain or Domain.method) → present? */
  private cache = new Map<string, boolean>();
  private inFlight = new Map<string, Promise<boolean>>();

  /**
   * Probe a single canary / method. Empty params on purpose:
   * required-params canaries fail validation (proving presence), read-only
   * canaries succeed (proving presence), unknown methods report "wasn't found".
   *
   * Pass a page-session id when probing page-scoped domains: the browser-level
   * endpoint only serves browser-wide domains (Target/Browser/SystemInfo/
   * Tracing/Extensions...), so page-scoped domains report "wasn't found"
   * without a session (live-confirmed: browser-level probes said 2/10).
   */
  async hasMethod(client: CDPClient, method: string, sessionId?: string): Promise<boolean> {
    const cached = this.cache.get(method);
    if (cached !== undefined) return cached;
    const pending = this.inFlight.get(method);
    if (pending) return pending;

    const probe = (async () => {
      try {
        await client.send(method, {}, sessionId);
        return true;
      } catch (err) {
        if (isMethodMissingError(err)) return false;
        // Invalid parameters / domain-specific error → the method exists
        return true;
      } finally {
        this.inFlight.delete(method);
      }
    })();
    this.inFlight.set(method, probe);
    const present = await probe;
    this.cache.set(method, present);
    return present;
  }

  /**
   * True when the connected browser supports the given domain. Domain names
   * resolve through their canary; dotted "Domain.method" keys probe directly
   * (useful for version-gated methods like Emulation.setCPUPerformanceOverride).
   */
  async has(client: CDPClient, key: string, sessionId?: string): Promise<boolean> {
    if (key.includes('.')) return this.hasMethod(client, key, sessionId);
    const canary = CANARIES[key as NotableDomain];
    if (!canary) return false; // no canary → unknown, treated as absent
    return this.hasMethod(client, canary, sessionId);
  }

  /** Feature-gate helper: throws an actionable error when absent. */
  async require(client: CDPClient, key: string, minChrome?: string, sessionId?: string): Promise<void> {
    if (await this.has(client, key, sessionId)) return;
    const versionNote = minChrome ? ` (requires Chrome ${minChrome}+)` : '';
    const err = new Error(
      `This browser does not support the CDP "${key}" feature${versionNote}. ` +
        `Update Chrome/Brave or use a feature-gated alternative.`,
    );
    err.name = 'DomainUnsupportedError';
    throw err;
  }

  /** Invalidate on disconnect/reconnect. */
  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  /**
   * Summary for the `status` tool: how many of the notable domains are
   * present, and which are missing. Every entry is individually probed.
   */
  async summarize(client: CDPClient, sessionId?: string): Promise<{ count: number; missing: string[] }> {
    const results = await Promise.all(
      NOTABLE_DOMAINS.map(async (d) => [d, await this.has(client, d, sessionId)] as const),
    );
    const missing = results.filter(([, present]) => !present).map(([d]) => d);
    return { count: results.length - missing.length, missing };
  }
}
