import { describe, expect, it } from 'vitest';
import type { BayState, LogLine } from '../contracts';
import { fakeProject, makeFakeBay, makeSample, type FakeBay } from './__fixtures__/fakeBay';
import { BAY_FACTS_TEXT } from './bayFacts';
import type { CallFn, CallResult } from './client';
import { MOVING_TOOLS, TOOL_DECLARATIONS, dispatchTool, liveToolDeclarations, summarizeResult, type ToolContext } from './tools';
import type { FabricateFn } from './types';

const bennu = makeSample({
  id: 's1',
  name: 'Bennu fragment',
  kind: 'mesh',
  dims: { w: 0.032, d: 0.03, h: 0.028 },
  pos: [0.05, -0.22, 0.014],
  mesh: { program: { name: 'bennu', category: 'asteroid', parts: [] }, graspWidthMm: 32, heightMm: 28, massG: 41.26, scale: 0.8, source: 'nasa', assetId: 'bennu' },
});
const cube = makeSample({ id: 's2', name: 'Red calibration cube', dims: { w: 0.025, d: 0.025, h: 0.025 }, pos: [-0.06, -0.2, 0.0125] });

function ctx(extra: Partial<ToolContext> = {}) {
  const lines: LogLine[] = [];
  const c: ToolContext = { sink: { log: (l) => lines.push(l), ledger() {} }, ...extra };
  return { c, lines };
}

const noCall: CallFn = async () => {
  throw new Error('Gemini should not be called');
};

describe('tools: gate rules', () => {
  it('refuses arm moves while IDLE (AI never starts a cycle); design and read-only tools still run', async () => {
    const bay = makeFakeBay({ samples: [bennu], state: 'IDLE' });
    const { c } = ctx({ fabricate: async () => ({ ok: true, sample: bennu, say: 'made' }) });
    const calls: Array<[string, Record<string, unknown>]> = [
      ['pick_sample', { id: 's1' }],
      ['place_sample', { x_mm: 0, y_mm: -200 }],
      ['place_in_containment', {}],
      ['go_home', {}],
    ];
    for (const [name, args] of calls) {
      const r = await dispatchTool(bay, name, args, 'live', c);
      expect(r).toMatchObject({ ok: false, code: 'BAY_IDLE', bay_state: 'IDLE' });
      expect(String(r.reason)).toMatch(/^The bay is idle\. The operator has to start the cycle first/);
    }
    expect(bay.calls.filter((x) => x.fn !== 'capture')).toEqual([]);
    expect(bay.gate.state()).toBe('IDLE');
    expect(await dispatchTool(bay, 'design_sample', { description: 'a shard' }, 'live', c)).toMatchObject({ ok: true });
    expect(await dispatchTool(bay, 'bay_status', {}, 'live', c)).toMatchObject({ ok: true, bay_state: 'IDLE' });
  });

  it('refuses every moving or creating tool while STOPPED or ESTOPPED, with a speakable reason', async () => {
    for (const state of ['STOPPED', 'ESTOPPED'] as const) {
      const bay = makeFakeBay({ samples: [bennu], state });
      const { c } = ctx({ fabricate: async () => ({ ok: true, sample: bennu, say: 'made' }) });
      const calls: Array<[string, Record<string, unknown>]> = [
        ['pick_sample', { id: 's1' }],
        ['place_sample', { x_mm: 0, y_mm: -200 }],
        ['place_in_containment', {}],
        ['go_home', {}],
        ['design_sample', { description: 'a shard' }],
      ];
      expect(calls.map(([n]) => n).sort()).toEqual([...MOVING_TOOLS].sort());
      for (const [name, args] of calls) {
        const r = await dispatchTool(bay, name, args, 'test', c);
        expect(r.ok).toBe(false);
        expect(r.code).toBe(state === 'STOPPED' ? 'BAY_STOPPED' : 'BAY_ESTOPPED');
        expect(String(r.reason)).toMatch(/^[A-Z][^{}]+\.$/);
      }
      expect(bay.calls.filter((x) => x.fn !== 'capture')).toEqual([]);
    }
  });

  it('read-only tools answer even during an emergency stop', async () => {
    const bay = makeFakeBay({ samples: [bennu, cube], state: 'ESTOPPED' });
    const { c } = ctx({ call: noCall });
    const d = await dispatchTool(bay, 'describe_bay', {}, 'test', c);
    expect(d.ok).toBe(true);
    expect(d.bay_state).toBe('ESTOPPED');
    const s = await dispatchTool(bay, 'bay_status', {}, 'test', c);
    expect(s).toMatchObject({ ok: true, bay_state: 'ESTOPPED', speed_factor: 0, holding: null, sample_count: 2 });

    const erReply: CallFn = async () => ({ text: '{"answer":"no","observation":"The arm is still."}' }) as CallResult;
    const v = await dispatchTool(bay, 'check_bay', { question: 'Is the arm moving?' }, 'test', { call: erReply });
    expect(v).toMatchObject({ ok: false, answer: 'no', decided_by: 'camera' });
  });
});

