/**
 * Actionability gate (5.1.0 A1) — ladder timing, state matrix, hit-target,
 * stable detection, force/autoWait escapes. Pure unit: send is mocked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runActionabilityGate,
  retryWithLadder,
  ACTIONABILITY_LADDER,
  ACTIONABILITY_FN_NAME,
} from '../../utils/actionability.js';
import { ActionableError } from '../../utils/error-handler.js';

type Round = Record<string, unknown>;

function makeSend(rounds: Round[], opts: { marker?: boolean } = {}) {
  let i = 0;
  const send = vi.fn(async () => {
    const round = rounds[Math.min(i++, rounds.length - 1)];
    return { result: { value: round } };
  }) as unknown as ReturnType<typeof vi.fn> & ((m: string, p?: object, s?: string) => Promise<unknown>);
  void opts;
  return send;
}

const visible = (box = { x: 10, y: 10, w: 100, h: 30 }): Round => ({
  present: true, visible: true, enabled: true, editable: true,
  hitOk: true, hitTag: 'button', box, stable: false,
});

describe('retryWithLadder()', () => {
  afterEach(() => vi.useRealTimers());

  it('uses the Playwright-shaped ladder delays', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const p = retryWithLadder(async () => {
      calls++;
      throw new Error('nope');
    }, { timeoutMs: 260, ladder: ACTIONABILITY_LADDER });
    // Attach the rejection expectation before advancing — with fake timers the
    // deadline rejection fires inside advanceTimersByTimeAsync, and a late
    // handler registers as an unhandled rejection (vitest exit-code 1).
    const rejection = expect(p).rejects.toThrow('nope');
    // Advance past the deadline; the ladder self-schedules inside
    await vi.advanceTimersByTimeAsync(2000);
    await rejection;
    // 260ms budget covers 20+50+100+100 = 270? No — deadline cuts after 260,
    // so 4 attempts (3 full waits) minimum. Assert bounded, not exact.
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(calls).toBeLessThanOrEqual(6);
  });

  it('returns on first success without extra delays', async () => {
    let calls = 0;
    const result = await retryWithLadder(async () => ++calls, { timeoutMs: 1000 });
    expect(result).toBe(1);
    expect(calls).toBe(1);
  });
});

describe('runActionabilityGate()', () => {
  it('passes immediately when all states are satisfied', async () => {
    const send = makeSend([visible()]);
    await expect(
      runActionabilityGate(send, 's1', { objectId: 'o1' }, { states: ['visible', 'enabled'], timeoutMs: 500 }),
    ).resolves.toBeUndefined();
    expect((send as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('Runtime.callFunctionOn');
  });

  it('selector path uses Runtime.evaluate with the injected marker', async () => {
    const send = makeSend([visible()]);
    await runActionabilityGate(send, 's1', { selector: '.btn' }, { states: ['visible'], timeoutMs: 500 });
    const expr = (send as ReturnType<typeof vi.fn>).mock.calls[0][1] as { expression: string };
    expect((send as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('Runtime.evaluate');
    expect(expr.expression).toContain(ACTIONABILITY_FN_NAME);
    expect(expr.expression).toContain('.btn');
  });

  it('stable requires two consecutive rounds with the same box', async () => {
    const send = makeSend([visible(), { ...visible(), stable: true }]); // round1: no prev → not stable; round2: same box → stable
    await runActionabilityGate(send, 's1', { objectId: 'o1' }, { states: ['visible', 'stable'], timeoutMs: 800 });
    expect((send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('moving element eventually times out naming the stable state', async () => {
    const send = makeSend([
      visible({ x: 10, y: 10, w: 100, h: 30 }),
      visible({ x: 11, y: 10, w: 100, h: 30 }),
      visible({ x: 12, y: 10, w: 100, h: 30 }),
    ]);
    const err = await runActionabilityGate(send, 's1', { objectId: 'o1' }, { states: ['visible', 'stable'], timeoutMs: 120 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.context.state).toBe('stable');
    expect(err.fix).toContain('force: true');
  });

  it('disabled element → enabled failure with disabled detail', async () => {
    const send = makeSend([{ ...visible(), enabled: false }]);
    const err = await runActionabilityGate(send, 's1', { objectId: 'o1' }, { states: ['visible', 'enabled'], timeoutMs: 100 })
      .catch((e) => e);
    expect(err.context.state).toBe('enabled');
    expect(err.message).toContain('disabled');
  });

  it('readonly input → editable failure', async () => {
    const send = makeSend([{ ...visible(), editable: false }]);
    const err = await runActionabilityGate(send, 's1', { objectId: 'o1' }, { states: ['visible', 'enabled', 'editable'], timeoutMs: 100 })
      .catch((e) => e);
    expect(err.context.state).toBe('editable');
  });

  it('obscured element → hit-target failure naming the blocker tag', async () => {
    const send = makeSend([{ ...visible(), stable: true, hitOk: false, hitTag: 'div' }]);
    const err = await runActionabilityGate(send, 's1', { objectId: 'o1' }, { states: ['visible', 'stable', 'enabled'], hitCheck: true, timeoutMs: 100 })
      .catch((e) => e);
    expect(err.context.state).toBe('hit-target');
    expect(err.message).toContain('obscured by <div>');
  });

  it('hitCheck false → obscured element still passes (non-pointer action)', async () => {
    const send = makeSend([{ ...visible(), hitOk: false }]);
    await expect(
      runActionabilityGate(send, 's1', { objectId: 'o1' }, { states: ['visible', 'enabled'], timeoutMs: 300 }),
    ).resolves.toBeUndefined();
  });

  it('detached element retries until mounted (present round arrives)', async () => {
    const send = makeSend([{ present: false }, visible()]);
    await runActionabilityGate(send, 's1', { objectId: 'o1' }, { states: ['visible', 'enabled'], timeoutMs: 500 });
    expect((send as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('detached past deadline → present failure, not a crash', async () => {
    const send = makeSend([{ present: false }]);
    const err = await runActionabilityGate(send, 's1', { objectId: 'o1' }, { states: ['visible'], timeoutMs: 80 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.context.state).toBe('present');
  });
});

describe('gate escapes', () => {
  it('ActionabilityError is an ActionableError with a force hint', async () => {
    const send = makeSend([{ ...visible(), enabled: false }]);
    const err = await runActionabilityGate(send, 's1', { objectId: 'o1' }, { states: ['visible', 'enabled'], timeoutMs: 60 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.fix).toContain('force: true');
  });
});
