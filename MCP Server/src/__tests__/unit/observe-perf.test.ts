/**
 * WS10 — observe perf_start/perf_stop: trace insights aggregation against
 * synthetic Tracing.dataCollected fixtures (no live deps), the two state
 * contracts (double-start fail-with-state, session-death actionable loss),
 * cap/truncation semantics, and the token-capped output shape.
 *
 * Field shapes mirror the live probe evidence (batch-b2/b4-results.json):
 * LCP candidate → { args: { frame, data: { candidateIndex, isMainFrame,
 * nodeId, nodeName, size, type } }, ts }; LayoutShift → { args: { data: {
 * cumulative_score, had_recent_input, impacted_nodes } }, ts }.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolRegistry } from '../../tools/registry.js';
import { registerObserveTools } from '../../tools/observe.js';
import { scrubText } from '../../utils/scrub.js';
import {
  appendTraceChunk,
  createPerfTraceRecording,
  aggregateTraceInsights,
  TRACE_EVENT_CAP,
} from '../../utils/trace-insights.js';
import type { ServerContext, PerfTraceRecording } from '../../types.js';

function makeCtx() {
  const send = vi.fn(async () => ({}));
  const ctx = {
    sendCommand: send,
    perfTraces: new Map<string, PerfTraceRecording>(),
  } as unknown as ServerContext;
  return { ctx, send, perfTraces: ctx.perfTraces };
}
function args(over: Record<string, unknown>) { return { tabId: 't1', _sessionId: 'sess1', ...over }; }
function textOf(res: { content?: Array<{ text?: string }> }) { return res.content?.[0]?.text ?? ''; }

/** Synthetic chunk builder — resilient to field reordering, mirrors trace event JSON. */
function lcpEvent(frame: string, ts: number, data: Record<string, unknown>) {
  return { name: 'largestContentfulPaint::Candidate', ts, cat: 'loading,rail', ph: 'I', args: { frame, data } };
}
function shiftEvent(ts: number, score: number, input = false) {
  return { name: 'LayoutShift', ts, cat: 'loading,rail', ph: 'I', args: { frame: 'F1', data: { cumulative_score: score, had_recent_input: input, impacted_nodes: [] } } };
}
/** WSB: EventTiming interaction event (real shape from B5: args.data carries type/duration/processing window). */
function eventTimingEvent(ts: number, type: string, dur: number, processingStart: number, processingEnd: number, interactionId = 1) {
  return { name: 'EventTiming', ts, cat: 'devtools.timeline', ph: 'I', args: { data: { interactionId, nodeId: 7, type, duration: dur, processingStart, processingEnd } } };
}