describe('tools: dispatch', () => {
  it('describe_bay reports grip width, height, mass and position in mm', async () => {
    const bay = makeFakeBay({ samples: [bennu, cube] });
    const d = await dispatchTool(bay, 'describe_bay', {}, 'test');
    const samples = d.samples as Array<Record<string, unknown>>;
    expect(samples[0]).toMatchObject({ id: 's1', name: 'Bennu fragment', grip_width_mm: 32, height_mm: 28, mass_g: 41.3, x_mm: 50, y_mm: -220, z_mm: 14, held: false });
    expect(samples[1]).toMatchObject({ id: 's2', grip_width_mm: 25, height_mm: 25 });
    expect(samples[1].mass_g).toBeUndefined();
    expect(d.containment_mm).toEqual([-127, -127]);
    expect(String(d.frame)).toContain('y points away from the operator');
    expect(d.arm).toMatchObject({ phase: 'idle', holding: null });
  });

  it('pick, place (mm to m), containment and home go through the arm API and log a line each way', async () => {
    const bay = makeFakeBay({ samples: [bennu, cube] });
    const { c, lines } = ctx(); // the default containment check uses the published bin geometry
    expect(await dispatchTool(bay, 'pick_sample', { id: 's1' }, 'coworker', c)).toMatchObject({ ok: true, holding: 's1', sample: 's1' });
    expect(await dispatchTool(bay, 'place_sample', { x_mm: 80, y_mm: '-240' }, 'coworker', c)).toMatchObject({ ok: true, sample: 's1', placed_mm: [80, -240] });
    expect(bay.calls.find((x) => x.fn === 'placeAt')?.args[0]).toEqual([0.08, -0.24]);
    await dispatchTool(bay, 'pick_sample', { id: 'Red calibration cube' }, 'coworker', c); // a name resolves to its id
    expect(await dispatchTool(bay, 'place_in_containment', {}, 'coworker', c)).toMatchObject({ ok: true, sample: 's2', in_containment: true });
    expect(await dispatchTool(bay, 'go_home', {}, 'coworker', c)).toMatchObject({ ok: true });
    expect(lines).toHaveLength(10);
    expect(lines.every((l) => l.kind === 'gemini' && l.text.startsWith('[coworker] '))).toBe(true);
    expect(lines[0].text).toBe('[coworker] pick_sample(id: "s1")');
    expect(lines[1].text).toBe('[coworker] pick_sample -> ok, holding s1');
    expect(lines[7].text).toContain('registry: inside');
  });

  it('passes arm refusals through and validates arguments', async () => {
    const bay = makeFakeBay({ samples: [bennu] });
    bay.nextMove = { ok: false, code: 'UNREACHABLE', reason: 'That spot is outside the reach band.' };
    expect(await dispatchTool(bay, 'pick_sample', { id: 's1' }, 'test')).toEqual({ ok: false, code: 'UNREACHABLE', reason: 'That spot is outside the reach band.' });
    expect(await dispatchTool(bay, 'pick_sample', { id: 's9' }, 'test')).toMatchObject({ ok: false, code: 'NO_SAMPLE', reason: 'There is no sample s9. Samples on deck: s1.' });
    expect(await dispatchTool(bay, 'place_sample', { x_mm: 'left' }, 'test')).toMatchObject({ ok: false, code: 'BAD_ARGS' });
    expect(await dispatchTool(bay, 'fly_to_mars', {}, 'test')).toMatchObject({ ok: false, code: 'UNKNOWN_TOOL' });
  });

  it('design_sample refuses until the fabricator is wired, then forwards description, placement and generateJson', async () => {
    const bay = makeFakeBay({ samples: [bennu] });
    expect(await dispatchTool(bay, 'design_sample', { description: 'a chondrite' }, 'test', { fabricate: null })).toMatchObject({
      ok: false,
      code: 'FABRICATOR_OFFLINE',
    });

    const seen: unknown[] = [];
    const generateJson = async () => ({ text: '{}', latencyMs: 1 });
    const fabricate: FabricateFn = async (_bay, description, placement, deps) => {
      seen.push(description, placement, deps.generateJson === generateJson);
      return { ok: true, sample: { ...cube, id: 's7', name: 'Chondrite shard' }, say: 'Chondrite shard fabricated. Grip 25 millimetres.' };
    };
    const r = await dispatchTool(
      bay,
      'design_sample',
      { description: 'a chondrite', relative_to: 's1', direction: 'left', distance_mm: 60, x_mm: null },
      'live',
      { fabricate, generateJson },
    );
    expect(r).toMatchObject({ ok: true, say: 'Chondrite shard fabricated. Grip 25 millimetres.', sample: { id: 's7', grip_width_mm: 25 } });
    expect(seen).toEqual(['a chondrite', { relative_to: 's1', direction: 'left', distance_mm: 60 }, true]);

    const refuse: FabricateFn = async () => ({ ok: false, code: 'TOO_HEAVY', reason: 'It would weigh 140 g; the limit is 100 g.', suggestion: 'Make it smaller.' });
    expect(await dispatchTool(bay, 'design_sample', { description: 'a lead brick' }, 'test', { fabricate: refuse })).toEqual({
      ok: false,
      code: 'TOO_HEAVY',
      reason: 'It would weigh 140 g; the limit is 100 g.',
      suggestion: 'Make it smaller.',
    });
  });

  it('a tool that throws comes back as a TOOL_ERROR result, never an exception', async () => {
    const bay = makeFakeBay({ samples: [bennu] });
    bay.arm.home = async () => {
      throw new Error('servo bus timeout');
    };
    expect(await dispatchTool(bay, 'go_home', {}, 'test')).toMatchObject({ ok: false, code: 'TOOL_ERROR', reason: 'go_home failed: servo bus timeout' });
  });

  it('declares nine tools; Live runs the long ones NON_BLOCKING', () => {
    expect(TOOL_DECLARATIONS.map((d) => d.name)).toEqual([
      'describe_bay',
      'bay_status',
      'pick_sample',
      'place_sample',
      'place_in_containment',
      'go_home',
      'design_sample',
      'check_bay',
      'point_at',
    ]);
    const live = Object.fromEntries(liveToolDeclarations().map((d) => [d.name, d.behavior]));
    expect(live).toMatchObject({ describe_bay: 'BLOCKING', bay_status: 'BLOCKING', pick_sample: 'NON_BLOCKING', check_bay: 'NON_BLOCKING' });
    for (const d of TOOL_DECLARATIONS) if (d.parameters) expect(d.parameters.type).toBe('OBJECT');
  });
});

