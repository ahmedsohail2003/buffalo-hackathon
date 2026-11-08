// Free deck spots with the real arm's IK probe and real fabricated samples: the default search over
// the slots and the whole reach band, and findSpot for a sample that is already in the bay.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Placement, Rejection, Sample } from '../contracts';
import { fabricatePreset } from '../fabricator';
import { registerNasaAssets } from '../fabricator/testkit';
import { CONTAINMENT_KEEPOUT, CONTAINMENT_XY, SLOTS, bearingOf, polarXY, rhoOf } from './constants';
import type { Bay } from './index';
import { DECK_SIDES, SEARCH_SPOTS, gripWidthMm, onDeckSide, sampleRadius } from './samples';
import { bayApi, dist2, makeBay, runUntil } from './testutil';

beforeAll(registerNasaAssets);

const clearOfBin = (s: Sample): boolean => {
  const rad = sampleRadius(s.dims);
  return Math.abs(s.pos[0] - CONTAINMENT_XY[0]) >= CONTAINMENT_KEEPOUT + rad || Math.abs(s.pos[1] - CONTAINMENT_XY[1]) >= CONTAINMENT_KEEPOUT + rad;
};

describe('deck spots: the slots, then the whole reach band', () => {
  it('searches the five slots, then rho 140-190 mm by bearing -80 to +80 degrees, nearest straight ahead and the 165 mm arc first', () => {
    expect(SEARCH_SPOTS.slice(0, SLOTS.length)).toEqual(SLOTS);
    const band = SEARCH_SPOTS.slice(SLOTS.length).map(([x, y]) => ({ rho: Math.round(rhoOf(x, y) * 1000), b: Math.round((bearingOf(x, y) * 180) / Math.PI) }));
    expect(band).toHaveLength(6 * 33);
    expect(new Set(band.map((s) => s.rho))).toEqual(new Set([140, 150, 160, 170, 180, 190]));
    expect(Math.min(...band.map((s) => s.b))).toBe(-80);
    expect(Math.max(...band.map((s) => s.b))).toBe(80);
    for (let i = 1; i < band.length; i++) {
      const [a, b] = [band[i - 1], band[i]];
      expect(Math.abs(a.b) < Math.abs(b.b) || (Math.abs(a.b) === Math.abs(b.b) && Math.abs(a.rho - 165) <= Math.abs(b.rho - 165))).toBe(true);
    }
  });

  it('after the three seeds and four mid-size designs, two more still find spots: clear of the bin, each passing checkSpot', async () => {
    const bay = await makeBay(); // the seed cube
    const api = bayApi(bay);
    const add = async (id: string) => {
      const r = await fabricatePreset(api, id);
      if (!r.ok) throw new Error(`${id}: ${r.code}: ${r.reason}`);
      return r.sample;
    };
    // the app's other two seeds, then four real fabricated designs, 26-33 mm across
    for (const id of ['nasa_bennu', 'nasa_itokawa']) await add(id);
    for (const id of ['iron', 'mars', 'ryugu', 'canister']) await add(id);
    // two more still find spots
    const more = [await add('iron'), await add('mars')];
    const all = bay.samples.list();
    expect(all).toHaveLength(9);
    for (const s of all) {
      expect(clearOfBin(s), s.name).toBe(true);
      expect(bay.samples.checkSpot(s.pos[0], s.pos[1], s.dims, gripWidthMm(s), s.yaw, s.id), s.name).toBeNull();
    }
    // the slots hold five; the rest came from the band search
    for (const s of more) expect(SLOTS.some((p) => dist2(p, s.pos) < 1e-9), s.name).toBe(false);
  });

  it('fits more of the largest parts than the slots alone, then says BAY_FULL with something to do about it', async () => {
    const bay = await makeBay({ noSeed: true });
    const made: Sample[] = [];
    let last = bay.samples.createPrimitive({ color: '#334155', kind: 'box', width_mm: 45, depth_mm: 60, height_mm: 20 });
    while (last.ok && made.length < 12) {
      made.push(last.sample);
      last = bay.samples.createPrimitive({ color: '#334155', kind: 'box', width_mm: 45, depth_mm: 60, height_mm: 20 });
    }
    // 45 x 60 mm parts need 85 mm between centres: the slots (51-57 mm apart) take only two of them
    expect(made.length).toBeGreaterThan(2);
    for (const s of made) expect(clearOfBin(s), s.name).toBe(true);
    expect(last).toMatchObject({ ok: false, code: 'BAY_FULL', reason: 'there is no free spot on the deck for a part this size.', suggestion: 'stow a sample in containment first' });
  });
});

