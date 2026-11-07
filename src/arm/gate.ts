// Cell safety gate (PLAN.md §1.5). Gestures and the e-stop panel own the cell
// state; this gate only reads it and lets arm tasks wait on it.
//
//   RUNNING/SLOW → resolve
//   IDLE         → auto CYCLE_START (logged) and resolve
//   STOPPED      → PAUSED line, wait for a state change (fed by notify()), then RESUMED
//   ESTOPPED     → reject {ok:false, code:'REJECTED_STATE', state:'ESTOPPED'}
//
// App calls notify() after every cell.apply() and after the e-stop reset so waiters wake.

import type { CellGateApi, CellState, PrimResult } from '../contracts';
import type { CobotCell } from '../cell/cellSim';

export type GateLine = { kind: 'cell' | 'reject'; text: string };

export interface GateEvents {
  /** telemetry sink for TASK START / PAUSED / RESUMED lines */
  onLine?: (line: GateLine) => void;
  /** spoken [CELL EVENT] pushes (Track B subscribes) */
  onEvent?: (ev: 'paused' | 'resumed' | 'estopped') => void;
}

export const REJECT_STOPPED: PrimResult = {
  ok: false,
  code: 'REJECTED_STATE',
  reason: 'the cell is STOPPED by the operator; motion is locked until a thumbs-up resumes it',
  state: 'STOPPED',
};

export function rejectEstopped(): PrimResult {
  return {
    ok: false,
    code: 'REJECTED_STATE',
    reason: 'the cell is in EMERGENCY STOP; it needs the two-step reset on the panel before anything moves',
    state: 'ESTOPPED',
  };
}

export class CellGate implements CellGateApi {
  private listeners = new Set<(s: CellState) => void>();
  private last: CellState;

  constructor(private readonly getCell: () => CobotCell, private events: GateEvents = {}) {
    this.last = this.state();
  }

  setEvents(events: GateEvents): void {
    this.events = events;
  }

  state(): CellState {
    return this.getCell().state;
  }

  /** Whether a NEW motion tool call may be accepted right now (§1.5). */
  acceptsTasks(): boolean {
    const s = this.state();
    return s === 'IDLE' || s === 'RUNNING' || s === 'SLOW';
  }

  /** Rejection for a new motion tool call in the current state, or null if accepted. */
  rejectNewCall(): PrimResult | null {
    const s = this.state();
    if (s === 'STOPPED') return REJECT_STOPPED;
    if (s === 'ESTOPPED') return rejectEstopped();
    return null;
  }

  /** Call after any cell.apply()/reset so waiters and subscribers see the new state. */
  notify(): void {
    const s = this.state();
    if (s === this.last) return;
    this.last = s;
    for (const cb of [...this.listeners]) cb(s);
  }

  onChange(cb: (s: CellState) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  async waitRunnable(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw abortedResult(String(signal.reason ?? 'aborted'));
      const s = this.state();
      if (s === 'RUNNING' || s === 'SLOW') return;
      if (s === 'IDLE') {
        this.getCell().apply('CYCLE_START');
        this.events.onLine?.({ kind: 'cell', text: 'TASK START — auto CYCLE START' });
        this.notify();
        return;
      }
      if (s === 'ESTOPPED') throw rejectEstopped();
      // STOPPED: wait for a change
      this.events.onLine?.({ kind: 'cell', text: 'PAUSED: cell STOPPED — waiting for thumbs-up' });
      this.events.onEvent?.('paused');
      const next = await this.nextChange(signal);
      if (next === 'RUNNING' || next === 'SLOW') {
        this.events.onLine?.({ kind: 'cell', text: 'RESUMED' });
        this.events.onEvent?.('resumed');
        return;
      }
      // ESTOPPED or IDLE (after reset): loop handles it
    }
  }

  private nextChange(signal?: AbortSignal): Promise<CellState> {
    return new Promise<CellState>((resolve, reject) => {
      const off = this.onChange((s) => {
        off();
        signal?.removeEventListener('abort', onAbort);
        resolve(s);
      });
      const onAbort = () => {
        off();
        reject(abortedResult(String(signal?.reason ?? 'aborted')));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

export function abortedResult(reason: string): PrimResult {
  return { ok: false, code: 'ABORTED', reason };
}

export function isPrimResult(e: unknown): e is PrimResult {
  return !!e && typeof e === 'object' && 'ok' in e && (e as { ok: unknown }).ok === false && 'code' in e;
}
