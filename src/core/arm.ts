// Arm controller: a joint-space segment queue with easing, teleop servoing, and the validated
// pick / place / home primitives. Kinematic only: a sample attaches by rule and rests where it
// is released (deck, containment floor, or the top of the sample below).
//
// Call step(dt, speedFactor) every frame (createBay's step passes the gate's speed factor).
// speedFactor 0 (STOP) freezes mid-move; abortAll (ESTOP) cancels everything in flight.

import type { ArmApi, ArmSnapshot, GateApi, MoveResult, PrimCode, Sample, Vec3 } from '../contracts';
import {
  CONTAINMENT_INNER,
  CONTAINMENT_OUTER_HALF,
  CONTAINMENT_XY,
  DECK_CLEARANCE,
  HOME_Q,
  JAW_OPEN,
  MIN_SPACING,
  REACH,
  SPACING_EXTRA,
  STACK_MAX_H,
  Z_CONTAINMENT_LOWER,
  Z_HOVER,
  Z_LIFT,
  bearingOf,
  graspOffset,
  graspZ,
  jawForGap,
  jawForWidth,
  polarXY,
  rhoOf,
} from './constants';
import { IK_TOL, IkSolver, wrapPi, type IkResult } from './ik';
import { ArmModel, NUM_JOINTS } from './model';
import { SampleRegistry, gripWidthMm, sampleRadius } from './samples';
import { GateError } from './gate';

export type ArmLog = (text: string, kind: 'info' | 'safety' | 'reject') => void;

export interface ArmOptions {
  log?: ArmLog;
  /** max joint speed at speedFactor 1 (rad/s): arm joints, gripper */
  jointSpeed?: number;
  gripperSpeed?: number;
  /** teleop servo: max joint speed (rad/s) and proportional gain (1/s) */
  servoSpeed?: number;
  servoGain?: number;
}

type Fail = { ok: false; code: PrimCode; reason: string };
const fail = (code: PrimCode, reason: string): Fail => ({ ok: false, code, reason });
const mmStr = (m: number): string => `${Math.round(m * 1000)} mm`;

interface Segment {
  path: number[][];
  phase: string;
  started: boolean;
  dur: number;
  t: number;
  cum: number[];
  job: Job;
  onStart?: () => void;
  /** runs inside step when the segment completes; may cancel the rest of its job */
  onDone?: () => void;
}

interface Job {
  name: string;
  done: boolean;
  resolve: (r: MoveResult) => void;
  /** result once the last segment completes */
  result: () => MoveResult;
}

/** vertical (approach / retreat) waypoint spacing and horizontal transit spacing, metres */
const VSTEP = 0.01;
const HSTEP = 0.015;
/** how far above its rest surface a sample is released */
const DROP_GAP = 0.002;
const MIN_SEG = 0.25;

function smoothstep5(s: number): number {
  return s * s * s * (s * (s * 6 - 15) + 10);
}

export class Arm implements ArmApi {
  readonly model: ArmModel;
  readonly samples: SampleRegistry;
  readonly gate: GateApi;
  readonly ik: IkSolver;
  private readonly q: number[];
  private queue: Segment[] = [];
  private servoTarget: Vec3 | null = null;
  private servoNote = '';
  private inFlight = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private abortCtl = new AbortController();
  private heldId: string | null = null;
  /** held sample centre in the gripper body frame, and yaw relative to the jaw axis */
  private heldLocal: Vec3 = [0, 0, 0];
  private heldYawOff = 0;
  private phase = 'idle';
  private readonly log: ArmLog;
  private readonly jointSpeed: number;
  private readonly gripperSpeed: number;
  private readonly servoSpeed: number;
  private readonly servoGain: number;

  constructor(model: ArmModel, samples: SampleRegistry, gate: GateApi, opts: ArmOptions = {}) {
    this.model = model;
    this.samples = samples;
    this.gate = gate;
    this.ik = new IkSolver(model.data);
    this.log = opts.log ?? (() => {});
    this.jointSpeed = opts.jointSpeed ?? 1.2;
    this.gripperSpeed = opts.gripperSpeed ?? 2.5;
    this.servoSpeed = opts.servoSpeed ?? 1.6;
    this.servoGain = opts.servoGain ?? 8;
    this.q = HOME_Q.slice();
    this.model.setPose(this.q);
  }