async function seededBay(): Promise<{ bay: Bay; bennu: Sample; itokawa: Sample }> {
  const bay = await makeBay(); // the seed cube, then the app's two NASA seeds
  const made: Sample[] = [];
  for (const id of ['nasa_bennu', 'nasa_itokawa']) {
    const r = await fabricatePreset(bayApi(bay), id);
    if (!r.ok) throw new Error(r.reason);
    made.push(r.sample);
  }
  return { bay, bennu: made[0], itokawa: made[1] };
}

const spotOf = (r: ReturnType<Bay['samples']['findSpot']>): [number, number] => {
  if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
  return r.xy;
};

describe('findSpot: a free, checked deck spot for a sample already in the bay', () => {
  it('"place Bennu on the left side of the deck": the held sample gets a free left spot and the arm puts it there', async () => {
    const { bay, bennu, itokawa } = await seededBay();
    const samples = bayApi(bay).samples; // through the public BayApi
    // as in the probe: the cube is stowed, Itokawa stays at its slot, Bennu is in the gripper
    expect((await runUntil(bay, bay.arm.pick('sample_1'))).ok).toBe(true);
    expect((await runUntil(bay, bay.arm.placeInContainment())).ok).toBe(true);
    expect(await runUntil(bay, bay.arm.pick(bennu.id))).toMatchObject({ ok: true, held: bennu.id });
    const xy = spotOf(samples.findSpot(bennu.id, { side: 'left' }));
    expect(xy[0]).toBeLessThan(0);
    const held = bay.samples.get(bennu.id)!;
    expect(bay.samples.checkSpot(xy[0], xy[1], held.dims, gripWidthMm(held), held.yaw, held.id)).toBeNull();
    expect(dist2(xy, itokawa.pos)).toBeGreaterThanOrEqual(sampleRadius(held.dims) + sampleRadius(itokawa.dims) + 0.01);
    expect(await runUntil(bay, bay.arm.placeAt(xy))).toMatchObject({ ok: true, held: null });
    expect(dist2(bay.samples.get(bennu.id)!.pos, xy)).toBeLessThan(0.002);
  });

  it('side: the first free spot of the search in each region (left -x, right +x, front rho >= 170, behind rho <= 160, center within 20 degrees)', async () => {
    const { bay, bennu } = await seededBay();
    expect(await runUntil(bay, bay.arm.pick(bennu.id))).toMatchObject({ ok: true });
    const s = bay.samples.get(bennu.id)!;
    const free = ([x, y]: readonly [number, number]) => bay.samples.checkSpot(x, y, s.dims, gripWidthMm(s), s.yaw, s.id) === null;
    const inRegion: Record<string, (x: number, y: number) => boolean> = {
      left: (x) => x < 0,
      right: (x) => x > 0,
      front: (x, y) => rhoOf(x, y) >= 0.17 - 1e-9,
      behind: (x, y) => rhoOf(x, y) <= 0.16 + 1e-9,
      center: (x, y) => Math.abs(bearingOf(x, y)) <= (20 * Math.PI) / 180 + 1e-9,
    };
    expect([...DECK_SIDES]).toEqual(Object.keys(inRegion));
    for (const side of DECK_SIDES) {
      const xy = spotOf(bay.samples.findSpot(bennu.id, { side }));
      expect(inRegion[side](xy[0], xy[1]), side).toBe(true);
      expect(onDeckSide(xy[0], xy[1], side), side).toBe(true);
      expect(free(xy), side).toBe(true);
      // the best one: no spot earlier in the search order is free in that region
      const i = SEARCH_SPOTS.findIndex((p) => p[0] === xy[0] && p[1] === xy[1]);
      expect(i, side).toBeGreaterThanOrEqual(0);
      expect(SEARCH_SPOTS.slice(0, i).some((p) => inRegion[side](p[0], p[1]) && free(p)), side).toBe(false);
    }
  });

  it('no placement: the best free spot anywhere, where the held sample does not block itself', async () => {
    const bay = await makeBay(); // the cube sits in the first slot
    const cube = bay.samples.get('sample_1')!;
    // on the deck, the cube's own spot is the best free spot for it
    expect(spotOf(bay.samples.findSpot(cube.id))).toEqual(SLOTS[0]);
    const other = bay.samples.createPrimitive({ color: '#0ea5e9', kind: 'box', width_mm: 30, height_mm: 20 });
    if (!other.ok) throw new Error(other.reason);
    expect(other.sample.pos.slice(0, 2)).toEqual(SLOTS[1]);
    expect(await runUntil(bay, bay.arm.pick(cube.id))).toMatchObject({ ok: true, held: cube.id });
    expect(spotOf(bay.samples.findSpot(cube.id))).toEqual(SLOTS[0]);
    // the other box is not held, so it still blocks its slot
    expect(spotOf(bay.samples.findSpot(cube.id, {}))).not.toEqual(SLOTS[1]);
  });

  it('x_mm and y_mm: the spot as given, checked for reach, the bin and spacing, ignoring the sample itself', async () => {
    const bay = await makeBay();
    const cube = bay.samples.get('sample_1')!;
    const mmOf = ([x, y]: [number, number]): Placement => ({ x_mm: x * 1000, y_mm: y * 1000 });
    const [fx, fy] = polarXY(0.17, 0.6);
    expect(spotOf(bay.samples.findSpot(cube.id, { x_mm: fx * 1000, y_mm: fy * 1000 }))).toEqual([fx, fy]);
    // its own spot is free for it, held or not
    expect(spotOf(bay.samples.findSpot(cube.id, mmOf([cube.pos[0], cube.pos[1]])))).toEqual([cube.pos[0], cube.pos[1]]);
    const other = bay.samples.createPrimitive({ color: '#0ea5e9', kind: 'box', width_mm: 30, height_mm: 20 });
    if (!other.ok) throw new Error(other.reason);
    const code = (p: Placement) => (bay.samples.findSpot(cube.id, p) as Rejection).code;
    expect(code(mmOf([other.sample.pos[0] + 0.02, other.sample.pos[1]]))).toBe('TOO_CLOSE');
    expect(code(mmOf(CONTAINMENT_XY))).toBe('ON_CONTAINMENT');
    expect(code(mmOf(polarXY(0.26, 0)))).toBe('OUT_OF_REACH');
    expect(code({ x_mm: 10 })).toBe('BAD_PLACEMENT');
  });

  it('relative_to + direction (+ distance_mm): resolved from the reference, then checked', async () => {
    const bay = await makeBay();
    const other = bay.samples.createPrimitive({ color: '#0ea5e9', kind: 'box', width_mm: 30, height_mm: 20 });
    if (!other.ok) throw new Error(other.reason);
    const [ox, oy] = other.sample.pos;
    const xy = spotOf(bay.samples.findSpot('sample_1', { relative_to: other.sample.id, direction: 'right', distance_mm: 60 }));
    expect(xy[0]).toBeCloseTo(ox + 0.06, 12);
    expect(xy[1]).toBeCloseTo(oy, 12);
    // by name, at the default 80 mm: behind the cube is too close to the arm's axis
    const behind = bay.samples.findSpot('sample_1', { relative_to: 'sample cube', direction: 'behind' }) as Rejection;
    expect(behind).toMatchObject({ ok: false, code: 'OUT_OF_REACH' });
    expect(behind.reason).toContain(`${Math.round((-SLOTS[0][1] - 0.08) * 1000)} mm from the arm's axis`);
    const code = (p: Placement) => (bay.samples.findSpot('sample_1', p) as Rejection).code;
    expect(code({ relative_to: other.sample.id, direction: 'left', distance_mm: 20 })).toBe('TOO_CLOSE');
    expect(code({ relative_to: 'containment', direction: 'front', distance_mm: 10 })).toBe('ON_CONTAINMENT');
    expect(code({ relative_to: other.sample.id })).toBe('BAD_PLACEMENT');
    expect(code({ relative_to: 'ghost', direction: 'left' })).toBe('NO_SAMPLE');
  });

  it('refuses an unknown sample, an unknown side, and a side with no free spot', async () => {
    const bay = await makeBay();
    expect(bay.samples.findSpot('sample_9')).toMatchObject({ ok: false, code: 'NO_SAMPLE' });
    expect(bay.samples.findSpot('sample_1', { side: 'top' as Placement['side'] })).toMatchObject({ ok: false, code: 'BAD_PLACEMENT' });
    // a probe that refuses everything leaves no free spot on any side
    bay.samples.setReachProbe(() => ({ ok: false, code: 'UNREACHABLE', reason: 'the arm cannot grasp it at that spot.' }));
    const none = bay.samples.findSpot('sample_1', { side: 'front' }) as Rejection;
    expect(none).toMatchObject({ ok: false, code: 'NO_SPOT', reason: 'there is no free spot at the front of the deck for sample cube.' });
    expect(bay.samples.findSpot('sample_1')).toMatchObject({ ok: false, code: 'BAY_FULL', reason: 'there is no free spot on the deck for sample cube.' });
  });

  it('new samples take a side too', async () => {
    const bay = await makeBay();
    for (const side of ['center', 'left', 'right', 'front', 'behind'] as const) {
      const r = bay.samples.createPrimitive({ color: '#22c55e', kind: 'box', width_mm: 20, height_mm: 20, side });
      if (!r.ok) throw new Error(`${side}: ${r.reason}`);
      expect(onDeckSide(r.sample.pos[0], r.sample.pos[1], side), side).toBe(true);
    }
  });
});

