// Cross-module integration: the real SO-101 core (converted from MuJoCo Menagerie) with the fabricator and
// hand teleop. No mocks for the arm: inverse kinematics, the motion queue, the registry and the gate are real.

import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BayApi, MoveResult } from './contracts';
import {
  CONTAINMENT_FLOOR_Z,
  CONTAINMENT_INNER,
  CONTAINMENT_OUTER_HALF,
  CONTAINMENT_XY,
  REACH,
  Z_HOVER,
  Z_LIFT,
  createBay,
  loadArmDataNode,
  type Bay,
} from './core';
import { fabricatePreset, registerAsset } from './fabricator';
import { createTeleop, simHandFrame, workspaceToUV } from './teleop';

const DT = 1 / 60;
let armData: Awaited<ReturnType<typeof loadArmDataNode>>;

beforeAll(async () => {
  armData = await loadArmDataNode('public/assets/so101.json');
  for (const id of ['bennu', 'itokawa', 'eros', 'kleopatra']) {
    registerAsset(id, JSON.parse(readFileSync(`public/assets/samples/${id}.json`, 'utf8')));
  }
});

function bayApiOf(bay: Bay): BayApi {
  return {
    arm: bay.arm,
    samples: bay.samples,
    gate: bay.gate,
    capture: () => ({ jpegB64: '', w: 0, h: 0, t: 0 }),
    project: () => [0, 0],
    unproject: () => null,
  };
}

/** Step the simulated clock until the promise settles (motion only advances when the bay steps). */
async function settle<T>(bay: Bay, p: Promise<T>, maxSteps = 4000, each?: (i: number) => void): Promise<T> {
  let done = false;
  let value: T | undefined;
  p.then((v) => {
    done = true;
    value = v;
  });
  for (let i = 0; i < maxSteps && !done; i++) {
    each?.(i);
    bay.step(DT);
    await new Promise((r) => setImmediate(r));
  }
  if (!done) throw new Error('motion did not finish');
  return value as T;
}

function inContainment(pos: [number, number, number]): boolean {
  const half = CONTAINMENT_INNER / 2;
  return Math.abs(pos[0] - CONTAINMENT_XY[0]) < half && Math.abs(pos[1] - CONTAINMENT_XY[1]) < half;
}

describe('core + fabricator', () => {
  it('fabricates the iron meteorite (mass guardrail scales it) and the arm stows it in containment', async () => {
    const bay = createBay(armData, { noSeed: true });
    const api = bayApiOf(bay);
    const placed = await fabricatePreset(api, 'iron');
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    const s = placed.sample;
    expect(s.kind).toBe('mesh');
    expect(s.mesh!.massG).toBeLessThanOrEqual(100);
    expect(s.mesh!.scale).toBeLessThan(1); // designed heavier than the arm can carry
    const pick = (await settle(bay, bay.arm.pick(s.id))) as MoveResult;
    expect(pick).toMatchObject({ ok: true, held: s.id });
    const stow = (await settle(bay, bay.arm.placeInContainment())) as MoveResult;
    expect(stow.ok).toBe(true);
    const after = bay.samples.get(s.id)!;
    expect(after.held).toBe(false);
    expect(inContainment(after.pos)).toBe(true);
    expect(after.pos[2] - after.dims.h / 2).toBeCloseTo(CONTAINMENT_FLOOR_Z, 3);
  });

  it('places a real NASA Bennu shape model and the arm can pick it up', async () => {
    const bay = createBay(armData, { noSeed: true });
    const placed = await fabricatePreset(bayApiOf(bay), 'nasa_bennu');
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    const pick = (await settle(bay, bay.arm.pick(placed.sample.id))) as MoveResult;
    expect(pick).toMatchObject({ ok: true, held: placed.sample.id });
  });

  it('every offline preset either lands on the deck or is refused with a spoken reason', async () => {
    const bay = createBay(armData, { noSeed: true });
    const api = bayApiOf(bay);
    for (const id of ['bennu', 'ryugu', 'canister', 'antenna']) {
      const r = await fabricatePreset(api, id);
      if (r.ok) expect(r.sample.dims.w * 1000).toBeLessThanOrEqual(45);
      else expect(r.reason.length).toBeGreaterThan(10);
    }
  });
});

