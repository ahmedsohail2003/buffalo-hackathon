import { describe, expect, it } from 'vitest';
import type { BayApi, ErPointEvent, Vec3 } from '../contracts';
import { BAY_CAMERA } from '../core/constants';
import { BayCameraModel } from '../scene/bayCamera';
import { fakeProject, makeFakeBay, makeSample } from './__fixtures__/fakeBay';
import type { CallFn, CallResult } from './client';
import { Coworker } from './coworker';
import { pointEvent } from './erEvents';
import { dispatchTool } from './tools';
import type { LogSink } from './types';

const bennu = makeSample({ id: 'sample_2', name: 'Bennu (NASA shape model)', kind: 'mesh', dims: { w: 0.03, d: 0.03, h: 0.031 }, pos: [0.056, -0.155, 0.0155] });
const cube = makeSample({ id: 'sample_1', name: 'sample cube', dims: { w: 0.024, d: 0.024, h: 0.024 }, pos: [0, -0.165, 0.012] });

function sinkWithEvents() {
  const events: ErPointEvent[] = [];
  const sink: LogSink = { log() {}, ledger() {}, er: (ev) => events.push(ev) };
  return { sink, events };
}

/** A model reply pointing at a bay-frame point (the fake camera is linear, so this is exact). */
function pointingAt(p: Vec3, label = 'Bennu'): CallFn {
  const [y, x] = fakeProject(p);
  return async () => ({ text: JSON.stringify([{ point: [y, x], label }]) }) as CallResult;
}

describe('er:point event: one per point_at answer', () => {
  it('carries the model point, label, matched sample, deck position, error and the registry truth in the same image', async () => {
    const bay = makeFakeBay({ samples: [cube, bennu] });
    const { sink, events } = sinkWithEvents();
    // the camera points 0.9 mm right and 1.2 mm toward the operator of Bennu's registry centre: 1.5 mm off
    const call = pointingAt([bennu.pos[0] + 0.0009, bennu.pos[1] - 0.0012, bennu.pos[2]]);
    const r = await dispatchTool(bay, 'point_at', { label: 'the Bennu sample' }, 'coworker', { sink, call });
    expect(r.ok).toBe(true);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev).toMatchObject({
      kind: 'point',
      source: 'coworker',
      label: 'the Bennu sample',
      sample_id: 'sample_2',
      sample_name: 'Bennu (NASA shape model)',
      found_mm: [57, -156, 16],
      truth_mm: [56, -155, 16],
    });
    expect(ev.point_yx).toEqual(r.point_yx);
    expect(ev.error_mm).toBeCloseTo(1.5, 1);
    // the registry truth goes through the same camera projection as the model's point
    const truth = fakeProject(bennu.pos);
    expect(ev.truth_yx?.[0]).toBeCloseTo(truth[0], 1);
    expect(ev.truth_yx?.[1]).toBeCloseTo(truth[1], 1);
    expect(typeof ev.t).toBe('number');
  });

  it('is sent for a point with no registry match, and not for refusals, empty answers or other tools', async () => {
    const bay = makeFakeBay({ samples: [cube, bennu] });
    const { sink, events } = sinkWithEvents();
    await dispatchTool(bay, 'point_at', { label: 'the antenna' }, 'live', { sink, call: pointingAt([0.2, -0.4, 0.015], 'antenna') });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: 'live', sample_id: null, sample_name: null, error_mm: null, truth_mm: null, truth_yx: null });
    expect(events[0].found_mm).not.toBeNull();

    const none: CallFn = async () => ({ text: '[]' }) as CallResult;
    expect(await dispatchTool(bay, 'point_at', { label: 'a ghost' }, 'live', { sink, call: none })).toMatchObject({ ok: false });
    expect(await dispatchTool(bay, 'point_at', { label: 'Bennu', sample_id: 'sample_9' }, 'live', { sink, call: none })).toMatchObject({ code: 'NO_SAMPLE' });
    expect(await dispatchTool(bay, 'point_at', {}, 'live', { sink, call: none })).toMatchObject({ code: 'BAD_ARGS' });
    await dispatchTool(bay, 'describe_bay', {}, 'live', { sink });
    expect(events).toHaveLength(1);
  });

  it('a throwing overlay hook never breaks the tool call', async () => {
    const bay = makeFakeBay({ samples: [bennu] });
    const sink: LogSink = {
      log() {},
      ledger() {},
      er() {
        throw new Error('overlay down');
      },
    };
    const r = await dispatchTool(bay, 'point_at', { label: 'Bennu' }, 'test', { sink, call: pointingAt(bennu.pos) });
    expect(r).toMatchObject({ ok: true, match: { id: 'sample_2' } });
  });

  it('reaches the sink from the typed coworker', async () => {
    const bay = makeFakeBay({ samples: [cube, bennu] });
    const { sink, events } = sinkWithEvents();
    const [y, x] = fakeProject(bennu.pos);
    let round = 0;
    const call: CallFn = async (req) => {
      if (req.purpose === 'point') return { text: `[{"point": [${y}, ${x}], "label": "Bennu"}]` } as CallResult;
      round++;
      if (round === 1) {
        const fc = { name: 'point_at', args: { label: 'the Bennu sample', sample_id: 'sample_2' } };
        return { text: '', functionCalls: [fc], content: { role: 'model', parts: [{ functionCall: fc }] } } as unknown as CallResult;
      }
      return { text: 'Bennu is at (56, -155) mm.', functionCalls: [], content: { role: 'model', parts: [{ text: 'ok' }] } } as unknown as CallResult;
    };
    const cw = new Coworker(bay, { call, tools: { sink, call } });
    const reply = await cw.ask('Point at the Bennu sample.');
    expect(reply.tools.map((t) => t.name)).toEqual(['point_at']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: 'coworker', sample_id: 'sample_2', error_mm: 0 });
    cw.dispose();
  });
});

