/**
 * CDP domain capability report (5.1.0 B1).
 *
 * Fetches `Schema.getDomains` once per connection and answers
 * "does this browser support domain X?" — the feature-detection backbone
 * for version-gated protocol surface (Emulation.setCPUPerformanceOverride,
 * Network.configureDurableMessages, WebAuthn, WebMCP, …).
 *
 * Cache lives on the instance and is invalidated on disconnect
 * (wired in index.ts next to the other per-connection caches).
 */
import type { CDPClient } from '../connection/cdp-client.js';

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

export class DomainCapabilities {
  private domains: Set<string> | null = null;
  private fetchPromise: Promise<Set<string>> | null = null;

  /**
   * Get the supported-domain set for the connected browser.
   * Cached per connection; re-fetched after `clear()`.
   */
  async get(client: CDPClient): Promise<Set<string>> {
    if (this.domains) return this.domains;
    if (!this.fetchPromise) {
      this.fetchPromise = (async () => {
        const resp = (await client.send('Schema.getDomains', {})) as {
          domains?: Array<{ name?: string }>;
        };
        const set = new Set<string>(
          (resp.domains ?? []).map((d) => d.name).filter((n): n is string => !!n),
        );
        this.domains = set;
        this.fetchPromise = null;
        return set;
      })();
    }
    return this.fetchPromise;
  }

  /** True when the connected browser lists the given domain. */
  has(client: CDPClient, domain: string): Promise<boolean> {
    return this.get(client).then((set) => set.has(domain));
  }

  /** Feature-gate helper: throws an actionable error when absent. */
  async require(client: CDPClient, domain: string, minChrome?: string): Promise<void> {
    const set = await this.get(client);
    if (set.has(domain)) return;
    const versionNote = minChrome ? ` (requires Chrome ${minChrome}+)` : '';
    const err = new Error(
      `This browser does not support the CDP "${domain}" domain${versionNote}. ` +
        `Update Chrome/Brave or use a feature-gated alternative.`,
    );
    err.name = 'DomainUnsupportedError';
    throw err;
  }

  /** Invalidate on disconnect/reconnect. */
  clear(): void {
    this.domains = null;
    this.fetchPromise = null;
  }

  /** Summary line for the `status` tool: count + notable-missing. */
  async summarize(client: CDPClient): Promise<{ count: number; missing: string[] }> {
    const set = await this.get(client);
    const missing = NOTABLE_DOMAINS.filter((d) => !set.has(d));
    return { count: set.size, missing };
  }
}