describe('a refused place names the nearest free spot', () => {
  const parse = (s: string | undefined): [number, number] => {
    const m = /^try \((-?\d+), (-?\d+)\) mm$/.exec(s ?? '');
    if (!m) throw new Error(`no spot in suggestion ${JSON.stringify(s)}`);
    return [Number(m[1]) / 1000, Number(m[2]) / 1000];
  };

  it("the probe's five refused spots for Bennu each come back with the nearest free spot, and that spot works", async () => {
    const { bay, bennu } = await seededBay();
    // as in the probe: the cube is stowed, Itokawa stays at its slot, Bennu is in the gripper
    expect((await runUntil(bay, bay.arm.pick('sample_1'))).ok).toBe(true);
    expect((await runUntil(bay, bay.arm.placeInContainment())).ok).toBe(true);
    expect(await runUntil(bay, bay.arm.pick(bennu.id))).toMatchObject({ ok: true, held: bennu.id });
    const held = bay.samples.get(bennu.id)!;
    const free = (p: readonly [number, number]) => bay.samples.checkSpot(p[0], p[1], held.dims, gripWidthMm(held), held.yaw, held.id) === null;
    let last: [number, number] | null = null;
    for (const [x, y] of [
      [-100, -130],
      [-85, -145],
      [-65, -135],
      [-30, -165],
      [-70, -165],
    ]) {
      const asked: [number, number] = [x / 1000, y / 1000];
      const q = bay.arm.joints();
      const r = await runUntil(bay, bay.arm.placeAt(asked));
      expect(r, `${x}, ${y}`).toMatchObject({ ok: false, code: 'UNREACHABLE' });
      expect((r as { reason: string }).reason, `${x}, ${y}`).toMatch(/wall|overlaps|between their centres/);
      expect(bay.arm.joints()).toEqual(q); // refused before moving
      const xy = parse((r as { suggestion?: string }).suggestion);
      // a free spot, and no free spot of the search (in whole mm) is nearer to the one asked for
      expect(free(xy), `${x}, ${y}`).toBe(true);
      for (const p of SEARCH_SPOTS) {
        const mm: [number, number] = [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000];
        if (free(mm)) expect(dist2(mm, asked), `${x}, ${y}`).toBeGreaterThan(dist2(xy, asked) - 0.001);
      }
      last = xy;
    }
    // one more call recovers
    expect(await runUntil(bay, bay.arm.placeAt(last!))).toMatchObject({ ok: true, held: null });
    expect(dist2(bay.samples.get(bennu.id)!.pos, last!)).toBeLessThan(0.002);
  });

  it('only spacing and the bin wall get one; findSpot names the nearest free spot for the same refusals', async () => {
    const bay = await makeBay();
    const tall = bay.samples.createPrimitive({ color: '#a855f7', kind: 'box', width_mm: 20, height_mm: 30 });
    if (!tall.ok) throw new Error(tall.reason);
    expect((await runUntil(bay, bay.arm.pick(tall.sample.id))).ok).toBe(true);
    const cube = bay.samples.get('sample_1')!;
    // out of reach, and a stack too tall to carry over: no spot to suggest
    const far = await runUntil(bay, bay.arm.placeAt([0, -0.26]));
    expect(far).toMatchObject({ ok: false, code: 'UNREACHABLE' });
    expect(far).not.toHaveProperty('suggestion');
    const tower = await runUntil(bay, bay.arm.placeAt([cube.pos[0], cube.pos[1]]));
    expect((tower as { reason: string }).reason).toMatch(/tower/);
    expect(tower).not.toHaveProperty('suggestion');
    // crowding the cube on the deck: suggested
    const near = await runUntil(bay, bay.arm.placeAt([cube.pos[0] + 0.035, cube.pos[1]]));
    expect((near as { reason: string }).reason).toMatch(/between their centres/);
    expect((near as { suggestion?: string }).suggestion).toMatch(/^try \(-?\d+, -?\d+\) mm$/);
    // findSpot: spacing and the bin keep-out are suggested, reach is not
    const s = (p: Placement) => bay.samples.findSpot(tall.sample.id, p) as Rejection;
    expect(s({ x_mm: cube.pos[0] * 1000 + 30, y_mm: cube.pos[1] * 1000 })).toMatchObject({ code: 'TOO_CLOSE', suggestion: expect.stringMatching(/^try \(/) });
    expect(s({ x_mm: CONTAINMENT_XY[0] * 1000, y_mm: CONTAINMENT_XY[1] * 1000 })).toMatchObject({ code: 'ON_CONTAINMENT', suggestion: expect.stringMatching(/^try \(/) });
    expect(s({ x_mm: 0, y_mm: -260 }).suggestion).not.toMatch(/^try \(/);
    // and the suggested spot is free
    const xy = parse(s({ x_mm: cube.pos[0] * 1000 + 30, y_mm: cube.pos[1] * 1000 }).suggestion);
    expect(bay.samples.findSpot(tall.sample.id, { x_mm: xy[0] * 1000, y_mm: xy[1] * 1000 })).toMatchObject({ ok: true });
  });
});
