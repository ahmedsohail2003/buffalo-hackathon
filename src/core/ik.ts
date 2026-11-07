// Damped-least-squares IK for the SO-101 with the gripper held pointing straight down.
//
// Unknowns: shoulder_pan, shoulder_lift, elbow_flex, wrist_flex. wrist_roll is an input (the
// caller picks it, see wrapRoll), the gripper joint does not move the TCP.
// Residual: TCP position error (3, metres) plus the approach-axis error (3, scaled by
// ORIENT_WEIGHT metres per unit) so the approach axis stays at (0, 0, -1).
// Levenberg-Marquardt style damping (lambda grows when a step makes things worse), joint limits
// by clamping, a few seeds when a warm start is missing or fails. Never throws.

import type { Vec3 } from '../contracts';
import { Kinematics, type So101Data } from './model';

export interface IkResult {
  /** all six joints; wrist_roll as given, gripper copied from the seed */
  q: number[];
  /** combined error, metres: hypot(position error, ORIENT_WEIGHT * tilt). Callers reject err > 1e-3. */
  err: number;
  /** position error, metres */
  posErr: number;
  /** angle between the approach axis and straight down, radians */
  tilt: number;
  iters: number;
}

/** metres of error charged per radian of tilt (about the wrist-to-fingertip lever arm) */
export const ORIENT_WEIGHT = 0.1;
/** the error every caller treats as "reachable" */
export const IK_TOL = 1e-3;

const ARM_JOINTS = 4;

export function wrapPi(a: number): number {
  let r = (a + Math.PI) % (2 * Math.PI);
  if (r < 0) r += 2 * Math.PI;
  return r - Math.PI;
}

/**
 * A parallel jaw grips the same rotated by pi, so a wrist roll is free modulo pi. Return the
 * equivalent roll (roll + k*pi) inside [lo, hi] closest to ref (default 0).
 */
export function wrapRoll(roll: number, range: [number, number], ref = 0): number {
  let best = Number.NaN;
  for (let k = -4; k <= 4; k++) {
    const r = roll + k * Math.PI;
    if (r < range[0] || r > range[1]) continue;
    if (Number.isNaN(best) || Math.abs(r - ref) < Math.abs(best - ref)) best = r;
  }
  if (Number.isNaN(best)) best = Math.min(range[1], Math.max(range[0], roll));
  return best;
}

export interface SolveOptions {
  maxIters?: number;
  /** stop when the position error is below this (m) and the tilt below tiltTol (rad) */
  posTol?: number;
  tiltTol?: number;
}

export class IkSolver {
  readonly kin: Kinematics;
  readonly ranges: [number, number][];
  private readonly qa = new Float64Array(6);
  private readonly qb = new Float64Array(6);
  private readonly t = new Float64Array(3);
  private readonly a = new Float64Array(3);
  private readonly ax = new Float64Array(3);
  private readonly an = new Float64Array(3);
  private readonly J = new Float64Array(6 * ARM_JOINTS);
  private readonly r = new Float64Array(6);
  private readonly A = new Float64Array(ARM_JOINTS * ARM_JOINTS);
  private readonly b = new Float64Array(ARM_JOINTS);
  private readonly dq = new Float64Array(ARM_JOINTS);
  /** default pitch seeds [lift, elbow, wrist_flex] for cold starts (gripper-down family) */
  seeds: number[][] = [
    [0.0, 0.0, 1.5],
    [-0.8, 0.9, 1.4],
    [0.6, -0.4, 1.4],
    [-1.4, 1.5, 1.0],
    [0.9, 0.6, 0.2],
  ];

  constructor(model: Kinematics | So101Data) {
    this.kin = model instanceof Kinematics ? model : new Kinematics(model);
    this.ranges = this.kin.ranges;
  }

  /** evaluate the residual at q (fills this.r); returns [posErr, tilt] */
  private residual(q: Float64Array, target: Vec3): [number, number] {
    const k = this.kin;
    k.compute(q);
    k.tcp(this.t);
    k.approach(this.a);
    const r = this.r;
    r[0] = target[0] - this.t[0];
    r[1] = target[1] - this.t[1];
    r[2] = target[2] - this.t[2];
    r[3] = ORIENT_WEIGHT * (0 - this.a[0]);
    r[4] = ORIENT_WEIGHT * (0 - this.a[1]);
    r[5] = ORIENT_WEIGHT * (-1 - this.a[2]);
    const pos = Math.hypot(r[0], r[1], r[2]);
    const tilt = Math.acos(Math.max(-1, Math.min(1, -this.a[2])));
    return [pos, tilt];
  }