describe('tools: check_bay and point_at take a sample_id', () => {
  const bennuSeed = makeSample({ id: 'sample_2', name: 'Bennu (NASA shape model)', kind: 'mesh', dims: { w: 0.031, d: 0.03, h: 0.03 }, pos: [0.056, -0.155, 0.015] });
  const itokawaSeed = makeSample({ id: 'sample_3', name: 'Itokawa (NASA/JAXA shape model)', kind: 'mesh', dims: { w: 0.03, d: 0.022, h: 0.02 }, pos: [-0.051, -0.157, 0.01] });

  it('declares sample_id as an optional string on both tools', () => {
    for (const name of ['check_bay', 'point_at']) {
      const d = TOOL_DECLARATIONS.find((x) => x.name === name);
      expect(d?.parameters?.properties?.sample_id).toMatchObject({ type: 'STRING' });
      expect(d?.parameters?.required).not.toContain('sample_id');
    }
  });

  it('check_bay: sample_id selects the sample, so the registry decides; an unknown id is refused before any Gemini call', async () => {
    const bay = makeFakeBay({ samples: [bennuSeed, itokawaSeed] });
    const erReply: CallFn = async () => ({ text: '{"answer":"no","observation":"The gripper hides the bin."}' }) as CallResult;
    const r = await dispatchTool(bay, 'check_bay', { question: 'Is it inside the containment bin?', sample_id: 'sample_3' }, 'test', {
      call: erReply,
      inContainment: (s) => s.id === 'sample_3',
    });
    expect(r).toMatchObject({ ok: true, decided_by: 'code', agree: false, registry: [expect.objectContaining({ id: 'sample_3', in_containment: true })] });
    const unknown = await dispatchTool(bay, 'check_bay', { question: 'Is it in the bin?', sample_id: 'sample_9' }, 'test', { call: noCall });
    expect(unknown).toEqual({ ok: false, code: 'NO_SAMPLE', reason: 'There is no sample sample_9. Samples on deck: sample_2, sample_3.' });
    expect(bay.calls.filter((x) => x.fn === 'capture')).toHaveLength(1);
  });

  it('point_at: sample_id (an id or a name) is the target the miss is measured against', async () => {
    const bay = makeFakeBay({ samples: [bennuSeed, itokawaSeed] });
    // the camera points at Itokawa; asked for Bennu, the result must report the miss against Bennu
    const [y, x] = fakeProject(itokawaSeed.pos).map(Math.round);
    const pointReply: CallFn = async () => ({ text: `[{"point": [${y}, ${x}], "label": "dark rock"}]` }) as CallResult;
    for (const ref of ['sample_2', 'Bennu']) {
      const r = await dispatchTool(bay, 'point_at', { label: 'the dark rock', sample_id: ref }, 'test', { call: pointReply });
      expect(r).toMatchObject({ ok: true, match: { id: 'sample_2' } });
      expect((r.match as { error_mm: number }).error_mm).toBeGreaterThan(100);
    }
  });
});

