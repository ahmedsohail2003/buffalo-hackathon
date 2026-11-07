import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { buildArmModel } from './armModel';
import type { ArmData } from './armData';

/** Node-only loader (kept in the test so the app module stays DOM/FS-free). */
export function loadArmDataNode(): ArmData {
  return JSON.parse(readFileSync(new URL('../../public/arm-data.json', import.meta.url), 'utf8')) as ArmData;
}

interface FkRow {
  q: number[];
  tcp: [number, number, number];
  fixed_jaw_pos: [number, number, number];
  fixed_jaw_quat_wxyz: [number, number, number, number];
}

const rows = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/mujoco-fk_samples.json', import.meta.url), 'utf8'),
) as FkRow[];

const dist = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('FK against MuJoCo fixtures', () => {
  const data = loadArmDataNode();
  const model = buildArmModel(data);

  it('matches tcp, Fixed_Jaw position and orientation on all 60 sampled poses', () => {
    expect(rows.length).toBe(60);
    let maxTcp = 0;
    let maxPos = 0;
    let minDot = 1;
    for (const r of rows) {
      model.setPose(r.q);
      const tcp = model.tcp();
      const fj = model.fixedJawRoot();
      const eTcp = dist(tcp, r.tcp);
      const ePos = dist(fj.pos, r.fixed_jaw_pos);
      const [w, x, y, z] = r.fixed_jaw_quat_wxyz;
      const [qx, qy, qz, qw] = fj.quatXYZW;
      const dot = Math.abs(qx * x + qy * y + qz * z + qw * w);
      maxTcp = Math.max(maxTcp, eTcp);
      maxPos = Math.max(maxPos, ePos);
      minDot = Math.min(minDot, dot);
      expect(eTcp).toBeLessThan(1e-5);
      expect(ePos).toBeLessThan(1e-5);
      expect(dot).toBeGreaterThan(1 - 1e-5);
    }
    // eslint-disable-next-line no-console
    console.log(`fk: 60 rows, max tcp err ${maxTcp.toExponential(2)} m, max jaw pos err ${maxPos.toExponential(2)} m, min |quat dot| ${minDot.toFixed(8)}`);
  });

  it('keyframe 2 reaches the block at z=0.015 and home points the jaw straight down', () => {
    model.setPose(data.keys[2].q);
    const tcp = model.tcp();
    expect(Math.abs(tcp[0] - 0)).toBeLessThan(1e-3);
    expect(Math.abs(tcp[1] - -0.23)).toBeLessThan(1e-3);
    expect(Math.abs(tcp[2] - 0.015)).toBeLessThan(1e-3);

    model.setPose(data.keys[0].q);
    const down = model.fixedJawDirRoot([0, -1, 0], new Vector3());
    expect(Math.abs(down.x)).toBeLessThan(1e-3);
    expect(Math.abs(down.y)).toBeLessThan(1e-3);
    expect(Math.abs(down.z - -1)).toBeLessThan(1e-3);
  });
});
