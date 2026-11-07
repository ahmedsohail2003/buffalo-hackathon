// Adapter for App.tsx (Track A): the 5th telemetry cell, strip lines and the export JSON, all from the bus.
// A wires: subscribeTraceLines(appendLog) · geminiRef.current = geminiUi() on each sync · geminiExportRef.current = geminiExport.

import { bus, type TraceKind } from './bus';
import { taskStore } from '../gemini/erLoop';
import { DEMO, ER_MODEL, FLASH_MODEL, LIVE_MODEL } from '../gemini/models';

export interface GeminiUiShape {
  calls: number;
  errors: number;
  lastLatencyMs: number | null;
  lastModel: string | null;
  lastLevel: string | null;
  lastPurpose: string | null;
  costUsd: number;
  phase: string;
  stepText: string;
}

const shortModel = (m: string) => (m === ER_MODEL ? 'ER-2' : m === FLASH_MODEL ? 'Flash' : m === LIVE_MODEL ? 'Live' : m);

/** Snapshot for the "Gemini in the loop" telemetry cell. Cheap; call at the ~8 Hz UI sync. */
export function geminiUi(): GeminiUiShape {
  const t = bus.totals();
  const entries = bus.entries();
  const last = entries.length ? entries[entries.length - 1] : null;
  const task = taskStore.get();
  const stepText = task.active
    ? `${task.phase}${task.step ? ` step ${task.step}` : ''}${task.text ? ` — "${task.text}"` : ''}`
    : task.report ? `${task.report.ok ? '✓' : '✗'} ${task.report.summary}` : '';
  return {
    calls: t.calls, errors: t.errors, costUsd: t.costUsd,
    lastLatencyMs: last ? last.latencyMs : null,
    lastModel: last ? shortModel(last.model) : null,
    lastLevel: last?.thinkingLevel ?? null,
    lastPurpose: last?.purpose ?? null,
    phase: task.active ? task.phase : task.report ? 'done' : 'idle',
    stepText,
  };
}

/** Strip lines: every bus line, in the kinds the strip already styles (gemini blue, tool teal, reject orange, live purple). */
export function subscribeTraceLines(cb: (line: { kind: Exclude<TraceKind, 'info'> | 'info'; text: string; t: number }) => void): () => void {
  return bus.subscribe((ev) => { if (ev.line) cb({ kind: ev.line.kind, text: ev.line.text, t: ev.line.t }); });
}

/** Export JSON fragment: gemini[], geminiTotals, fallbacks, demoMode, trace. */
export function geminiExport() {
  return { ...bus.exportPayload(), demoMode: { ...DEMO } };
}
