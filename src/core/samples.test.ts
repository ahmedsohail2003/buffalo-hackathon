import { describe, expect, it } from 'vitest';
import type { MeshInfo, Rejection } from '../contracts';
import { SampleRegistry, sampleRadius } from './samples';
import { CONTAINMENT_FLOOR_Z, CONTAINMENT_XY, MAX_SAMPLES, REACH, SLOTS, polarXY } from './constants';
import { makeBay } from './testutil';

const box = (w: number, h = 20, extra: Record<string, unknown> = {}) => ({ color: '#3b82f6', kind: 'box' as const, width_mm: w, height_mm: h, ...extra });
const rej = (r: unknown): Rejection => {
  expect((r as { ok: boolean }).ok).toBe(false);
  return r as Rejection;
};
const oneSentence = (s: string): void => {
  expect(s).toMatch(/^[a-z0-9].*\.$/i);
  expect(s).not.toMatch(/\n/);
  expect(s.slice(0, -1)).not.toMatch(/[.!?] [A-Z]/);
};

describe('SampleRegistry', () => {
  it('seeds one 24 mm sample cube at the first slot', () => {
    const reg = new SampleRegistry();
    const [s] = reg.list();
    expect(reg.list()).toHaveLength(1);
    expect(s).toMatchObject({ id: 'sample_1', name: 'sample cube', kind: 'box', color: '#d9480f', held: false, createdBy: 'seed', yaw: 0 });
    expect(s.dims).toEqual({ w: 0.024, d: 0.024, h: 0.024 });
    expect(s.pos).toEqual([SLOTS[0][0], SLOTS[0][1], 0.012]);
  });

  it('creates a valid primitive at the first free slot, with the next id', () => {
    const reg = new SampleRegistry();
    const r = reg.createPrimitive(box(30, 25, { name: 'core tube' }), 'gemini');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sample.id).toBe('sample_2');
    expect(r.sample.pos[0]).toBeCloseTo(SLOTS[1][0], 9);
    expect(r.sample.pos[2]).toBeCloseTo(0.0125, 9);
    expect(r.sample.createdBy).toBe('gemini');
    expect(r.sample.yaw).toBe(0);
  });

  it('rejects grip widths outside 15-45 mm with a speakable reason', () => {
    const reg = new SampleRegistry();
    const wide = rej(reg.createPrimitive(box(60)));
    expect(wide.code).toBe('TOO_WIDE');
    expect(wide.reason).toBe('a 60 mm part is wider than the 45 mm the gripper can hold.');
    expect(wide.suggestion).toBeTruthy();
    const narrow = rej(reg.createPrimitive(box(10)));
    expect(narrow.code).toBe('TOO_NARROW');
    oneSentence(narrow.reason);
  });

  it('rejects heights outside 10-45 mm, depth over 60 mm and unknown kinds', () => {
    const reg = new SampleRegistry();
    expect(rej(reg.createPrimitive(box(30, 50))).code).toBe('TOO_TALL');
    expect(rej(reg.createPrimitive(box(30, 5))).code).toBe('TOO_SHORT');
    expect(rej(reg.createPrimitive(box(30, 20, { depth_mm: 70 }))).code).toBe('TOO_DEEP');
    expect(rej(reg.createPrimitive({ ...box(30), kind: 'torus' as unknown as 'box' })).code).toBe('BAD_KIND');
    expect(rej(reg.createPrimitive(box(Number.NaN))).code).toBe('BAD_SIZE');
    // a sphere uses its diameter for every extent
    const s = reg.createPrimitive({ color: 'teal', kind: 'sphere', width_mm: 30, height_mm: 99 });
    expect(s.ok && s.sample.dims).toEqual({ w: 0.03, d: 0.03, h: 0.03 });
  });

  it('rejects spots outside REACH, with the distance in mm', () => {
    const reg = new SampleRegistry();
    const far = rej(reg.createPrimitive(box(30, 20, { x_mm: 0, y_mm: -260 })));
    expect(far.code).toBe('OUT_OF_REACH');
    expect(far.reason).toContain('260 mm');
    expect(far.reason).toContain(`${REACH.rhoMin * 1000} mm`);
    oneSentence(far.reason);
    const [sx, sy] = polarXY(0.165, 1.7);
    const side = rej(reg.createPrimitive(box(30, 20, { x_mm: sx * 1000, y_mm: sy * 1000 })));
    expect(side.code).toBe('OUT_OF_REACH');
    expect(side.reason).toContain('degrees');
  });

  it('keeps samples off and around the containment bin', () => {
    const reg = new SampleRegistry();
    const r = rej(reg.createPrimitive(box(30, 20, { x_mm: CONTAINMENT_XY[0] * 1000 + 30, y_mm: CONTAINMENT_XY[1] * 1000 })));
    expect(r.code).toBe('ON_CONTAINMENT');
    oneSentence(r.reason);
  });

  it('enforces spacing max(40 mm, r_a + r_b + 10 mm) between centres', () => {
    const reg = new SampleRegistry();
    const [x, y] = SLOTS[0];
    const near = rej(reg.createPrimitive(box(30, 20, { x_mm: x * 1000 + 30, y_mm: y * 1000 })));
    expect(near.code).toBe('TOO_CLOSE');
    expect(near.reason).toContain('sample cube');
    // r_a + r_b + 10 for a 24 mm cube and a 45 x 60 box: 17 + 37.5 + 10 = 64.5 mm
    const need = (sampleRadius({ w: 0.024, d: 0.024 }) + sampleRadius({ w: 0.045, d: 0.06 }) + 0.01) * 1000;
    const [bx, by] = polarXY(0.165, 0.33);
    expect(Math.hypot(bx - x, by - y) * 1000).toBeLessThan(need);
    expect(rej(reg.createPrimitive(box(45, 20, { depth_mm: 60, x_mm: bx * 1000, y_mm: by * 1000 }))).code).toBe('TOO_CLOSE');
  });

  it('places relative to a sample, the bin or the arm; rejects unknown refs and missing directions', () => {
    const reg = new SampleRegistry({ armTcp: () => [0.15, -0.08, 0.06] });
    const r = reg.createPrimitive(box(20, 20, { relative_to: 'sample cube', direction: 'right' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sample.pos[0]).toBeCloseTo(SLOTS[0][0] + 0.08, 9);
    const r2 = reg.createPrimitive(box(20, 20, { relative_to: 'sample_1', direction: 'left', distance_mm: 50 }));
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.sample.pos[0]).toBeCloseTo(SLOTS[0][0] - 0.05, 9);
    // 70 mm to the left lands next to the containment bin
    expect(rej(reg.createPrimitive(box(20, 20, { relative_to: 'sample_1', direction: 'left', distance_mm: 70 }))).code).toBe('ON_CONTAINMENT');
    expect(rej(reg.createPrimitive(box(20, 20, { relative_to: 'ghost', direction: 'left' }))).code).toBe('NO_SAMPLE');
    expect(rej(reg.createPrimitive(box(20, 20, { relative_to: 'sample_1' }))).code).toBe('BAD_PLACEMENT');
    const bin = rej(reg.createPrimitive(box(20, 20, { relative_to: 'containment', direction: 'front', distance_mm: 20 })));
    expect(bin.code).toBe('ON_CONTAINMENT');
    const arm = reg.createPrimitive(box(20, 20, { relative_to: 'arm', direction: 'front', distance_mm: 0 }));
    expect(arm.ok && arm.sample.pos[1]).toBeCloseTo(-0.08, 9);
  });

  it(`holds at most ${MAX_SAMPLES} samples and says when no default spot is free`, () => {
    const reg = new SampleRegistry();
    const made = [];
    for (let i = 0; i < 4; i++) made.push(reg.createPrimitive(box(20, 20)));
    expect(made.every((m) => m.ok)).toBe(true);
    const full = rej(reg.createPrimitive(box(20, 20)));
    expect(full.code).toBe('BAY_FULL');
    oneSentence(full.reason);
    // three more on the outer edge, between the slots
    for (const d of [10, 30, 50]) {
      const [x, y] = polarXY(0.199, (d * Math.PI) / 180);
      expect(reg.createPrimitive(box(15, 20, { depth_mm: 15, x_mm: x * 1000, y_mm: y * 1000 })).ok).toBe(true);
    }
    expect(reg.list().length).toBe(MAX_SAMPLES);
    const [x, y] = polarXY(0.135, 0.2);
    expect(rej(reg.createPrimitive(box(15, 20, { depth_mm: 15, x_mm: x * 1000, y_mm: y * 1000 }))).reason).toContain(`${MAX_SAMPLES} samples`);
  });

  it('uses the injected reach probe as the last check', () => {
    const reg = new SampleRegistry({ reachProbe: () => ({ ok: false, code: 'UNREACHABLE', reason: 'the arm cannot grasp it at that spot.' }) });
    expect(rej(reg.createPrimitive(box(20, 20))).code).toBe('BAY_FULL'); // no slot passes the probe
    expect(rej(reg.createPrimitive(box(20, 20, { x_mm: 100, y_mm: -160 }))).code).toBe('UNREACHABLE');
  });

  it('createMesh stores dims as given, keeps the mesh info and checks placement', () => {
    const reg = new SampleRegistry();
    const mesh: MeshInfo = { program: { name: 'bennu', category: 'asteroid', parts: [] }, graspWidthMm: 33, heightMm: 30, massG: 40, scale: 0.5, source: 'nasa', assetId: 'bennu' };
    const r = reg.createMesh({ name: 'Bennu', color: '#555', mesh, dims: { w: 0.033, d: 0.035, h: 0.03 } }, 'preset');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sample.kind).toBe('mesh');
    expect(r.sample.dims).toEqual({ w: 0.033, d: 0.035, h: 0.03 });
    expect(r.sample.mesh).toBe(mesh);
    expect(r.sample.yaw).toBe(0);
    expect(r.sample.pos[2]).toBeCloseTo(0.015, 9);
    const far = rej(reg.createMesh({ name: 'x', color: '#555', mesh, dims: { w: 0.03, d: 0.03, h: 0.03 }, x_mm: 300, y_mm: 0 }));
    expect(far.code).toBe('OUT_OF_REACH');
    expect(rej(reg.createMesh({ name: 'x', color: '#555', mesh: { ...mesh, graspWidthMm: 52 }, dims: { w: 0.052, d: 0.03, h: 0.03 } })).code).toBe('TOO_WIDE');
  });

  it('restZ: deck, containment floor, and the top of the sample below', () => {
    const reg = new SampleRegistry();
    const cube = reg.list()[0];
    const probe = { id: 'probe', dims: { w: 0.02, d: 0.02, h: 0.02 } };
    expect(reg.restZ(probe, 0.1, -0.1)).toMatchObject({ z: 0.01, on: 'deck' });
    expect(reg.restZ(probe, CONTAINMENT_XY[0], CONTAINMENT_XY[1])).toMatchObject({ z: CONTAINMENT_FLOOR_Z + 0.01, on: 'containment' });
    const st = reg.restZ(probe, cube.pos[0] + 0.003, cube.pos[1]);
    expect(st.on).toBe('sample');
    expect(st.underId).toBe(cube.id);
    expect(st.z).toBeCloseTo(0.024 + 0.01, 9);
  });

  it('attachCandidate applies the xy and height band rule', () => {
    const reg = new SampleRegistry();
    const c = reg.list()[0];
    expect(reg.attachCandidate([c.pos[0] + 0.008, c.pos[1], 0.008])?.id).toBe(c.id);
    expect(reg.attachCandidate([c.pos[0] + 0.02, c.pos[1], 0.008])).toBeUndefined();
    expect(reg.attachCandidate([c.pos[0], c.pos[1], 0.06])).toBeUndefined();
    expect(reg.nearest([c.pos[0] + 0.01, c.pos[1]], 0.035)?.id).toBe(c.id);
    expect(reg.nearest([c.pos[0] + 0.05, c.pos[1]], 0.035)).toBeUndefined();
  });

  it('notifies onChange on create, remove, held changes and reset; list() returns copies', () => {
    const reg = new SampleRegistry();
    let n = 0;
    const off = reg.onChange(() => n++);
    const r = reg.createPrimitive(box(20, 20));
    expect(n).toBe(1);
    if (r.ok) reg.setHeld(r.sample.id, true);
    expect(n).toBe(2);
    if (r.ok) expect(reg.remove(r.sample.id)).toBe(true);
    expect(reg.remove('nope')).toBe(false);
    expect(n).toBe(3);
    reg.reset();
    expect(n).toBe(4);
    expect(reg.list().map((s) => s.id)).toEqual(['sample_1']);
    const copy = reg.list()[0];
    copy.pos[0] = 99;
    expect(reg.list()[0].pos[0]).not.toBe(99);
    off();
    reg.reset();
    expect(n).toBe(4);
  });

  it('the bay factory wires an IK reach probe into the registry', async () => {
    const bay = await makeBay();
    const ok = bay.samples.createPrimitive(box(30, 30, { x_mm: 100, y_mm: -160 }));
    expect(ok.ok).toBe(true);
    // a probe that refuses: the factory's wording is one speakable sentence
    bay.samples.setReachProbe(() => ({ ok: false, code: 'UNREACHABLE', reason: 'the arm cannot grasp it at that spot with the gripper pointing down.' }));
    const no = rej(bay.samples.createPrimitive(box(30, 30, { x_mm: 150, y_mm: -80 })));
    expect(no.code).toBe('UNREACHABLE');
    oneSentence(no.reason);
  });
});