  // ---------- state ----------

  /** live joint values (copy) */
  joints(): number[] {
    return this.q.slice();
  }
  /** teleport to a pose (tests / reset); clears the queue and the servo target */
  setJoints(q: ArrayLike<number>): void {
    for (let j = 0; j < NUM_JOINTS; j++) this.q[j] = q[j] ?? this.q[j];
    this.model.setPose(this.q);
    for (let j = 0; j < NUM_JOINTS; j++) this.q[j] = this.model.q[j];
    this.followHeld();
  }

  busy(): boolean {
    return this.queue.length > 0 || this.inFlight > 0;
  }

  snapshot(): ArmSnapshot {
    const lo = this.model.ranges[5][0];
    const jawOpen = Math.max(0, Math.min(1, (this.q[5] - lo) / (JAW_OPEN - lo)));
    return { q: this.q.slice(), tcp: this.model.tcp(), jawOpen, phase: this.phase, heldId: this.heldId, busy: this.busy() };
  }

  // ---------- stepping ----------

  step(dtIn: number, speedFactor: number = this.gate.speedFactor()): void {
    const sf = Math.max(0, Math.min(1, speedFactor));
    if (!(dtIn > 0)) return;
    // a backgrounded tab can hand us a huge dt; never jump more than 0.1 s at once
    const dt = Math.min(dtIn, 0.1);
    if (this.queue.length > 0) {
      const seg = this.queue[0];
      if (!seg.started) this.startSegment(seg);
      seg.t += dt * sf;
      const s = Math.min(1, seg.t / seg.dur);
      this.sampleSegment(seg, smoothstep5(s));
      this.model.setPose(this.q);
      this.followHeld();
      if (s >= 1) {
        this.queue.shift();
        seg.onDone?.();
        if (!seg.job.done && !this.queue.some((x) => x.job === seg.job)) {
          seg.job.done = true;
          seg.job.resolve(seg.job.result());
        }
      }
      return;
    }
    if (this.servoTarget && this.inFlight === 0 && sf > 0) this.servoStep(dt, sf);
  }

  private startSegment(seg: Segment): void {
    seg.started = true;
    seg.path[0] = this.q.slice();
    seg.cum = [0];
    let total = 0;
    let time = 0;
    for (let i = 1; i < seg.path.length; i++) {
      let d = 0;
      let tm = 0;
      for (let j = 0; j < NUM_JOINTS; j++) {
        const dj = Math.abs(seg.path[i][j] - seg.path[i - 1][j]);
        d = Math.max(d, dj);
        tm = Math.max(tm, dj / (j === 5 ? this.gripperSpeed : this.jointSpeed));
      }
      total += d;
      time += tm;
      seg.cum.push(total);
    }
    // quintic easing peaks at 1.875x the mean speed
    seg.dur = Math.max(MIN_SEG, time * 1.875);
    if (total > 0) seg.cum = seg.cum.map((c) => c / total);
    else seg.cum = seg.cum.map((_, i) => (seg.path.length > 1 ? i / (seg.path.length - 1) : 1));
    this.phase = seg.phase;
    seg.onStart?.();
  }

  private sampleSegment(seg: Segment, e: number): void {
    const p = seg.path;
    if (p.length === 1) {
      for (let j = 0; j < NUM_JOINTS; j++) this.q[j] = p[0][j];
      return;
    }
    let i = 1;
    while (i < p.length - 1 && seg.cum[i] < e) i++;
    const c0 = seg.cum[i - 1];
    const c1 = seg.cum[i];
    const u = c1 > c0 ? Math.max(0, Math.min(1, (e - c0) / (c1 - c0))) : 1;
    for (let j = 0; j < NUM_JOINTS; j++) this.q[j] = p[i - 1][j] + (p[i][j] - p[i - 1][j]) * u;
  }

