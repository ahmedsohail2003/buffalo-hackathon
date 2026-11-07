// HandSignal — gesture safety-command state machine.
//
// Pure TypeScript with no DOM dependencies: the exact same logic processes
// real MediaPipe classifications and simulated keyboard-injected ones, and it
// is unit-tested in isolation (see stateMachine.test.ts).
//
// Pipeline:
//   raw classification -> confidence gate -> debounce window -> dwell arming
//   -> command fires -> refractory period
//
// Every raw detection, arming event, fired command, and false start (armed
// but released before the dwell completed) is emitted as a timestamped event.
// These are the dependent measures a usability study needs: false-activation
// rate, false-start rate, and dwell-to-fire latency per gesture.

export type GestureLabel =
  | 'Open_Palm'
  | 'Closed_Fist'
  | 'Thumb_Up'
  | 'Pointing_Up'
  | 'Victory';

export type CommandId =
  | 'STOP'
  | 'EMERGENCY_STOP'
  | 'RESUME'
  | 'SLOW'
  | 'CYCLE_START';

/**
 * Mapping from MediaPipe's canonical gesture set to cobot cell commands.
 * The semantics are adapted from the ASME B30.5 crane signalperson
 * vocabulary; see the About panel and case-study notes for which mappings
 * are literal and which are adaptations.
 */
export const GESTURE_TO_COMMAND: Record<GestureLabel, CommandId> = {
  Open_Palm: 'STOP',
  Closed_Fist: 'EMERGENCY_STOP',
  Thumb_Up: 'RESUME',
  Pointing_Up: 'SLOW',
  Victory: 'CYCLE_START',
};

export interface StateMachineConfig {
  /** Classifications below this confidence are treated as "no gesture". */
  minConfidence: number;
  /** A gesture must persist this long before arming begins. */
  debounceMs: number;
  /** Dwell required to fire a normal command (adjustable in the UI). */
  dwellMs: number;
  /**
   * Dwell required to fire EMERGENCY_STOP (Closed_Fist). Deliberately longer
   * than the normal dwell: an e-stop halts production, so a false trigger is
   * expensive. Fixed, not user-adjustable.
   */
  estopDwellMs: number;
  /**
   * After a command fires, the same gesture cannot re-arm until this period
   * elapses AND the gesture has been released. A different gesture may arm
   * immediately, so a STOP is never delayed by a preceding RESUME.
   */
  refractoryMs: number;
  /** Dropouts shorter than this do not cancel a debounce or an arming hold. */
  lossGraceMs: number;
}

export const DEFAULT_CONFIG: StateMachineConfig = {
  minConfidence: 0.6,
  debounceMs: 120,
  dwellMs: 600,
  estopDwellMs: 1500,
  refractoryMs: 1200,
  lossGraceMs: 120,
};

export type Phase = 'idle' | 'debouncing' | 'arming' | 'refractory';

export type MachineEvent =
  | { type: 'raw'; t: number; label: GestureLabel; confidence: number }
  | {
      type: 'armed';
      t: number;
      gesture: GestureLabel;
      command: CommandId;
      requiredDwellMs: number;
    }
  | {
      type: 'fired';
      t: number;
      gesture: GestureLabel;
      command: CommandId;
      /** Time from the first raw detection of this hold to the fire. */
      latencyMs: number;
    }
  | {
      type: 'false_start';
      t: number;
      gesture: GestureLabel;
      command: CommandId;
      /** How long the gesture was held before it was released or replaced. */
      heldMs: number;
    };

export interface Counters {
  raw: number;
  armed: number;
  fired: number;
  falseStarts: number;
  avgLatencyMs: number | null;
}

export interface Snapshot {
  phase: Phase;
  gesture: GestureLabel | null;
  command: CommandId | null;
  /** 0..1 while arming; 0 otherwise. Drives the radial progress ring. */
  dwellProgress: number;
  requiredDwellMs: number;
  refractoryRemainingMs: number;
  counters: Counters;
}

export class GestureStateMachine {
  private cfg: StateMachineConfig;

  private phase: Phase = 'idle';
  private candidate: GestureLabel | null = null;
  private firstSeenAt = 0; // first raw detection of the current hold
  private stableStart = 0; // debounce anchor
  private armStart = 0;
  private lastSeen = 0;
  private refractoryUntil = -1;

  /** Label that fired and must be released before it can arm again. */
  private holdLock: GestureLabel | null = null;
  private holdLockLastSeen = 0;

  private rawCount = 0;
  private armedCount = 0;
  private firedCount = 0;
  private falseStartCount = 0;
  private latencySum = 0;

  constructor(config: Partial<StateMachineConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
  }

  getConfig(): StateMachineConfig {
    return { ...this.cfg };
  }

  /** Adjust the normal-command dwell (bounded below the fixed e-stop dwell). */
  setDwellMs(ms: number): void {
    this.cfg.dwellMs = Math.min(1200, Math.max(200, ms));
  }