describe('er:point projection maths on the real bay camera', () => {
  const cam = new BayCameraModel({ pos: BAY_CAMERA.pos, target: BAY_CAMERA.target, fovDeg: BAY_CAMERA.fovDeg });
  const bay: BayApi = { ...makeFakeBay({ samples: [cube, bennu] }), project: (p) => cam.project(p), unproject: (yx, z) => cam.unproject(yx, z) };

  it('projects the registry truth into the 0-1000 frame, and the found point unprojects onto the sample plane', () => {
    const point = cam.project([bennu.pos[0] + 0.002, bennu.pos[1], bennu.pos[2]]);
    const found = cam.unproject(point, bennu.pos[2])!;
    const ev = pointEvent(
      bay,
      {
        ok: true,
        label: 'Bennu',
        point_yx: point,
        bay_mm: found.map((v) => Math.round(v * 1000)),
        match: { id: 'sample_2', name: bennu.name, error_mm: 2, registry_mm: [56, -155, 16] },
      },
      'live',
      42,
    )!;
    expect(ev.t).toBe(42);
    const truth = cam.project(bennu.pos);
    expect(ev.truth_yx![0]).toBeCloseTo(truth[0], 1);
    expect(ev.truth_yx![1]).toBeCloseTo(truth[1], 1);
    // both inside the frame, and the 2 mm miss is a few image units to the right (+x) at the same height
    for (const v of [...ev.point_yx, ...ev.truth_yx!]) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1000);
    }
    expect(ev.point_yx[1] - ev.truth_yx![1]).toBeGreaterThan(1);
    expect(ev.point_yx[1] - ev.truth_yx![1]).toBeLessThan(10);
    expect(Math.abs(ev.point_yx[0] - ev.truth_yx![0])).toBeLessThan(1);
    expect(ev.found_mm).toEqual([58, -155, 16]);
    // a point on the image unprojects back to where the registry put the sample
    const back = cam.unproject(ev.truth_yx!, bennu.pos[2])!;
    expect(Math.hypot(back[0] - bennu.pos[0], back[1] - bennu.pos[1]) * 1000).toBeLessThan(0.5);
  });

  it('falls back to the reported registry position when the sample has left the registry', () => {
    const ev = pointEvent(bay, { label: 'x', point_yx: [500, 500], bay_mm: [0, -80, 0], match: { id: 'gone', name: 'Gone', error_mm: 3, registry_mm: [10, -100, 15] } }, 'live')!;
    expect(ev.truth_mm).toEqual([10, -100, 15]);
    const p = cam.project([0.01, -0.1, 0.015]);
    expect(ev.truth_yx![0]).toBeCloseTo(p[0], 1);
    expect(pointEvent(bay, { label: 'x', points: [] }, 'live')).toBeNull();
  });
});
