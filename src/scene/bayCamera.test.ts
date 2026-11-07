import { describe, expect, it } from 'vitest';
import { BayCameraModel } from './bayCamera';

const cam = new BayCameraModel({ pos: [0, -0.6, 0.46], target: [0, -0.14, 0.03], fovDeg: 40 });

describe('bay camera model', () => {
  it('projects the look-at target to the image centre', () => {
    const [y, x] = cam.project([0, -0.14, 0.03]);
    expect(y).toBeCloseTo(500, 3);
    expect(x).toBeCloseTo(500, 3);
  });

  it('puts +x on the right and nearer points lower in the image', () => {
    const [, xr] = cam.project([0.1, -0.14, 0]);
    const [, xl] = cam.project([-0.1, -0.14, 0]);
    expect(xr).toBeGreaterThan(500);
    expect(xl).toBeLessThan(500);
    const [yNear] = cam.project([0, -0.3, 0]);
    const [yFar] = cam.project([0, 0.1, 0]);
    expect(yNear).toBeGreaterThan(yFar);
  });

  it('unprojects back onto the plane it came from', () => {
    for (const p of [
      [0.05, -0.2, 0],
      [-0.12, -0.25, 0.02],
      [0.17, -0.19, 0.01],
    ] as const) {
      const yx = cam.project([p[0], p[1], p[2]]);
      const back = cam.unproject(yx, p[2]);
      expect(back).not.toBeNull();
      expect(back![0]).toBeCloseTo(p[0], 6);
      expect(back![1]).toBeCloseTo(p[1], 6);
      expect(back![2]).toBeCloseTo(p[2], 9);
    }
  });

  it('returns null when the ray cannot reach the plane', () => {
    expect(cam.unproject([500, 500], 1.0)).toBeNull();
  });

  it('gives a deck footprint that is wider at the far edge', () => {
    const fp = cam.deckFootprint();
    expect(fp).toHaveLength(4);
    const farWidth = Math.abs(fp[1]![0] - fp[0]![0]);
    const nearWidth = Math.abs(fp[2]![0] - fp[3]![0]);
    expect(farWidth).toBeGreaterThan(nearWidth);
  });
});
