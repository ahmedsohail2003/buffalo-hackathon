// Small local interfaces the integrator wires to the app bus, the egress counter and the
// fabricator. Types plus a few tiny helpers; no DOM.
import type { BayApi, ErPointEvent, GeminiCallEntry, LogLine, Placement, Sample } from '../contracts';

/** One outbound payload, for the "what leaves this machine" counter. */
export interface EgressNote {
  dest: string;
  kind: 'image' | 'text' | 'audio';
  bytes: number;
  note?: string;
}

/**
 * Where this layer writes. Wire to src/app/bus.ts:
 * `{ log: (l) => bus.log(l.kind, l.text, l.t), ledger: bus.recordGeminiCall, egress: recordEgress }`.
 */
export interface LogSink {
  log(line: LogLine): void;
  ledger(entry: GeminiCallEntry): void;
  egress?(rec: EgressNote): void;
  /** One event per point_at result, for the viewer overlays (wire to bus.emitEr). */
  er?(ev: ErPointEvent): void;
}

/** A subscription to mission-log lines, for example `bus.onLog`. Returns the unsubscribe function. */
export type LogSource = (cb: (line: LogLine) => void) => () => void;

export type FabricateResult =
  | { ok: true; sample: Sample; say: string }
  | { ok: false; code: string; reason: string; suggestion?: string };

/** What the fabricator needs from this layer: the fast model with a JSON schema (client.ts generateJson). */
export interface FabricatorDeps {
  generateJson: (a: { system: string; prompt: string; schema: object; signal?: AbortSignal }) => Promise<{ text: string; latencyMs: number }>;
}

/**
 * The fabricator's entry point, `designAndFabricate` in src/fabricator: design, build, measure,
 * then scale to fit or refuse.
 */
export type FabricateFn = (
  bay: BayApi,
  description: string,
  placement: Placement | undefined,
  deps: FabricatorDeps,
  signal?: AbortSignal,
) => Promise<FabricateResult>;

export const nullSink: LogSink = {
  log() {},
  ledger() {},
};

export function logTo(sink: LogSink | null | undefined, kind: LogLine['kind'], text: string): void {
  if (!sink) return;
  try {
    sink.log({ t: Date.now(), kind, text });
  } catch {
    // a broken sink must never break a tool call
  }
}

export function erTo(sink: LogSink | null | undefined, ev: ErPointEvent): void {
  if (!sink?.er) return;
  try {
    sink.er(ev);
  } catch {
    // a broken overlay must never break a tool call
  }
}