describe('observe WS10 — perf_start / perf_stop wiring', () => {
  let registry: ToolRegistry;
  beforeEach(() => { registry = new ToolRegistry(); registerObserveTools(registry, {} as ServerContext); });

  it('schema exposes perf_start + perf_stop', () => {
    const tool = registry.list().find((t) => t.name === 'observe')!;
    const acts = tool.inputSchema.properties.action.enum as string[];
    expect(acts).toContain('perf_start');
    expect(acts).toContain('perf_stop');
    expect(acts).toContain('heap_dump');
    expect(acts).toContain('heap_summary');
    expect(acts).toHaveLength(11);
  });

  it('description documents the new operations', () => {
    const tool = registry.list().find((t) => t.name === 'observe')!;
    expect(tool.description).toContain('- perf_start: Begin recording page rendering performance');
    expect(tool.description).toContain('- perf_stop: Stop the recording started by perf_start');
  });

  it('dispatch-fail string enumerates all 11 actions (sweep second source)', async () => {
    const { ctx } = makeCtx();
    const res = await registry.dispatch('observe', args({ action: 'banana' }), ctx);
    const text = textOf(res);
    expect(text).toContain('Unknown observe action: "banana"');
    expect(text).toContain('console, network, request, performance, perf_start, perf_stop, heap_dump, heap_summary, memory, downloads, har');
  });

  it('happy path: start records, stop aggregates LCP + CLS from synthetic chunks', async () => {
    const { ctx, send, perfTraces } = makeCtx();
    // sendCommand with Tracing.end marks completed (mimics the event pipeline finishing)
    send.mockImplementation(async (method: string) => {
      if (method === 'Tracing.end') {
        const rec = perfTraces.get('sess1');
        if (rec) { rec.completed = true; rec.dataLoss = false; }
        return {};
      }
      return {};
    });
    await registry.dispatch('observe', args({ action: 'perf_start' }), ctx);
    expect(send.mock.calls.find((c) => c[0] === 'Tracing.start')).toBeTruthy();
    const started = send.mock.calls.find((c) => c[0] === 'Tracing.start')![1];
    expect(started.traceConfig.includedCategories).toEqual(['loading']);
    expect(started.traceConfig.recordMode).toBe('recordAsMuchAsPossible');
    const rec = perfTraces.get('sess1')!;
    expect(rec.url).toBeNull(); // baseline eval attempted but the mock returns no value → stays null
    appendTraceChunk(rec, [
      lcpEvent('F-aaa', 1_000_000, { nodeName: "H1 id='lcp'", size: 49619, isMainFrame: true, candidateIndex: 1 }),
      shiftEvent(1_600_000, 0.01),
      shiftEvent(1_700_000, 0.0216),
    ]);

    const res = await registry.dispatch('observe', args({ action: 'perf_stop' }), ctx);
    expect(textOf(res)).toContain('LCP');
    expect(textOf(res)).toContain("H1 id='lcp'");
    expect(textOf(res)).toContain('0.0216');
    expect(textOf(res)).toContain('trace complete');
    // no session state survives the stop (contract: discard raw events)
    expect(perfTraces.has('sess1')).toBe(false);
  });

  it('double perf_start fails with state (never silently discards a running trace)', async () => {
    const { ctx, perfTraces } = makeCtx();
    const startedAt = Date.now() - 5000;
    perfTraces.set('sess1', createPerfTraceRecording(startedAt, null));
    const res = await registry.dispatch('observe', args({ action: 'perf_start' }), ctx);
    const text = textOf(res);
    expect(text).toContain('already in progress');
    expect(text).toContain(new Date(startedAt).toLocaleTimeString()); // clock echo of the ORIGINAL start
    expect(perfTraces.get('sess1')!.startedAt).toBe(startedAt); // original entry untouched
  });

  it('session death between start and stop: perf_stop reports the recording LOST, actionable + prunes', async () => {
    const { ctx, send, perfTraces } = makeCtx();
    const rec = createPerfTraceRecording(Date.now(), null);
    perfTraces.set('sess1', rec);
    appendTraceChunk(rec, [lcpEvent('F', 1000, { size: 1 })]);
    send.mockRejectedValueOnce(new Error('Session with given id not found'));
    const res = await registry.dispatch('observe', args({ action: 'perf_stop' }), ctx);
    const text = textOf(res);
    expect(text).toContain('recording lost');
    expect(text).toContain('observe perf_start');
    expect(perfTraces.has('sess1')).toBe(false);
  });

  it('perf_start categories override: JS-appends v8 to the default set; anything else fails actionably', async () => {
    const { ctx, send, perfTraces } = makeCtx();
    await registry.dispatch('observe', args({ action: 'perf_start', categories: ['v8'] }), ctx);
    const rule = send.mock.calls.find((c) => c[0] === 'Tracing.start')[1];
    expect(rule.traceConfig.includedCategories).toEqual(['loading', 'v8', 'devtools.timeline']);

    const bad = await registry.dispatch('observe', args({ action: 'perf_start', categories: ['banana'] }), ctx);
    perfTraces.clear(); // drop the running recording so the guard doesn't shadow the validation error
    const bad2 = await registry.dispatch('observe', args({ action: 'perf_start', categories: ['banana'] }), ctx);
    expect(textOf(bad2)).toContain("Only 'v8' is accepted");
    expect(send.mock.calls.filter((c) => c[0] === 'Tracing.start')).toHaveLength(1); // no second start emitted
  });

  it('perf_start with v8 records the escalation and advertises interaction capture', async () => {
    const { ctx, perfTraces } = makeCtx();
    const res = await registry.dispatch('observe', args({ action: 'perf_start', categories: ['v8'] }), ctx);
    expect(perfTraces.get('sess1')!.escalated).toBe(true);
    expect(textOf(res)).toContain('Interact with the page');
    expect(textOf(res)).toContain('interaction latency');
  });

  it('perf_stop surfaces interaction insights end-to-end when EventTiming was captured', async () => {
    const { ctx, send, perfTraces } = makeCtx();
    send.mockImplementation(async (method: string) => {
      if (method === 'Tracing.end') {
        const rec = perfTraces.get('sess1');
        if (rec) rec.completed = true;
      }
      return {};
    });
    await registry.dispatch('observe', args({ action: 'perf_start', categories: ['v8'] }), ctx);
    appendTraceChunk(perfTraces.get('sess1')!, [eventTimingEvent(500_000, 'keydown', 144.4, 10, 154.4)]);
    const res = await registry.dispatch('observe', args({ action: 'perf_stop' }), ctx);
    expect(textOf(res)).toContain('Interaction latency');
    expect(textOf(res)).toContain('keydown — dur 144.4ms');
  });

  it('perf_stop without perf_start gives the established actionable error', async () => {
    const { ctx } = makeCtx();
    const res = await registry.dispatch('observe', args({ action: 'perf_stop' }), ctx);
    expect(textOf(res)).toContain('No performance recording active');
    expect(textOf(res)).toContain('perf_start');
  });

  it('dataLoss flag surfaces in the header when the trace overflowed', () => {
    const out = aggregateTraceInsights(
      [lcpEvent('F', 1000, { size: 1 })],
      { url: null, startedAt: 0, stoppedAt: 1000, dataLoss: true, truncated: false, completed: true },
    ).output;
    expect(out).toContain('dataLossOccurred');
  });

  it('truncation note surfaces when the 50k event cap was hit mid-recording', () => {
    const out = aggregateTraceInsights(
      [lcpEvent('F', 1000, { size: 1 })],
      { url: 'http://x', startedAt: 0, stoppedAt: 2000, dataLoss: false, truncated: true, completed: true },
    ).output;
    expect(out).toContain('event cap 50000 reached');
    expect(out).toContain('http://x');
  });

  it('single-event CLS reports the score as the worst step (no delta possible)', () => {
    const out = aggregateTraceInsights(
      [lcpEvent('F', 1_000_000, { nodeName: 'DIV', size: 10 }), shiftEvent(1_100_000, 0.09)],
      { url: null, startedAt: 0, stoppedAt: 3000, dataLoss: false, truncated: false, completed: true },
    ).output;
    expect(out).toContain('final 0.0900');
    expect(out).toContain('worst single step ≈ 0.0900');
  });
});