describe('tools: the check_bay summary leads with the decision', () => {
  it('registry decisions read "<decision> (registry decides); camera says <answer>: <observation>", the same in both branches', () => {
    const obs = 'The cube is held by the gripper above the bin.';
    expect(summarizeResult('check_bay', { ok: true, answer: 'no', observation: obs, decided_by: 'code', agree: false })).toBe(
      `yes (registry decides); camera says no: ${obs}`,
    );
    expect(summarizeResult('check_bay', { ok: false, answer: 'yes', observation: 'It sits in the bin.', decided_by: 'code', agree: false })).toBe(
      'no (registry decides); camera says yes: It sits in the bin.',
    );
    expect(summarizeResult('check_bay', { ok: true, answer: 'yes', observation: 'It sits in the bin.', decided_by: 'code', agree: true })).toBe(
      'yes (registry decides); camera says yes: It sits in the bin.',
    );
    expect(summarizeResult('check_bay', { ok: true, answer: 'unsure', observation: 'The arm hides the bin.', decided_by: 'code' })).toBe(
      'yes (registry decides); camera is unsure: The arm hides the bin.',
    );
    expect(summarizeResult('check_bay', { ok: false, answer: 'no', observation: 'The arm is still.', decided_by: 'camera' })).toBe('no (camera decides): The arm is still.');
    expect(summarizeResult('check_bay', { ok: true, answer: 'yes', observation: '', decided_by: 'camera' })).toBe('yes (camera decides)');
  });

  it('the log line shows the registry decision first', async () => {
    const bay = makeFakeBay({ samples: [bennu] });
    const { c, lines } = ctx({ call: async () => ({ text: '{"answer":"no","observation":"The bin looks empty."}' }) as CallResult, inContainment: () => true });
    await dispatchTool(bay, 'check_bay', { question: 'Is the Bennu fragment inside the containment bin?' }, 'coworker', c);
    expect(lines[1].text).toBe('[coworker] check_bay -> yes (registry decides); camera says no: The bin looks empty.');
  });
});

