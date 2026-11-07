// Telemetry bus: every Gemini call, tool call, rejection and Live event goes through here.
// The strip, the Coworker ledger, the 5th telemetry cell and the export JSON all subscribe.
// No window/document access at import time.

import type { GeminiCallEntry } from '../contracts';

export type TraceKind = 'gemini' | 'tool' | 'reject' | 'live' | 'info';

export interface TraceLine {
  id: number;
  t: number; // ms since first emit
  kind: TraceKind;
  text: string;
}

export interface GeminiTotals {
  calls: number;
  errors: number;
  costUsd: number;
  promptTokens: number;
  outputTokens: number;
  thoughtTokens: number;
}

export interface Fallback {
  t: number;
  name: string;
  because: string;
}

export interface BusEvent {
  line?: TraceLine;
  entry?: GeminiCallEntry;
}

type Listener = (ev: BusEvent) => void;

const MAX_LINES = 400;
const MAX_ENTRIES = 200;

const listeners = new Set<Listener>();
const lines: TraceLine[] = [];
const entries: GeminiCallEntry[] = [];
const fallbacks: Fallback[] = [];
let nextId = 1;
let t0: number | null = null;

function now(): number {
  const n = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (t0 === null) t0 = n;
  return Math.round(n - t0);
}

export const bus = {
  /** Emit a trace line and/or a ledger entry. Returns the line (if any). */
  emit(line?: { kind: TraceKind; text: string }, entry?: GeminiCallEntry): TraceLine | undefined {
    let l: TraceLine | undefined;
    if (line) {
      l = { id: nextId++, t: now(), kind: line.kind, text: line.text };
      lines.push(l);
      if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    }
    if (entry) {
      entries.push(entry);
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    }
    const ev: BusEvent = { line: l, entry };
    for (const cb of listeners) {
      try { cb(ev); } catch (e) { console.error('bus listener', e); }
    }
    return l;
  },
  subscribe(cb: Listener): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },
  lines(): readonly TraceLine[] { return lines; },
  entries(): readonly GeminiCallEntry[] { return entries; },
  fallback(name: string, because: string): void {
    fallbacks.push({ t: now(), name, because });
    bus.emit({ kind: 'reject', text: `FALLBACK ${name} — ${because}` });
  },
  fallbacks(): readonly Fallback[] { return fallbacks; },
  totals(): GeminiTotals {
    const tot: GeminiTotals = { calls: 0, errors: 0, costUsd: 0, promptTokens: 0, outputTokens: 0, thoughtTokens: 0 };
    for (const e of entries) {
      tot.calls++;
      if (!e.ok) tot.errors++;
      tot.costUsd += e.costUsd;
      tot.promptTokens += e.promptTokens;
      tot.outputTokens += e.outputTokens;
      tot.thoughtTokens += e.thoughtTokens;
    }
    return tot;
  },
  /** Everything the export JSON needs. */
  exportPayload() {
    return { gemini: entries.slice(), geminiTotals: bus.totals(), fallbacks: fallbacks.slice(), trace: lines.slice() };
  },
  /** Test helper. */
  _reset(): void {
    lines.length = 0; entries.length = 0; fallbacks.length = 0; listeners.clear(); nextId = 1; t0 = null;
  },
};

export const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
export const fmtUsd = (usd: number): string => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}`;
export const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
