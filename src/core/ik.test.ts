import { describe, expect, it } from 'vitest';
import { IK_TOL, IkSolver, wrapPi, wrapRoll } from './ik';
import { ArmModel } from './model';
import { REACH, Z_HOVER, Z_LIFT, graspZ, polarXY } from './constants';
import { armData, dist3 } from './testutil';

describe('gripper-down IK', () => {
  it('round-trips a grid inside REACH at Z_HOVER and Z_LIFT (err < 1 mm, gripper down)', async () => {
    const d = await armData();
    const ik = new IkSolver(d);
    const m = new ArmModel(d);
    let n = 0;
    for (const z of [Z_HOVER, Z_LIFT, graspZ(0.024)]) {
      for (let r = REACH.rhoMin - 0.012; r <= REACH.rhoMax + 0.0125; r += 0.0125) {
        for (let b = -REACH.bearingMax; b <= REACH.bearingMax + 1e-9; b += REACH.bearingMax / 3) {
          for (const roll of [-2.5, -1, 0, 1.2, 2.7]) {
            const [x, y] = polarXY(r, b);
            const res = ik.solve([x, y, z], roll);
            expect(res.err).toBeLessThan(IK_TOL);
            m.setPose(res.q);
            expect(dist3(m.tcp(), [x, y, z])).toBeLessThan(1e-3);
            expect(m.approachAxis()[2]).toBeLessThan(-0.99995);
            expect(res.q[4]).toBeCloseTo(roll, 9);
            n++;
          }
        }
      }
    }
    expect(n).toBeGreaterThan(300);
  });

  it('respects the joint ranges', async () => {
    const ik = new IkSolver(await armData());
    const res = ik.solve([0.1, -0.15, Z_HOVER], 0.4);
    res.q.forEach((v, j) => {
      expect(v).toBeGreaterThanOrEqual(ik.ranges[j][0] - 1e-12);
      expect(v).toBeLessThanOrEqual(ik.ranges[j][1] + 1e-12);
    });
  });

  it('never throws and reports the error for unreachable or invalid targets', async () => {
    const ik = new IkSolver(await armData());
    const far = ik.solve([0, -0.5, 0.06], 0);
    expect(far.err).toBeGreaterThan(IK_TOL);
    const high = ik.solve([0, -0.16, 0.2], 0);
    expect(high.err).toBeGreaterThan(IK_TOL);
    const bad = ik.solve([Number.NaN, 0, 0], 0);
    expect(bad.err).toBe(Infinity);
  });

  it('warm starts in a couple of iterations and is fast enough for every frame', async () => {
    const ik = new IkSolver(await armData());
    let q = ik.solve([0, -0.165, Z_HOVER], 0).q;
    const t0 = performance.now();
    let maxIters = 0;
    for (let i = 0; i < 200; i++) {
      const [x, y] = polarXY(0.165 + 0.02 * Math.sin(i / 20), 0.6 * Math.sin(i / 30));
      const r = ik.solve([x, y, Z_HOVER], 0, q);
      expect(r.err).toBeLessThan(IK_TOL);
      maxIters = Math.max(maxIters, r.iters);
      q = r.q;
    }
    const ms = (performance.now() - t0) / 200;
    expect(maxIters).toBeLessThanOrEqual(6);
    expect(ms).toBeLessThan(2);
  });

  it('wraps the wrist roll by pi into its range, nearest the reference', async () => {
    const ik = new IkSolver(await armData());
    const range = ik.ranges[4];
    for (let r = -9; r <= 9; r += 0.37) {
      const w = wrapRoll(r, range, 0.3);
      expect(w).toBeGreaterThanOrEqual(range[0]);
      expect(w).toBeLessThanOrEqual(range[1]);
      const k = (w - r) / Math.PI;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
    }
    expect(wrapRoll(3.0, range)).toBeCloseTo(3.0 - Math.PI, 12);
    expect(wrapRoll(-3.0, range)).toBeCloseTo(-3.0 + Math.PI, 12);
    expect(wrapRoll(2.0, range, 0)).toBeCloseTo(2.0 - Math.PI, 12);
    expect(wrapRoll(2.0, range, 2.5)).toBeCloseTo(2.0, 12);
    expect(wrapPi(3 * Math.PI)).toBeCloseTo(-Math.PI, 9);
  });

  it('aligns the jaw closing axis with a requested yaw (modulo pi)', async () => {
    const ik = new IkSolver(await armData());
    for (const yaw of [0, 0.5, 1.4, -1.0, 2.9, -2.4]) {
      for (const b of [-1.2, 0, 0.8]) {
        const [x, y] = polarXY(0.165, b);
        const sol = ik.solveJawYaw(yaw, () => [x, y, Z_HOVER], 0);
        expect(sol.err).toBeLessThan(IK_TOL);
        const ja = ik.jawAngleAt(sol.q);
        const diff = wrapPi(2 * (ja - yaw)) / 2; // modulo pi
        expect(Math.abs(diff)).toBeLessThan(1e-3);
        expect(sol.q[4]).toBeGreaterThanOrEqual(ik.ranges[4][0]);
        expect(sol.q[4]).toBeLessThanOrEqual(ik.ranges[4][1]);
      }
    }
  });
});
