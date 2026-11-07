// Motion executor for the kinematic SO-ARM100 (PLAN.md A3).
// Joint-space segments with smoothstep easing, stepped from the app RAF with the
// cell's speedFactor (1 / 0.5 / 0): STOP freezes mid-move (u untouched), ESTOP
// aborts every pending promise. Motion promises have NO timeouts; only abortAll
// (ESTOP / cancel) rejects them. Node-safe.

import type { ArmApi, ArmSnapshot, PrimResult, Vec3, CellGateApi } from '../contracts';
import type { ArmModel } from './armModel';
import type { ObjectRegistry } from '../cell/objects';
import { HOME_Q, JAW_OPEN } from './armData';
import { abortedResult } from './gate';
import * as prim from './primitives';

export interface Segment {
  q0: number[];
  q1: number[];
  durS: number;
  u: number;
  started: boolean;
  label: string;
  resolve: () => void;
  reject: (r: PrimResult) => void;
}

const smoothstep = (s: number) => {
  const c = Math.min(1, Math.max(0, s));
  return c * c * (3 - 2 * c);
};

export const JOINT_SPEED = 1.5; // rad/s at speed 1
export const MIN_SEG_S = 0.35;

export class ArmController implements ArmApi {
  /** 6 joints: Rotation, Pitch, Elbow, Wrist_Pitch, Wrist_Roll, Jaw */
  q: number[];
  phase = 'idle';
  heldId: string | null = null;
  /** object centre − tcp at attach time (root frame) */
  private heldOffset: Vec3 = [0, 0, 0];
  queue: Segment[] = [];
  private tcpNow: Vec3;
  /** the joint target the queue ends at (or q if empty) */
  private tail: number[];

  constructor(
    readonly model: ArmModel,
    readonly objects: ObjectRegistry,
    readonly gate: CellGateApi,
  ) {
    this.q = [...HOME_Q, JAW_OPEN];
    this.tail = [...this.q];
    this.model.setPose(this.q);
    this.tcpNow = this.model.tcp();
  }

  // ---- stepping ----

  /** Advance motion by dt seconds at the cell's speed factor. Called from the app RAF. */
  step(dt: number, speedFactor: number): void {
    const seg = this.queue[0];
    if (seg) {
      if (!seg.started) {
        seg.started = true;
        this.phase = seg.label;
      }
      if (speedFactor > 0 && dt > 0) {
        seg.u += (dt * speedFactor) / seg.durS;
        const s = smoothstep(seg.u);
        for (let i = 0; i < this.q.length; i++) this.q[i] = seg.q0[i] + (seg.q1[i] - seg.q0[i]) * s;
        if (seg.u >= 1) {
          for (let i = 0; i < this.q.length; i++) this.q[i] = seg.q1[i];
          this.queue.shift();
          if (this.queue.length === 0) this.phase = this.heldId ? `holding ${this.heldId}` : 'idle';
          this.syncKinematics();
          seg.resolve();
          return;
        }
      }
    }
    this.syncKinematics();
  }

  private syncKinematics(): void {
    this.model.setPose(this.q);
    this.tcpNow = this.model.tcp();
    if (this.heldId) {
      const o = this.objects.get(this.heldId);
      if (o) {
        o.pos = [
          this.tcpNow[0] + this.heldOffset[0],
          this.tcpNow[1] + this.heldOffset[1],
          this.tcpNow[2] + this.heldOffset[2],
        ];
      } else {
        this.heldId = null;
      }
    }
  }

  /** Current tcp (root frame, metres). */
  tcp(): Vec3 {
    return [...this.tcpNow] as Vec3;
  }

  tcpMm(): Vec3 {
    return [Math.round(this.tcpNow[0] * 1000), Math.round(this.tcpNow[1] * 1000), Math.round(this.tcpNow[2] * 1000)];
  }

  /** Joint target at the end of the queue (what the next segment starts from). */
  targetQ(): number[] {
    return [...this.tail];
  }

  jawOpen(): boolean {
    return this.q[5] >= JAW_OPEN - 0.05;
  }

  // ---- low-level motion (used by primitives only) ----

  private enqueue(q1: number[], durS: number, label: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const q0 = [...this.tail];
      this.tail = [...q1];
      this.queue.push({ q0, q1: [...q1], durS, u: 0, started: false, label, resolve, reject });
    });
  }

  /** Move the arm joints (5 values keep the jaw; 6 set it). Duration from the largest joint delta. */
  move(target: ArrayLike<number>, label: string, durS?: number): Promise<void> {
    const q1 = [...this.tail];
    for (let i = 0; i < Math.min(target.length, 6); i++) q1[i] = target[i];
    let maxD = 0;
    for (let i = 0; i < 6; i++) maxD = Math.max(maxD, Math.abs(q1[i] - this.tail[i]));
    const d = durS ?? Math.max(MIN_SEG_S, maxD / JOINT_SPEED);
    return this.enqueue(q1, d, label);
  }

  setJaw(v: number, durS: number, label: string): Promise<void> {
    const q1 = [...this.tail];
    q1[5] = v;
    return this.enqueue(q1, Math.max(0.05, durS), label);
  }

  hold(durS: number, label: string): Promise<void> {
    return this.enqueue([...this.tail], Math.max(0.05, durS), label);
  }

  /** Attach an object to the gripper (registry pos follows the tcp from now on). */
  attach(id: string): void {
    const o = this.objects.get(id);
    if (!o) return;
    this.heldId = id;
    o.held = true;
    this.heldOffset = [o.pos[0] - this.tcpNow[0], o.pos[1] - this.tcpNow[1], o.pos[2] - this.tcpNow[2]];
  }

  /** Release the held object at its rest height under the current tcp. */
  release(): string | null {
    const id = this.heldId;
    if (!id) return null;
    const o = this.objects.get(id);
    this.heldId = null;
    if (o) {
      o.held = false;
      const x = this.tcpNow[0];
      const y = this.tcpNow[1];
      o.pos = [x, y, this.objects.restZ(o, x, y)];
    }
    return id;
  }

  /** Reject every pending motion promise with ABORTED and freeze in place. */
  abortAll(reason: string): void {
    const pending = this.queue;
    this.queue = [];
    this.tail = [...this.q];
    this.phase = `ABORTED: ${reason}`;
    const r = abortedResult(reason);
    for (const s of pending) s.reject(r);
  }

  snapshot(): ArmSnapshot {
    return {
      q: [...this.q],
      tcp: this.tcp(),
      jaw: this.q[5],
      jawOpen: this.jawOpen(),
      phase: this.phase,
      heldId: this.heldId,
      queueLen: this.queue.length,
    };
  }

  okResult(): PrimResult {
    return { ok: true, tcp_mm: this.tcpMm(), held: this.heldId, phase: this.phase };
  }

  // ---- ArmApi: the ONLY surface exposed to Gemini ----

  pick(id: string): Promise<PrimResult> {
    return prim.pick(this, id);
  }
  placeInTray(): Promise<PrimResult> {
    return prim.placeInTray(this);
  }
  placeAt(xy: [number, number]): Promise<PrimResult> {
    return prim.placeAt(this, xy);
  }
  moveTo(p: Vec3): Promise<PrimResult> {
    return prim.moveTo(this, p);
  }
  home(): Promise<PrimResult> {
    return prim.home(this);
  }
  open(): Promise<PrimResult> {
    return prim.open(this);
  }
  close(): Promise<PrimResult> {
    return prim.close(this);
  }
}