describe('trace-insights — aggregation semantics (fixtures from the probe evidence)', () => {
  const opts = { url: 'http://localhost:8877/slow-rig.html', startedAt: 0, stoppedAt: 6000, dataLoss: false, truncated: false, completed: true };

  it('keeps only the LAST LCP candidate per frame (ms from trace start)', () => {
    const events = [
      lcpEvent('F-aaa', 500_000, { nodeName: 'H1 id=lcp', size: 49619 }),
      lcpEvent('F-aaa', 2_000_000, { nodeName: 'IMG hero', size: 200000 }), // newer wins
      lcpEvent('F-bbb', 1_200_000, { nodeName: 'P body', size: 4096 }),     // second frame kept
    ];
    const ins = aggregateTraceInsights(events, opts);
    expect(ins.lcpCandidates).toBe(2);
    expect(ins.output).toContain('IMG hero');
    expect(ins.output).toContain('P body');
    expect(ins.output).not.toContain('H1 id=lcp');
    expect(ins.output).toContain('1500ms'); // relative ms from trace start (ts − min ts of the recording)
  });

  it('input-attributed shifts are EXCLUDED from the CLS count and final score', () => {
    const events = [
      shiftEvent(100_000, 0.01),
      shiftEvent(200_000, 0.05, true), // had_recent_input — excluded
      shiftEvent(300_000, 0.13),
    ];
    const out = aggregateTraceInsights(events, opts).output;
    expect(out).toContain('final 0.1300');
    expect(out).toContain('over 2 non-input shift(s)');
    expect(out).toContain('worst single step ≈ 0.1200'); // 0.13 - 0.01 across the excluded one
  });

  it('a recording with ONLY input-attributed shifts says so instead of emitting a zero score', () => {
    const events = [shiftEvent(100_000, 0.04, true), shiftEvent(200_000, 0.06, true)];
    const out = aggregateTraceInsights(events, opts).output;
    expect(out).toContain('all input-attributed (excluded)');
    expect(out).not.toContain('final 0.0000');
  });

  it('malformed chunks are tolerated: non-array values, nameless events, missing args', () => {
    const rec = createPerfTraceRecording(0, null);
    appendTraceChunk(rec, null); // not an array
    appendTraceChunk(rec, 'nope');
    appendTraceChunk(rec, [{ noName: true }, lcpEvent('F', 100, {})]);
    expect(rec.events).toHaveLength(2); // stored raw; filtering happens at aggregation
    const ins = aggregateTraceInsights(rec.events, { ...opts, url: null });
    expect(ins.lcpCandidates).toBe(1);
    expect(ins.output).toContain('<unknown>');
  });

  it('event cap: append stops at 50k, marks truncated, and drops overflow', () => {
    const rec = createPerfTraceRecording(0, null);
    const bigChunk = Array.from({ length: TRACE_EVENT_CAP }, (_, i) => ({ name: 'Misc', ts: i }));
    appendTraceChunk(rec, bigChunk);
    appendTraceChunk(rec, [{ name: 'Overflow' }]);
    expect(rec.events).toHaveLength(TRACE_EVENT_CAP);
    expect(rec.truncated).toBe(true);
  });
});

