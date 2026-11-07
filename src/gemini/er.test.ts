import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GenerateContentConfig } from '@google/genai/web';
import { setGenerateForTests } from './client';
import { graspCheck, pointAt, verifyStep } from './er';
import { DEMO } from './models';
import { StubCell } from './stubs';
import { bus } from '../telemetry/bus';
import { egress } from '../telemetry/egress';

type Call = { config: GenerateContentConfig; text: string };
const calls: Call[] = [];
let responses: (string | Error)[] = [];

function fake(...rs: (string | Error)[]) {
  responses = rs;
  setGenerateForTests(async ({ config, contents }) => {
    const text = typeof contents === 'string' ? contents : (contents[0].parts?.find((p) => p.text)?.text ?? '');
    calls.push({ config, text });
    const r = responses.shift();
    if (r === undefined) throw new Error('no fake response left');
    if (r instanceof Error) throw r;
    return { text: r, usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 30, thoughtsTokenCount: 100 } } as never;
  });
}

describe('er.ts (mocked callER)', () => {
  let cell: StubCell;
  beforeEach(() => { cell = new StubCell(1); calls.length = 0; bus._reset(); egress._reset(); DEMO.pointSchema = true; DEMO.consensusN = 1; });
  afterEach(() => setGenerateForTests(null));

  it('stub cell camera projects the seed block near the measured [564,577] and unprojects back', () => {
    const [y, x] = cell.projectMujoco([0, -0.23, 0.012]);
    expect(Math.abs(y - 564)).toBeLessThanOrEqual(15);
    expect(Math.abs(x - 577)).toBeLessThanOrEqual(15);
    const back = cell.unprojectER([y, x], 0.012)!;
    expect(back[0]).toBeCloseTo(0, 2);
    expect(back[1]).toBeCloseTo(-0.23, 2);
  });

  it('pointAt: error in mm against the registry, unprojected on the top face (z = h), schema on', async () => {
    const top = cell.projectMujoco([0, -0.23, 0.024]); // top face centre, what the prompt asks for
    fake(JSON.stringify([{ point: top, label: 'red block' }, { point: [250, 136], label: 'tray' }]));
    const f = cell.capture();
    const pts = await pointAt(cell, f, ['red block', 'tray']);
    expect(calls).toHaveLength(1);
    expect(calls[0].config.responseMimeType).toBe('application/json');
    expect(calls[0].config.responseJsonSchema).toBeDefined();
    expect(calls[0].text).toContain('Point to the following items in the image: red block, tray.');
    expect(pts[0].matched).toBe('block_1');
    expect(pts[0].error_mm!).toBeLessThan(2);
    expect(pts[1].matched).toBeNull();
    expect(egress.get().cellFrames).toBe(1);
    // the same image point unprojected on z = 0 lands ~10 mm off: the plane height matters
    const wrong = cell.unprojectER(top, 0)!;
    expect(Math.hypot(wrong[0] * 1000, wrong[1] * 1000 + 230)).toBeGreaterThan(8);
    expect(bus.lines().slice(-1)[0].text).toMatch(/^ER point LOW .* block_1 err [\d.]+ mm/);
  });

  it('pointAt with consensus n = 3 takes the median per coordinate at temperature 0.4', async () => {
    fake(JSON.stringify([{ point: [500, 600], label: 'red block' }]), JSON.stringify([{ point: [520, 580], label: 'red block' }]), JSON.stringify([{ point: [900, 590], label: 'red block' }]));
    const pts = await pointAt(cell, cell.capture(), ['red block'], 3);
    expect(calls).toHaveLength(3);
    expect(calls[0].config.temperature).toBe(0.4);
    expect(pts[0].image_point).toEqual([520, 590]);
    expect(pts[0].samples).toBe(3);
  });

  it('parses fenced JSON and falls back to SCHEMA-OFF on a 400', async () => {
    const top = cell.projectMujoco([0, -0.23, 0.024]);
    fake(Object.assign(new Error('400 Invalid JSON schema'), { status: 400 }), '```json\n' + JSON.stringify([{ point: top, label: 'red block' }]) + '\n```');
    const pts = await pointAt(cell, cell.capture(), ['red block']);
    expect(calls).toHaveLength(2);
    expect(calls[0].config.responseJsonSchema).toBeDefined();
    expect(calls[1].config.responseJsonSchema).toBeUndefined();
    expect(DEMO.pointSchema).toBe(false);
    expect(pts[0].matched).toBe('block_1');
    expect(bus.fallbacks()[0].name).toBe('SCHEMA-OFF');
    // subsequent calls stay schema-off
    fake(JSON.stringify([{ point: top, label: 'red block' }]));
    await pointAt(cell, cell.capture(), ['red block']);
    expect(calls[2].config.responseJsonSchema).toBeUndefined();
  });

  it('verifyStep and graspCheck return typed verdicts and trace lines', async () => {
    fake(JSON.stringify({ ok: false, observation: 'the block is still on the table' }));
    const v = await verifyStep(cell, cell.capture(), 'pick(block_1)', 'the red block is lifted off the table between the gripper jaws');
    expect(v.ok).toBe(false);
    expect(calls[0].text).toContain('Expected outcome: "the red block is lifted off the table between the gripper jaws"');
    expect(bus.lines().slice(-1)[0].text).toMatch(/^ER check LOW .* ✗ "the block is still on the table"/);
    const top = cell.projectMujoco([0, -0.23, 0.024]);
    fake(JSON.stringify({ graspable: true, grasp_point: top, approach_yaw_deg: 0, reason: 'clear top face' }));
    const g = await graspCheck(cell, cell.capture(), cell.objects.get('block_1')!);
    expect(g.graspable).toBe(true);
    expect(Math.abs(g.world_mm![0])).toBeLessThan(2);
    expect(Math.abs(g.world_mm![1] + 230)).toBeLessThan(2);
    expect(calls[1].text).toContain('box, 24 x 24 x 24 mm, red, at (0, -230)');
  });
});