describe('core + teleop (simulated hand)', () => {
  it('follows the hand, picks the seed cube on a pinch-click and drops it in containment on the next', async () => {
    const bay = createBay(armData);
    const api = bayApiOf(bay);
    const teleop = createTeleop(api, {
      reach: REACH,
      zHover: Z_HOVER,
      zLift: Z_LIFT,
      containment: { xy: CONTAINMENT_XY, half: CONTAINMENT_OUTER_HALF },
    });
    const cube = bay.samples.list()[0];
    expect(cube).toBeDefined();
    teleop.enable();
    let t = 0;
    const tick = () => new Promise((r) => setImmediate(r));
    /** feed `frames` hand frames aimed at (x, y); yields each frame so async primitives progress */
    const drive = async (x: number, y: number, pinch: boolean, frames: number) => {
      const { u, v } = workspaceToUV(x, y, REACH);
      for (let i = 0; i < frames; i++) {
        t += DT * 1000;
        teleop.step(t, simHandFrame(u, v, pinch, t));
        bay.step(DT);
        await tick();
      }
    };
    await settle(bay, Promise.resolve()); // let enable() auto-start the cycle
    await drive(cube.pos[0], cube.pos[1], false, 240);
    const tcp = bay.arm.snapshot().tcp;
    expect(Math.hypot(tcp[0] - cube.pos[0], tcp[1] - cube.pos[1])).toBeLessThan(0.02);
    await drive(cube.pos[0], cube.pos[1], true, 4); // pinch closes …
    await drive(cube.pos[0], cube.pos[1], false, 4); // … and opens: one click
    for (let i = 0; i < 900 && bay.arm.snapshot().heldId !== cube.id; i++) await drive(cube.pos[0], cube.pos[1], false, 1);
    expect(bay.arm.snapshot().heldId).toBe(cube.id);
    for (let i = 0; i < 900 && bay.arm.snapshot().busy; i++) await drive(cube.pos[0], cube.pos[1], false, 1);
    await drive(CONTAINMENT_XY[0], CONTAINMENT_XY[1], false, 300);
    await drive(CONTAINMENT_XY[0], CONTAINMENT_XY[1], true, 4);
    await drive(CONTAINMENT_XY[0], CONTAINMENT_XY[1], false, 4);
    for (let i = 0; i < 1200 && bay.samples.get(cube.id)!.held; i++) await drive(CONTAINMENT_XY[0], CONTAINMENT_XY[1], false, 1);
    for (let i = 0; i < 900 && bay.arm.snapshot().busy; i++) await drive(CONTAINMENT_XY[0], CONTAINMENT_XY[1], false, 1);
    const after = bay.samples.get(cube.id)!;
    expect(after.held).toBe(false);
    expect(inContainment(after.pos)).toBe(true);
  });

  it('holds still when the hand leaves view and freezes on STOP', async () => {
    const bay = createBay(armData);
    const teleop = createTeleop(bayApiOf(bay), {
      reach: REACH,
      zHover: Z_HOVER,
      zLift: Z_LIFT,
      containment: { xy: CONTAINMENT_XY, half: CONTAINMENT_OUTER_HALF },
    });
    teleop.enable();
    await settle(bay, Promise.resolve());
    let t = 0;
    const { u, v } = workspaceToUV(0.05, -0.16, REACH);
    for (let i = 0; i < 120; i++) {
      t += DT * 1000;
      teleop.step(t, simHandFrame(u, v, false, t));
      bay.step(DT);
    }
    const before = bay.arm.snapshot().q.slice();
    for (let i = 0; i < 60; i++) {
      t += DT * 1000;
      teleop.step(t, null); // hand gone: dead-man hold
      bay.step(DT);
    }
    const held = bay.arm.snapshot().q;
    expect(Math.max(...held.map((q, i) => Math.abs(q - before[i])))).toBeLessThan(1e-6);
    bay.command('STOP');
    const { u: u2, v: v2 } = workspaceToUV(-0.05, -0.17, REACH);
    for (let i = 0; i < 60; i++) {
      t += DT * 1000;
      teleop.step(t, simHandFrame(u2, v2, false, t));
      bay.step(DT);
    }
    const stopped = bay.arm.snapshot().q;
    expect(Math.max(...stopped.map((q, i) => Math.abs(q - held[i])))).toBeLessThan(1e-6);
  });
});
