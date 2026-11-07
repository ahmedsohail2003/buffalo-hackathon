// Hand teleoperation: shared autonomy over the sample deck.
// The operator gives intent: WHERE (the palm steers a hover target) and WHEN (a pinch click).
// Validated code does the precise part: a click runs the arm's pick / place primitives (gate,
// IK pre-check, descent, jaw width, attach rule, lift); the arm also solves IK for the servo.
// Safety: a stale hand frame holds position (dead-man), a hand showing one of the five safety
// signals (or any signal the gesture machine is forming) never steers or clicks, STOP holds, and
// E-STOP turns teleop off. Teleop never changes the bay state itself; enabling on an IDLE bay goes
// through gate.waitRunnable(), the same logged auto CYCLE START every arm task uses. Node-safe.

import type { BayApi, BayState, HandFrame, MoveResult, Sample, TeleopStatus, Vec3 } from '../contracts';
import { OneEuroFilter } from './oneEuro';
import { PinchDetector, fingersExtended, isPinchPose, mapToWorkspace, palmPoint, pinchRatio, type ReachBand } from './mapping';
import { setPinchRatio, setTeleopStatus } from './state';

/** A hand frame older than this is no hand at all (dead-man). */
/** A hand frame older than this counts as 'no hand' (dead-man hold). 600 ms tolerates a slow laptop's
 * frame rate (a few fps) while still stopping the arm within about half a second of the hand leaving. */
export const FRESH_MS = 600;
/** A pinch picks the nearest unheld sample whose centre is this close (xy) to the hover target. */
export const PICK_RADIUS = 0.035;
/** The gesture vocabulary of the safety channel: a hand showing one of these is signalling, not steering. */
export const SAFETY_LABELS: ReadonlySet<string> = new Set(['Open_Palm', 'Closed_Fist', 'Thumb_Up', 'Pointing_Up', 'Victory']);
/** Recognizer score from which a safety label counts (the gesture machine's confidence gate). */
export const SIGNAL_MIN_SCORE = 0.6;
const FLASH_MS = 2000;

export interface TeleopConfig {
  reach: ReachBand;
  /** tool-centre height while following empty-handed, metres */
  zHover: number;
  /** tool-centre height while carrying a sample, metres */
  zLift: number;
  /** containment bin centre and the half-width of its footprint, metres */
  containment: { xy: [number, number]; half: number };
  log?: (text: string, kind?: string) => void;
  /** optional: true while an AI task owns the arm; teleop turns off and cannot be enabled */
  taskActive?: () => boolean;
}

export interface Teleop {
  /** Turn teleop on (an IDLE bay gets the gate's auto CYCLE START); refused in E-STOP. */
  enable(): void;
  /** Turn teleop off; a pick or place already running finishes on its own. */
  disable(reason?: string): void;
  /** Every app frame: the latest hand frame and the safety gesture machine's phase. */
  step(nowMs: number, frame: HandFrame | null, gesturePhase?: string): void;
  status(): TeleopStatus;
}

/**
 * The hand is showing a safety signal rather than steering: one of the five labels at score >= 0.6.
 * A Closed_Fist label on a clear pinch pose (other fingers extended) is a pinch, not a fist.
 */
export function isSafetySignal(f: HandFrame): boolean {
  if (!f.gesture || !SAFETY_LABELS.has(f.gesture) || !(f.gestureScore >= SIGNAL_MIN_SCORE)) return false;
  return !(f.gesture === 'Closed_Fist' && isPinchPose(f.landmarks));
}

const mm = (v: number) => Math.round(v * 1000);

class TeleopController implements Teleop {
  private enabled = false;
  private busy: 'grasping' | 'placing' | null = null;
  private readonly fu = new OneEuroFilter();
  private readonly fv = new OneEuroFilter();
  private readonly pinch = new PinchDetector();
  private lastFrameT = Number.NaN;
  private targetXY: [number, number] | null = null;
  private clamped = false;
  private handPresent = false;
  private frozen = false;
  private mode: TeleopStatus['mode'] = 'off';
  private note = '';
  private flash: { text: string; until: number } | null = null;
  private now = 0;

  constructor(
    private readonly bay: BayApi,
    private readonly cfg: TeleopConfig,
  ) {
    // E-STOP turns teleop off at once, not on the next frame.
    bay.gate.onChange((s) => {
      if (s === 'ESTOPPED') this.onEstop();
    });
    this.publish();
  }