describe('tools: a camera check first moves an empty, idle arm clear of the view', () => {
  const cubeSeed = makeSample({ id: 'sample_1', name: 'sample cube', dims: { w: 0.024, d: 0.024, h: 0.024 }, pos: [0, -0.165, 0.012] });
  const itokawaSeed = makeSample({ id: 'sample_3', name: 'Itokawa (NASA/JAXA shape model)', kind: 'mesh', dims: { w: 0.03, d: 0.022, h: 0.02 }, pos: [-0.051, -0.157, 0.01] });
  const binQuestion = { question: 'Is the sample cube inside the containment bin?' };
  const yes: CallFn = async () => ({ text: '{"answer":"yes","observation":"The cube sits in the bin."}' }) as CallResult;
  const fns = (bay: FakeBay) => bay.calls.map((x) => x.fn);

  /** the cube stowed: the open gripper is left straight above the bin, as the real arm leaves it */
  async function stowed(state: BayState = 'RUNNING'): Promise<FakeBay> {
    const bay = makeFakeBay({ samples: [cubeSeed, itokawaSeed] });
    await bay.arm.pick('sample_1');
    await bay.arm.placeInContainment();
    bay.calls.length = 0;
    bay.setState(state);
    return bay;
  }

  it('RUNNING, idle and empty over the bin: home first (logged), then the frame', async () => {
    const bay = await stowed();
    const { c, lines } = ctx({ call: yes });
    const r = await dispatchTool(bay, 'check_bay', binQuestion, 'coworker', c);
    expect(fns(bay)).toEqual(['home', 'capture']);
    expect(lines.map((l) => l.text)).toEqual([
      '[coworker] check_bay(question: "Is the sample cube inside the containment bin?")',
      '[coworker] moving the arm clear of the camera first',
      '[coworker] check_bay -> yes (registry decides); camera says yes: The cube sits in the bin.',
    ]);
    expect(r).toMatchObject({ ok: true, decided_by: 'code', agree: true });
    expect(r).not.toHaveProperty('note');
  });

  it('near the sample in question it moves clear too (point_at as well); far from it, or already home, it does not', async () => {
    const bay = makeFakeBay({ samples: [cubeSeed, itokawaSeed] });
    await bay.arm.pick('sample_3');
    await bay.arm.placeAt([itokawaSeed.pos[0], itokawaSeed.pos[1]]); // the gripper is left above Itokawa
    bay.calls.length = 0;
    const [y, x] = fakeProject(itokawaSeed.pos).map(Math.round);
    const point: CallFn = async () => ({ text: `[{"point": [${y}, ${x}], "label": "Itokawa"}]` }) as CallResult;
    const r = await dispatchTool(bay, 'point_at', { label: 'the Itokawa sample' }, 'test', { call: point });
    expect(fns(bay)).toEqual(['home', 'capture']);
    expect(r).toMatchObject({ ok: true, match: { id: 'sample_3' } });
    // now at home: about 69 mm from Itokawa and 55 mm from the cube, but a parked-home arm hides nothing
    bay.calls.length = 0;
    await dispatchTool(bay, 'check_bay', { question: 'Is Itokawa on the grid?' }, 'test', { call: yes });
    expect(fns(bay)).toEqual(['capture']);
    // over the bin, a question about a sample elsewhere and not about the bin: no move
    const far = await stowed();
    await dispatchTool(far, 'check_bay', { question: 'Is Itokawa on the grid?' }, 'test', { call: yes });
    expect(fns(far)).toEqual(['capture']);
  });

  it('never moves unless the bay is RUNNING and the arm is idle', async () => {
    for (const state of ['IDLE', 'SLOW', 'STOPPED', 'ESTOPPED'] as const) {
      const bay = await stowed(state);
      const { c, lines } = ctx({ call: yes });
      await dispatchTool(bay, 'check_bay', binQuestion, 'test', c);
      expect(fns(bay)).toEqual(['capture']);
      expect(lines.some((l) => l.text.includes('moving the arm clear'))).toBe(false);
      expect(bay.gate.state()).toBe(state);
    }
    const busy = await stowed();
    busy.armBusy = true;
    await dispatchTool(busy, 'check_bay', binQuestion, 'test', { call: yes });
    expect(fns(busy)).toEqual(['capture']);
  });

  it('never moves while holding: the result and its summary say the gripper may hide the sample', async () => {
    const bay = makeFakeBay({ samples: [cubeSeed, itokawaSeed] });
    await bay.arm.pick('sample_3'); // the gripper is right above Itokawa, holding it
    bay.calls.length = 0;
    const { c, lines } = ctx({ call: async () => ({ text: '{"answer":"yes","observation":"Itokawa is in the gripper."}' }) as CallResult });
    const r = await dispatchTool(bay, 'check_bay', { question: 'Is Itokawa inside the containment bin?' }, 'test', c);
    expect(fns(bay)).toEqual(['capture']);
    const note = 'The gripper is holding Itokawa (NASA/JAXA shape model), so it may hide the sample from the camera.';
    expect(r).toMatchObject({ ok: false, decided_by: 'code', note });
    expect(lines[1].text).toBe(`[test] check_bay -> no (registry decides); camera says yes: Itokawa is in the gripper. ${note}`);
  });
});

