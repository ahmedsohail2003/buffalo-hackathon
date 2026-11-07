import { describe, it, expect } from 'vitest';
import {
  FIST_MASK_MS,
  FistPinchMask,
  PINCH_CLOSE,
  PINCH_OPEN,
  PinchDetector,
  clampToReach,
  fingersExtended,
  isPinchPose,
  mapToWorkspace,
  palmPoint,
  palmScale,
  pinchRatio,
  toPolar,
  workspaceToUV,
  type ReachBand,
} from './mapping';
import { OPEN_HAND, simHandFrame, syntheticHand } from './handTemplate';
import { fistLike } from './testFakes';

const BAND: ReachBand = { rhoMin: 0.13, rhoMax: 0.21, bearingMax: 1.35 };

describe('hand template', () => {
  it('is a 21-point open hand with palm size 0.18 and an open pinch', () => {
    expect(OPEN_HAND.length).toBe(21);
    expect(palmScale(OPEN_HAND)).toBeCloseTo(0.18, 6);
    expect(pinchRatio(OPEN_HAND)).toBeGreaterThan(PINCH_OPEN);
    const pinched = syntheticHand(0.5, 0.5, true);
    expect(pinchRatio(pinched)).toBeLessThan(PINCH_CLOSE);
    expect(pinched[4]).toEqual(pinched[8]);
  });

  it('puts the palm point under the pointer, mirrored (pad left = video right)', () => {
    const f = simHandFrame(0.2, 0.7, false, 0);
    const xs = [0, 5, 9, 13, 17].map((i) => f.landmarks[i].x);
    expect(xs.reduce((a, b) => a + b) / 5).toBeCloseTo(0.8, 9); // synthetic x = 1 - u
    const p = palmPoint(f.landmarks);
    expect(p.u).toBeCloseTo(0.2, 9);
    expect(p.v).toBeCloseTo(0.7, 9);
  });
});

describe('workspace mapping (base at the origin, reaching toward -y)', () => {
  it('mirrors: moving left in the preview moves the gripper to the operator left (x < 0)', () => {
    const left = mapToWorkspace(0.3, 0.8, BAND);
    const right = mapToWorkspace(0.7, 0.8, BAND);
    expect(left.x).toBeLessThan(-0.02);
    expect(right.x).toBeGreaterThan(0.02);
    expect(left.x).toBeCloseTo(-right.x, 9);
    // a hand on the right of the RAW video is on the operator's left
    const raw = simHandFrame(0.3, 0.8, false, 0);
    expect(raw.landmarks[0].x).toBeGreaterThan(0.5);
    const p = palmPoint(raw.landmarks);
    expect(mapToWorkspace(p.u, p.v, BAND).x).toBeCloseTo(left.x, 9);
  });

  it('hand higher in the image targets closer to the base; everything is in front of it (y < 0)', () => {
    const near = mapToWorkspace(0.5, 0.3, BAND);
    const far = mapToWorkspace(0.5, 0.85, BAND);
    expect(toPolar(near.x, near.y).rho).toBeLessThan(toPolar(far.x, far.y).rho);
    expect(near.y).toBeGreaterThan(far.y);
    expect(far.y).toBeLessThan(0);
  });

  it('every reachable deck point has a hand position: band points round-trip unclamped', () => {
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        const rho = BAND.rhoMin + 1e-4 + (BAND.rhoMax - BAND.rhoMin - 2e-4) * (i / 8);
        const b = -BAND.bearingMax + 1e-4 + (2 * BAND.bearingMax - 2e-4) * (j / 8);
        const x = rho * Math.sin(b);
        const y = -rho * Math.cos(b);
        const { u, v } = workspaceToUV(x, y, BAND);
        expect(u).toBeGreaterThanOrEqual(0.15 - 1e-9);
        expect(u).toBeLessThanOrEqual(0.85 + 1e-9);
        expect(v).toBeGreaterThanOrEqual(0.15 - 1e-9);
        expect(v).toBeLessThanOrEqual(0.85 + 1e-9);
        const m = mapToWorkspace(u, v, BAND);
        expect(m.clamped).toBe(false);
        expect(m.x).toBeCloseTo(x, 9);
        expect(m.y).toBeCloseTo(y, 9);
      }
    }
  });

  it('clamps every image point into the reach band in polar coordinates', () => {
    let clamped = 0;
    for (let i = 0; i <= 20; i++) {
      for (let j = 0; j <= 20; j++) {
        const m = mapToWorkspace(i / 20, j / 20, BAND);
        const { rho, bearing } = toPolar(m.x, m.y);
        expect(rho).toBeGreaterThanOrEqual(BAND.rhoMin - 1e-9);
        expect(rho).toBeLessThanOrEqual(BAND.rhoMax + 1e-9);
        expect(Math.abs(bearing)).toBeLessThanOrEqual(BAND.bearingMax + 1e-9);
        if (m.clamped) clamped++;
      }
    }
    expect(clamped).toBeGreaterThan(0);
    expect(mapToWorkspace(0.5, 0, BAND).clamped).toBe(true); // straight ahead, next to the base
    expect(mapToWorkspace(0.0, 0.8, BAND)).toEqual(mapToWorkspace(0.1, 0.8, BAND)); // margin
    const c = clampToReach(0, -0.4, BAND);
    expect(c.clamped).toBe(true);
    expect(c.x).toBeCloseTo(0, 9);
    expect(c.y).toBeCloseTo(-BAND.rhoMax, 9);
    const behind = clampToReach(0.05, 0.1, BAND); // behind the base: pulled to the bearing limit
    expect(Math.abs(toPolar(behind.x, behind.y).bearing)).toBeCloseTo(BAND.bearingMax, 9);
  });
});

