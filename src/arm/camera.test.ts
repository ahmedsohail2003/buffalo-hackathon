import { describe, it, expect } from 'vitest';
import { createCellCam, projectMujoco, unprojectER } from './cellCamera';

describe('cell camera (what Gemini sees)', () => {
  const cam = createCellCam();

  it('projects the seed block to ER [y,x] ≈ [564,577] (±15)', () => {
    const [y, x] = projectMujoco(cam, [0, -0.23, 0.012]);
    console.log(`cellCam: block at ER [${y}, ${x}]`);
    expect(Math.abs(y - 564)).toBeLessThanOrEqual(15);
    expect(Math.abs(x - 577)).toBeLessThanOrEqual(15);
    // sanity: the tray is left (smaller x) and further back (smaller y) than the block
    const [ty, tx] = projectMujoco(cam, [-0.18, -0.13, 0.006]);
    expect(tx).toBeLessThan(x);
    expect(ty).toBeLessThan(y);
  });

  it('round-trips block xy through unprojectER on the z = 0.012 plane within 1 mm', () => {
    const yx = projectMujoco(cam, [0, -0.23, 0.012]);
    const p = unprojectER(cam, yx, 0.012);
    expect(p).not.toBeNull();
    if (!p) return;
    expect(Math.abs(p[0] - 0)).toBeLessThan(1.5e-3); // integer rounding of 0–1000 costs < 1 mm
    expect(Math.abs(p[1] - -0.23)).toBeLessThan(1.5e-3);
    expect(Math.abs(p[2] - 0.012)).toBeLessThan(1e-6);
    // unprojecting a top-face point onto the wrong plane shifts xy (why we use z = h)
    const wrong = unprojectER(cam, projectMujoco(cam, [0, -0.23, 0.024]), 0.012)!;
    expect(Math.abs(wrong[1] - -0.23)).toBeGreaterThan(5e-3);
  });
});
