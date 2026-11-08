import { describe, expect, it } from 'vitest';
import { fakeProject, makeFakeBay, makeSample } from './__fixtures__/fakeBay';
import type { CallFn, CallRequest, CallResult } from './client';
import { distinctiveWords, graspCheck, localize, matchSample, mentionedSamples, parseJsonLoose, pointAt, readPoints, verifyContainment, verifyQuestion } from './er';

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

  it('the registry decides only "is X in the bin"; other bin questions are the camera\'s, with in_containment as data', async () => {
    const bay = makeFakeBay({ samples: [itokawa] });
    for (const question of [
      'Is the Itokawa outside the containment bin?',
      'Is the Itokawa still on the deck, out of the bin?',
      'Is the Itokawa not in the containment bin?',
      'Is the Itokawa to the right of the containment bin?',
      'Did the Itokawa fall out of the bin?',
    ]) {
      const { call } = replies('{"answer":"yes","observation":"It sits on the grid beside the bin."}');
      const r = await verifyQuestion(bay, question, { call, inContainment: () => false });
      expect(r).toMatchObject({ ok: true, answer: 'yes', decided_by: 'camera' });
      expect(r).not.toHaveProperty('agree');
      expect(r.registry).toEqual([expect.objectContaining({ id: 's3', in_containment: false })]);
    }
    const { call } = replies('{"answer":"yes","observation":"It is in the bin."}');
    const r = await verifyQuestion(bay, 'Is the Itokawa in containment?', { call, inContainment: () => false });
    expect(r).toMatchObject({ ok: false, answer: 'yes', decided_by: 'code', agree: false });
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

describe('sample names: the real seeds', () => {
  // the bay's seeds, as src/core/samples.ts and the NASA presets name them
  const cubeSeed = makeSample({ id: 'sample_1', name: 'sample cube', dims: { w: 0.024, d: 0.024, h: 0.024 }, pos: [0, -0.165, 0.012] });
  const bennuSeed = makeSample({ id: 'sample_2', name: 'Bennu (NASA shape model)', kind: 'mesh', dims: { w: 0.031, d: 0.03, h: 0.03 }, pos: [0.056, -0.155, 0.015] });
  const itokawaSeed = makeSample({ id: 'sample_3', name: 'Itokawa (NASA/JAXA shape model)', kind: 'mesh', dims: { w: 0.03, d: 0.022, h: 0.02 }, pos: [-0.051, -0.157, 0.01] });
  const seeds = [cubeSeed, bennuSeed, itokawaSeed];
  const ids = (list: Array<{ id: string }>) => list.map((s) => s.id);

  it('a distinctive word of one sample selects it; parentheticals and generic words do not count', () => {
    expect(distinctiveWords('Bennu (NASA shape model)')).toEqual(['bennu']);
    expect(distinctiveWords('Itokawa (NASA/JAXA shape model)')).toEqual(['itokawa']);
    expect(distinctiveWords('sample cube')).toEqual(['cube']);
    expect(ids(mentionedSamples(seeds, 'Is Itokawa inside the containment bin?'))).toEqual(['sample_3']);
    expect(ids(mentionedSamples(seeds, 'Is the Bennu sample inside the containment bin?'))).toEqual(['sample_2']);
    expect(ids(mentionedSamples(seeds, 'Is Bennu (NASA shape model) inside the containment bin?'))).toEqual(['sample_2']);
    expect(ids(mentionedSamples(seeds, 'Is the sample cube inside the containment bin?'))).toEqual(['sample_1']);
    expect(ids(mentionedSamples(seeds, 'Is sample_3 inside the containment bin?'))).toEqual(['sample_3']);
    expect(mentionedSamples(seeds, 'Is the NASA shape model in the bin?')).toEqual([]);
    expect(matchSample(seeds, 'the Bennu sample')?.id).toBe('sample_2');
    expect(matchSample(seeds, 'the Itokawa sample')?.id).toBe('sample_3');
    expect(matchSample(seeds, 'Itokawa (NASA/JAXA shape model)')?.id).toBe('sample_3');
  });

  it('a word two samples share is ambiguous (undefined) unless another word or the id settles it', () => {
    const bennuPreset = makeSample({ id: 'sample_4', name: 'Bennu fragment', pos: [0.1, -0.13, 0.015] });
    const deck = [...seeds, bennuPreset];
    expect(matchSample(deck, 'Is Bennu in the bin?')).toBeUndefined();
    expect(matchSample(deck, 'the Bennu fragment')).toBeUndefined();
    expect(ids(mentionedSamples(deck, 'Is Bennu in the bin?'))).toEqual(['sample_2', 'sample_4']);
    expect(matchSample(deck, 'the Bennu fragment (sample_4)')?.id).toBe('sample_4');
    expect(matchSample(deck, 'Itokawa')?.id).toBe('sample_3');
    const iron = makeSample({ id: 'sample_5', name: 'Iron meteorite' });
    const stony = makeSample({ id: 'sample_6', name: 'Stony meteorite' });
    expect(matchSample([iron, stony], 'the iron meteorite')?.id).toBe('sample_5');
    expect(matchSample([iron, stony], 'the meteorite')).toBeUndefined();
  });

  it('check_bay on a NASA seed is decided by the registry; a sample id selects directly', async () => {
    const bay = makeFakeBay({ samples: seeds });
    const inContainment = (s: { id: string }) => s.id === 'sample_3';
    const a = replies('{"answer":"no","observation":"Itokawa is held by the gripper above the bin."}');
    const r = await verifyQuestion(bay, 'Is Itokawa inside the containment bin?', { call: a.call, inContainment });
    expect(r).toMatchObject({ ok: true, answer: 'no', decided_by: 'code', agree: false });
    expect(r.registry).toEqual([{ id: 'sample_3', name: 'Itokawa (NASA/JAXA shape model)', held: false, x_mm: -51, y_mm: -157, in_containment: true }]);

    const b = replies('{"answer":"no","observation":"The bin holds one grey rock."}');
    const byId = await verifyQuestion(bay, 'Is it inside the containment bin?', { call: b.call, inContainment }, 'sample_2');
    expect(byId).toMatchObject({ ok: false, decided_by: 'code', agree: true });
    expect(byId.registry.map((s) => s.id)).toEqual(['sample_2']);
  });

  it('point_at measures the miss against the named seed, not whichever rock is nearest the point', () => {
    const bay = makeFakeBay({ samples: seeds });
    // the camera points at Itokawa although the label asks for Bennu
    const r = localize(bay, 'the Bennu sample', [{ yx: yxOf(itokawaSeed.pos), label: 'rock' }]);
    expect(r.match?.id).toBe('sample_2');
    expect(r.match?.error_mm).toBeGreaterThan(100);
    const byId = localize(bay, 'the grey rock', [{ yx: yxOf(itokawaSeed.pos), label: 'rock' }], 'sample_3');
    expect(byId.match?.id).toBe('sample_3');
    expect(byId.match?.error_mm).toBeLessThan(3);
  });
});