  private run(target: Vec3, q: Float64Array, maxIters: number, posTol: number, tiltTol: number): { posErr: number; tilt: number; iters: number } {
    const { J, r, A, b, dq, ranges, qb } = this;
    let [pos, tilt] = this.residual(q, target);
    let cost = pos * pos + (ORIENT_WEIGHT * tilt) ** 2;
    let lambda = 0.01;
    let iters = 0;
    for (; iters < maxIters; iters++) {
      if (pos < posTol && tilt < tiltTol) break;
      // Jacobian at q (residual() left the FK of q in kin)
      const k = this.kin;
      for (let j = 0; j < ARM_JOINTS; j++) {
        k.jointAxis(j, this.ax);
        k.anchor(j, this.an);
        const zx = this.ax[0], zy = this.ax[1], zz = this.ax[2];
        const px = this.t[0] - this.an[0], py = this.t[1] - this.an[1], pz = this.t[2] - this.an[2];
        J[0 * ARM_JOINTS + j] = zy * pz - zz * py;
        J[1 * ARM_JOINTS + j] = zz * px - zx * pz;
        J[2 * ARM_JOINTS + j] = zx * py - zy * px;
        J[3 * ARM_JOINTS + j] = ORIENT_WEIGHT * (zy * this.a[2] - zz * this.a[1]);
        J[4 * ARM_JOINTS + j] = ORIENT_WEIGHT * (zz * this.a[0] - zx * this.a[2]);
        J[5 * ARM_JOINTS + j] = ORIENT_WEIGHT * (zx * this.a[1] - zy * this.a[0]);
      }
      const rr = r.slice();
      let improved = false;
      for (let attempt = 0; attempt < 6 && !improved; attempt++) {
        // A = J^T J + lambda^2 I, b = J^T r
        for (let i = 0; i < ARM_JOINTS; i++) {
          for (let j = 0; j < ARM_JOINTS; j++) {
            let s = 0;
            for (let m = 0; m < 6; m++) s += J[m * ARM_JOINTS + i] * J[m * ARM_JOINTS + j];
            A[i * ARM_JOINTS + j] = s + (i === j ? lambda * lambda : 0);
          }
          let s = 0;
          for (let m = 0; m < 6; m++) s += J[m * ARM_JOINTS + i] * rr[m];
          b[i] = s;
        }
        solve4(A, b, dq);
        let mx = 0;
        for (let j = 0; j < ARM_JOINTS; j++) mx = Math.max(mx, Math.abs(dq[j]));
        const scale = mx > 0.35 ? 0.35 / mx : 1;
        qb.set(q);
        for (let j = 0; j < ARM_JOINTS; j++) {
          const v = q[j] + dq[j] * scale;
          qb[j] = Math.min(ranges[j][1], Math.max(ranges[j][0], v));
        }
        const [p2, t2] = this.residual(qb, target);
        const c2 = p2 * p2 + (ORIENT_WEIGHT * t2) ** 2;
        if (c2 < cost) {
          q.set(qb);
          pos = p2;
          tilt = t2;
          cost = c2;
          lambda = Math.max(1e-4, lambda * 0.3);
          improved = true;
        } else {
          lambda *= 5;
        }
      }
      if (!improved) {
        // restore FK of the current best for the caller, then give up
        [pos, tilt] = this.residual(q, target);
        iters++;
        break;
      }
    }
    return { posErr: pos, tilt, iters };
  }

  /**
   * Solve for the four positioning joints so the TCP reaches target with the gripper pointing
   * straight down, wrist_roll fixed at roll. seed (6 joints) warm-starts the solve; on failure a
   * few cold seeds are tried. Never throws.
   */
  solve(target: Vec3, roll: number, seed?: ArrayLike<number>, opts: SolveOptions = {}): IkResult {
    const maxIters = opts.maxIters ?? 40;
    const posTol = opts.posTol ?? 2e-5;
    const tiltTol = opts.tiltTol ?? 2e-4;
    if (!target.every(Number.isFinite) || !Number.isFinite(roll)) {
      return { q: seed ? Array.from(seed) : [0, 0, 0, 0, 0, 0], err: Infinity, posErr: Infinity, tilt: Math.PI, iters: 0 };
    }
    const r4 = this.ranges[4];
    const rollC = Math.min(r4[1], Math.max(r4[0], roll));
    const grip = seed ? seed[5] ?? 0 : 0;
    let best: IkResult | null = null;
    let totalIters = 0;
    const tryFrom = (init: ArrayLike<number>): void => {
      const q = this.qa;
      for (let j = 0; j < 6; j++) q[j] = init[j] ?? 0;
      for (let j = 0; j < ARM_JOINTS; j++) q[j] = Math.min(this.ranges[j][1], Math.max(this.ranges[j][0], q[j]));
      q[4] = rollC;
      q[5] = grip;
      const res = this.run(target, q, maxIters, posTol, tiltTol);
      totalIters += res.iters;
      const err = Math.hypot(res.posErr, ORIENT_WEIGHT * res.tilt);
      if (!best || err < best.err) best = { q: Array.from(q), err, posErr: res.posErr, tilt: res.tilt, iters: 0 };
    };
    if (seed) tryFrom(seed);
    const good = (): boolean => best !== null && best.err < IK_TOL * 0.05;
    if (!good()) {
      // pan seed from the target bearing: pan = 0 points at -y, positive pan turns toward -x
      const pan = wrapPi(-Math.PI / 2 - Math.atan2(target[1], target[0]));
      for (const s of this.seeds) {
        tryFrom([pan, s[0], s[1], s[2], rollC, grip]);
        if (good()) break;
      }
    }
    const out = best as unknown as IkResult;
    out.iters = totalIters;
    return out;
  }

