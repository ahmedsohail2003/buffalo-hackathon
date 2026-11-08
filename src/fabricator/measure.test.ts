import { beforeAll, describe, expect, it } from 'vitest';
import { ensureAssets } from './assets';
import { buildBakedGeometry, buildShape } from './build';
import { fabricatePreset, fabricateProgram } from './fabricate';
import { measureGeometry } from './measure';
import { PRESETS } from './presets';
import { sanitizeProgram } from './program';
import { fakeBay, registerNasaAssets } from './testkit';
import type { FabPart, FabProgram } from './types';

const prog = (parts: FabPart[]): FabProgram => sanitizeProgram({ name: 'test', category: 'other', color: '#888888', density_g_cm3: 2.7, parts });
const measure = (p: FabProgram) => {
  const b = buildShape(p);
  return measureGeometry(b.geometry, b.densityGcm3);
};

beforeAll(registerNasaAssets);

describe('measureGeometry: footprint radius', () => {
  it('is the largest horizontal distance from the bounding-box centre, in metres', () => {
    // a cylinder reaches its radius; the bounding circle of its square box reaches 41% further
    const cyl = measure(prog([{ kind: 'cylinder', radius_mm: 10, height_mm: 20 }]));
    expect(cyl.r * 1000).toBeCloseTo(10, 2);
    expect((Math.hypot(cyl.w, cyl.d) / 2) * 1000).toBeCloseTo(14.14, 1);
    // a box reaches its corners
    const box = measure(prog([{ kind: 'box', size_mm: [20, 30, 10] }]));
    expect(box.r * 1000).toBeCloseTo(Math.hypot(20, 30) / 2, 3);
    // two discs 30 mm apart: about the bounding-box centre (15, 0) the far edges are 25 mm away (40 mm from the origin)
    const pair = measure(prog([{ kind: 'cylinder', radius_mm: 10, height_mm: 20 }, { kind: 'cylinder', radius_mm: 10, height_mm: 20, pos_mm: [30, 0, 0] }]));
    expect(pair.r * 1000).toBeCloseTo(25, 2);
    expect(pair.footprintMm).toBeCloseTo(2 * pair.r * 1000, 6);
  });

  it('is measured about the point the scene draws at the sample pos (the baked geometry origin)', async () => {
    for (const id of ['nasa_bennu', 'nasa_itokawa', 'iron', 'mars']) {
      const preset = PRESETS.find((p) => p.id === id)!;
      await ensureAssets(preset.program);
      const f = fabricateProgram(preset.program, preset.source);
      if (!f.ok) throw new Error(`${id}: ${f.reason}`);
      // what geometryForSample rebuilds for the scene: turned, scaled, centred on its bounding box
      const g = buildBakedGeometry(f.program, f.designed.graspYaw, f.mesh.scale);
      const a = g.getAttribute('position');
      let far = 0;
      for (let i = 0; i < a.count; i++) far = Math.max(far, Math.hypot(a.getX(i), a.getY(i)));
      expect(Math.abs(far - f.measured.r), id).toBeLessThan(2e-5);
      // real rocks are much rounder than their bounding boxes
      expect(f.measured.r, id).toBeLessThan(0.95 * (Math.hypot(f.dims.w, f.dims.d) / 2));
      g.dispose();
    }
  });

  it('placeFabricated hands the registry the measured footprint radius as dims.r, in metres', async () => {
    const bay = fakeBay();
    const r = await fabricatePreset(bay, 'nasa_bennu');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { dims } = bay.created[0].input;
    expect(dims.r).toBeCloseTo(r.fab.measured.r, 12);
    expect(dims.r! * 1000).toBeGreaterThan(10);
    expect(dims.r!).toBeLessThan(Math.hypot(dims.w, dims.d) / 2);
  });
});
