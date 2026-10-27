import { describe, it, expect } from 'vitest';
import { DomainCapabilities, isMethodMissingError, NOTABLE_DOMAINS } from '../../connection/capabilities.js';
import type { CDPClient } from '../../connection/cdp-client.js';

/** CDPClient stand-in whose behavior is scripted per method. */
function makeClient(behavior: (method: string) => 'ok' | 'notfound' | 'invalid') {
  return {
    send: async (method: string) => {
      const b = behavior(method);
      if (b === 'notfound') throw new Error(`'${method}' wasn't found`);
      if (b === 'invalid') throw new Error(`Invalid parameters`);
      return {};
    },
  } as unknown as CDPClient;
}

describe('isMethodMissingError', () => {
  it('classifies Chrome "wasn\'t found" errors as missing', () => {
    expect(isMethodMissingError(new Error("'Schema.getDomains' wasn't found"))).toBe(true);
    expect(isMethodMissingError(new Error("'Foo.bar' wasn't found"))).toBe(true);
    expect(isMethodMissingError(new Error('method not found'))).toBe(true);
  });

  it('does not classify domain/validation errors as missing', () => {
    expect(isMethodMissingError(new Error('Invalid parameters'))).toBe(false);
    expect(isMethodMissingError(new Error('A dialog is already open'))).toBe(false);
  });
});

describe('DomainCapabilities multi-canary probing (B1)', () => {
  it('treats "wasn\'t found" as absent', async () => {
    const caps = new DomainCapabilities();
    const client = makeClient(() => 'notfound');
    expect(await caps.has(client, 'WebAuthn')).toBe(false);
  });

  it('treats Invalid parameters as present (required-params canary)', async () => {
    const caps = new DomainCapabilities();
    const client = makeClient(() => 'invalid');
    expect(await caps.has(client, 'WebAuthn')).toBe(true);
  });

  it('treats success as present (read-only canary)', async () => {
    const caps = new DomainCapabilities();
    const client = makeClient(() => 'ok');
    expect(await caps.has(client, 'Tracing')).toBe(true);
  });

  it('probes dotted method keys directly', async () => {
    const caps = new DomainCapabilities();
    const client = makeClient((m) => (m === 'Emulation.setCPUPerformanceOverride' ? 'invalid' : 'notfound'));
    expect(await caps.has(client, 'Emulation.setCPUPerformanceOverride')).toBe(true);
    expect(await caps.has(client, 'Emulation.setDoesNotExist')).toBe(false);
  });

  it('caches probes per connection (single send per method)', async () => {
    const caps = new DomainCapabilities();
    let calls = 0;
    const client = {
      send: async () => {
        calls++;
        throw new Error("'X.y' wasn't found");
      },
    } as unknown as CDPClient;
    await caps.has(client, 'WebAuthn');
    await caps.has(client, 'WebAuthn');
    expect(calls).toBe(1);
    expect(await caps.has(client, 'FedCm')).toBe(false);
    expect(calls).toBe(2);
  });

  it('clear() invalidates the cache', async () => {
    const caps = new DomainCapabilities();
    let calls = 0;
    const client = {
      send: async () => {
        calls++;
        return {};
      },
    } as unknown as CDPClient;
    await caps.has(client, 'WebAuthn');
    caps.clear();
    await caps.has(client, 'WebAuthn');
    expect(calls).toBe(2);
  });

  it('summarize counts present domains and lists missing ones', async () => {
    const caps = new DomainCapabilities();
    // Everything present except WebMCP (newest domain, may lag on older Chrome)
    const client = makeClient((m) => (m === 'WebMCP.invokeTool' ? 'notfound' : 'invalid'));
    const { count, missing } = await caps.summarize(client);
    expect(count).toBe(NOTABLE_DOMAINS.length - 1);
    expect(missing).toEqual(['WebMCP']);
  });
});
