import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { TabSessionService } from '../../connection/tab-session-service.js';
import type { CDPClient } from '../../connection/cdp-client.js';
import { tagNodesWithSession } from '../../snapshot/accessibility.js';
import type { AXNode } from '../../snapshot/accessibility.js';

/** Minimal CDPClient stand-in: EventEmitter + send/pool surface. */
class FakeCDPClient extends EventEmitter {
  sent: Array<{ method: string; params?: object; sessionId?: string }> = [];
  private pool = new Map<string, string>();

  async send(method: string, params?: object, sessionId?: string): Promise<unknown> {
    this.sent.push({ method, params, sessionId });
    if (method === 'Target.attachToTarget') {
      return { sessionId: `sess-${this.sent.length}` };
    }
    return {};
  }

  getPooledSession(targetId: string): string | null {
    return this.pool.get(targetId) ?? null;
  }

  poolSession(targetId: string, sessionId: string): void {
    this.pool.set(targetId, sessionId);
  }

  unpoolSession(targetId: string): void {
    this.pool.delete(targetId);
  }
}

function makeAttachedEvent(parentSessionId: string, childSessionId: string, type = 'iframe') {
  return {
    method: 'Target.attachedToTarget',
    sessionId: parentSessionId,
    params: {
      sessionId: childSessionId,
      targetInfo: { targetId: `tgt-${childSessionId}`, type, url: 'https://evil.example/frame' },
    },
  };
}

describe('TabSessionService auto-attach event routing (A5b)', () => {
  it('registers child sessions from Target.attachedToTarget for managed page sessions', async () => {
    const svc = new TabSessionService();
    const client = new FakeCDPClient();
    const parentSess = await svc.getSession(client as unknown as CDPClient, 'tab1');

    client.emit('event', makeAttachedEvent(parentSess, 'sess-child'));

    const children = svc.getChildSessions(parentSess);
    expect(children.size).toBe(1);
    const entry = children.get('tgt-sess-child');
    expect(entry).toEqual({ sessionId: 'sess-child', url: 'https://evil.example/frame' });
    expect(svc.getParentSession('sess-child')).toBe(parentSess);
  });

  it('ignores attachedToTarget events from non-managed sessions', async () => {
    const svc = new TabSessionService();
    const client = new FakeCDPClient();
    await svc.getSession(client as unknown as CDPClient, 'tab1');

    client.emit('event', makeAttachedEvent('sess-foreign', 'sess-child'));

    expect(svc.getChildSessions('sess-foreign').size).toBe(0);
    expect(svc.getParentSession('sess-child')).toBeUndefined();
  });

  it('ignores non-iframe target types', async () => {
    const svc = new TabSessionService();
    const client = new FakeCDPClient();
    const parentSess = await svc.getSession(client as unknown as CDPClient, 'tab1');

    client.emit('event', makeAttachedEvent(parentSess, 'sess-worker', 'worker'));

    expect(svc.getChildSessions(parentSess).size).toBe(0);
  });

  it('removes child sessions on Target.detachedFromTarget', async () => {
    const svc = new TabSessionService();
    const client = new FakeCDPClient();
    const parentSess = await svc.getSession(client as unknown as CDPClient, 'tab1');

    client.emit('event', makeAttachedEvent(parentSess, 'sess-child'));
    expect(svc.getChildSessions(parentSess).size).toBe(1);

    client.emit('event', {
      method: 'Target.detachedFromTarget',
      sessionId: parentSess,
      params: { sessionId: 'sess-child' },
    });

    expect(svc.getChildSessions(parentSess).size).toBe(0);
    expect(svc.getParentSession('sess-child')).toBeUndefined();
  });

  it('registers the event listener once per client (idempotent wiring)', async () => {
    const svc = new TabSessionService();
    const client = new FakeCDPClient();

    await svc.getSession(client as unknown as CDPClient, 'tab1');
    const countAfterFirst = client.listenerCount('event');
    await svc.getSession(client as unknown as CDPClient, 'tab1');
    await svc.getSession(client as unknown as CDPClient, 'tab2');

    expect(countAfterFirst).toBe(1);
    expect(client.listenerCount('event')).toBe(1);
  });
});

describe('tagNodesWithSession (A5b refRouting ordering fix)', () => {
  it('records routing only for nodes with assigned uids', () => {
    const tagged: AXNode[] = [
      { role: 'button', name: 'In frame', uid: 42, backendNodeId: 7 } as unknown as AXNode,
      { role: 'generic', name: 'no uid yet' } as unknown as AXNode,
      { role: 'link', name: 'Nested', uid: 43, backendNodeId: 9, children: [] } as unknown as AXNode,
    ];

    const routing = new Map<number, string>();
    tagNodesWithSession(tagged, 'sess-child', routing);

    expect(routing.get(42)).toBe('sess-child');
    expect(routing.get(43)).toBe('sess-child');
    expect(routing.size).toBe(2);
  });
});
