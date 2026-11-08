// The containment bin with the real arm (IK, motion queue, registry) and real fabricated samples:
// samples fill the floor from the corners, and stack only once the floor is full.
import { beforeAll, describe, expect, it } from 'vitest';
import type { MoveResult, Sample } from '../contracts';
import { fabricatePreset } from '../fabricator';
import { registerNasaAssets } from '../fabricator/testkit';
import { CONTAINMENT_FLOOR_Z, CONTAINMENT_INNER, CONTAINMENT_XY, STACK_MAX_H, polarXY } from './constants';
import type { Bay } from './index';
import { sampleRadius } from './samples';
import { bayApi, dist2, makeBay, runUntil } from './testutil';

beforeAll(registerNasaAssets);

async function stow(bay: Bay, id: string): Promise<MoveResult> {
  expect(await runUntil(bay, bay.arm.pick(id)), `pick ${id}`).toMatchObject({ ok: true, held: id });
  return runUntil(bay, bay.arm.placeInContainment());
}

/** resting on the bin floor with its whole footprint inside the inner walls */
function expectOnFloor(s: Sample): void {
  const half = CONTAINMENT_INNER / 2;
  const r = sampleRadius(s.dims);
  expect(s.held, s.name).toBe(false);
  expect(Math.abs(s.pos[0] - CONTAINMENT_XY[0]) + r, s.name).toBeLessThanOrEqual(half);
  expect(Math.abs(s.pos[1] - CONTAINMENT_XY[1]) + r, s.name).toBeLessThanOrEqual(half);
  expect(s.pos[2] - s.dims.h / 2, s.name).toBeCloseTo(CONTAINMENT_FLOOR_Z, 6);
}

/** no two footprints overlap (beyond the 2 mm of contact the registry allows) */
function expectApart(list: Sample[]): void {
  for (let i = 0; i < list.length; i++) {
    for (let j = 0; j < i; j++) expect(dist2(list[i].pos, list[j].pos)).toBeGreaterThanOrEqual(sampleRadius(list[i].dims) + sampleRadius(list[j].dims) - 0.002);
  }
}

const box = (bay: Bay, w: number, h: number, bearingDeg: number) => {
  const [x, y] = polarXY(0.165, (bearingDeg * Math.PI) / 180);
  const c = bay.samples.createPrimitive({ color: '#14b8a6', kind: 'box', width_mm: w, height_mm: h, x_mm: x * 1000, y_mm: y * 1000 });
  if (!c.ok) throw new Error(`${c.code}: ${c.reason}`);
  return c.sample;
};

describe('containment bin', () => {
  it('NASA Bennu, then the iron meteorite: both rest on the bin floor (the teleop beat, then the CAPCOM beat)', async () => {
    const bay = await makeBay({ noSeed: true });
    const ids: string[] = [];
    for (const preset of ['nasa_bennu', 'iron']) {
      const placed = await fabricatePreset(bayApi(bay), preset);
      if (!placed.ok) throw new Error(placed.reason);
      ids.push(placed.sample.id);
    }
    for (const id of ids) expect(await stow(bay, id)).toMatchObject({ ok: true, held: null });
    const [bennu, iron] = ids.map((id) => bay.samples.get(id)!);
    expectOnFloor(bennu);
    expectOnFloor(iron);
    expectApart([bennu, iron]);
    // the first one went to a corner, not the middle of the bin
    expect(dist2(bennu.pos, CONTAINMENT_XY)).toBeGreaterThan(0.02);
    expect(bay.arm.snapshot().heldId).toBeNull();
  });

  it('a 32 x 32 x 36 mm box and Bennu share the floor, in either order', async () => {
    for (const boxFirst of [true, false]) {
      const bay = await makeBay({ noSeed: true });
      const b = box(bay, 32, 36, 40);
      const placed = await fabricatePreset(bayApi(bay), 'nasa_bennu');
      if (!placed.ok) throw new Error(placed.reason);
      const order = boxFirst ? [b.id, placed.sample.id] : [placed.sample.id, b.id];
      for (const id of order) expect(await stow(bay, id), `boxFirst ${boxFirst}`).toMatchObject({ ok: true, held: null });
      const both = order.map((id) => bay.samples.get(id)!);
      both.forEach(expectOnFloor);
      expectApart(both);
    }
  });

  it('three 24 mm cubes share the floor', async () => {
    const bay = await makeBay();
    const ids = ['sample_1', box(bay, 24, 24, 30).id, box(bay, 24, 24, 60).id];
    for (const id of ids) expect(await stow(bay, id)).toMatchObject({ ok: true, held: null });
    const cubes = ids.map((id) => bay.samples.get(id)!);
    cubes.forEach(expectOnFloor);
    expectApart(cubes);
  });

  it('stacks only once the floor is full, right on top of a sample, and never above STACK_MAX_H', async () => {
    const bay = await makeBay({ noSeed: true });
    // three 32 mm boxes 20 mm tall (two fill the floor), then one 30 mm tall
    const ids = [
      [0, 20],
      [20, 20],
      [40, 20],
      [60, 30],
    ].map(([b, h]) => box(bay, 32, h, b).id);
    for (const id of ids.slice(0, 3)) expect(await stow(bay, id)).toMatchObject({ ok: true, held: null });
    const [a, b, top] = ids.map((id) => bay.samples.get(id)!);
    expectOnFloor(a);
    expectOnFloor(b);
    expectApart([a, b]);
    // the third rests on one of them, centred over its top face
    const under = [a, b].find((s) => dist2(s.pos, top.pos) <= Math.min(s.dims.w, s.dims.d) / 2);
    expect(under, 'stacked right on top').toBeDefined();
    expect(top.pos[2]).toBeCloseTo(CONTAINMENT_FLOOR_Z + 0.02 + 0.01, 6);
    // the tall one would make a tower over STACK_MAX_H on every sample in the bin: refused, still held
    expect(CONTAINMENT_FLOOR_Z + 0.02 + 0.03).toBeGreaterThan(STACK_MAX_H);
    const full = await stow(bay, ids[3]);
    expect(full).toMatchObject({ ok: false, code: 'UNREACHABLE' });
    expect((full as { reason: string }).reason).toBe(`the containment bin is full; there is no room for ${bay.samples.get(ids[3])!.name}.`);
    expect(bay.arm.snapshot().heldId).toBe(ids[3]);
  });
});
