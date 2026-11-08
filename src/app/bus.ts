// The app bus: the mission log, the Gemini ledger and a small typed event channel.
// Module-level state, safe to import from any layer (no DOM, no React).
import type { ErPointEvent, GeminiCallEntry, LogLine } from '../contracts';

export type LogKind = LogLine['kind'];

/** Named events with a known payload. Other names are allowed and carry `unknown`. */
export interface BusEvents {
  log: LogLine;
  gemini: GeminiCallEntry;
  /** a point_at result: the bay-camera inset and the deck marker draw it */
  'er:point': ErPointEvent;
}

export type BusEventName = keyof BusEvents | (string & {});
export type BusPayload<K> = K extends keyof BusEvents ? BusEvents[K] : unknown;

export const MAX_LOG_LINES = 400;
export const MAX_LEDGER_ENTRIES = 500;

let lines: readonly LogLine[] = [];
let calls: readonly GeminiCallEntry[] = [];
const listeners = new Map<string, Set<(payload: unknown) => void>>();

/** Listen to one event. Returns the unsubscribe function. */
export function subscribe<K extends BusEventName>(type: K, cb: (payload: BusPayload<K>) => void): () => void {
  let set = listeners.get(type);
  if (!set) {
    set = new Set();
    listeners.set(type, set);
  }
  const fn = cb as (payload: unknown) => void;
  set.add(fn);
  return () => {
    set.delete(fn);
  };
}

/** Publish one event. A listener that throws is reported and does not stop the others. */
export function emit<K extends BusEventName>(type: K, payload: BusPayload<K>): void {
  const set = listeners.get(type);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[bus] listener for "${type}" failed`, err);
    }
  }
}

// ---- Mission log ----------------------------------------------------------------------------

/** Append a line to the mission log (t defaults to Date.now()). */
export function log(kind: LogKind, text: string, t: number = Date.now()): LogLine {
  const line: LogLine = { t, kind, text };
  const next = lines.length >= MAX_LOG_LINES ? lines.slice(lines.length - MAX_LOG_LINES + 1) : lines.slice();
  next.push(line);
  lines = next;
  emit('log', line);
  return line;
}

/** The log, oldest first. The array is replaced (never mutated) on each new line. */
export function getLog(): readonly LogLine[] {
  return lines;
}

export function onLog(cb: (line: LogLine) => void): () => void {
  return subscribe('log', cb);
}

// ---- Gemini ledger --------------------------------------------------------------------------

/** Record one Gemini call (the Gemini client calls this once per request). */
export function recordGeminiCall(entry: GeminiCallEntry): void {
  const next = calls.length >= MAX_LEDGER_ENTRIES ? calls.slice(calls.length - MAX_LEDGER_ENTRIES + 1) : calls.slice();
  next.push(entry);
  calls = next;
  emit('gemini', entry);
}

/** The ledger, oldest first. The array is replaced (never mutated) on each new entry. */
export function getLedger(): readonly GeminiCallEntry[] {
  return calls;
}

export function onLedger(cb: (entry: GeminiCallEntry) => void): () => void {
  return subscribe('gemini', cb);
}

export interface LedgerSummary {
  calls: number;
  failed: number;
  lastLatencyMs: number | null;
  lastModel: string | null;
  totalUsd: number;
  promptTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  byPurpose: Partial<Record<GeminiCallEntry['purpose'], number>>;
}

export function ledgerSummary(entries: readonly GeminiCallEntry[] = calls): LedgerSummary {
  const s: LedgerSummary = {
    calls: entries.length,
    failed: 0,
    lastLatencyMs: null,
    lastModel: null,
    totalUsd: 0,
    promptTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    byPurpose: {},
  };
  for (const e of entries) {
    if (!e.ok) s.failed += 1;
    s.totalUsd += Number.isFinite(e.costUsd) ? e.costUsd : 0;
    s.promptTokens += e.promptTokens || 0;
    s.outputTokens += e.outputTokens || 0;
    s.thoughtTokens += e.thoughtTokens || 0;
    s.byPurpose[e.purpose] = (s.byPurpose[e.purpose] ?? 0) + 1;
  }
  const last = entries[entries.length - 1];
  if (last) {
    s.lastLatencyMs = last.latencyMs;
    s.lastModel = last.model;
  }
  return s;
}

// ---- Camera results -------------------------------------------------------------------------

/** Publish one camera result: a point_at as 'er:point'. */
export function emitEr(ev: ErPointEvent): void {
  emit('er:point', ev);
}

// ---- Export ---------------------------------------------------------------------------------

/** The log and the ledger as pretty JSON, for the "Export" button and for judges. */
export function exportJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      ...extra,
      ledgerSummary: ledgerSummary(),
      log: lines,
      ledger: calls,
    },
    null,
    2,
  );
}

/** Tests only: forget every line, entry and listener. */
export function resetBus(): void {
  lines = [];
  calls = [];
  listeners.clear();
}
