import { describe, it, expect, beforeAll } from 'vitest';
import type { MeshInfo, Placement, Sample } from '../contracts';
import { fakeBay, registerNasaAssets } from './testkit';
import { sanitizeProgram, MAX_PARTS, KINDS, PROGRAM_JSON_SCHEMA } from './program';
import { buildGeometry, buildShape, buildBakedGeometry, signedVolume } from './build';
import { measureGeometry } from './measure';
import { fitToGripper } from './guard';
import { SAMPLE_LIMITS } from './limits';
import { PRESETS, matchPreset } from './presets';
import { fabricatePreset, fabricateProgram, geometryForSample } from './fabricate';
import type { FabPart, FabProgram } from './types';

const prog = (parts: FabPart[] | Record<string, unknown>[], extra: Record<string, unknown> = {}): FabProgram =>
  sanitizeProgram({ name: 'test', category: 'other', color: '#888888', density_g_cm3: 2.7, parts, ...extra });
const measure = (p: FabProgram) => {
  const b = buildShape(p);
  return measureGeometry(b.geometry, b.densityGcm3);
};

beforeAll(registerNasaAssets);

describe('sanitizeProgram (a program is a request, never trusted)', () => {
  it('clamps junk numbers, drops unknown kinds, caps parts, defaults colours', () => {
    const p = sanitizeProgram({
      name: '  x'.repeat(40), category: 'weapon', color: 'not a colour', density_g_cm3: 99,
      parts: [
        { kind: 'box', size_mm: [9999, -5, 'abc'], pos_mm: [500, -500, NaN], rot_deg: [720, 0, 0], color: '#FFF', metalness: 7, roughness: -1 },
        { kind: 'teapot', radius_mm: 10 },
        { kind: 'rock', radius_mm: 0, rock: { seed: -3, roughness: 9, craters: 99 } },
        { kind: 'lathe', profile_mm: Array.from({ length: 40 }, (_, i) => [100, 40 - i]) },
        ...Array.from({ length: 20 }, () => ({ kind: 'sphere', diameter_mm: 10 })),
      ],
    });
    expect(p.name.length).toBeLessThanOrEqual(40);
    expect(p.category).toBe('other');
    expect(p.color).toBe('#8a8580');
    expect(p.density_g_cm3).toBe(8);
    expect(p.parts.length).toBe(MAX_PARTS);
    const [box, rock, lathe, sphere] = p.parts;
    expect(box.size_mm).toEqual([120, 1, 20]);
    expect(box.pos_mm).toEqual([80, -80, 0]);
    expect(box.rot_deg).toEqual([360, 0, 0]);
    expect(box.color).toBe('#ffffff');
    expect(box.metalness).toBe(1);
    expect(box.roughness).toBe(0);
    expect(rock.radius_mm).toBe(1);
    expect(rock.rock).toMatchObject({ seed: 0, roughness: 1, craters: 12 });
    expect(lathe.profile_mm!.length).toBe(24);
    expect(lathe.profile_mm!.every(([r]) => r <= 60)).toBe(true);
    const zs = lathe.profile_mm!.map(([, z]) => z);
    expect(zs).toEqual([...zs].sort((a, b) => a - b));
    expect(sphere.radius_mm).toBe(5); // diameter accepted
  });

  it('never throws on garbage: falls back to a single rock', () => {
    for (const junk of [null, undefined, 42, 'rock', [], { parts: 'nope' }, { parts: [{ kind: 'nothing' }] }, { parts: [{ kind: 'asset', asset: 'deathstar' }] }]) {
      const p = sanitizeProgram(junk);
      expect(p.parts.length).toBe(1);
      expect(p.parts[0].kind).toBe('rock');
      expect(Number.isFinite(p.density_g_cm3)).toBe(true);
    }
  });

  it('Gemini programs cannot set a density: code derives it from the material', () => {
    const p = sanitizeProgram({ name: 'lie', category: 'meteorite', color: '#777777', material: 'iron_meteorite', density_g_cm3: 0.5, parts: [{ kind: 'sphere', radius_mm: 10 }] }, { allowDensity: false });
    expect(p.density_g_cm3).toBe(7.8);
    expect(PROGRAM_JSON_SCHEMA.required).toContain('material');
    expect(JSON.stringify(PROGRAM_JSON_SCHEMA)).not.toContain('density_g_cm3');
  });
});