  private requiredDwell(label: GestureLabel): number {
    return label === 'Closed_Fist' ? this.cfg.estopDwellMs : this.cfg.dwellMs;
  }

  /**
   * Feed one classification sample. Call on every frame, including frames
   * with no detection (label = null), so grace and refractory timers advance.
   * Timestamps must be monotonically non-decreasing.
   */
  sample(
    label: GestureLabel | null,
    confidence: number,
    t: number,
  ): MachineEvent[] {
    const events: MachineEvent[] = [];
    const cfg = this.cfg;

    if (label !== null) {
      this.rawCount += 1;
      events.push({ type: 'raw', t, label, confidence });
    }

    // Confidence gate.
    let eff: GestureLabel | null =
      label !== null && confidence >= cfg.minConfidence ? label : null;

    // Hold-lock: a fired gesture is ignored until released (a gap longer
    // than the loss grace) and its refractory period has elapsed.
    if (this.holdLock !== null) {
      if (eff === this.holdLock) {
        this.holdLockLastSeen = t;
      } else if (
        t - this.holdLockLastSeen > cfg.lossGraceMs &&
        t >= this.refractoryUntil
      ) {
        this.holdLock = null;
      }
      if (this.holdLock !== null && eff === this.holdLock) {
        eff = null;
      }
    }

    // Refractory phase expires on its own.
    if (this.phase === 'refractory' && t >= this.refractoryUntil) {
      this.phase = 'idle';
    }

    if (this.phase === 'idle' || this.phase === 'refractory') {
      if (eff !== null) {
        this.startCandidate(eff, t);
      }
    } else if (this.phase === 'debouncing') {
      if (eff === null) {
        if (t - this.lastSeen > cfg.lossGraceMs) {
          this.dropCandidate(t);
        }
      } else if (eff !== this.candidate) {
        this.startCandidate(eff, t);
      } else {
        this.lastSeen = t;
        if (t - this.stableStart >= cfg.debounceMs) {
          this.phase = 'arming';
          this.armStart = t;
          this.armedCount += 1;
          events.push({
            type: 'armed',
            t,
            gesture: eff,
            command: GESTURE_TO_COMMAND[eff],
            requiredDwellMs: this.requiredDwell(eff),
          });
        }
      }
    } else if (this.phase === 'arming') {
      const g = this.candidate as GestureLabel;
      if (eff === null) {
        if (t - this.lastSeen > cfg.lossGraceMs) {
          events.push(this.falseStart(g, t));
          this.dropCandidate(t);
        }
      } else if (eff !== g) {
        events.push(this.falseStart(g, t));
        this.startCandidate(eff, t);
      } else {
        this.lastSeen = t;
        if (t - this.armStart >= this.requiredDwell(g)) {
          const latencyMs = t - this.firstSeenAt;
          this.firedCount += 1;
          this.latencySum += latencyMs;
          events.push({
            type: 'fired',
            t,
            gesture: g,
            command: GESTURE_TO_COMMAND[g],
            latencyMs,
          });
          this.holdLock = g;
          this.holdLockLastSeen = t;
          this.refractoryUntil = t + cfg.refractoryMs;
          this.phase = 'refractory';
          this.candidate = null;
        }
      }
    }

    return events;
  }

  private startCandidate(label: GestureLabel, t: number): void {
    this.phase = 'debouncing';
    this.candidate = label;
    this.firstSeenAt = t;
    this.stableStart = t;
    this.lastSeen = t;
  }

  private dropCandidate(t: number): void {
    this.candidate = null;
    this.phase = t < this.refractoryUntil ? 'refractory' : 'idle';
  }

  private falseStart(g: GestureLabel, t: number): MachineEvent {
    this.falseStartCount += 1;
    return {
      type: 'false_start',
      t,
      gesture: g,
      command: GESTURE_TO_COMMAND[g],
      heldMs: t - this.firstSeenAt,
    };
  }

  counters(): Counters {
    return {
      raw: this.rawCount,
      armed: this.armedCount,
      fired: this.firedCount,
      falseStarts: this.falseStartCount,
      avgLatencyMs:
        this.firedCount > 0 ? this.latencySum / this.firedCount : null,
    };
  }

  snapshot(t: number): Snapshot {
    const g = this.candidate;
    const required =
      g !== null ? this.requiredDwell(g) : this.cfg.dwellMs;
    const dwellProgress =
      this.phase === 'arming' && g !== null
        ? Math.min(1, Math.max(0, (t - this.armStart) / required))
        : 0;
    return {
      phase: this.phase,
      gesture: g,
      command: g !== null ? GESTURE_TO_COMMAND[g] : null,
      dwellProgress,
      requiredDwellMs: required,
      refractoryRemainingMs:
        this.phase === 'refractory'
          ? Math.max(0, this.refractoryUntil - t)
          : 0,
      counters: this.counters(),
    };
  }
}