  /**
   * Gripper-down solve where the jaw closing axis must lie along yaw (modulo pi).
   * tcpFor(u) gives the TCP target for a jaw axis direction u (unit, horizontal). Both jaw sides
   * (yaw and yaw + pi) are tried; the roll is iterated until the measured jaw axis matches and
   * must stay inside the joint range. Among reachable answers the roll nearest refRoll wins.
   * Returns the solution, the jaw axis u actually used and its TCP target.
   */
  solveJawYaw(
    yaw: number,
    tcpFor: (u: [number, number]) => Vec3,
    refRoll: number,
    seed?: ArrayLike<number>,
  ): IkResult & { u: [number, number]; target: Vec3 } {
    const r4 = this.ranges[4];
    let best: (IkResult & { u: [number, number]; target: Vec3 }) | null = null;
    for (const flip of [0, Math.PI]) {
      const psi = yaw + flip;
      const u: [number, number] = [Math.cos(psi), Math.sin(psi)];
      const target = tcpFor(u);
      let res = this.solve(target, Math.min(r4[1], Math.max(r4[0], refRoll)), seed);
      let feasible = true;
      for (let it = 0; it < 5; it++) {
        // the roll that turns the measured jaw axis onto psi (full turns keep the same jaw side)
        const want = res.q[4] + wrapPi(psi - this.jawAngleAt(res.q));
        let roll = Number.NaN;
        for (const c of [want, want - 2 * Math.PI, want + 2 * Math.PI]) {
          if (c >= r4[0] && c <= r4[1] && (Number.isNaN(roll) || Math.abs(c - refRoll) < Math.abs(roll - refRoll))) roll = c;
        }
        if (Number.isNaN(roll)) {
          feasible = false; // only the flipped jaw (the other branch) fits the roll range
          break;
        }
        res = this.solve(target, roll, res.q);
        if (Math.abs(wrapPi(this.jawAngleAt(res.q) - psi)) < 1e-5) break;
      }
      const jawErr = feasible ? Math.abs(wrapPi(this.jawAngleAt(res.q) - psi)) : Math.PI;
      const err = Math.max(res.err, jawErr * ORIENT_WEIGHT);
      const cand = { ...res, err, u, target };
      const ok = cand.err <= IK_TOL;
      const bestOk = best !== null && best.err <= IK_TOL;
      const better =
        best === null ||
        (ok && !bestOk) ||
        (ok && bestOk && Math.abs(cand.q[4] - refRoll) < Math.abs(best.q[4] - refRoll)) ||
        (!ok && !bestOk && cand.err < best.err);
      if (better) best = cand;
    }
    return best!;
  }

  /** jaw closing axis angle (atan2 in the xy plane) at q */
  jawAngleAt(q: ArrayLike<number>): number {
    this.kin.compute(q);
    this.kin.jawAxis(this.ax);
    return Math.atan2(this.ax[1], this.ax[0]);
  }

  /** TCP of q (bay frame) */
  tcpAt(q: ArrayLike<number>): Vec3 {
    this.kin.compute(q);
    const o: Vec3 = [0, 0, 0];
    this.kin.tcp(o);
    return o;
  }
}

/** Solve the 4x4 system A x = b (Gaussian elimination with partial pivoting). */
function solve4(A: Float64Array, b: Float64Array, x: Float64Array): void {
  const n = ARM_JOINTS;
  const M = new Float64Array(n * (n + 1));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) M[i * (n + 1) + j] = A[i * n + j];
    M[i * (n + 1) + n] = b[i];
  }
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * (n + 1) + c]) > Math.abs(M[p * (n + 1) + c])) p = r;
    if (p !== c) for (let k = 0; k <= n; k++) [M[c * (n + 1) + k], M[p * (n + 1) + k]] = [M[p * (n + 1) + k], M[c * (n + 1) + k]];
    const d = M[c * (n + 1) + c];
    if (Math.abs(d) < 1e-14) continue;
    for (let r = c + 1; r < n; r++) {
      const f = M[r * (n + 1) + c] / d;
      for (let k = c; k <= n; k++) M[r * (n + 1) + k] -= f * M[c * (n + 1) + k];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i * (n + 1) + n];
    for (let j = i + 1; j < n; j++) s -= M[i * (n + 1) + j] * x[j];
    const d = M[i * (n + 1) + i];
    x[i] = Math.abs(d) < 1e-14 ? 0 : s / d;
  }
}