  enable(): void {
    if (this.enabled) return;
    const s = this.bay.gate.state();
    if (s === 'ESTOPPED') return this.refuse('E-STOP — reset the bay on the panel, then enable teleop', 'TELEOP refused — bay in E-STOP');
    if (this.cfg.taskActive?.()) return this.refuse('an AI task is running — enable teleop when it is done', 'TELEOP refused — an AI task is running');
    // IDLE: the gate's own logged auto CYCLE START, as for every arm task.
    if (s === 'IDLE') void this.bay.gate.waitRunnable().catch(() => undefined);
    this.enabled = true;
    this.forgetHand();
    this.flash = null;
    this.set('holding', 'no hand in view — holding position');
    this.log('TELEOP ON — the gripper follows your hand; pinch to pick, pinch again to place', 'teleop');
    this.publish();
  }

  disable(reason?: string): void {
    this.off('', `TELEOP OFF${reason ? ` — ${reason}` : ''}`, 'teleop');
  }

  private onEstop(): void {
    this.off('E-STOP — teleop disabled; reset the bay, then re-enable', 'TELEOP OFF — E-STOP', 'safety');
  }

  private refuse(note: string, text: string): void {
    this.note = note;
    this.log(text, 'reject');
    this.publish();
  }

  private off(note: string, text: string, kind: string): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.bay.arm.servoTo(null);
    this.forgetHand();
    this.flash = null;
    this.set('off', note);
    this.log(text, kind);
    this.publish();
  }

  step(nowMs: number, frame: HandFrame | null, gesturePhase?: string): void {
    this.now = nowMs;
    if (!this.enabled) return;
    const s = this.bay.gate.state();
    if (s === 'ESTOPPED') return this.onEstop();
    if (this.cfg.taskActive?.()) {
      return this.off('an AI task took the arm — re-enable teleop when it is done', 'TELEOP OFF — AI task started', 'teleop');
    }
    const forming = gesturePhase === 'debouncing' || gesturePhase === 'arming';
    const click = this.readHand(nowMs, frame, forming);
    this.decide(s, click);
    this.publish();
  }

  private decide(s: BayState, click: boolean): void {
    // STOP outranks everything: a paused pick or place reads as holding until the thumbs-up.
    if (s === 'STOPPED') return this.hold('bay STOPPED — thumbs-up to resume');
    if (s !== 'RUNNING' && s !== 'SLOW') return this.hold('bay IDLE — turn teleop off and on to start a cycle');
    if (this.busy) return this.set(this.busy, this.busy === 'grasping' ? 'picking the sample under the gripper' : 'placing the sample');
    const snap = this.bay.arm.snapshot();
    if (snap.busy) return this.hold('arm busy with a task — waiting');
    if (!this.handPresent || !this.targetXY) return this.hold('no hand in view — holding position');
    const target = this.target(snap.heldId)!;
    if (click && !this.frozen) {
      this.onClick(target, snap.heldId);
      if (this.busy) return this.set(this.busy, this.busy === 'grasping' ? 'picking the sample under the gripper' : 'placing the sample');
    }
    this.bay.arm.servoTo(target);
    if (/unreach|blocked/i.test(snap.phase)) return this.set('blocked', 'edge of reach');
    if (this.frozen) return this.set('holding', 'safety signal — steering paused, target frozen');
    this.set('following', this.followNote(target, snap.heldId));
  }

  private set(mode: TeleopStatus['mode'], note: string): void {
    this.mode = mode;
    this.note = note;
  }

  /** Hold position: no servo target, so the arm stays where it is. */
  private hold(note: string): void {
    this.bay.arm.servoTo(null);
    this.set('holding', note);
  }

  /** Read one hand frame; returns true when a pinch click fired on this (new) frame. */
  private readHand(now: number, frame: HandFrame | null, forming: boolean): boolean {
    const fresh = frame !== null && now - frame.t <= FRESH_MS && frame.landmarks.length >= 21;
    if (!fresh) {
      if (this.handPresent || this.targetXY) this.forgetHand();
      return false;
    }
    this.handPresent = true;
    // A hand showing a safety signal, or any signal the gesture machine is forming, never steers.
    this.frozen = forming || isSafetySignal(frame);
    if (frame.t === this.lastFrameT) return false; // the same camera frame, seen again
    this.lastFrameT = frame.t;
    const p = palmPoint(frame.landmarks);
    const tS = frame.t / 1000;
    const m = mapToWorkspace(this.fu.filter(p.u, tS), this.fv.filter(p.v, tS), this.cfg.reach);
    // A frozen hand keeps the old target; with no target yet (the hand just came back) it holds.
    if (!this.frozen) {
      this.targetXY = [m.x, m.y];
      this.clamped = m.clamped;
    }
    const ratio = pinchRatio(frame.landmarks);
    setPinchRatio(ratio);
    // a click is a PINCH: the close edge with at least two of middle / ring / pinky extended (not a fist)
    const edge = this.pinch.update(ratio);
    return edge && fingersExtended(frame.landmarks) >= 2 && !this.frozen;
  }

  private forgetHand(): void {
    this.handPresent = false;
    this.frozen = false;
    this.targetXY = null;
    this.clamped = false;
    this.lastFrameT = Number.NaN;
    this.fu.reset();
    this.fv.reset();
    this.pinch.reset();
    setPinchRatio(Infinity);
  }

  /** Hover target: the mapped deck point at hover height (lift height while carrying). */
  private target(heldId: string | null): Vec3 | null {
    if (!this.targetXY) return null;
    return [this.targetXY[0], this.targetXY[1], heldId ? this.cfg.zLift : this.cfg.zHover];
  }

  private inContainment(x: number, y: number): boolean {
    const { xy, half } = this.cfg.containment;
    return Math.abs(x - xy[0]) <= half && Math.abs(y - xy[1]) <= half;
  }

  /** Nearest unheld sample whose centre is within PICK_RADIUS (xy) of p. */
  private sampleUnder(p: Vec3): Sample | null {
    let best: Sample | null = null;
    let bd = Infinity;
    for (const o of this.bay.samples.list()) {
      if (o.held) continue;
      const d = Math.hypot(o.pos[0] - p[0], o.pos[1] - p[1]);
      if (d <= PICK_RADIUS && d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  private onClick(target: Vec3, heldId: string | null): void {
    const [x, y] = target;
    if (heldId) {
      const inBin = this.inContainment(x, y);
      this.busy = 'placing';
      this.bay.arm.servoTo(null); // the primitive owns the arm from here
      this.track(
        inBin ? this.bay.arm.placeInContainment() : this.bay.arm.placeAt([x, y]),
        inBin ? `TELEOP place ${heldId} in containment` : `TELEOP place ${heldId} at (${mm(x)}, ${mm(y)}) mm`,
      );
      return;
    }
    const s = this.sampleUnder(target);
    if (!s) {
      this.flash = { text: 'nothing under the gripper', until: this.now + FLASH_MS };
      this.log('TELEOP pinch — nothing under the gripper', 'teleop');
      return;
    }
    this.busy = 'grasping';
    this.bay.arm.servoTo(null);
    this.track(this.bay.arm.pick(s.id), `TELEOP pick ${s.id}`);
  }

  private track(p: Promise<MoveResult>, label: string): void {
    p.then(
      (r) => {
        this.busy = null;
        if (r.ok) {
          this.log(`${label} → ok${r.held ? `, holding ${r.held}` : ''}`, 'teleop');
        } else {
          this.log(`${label} → ${r.code} ${r.reason}`, 'reject');
          this.flash = { text: r.reason, until: this.now + FLASH_MS };
        }
        this.publish();
      },
      (e: unknown) => {
        this.busy = null;
        this.log(`${label} → failed: ${e instanceof Error ? e.message : String(e)}`, 'reject');
        this.publish();
      },
    );
  }

  private followNote(target: Vec3, heldId: string | null): string {
    const edge = (this.clamped ? ' · at the edge of reach' : '') + (this.bay.gate.speedFactor() === 0.5 ? ' · SLOW' : '');
    if (heldId) {
      const name = this.bay.samples.get(heldId)?.name ?? heldId;
      return `carrying ${name} — pinch to place it${this.inContainment(target[0], target[1]) ? ' in containment' : ' here'}${edge}`;
    }
    const s = this.sampleUnder(target);
    return s ? `over ${s.name} — pinch to pick it${edge}` : `following your hand${edge}`;
  }

  private log(text: string, kind: string): void {
    this.cfg.log?.(text, kind);
  }

  status(): TeleopStatus {
    const t = this.enabled && this.targetXY ? this.target(this.bay.arm.snapshot().heldId) : null;
    const flash = this.flash && this.now < this.flash.until ? this.flash.text : null;
    return {
      enabled: this.enabled,
      handPresent: this.handPresent,
      pinched: this.handPresent && this.pinch.closed,
      target_mm: t ? [mm(t[0]), mm(t[1]), mm(t[2])] : null,
      mode: this.mode,
      note: flash && this.enabled ? `${flash} · ${this.note}` : this.note,
    };
  }

  private publish(): void {
    setTeleopStatus(this.status());
  }
}

/** Build the teleop controller for a bay. Call step() every frame before the arm steps. */
export function createTeleop(bay: BayApi, cfg: TeleopConfig): Teleop {
  return new TeleopController(bay, cfg);
}
