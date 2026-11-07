// Hand-signal state machine: the operator's safety channel. Feed it the gesture recognizer's top
// label for the hand (or null), its score and a timestamp, about 30 times a second.
//
//  - confidence gate: a label scoring below CONFIDENCE_MIN counts as no gesture
//  - debounce: a gesture must be seen for DEBOUNCE_MS before it arms ('armed' event); gaps shorter
//    than DEBOUNCE_MS (a dropped or misread frame) do not break a hold
//  - dwell: it fires once held DWELL_MS from its first sighting (ESTOP_DWELL_MS for the fist)
//  - released after arming but before firing: 'false_start'
//  - after firing, that gesture must be released, and REFRACTORY_MS must pass, before it can arm
//    again; a different gesture may arm at once
// Node-safe, no timers: time only advances with the samples you feed.

import type { GateCommand } from '../core/gate';

export const CONFIDENCE_MIN = 0.6;
export const DEBOUNCE_MS = 120;
export const DWELL_MS = 600;
export const ESTOP_DWELL_MS = 1500;
export const REFRACTORY_MS = 1000;

/** MediaPipe GestureRecognizer labels -> bay commands. Reset is never a gesture (panel only). */
export const GESTURE_COMMANDS = {
  Open_Palm: 'STOP',
  Closed_Fist: 'ESTOP',
  Thumb_Up: 'RESUME',
  Pointing_Up: 'SLOW',
  Victory: 'CYCLE_START',
} as const satisfies Record<string, GateCommand>;

export type GestureLabel = keyof typeof GESTURE_COMMANDS;
export type SignalCommand = (typeof GESTURE_COMMANDS)[GestureLabel];

export interface SignalEvent {
  type: 'armed' | 'fired' | 'false_start';
  command: SignalCommand;
  gesture: GestureLabel;
  /** timestamp of the sample that produced the event, ms */
  t: number;
  /** how long the gesture had been held, ms */
  heldMs: number;
}

export type SignalPhase = 'idle' | 'debounce' | 'armed' | 'fired';

export interface SignalSnapshot {
  phase: SignalPhase;
  gesture: GestureLabel | null;
  command: SignalCommand | null;
  /** 0-1 toward firing, for the UI ring (1 once fired) */
  progress: number;
  heldMs: number;
}

export function isGestureLabel(label: string | null | undefined): label is GestureLabel {
  return !!label && Object.prototype.hasOwnProperty.call(GESTURE_COMMANDS, label);
}

export function dwellFor(g: GestureLabel): number {
  return g === 'Closed_Fist' ? ESTOP_DWELL_MS : DWELL_MS;
}

interface Track {
  gesture: GestureLabel;
  t0: number;
  lastSeen: number;
}

export class HandSignals {
  private cur: (Track & { armed: boolean; fired: boolean }) | null = null;
  /** a different gesture seen while cur is still held */
  private alt: Track | null = null;
  private readonly refractoryUntil = new Map<GestureLabel, number>();
  private lastT = -Infinity;
  private readonly listeners = new Set<(e: SignalEvent) => void>();

  /** feed one recognizer sample; returns the events it produced (also sent to onEvent listeners) */
  feed(label: string | null, score: number, tMs: number): SignalEvent[] {
    if (!Number.isFinite(tMs) || tMs < this.lastT) return [];
    this.lastT = tMs;
    const g: GestureLabel | null = isGestureLabel(label) && Number.isFinite(score) && score >= CONFIDENCE_MIN ? label : null;
    const out: SignalEvent[] = [];
    const emit = (type: SignalEvent['type'], tr: Track): void => {
      out.push({ type, command: GESTURE_COMMANDS[tr.gesture], gesture: tr.gesture, t: tMs, heldMs: tMs - tr.t0 });
    };

    // follow the current gesture, or notice it went away
    if (this.cur) {
      if (g === this.cur.gesture) {
        this.cur.lastSeen = tMs;
        this.alt = null;
      } else {
        if (g !== null) {
          if (this.alt && this.alt.gesture === g && tMs - this.alt.lastSeen < DEBOUNCE_MS) this.alt.lastSeen = tMs;
          else this.alt = { gesture: g, t0: tMs, lastSeen: tMs };
        }
        if (tMs - this.cur.lastSeen >= DEBOUNCE_MS) {
          if (this.cur.armed && !this.cur.fired) emit('false_start', this.cur);
          this.cur = null;
        }
      }
    } else if (g !== null) {
      if (this.alt && this.alt.gesture === g && tMs - this.alt.lastSeen < DEBOUNCE_MS) this.alt.lastSeen = tMs;
      else this.alt = { gesture: g, t0: tMs, lastSeen: tMs };
    }

    // start tracking a gesture (the one that replaced cur keeps its own onset time)
    if (!this.cur && g !== null && this.alt && this.alt.gesture === g) {
      const until = this.refractoryUntil.get(g) ?? -Infinity;
      if (tMs >= until) {
        // a gesture shown during its refractory period starts its dwell when that period ends
        this.cur = { ...this.alt, t0: Math.max(this.alt.t0, until), armed: false, fired: false };
        this.alt = null;
      }
    }

    // arm and fire
    const c = this.cur;
    if (c && !c.fired && c.lastSeen === tMs) {
      const held = tMs - c.t0;
      if (!c.armed && held >= DEBOUNCE_MS) {
        c.armed = true;
        emit('armed', c);
      }
      if (c.armed && held >= dwellFor(c.gesture)) {
        c.fired = true;
        this.refractoryUntil.set(c.gesture, tMs + REFRACTORY_MS);
        emit('fired', c);
      }
    }
    for (const e of out) for (const cb of [...this.listeners]) cb(e);
    return out;
  }

  snapshot(): SignalSnapshot {
    const c = this.cur;
    if (!c) return { phase: 'idle', gesture: null, command: null, progress: 0, heldMs: 0 };
    const heldMs = Math.max(0, this.lastT - c.t0);
    const phase: SignalPhase = c.fired ? 'fired' : c.armed ? 'armed' : 'debounce';
    const progress = c.fired ? 1 : Math.min(1, heldMs / dwellFor(c.gesture));
    return { phase, gesture: c.gesture, command: GESTURE_COMMANDS[c.gesture], progress, heldMs };
  }

  onEvent(cb: (e: SignalEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** forget everything (e.g. when the camera restarts) */
  reset(): void {
    this.cur = null;
    this.alt = null;
    this.refractoryUntil.clear();
    this.lastT = -Infinity;
  }
}

/** Route fired gestures to the bay gate (source 'gesture'). Returns an unsubscribe function. */
export function bindSignalsToGate(signals: HandSignals, gate: { apply(cmd: GateCommand, source?: string): unknown }): () => void {
  return signals.onEvent((e) => {
    if (e.type === 'fired') gate.apply(e.command, 'gesture');
  });
}
