/**
 * Trace insights aggregation (5.4 WS10).
 *
 * Aggregates raw Tracing.dataCollected events into a token-capped insight
 * set for `observe perf_stop`. Parse-once-at-stop design, locked by the
 * WS10 PROBE RESULT: the shipping category set is the single string
 * `'loading'`, so trace volume is tiny (worst observed 5.5k events vs the
 * 50k cap) and the two proven insight classes are LCP and CLS only.
 *
 * Dead-on-arrival classes (LongTask, EventTiming/INP) are deliberately
 * NOT aggregated — both are KILL verdicts from the batch-b3/b4 probe:
 * LongTask events never surfaced on any category set (page-side ground
 * truth proved the busy tasks ran), and EventTiming is input-dependent.
 *
 * Field shapes proven live (b2/b4): LCP candidate carries
 * {candidateIndex, isMainFrame, nodeId, nodeName, size, type} under
 * args.data with an args.frame key; LayoutShift carries
 * {cumulative_score, had_recent_input, frame_max_distance,
 * impacted_nodes[{node_id, old_rect, new_rect}]}.
 *
 * 5.5 WSB: EventTiming is now a SHIPPED insight class (retry-GO in 5.4).
 * It only surfaces when the `v8` category escalation is on AND real input
 * occurs during the window (B1 `['devtools.timeline']` → ×0; B3/B5 with
 * `['v8']` → ×32/×14). Output states the requirement honestly when absent.
 */

import type { TempStreamWriter } from './temp-files.js';

/** Hard cap on raw trace events retained per recording (plan: never OOM). */
export const TRACE_EVENT_CAP = 50_000;

/** Raw-trace dump size cap (5.5 WSC keepRaw). */
export const RAW_TRACE_MAX_BYTES = 50 * 1024 * 1024;

/** Recording-side state mutated by the event pipeline (synchronous append). */
export interface PerfTraceRecording {
  startedAt: number;
  /** Best-effort page URL captured at start; null when evaluation failed. */
  url: string | null;
  /** Raw trace events, append-only, capped at TRACE_EVENT_CAP. */
  events: Array<Record<string, unknown>>;
  /** Set by Tracing.tracingComplete (event pipeline). */
  completed: boolean;
  /** Set by Tracing.tracingComplete (event pipeline). */
  dataLoss: boolean;
  /** Set by the event pipeline when the cap truncates further accumulation. */
  truncated: boolean;
  /** True between Tracing.end and aggregation completion. */
  stopping: boolean;
  /** Diagnostics (honest-output contract): chunk arrival stats. */
  chunkCount: number;
  maxChunkEvents: number;
  /** First few distinct event names seen, for zero-insight diagnoses. */
  sampleNames: string[];
  /** True when perf_start escalated categories to include 'v8' (EventTiming gate). */
  escalated: boolean;
  /** 5.5 WSC keepRaw: streaming raw-event writer (jsonl), or null. */
  rawWriter: TempStreamWriter | null;
  /** Final path advertised by perf_stop once the raw dump is finalized. */
  rawPath: string | null;
  /** Set when the raw writer hit its cap or errored (partial orphan remains). */
  rawError: string | null;
}

export function createPerfTraceRecording(
  startedAt: number,
  url: string | null,
  escalated = false,
): PerfTraceRecording {
  return {
    startedAt,
    url,
    events: [],
    completed: false,
    dataLoss: false,
    truncated: false,
    stopping: false,
    chunkCount: 0,
    maxChunkEvents: 0,
    sampleNames: [],
    escalated,
    rawWriter: null,
    rawPath: null,
    rawError: null,
  };
}

/**
 * Append one Tracing.dataCollected payload to a recording. Synchronous in
 * the event-dispatch path (the append-discipline contract: chunk k is fully
 * appended before k+1 arrives — no async hops). Tolerates malformed
 * payloads (non-array `value` is ignored, never throws). The cap truncates
 * the OVERFLOW and sets `truncated` — newest events beyond the cap are
 * dropped, the note surfaces in the perf_stop output.
 */
