import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildArmModel } from './armModel';
import { HOME_Q } from './armData';
import type { ArmData } from './armData';
import { solveIK, pivotPolar, rollForYaw } from './ik';
import type { Vec3 } from '../contracts';

const data = JSON.parse(readFileSync(new URL('../../public/arm-data.json', import.meta.url), 'utf8')) as ArmData;

interface GridRow {
  x: number;
  y: number;
  z: number;
  r: number;
  theta_deg: number;
  q: number[];
  err_m: number;
}
const grid = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/mujoco-ik_grid.json', import.meta.url), 'utf8'),
) as GridRow[];

const maxAbsDiff = (a: number[], b: number[], n: number) => {
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const downSum = (q: number[]) => q[1] + q[2] + q[3];

describe('damped least-squares IK', () => {
  const model = buildArmModel(data);
  const times: number[] = [];
  const timed = (target: Vec3, q0: number[], opts?: { roll?: number }) => {
    const t0 = performance.now();
    const r = solveIK(model, target, q0, opts);
    times.push(performance.now() - t0);
    return r;
  };

  it('(a) block at z=0.015 from home matches keyframe 2 (roll pinned)', () => {
    const k2 = data.keys[2].q;
    const r = timed([0, -0.23, 0.015], HOME_Q, { roll: k2[4] });
    expect(r.err).toBeLessThan(1e-3);
    expect(maxAbsDiff(r.q, k2, 4)).toBeLessThan(0.05);
  });

  it('(b) block at z=0.027 from home: reachable, jaw down', () => {
    const r = timed([0, -0.23, 0.027], HOME_Q);
    expect(r.err).toBeLessThan(1e-3);
    expect(Math.abs(downSum(r.q) - 1.57)).toBeLessThan(1e-3);
  });

  it('(c) 20 interior MuJoCo grid rows round-trip through FK within 2 mm (≤1 failure tolerated)', () => {
    const interior = grid.filter((g) => g.err_m < 1e-3 && g.z <= 0.075 && g.r <= 0.25);
    const stride = Math.max(1, Math.floor(interior.length / 20));
    const rows = interior.filter((_, i) => i % stride === 0).slice(0, 20);
    expect(rows.length).toBe(20);
    const failures: string[] = [];
    for (const g of rows) {
      const r = timed([g.x, g.y, g.z], HOME_Q, { roll: g.q[4] });
      model.setPose(r.q);
      const tcp = model.tcp();
      const fkErr = Math.hypot(tcp[0] - g.x, tcp[1] - g.y, tcp[2] - g.z);
      const ds = Math.abs(downSum(r.q) - 1.57);
      if (fkErr >= 2e-3 || ds >= 1e-3) failures.push(`(${g.x},${g.y},${g.z}) fk ${(fkErr * 1000).toFixed(2)} mm ds ${ds.toFixed(4)}`);
    }
    model.setPose(HOME_Q);
    if (failures.length) console.log('ik grid failures:', failures);
    expect(failures.length).toBeLessThanOrEqual(1);
  });

  it('(d) retreat at 0.12 over the tray is unreachable (regression)', () => {
    const r = timed([-0.18, -0.13, 0.12], HOME_Q);
    expect(r.err).toBeGreaterThan(5e-3);
  });

  it('(e) far out of reach: large error, no throw', () => {
    const r = timed([0, -0.4, 0.015], HOME_Q);
    expect(Number.isFinite(r.err) || r.err === Infinity).toBe(true);
    expect(r.err).toBeGreaterThan(0.05);
  });

  it('(f) tray lower from keyframe 3 lands near keyframe 6', () => {
    const r = timed([-0.18, -0.13, 0.045], data.keys[3].q);
    expect(maxAbsDiff(r.q, data.keys[6].q, 4)).toBeLessThan(0.08);
    const sorted = [...times].sort((a, b) => a - b);
    console.log(
      `ik: ${times.length} solves, median ${sorted[Math.floor(sorted.length / 2)].toFixed(2)} ms, max ${sorted[sorted.length - 1].toFixed(2)} ms`,
    );
  });

  it('helpers: pivotPolar and rollForYaw', () => {
    const p = pivotPolar(0, -0.23);
    expect(p.rho).toBeCloseTo(0.1848, 4);
    expect(p.bearing).toBeCloseTo(0, 6);
    expect(pivotPolar(0.1, -0.0452).bearing).toBeCloseTo(Math.PI / 2, 6);
    expect(rollForYaw(0, 0)).toBeCloseTo(-1.57, 6);
    expect(rollForYaw(0.3, 0.1)).toBeCloseTo(-1.37, 6);
  });
});
