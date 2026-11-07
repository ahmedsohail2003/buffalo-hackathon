import { describe, expect, it } from 'vitest';
import type { LogLine } from '../contracts';
import { makeFakeBay, makeSample } from './__fixtures__/fakeBay';
import type { CallFn, CallResult } from './client';
import { MOVING_TOOLS, TOOL_DECLARATIONS, dispatchTool, liveToolDeclarations, type ToolContext } from './tools';
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