describe('pinch click detector (hysteresis)', () => {
  const feed = (d: PinchDetector, ratios: number[]) => ratios.map((r) => d.update(r));

  it('clicks once on the close edge after 2 frames below 0.28, re-arms only above 0.45', () => {
    const d = new PinchDetector();
    expect(feed(d, [1.0, 0.2])).toEqual([false, false]);
    expect(d.update(0.2)).toBe(true);
    expect(d.closed).toBe(true);
    expect(feed(d, [0.1, 0.35, 0.4, 0.2, 0.44])).toEqual([false, false, false, false, false]);
    expect(d.update(0.5)).toBe(false);
    expect(d.closed).toBe(false);
    expect(feed(d, [0.2, 0.2])).toEqual([false, true]);
  });

  it('needs consecutive frames, and never clicks for a hand that appears already pinched', () => {
    const d = new PinchDetector();
    expect(feed(d, [1.0, 0.2, 0.3, 0.2, 0.2])).toEqual([false, false, false, false, true]);
    const e = new PinchDetector();
    expect(feed(e, [0.1, 0.1, 0.1])).toEqual([false, false, false]);
    expect(feed(e, [0.9, 0.1, 0.1])).toEqual([false, false, true]);
    e.reset();
    expect(feed(e, [0.1, 0.1, Number.NaN, Infinity])).toEqual([false, false, false, false]);
  });
});

describe('pinch pose vs fist (safety)', () => {
  it('a pinch with the other fingers extended is a pinch pose; a fist is not', () => {
    expect(fingersExtended(syntheticHand(0.5, 0.5, false))).toBe(3);
    expect(isPinchPose(syntheticHand(0.5, 0.5, true))).toBe(true);
    expect(isPinchPose(syntheticHand(0.5, 0.5, false))).toBe(false);
    const fist = fistLike();
    expect(pinchRatio(fist)).toBeLessThan(PINCH_CLOSE);
    expect(fingersExtended(fist)).toBe(0);
    expect(isPinchPose(fist)).toBe(false);
  });

  it('withholds Closed_Fist only on a pinch pose with teleop on, at most 500 ms per pinch', () => {
    const m = new FistPinchMask();
    const pinch = syntheticHand(0.5, 0.5, true);
    expect(m.suppress('Closed_Fist', pinch, false, 0)).toBe(false); // teleop off
    expect(m.suppress('Closed_Fist', fistLike(), true, 0)).toBe(false); // a real fist
    expect(m.suppress('Open_Palm', pinch, true, 10)).toBe(false);
    expect(m.suppress('Closed_Fist', pinch, true, 100)).toBe(true);
    expect(m.suppress('Closed_Fist', pinch, true, 400)).toBe(true);
    expect(m.suppress('Closed_Fist', pinch, true, 520)).toBe(false); // cap reached
    expect(m.suppress('Closed_Fist', pinch, true, 3000)).toBe(false);
    expect(m.suppress(null, syntheticHand(0.5, 0.5, false), true, 3100)).toBe(false); // pinch ends
    expect(m.suppress('Closed_Fist', pinch, true, 3200)).toBe(true); // next pinch
    expect(m.suppress('Closed_Fist', null, true, 3300)).toBe(false);
    expect(FIST_MASK_MS).toBe(500);
  });
});
