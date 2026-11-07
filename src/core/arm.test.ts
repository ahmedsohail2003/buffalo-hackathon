import { describe, expect, it } from 'vitest';
import { ArmModel } from './model';
import { wrapPi } from './ik';
import {
  CONTAINMENT_FLOOR_Z,
  CONTAINMENT_INNER,
  CONTAINMENT_OUTER_HALF,
  CONTAINMENT_XY,
  HOME_Q,
  JAW_OPEN,
  SLOTS,
  Z_HOVER,
  Z_LIFT,
  jawForWidth,
  polarXY,
} from './constants';
import { armData, dist2, dist3, flush, makeBay, runUntil, steps } from './testutil';

describe('Arm: teleop servo', () => {
  it('converges on a hover target when running, phase "teleop"', async () => {
    const bay = await makeBay();
    bay.gate.apply('CYCLE_START');
    const target: [number, number, number] = [0.06, -0.16, Z_HOVER];
    bay.arm.servoTo(target);
    await steps(bay, 240);
    expect(dist3(bay.arm.snapshot().tcp, target)).toBeLessThan(1e-3);
    expect(bay.arm.snapshot().phase).toBe('teleop');
    expect(bay.arm.snapshot().busy).toBe(false);
  });

  it('rate-limits joint motion', async () => {
    const bay = await makeBay();
    bay.gate.apply('CYCLE_START');
    const q0 = bay.arm.joints();
    bay.arm.servoTo([0.15, -0.09, Z_HOVER]);
    bay.step(1 / 60);
    const q1 = bay.arm.joints();
    for (let j = 0; j < 4; j++) expect(Math.abs(q1[j] - q0[j])).toBeLessThanOrEqual(1.6 / 60 + 1e-9);
  });

  it('does not move while IDLE or STOPPED; servoTo(null) holds the pose', async () => {
    const bay = await makeBay();
    const q0 = bay.arm.joints();
    bay.arm.servoTo([0.06, -0.16, Z_HOVER]);
    await steps(bay, 30);
    expect(bay.arm.joints()).toEqual(q0); // IDLE: speed factor 0
    bay.gate.apply('CYCLE_START');
    await steps(bay, 20);
    bay.arm.servoTo(null);
    const q1 = bay.arm.joints();
    await steps(bay, 60);
    expect(bay.arm.joints()).toEqual(q1);
    expect(bay.arm.snapshot().phase).toBe('holding');
  });

  it('reports an unreachable target in the phase and holds still', async () => {
    const bay = await makeBay();
    bay.gate.apply('CYCLE_START');
    const q0 = bay.arm.joints();
    bay.arm.servoTo([0, -0.4, Z_HOVER]);
    await steps(bay, 10);
    expect(bay.arm.snapshot().phase).toContain('unreach');
    expect(bay.arm.joints()).toEqual(q0);
  });

  it('is ignored while a primitive runs, and a queued move clears the target', async () => {
    const bay = await makeBay();
    bay.gate.apply('CYCLE_START');
    bay.arm.servoTo([0.06, -0.16, Z_HOVER]);
    const p = bay.arm.home();
    bay.arm.servoTo([0.1, -0.12, Z_HOVER]); // ignored: busy
    const r = await runUntil(bay, p);
    expect(r.ok).toBe(true);
    const q = bay.arm.joints();
    await steps(bay, 30);
    expect(bay.arm.joints()).toEqual(q); // the servo target was cleared by the move
  });
});

