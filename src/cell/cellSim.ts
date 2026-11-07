// Simulated collaborative robot cell: state, cycle clock, and command
// handling. Pure TypeScript (no canvas), so the transitions are unit-testable.
//
// Design note: recovery from EMERGENCY_STOP is deliberately NOT gesture-
// driven. Resetting an e-stop must be an explicit, unambiguous, two-step act
// at the panel (reset, then confirm) so that a misclassified gesture can
// never restart a locked-out cell. Gestures can only make the cell safer
// (stop it); making it live again requires the on-screen interlock.

import type { CommandId } from '../gesture/stateMachine';

export type CellState = 'IDLE' | 'RUNNING' | 'SLOW' | 'STOPPED' | 'ESTOPPED';

export const CYCLE_DURATION_S = 8;

export class CobotCell {
  state: CellState = 'IDLE';
  /** State to return to when RESUME is issued after a STOP. */
  private resumeTo: 'RUNNING' | 'SLOW' = 'RUNNING';
  /** Seconds into the current pick-and-place cycle. */
  cycleT = 0;
  cyclesCompleted = 0;
  /** Two-step e-stop reset progress: 0 = not started, 1 = reset pressed. */
  resetStep: 0 | 1 = 0;

  speedFactor(): number {
    if (this.state === 'RUNNING') return 1;
    if (this.state === 'SLOW') return 0.5;
    return 0;
  }

  /** Advance the cycle clock. STOPPED/ESTOPPED/IDLE freeze motion in place. */
  tick(dtSeconds: number): void {
    const f = this.speedFactor();
    if (f <= 0) return;
    this.cycleT += dtSeconds * f;
    while (this.cycleT >= CYCLE_DURATION_S) {
      this.cycleT -= CYCLE_DURATION_S;
      this.cyclesCompleted += 1;
    }
  }

  /** Cycle progress 0..1. */
  cycleU(): number {
    return this.cycleT / CYCLE_DURATION_S;
  }

  /**
   * Apply a fired gesture command. Returns true if the command changed the
   * cell, false if it was ignored in the current state (logged upstream so
   * a study can see commands that had no effect).
   */
  apply(cmd: CommandId): boolean {
    switch (cmd) {
      case 'EMERGENCY_STOP':
        if (this.state === 'ESTOPPED') return false;
        this.state = 'ESTOPPED';
        this.resetStep = 0;
        return true;
      case 'STOP':
        if (this.state === 'RUNNING' || this.state === 'SLOW') {
          this.resumeTo = this.state === 'SLOW' ? 'SLOW' : 'RUNNING';
          this.state = 'STOPPED';
          return true;
        }
        return false;
      case 'RESUME':
        if (this.state === 'STOPPED') {
          this.state = this.resumeTo;
          return true;
        }
        if (this.state === 'SLOW') {
          this.state = 'RUNNING';
          return true;
        }
        return false;
      case 'SLOW':
        if (this.state === 'RUNNING') {
          this.state = 'SLOW';
          return true;
        }
        if (this.state === 'STOPPED') {
          this.resumeTo = 'SLOW';
          return true;
        }
        return false;
      case 'CYCLE_START':
        if (this.state === 'IDLE') {
          this.state = 'RUNNING';
          this.resumeTo = 'RUNNING';
          this.cycleT = 0;
          return true;
        }
        return false;
    }
  }

  /** Step 1 of the on-screen e-stop reset interlock. */
  estopResetArm(): void {
    if (this.state === 'ESTOPPED') this.resetStep = 1;
  }

  /** Step 2: confirm. Returns the cell to IDLE (CYCLE_START required). */
  estopResetConfirm(): void {
    if (this.state === 'ESTOPPED' && this.resetStep === 1) {
      this.state = 'IDLE';
      this.resetStep = 0;
      this.cycleT = 0;
      this.resumeTo = 'RUNNING';
    }
  }
}
