import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { IK_TOL, IkSolver } from './ik';
import { ArmModel } from './model';
import * as C from './constants';
import { armData } from './testutil';

describe('derived constants', () => {
  it('REACH: gripper-down IK solves at Z_HOVER and Z_LIFT for every roll, with the grasp offset either way', async () => {
    const ik = new IkSolver(await armData());
    const rolls = [-2.6, -1.6, -0.6, 0, 0.8, 1.8, 2.8];
    for (const z of [C.Z_HOVER, C.Z_LIFT]) {
      for (const r of [C.REACH.rhoMin - 0.0125, (C.REACH.rhoMin + C.REACH.rhoMax) / 2, C.REACH.rhoMax + 0.0125]) {
        for (const b of [-C.REACH.bearingMax, -0.7, 0, 0.7, C.REACH.bearingMax]) {
          for (const roll of rolls) {
            const [x, y] = C.polarXY(r, b);
            expect(ik.solve([x, y, z], roll).err).toBeLessThan(IK_TOL / 10);
          }
        }
      }
    }
  });

  it('Z_LIFT is close to the top of the gripper-down workspace (the band collapses above ~86 mm)', async () => {
    const ik = new IkSolver(await armData());
    expect(ik.solve([0, -0.165, 0.095], 0).err).toBeGreaterThan(IK_TOL);
    expect(ik.solve([0, -0.165, C.Z_LIFT], 0).err).toBeLessThan(IK_TOL);
  });

  it('heights: hover clears 45 mm parts, carried 45 mm parts clear 45 mm neighbours and every stack', () => {
    expect(C.Z_HOVER - C.FINGERTIP_BELOW_TCP).toBeGreaterThan(0.045 + 0.005);
    const hang = C.graspZ(0.045); // a 45 mm part's bottom is this far below the tcp
    expect(C.Z_LIFT - hang).toBeGreaterThan(0.045 + 0.004);
    expect(C.Z_LIFT - hang).toBeGreaterThan(C.STACK_MAX_H + 0.004);
    expect(C.Z_LIFT - hang).toBeGreaterThan(C.CONTAINMENT_WALL_H + 0.02);
    expect(C.Z_LIFT).toBeGreaterThan(C.Z_HOVER);
  });

  it('graspZ: pads straddle mid-height, fingertips stay above the deck', () => {
    for (let h = 0.01; h <= 0.045; h += 0.001) {
      const z = C.graspZ(h);
      expect(z - C.FINGERTIP_BELOW_TCP).toBeGreaterThanOrEqual(C.DECK_CLEARANCE - 1e-12);
      // the contact zone (4 mm below to 15 mm above the tcp) overlaps the part
      expect(z - 0.004).toBeLessThan(h);
      if (h >= 0.026) expect(z + C.PAD_CENTRE_ABOVE_TCP).toBeCloseTo(h / 2, 9);
    }
    expect(C.FINGERTIP_BELOW_TCP_MM).toBeCloseTo(C.FINGERTIP_BELOW_TCP * 1000, 9);
  });

  it('jawForWidth gives a gap 1 mm tighter than the part; JAW_OPEN is a 60 mm gap', async () => {
    const m = new ArmModel(await armData());
    for (let w = C.GRIP_MIN_MM; w <= C.GRIP_MAX_MM; w += 2.5) {
      m.setPose([0, 0, 0, 0, 0, C.jawForWidth(w)]);
      expect(m.jawGap() * 1000).toBeCloseTo(w - C.JAW_SQUEEZE_MM, 3);
    }
    m.setPose([0, 0, 0, 0, 0, C.JAW_OPEN]);
    expect(m.jawGap() * 1000).toBeCloseTo(C.JAW_OPEN_GAP_MM, 3);
    expect(C.jawGapAt(C.jawForGap(1))).toBeGreaterThan(0.105); // the widest the jaw opens
    expect(C.jawForGap(0)).toBe(C.JAW_RANGE[0]);
  });

  it('fingertip and pad offsets match the model geometry', async () => {
    const d = await armData();
    const site = d.sites.gripperframe;
    expect(site.pos[0]).toBeCloseTo(C.TCP_X, 6);
    const fp = d.pads.fixed_jaw_box4;
    expect(fp.pos[0] + fp.size[0]).toBeCloseTo(C.FIXED_PAD_X, 6);
    const tip = d.pads.fixed_jaw_box3;
    expect(site.pos[2] - (tip.pos[2] - tip.size[0])).toBeCloseTo(C.FINGERTIP_BELOW_TCP, 4);
    expect(C.graspOffset(24)).toBeCloseTo(0.008, 9);
    expect(C.graspOffset(40)).toBeCloseTo(0, 9);
  });

  it('containment: inner >= 74 mm, wall <= 24 mm, centre front-left at 180-200 mm and reachable', async () => {
    expect(C.CONTAINMENT_INNER).toBeGreaterThanOrEqual(0.074);
    expect(C.CONTAINMENT_WALL_H).toBeLessThanOrEqual(0.024);
    expect(C.CONTAINMENT_OUTER_HALF).toBeCloseTo(C.CONTAINMENT_INNER / 2 + C.CONTAINMENT_WALL_T, 12);
    const [x, y] = C.CONTAINMENT_XY;
    expect(x).toBeLessThan(0);
    expect(y).toBeLessThan(0);
    expect(C.rhoOf(x, y)).toBeGreaterThanOrEqual(0.18);
    expect(C.rhoOf(x, y)).toBeLessThanOrEqual(0.2);
    expect(C.inReach(x, y)).toBe(true);
    const ik = new IkSolver(await armData());
    for (const z of [C.Z_LIFT, C.Z_CONTAINMENT_LOWER]) expect(ik.solve([x, y, z], 0.5).err).toBeLessThan(IK_TOL);
  });

  it('slots: 4-6 spots, >= 50 mm apart, inside REACH and clear of the bin', () => {
    expect(C.SLOTS.length).toBeGreaterThanOrEqual(4);
    expect(C.SLOTS.length).toBeLessThanOrEqual(6);
    for (let i = 0; i < C.SLOTS.length; i++) {
      const [x, y] = C.SLOTS[i];
      expect(C.inReach(x, y)).toBe(true);
      expect(Math.max(Math.abs(x - C.CONTAINMENT_XY[0]), Math.abs(y - C.CONTAINMENT_XY[1]))).toBeGreaterThan(C.CONTAINMENT_KEEPOUT + 0.017);
      for (let j = 0; j < i; j++) expect(Math.hypot(x - C.SLOTS[j][0], y - C.SLOTS[j][1])).toBeGreaterThanOrEqual(0.05);
    }
  });

  it('the bay camera frames the reach band, the slots and the bin', () => {
    const cam = new PerspectiveCamera(C.BAY_CAMERA.fovDeg, C.BAY_CAMERA.width / C.BAY_CAMERA.height, 0.01, 10);
    cam.up.set(...C.BAY_CAMERA.up);
    cam.position.set(...C.BAY_CAMERA.pos);
    cam.lookAt(...C.BAY_CAMERA.target);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const inside = (p: number[]): boolean => {
      const v = new Vector3(p[0], p[1], p[2]).project(cam);
      return Math.abs(v.x) < 0.9 && Math.abs(v.y) < 0.9 && v.z < 1;
    };
    for (const b of [-C.REACH.bearingMax, 0, C.REACH.bearingMax]) for (const r of [C.REACH.rhoMin, C.REACH.rhoMax]) expect(inside([...C.polarXY(r, b), 0])).toBe(true);
    for (const s of C.SLOTS) expect(inside([s[0], s[1], 0.045])).toBe(true);
    for (const dx of [-1, 1]) for (const dy of [-1, 1]) expect(inside([C.CONTAINMENT_XY[0] + dx * C.CONTAINMENT_OUTER_HALF, C.CONTAINMENT_XY[1] + dy * C.CONTAINMENT_OUTER_HALF, 0])).toBe(true);
    expect(C.BAY_CAMERA.pos[1]).toBeLessThan(0);
  });

  it('clampToReach and inReach agree', () => {
    for (const [x, y] of [[0, -0.3], [0, -0.05], [0.3, 0.1], [-0.15, -0.1]]) {
      const [cx, cy] = C.clampToReach(x, y);
      expect(C.inReach(cx, cy, -1e-9)).toBe(true);
    }
    expect(C.bearingOf(0.1, -0.1)).toBeCloseTo(Math.PI / 4, 12);
  });
});