export function appendTraceChunk(
  rec: PerfTraceRecording,
  value: unknown,
): void {
  rec.chunkCount++;
  if (!Array.isArray(value)) return;
  rec.maxChunkEvents = Math.max(rec.maxChunkEvents, value.length);
  for (const e of value) {
    if (rec.events.length >= TRACE_EVENT_CAP) {
      rec.truncated = true;
      return;
    }
    rec.events.push(e);
    if (rec.sampleNames.length < 8) {
      const name = (e as { name?: unknown })?.name;
      if (typeof name === 'string' && !rec.sampleNames.includes(name)) rec.sampleNames.push(name);
    }
  }
}

// ─── Raw-trace dump (5.5 WSC keepRaw) ───────────────────────────────

/**
 * Append one `dataCollected` chunk verbatim as JSONL to the raw dump (only
 * when perf_start keepRaw created a writer). Cap overrun abandons the writer
 * and records an actionable `rawError`; the `.partial` orphan stays on disk.
 */
export function appendRawTraceChunk(rec: PerfTraceRecording, value: unknown): void {
  if (!rec.rawWriter || !Array.isArray(value)) return;
  try {
    let buf = '';
    for (const e of value) buf += JSON.stringify(e) + '\n';
    rec.rawWriter.write(buf);
  } catch (err) {
    rec.rawError = (err as Error).message;
    try { rec.rawWriter.abandon(); } catch { /* ok */ }
    rec.rawWriter = null;
  }
}

/** Finalize the raw dump (rename .partial → final) and return its path. */
export function finalizeRawTrace(rec: PerfTraceRecording): string | null {
  if (!rec.rawWriter) return null;
  try {
    rec.rawPath = rec.rawWriter.finalize();
  } catch (err) {
    rec.rawError = (err as Error).message;
    try { rec.rawWriter.abandon(); } catch { /* ok */ }
  }
  rec.rawWriter = null;
  return rec.rawPath;
}

/** Close the raw writer WITHOUT finalizing (session death / errors). */
export function abandonRawTrace(rec: PerfTraceRecording): void {
  if (!rec.rawWriter) return;
  try { rec.rawWriter.abandon(); } catch { /* ok */ }
  rec.rawWriter = null;
}

interface TraceEvent {
  name: string;
  ts?: number;
  frame?: string;
  data?: Record<string, unknown>;
}

function toEvent(e: unknown): TraceEvent | null {
  if (!e || typeof e !== 'object') return null;
  const o = e as Record<string, unknown>;
  if (typeof o.name !== 'string') return null;
  const args = (o.args && typeof o.args === 'object' ? o.args : undefined) as
    | { frame?: string; data?: Record<string, unknown> }
    | undefined;
  return {
    name: o.name,
    ts: typeof o.ts === 'number' ? o.ts : undefined,
    frame: typeof args?.frame === 'string' ? args.frame : undefined,
    data: args?.data && typeof args.data === 'object' ? args.data : undefined,
  };
}

export interface TraceInsightOptions {
  url: string | null;
  startedAt: number;
  stoppedAt: number;
  dataLoss: boolean;
  truncated: boolean;
  completed: boolean;
  /** Recording diagnostics (honest-output contract): append stats from the pipeline. */
  chunkCount?: number;
  maxChunkEvents?: number;
  sampleNames?: string[];
  /** True when the recording ran with the `v8` category escalation on. */
  v8Category?: boolean;
}

export interface TraceInsights {
  /** ≤ ~40 lines of text, token-capped (plan contract). */
  output: string;
  lcpCandidates: number;
  shiftCount: number;
  /** 5.5 WSB: number of EventTiming interaction events aggregated. */
  eventTimingCount: number;
}

