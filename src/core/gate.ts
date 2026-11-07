// Bay safety gate: the operator's state machine. AI can only read it and wait on it.
//
//   IDLE --CYCLE_START--> RUNNING --SLOW--> SLOW --RESUME--> RUNNING
//   RUNNING / SLOW --STOP--> STOPPED --RESUME--> (whichever it was stopped from)
//   any --ESTOP--> ESTOPPED --RESET_ARM, then RESET_CONFIRM--> IDLE   (two steps, panel only)
// speedFactor: RUNNING 1, SLOW 0.5, otherwise 0.

import type { BayState, GateApi } from '../contracts';

export type GateCommand = 'CYCLE_START' | 'STOP' | 'RESUME' | 'SLOW' | 'ESTOP' | 'RESET_ARM' | 'RESET_CONFIRM';
export const GATE_COMMANDS: readonly GateCommand[] = ['CYCLE_START', 'STOP', 'RESUME', 'SLOW', 'ESTOP', 'RESET_ARM', 'RESET_CONFIRM'];

export type GateLog = (text: string, kind: 'safety' | 'info') => void;

export interface GateApplyResult {
  ok: boolean;
  state: BayState;
  /** speakable note: what happened, or why the command did nothing */
  note: string;
}

export class GateError extends Error {
  constructor(
    readonly code: 'ESTOPPED' | 'ABORTED',
    message: string,
  ) {
    super(message);
    this.name = 'GateError';
  }
}

export class BayGate implements GateApi {
  private s: BayState = 'IDLE';
  private stoppedFrom: 'RUNNING' | 'SLOW' = 'RUNNING';
  private resetPending = false;
  private readonly listeners = new Set<(s: BayState) => void>();
  private readonly log: GateLog;

  constructor(opts: { log?: GateLog } = {}) {
    this.log = opts.log ?? (() => {});
  }

  state(): BayState {
    return this.s;
  }

  speedFactor(): number {
    return this.s === 'RUNNING' ? 1 : this.s === 'SLOW' ? 0.5 : 0;
  }

  /** true after RESET_ARM while waiting for RESET_CONFIRM */
  resetArmed(): boolean {
    return this.resetPending;
  }

  apply(cmd: GateCommand, source = 'operator'): GateApplyResult {
    const from = this.s;
    const go = (to: BayState, note: string): GateApplyResult => {
      this.s = to;
      this.log(`${cmd} (${source}): ${from} -> ${to}. ${note}`, 'safety');
      for (const cb of [...this.listeners]) cb(to);
      return { ok: true, state: to, note };
    };
    const no = (note: string): GateApplyResult => {
      this.log(`${cmd} (${source}) ignored in ${from}: ${note}`, 'info');
      return { ok: false, state: from, note };
    };
    if (cmd !== 'RESET_CONFIRM' && cmd !== 'RESET_ARM') this.resetPending = false;
    switch (cmd) {
      case 'ESTOP':
        if (from === 'ESTOPPED') return no('the bay is already in emergency stop.');
        return go('ESTOPPED', 'Emergency stop: every move is cancelled until the arm is reset on the panel.');
      case 'CYCLE_START':
        if (from !== 'IDLE') return no(`cycle start only works from idle; the bay is ${from.toLowerCase()}.`);
        return go('RUNNING', 'Cycle started.');
      case 'STOP':
        if (from !== 'RUNNING' && from !== 'SLOW') return no(`there is nothing running to stop; the bay is ${from.toLowerCase()}.`);
        this.stoppedFrom = from;
        return go('STOPPED', 'Arm frozen; resume to continue.');
      case 'RESUME':
        if (from === 'STOPPED') return go(this.stoppedFrom, 'Resumed.');
        if (from === 'SLOW') return go('RUNNING', 'Full speed.');
        return no(`resume only works when stopped or slow; the bay is ${from.toLowerCase()}.`);
      case 'SLOW':
        if (from !== 'RUNNING') return no(`slow only works while running; the bay is ${from.toLowerCase()}.`);
        return go('SLOW', 'Half speed.');
      case 'RESET_ARM':
        if (from !== 'ESTOPPED') return no('reset is only needed after an emergency stop.');
        this.resetPending = true;
        this.log(`RESET_ARM (${source}): confirm to return the bay to idle.`, 'safety');
        return { ok: true, state: from, note: 'Reset armed; confirm to return the bay to idle.' };
      case 'RESET_CONFIRM':
        if (from !== 'ESTOPPED') return no('reset is only needed after an emergency stop.');
        if (!this.resetPending) return no('press reset arm first, then confirm.');
        this.resetPending = false;
        return go('IDLE', 'Arm reset; the bay is idle.');
    }
  }

  /**
   * Resolves when the bay is RUNNING or SLOW. From IDLE this starts the cycle itself (logged as
   * 'TASK START - auto CYCLE START'). From STOPPED it waits for a change. Rejects with a GateError
   * on ESTOPPED (now or later) or when signal aborts.
   */
  waitRunnable(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new GateError('ABORTED', 'the move was cancelled.'));
    if (this.s === 'RUNNING' || this.s === 'SLOW') return Promise.resolve();
    if (this.s === 'ESTOPPED') return Promise.reject(new GateError('ESTOPPED', 'the bay is in emergency stop; reset the arm on the panel first.'));
    if (this.s === 'IDLE') {
      this.log('TASK START - auto CYCLE START', 'safety');
      this.apply('CYCLE_START', 'auto');
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        off();
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new GateError('ABORTED', 'the move was cancelled.'));
      };
      const off = this.onChange((s) => {
        if (s === 'RUNNING' || s === 'SLOW') {
          cleanup();
          resolve();
        } else if (s === 'ESTOPPED') {
          cleanup();
          reject(new GateError('ESTOPPED', 'the bay went into emergency stop.'));
        } else if (s === 'IDLE') {
          cleanup();
          this.log('TASK START - auto CYCLE START', 'safety');
          this.apply('CYCLE_START', 'auto');
          resolve();
        }
      });
      signal?.addEventListener('abort', onAbort);
    });
  }

  onChange(cb: (s: BayState) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}