describe('buildGeometry', () => {
  it('every kind builds a non-empty, finite, centred, outward-facing geometry with colours', () => {
    const parts: Record<string, FabPart> = {
      box: { kind: 'box', size_mm: [20, 30, 40] },
      cylinder: { kind: 'cylinder', radius_mm: 12, height_mm: 30 },
      sphere: { kind: 'sphere', radius_mm: 12 },
      cone: { kind: 'cone', radius_mm: 12, radius2_mm: 4, height_mm: 30 },
      torus: { kind: 'torus', radius_mm: 14, radius2_mm: 4 },
      capsule: { kind: 'capsule', radius_mm: 10, height_mm: 36 },
      rock: { kind: 'rock', radius_mm: 15, rock: { seed: 3, roughness: 0.6, craters: 4 } },
      lathe: { kind: 'lathe', profile_mm: [[10, 0], [14, 10], [8, 30]] },
      extrude: { kind: 'extrude', outline_mm: [[-10, -8], [12, -8], [4, 10]], height_mm: 15 },
      asset: { kind: 'asset', asset: 'bennu' },
    };
    expect(Object.keys(parts).sort()).toEqual([...KINDS].sort());
    for (const [name, part] of Object.entries(parts)) {
      const p = prog([part]);
      expect(p.parts[0].kind, name).toBe(name);
      const g = buildGeometry(p);
      const pos = g.getAttribute('position');
      expect(pos.count, name).toBeGreaterThanOrEqual(24);
      expect(g.getAttribute('normal').count, name).toBe(pos.count);
      expect(g.getAttribute('color').count, name).toBe(pos.count);
      expect(Array.from(pos.array as Float32Array).every(Number.isFinite), name).toBe(true);
      g.computeBoundingBox();
      const c = g.boundingBox!.getCenter(g.boundingBox!.min.clone());
      expect(c.length(), name).toBeLessThan(1e-6);
      expect(signedVolume(g), `${name} winding`).toBeGreaterThan(0);
    }
  });

  it('a 12 mm sphere has the analytic volume within 3 % and mass = volume x density', () => {
    const m = measure(prog([{ kind: 'sphere', radius_mm: 12 }]));
    const v = (4 / 3) * Math.PI * 1.2 ** 3;
    expect(Math.abs(m.volumeCm3 - v) / v).toBeLessThan(0.03);
    expect(m.massG).toBeCloseTo(m.volumeCm3 * 2.7, 6);
  });

  it('rocks are deterministic per seed and differ between seeds', () => {
    const arr = (seed: number) => Array.from(buildGeometry(prog([{ kind: 'rock', radius_mm: 15, rock: { seed, roughness: 0.5, craters: 3 } }])).getAttribute('position').array as Float32Array);
    expect(arr(9)).toEqual(arr(9));
    expect(arr(9)).not.toEqual(arr(10));
  });
});

describe('measureGeometry (what the jaw meets)', () => {
  it('a 20 x 30 x 40 mm box is 20 mm across the jaw and 40 mm tall', () => {
    const m = measure(prog([{ kind: 'box', size_mm: [20, 30, 40] }]));
    expect(Math.abs(m.graspWidthMm - 20)).toBeLessThan(0.5);
    expect(m.h * 1000).toBeCloseTo(40, 3);
    expect(m.graspYaw).toBeCloseTo(0, 3);
    expect(m.volumeCm3).toBeCloseTo(24, 1);
  });

  it('a box turned 35 degrees is still 20 mm across, and baking puts the narrow side on local x', () => {
    const p = prog([{ kind: 'box', size_mm: [20, 30, 40], rot_deg: [0, 0, 35] }]);
    const m = measure(p);
    expect(Math.abs(m.graspWidthMm - 20)).toBeLessThan(0.5);
    expect(Math.abs(m.graspYaw - (35 * Math.PI) / 180)).toBeLessThan(0.01);
    const baked = measureGeometry(buildBakedGeometry(p, m.graspYaw, 1), 2.7);
    expect(Math.abs(baked.widthAlongXMm - 20)).toBeLessThan(0.5);
    expect(Math.abs(baked.w * 1000 - 20)).toBeLessThan(0.5);
    expect(Math.abs(baked.d * 1000 - 30)).toBeLessThan(0.5);
  });

  it('a tapered cone is measured where the fingertips meet it, not at its vertices', () => {
    // 56 mm across at the base, 20 mm at the top: the only vertices are at z 0 and z 20, but the
    // fingertip plane (about 2 mm up) cuts the cone at about 51 mm, over the 45 mm jaw limit.
    const cone = prog([{ kind: 'cone', radius_mm: 28, radius2_mm: 10, height_mm: 20 }]);
    const m = measure(cone);
    expect(m.graspWidthMm).toBeGreaterThan(45);
    expect(m.graspWidthMm).toBeLessThan(56);
    const r = fitToGripper(m);
    if (r.ok) expect(m.graspWidthMm * r.scale).toBeLessThanOrEqual(SAMPLE_LIMITS.graspTargetMaxMm + 1e-6);
    const f = fabricateProgram(cone, 'gemini');
    if (f.ok) {
      // what the registry is told matches a slice of the baked mesh at the fingertip plane
      expect(f.mesh.graspWidthMm).toBeLessThanOrEqual(SAMPLE_LIMITS.graspMaxMm);
      expect(f.scale).toBeLessThan(0.9);
    }
    // a pointed cone has no vertex in the band but the apex: it is about 24 mm across there, not empty
    const pointed = measure(prog([{ kind: 'cone', radius_mm: 14, radius2_mm: 0, height_mm: 30 }]));
    expect(pointed.graspWidthMm).toBeGreaterThan(20);
    expect(fitToGripper(pointed).ok).toBe(true);
  });

  it('the NASA Eros model is narrow along y: baking turns it so the jaw closes across its waist', () => {
    const f = fabricateProgram(PRESETS.find((p) => p.id === 'nasa_eros')!.program, 'nasa');
    expect(f.ok).toBe(true);
    if (!f.ok) return;
    expect(f.dims.w).toBeLessThan(f.dims.d); // local x is the narrow side
    expect(f.mesh.graspWidthMm).toBeCloseTo(f.dims.w * 1000, 0);
  });
});

