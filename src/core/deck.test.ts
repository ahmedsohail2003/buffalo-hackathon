// Free deck spots with the real arm's IK probe and real fabricated samples: the default search over
// the slots and the whole reach band.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sample } from '../contracts';
import { fabricatePreset } from '../fabricator';
import { registerNasaAssets } from '../fabricator/testkit';
import { CONTAINMENT_KEEPOUT, CONTAINMENT_XY, SLOTS, bearingOf, rhoOf } from './constants';
import { SEARCH_SPOTS, gripWidthMm, sampleRadius } from './samples';
import { bayApi, dist2, makeBay } from './testutil';

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
