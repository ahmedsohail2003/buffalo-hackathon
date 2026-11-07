// Damped-least-squares IK for the SO-ARM100 (PLAN.md §1.3).
// Formulation ported from my `workcell-partA-imitation` MuJoCo project (ik.py:20-74),
// re-derived here for the three.js kinematic model:
//   rows    = xyz tcp error + "down-sum" residual (Pitch + Elbow + Wrist_Pitch = 1.57, jaw pointing down)
//   columns = Rotation, Pitch, Elbow, Wrist_Pitch; Wrist_Roll is pinned as an input
//   dq = Jᵀ (J Jᵀ + λI)⁻¹ e, λ = 1e-3, step clip 0.3 rad, joint clamp, 100 iters, tol 1e-4
// NEVER throws; returns {q, err, iters}. Callers must reject err > 1e-3 m.
// Node-safe: imports only three math classes.

import { Vector3 } from 'three';
import type { Vec3 } from '../contracts';
import type { ArmModel } from './armModel';
import { HOME_Q, PIVOT, Z_HOVER, Z_LIFT, graspZ } from './armData';

export interface IkResult {
  /** 5 joints: Rotation, Pitch, Elbow, Wrist_Pitch, Wrist_Roll (roll = the pinned input) */
  q: number[];
  /** tcp position error at q, metres */
  err: number;
  iters: number;
}

export interface IkOptions {
  /** Wrist_Roll to pin. Default: q0[4] (or HOME_Q[4]). */
  roll?: number;
  lambda?: number;
  maxIters?: number;
  tol?: number;
  stepClip?: number;
}

const IK_JOINTS = ['Rotation', 'Pitch', 'Elbow', 'Wrist_Pitch'] as const;
const DOWN_SUM = 1.57;

const _axis = new Vector3();
const _anchor = new Vector3();
const _p = new Vector3();
const _r = new Vector3();
const _c = new Vector3();

/** Solve the 4×4 system A y = b in place by Gaussian elimination with partial pivoting. */
function solve4(A: number[][], b: number[]): number[] {
  const n = 4;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (piv !== col) [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    if (Math.abs(d) < 1e-12) continue;
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / d;
      if (f === 0) continue;
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  const y = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * y[k];
    y[r] = Math.abs(M[r][r]) < 1e-12 ? 0 : s / M[r][r];
  }
  return y;
}

export function solveIK(model: ArmModel, target: Vec3, q0: ArrayLike<number>, opts: IkOptions = {}): IkResult {
  const lambda = opts.lambda ?? 1e-3;
  const maxIters = opts.maxIters ?? 100;
  const tol = opts.tol ?? 1e-4;
  const clip = opts.stepClip ?? 0.3;
  const roll = opts.roll ?? (q0.length > 4 ? q0[4] : HOME_Q[4]);

  const q = [q0[0], q0[1], q0[2], q0[3], roll];
  const ranges = IK_JOINTS.map((n) => model.joints[n].range);
  const clampAll = () => {
    for (let j = 0; j < 4; j++) q[j] = Math.min(ranges[j][1], Math.max(ranges[j][0], q[j]));
  };
  clampAll();

  let err = Infinity;
  let iters = 0;
  const J: number[][] = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 1, 1, 1],
  ];
  const e = [0, 0, 0, 0];

  try {
    for (iters = 0; iters < maxIters; iters++) {
      model.setPose(q);
      model.tcpRoot(_p); // also updates world matrices
      e[0] = target[0] - _p.x;
      e[1] = target[1] - _p.y;
      e[2] = target[2] - _p.z;
      e[3] = DOWN_SUM - (q[1] + q[2] + q[3]);
      err = Math.hypot(e[0], e[1], e[2]);
      if (err < tol && Math.abs(e[3]) < tol) break;

      // analytic Jacobian: col_j = a_j × (p − o_j)
      for (let j = 0; j < 4; j++) {
        model.jointRoot(IK_JOINTS[j], _axis, _anchor);
        _r.copy(_p).sub(_anchor);
        _c.crossVectors(_axis, _r);
        J[0][j] = _c.x;
        J[1][j] = _c.y;
        J[2][j] = _c.z;
      }
      // A = J Jᵀ + λI
      const A: number[][] = [];
      for (let i = 0; i < 4; i++) {
        A.push([0, 0, 0, 0]);
        for (let k = 0; k < 4; k++) {
          let s = 0;
          for (let j = 0; j < 4; j++) s += J[i][j] * J[k][j];
          A[i][k] = s + (i === k ? lambda : 0);
        }
      }
      const y = solve4(A, e);
      // dq = Jᵀ y, clipped
      for (let j = 0; j < 4; j++) {
        let dq = 0;
        for (let i = 0; i < 4; i++) dq += J[i][j] * y[i];
        if (!Number.isFinite(dq)) dq = 0;
        q[j] += Math.max(-clip, Math.min(clip, dq));
      }
      clampAll();
    }
    // final error at the returned q
    model.setPose(q);
    model.tcpRoot(_p);
    err = Math.hypot(target[0] - _p.x, target[1] - _p.y, target[2] - _p.z);
  } catch {
    err = Infinity;
  } finally {
    model.setPose(q0);
    model.update();
  }
  if (!Number.isFinite(err)) err = Infinity;
  return { q, err, iters };
}

/** Polar coordinates about the Rotation pivot (root frame). */
export function pivotPolar(x: number, y: number): { rho: number; bearing: number } {
  const dy = y - PIVOT[1]; // y + 0.0452
  return { rho: Math.hypot(x, dy), bearing: Math.atan2(x, -dy) };
}

/** Wrist_Roll that aligns the finger axis with an object yaw, given the Rotation angle. */
export function rollForYaw(objYaw: number, qRot: number): number {
  return -1.57 + (objYaw - qRot);
}

/**
 * Worst tcp error (mm) over hover / grasp / lift at a table xy for a part of height h,
 * solved from home with the roll aligned two-pass. Used by the object validator.
 */
export function reachProbe(model: ArmModel, xy: [number, number], h: number, yaw = 0): number {
  let worst = 0;
  for (const z of [Z_HOVER, graspZ(h), Z_LIFT]) {
    const target: Vec3 = [xy[0], xy[1], z];
    const first = solveIK(model, target, HOME_Q);
    const second = solveIK(model, target, first.q, { roll: rollForYaw(yaw, first.q[0]) });
    worst = Math.max(worst, second.err * 1000);
  }
  return worst;
}