  private servoStep(dt: number, sf: number): void {
    const target = this.servoTarget!;
    const res = this.ik.solve(target, this.q[4], this.q, { maxIters: 12 });
    if (res.err > IK_TOL) {
      this.phase = 'teleop: unreachable target';
      this.servoNote = `the hover target is out of reach (error ${mmStr(res.err)})`;
      return;
    }
    this.phase = 'teleop';
    const lim = this.servoSpeed * sf * dt;
    const k = Math.min(1, this.servoGain * dt);
    for (let j = 0; j < 4; j++) {
      const d = (res.q[j] - this.q[j]) * k;
      this.q[j] += Math.max(-lim, Math.min(lim, d));
    }
    this.model.setPose(this.q);
    this.followHeld();
  }

  /** a held sample follows the gripper */
  private followHeld(): void {
    if (!this.heldId) return;
    const p = this.model.gripperPoint(this.heldLocal);
    const ja = this.jawAngle();
    this.samples.updatePose(this.heldId, p, wrapPi(ja + this.heldYawOff));
  }

  private jawAngle(): number {
    const a = this.model.jawAxis();
    return Math.atan2(a[1], a[0]);
  }

  // ---------- teleop ----------

  servoTo(target: Vec3 | null): void {
    if (this.busy()) return;
    if (target === null) {
      this.servoTarget = null;
      this.phase = 'holding';
      return;
    }
    if (!target.every(Number.isFinite)) return;
    this.servoTarget = [target[0], target[1], target[2]];
    if (this.phase === 'idle' || this.phase === 'holding' || this.phase.startsWith('done')) this.phase = 'teleop';
  }

  /** why the last servo target was refused ('' when following) */
  servoStatus(): string {
    return this.phase.includes('unreach') ? this.servoNote : '';
  }

  // ---------- abort ----------

  abortAll(reason: string): void {
    this.epoch++;
    this.abortCtl.abort();
    this.abortCtl = new AbortController();
    this.servoTarget = null;
    const jobs = new Set(this.queue.map((s) => s.job));
    this.queue = [];
    for (const j of jobs) {
      if (j.done) continue;
      j.done = true;
      j.resolve(fail('ABORTED', `the ${j.name} was cancelled (${reason}).`));
    }
    this.phase = 'aborted';
    this.log(`arm: all moves cancelled (${reason})`, 'safety');
  }

  // ---------- primitives ----------

  pick(id: string): Promise<MoveResult> {
    return this.primitive('pick', () => this.planPick(id));
  }
  placeAt(xy: [number, number]): Promise<MoveResult> {
    return this.primitive('place', () => this.planPlace(xy, false));
  }
  placeInContainment(): Promise<MoveResult> {
    return this.primitive('containment place', () => this.planPlace(null, true));
  }
  home(): Promise<MoveResult> {
    return this.primitive('home move', () => this.planHome());
  }

  /** serialise primitives, wait for the gate, plan (all waypoints IK-checked), then run */
  private primitive(name: string, plan: () => Fail | ((job: Job) => Segment[])): Promise<MoveResult> {
    const epoch = this.epoch;
    const signal = this.abortCtl.signal;
    this.inFlight++;
    this.servoTarget = null;
    const run = async (): Promise<MoveResult> => {
      if (this.epoch !== epoch) return fail('ABORTED', `the ${name} was cancelled before it started.`);
      try {
        await this.gate.waitRunnable(signal);
      } catch (e) {
        if (e instanceof GateError && e.code === 'ESTOPPED') return fail('REJECTED_STATE', `the ${name} cannot run: ${e.message}`);
        return fail('ABORTED', `the ${name} was cancelled while waiting for the bay.`);
      }
      if (this.epoch !== epoch) return fail('ABORTED', `the ${name} was cancelled before it started.`);
      const planned = plan();
      if (typeof planned !== 'function') {
        this.log(`${name} refused: ${planned.reason}`, 'reject');
        return planned;
      }
      this.servoTarget = null;
      return new Promise<MoveResult>((resolve) => {
        const job: Job = { name, done: false, resolve, result: () => this.okResult() };
        const segs = planned(job);
        if (segs.length === 0) {
          job.done = true;
          resolve(job.result());
          return;
        }
        this.queue.push(...segs);
      });
    };
    const safeRun = async (): Promise<MoveResult> => {
      try {
        return await run();
      } catch (e) {
        // planning must never reject the caller's promise
        return fail('UNREACHABLE', `the ${name} could not be planned (${e instanceof Error ? e.message : String(e)}).`);
      }
    };
    const p = this.chain.then(safeRun, safeRun).finally(() => {
      this.inFlight--;
      if (this.queue.length === 0 && this.inFlight === 0 && this.phase !== 'aborted') this.phase = 'idle';
    });
    this.chain = p.catch(() => undefined);
    return p;
  }