describe('WSB — EventTiming / INP interaction insights', () => {
  const base = { url: null, startedAt: 0, stoppedAt: 5000, dataLoss: false, truncated: false, completed: true };

  it('renders the top 3 interactions by duration with processing windows', () => {
    const ins = aggregateTraceInsights([
      eventTimingEvent(1000, 'keydown', 120.5, 10, 130.5),
      eventTimingEvent(2000, 'pointerdown', 300.2, 20, 320.2),
      eventTimingEvent(3000, 'click', 40, 5, 45),
      eventTimingEvent(4000, 'keydown', 200, 8, 208),
    ], { ...base, v8Category: true });
    expect(ins.eventTimingCount).toBe(4);
    expect(ins.output).toContain('Interaction latency — EventTiming top 3 of 4');
    const lines = ins.output.split('\n').filter((l) => l.startsWith('- ') && / dur /.test(l));
    expect(lines[0]).toContain('pointerdown — dur 300.2ms');
    expect(lines[1]).toContain('keydown — dur 200.0ms');
    expect(lines[2]).toContain('keydown — dur 120.5ms');
    expect(lines[0]).toContain('processing 20.0–320.2ms');
  });

  it('v8 on but no interactions → honest input-gated guidance', () => {
    const out = aggregateTraceInsights([shiftEvent(1000, 0.01)], { ...base, v8Category: true }).output;
    expect(out).toContain('v8 category was on but no EventTiming events');
    expect(out).toContain('interact with the page');
  });

  it('v8 off → states the required escalation + real input', () => {
    const out = aggregateTraceInsights([shiftEvent(1000, 0.01)], { ...base, v8Category: false }).output;
    expect(out).toContain("requires categories: ['v8'] and real input");
  });

  it('malformed EventTiming events (no dur) are ignored and count as absent', () => {
    const ins = aggregateTraceInsights(
      [{ name: 'EventTiming', ts: 1, args: { data: { type: 'keydown' } } }],
      { ...base, v8Category: true },
    );
    expect(ins.eventTimingCount).toBe(0);
    expect(ins.output).toContain('no EventTiming events');
  });
});

describe('WS10 scrubber decision pin — perf output is DEFAULT-SCRUBBED (no opt-out)', () => {
  it('a trace-derived URL carrying token=X comes out masked', () => {
    const line = 'recording: https://page.example/dashboard?token=secret123#/app';
    expect(scrubText(line)).toBe('recording: https://page.example/dashboard?token=***#/app');
  });
  it('structured LCP attribution fields under secret-bearing keys are masked', () => {
    expect(scrubText('{"nodeName":"IMG","size":10,"auth":"bearer1"}')).toBe('{"nodeName":"IMG","size":10,"auth":"***"}');
  });
});
