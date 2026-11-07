import { describe, expect, it } from 'vitest';
import { fakeProject, makeFakeBay, makeSample } from './__fixtures__/fakeBay';
import type { CallFn, CallRequest, CallResult } from './client';
import { graspCheck, localize, matchSample, parseJsonLoose, pointAt, readPoints, verifyContainment, verifyQuestion } from './er';

const itokawa = makeSample({ id: 's3', name: 'Itokawa', dims: { w: 0.03, d: 0.02, h: 0.02 }, pos: [0.04, -0.25, 0.01] });
const cube = makeSample({ id: 's4', name: 'Red calibration cube', dims: { w: 0.025, d: 0.025, h: 0.025 }, pos: [-0.08, -0.18, 0.0125] });

function replies(...texts: Array<string | Error>) {
  const seen: CallRequest[] = [];
  const call: CallFn = async (req) => {
    seen.push(req);
    const next = texts.shift();
    if (next instanceof Error) throw next;
    return { text: next ?? '' } as CallResult;
  };
  return { call, seen };
}

const yxOf = (p: [number, number, number]) => fakeProject(p).map((v) => Math.round(v)) as [number, number];

describe('Robotics-ER pointing', () => {
  it('unprojects on the target sample plane and measures the miss against the registry in mm', () => {
    const bay = makeFakeBay({ samples: [itokawa, cube] });
    // camera points 6 mm right (+x) and 8 mm toward the operator (-y) of the registry centre
    const yx = fakeProject([itokawa.pos[0] + 0.006, itokawa.pos[1] - 0.008, itokawa.pos[2]]);
    const r = localize(bay, 'the Itokawa sample', [{ yx, label: 'itokawa' }]);
    expect(r.ok).toBe(true);
    expect(r.match?.id).toBe('s3');
    expect(r.match?.error_mm).toBeCloseTo(10, 1);
    expect(r.bay_mm).toEqual([46, -258, 10]);
    expect(r.match?.registry_mm).toEqual([40, -250, 10]);
    expect(r.match?.image_error).toBeCloseTo(Math.hypot(0.008 * 1600, 0.006 * 2000), 1);
  });

  it('with no name match, falls back to the nearest registry sample within 60 mm', () => {
    const bay = makeFakeBay({ samples: [itokawa, cube] });
    const near = localize(bay, 'the small red thing', [{ yx: yxOf([-0.075, -0.18, 0.015]), label: '' }]);
    expect(near.match?.id).toBe('s4');
    expect(near.match?.error_mm).toBeLessThan(6);
    const far = localize(bay, 'the antenna', [{ yx: yxOf([0.2, -0.4, 0.015]), label: '' }]);
    expect(far.ok).toBe(true);
    expect(far.match).toBeUndefined();
    expect(localize(bay, 'a ghost', []).ok).toBe(false);
  });

  it('retries without the schema on a 400 and reads fenced JSON', async () => {
    const bay = makeFakeBay({ samples: [itokawa] });
    const yx = yxOf(itokawa.pos);
    const { call, seen } = replies(
      Object.assign(new Error('responseJsonSchema is not supported'), { status: 400 }),
      '```json\n[{"point": [' + yx[0] + ', ' + yx[1] + '], "label": "Itokawa"}]\n```',
    );
    const r = await pointAt(bay, 'Itokawa', { call });
    expect(seen).toHaveLength(2);
    expect(seen[0].config).toMatchObject({ responseMimeType: 'application/json', responseJsonSchema: { type: 'array' } });
    expect(seen[1].config).toEqual({});
    expect(seen[0].purpose).toBe('point');
    const parts = (seen[0].contents as Array<{ parts: Array<Record<string, unknown>> }>)[0].parts;
    expect(parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'ZmFrZS1qcGVn' } });
    expect(r.schema).toBe(false);
    expect(r.match?.id).toBe('s3');
    expect(r.match?.error_mm).toBeLessThan(1);
  });

  it('reads the point formats Gemini uses and matches labels to ids or names', () => {
    expect(readPoints([{ point: [100, 200], label: 'a' }]).map((p) => p.yx)).toEqual([[100, 200]]);
    expect(readPoints({ points: [{ point: [1200, -5] }] })[0].yx).toEqual([1000, 0]);
    expect(readPoints([300, 400])[0].yx).toEqual([300, 400]);
    expect(readPoints({ nope: true })).toEqual([]);
    expect(parseJsonLoose('Sure! {"answer":"yes"} done')).toEqual({ answer: 'yes' });
    expect(matchSample([itokawa, cube], 's4')?.id).toBe('s4');
    expect(matchSample([itokawa, cube], 'the calibration cube')?.id).toBe('s4');
    expect(matchSample([itokawa, cube], 'sample s44')).toBeUndefined();
  });
});

describe('Robotics-ER verify and grasp check', () => {
  it('containment: the registry decides and the result says whether the camera agrees', async () => {
    const bay = makeFakeBay({ samples: [itokawa] });
    const inContainment = () => true;
    const { call, seen } = replies('{"answer":"no","observation":"The bin looks empty."}');
    const r = await verifyContainment(bay, 's3', { call, inContainment });
    expect(String((seen[0].contents as Array<{ parts: Array<{ text?: string }> }>)[0].parts[1].text)).toContain('Is the Itokawa (s3) inside the containment bin?');
    expect(r).toMatchObject({ ok: true, answer: 'no', decided_by: 'code', agree: false });
    expect(r.registry).toEqual([{ id: 's3', name: 'Itokawa', held: false, x_mm: 40, y_mm: -250, in_containment: true }]);
  });

  it('a question code cannot answer is decided by the camera', async () => {
    const bay = makeFakeBay({ samples: [itokawa] });
    const { call } = replies('{"answer":"yes","observation":"Two samples sit on the grid."}');
    const r = await verifyQuestion(bay, 'Is the deck clear of debris?', { call, inContainment: () => false });
    expect(r).toMatchObject({ ok: true, answer: 'yes', decided_by: 'camera', registry: [] });
  });

  it('grasp check: visible, located within tolerance, and spaced per the guardrail', async () => {
    const shard = makeSample({ id: 's9', name: 'Chondrite shard', dims: { w: 0.02, d: 0.02, h: 0.02 }, pos: [0.04, -0.21, 0.01] });
    const bay = makeFakeBay({ samples: [itokawa, shard] });
    const yx = yxOf([0.042, -0.212, 0.01]);
    const good = replies(`{"visible": true, "point": [${yx[0]}, ${yx[1]}], "clear": "yes", "observation": "Shard on the grid."}`);
    const r = await graspCheck(bay, 's9', { call: good.call });
    expect(good.seen[0].purpose).toBe('grasp_check');
    expect(r.visible).toBe(true);
    expect(r.error_mm).toBeLessThan(4);
    // 40 mm from Itokawa; the guardrail needs max(40, 18 + 14.1 + 10) = 42.1 mm
    expect(r.nearest_mm).toBe(40);
    expect(r.spacing_ok).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('Chondrite shard is 40 mm from Itokawa; it needs 42 mm.');

    bay.sampleList[0].pos = [-0.1, -0.25, 0.01];
    const again = replies(`{"visible": true, "point": [${yx[0]}, ${yx[1]}], "clear": "yes", "observation": "Clear."}`);
    expect((await graspCheck(bay, 's9', { call: again.call })).ok).toBe(true);

    const blind = replies('{"visible": false, "clear": "unsure", "observation": "Nothing there."}');
    expect(await graspCheck(bay, 's9', { call: blind.call })).toMatchObject({ ok: false, visible: false, reason: 'The bay camera cannot see Chondrite shard.' });
  });
});