  private okResult(): MoveResult {
    const t = this.model.tcp();
    return { ok: true, tcp_mm: [t[0] * 1000, t[1] * 1000, t[2] * 1000], held: this.heldId };
  }

  private seg(job: Job, phase: string, path: number[][], extra: Partial<Segment> = {}): Segment {
    return { path: [this.q.slice(), ...path], phase, started: false, dur: MIN_SEG, t: 0, cum: [], job, ...extra };
  }

  /** IK a gripper-down TCP target with a fixed roll, warm-started; null if unreachable */
  private solveAt(x: number, y: number, z: number, roll: number, seed: ArrayLike<number>, grip: number): number[] | null {
    const r: IkResult = this.ik.solve([x, y, z], roll, seed);
    if (r.err > IK_TOL) return null;
    const q = r.q.slice();
    q[5] = grip;
    return q;
  }

  /** vertical waypoints (inclusive of the end) from z0 to z1 at xy */
  private vertical(x: number, y: number, z0: number, z1: number, roll: number, seed: number[], grip: number): number[][] | null {
    const n = Math.max(1, Math.ceil(Math.abs(z1 - z0) / VSTEP));
    const out: number[][] = [];
    let s = seed;
    for (let i = 1; i <= n; i++) {
      const q = this.solveAt(x, y, z0 + ((z1 - z0) * i) / n, roll, s, grip);
      if (!q) return null;
      out.push(q);
      s = q;
    }
    return out;
  }

