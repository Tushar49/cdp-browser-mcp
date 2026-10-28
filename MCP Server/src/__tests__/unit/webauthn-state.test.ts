/**
 * WS1: WebAuthnStateManager — ownership/routing registry for virtual
 * authenticators. Unit tests only (no CDP): register/unregister/list,
 * tab-scoped queries, internal-transport filter, lifecycle sweeps.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WebAuthnStateManager, type AuthenticatorRecord } from '../../session/webauthn-state.js';

function record(overrides: Partial<AuthenticatorRecord> = {}): AuthenticatorRecord {
  return {
    ownerTabId: 'tab-1',
    options: { protocol: 'ctap2', transport: 'internal' },
    createdAt: 1000,
    ...overrides,
  };
}

describe('WebAuthnStateManager', () => {
  let mgr: WebAuthnStateManager;

  beforeEach(() => {
    mgr = new WebAuthnStateManager();
  });

  it('registers, gets and unregisters authenticators', () => {
    mgr.register('auth-1', record());
    expect(mgr.get('auth-1')?.ownerTabId).toBe('tab-1');
    mgr.unregister('auth-1');
    expect(mgr.get('auth-1')).toBeUndefined();
  });

  it('unregistering an unknown id is a no-op', () => {
    expect(() => mgr.unregister('nope')).not.toThrow();
  });

  it('list() returns authenticatorId merged with the record', () => {
    mgr.register('auth-1', record());
    mgr.register('auth-2', record({ ownerTabId: 'tab-2' }));
    const all = mgr.list();
    expect(all).toHaveLength(2);
    expect(all[0].authenticatorId).toBe('auth-1');
    expect(all[1].ownerTabId).toBe('tab-2');
  });

  it('listByTab filters by owner tab', () => {
    mgr.register('auth-1', record());
    mgr.register('auth-2', record());
    mgr.register('auth-3', record({ ownerTabId: 'tab-2' }));
    expect(mgr.listByTab('tab-1')).toEqual(['auth-1', 'auth-2']);
    expect(mgr.listByTab('tab-2')).toEqual(['auth-3']);
    expect(mgr.listByTab('tab-x')).toEqual([]);
  });

  it('listInternal returns only internal-transport authenticators', () => {
    mgr.register('auth-internal', record());
    mgr.register('auth-usb', record({ options: { protocol: 'ctap2', transport: 'usb' } }));
    expect(mgr.listInternal()).toEqual(['auth-internal']);
  });

  it('clearForTab drops only that tab\'s entries', () => {
    mgr.register('auth-1', record());
    mgr.register('auth-2', record({ ownerTabId: 'tab-2' }));
    mgr.clearForTab('tab-1');
    expect(mgr.get('auth-1')).toBeUndefined();
    expect(mgr.get('auth-2')).toBeDefined();
  });

  it('clearAll drops everything', () => {
    mgr.register('auth-1', record());
    mgr.register('auth-2', record({ ownerTabId: 'tab-2' }));
    mgr.clearAll();
    expect(mgr.list()).toHaveLength(0);
  });
});