describe('Arm: queue, STOP and ESTOP', () => {
  it('STOP freezes mid-move and RESUME finishes it', async () => {
    const bay = await makeBay();
    const cube = bay.samples.list()[0];
    const p = bay.arm.pick(cube.id);
    await steps(bay, 25);
    expect(bay.arm.snapshot().busy).toBe(true);
    bay.gate.apply('STOP');
    const frozen = bay.arm.joints();
    await steps(bay, 120);
    expect(bay.arm.joints()).toEqual(frozen);
    bay.gate.apply('RESUME');
    const r = await runUntil(bay, p);
    expect(r).toMatchObject({ ok: true, held: cube.id });
  });

  it('SLOW runs at half speed', async () => {
    const run = async (slow: boolean): Promise<number> => {
      const bay = await makeBay();
      bay.gate.apply('CYCLE_START');
      if (slow) bay.gate.apply('SLOW');
      const p = bay.arm.pick(bay.samples.list()[0].id);
      let n = 0;
      let done = false;
      p.then(() => (done = true));
      while (!done && n < 5000) {
        bay.step(1 / 60);
        await flush();
        n++;
      }
      return n;
    };
    const fast = await run(false);
    const slow = await run(true);
    expect(slow / fast).toBeGreaterThan(1.8);
    expect(slow / fast).toBeLessThan(2.2);
  });

  it('ESTOP aborts the move in flight with ABORTED and freezes the arm', async () => {
    const bay = await makeBay();
    const p = bay.arm.pick(bay.samples.list()[0].id);
    await steps(bay, 30);
    bay.gate.apply('ESTOP');
    const r = await p;
    expect(r).toMatchObject({ ok: false, code: 'ABORTED' });
    expect(bay.arm.snapshot().busy).toBe(false);
    const q = bay.arm.joints();
    await steps(bay, 30);
    expect(bay.arm.joints()).toEqual(q);
    // further moves are refused until the two-step reset
    const r2 = await runUntil(bay, bay.arm.home());
    expect(r2).toMatchObject({ ok: false, code: 'REJECTED_STATE' });
    bay.gate.apply('RESET_ARM');
    bay.gate.apply('RESET_CONFIRM');
    expect((await runUntil(bay, bay.arm.home())).ok).toBe(true);
  });

  it('abortAll rejects queued and waiting moves', async () => {
    const bay = await makeBay();
    bay.gate.apply('CYCLE_START');
    bay.gate.apply('STOP');
    const a = bay.arm.home();
    const b = bay.arm.pick('sample_1');
    await flush();
    bay.arm.abortAll('test');
    expect(await a).toMatchObject({ ok: false, code: 'ABORTED' });
    expect(await b).toMatchObject({ ok: false, code: 'ABORTED' });
  });

  it('a primitive from IDLE starts the cycle itself (logged)', async () => {
    const bay = await makeBay();
    const r = await runUntil(bay, bay.arm.home());
    expect(r.ok).toBe(true);
    expect(bay.gate.state()).toBe('RUNNING');
    expect(bay.logs).toContain('TASK START - auto CYCLE START');
  });
});

