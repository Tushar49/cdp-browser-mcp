/**
 * WebAuthn virtual-authenticator registry for CDP Browser MCP Server (5.2 WS1).
 *
 * Tracks which virtual authenticators this server created, and which tab owns
 * each one, so every authenticatorId-taking CDP command can be routed through
 * the OWNING tab's session. Chromium's authenticator scope across sessions was
 * not resolvable from source at design time (plan v5.2.0 §WS1); routing through
 * the owner is correct whether authenticators are session-scoped or shared.
 *
 * Ownership only: this registry is never a credential cache — listing always
 * queries CDP live. `WebAuthn.enable` is NOT tracked here; it is per-CDP-session
 * state that dies on re-attach, so `add_authenticator` unconditionally sends it
 * (idempotent) immediately before `addVirtualAuthenticator`.
 *
 * Lifecycle: cleared per-tab on `Target.targetDestroyed` (wired in index.ts —
 * covers every close origin, including the user closing the tab in the
 * browser), and wholesale on CDP disconnect. Deliberately NOT cleared on
 * detach: detach keeps the tab (and its browser-side authenticators) alive,
 * and CDP has no enumerate-authenticators method — clearing the registry on
 * detach would orphan browser-side state with no recovery path.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface AuthenticatorRecord {
  /** Tab target ID that created (and owns) the authenticator. */
  ownerTabId: string;
  /** The VirtualAuthenticatorOptions the authenticator was created with. */
  options: Record<string, unknown>;
  createdAt: number;
}

// ─── WebAuthnStateManager ───────────────────────────────────────────

export class WebAuthnStateManager {
  /** authenticatorId → record. */
  private auths = new Map<string, AuthenticatorRecord>();

  register(authenticatorId: string, record: AuthenticatorRecord): void {
    this.auths.set(authenticatorId, record);
  }

  /** Remove a registry entry after the CDP-side authenticator is removed. */
  unregister(authenticatorId: string): void {
    this.auths.delete(authenticatorId);
  }

  get(authenticatorId: string): AuthenticatorRecord | undefined {
    return this.auths.get(authenticatorId);
  }

  /** All registered authenticators as `{ authenticatorId, ...record }` entries. */
  list(): Array<{ authenticatorId: string } & AuthenticatorRecord> {
    return [...this.auths.entries()].map(([authenticatorId, record]) => ({
      authenticatorId,
      ...record,
    }));
  }

  /** Authenticator IDs owned by a tab (for reset / tab cleanup). */
  listByTab(tabId: string): string[] {
    return [...this.auths.entries()]
      .filter(([, r]) => r.ownerTabId === tabId)
      .map(([id]) => id);
  }

  /** Authenticator IDs created with the `internal` transport (platform-key semantics). */
  listInternal(): string[] {
    return [...this.auths.entries()]
      .filter(([, r]) => r.options.transport === 'internal')
      .map(([id]) => id);
  }

  /** Drop every entry owned by a tab (Target.targetDestroyed / tabs.close). */
  clearForTab(tabId: string): void {
    for (const [id, r] of this.auths.entries()) {
      if (r.ownerTabId === tabId) this.auths.delete(id);
    }
  }

  /** Drop everything (CDP disconnect — browser-side state is gone too). */
  clearAll(): void {
    this.auths.clear();
  }
}