describe('fitToGripper (one uniform scale or a spoken refusal)', () => {
  it('scales a 90 mm rock down to at most 40 mm across', () => {
    const m = measure(prog([{ kind: 'rock', radius_mm: 45, rock: { seed: 5, roughness: 0.4, craters: 2 } }], { density_g_cm3: 1.2 }));
    expect(m.graspWidthMm).toBeGreaterThan(70);
    const r = fitToGripper(m);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scale).toBeLessThan(1);
    expect(m.graspWidthMm * r.scale).toBeLessThanOrEqual(SAMPLE_LIMITS.graspTargetMaxMm + 1e-6);
    expect(r.reasons[0]).toMatch(/^scaled to \d+% /);
  });

  it('rejects a 4 x 4 x 200 mm needle with a reason and a concrete suggestion', () => {
    const r = fitToGripper(measure(prog([{ kind: 'cylinder', radius_mm: 2, height_mm: 200 }])));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('TOO_THIN');
    expect(r.reason).toMatch(/too tall and thin/);
    expect(r.suggestion).toMatch(/at least \d+ mm across/);
    const lying = fitToGripper(measure(prog([{ kind: 'box', size_mm: [120, 4, 4] }])));
    expect(lying.ok === false && lying.code).toBe('TOO_THIN');
  });

  it('grows a 12 mm pebble so the jaw has something to hold', () => {
    const r = fitToGripper(measure(prog([{ kind: 'sphere', radius_mm: 6 }])));
    expect(r.ok && r.direction).toBe('up');
    expect(r.ok && r.scale).toBeGreaterThan(1);
  });

  it('rejects a floating part (a placement bug in the design)', () => {
    const b = buildShape(prog([{ kind: 'cylinder', radius_mm: 12, height_mm: 30 }, { kind: 'sphere', radius_mm: 5, pos_mm: [0, 0, 70] }]));
    const f = fitToGripper(measureGeometry(b.geometry, 2.7), SAMPLE_LIMITS, b.floating);
    expect(f.ok === false && f.code).toBe('FLOATING_PART');
  });
});