  /** polar transit at height z from xy0 to xy1 (roll and gripper interpolated), end inclusive */
  private transit(xy0: [number, number], xy1: [number, number], z: number, roll0: number, roll1: number, seed: number[], grip0: number, grip1: number): number[][] | null {
    const r0 = rhoOf(xy0[0], xy0[1]);
    const r1 = rhoOf(xy1[0], xy1[1]);
    const b0 = bearingOf(xy0[0], xy0[1]);
    const b1 = bearingOf(xy1[0], xy1[1]);
    const len = Math.hypot(r1 - r0, ((r0 + r1) / 2) * (b1 - b0));
    const n = Math.max(1, Math.min(40, Math.ceil(len / HSTEP)));
    const out: number[][] = [];
    let s = seed;
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      const [x, y] = i === n ? xy1 : polarXY(r0 + (r1 - r0) * f, b0 + (b1 - b0) * f);
      const q = this.solveAt(x, y, z, roll0 + (roll1 - roll0) * f, s, grip0 + (grip1 - grip0) * f);
      if (!q) return null;
      out.push(q);
      s = q;
    }
    return out;
  }

  /**
   * Waypoints from the live pose to a gripper-down pose at height z above xy: rise (or settle)
   * vertically at the current xy, then a polar transit. Falls back to a direct joint move when
   * the current pose is not a gripper-down pose the IK can continue from.
   */
  private approach(xy: [number, number], z: number, roll: number, grip: number): number[][] | null {
    const tcp = this.model.tcp();
    const here: [number, number] = [tcp[0], tcp[1]];
    const roll0 = this.q[4];
    const rise = this.solveAt(here[0], here[1], z, roll0, this.q, this.q[5]);
    if (rise) {
      const tr = this.transit(here, xy, z, roll0, roll, rise, this.q[5], grip);
      if (tr) return [rise, ...tr];
    }
    const direct = this.solveAt(xy[0], xy[1], z, roll, this.q, grip);
    return direct ? [direct] : null;
  }

  private unreachable(what: string, x: number, y: number): Fail {
    const r = rhoOf(x, y);
    const b = Math.abs(bearingOf(x, y));
    if (r < REACH.rhoMin || r > REACH.rhoMax) {
      return fail('UNREACHABLE', `${what} is ${mmStr(r)} from the arm's axis, and the gripper only works between ${mmStr(REACH.rhoMin)} and ${mmStr(REACH.rhoMax)}.`);
    }
    if (b > REACH.bearingMax) {
      return fail('UNREACHABLE', `${what} is ${Math.round((b * 180) / Math.PI)} degrees to the side, beyond the ${Math.round((REACH.bearingMax * 180) / Math.PI)} degrees the arm works in.`);
    }
    return fail('UNREACHABLE', `the arm cannot reach ${what} with the gripper pointing down, at ${mmStr(r)} from its axis.`);
  }

  // ----- pick -----
  private planPick(id: string): Fail | ((job: Job) => Segment[]) {
    const s = this.samples.get(id) ?? this.samples.resolve(id);
    if (!s) return fail('NO_SAMPLE', `there is no sample called ${id} in the bay.`);
    if (this.heldId) {
      const h = this.samples.get(this.heldId);
      return fail('ALREADY_HELD', `the gripper is already holding ${h?.name ?? this.heldId}; place it first.`);
    }
    if (s.held) return fail('ALREADY_HELD', `${s.name} is already in the gripper.`);
    const top = this.samples.coveredBy(s.id);
    if (top) return fail('UNREACHABLE', `${s.name} is under ${top.name}; pick ${top.name} first.`);
    const plan = this.graspPlan(s);
    if ('ok' in plan) return plan;
    const { qHover, descend, qLift, x, y } = plan;
    const grip = jawForWidth(gripWidthMm(s));
    const toHover = this.approach([qHover.tcp[0], qHover.tcp[1]], Z_HOVER, qHover.q[4], JAW_OPEN);
    if (!toHover) return this.unreachable(s.name, x, y);
    const closed = descend[descend.length - 1].slice();
    closed[5] = grip;
    const lift = qLift.map((q) => {
      const c = q.slice();
      c[5] = grip;
      return c;
    });
    return (job) => {
      const segs: Segment[] = [];
      segs.push(this.seg(job, `pick ${s.name}: moving to hover`, toHover));
      segs.push(this.seg(job, `pick ${s.name}: descending`, descend));
      const close = this.seg(job, `pick ${s.name}: closing jaw`, [closed]);
      close.onDone = () => {
        const tcp = this.model.tcp();
        const cand = this.samples.attachCandidate(tcp, s.id);
        if (!cand) {
          // missed: drop the rest of this job, reopen and back off
          this.queue = this.queue.filter((x2) => x2.job !== job);
          const open = closed.slice();
          open[5] = JAW_OPEN;
          const back = [...descend.slice(0, -1).reverse(), qHover.q].map((q) => {
            const c = q.slice();
            c[5] = JAW_OPEN;
            return c;
          });
          job.result = () => fail('GRASP_MISSED', `the jaw closed but ${s.name} was not between the fingers; it may have moved.`);
          this.queue.unshift(this.seg(job, `pick ${s.name}: reopening`, [open]), this.seg(job, `pick ${s.name}: backing off`, back));
          this.log(`grasp missed on ${s.name}`, 'reject');
          return;
        }
        this.attach(cand);
      };
      segs.push(close);
      segs.push(this.seg(job, `pick ${s.name}: lifting`, lift));
      return segs;
    };
  }

  /** IK plan for grasping s: hover, descend waypoints and lift, all checked */
  private graspPlan(s: Sample): Fail | { qHover: { q: number[]; tcp: Vec3 }; descend: number[][]; qLift: number[][]; x: number; y: number } {
    const [x, y] = [s.pos[0], s.pos[1]];
    const bottom = s.pos[2] - s.dims.h / 2;
    const zGrasp = bottom + graspZ(s.dims.h);
    const off = graspOffset(gripWidthMm(s));
    const sol = this.ik.solveJawYaw(s.yaw, (u) => [x + off * u[0], y + off * u[1], zGrasp], this.q[4], this.q);
    if (sol.err > IK_TOL) return this.unreachable(s.name, x, y);
    const roll = sol.q[4];
    const tx = sol.target[0];
    const ty = sol.target[1];
    const hoverQ = this.solveAt(tx, ty, Z_HOVER, roll, sol.q, JAW_OPEN);
    if (!hoverQ) return this.unreachable(`the spot above ${s.name}`, x, y);
    const descend = this.vertical(tx, ty, Z_HOVER, zGrasp, roll, hoverQ, JAW_OPEN);
    if (!descend) return this.unreachable(s.name, x, y);
    const lift = this.vertical(tx, ty, zGrasp, Z_LIFT, roll, descend[descend.length - 1], JAW_OPEN);
    if (!lift) return this.unreachable(`the carry height above ${s.name}`, x, y);
    return { qHover: { q: hoverQ, tcp: [tx, ty, Z_HOVER] }, descend, qLift: lift, x, y };
  }

  private attach(s: Sample): void {
    // remember the sample's pose relative to the gripper body
    const g = this.model.bodyPose('gripper');
    const d: Vec3 = [s.pos[0] - g.pos[0], s.pos[1] - g.pos[1], s.pos[2] - g.pos[2]];
    const [qx, qy, qz, qw] = g.quat;
    // rotate d by the inverse quaternion
    const ix = qw * d[0] - qy * d[2] + qz * d[1];
    const iy = qw * d[1] - qz * d[0] + qx * d[2];
    const iz = qw * d[2] - qx * d[1] + qy * d[0];
    const iw = qx * d[0] + qy * d[1] + qz * d[2];
    this.heldLocal = [ix * qw + iw * qx + iy * qz - iz * qy, iy * qw + iw * qy + iz * qx - ix * qz, iz * qw + iw * qz + ix * qy - iy * qx];
    this.heldYawOff = wrapPi(s.yaw - this.jawAngle());
    this.heldId = s.id;
    this.samples.setHeld(s.id, true);
    this.log(`picked ${s.name}`, 'info');
  }

  private release(): Sample | undefined {
    if (!this.heldId) return undefined;
    const id = this.heldId;
    const s = this.samples.get(id);
    this.heldId = null;
    if (!s) return undefined;
    const rest = this.samples.restZ(s, s.pos[0], s.pos[1]);
    this.samples.updatePose(id, [s.pos[0], s.pos[1], rest.z], s.yaw);
    this.samples.setHeld(id, false);
    this.log(`released ${s.name} on the ${rest.on === 'sample' ? 'sample below' : rest.on}`, 'info');
    return this.samples.get(id);
  }

  // ----- place -----
  private planPlace(xyIn: [number, number] | null, containment: boolean): Fail | ((job: Job) => Segment[]) {
    if (!this.heldId) return fail('NOTHING_HELD', 'the gripper is not holding anything to place.');
    const s = this.samples.get(this.heldId);
    if (!s) return fail('NOTHING_HELD', 'the held sample no longer exists.');
    let xy: [number, number];
    if (containment) {
      const spot = this.containmentSpot(s);
      if ('ok' in spot) return spot;
      xy = spot.xy;
    } else {
      if (!xyIn || !xyIn.every(Number.isFinite)) return fail('UNREACHABLE', 'the place position must be two numbers in metres.');
      xy = [xyIn[0], xyIn[1]];
      const bad = this.checkPlaceSpot(s, xy);
      if (bad) return bad;
    }
    const rest = this.samples.restZ(s, xy[0], xy[1]);
    // TCP height: keep the held offset between the TCP and the sample's bottom
    const tcpNow = this.model.tcp();
    const bottomBelowTcp = tcpNow[2] - (s.pos[2] - s.dims.h / 2);
    let zPlace = rest.support + bottomBelowTcp + DROP_GAP;
    if (rest.on === 'containment') zPlace = Math.max(zPlace, Z_CONTAINMENT_LOWER);
    zPlace = Math.max(zPlace, rest.support + DECK_CLEARANCE + 0.006);
    // TCP xy so the sample centre lands on xy: the held offset rotates with the pan
    const offNow: [number, number] = [s.pos[0] - tcpNow[0], s.pos[1] - tcpNow[1]];
    const roll = this.q[4];
    const ja0 = this.jawAngle();
    let txy: [number, number] = [xy[0] - offNow[0], xy[1] - offNow[1]];
    let qEnd: number[] | null = null;
    for (let it = 0; it < 4; it++) {
      qEnd = this.solveAt(txy[0], txy[1], Z_LIFT, roll, qEnd ?? this.q, this.q[5]);
      if (!qEnd) break;
      const da = this.ik.jawAngleAt(qEnd) - ja0;
      const c = Math.cos(da);
      const sn = Math.sin(da);
      txy = [xy[0] - (c * offNow[0] - sn * offNow[1]), xy[1] - (sn * offNow[0] + c * offNow[1])];
    }
    const where = containment ? 'the containment bin' : 'that spot';
    const grip = this.q[5];
    const toLift = this.approach(txy, Z_LIFT, roll, grip);
    if (!toLift) return this.unreachable(where, xy[0], xy[1]);
    const lower = this.vertical(txy[0], txy[1], Z_LIFT, zPlace, roll, toLift[toLift.length - 1], grip);
    if (!lower) return this.unreachable(where, xy[0], xy[1]);
    const openGrip = Math.min(JAW_OPEN, jawForGap(gripWidthMm(s) / 1000 + 0.015));
    const atBottom = lower[lower.length - 1];
    const opened = atBottom.slice();
    opened[5] = openGrip;
    const retreat = this.vertical(txy[0], txy[1], zPlace, Z_HOVER, roll, atBottom, openGrip);
    if (!retreat) return this.unreachable(where, xy[0], xy[1]);
    const label = containment ? `contain ${s.name}` : `place ${s.name}`;
    return (job) => {
      const open = this.seg(job, `${label}: opening jaw`, [opened]);
      open.onStart = () => {
        this.release();
      };
      return [this.seg(job, `${label}: carrying`, toLift), this.seg(job, `${label}: lowering`, lower), open, this.seg(job, `${label}: retreating`, retreat)];
    };
  }

  /** reasons a held sample cannot be put down at xy (deck placement) */
  private checkPlaceSpot(s: Sample, xy: [number, number]): Fail | null {
    const [x, y] = xy;
    const r = rhoOf(x, y);
    if (r < REACH.rhoMin || r > REACH.rhoMax || Math.abs(bearingOf(x, y)) > REACH.bearingMax) return this.unreachable('that spot', x, y);
    const rest = this.samples.restZ(s, x, y);
    if (rest.on === 'wall') return fail('UNREACHABLE', `that spot is on the containment bin's wall; place it inside the bin or away from it.`);
    const rad = sampleRadius(s.dims);
    if (rest.on !== 'sample') {
      // the whole footprint, not only the centre, must clear the wall: inside the inner face or past the outer one
      const m = Math.max(Math.abs(x - CONTAINMENT_XY[0]), Math.abs(y - CONTAINMENT_XY[1]));
      if (m > CONTAINMENT_INNER / 2 - rad && m < CONTAINMENT_OUTER_HALF + rad) {
        return fail('UNREACHABLE', `${s.name} would rest across the containment bin's wall there; place it inside the bin or at least ${mmStr(CONTAINMENT_OUTER_HALF + rad)} from the bin centre on each side.`);
      }
    }
    if (rest.on === 'deck') {
      for (const o of this.samples.list()) {
        if (o.id === s.id || o.held) continue;
        const need = Math.max(MIN_SPACING, rad + sampleRadius(o.dims) + SPACING_EXTRA);
        const d = Math.hypot(x - o.pos[0], y - o.pos[1]);
        if (d < need - 1e-9) return fail('UNREACHABLE', `that spot is ${mmStr(d)} from ${o.name}; leave at least ${mmStr(need)} between their centres so the jaw has room.`);
      }
    }
    if (rest.on === 'sample') {
      const under = this.samples.get(rest.underId!)!;
      const d = Math.hypot(x - under.pos[0], y - under.pos[1]);
      const inner = Math.min(under.dims.w, under.dims.d) / 2;
      if (d > inner) {
        const need = sampleRadius(s.dims) + sampleRadius(under.dims);
        return fail('UNREACHABLE', `that spot overlaps ${under.name} by ${mmStr(need - d)}; put it right on top or at least ${mmStr(need)} away from its centre.`);
      }
      if (rest.support + s.dims.h > STACK_MAX_H + 1e-9) {
        return fail('UNREACHABLE', `stacking ${s.name} on ${under.name} would make a ${mmStr(rest.support + s.dims.h)} tower, taller than the ${mmStr(STACK_MAX_H)} the arm can carry over.`);
      }
    }
    return null;
  }

  /** a free spot in the bin: the free floor spot nearest the centre, else on top of the centre */
  private containmentSpot(s: Sample): Fail | { xy: [number, number] } {
    const [cx, cy] = CONTAINMENT_XY;
    const lim = CONTAINMENT_INNER / 2 - sampleRadius(s.dims) - 0.002;
    const cands: [number, number][] = [];
    for (let dx = -lim; dx <= lim + 1e-9; dx += 0.004) {
      for (let dy = -lim; dy <= lim + 1e-9; dy += 0.004) cands.push([cx + dx, cy + dy]);
    }
    cands.push([cx, cy]);
    cands.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
    for (const c of cands) {
      const r = rhoOf(c[0], c[1]);
      if (r < REACH.rhoMin || r > REACH.rhoMax) continue;
      if (this.samples.restZ(s, c[0], c[1]).on === 'containment') return { xy: c };
    }
    const rest = this.samples.restZ(s, cx, cy);
    if (rest.on === 'sample' && rest.support + s.dims.h <= STACK_MAX_H) return { xy: [cx, cy] };
    return fail('UNREACHABLE', `the containment bin is full; there is no room for ${s.name}.`);
  }

  // ----- home -----
  private planHome(): Fail | ((job: Job) => Segment[]) {
    const tcp = this.model.tcp();
    const target = HOME_Q.slice();
    if (this.heldId) target[5] = this.q[5];
    const path: number[][] = [];
    if (tcp[2] < Z_HOVER - 0.005) {
      const up = this.vertical(tcp[0], tcp[1], tcp[2], Z_HOVER, this.q[4], this.q, this.q[5]);
      if (up) path.push(...up);
    }
    path.push(target);
    return (job) => [this.seg(job, 'home: moving home', path)];
  }

  // ---------- probes for the registry ----------

  /** can the arm hover, grasp and lift a sample placed here (gripper down, any jaw side)? */
  reachProbe(p: { x: number; y: number; yaw: number; h: number; gripWidthMm: number }): string | null {
    const off = graspOffset(p.gripWidthMm);
    const zg = graspZ(p.h);
    const sol = this.ik.solveJawYaw(p.yaw, (u) => [p.x + off * u[0], p.y + off * u[1], zg], 0);
    if (sol.err > IK_TOL) return 'grasp';
    for (const z of [Z_HOVER, Z_LIFT]) {
      const r = this.ik.solve([sol.target[0], sol.target[1], z], sol.q[4], sol.q);
      if (r.err > IK_TOL) return z === Z_HOVER ? 'hover' : 'lift';
    }
    return null;
  }
}

