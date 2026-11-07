// TEMPORARY hand-signal dwell machine, until src/safety/signals.ts lands with the arm core.
// A gesture must be held for its dwell before its command fires once; it fires again only after
// the hand lets go or changes gesture.
import type { SafetySignal } from './bayTypes';

export interface GestureCommand {
  gesture: string;
  signal: SafetySignal;
  /** keypad key that simulates holding this gesture */
  key: string;
  /** short operator-facing names */
  gestureLabel: string;
  commandLabel: string;
  dwellMs: number;
}

/** The fixed signal mapping (docs/ARCHITECTURE.md): keys 1-5 simulate holding each gesture. */
export const GESTURE_COMMANDS: readonly GestureCommand[] = [
  { gesture: 'Open_Palm', signal: 'STOP', key: '1', gestureLabel: 'Open palm', commandLabel: 'Stop', dwellMs: 300 },
  { gesture: 'Closed_Fist', signal: 'ESTOP', key: '2', gestureLabel: 'Fist, held 1.5 s', commandLabel: 'E-stop', dwellMs: 1500 },
  { gesture: 'Thumb_Up', signal: 'RESUME', key: '3', gestureLabel: 'Thumb up', commandLabel: 'Resume', dwellMs: 700 },
  { gesture: 'Pointing_Up', signal: 'SLOW', key: '4', gestureLabel: 'Point up', commandLabel: 'Slow', dwellMs: 700 },
  { gesture: 'Victory', signal: 'CYCLE_START', key: '5', gestureLabel: 'Victory', commandLabel: 'Cycle start', dwellMs: 700 },
];

export const MIN_GESTURE_SCORE = 0.55;
const DEBOUNCE_MS = 90;

export type SafetyPhase = 'idle' | 'debouncing' | 'arming' | 'fired';

export interface SafetySnapshot {
  phase: SafetyPhase;
  /** gesture currently held (after filtering), or null */
  gesture: string | null;
  /** command that gesture maps to */
  signal: SafetySignal | null;
  /** 0-1 progress through the dwell */
  progress: number;
  /** last command fired, and when (performance.now ms) */
  lastFired: { signal: SafetySignal; t: number } | null;
}

export class DwellMachine {
  private held: GestureCommand | null = null;
  private since = 0;
  private latched = false;
  private snap: SafetySnapshot = { phase: 'idle', gesture: null, signal: null, progress: 0, lastFired: null };

  /** Feed one sample; returns the command that fires on this sample, if any. */
  feed(label: string | null, score: number, now: number): SafetySignal | null {
    const cmd = label && score >= MIN_GESTURE_SCORE ? (GESTURE_COMMANDS.find((c) => c.gesture === label) ?? null) : null;
    if (!cmd) {
      this.held = null;
      this.latched = false;
      this.snap = { ...this.snap, phase: 'idle', gesture: null, signal: null, progress: 0 };
      return null;
    }
    if (cmd !== this.held) {
      this.held = cmd;
      this.since = now;
      this.latched = false;
    }
    const elapsed = now - this.since;
    const progress = Math.min(1, elapsed / cmd.dwellMs);
    if (this.latched) {
      this.snap = { ...this.snap, phase: 'fired', gesture: cmd.gesture, signal: cmd.signal, progress: 1 };
      return null;
    }
    if (progress >= 1) {
      this.latched = true;
      this.snap = { phase: 'fired', gesture: cmd.gesture, signal: cmd.signal, progress: 1, lastFired: { signal: cmd.signal, t: now } };
      return cmd.signal;
    }
    this.snap = { ...this.snap, phase: elapsed < DEBOUNCE_MS ? 'debouncing' : 'arming', gesture: cmd.gesture, signal: cmd.signal, progress };
    return null;
  }

  snapshot(): SafetySnapshot {
    return this.snap;
  }
}
