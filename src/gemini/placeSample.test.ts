// place_sample against the real core (registry, IK, motion queue, gate): the request that failed on
// the real model, "Place Bennu on the left side of the deck", with the deck as the app boots it.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BayApi } from '../contracts';
import { MIN_SPACING, createBay, inContainment, loadArmDataNode, sampleRadius, SPACING_EXTRA, type Bay } from '../core';
import { fabricatePreset, registerAsset } from '../fabricator';
import { dispatchTool } from './tools';

const DT = 1 / 60;
let armData: Awaited<ReturnType<typeof loadArmDataNode>>;

beforeAll(async () => {
  armData = await loadArmDataNode('public/assets/so101.json');
  for (const id of ['bennu', 'itokawa']) registerAsset(id, JSON.parse(readFileSync(`public/assets/samples/${id}.json`, 'utf8')));
});

function apiOf(bay: Bay): BayApi {
  return { arm: bay.arm, samples: bay.samples, gate: bay.gate, capture: () => ({ jpegB64: '', w: 0, h: 0, t: 0 }), project: () => [0, 0], unproject: () => null };
}

/** Step the simulated clock until the promise settles (motion only advances when the bay steps). */
async function settle<T>(bay: Bay, p: Promise<T>, maxSteps = 6000): Promise<T> {
  let done = false;
  let value: T | undefined;
  void p.then((v) => {
    done = true;
    value = v;
  });
  for (let i = 0; i < maxSteps && !done; i++) {
    bay.step(DT);
    await new Promise((r) => setImmediate(r));
  }
  if (!done) throw new Error('motion did not finish');
  return value as T;
}

describe('place_sample on the real core', () => {
  it('"Place Bennu on the left side of the deck" is one place_sample call with side: left', async () => {
    const bay = createBay(armData); // the seed cube at the first slot
    const api = apiOf(bay);
    for (const id of ['nasa_bennu', 'nasa_itokawa']) expect((await fabricatePreset(api, id)).ok).toBe(true);
    const [cube, bennu, itokawa] = bay.samples.list();
    expect([cube.name, bennu.name, itokawa.name]).toEqual(['sample cube', 'Bennu (NASA shape model)', 'Itokawa (NASA/JAXA shape model)']);
    bay.command('CYCLE_START');
    // the probe's deck: the cube stowed, Itokawa on the deck, Bennu in the gripper
    expect(await settle(bay, bay.arm.pick(cube.id))).toMatchObject({ ok: true });
    expect(await settle(bay, bay.arm.placeInContainment())).toMatchObject({ ok: true });
    expect(await settle(bay, bay.arm.pick(bennu.id))).toMatchObject({ ok: true, held: bennu.id });

    const r = await settle(bay, dispatchTool(api, 'place_sample', { side: 'left' }, 'test'));
    expect(r).toMatchObject({ ok: true, sample: bennu.id, holding: null });
    const after = bay.samples.get(bennu.id)!;
    expect(after.held).toBe(false);
    expect(after.pos[0]).toBeLessThan(0); // the left of the deck is -x
    expect(inContainment(after.pos[0], after.pos[1])).toBe(false);
    const gap = Math.hypot(after.pos[0] - itokawa.pos[0], after.pos[1] - itokawa.pos[1]);
    expect(gap).toBeGreaterThanOrEqual(Math.max(MIN_SPACING, sampleRadius(after.dims) + sampleRadius(itokawa.dims) + SPACING_EXTRA) - 1e-9);
    expect(r.placed_mm).toEqual([Math.round(after.pos[0] * 1000), Math.round(after.pos[1] * 1000)]);
  });
});