describe('Arm: pick and place primitives', () => {
  it('picks the seed cube: jaw closes to its width, the cube follows the tcp up to Z_LIFT', async () => {
    const bay = await makeBay();
    const cube = bay.samples.list()[0];
    const r = await runUntil(bay, bay.arm.pick(cube.id));
    expect(r).toMatchObject({ ok: true, held: cube.id });
    const snap = bay.arm.snapshot();
    expect(snap.heldId).toBe(cube.id);
    expect(snap.tcp[2]).toBeCloseTo(Z_LIFT, 3);
    expect(snap.q[5]).toBeCloseTo(jawForWidth(24), 9);
    const held = bay.samples.get(cube.id)!;
    expect(held.held).toBe(true);
    expect(held.pos[2]).toBeGreaterThan(0.06);
    expect(dist2(held.pos, snap.tcp)).toBeLessThan(0.015);
    // the jaw pads straddle the cube: gap ~ 23 mm
    const m = new ArmModel(await armData());
    m.setPose(snap.q);
    expect(m.jawGap() * 1000).toBeCloseTo(23, 1);
    // moving the arm carries the cube along
    await runUntil(bay, bay.arm.placeAt(SLOTS[1]));
    const placed = bay.samples.get(cube.id)!;
    expect(placed.held).toBe(false);
    expect(dist2(placed.pos, SLOTS[1])).toBeLessThan(0.002);
    expect(placed.pos[2]).toBeCloseTo(0.012, 9);
    expect(bay.arm.snapshot().heldId).toBeNull();
    expect(bay.arm.snapshot().tcp[2]).toBeCloseTo(Z_HOVER, 3);
  });

  it('aligns the jaw with the sample yaw (modulo pi)', async () => {
    const bay = await makeBay();
    const cube = bay.samples.list()[0];
    bay.samples.updatePose(cube.id, cube.pos, 0.7);
    const r = await runUntil(bay, bay.arm.pick(cube.id));
    expect(r.ok).toBe(true);
    const m = new ArmModel(await armData());
    m.setPose(bay.arm.joints());
    const a = m.jawAxis();
    expect(Math.abs(wrapPi(2 * (Math.atan2(a[1], a[0]) - 0.7)) / 2)).toBeLessThan(2e-3);
  });

  it('places into containment, on the bin floor', async () => {
    const bay = await makeBay();
    const cube = bay.samples.list()[0];
    await runUntil(bay, bay.arm.pick(cube.id));
    const r = await runUntil(bay, bay.arm.placeInContainment());
    expect(r).toMatchObject({ ok: true, held: null });
    const s = bay.samples.get(cube.id)!;
    expect(Math.abs(s.pos[0] - CONTAINMENT_XY[0])).toBeLessThan(CONTAINMENT_INNER / 2);
    expect(Math.abs(s.pos[1] - CONTAINMENT_XY[1])).toBeLessThan(CONTAINMENT_INNER / 2);
    expect(s.pos[2]).toBeCloseTo(CONTAINMENT_FLOOR_Z + 0.012, 9);
  });

  it('a second sample in the bin goes beside the first', async () => {
    const bay = await makeBay();
    const b = bay.samples.createPrimitive({ color: '#0ea5e9', kind: 'cylinder', width_mm: 20, height_mm: 20 });
    expect(b.ok).toBe(true);
    for (const id of ['sample_1', 'sample_2']) {
      expect((await runUntil(bay, bay.arm.pick(id))).ok).toBe(true);
      expect((await runUntil(bay, bay.arm.placeInContainment())).ok).toBe(true);
    }
    const [s1, s2] = [bay.samples.get('sample_1')!, bay.samples.get('sample_2')!];
    expect(s2.pos[2]).toBeCloseTo(CONTAINMENT_FLOOR_Z + 0.01, 9);
    expect(dist2(s1.pos, s2.pos)).toBeGreaterThan(0.025);
  });

  it('stacks: a sample released over another rests on its top', async () => {
    const bay = await makeBay();
    const small = bay.samples.createPrimitive({ color: '#22c55e', kind: 'box', width_mm: 20, height_mm: 18 });
    expect(small.ok).toBe(true);
    if (!small.ok) return;
    const cube = bay.samples.list()[0];
    expect((await runUntil(bay, bay.arm.pick(small.sample.id))).ok).toBe(true);
    const r = await runUntil(bay, bay.arm.placeAt([cube.pos[0], cube.pos[1]]));
    expect(r.ok).toBe(true);
    const top = bay.samples.get(small.sample.id)!;
    expect(top.pos[2]).toBeCloseTo(0.024 + 0.009, 9);
    // the cube underneath cannot be picked until the top one is moved
    const blocked = await runUntil(bay, bay.arm.pick(cube.id));
    expect(blocked).toMatchObject({ ok: false, code: 'UNREACHABLE' });
    expect((blocked as { reason: string }).reason).toContain('under');
    // and the top one can be picked off the stack again
    expect((await runUntil(bay, bay.arm.pick(small.sample.id))).ok).toBe(true);
  });

  it('refuses a stack taller than the carry clearance', async () => {
    const bay = await makeBay();
    const tall = bay.samples.createPrimitive({ color: '#a855f7', kind: 'box', width_mm: 20, height_mm: 30 });
    if (!tall.ok) throw new Error(tall.reason);
    await runUntil(bay, bay.arm.pick(tall.sample.id));
    const cube = bay.samples.list()[0];
    const r = await runUntil(bay, bay.arm.placeAt([cube.pos[0], cube.pos[1]]));
    expect(r).toMatchObject({ ok: false, code: 'UNREACHABLE' });
    expect((r as { reason: string }).reason).toMatch(/54 mm tower/);
    expect(bay.arm.snapshot().heldId).toBe(tall.sample.id);
  });

  it('GRASP_MISSED when the sample moved during the descent: reopens and backs off', async () => {
    const bay = await makeBay();
    const cube = bay.samples.list()[0];
    const p = bay.arm.pick(cube.id);
    // let it start, then move the cube away (say a teleop nudge)
    for (let i = 0; i < 400 && !bay.arm.snapshot().phase.includes('descending'); i++) {
      bay.step(1 / 60);
      await flush();
    }
    expect(bay.arm.snapshot().phase).toContain('descending');
    bay.samples.updatePose(cube.id, [cube.pos[0] + 0.03, cube.pos[1], cube.pos[2]], 0);
    const r = await runUntil(bay, p);
    expect(r).toMatchObject({ ok: false, code: 'GRASP_MISSED' });
    const snap = bay.arm.snapshot();
    expect(snap.heldId).toBeNull();
    expect(snap.q[5]).toBeCloseTo(JAW_OPEN, 6);
    expect(snap.tcp[2]).toBeCloseTo(Z_HOVER, 3);
    expect(bay.samples.get(cube.id)!.held).toBe(false);
  });

  it('returns speakable errors: NO_SAMPLE, ALREADY_HELD, NOTHING_HELD, UNREACHABLE', async () => {
    const bay = await makeBay();
    expect(await runUntil(bay, bay.arm.pick('sample_9'))).toMatchObject({ ok: false, code: 'NO_SAMPLE' });
    expect(await runUntil(bay, bay.arm.placeAt(SLOTS[2]))).toMatchObject({ ok: false, code: 'NOTHING_HELD' });
    expect(await runUntil(bay, bay.arm.placeInContainment())).toMatchObject({ ok: false, code: 'NOTHING_HELD' });
    await runUntil(bay, bay.arm.pick('sample cube'));
    const again = await runUntil(bay, bay.arm.pick('sample_1'));
    expect(again).toMatchObject({ ok: false, code: 'ALREADY_HELD' });
    const q = bay.arm.joints();
    const far = await runUntil(bay, bay.arm.placeAt(polarXY(0.26, 0)));
    expect(far).toMatchObject({ ok: false, code: 'UNREACHABLE' });
    expect((far as { reason: string }).reason).toMatch(/260 mm from the arm's axis.*130 mm and 200 mm\.$/);
    expect(bay.arm.joints()).toEqual(q); // nothing moved
    const wall = await runUntil(bay, bay.arm.placeAt([CONTAINMENT_XY[0] + CONTAINMENT_INNER / 2 + 0.002, CONTAINMENT_XY[1]]));
    expect(wall).toMatchObject({ ok: false, code: 'UNREACHABLE' });
    expect((wall as { reason: string }).reason).toContain('wall');
  });

  it('refuses a place whose footprint crosses the bin wall or crowds a deck neighbour', async () => {
    const bay = await makeBay();
    await runUntil(bay, bay.arm.pick('sample_1'));
    // centre 2 mm inside the inner face, then 1 mm outside the outer face: the 24 mm cube spans the wall either way
    for (const dx of [CONTAINMENT_INNER / 2 - 0.002, CONTAINMENT_OUTER_HALF + 0.001]) {
      const r = await runUntil(bay, bay.arm.placeAt([CONTAINMENT_XY[0] + dx, CONTAINMENT_XY[1]]));
      expect(r).toMatchObject({ ok: false, code: 'UNREACHABLE' });
      expect((r as { reason: string }).reason).toContain('wall');
    }
    expect(await runUntil(bay, bay.arm.placeAt([0, -0.165]))).toMatchObject({ ok: true });
    const other = bay.samples.createPrimitive({ color: '#ef4444', kind: 'cylinder', width_mm: 30, height_mm: 30 });
    if (!other.ok) throw new Error(other.reason);
    await runUntil(bay, bay.arm.pick(other.sample.id));
    const near = await runUntil(bay, bay.arm.placeAt([0.0375, -0.165]));
    expect(near).toMatchObject({ ok: false, code: 'UNREACHABLE' });
    expect((near as { reason: string }).reason).toMatch(/from sample cube; leave at least \d+ mm/);
    expect(await runUntil(bay, bay.arm.placeAt(polarXY(0.17, 0.32)))).toMatchObject({ ok: true });
  });

  it('home returns to HOME_Q, keeping a held sample in the jaw', async () => {
    const bay = await makeBay();
    await runUntil(bay, bay.arm.pick('sample_1'));
    const grip = bay.arm.joints()[5];
    const r = await runUntil(bay, bay.arm.home());
    expect(r).toMatchObject({ ok: true, held: 'sample_1' });
    const q = bay.arm.joints();
    for (let j = 0; j < 5; j++) expect(q[j]).toBeCloseTo(HOME_Q[j], 9);
    expect(q[5]).toBeCloseTo(grip, 9);
    expect(bay.arm.snapshot().phase).toBe('idle');
  });

  it('serialises primitives: pick then place queued back to back', async () => {
    const bay = await makeBay();
    const a = bay.arm.pick('sample_1');
    const b = bay.arm.placeAt(SLOTS[3]);
    const rb = await runUntil(bay, b);
    expect((await a).ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(dist2(bay.samples.get('sample_1')!.pos, SLOTS[3])).toBeLessThan(0.002);
  });
});
