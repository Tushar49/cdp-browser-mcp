/**
 * Capability report (5.1.0 B1) — Schema.getDomains fetch, caching,
 * invalidation, feature-gate helper.
 */
import { describe, it, expect, vi } from 'vitest';
import { DomainCapabilities, NOTABLE_DOMAINS } from '../../connection/capabilities.js';
import type { CDPClient } from '../../connection/cdp-client.js';

const DOMAINS = [
  { name: 'Page' }, { name: 'Network' }, { name: 'Input' },
  { name: 'Emulation' }, { name: 'WebAuthn' },
];

function fakeClient(sendImpl: vi.Mock): CDPClient {
  return { send: sendImpl } as unknown as CDPClient;
}

describe('DomainCapabilities', () => {
  it('parses Schema.getDomains into a name set', async () => {
    const send = vi.fn(async () => ({ domains: DOMAINS }));
    const caps = new DomainCapabilities();
    const set = await caps.get(fakeClient(send));
    expect(set.has('Page')).toBe(true);
    expect(set.has('WebAuthn')).toBe(true);
    expect(set.has('FedCm')).toBe(false);
  });

  it('caches: second get() does not re-send', async () => {
    const send = vi.fn(async () => ({ domains: DOMAINS }));
    const caps = new DomainCapabilities();
    const client = fakeClient(send);
    await caps.get(client);
    await caps.get(client);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('clear() forces a re-fetch on next get()', async () => {
    const send = vi.fn(async () => ({ domains: DOMAINS }));
    const caps = new DomainCapabilities();
    const client = fakeClient(send);
    await caps.get(client);
    caps.clear();
    await caps.get(client);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('require() passes for present domains', async () => {
    const caps = new DomainCapabilities();
    await expect(
      caps.require(fakeClient(vi.fn(async () => ({ domains: DOMAINS }))), 'Emulation'),
    ).resolves.toBeUndefined();
  });

  it('require() throws DomainUnsupportedError naming the domain (+version hint)', async () => {
    const caps = new DomainCapabilities();
    const err = await caps
      .require(
        fakeClient(vi.fn(async () => ({ domains: DOMAINS }))),
        'WebMCP',
        '149',
      )
      .catch((e) => e);
    expect(err.name).toBe('DomainUnsupportedError');
    expect(err.message).toContain('WebMCP');
    expect(err.message).toContain('Chrome 149+');
  });

  it('summarize() returns count + notable missing domains', async () => {
    const caps = new DomainCapabilities();
    const { count, missing } = await caps.summarize(
      fakeClient(vi.fn(async () => ({ domains: DOMAINS }))),
    );
    expect(count).toBe(DOMAINS.length);
    // FedCm/WebMCP not in DOMAINS → missing; WebAuthn present → not missing
    expect(missing).toContain('FedCm');
    expect(missing).toContain('WebMCP');
    expect(missing).not.toContain('WebAuthn');
    expect(NOTABLE_DOMAINS).toContain('WebMCP');
  });

  it('tolerates malformed Schema.getDomains responses', async () => {
    const caps = new DomainCapabilities();
    const set = await caps.get(fakeClient(vi.fn(async () => ({}))));
    expect(set.size).toBe(0);
  });
});
