/**
 * Tab ownership and locking for multi-agent session isolation.
 *
 * Extracted from server.js:
 *  - `tabLocks` Map  — which agent session owns which tab
 *  - `activeSessions` Map  — tabId → CDP session ID mapping
 *  - Exclusive lock checks in handleTool
 *  - Tab listing filters (showAll vs session-scoped)
 *
 * Note (Issue B, alpha.4): profile-sticky launch logic does NOT live
 * here — the pinned `browserContextId` is stored on the AgentSession
 * itself (see session-manager.ts) and resolved at tab-creation time
 * by `session/profile-resolver.ts`. A stale pin used to silently let
 * Chrome open new tabs in the user's foreground profile; the resolver
 * now validates the pin against `Target.getBrowserContexts` ∪
 * `Target.getTargets[].browserContextId` before each `tabs.new`.
 */

// ─── Public Types ───────────────────────────────────────────────────

export interface TabLock {
  sessionId: string;
  exclusive: boolean;
  origin: 'created' | 'claimed';
  lockedAt: number;
}

// ─── TabOwnership ───────────────────────────────────────────────────

export class TabOwnership {
  /** tabId → agent-session lock metadata */
  private locks = new Map<string, TabLock>();

  /** tabId → CDP target session ID (the browser-level session, not the agent session) */
  private cdpSessions = new Map<string, string>();

  // ── Lock management ───────────────────────────────────────────────

  /**
   * Lock a tab to an agent session.
   *
   * Mirrors `tabLocks.set(targetId, { sessionId, origin })` in server.js.
   * In the original code `exclusive` was implicit (always true unless the
   * caller passed `exclusive: false`); here it's stored explicitly.
   */
  lock(
    tabId: string,
    sessionId: string,
    exclusive: boolean,
    origin: 'created' | 'claimed',
  ): void {
    this.locks.set(tabId, {
      sessionId,
      exclusive,
      origin,
      lockedAt: Date.now(),
    });
  }

  /**
   * Check whether `sessionId` may access `tabId`.
   *
   * Mirrors the exclusive-lock guard in handleTool:
   *  - If the tab is unowned → allow (caller will claim it).
   *  - If the tab is owned by this session → allow.
   *  - If the tab is owned by another session AND the caller did NOT
   *    opt into shared access (`exclusive !== false`) → deny.
   *
   * @param exclusiveOverride  When explicitly `false`, the caller is
   *   requesting shared (non-exclusive) access.
   */
  canAccess(
    tabId: string,
    sessionId: string,
    exclusiveOverride?: boolean,
  ): boolean {
    const lock = this.locks.get(tabId);
    if (!lock) return true; // unowned
    if (lock.sessionId === sessionId) return true; // own tab
    if (exclusiveOverride === false) return true; // shared access requested
    return false;
  }

  /** Release a single tab lock. */
  release(tabId: string): void {
    this.locks.delete(tabId);
  }

  /**
   * Release every tab owned by `sessionId`.
   *
   * @returns Array of released tabIds (useful for downstream CDP detach).
   */
  releaseSession(sessionId: string): string[] {
    const released: string[] = [];
    for (const [tabId, lock] of this.locks) {
      if (lock.sessionId === sessionId) {
        this.locks.delete(tabId);
        released.push(tabId);
      }
    }
    return released;
  }

  /** Get the lock metadata for a tab (or undefined if unowned). */
  getLock(tabId: string): TabLock | undefined {
    return this.locks.get(tabId);
  }

  /**
   * Get all tab IDs locked by a given session.
   *
   * Mirrors `[...s.tabIds].filter(tid => tabLocks.get(tid)?.sessionId === id)`.
   */
  getSessionTabs(sessionId: string): string[] {
    const tabs: string[] = [];
    for (const [tabId, lock] of this.locks) {
      if (lock.sessionId === sessionId) {
        tabs.push(tabId);
      }
    }
    return tabs;
  }

  /**
   * Attempt to claim a tab for a session.
   *
   * Mirrors the handleTool logic:
   *  1. If tab is already locked by another session and exclusive is not
   *     false → return false (access denied).
   *  2. If tab is unowned → set lock with origin 'claimed'.
   *  3. If tab is already owned by this session → no-op.
   *
   * @returns `true` if the tab is now accessible, `false` if blocked.
   */
  claimIfUnowned(
    tabId: string,
    sessionId: string,
    exclusive?: boolean,
  ): boolean {
    const lock = this.locks.get(tabId);

    // Locked by another session — check exclusive override
    if (lock?.sessionId && lock.sessionId !== sessionId && exclusive !== false) {
      return false;
    }

    // Only set lock if tab is unowned — never overwrite another session's lock
    if (!lock) {
      this.lock(tabId, sessionId, exclusive !== false, 'claimed');
    }

    return true;
  }

  // ── CDP session mapping ───────────────────────────────────────────

  /** Associate a tabId with its CDP target session ID. */
  setCdpSession(tabId: string, cdpSessionId: string): void {
    this.cdpSessions.set(tabId, cdpSessionId);
  }

  /** Get the CDP session ID for a tab (or undefined if not attached). */
  getCdpSession(tabId: string): string | undefined {
    return this.cdpSessions.get(tabId);
  }

  /** Remove the CDP session mapping for a tab. */
  removeCdpSession(tabId: string): void {
    this.cdpSessions.delete(tabId);
  }

  /** Check whether a tab has an active CDP session. */
  hasCdpSession(tabId: string): boolean {
    return this.cdpSessions.has(tabId);
  }

  /** Get all tabIds with active CDP sessions. */
  cdpSessionKeys(): IterableIterator<string> {
    return this.cdpSessions.keys();
  }

  /** Number of active CDP sessions. */
  get cdpSessionCount(): number {
    return this.cdpSessions.size;
  }

  /** Clear all CDP session mappings. */
  clearCdpSessions(): void {
    this.cdpSessions.clear();
  }

  // ── Listing ───────────────────────────────────────────────────────

  /**
   * List tab locks, optionally filtered to a session's view.
   *
   * Mirrors the session-scoped tab listing in handleTool:
   *  - If `showAll` is true → return all locks.
   *  - Otherwise → return only locks belonging to `sessionId`.
   */
  listLocks(sessionId?: string, showAll?: boolean): Map<string, TabLock> {
    if (showAll || !sessionId) {
      return new Map(this.locks);
    }
    const filtered = new Map<string, TabLock>();
    for (const [tabId, lock] of this.locks) {
      if (lock.sessionId === sessionId) {
        filtered.set(tabId, lock);
      }
    }
    return filtered;
  }

  /** Clear all locks. */
  clear(): void {
    this.locks.clear();
  }

  /** Total number of locked tabs. */
  get size(): number {
    return this.locks.size;
  }

  /** Iterate all locks. */
  entries(): IterableIterator<[string, TabLock]> {
    return this.locks.entries();
  }
}