describe('tools: place_sample lets code choose the spot', () => {
  const bennuSeed = makeSample({ id: 'sample_2', name: 'Bennu (NASA shape model)', kind: 'mesh', dims: { w: 0.031, d: 0.03, h: 0.03 }, pos: [0.056, -0.155, 0.015] });
  const itokawaSeed = makeSample({ id: 'sample_3', name: 'Itokawa (NASA/JAXA shape model)', kind: 'mesh', dims: { w: 0.03, d: 0.022, h: 0.02 }, pos: [-0.051, -0.157, 0.01] });

  /** Bennu in the gripper; findSpot records what it is asked and answers with `answer` */
  async function holdingBennu(answer: ReturnType<FakeBay['samples']['findSpot']> = { ok: true, xy: [-0.16, -0.08] }) {
    const bay = makeFakeBay({ samples: [bennuSeed, itokawaSeed] });
    await bay.arm.pick('sample_2');
    bay.calls.length = 0;
    const asked: unknown[] = [];
    bay.samples.findSpot = (id, placement) => {
      asked.push([id, placement]);
      return answer;
    };
    return { bay, asked };
  }

  it('side, relative_to + direction, or nothing: findSpot for the held sample, then the arm places there', async () => {
    const { bay, asked } = await holdingBennu();
    const { c, lines } = ctx();
    expect(await dispatchTool(bay, 'place_sample', { side: 'left' }, 'coworker', c)).toMatchObject({ ok: true, sample: 'sample_2', placed_mm: [-160, -80] });
    expect(bay.calls).toEqual([{ fn: 'placeAt', args: [[-0.16, -0.08]] }]);
    expect(lines[1].text).toBe('[coworker] place_sample -> ok, sample_2 down at (-160, -80) mm');
    for (const args of [{ relative_to: 'sample_3', direction: 'behind', distance_mm: 60 }, {}, { direction: 'left' }]) {
      await bay.arm.pick('sample_2');
      expect(await dispatchTool(bay, 'place_sample', args, 'test')).toMatchObject({ ok: true });
    }
    expect(asked).toEqual([
      ['sample_2', { side: 'left' }],
      ['sample_2', { relative_to: 'sample_3', direction: 'behind', distance_mm: 60 }],
      ['sample_2', {}],
      ['sample_2', { side: 'left' }], // a direction with nothing to be relative to means that side of the deck
    ]);
  });

  it('a spot code refuses comes back with its reason and suggestion, and nothing moves', async () => {
    const reason = 'there is no free spot on the left of the deck for Bennu (NASA shape model).';
    const { bay } = await holdingBennu({ ok: false, code: 'NO_SPOT', reason, suggestion: 'try another side, or leave the side out for any free spot' });
    const { c, lines } = ctx();
    expect(await dispatchTool(bay, 'place_sample', { side: 'left' }, 'test', c)).toEqual({
      ok: false,
      code: 'NO_SPOT',
      reason,
      suggestion: 'try another side, or leave the side out for any free spot',
    });
    expect(bay.calls).toEqual([]);
    expect(lines[1].text).toBe(`[test] place_sample -> refused (NO_SPOT): ${reason} Try another side, or leave the side out for any free spot.`);
  });

  it('exact x/y go straight to the arm; its refusal passes the suggested free spot through', async () => {
    const { bay, asked } = await holdingBennu();
    const reason = 'that spot is 24 mm from Itokawa (NASA/JAXA shape model); leave at least 44 mm between their centres so the jaw has room.';
    bay.nextMove = { ok: false, code: 'UNREACHABLE', reason, suggestion: 'try (-127, -59) mm' };
    const { c, lines } = ctx();
    expect(await dispatchTool(bay, 'place_sample', { x_mm: -70, y_mm: -165 }, 'test', c)).toEqual({ ok: false, code: 'UNREACHABLE', reason, suggestion: 'try (-127, -59) mm' });
    expect(bay.calls).toEqual([{ fn: 'placeAt', args: [[-0.07, -0.165]] }]);
    expect(asked).toEqual([]);
    expect(lines[1].text).toBe(`[test] place_sample -> refused (UNREACHABLE): ${reason} Try (-127, -59) mm.`);
  });

  it('validates its arguments and needs something in the gripper', async () => {
    const { bay, asked } = await holdingBennu();
    expect(await dispatchTool(bay, 'place_sample', { x_mm: -70 }, 'test')).toMatchObject({ ok: false, code: 'BAD_ARGS' });
    expect(await dispatchTool(bay, 'place_sample', { x_mm: -70, y_mm: 'far' }, 'test')).toMatchObject({ ok: false, code: 'BAD_ARGS' });
    expect(await dispatchTool(bay, 'place_sample', { side: 'up' }, 'test')).toMatchObject({ ok: false, code: 'BAD_ARGS' });
    const empty = makeFakeBay({ samples: [bennuSeed] });
    expect(await dispatchTool(empty, 'place_sample', { side: 'left' }, 'test')).toEqual({ ok: false, code: 'NOTHING_HELD', reason: 'The gripper is not holding anything to place.' });
    expect(asked).toEqual([]);
    expect(bay.calls).toEqual([]);
  });

  it('the declaration and the bay facts tell the model how: side, spacing and the bin keep-out', () => {
    const d = TOOL_DECLARATIONS.find((x) => x.name === 'place_sample');
    expect(d?.parameters?.required).toBeUndefined();
    expect(Object.keys(d?.parameters?.properties ?? {}).sort()).toEqual(['direction', 'distance_mm', 'relative_to', 'side', 'x_mm', 'y_mm']);
    expect(d?.parameters?.properties?.side?.enum).toEqual(['left', 'right', 'front', 'behind', 'center']);
    expect(d?.description).toContain('give side');
    expect(BAY_FACTS_TEXT).toContain('40 mm or more between centres');
    expect(BAY_FACTS_TEXT).toContain('the bin has a keep-out');
    expect(BAY_FACTS_TEXT).toContain('give place_sample a side of the deck (left, right, front, behind or center) and code chooses a free spot there');
  });
});

describe('tools: app-wide wiring', () => {
  it('configureTools sets defaults that an unset per-call field never overrides', async () => {
    const { configureTools } = await import('./tools');
    const lines: LogLine[] = [];
    configureTools({ sink: { log: (l) => lines.push(l), ledger() {} } });
    try {
      const bay = makeFakeBay({ samples: [bennu] });
      await dispatchTool(bay, 'bay_status', {}, 'coworker', { sink: undefined, fabricate: undefined });
      expect(lines.map((l) => l.text)).toEqual(['[coworker] bay_status()', '[coworker] bay_status -> bay RUNNING, arm idle, holding nothing']);
    } finally {
      configureTools({ sink: null });
    }
  });
});