/**
 * Aggregate raw trace events into the token-capped insight output.
 *
 * ACQUISITION-HONEST semantics for CLS: trace LayoutShift events carry the
 * browser's CUMULATIVE session score at each shift, not per-shift deltas —
 * summing cumulatives double-counts. The insight reports the final
 * cumulative score among input-excluded shifts (page-side parity: the rig's
 * clsTotal reads the latest cumulative value) and the largest single step
 * observed (delta between consecutive scores) — labelled as an
 * approximation in the output.
 */
export function aggregateTraceInsights(
  events: Array<unknown>,
  opts: TraceInsightOptions,
): TraceInsights {
  const parsed = events.map(toEvent).filter(
    (e): e is TraceEvent => e !== null && (e.name === 'largestContentfulPaint::Candidate' || e.name === 'LayoutShift' || e.name === 'EventTiming'),
  );

  const t0Min = parsed.reduce<number | null>(
    (min, e) => (e.ts !== undefined && (min === null || e.ts < min) ? e.ts : min),
    null,
  );
  const rel = (ts: number | undefined): string =>
    ts !== undefined && t0Min !== null ? `${((ts - t0Min) / 1000).toFixed(0)}` : '?';

  // ── LCP: last candidate per frame ──
  const lastPerFrame = new Map<string, TraceEvent>();
  for (const e of parsed) {
    if (e.name !== 'largestContentfulPaint::Candidate') continue;
    const key = e.frame ?? '(unknown frame)';
    lastPerFrame.set(key, e);
  }

  // ── CLS: final cumulative + worst step, input shifts excluded ──
  const clsEvents = parsed
    .filter((e) => e.name === 'LayoutShift')
    .map((e) => ({ e, score: typeof e.data?.cumulative_score === 'number' ? (e.data.cumulative_score as number) : null, input: e.data?.had_recent_input === true }));
  const counted = clsEvents.filter((s) => !s.input && s.score !== null);
  let clsFinal: number | null = null;
  for (const s of counted) clsFinal = s.score;
  let clsWorst = 0;
  for (let i = 1; i < counted.length; i++) {
    const prev = counted[i - 1].score as number;
    const cur = counted[i].score as number;
    clsWorst = Math.max(clsWorst, cur - prev);
  }
  if (counted.length === 1) clsWorst = counted[0].score as number;

  // ── WSB: EventTiming interactions (input-dependent, v8-gated) ──
  interface Interaction {
    type: string;
    dur: number;
    processingStart: number | null;
    processingEnd: number | null;
    ts?: number;
  }
  const interactions: Interaction[] = [];
  for (const e of parsed) {
    if (e.name !== 'EventTiming') continue;
    const d = e.data ?? {};
    const dur = typeof d.duration === 'number' ? d.duration : (typeof d.dur === 'number' ? d.dur : null);
    if (dur === null || dur <= 0) continue;
    interactions.push({
      type: typeof d.type === 'string' ? d.type : '(unknown)',
      dur,
      processingStart: typeof d.processingStart === 'number' ? d.processingStart : null,
      processingEnd: typeof d.processingEnd === 'number' ? d.processingEnd : null,
      ts: e.ts,
    });
  }
  const topInteractions = [...interactions].sort((a, b) => b.dur - a.dur).slice(0, 3);

  const lines: string[] = [];
  const durSec = (opts.stoppedAt - opts.startedAt) / 1000;
  const status: string[] = [];
  if (!opts.completed && opts.stoppedAt > opts.startedAt && !opts.dataLoss) {
    status.push('trace NOT confirmed complete (timeout) — insights may be partial');
  }
  if (opts.dataLoss) status.push('dataLossOccurred — trace buffer overflowed, data was lost');
  if (opts.truncated) status.push(`event cap ${TRACE_EVENT_CAP} reached — later events dropped`);

  lines.push(`Performance insights (${status.length ? status.join('; ') : 'trace complete'}):`);
  if (opts.url) lines.push(`recording: ${opts.url}`);
  lines.push(`duration: ${durSec.toFixed(1)}s | chunks: ${opts.chunkCount ?? '?'} (max ${opts.maxChunkEvents ?? '?'} events) | LCP/CLS/EventTiming-class events: ${parsed.length}`);
  if (parsed.length === 0 && (opts.sampleNames?.length ?? 0) > 0) {
    lines.push(`zero LCP/CLS/EventTiming events among the trace — names seen: ${opts.sampleNames!.slice(0, 6).join(', ')}`);
  } else if (parsed.length === 0) {
    lines.push('zero trace chunks reached the recording — the trace datasource produced nothing (session or build limitation).');
  }

  // LCP section
  lines.push('');
  if (lastPerFrame.size > 0) {
    lines.push(`LCP — last candidate per frame (${relUnit()}):`);
    for (const [frame, e] of [...lastPerFrame.entries()].slice(0, 6)) {
      const d = e.data ?? {};
      lines.push(`- ${frameShort(frame)}: ${rel(e.ts)}ms — ${nodeNameHint(d)} — size ${typeof d.size === 'number' ? `${d.size}B` : '?'}`);
    }
  } else {
    lines.push('LCP: no candidates captured — the page may not have painted, or the browser emitted the perf events outside this trace window (paint/metric emission to the trace is nondeterministic between runs on some browsers — a zero-class stop can succeed on a retry).');
  }

  // CLS section
  lines.push('');
  if (counted.length > 0 || clsEvents.length > 0) {
    lines.push(`CLS — final cumulative, input shifts excluded (approx):`);
    if (clsFinal !== null) {
      lines.push(`- final ${clsFinal.toFixed(4)} over ${counted.length} non-input shift(s), worst single step ≈ ${clsWorst.toFixed(4)}`);
    } else if (clsEvents.length > 0) {
      lines.push(`- ${clsEvents.length} shift(s) recorded, all input-attributed (excluded)`);
    }
  } else {
    lines.push('CLS: no layout shifts captured — the emission caveat mirrors LCP (nondeterministic between runs; a zero-class stop can succeed on a retry).');
  }

  // WSB: interaction latency (INP inputs) — input-dependent, v8-gated
  lines.push('');
  if (interactions.length > 0) {
    lines.push(`Interaction latency — EventTiming top ${topInteractions.length} of ${interactions.length} by duration (INP inputs):`);
    for (const it of topInteractions) {
      const window = it.processingStart !== null && it.processingEnd !== null
        ? `, processing ${it.processingStart.toFixed(1)}–${it.processingEnd.toFixed(1)}ms`
        : '';
      lines.push(`- ${it.type} — dur ${it.dur.toFixed(1)}ms${window}`);
    }
  } else if (opts.v8Category) {
    lines.push('Interaction insights: v8 category was on but no EventTiming events were captured — interact with the page (click or keypress) during the recording to capture INP inputs.');
  } else {
    lines.push("Interaction insights: requires categories: ['v8'] and real input — restart with perf_start categories: ['v8'] and interact during the recording.");
  }

  return {
    output: lines.join('\n'),
    lcpCandidates: lastPerFrame.size,
    shiftCount: clsEvents.length,
    eventTimingCount: interactions.length,
  };
}

function relUnit(): string {
  return 'ms from trace start';
}

function frameShort(frame: string): string {
  return frame.length > 12 ? `${frame.slice(0, 8)}…` : frame;
}

function nodeNameHint(data: Record<string, unknown>): string {
  const name = typeof data.nodeName === 'string' ? data.nodeName : '';
  const type = typeof data.type === 'string' ? data.type : '';
  const hint = name || (type ? `<${type}>` : '<unknown>');
  return hint.length > 60 ? `${hint.slice(0, 57)}…` : hint;
}
