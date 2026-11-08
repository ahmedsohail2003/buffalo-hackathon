import { describe, expect, it } from 'vitest';
import type { MeshInfo } from '../contracts';
import { CONTAINMENT_FLOOR_Z, CONTAINMENT_XY, REACH, Z_HOVER, Z_LIFT, inContainment, jawForWidth, polarXY } from './constants';
import { dist2, flush, makeBay, runUntil, steps } from './testutil';

describe('Arm flows', () => {
  it('picks and places across the whole REACH band (every waypoint IK-checked)', async () => {
    const bay = await makeBay({ noSeed: true });
    const spots: [number, number][] = [];
    for (const r of [REACH.rhoMin + 0.002, (REACH.rhoMin + REACH.rhoMax) / 2, REACH.rhoMax - 0.002]) {
      for (const b of [-0.2, 0.3, 0.9, REACH.bearingMax - 0.02]) spots.push(polarXY(r, b));
    }
    let n = 0;
    for (const [i, from] of spots.entries()) {
      const to = spots[(i + 5) % spots.length];
      const c = bay.samples.createPrimitive({ color: '#f59e0b', kind: 'box', width_mm: 15 + (i % 4) * 10, height_mm: 12 + (i % 3) * 15, x_mm: from[0] * 1000, y_mm: from[1] * 1000 });
      if (!c.ok) throw new Error(`${c.code}: ${c.reason}`);
      bay.samples.updatePose(c.sample.id, c.sample.pos, (i * 0.9) % Math.PI);
      const p = await runUntil(bay, bay.arm.pick(c.sample.id));
      expect(p).toMatchObject({ ok: true, held: c.sample.id });
      const q = await runUntil(bay, bay.arm.placeAt(to));
      expect(q).toMatchObject({ ok: true, held: null });
      const s = bay.samples.get(c.sample.id)!;
      expect(dist2(s.pos, to)).toBeLessThan(0.002);
      expect(s.pos[2]).toBeCloseTo(s.dims.h / 2, 9);
      bay.samples.remove(c.sample.id);
      n++;
    }
    expect(n).toBe(12);
  });

  it('a mesh sample is gripped by its measured grasp width', async () => {
    const bay = await makeBay({ noSeed: true });
    const mesh: MeshInfo = { program: { name: 'rock', category: 'asteroid', parts: [] }, graspWidthMm: 28, heightMm: 22, massG: 30, scale: 1, source: 'gemini' };
    const c = bay.samples.createMesh({ name: 'rock', color: '#6b7280', mesh, dims: { w: 0.03, d: 0.026, h: 0.022 } });
    if (!c.ok) throw new Error(c.reason);
    expect((await runUntil(bay, bay.arm.pick(c.sample.id))).ok).toBe(true);
    expect(bay.arm.joints()[5]).toBeCloseTo(jawForWidth(28), 9);
  });

  it('teleop hover, then a pick, starts from the live pose without a jump', async () => {
    const bay = await makeBay();
    bay.gate.apply('CYCLE_START');
    const cube = bay.samples.list()[0];
    bay.arm.servoTo([cube.pos[0] + 0.01, cube.pos[1], Z_HOVER]);
    await steps(bay, 200);
    const before = bay.arm.joints();
    const p = bay.arm.pick(cube.id);
    await flush();
    bay.step(1 / 60);
    const after = bay.arm.joints();
    for (let j = 0; j < 6; j++) expect(Math.abs(after[j] - before[j])).toBeLessThan(0.02);
    expect((await runUntil(bay, p)).ok).toBe(true);
  });

  it('recovers after an E-STOP mid-descent: reset, then the same pick succeeds', async () => {
    const bay = await makeBay();
    const cube = bay.samples.list()[0];
    const p = bay.arm.pick(cube.id);
    for (let i = 0; i < 600 && !bay.arm.snapshot().phase.includes('descending'); i++) {
      bay.step(1 / 60);
      await flush();
    }
    await steps(bay, 8);
    bay.command('ESTOP', 'panel');
    expect((await p).ok).toBe(false);
    bay.command('RESET_ARM', 'panel');
    bay.command('RESET_CONFIRM', 'panel');
    const r = await runUntil(bay, bay.arm.pick(cube.id));
    expect(r).toMatchObject({ ok: true, held: cube.id });
    expect(bay.arm.snapshot().tcp[2]).toBeCloseTo(Z_LIFT, 3);
  });

  it('a held sample keeps clear of the deck while it is carried', async () => {
    const bay = await makeBay();
    const tall = bay.samples.createPrimitive({ color: '#ef4444', kind: 'cylinder', width_mm: 30, height_mm: 45 });
    if (!tall.ok) throw new Error(tall.reason);
    await runUntil(bay, bay.arm.pick(tall.sample.id));
    // far enough from the seed cube for the jaw (place keeps max(40, r_a + r_b + 10) mm between centres)
    const p = bay.arm.placeAt(polarXY(0.17, 0.32));
    let minBottomWhileCarrying = Infinity;
    let done = false;
    p.then(() => (done = true));
    while (!done) {
      bay.step(1 / 60);
      await flush();
      const s = bay.samples.get(tall.sample.id)!;
      if (s.held && bay.arm.snapshot().phase.includes('carrying')) minBottomWhileCarrying = Math.min(minBottomWhileCarrying, s.pos[2] - s.dims.h / 2);
    }
    expect((await p).ok).toBe(true);
    // the carry path stays at Z_LIFT: the 45 mm part's bottom never drops below 45 mm
    expect(minBottomWhileCarrying).toBeGreaterThan(0.049);
  });

  it('says when the containment bin is full', async () => {
    const bay = await makeBay({ noSeed: true });
    const ids: string[] = [];
    for (const b of [0, 0.5]) {
      const c = bay.samples.createPrimitive({ color: '#14b8a6', kind: 'box', width_mm: 40, depth_mm: 40, height_mm: 30, ...xyMm(polarXY(0.165, b)) });
      if (!c.ok) throw new Error(c.reason);
      ids.push(c.sample.id);
    }
    expect((await runUntil(bay, bay.arm.pick(ids[0]))).ok).toBe(true);
    expect((await runUntil(bay, bay.arm.placeInContainment())).ok).toBe(true);
    // the first rests on the floor in a corner, which leaves the second no room beside it or on top
    const first = bay.samples.get(ids[0])!;
    expect(first.pos[2]).toBeCloseTo(CONTAINMENT_FLOOR_Z + 0.015, 6);
    expect(inContainment(first.pos[0], first.pos[1])).toBe(true);
    expect(dist2(first.pos, CONTAINMENT_XY)).toBeGreaterThan(0.01);
    expect((await runUntil(bay, bay.arm.pick(ids[1]))).ok).toBe(true);
    const q = bay.arm.joints();
    const full = await runUntil(bay, bay.arm.placeInContainment());
    expect(full).toMatchObject({ ok: false, code: 'UNREACHABLE' });
    expect((full as { reason: string }).reason).toBe(`the containment bin is full; there is no room for ${bay.samples.get(ids[1])!.name}.`);
    expect(bay.arm.joints()).toEqual(q);
    expect(bay.arm.snapshot().heldId).toBe(ids[1]);
  });
});

function xyMm([x, y]: [number, number]): { x_mm: number; y_mm: number } {
  return { x_mm: x * 1000, y_mm: y * 1000 };
}