describe('presets + fabricate', () => {
  it('every preset fabricates inside the limits; iron is scaled for mass, Eros for its length; the antenna is refused', () => {
    const rows: string[] = [];
    for (const preset of PRESETS) {
      const r = fabricateProgram(preset.program, preset.source);
      if (preset.id === 'antenna') {
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.code).toBe('TOO_THIN');
          rows.push(`${preset.label.padEnd(22)} REFUSED ${r.code}: ${r.reason} | ${r.suggestion}`);
        }
        continue;
      }
      expect(r.ok, `${preset.id}: ${r.ok ? '' : r.reason}`).toBe(true);
      if (!r.ok) continue;
      const m = r.measured;
      expect(r.mesh.graspWidthMm).toBeGreaterThanOrEqual(SAMPLE_LIMITS.graspMinMm);
      expect(r.mesh.graspWidthMm).toBeLessThanOrEqual(SAMPLE_LIMITS.graspMaxMm);
      expect(r.mesh.heightMm).toBeLessThanOrEqual(SAMPLE_LIMITS.heightMaxMm);
      expect(r.mesh.massG).toBeLessThanOrEqual(SAMPLE_LIMITS.massMaxG);
      expect(m.footprintMm).toBeLessThanOrEqual(SAMPLE_LIMITS.footprintMaxMm);
      expect(r.mesh.graspWidthMm).toBeCloseTo(r.dims.w * 1000, 0);
      expect(r.mesh.source).toBe(preset.source);
      if (preset.source === 'nasa') expect(r.mesh.assetId).toBeTruthy();
      rows.push(`${preset.label.padEnd(22)} grip ${r.mesh.graspWidthMm.toFixed(1)} mm  h ${r.mesh.heightMm.toFixed(1)} mm  fp ${m.footprintMm.toFixed(0)} mm  ${r.mesh.massG.toFixed(1)} g  scale ${r.scale.toFixed(3)} | ${r.reasons[0]}`);
      if (preset.id === 'iron') {
        expect(r.scale).toBeLessThan(0.85);
        expect(r.binding).toBe('mass');
        expect(r.designed.massG).toBeGreaterThan(150);
        expect(r.say).toMatch(/so the arm can lift it/);
      }
      if (preset.id === 'nasa_eros') {
        expect(r.scale).toBeLessThan(0.8);
        expect(r.binding).toBe('footprint');
      }
    }
    console.log(rows.join('\n'));
  });

  it('fabricatePreset hands the registry the measured mesh and dims, and says where it went', async () => {
    const bay = fakeBay();
    const r = await fabricatePreset(bay, 'iron', { x_mm: -60, y_mm: -210 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(bay.created).toHaveLength(1);
    const { input, by } = bay.created[0];
    expect(by).toBe('preset');
    expect((input as Placement).x_mm).toBe(-60);
    expect(input.mesh.source).toBe('preset');
    expect(input.dims.w * 1000).toBeCloseTo(input.mesh.graspWidthMm, 0);
    expect(r.say).toMatch(/at x -60, y -210 mm/);
    const nasa = await fabricatePreset(bay, 'nasa_itokawa');
    expect(nasa.ok && nasa.sample.mesh!.source).toBe('nasa');
    const missing = await fabricatePreset(bay, 'nope');
    expect(missing.ok === false && missing.code).toBe('NO_PRESET');
    // a registry refusal (placement) comes back unchanged
    const full = fakeBay({ reject: { ok: false, code: 'TOO_MANY', reason: 'the deck is full', suggestion: 'remove one first?' } });
    const r2 = await fabricatePreset(full, 'bennu');
    expect(r2.ok === false && r2.code).toBe('TOO_MANY');
  });

  it('geometryForSample rebuilds exactly what was measured (narrow side on local x)', () => {
    for (const id of ['canister', 'wheel', 'nasa_kleopatra']) {
      const f = fabricateProgram(PRESETS.find((p) => p.id === id)!.program, 'preset');
      expect(f.ok).toBe(true);
      if (!f.ok) continue;
      const sample: Sample = { id: 's', name: f.name, color: f.color, kind: 'mesh', dims: f.dims, pos: [0, -0.2, f.dims.h / 2], yaw: 0, held: false, mesh: JSON.parse(JSON.stringify(f.mesh)) as MeshInfo, createdBy: 'preset' };
      const g = geometryForSample(sample)!;
      g.computeBoundingBox();
      const bb = g.boundingBox!;
      expect(bb.max.x - bb.min.x, id).toBeCloseTo(f.dims.w, 4);
      expect(bb.max.y - bb.min.y, id).toBeCloseTo(f.dims.d, 4);
      expect(bb.max.z - bb.min.z, id).toBeCloseTo(f.dims.h, 4);
    }
    expect(geometryForSample({ id: 'b', name: 'block', color: 'red', kind: 'box', dims: { w: 0.02, d: 0.02, h: 0.02 }, pos: [0, 0, 0.01], yaw: 0, held: false, createdBy: 'seed' })).toBeNull();
  });

  it('keyword match picks a preset for the offline fallback (never the refused antenna)', () => {
    expect(matchPreset('a chunk of an iron meteorite').id).toBe('iron');
    expect(matchPreset('CubeSat reaction wheel').id).toBe('wheel');
    expect(matchPreset('something from asteroid Bennu').id).toBe('bennu');
    expect(matchPreset('the dog bone asteroid Kleopatra').id).toBe('nasa_kleopatra');
    expect(matchPreset('a whip antenna').id).not.toBe('antenna');
    expect(matchPreset('zzz').id).toBe('bennu');
  });
});
