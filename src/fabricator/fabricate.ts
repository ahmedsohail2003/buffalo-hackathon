// The Fabricator pipeline: sanitize -> build -> measure -> guard -> bake + scale -> re-measure.
// Gemini (or a preset) proposes a shape program; this code measures it and decides. The registry
// (bay.samples.createMesh) then checks placement, spacing and reach. Node-safe.

import type { BufferGeometry } from 'three';
import type { BayApi, MeshInfo, Placement, Rejection, Sample, ShapeProgram } from '../contracts';
import { buildShape, hasAsset, orientGeometry } from './build';
import { ensureAssets } from './assets';
import { fitSentence, fitToGripper, WHY, type FitKey } from './guard';
import { SAMPLE_LIMITS } from './limits';
import { measureGeometry, type Measured } from './measure';
import { PRESETS } from './presets';
import { sanitizeProgram } from './program';
import type { FabProgram } from './types';

export type Fabricated = {
  ok: true;
  name: string;
  color: string;
  mesh: MeshInfo;
  /** extents in the sample's local frame, metres; dims.w is the width the jaw holds (local x) */
  dims: { w: number; d: number; h: number };
  /** one or two sentences a voice can read */
  say: string;
  /** the guardrail sentence first, then why, the designed size and any warning */
  reasons: string[];
  scale: number;
  binding: FitKey | null;
  measured: Measured;
  designed: Measured;
  program: FabProgram;
};
export type FabRejection = Rejection & { program?: FabProgram; designed?: Measured };
export type Placed = { ok: true; sample: Sample; say: string; reasons: string[]; fab: Fabricated; note?: string };

const r0 = (v: number) => Math.round(v);
const r1 = (v: number) => Math.round(v * 10) / 10;
const article = (name: string) => (/^[aeiou]/i.test(name) ? 'an' : 'a');

function hashStr(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** Geometry identity: program content + scale. */
export function meshKey(program: ShapeProgram, scale: number): string {
  return `${hashStr(JSON.stringify(program))}|${scale.toFixed(5)}`;
}

// Built geometry by meshKey, shared by fabricate and the scene (never disposed by us while cached).
const cache = new Map<string, BufferGeometry>();
const CACHE_MAX = 32;
function remember(key: string, g: BufferGeometry): void {
  cache.delete(key);
  cache.set(key, g);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
  }
}

/** The first hard-limit violation of a measured (already scaled) sample, or null. */
function hardViolation(m: Measured): string | null {
  const L = SAMPLE_LIMITS;
  const gw = m.widthAlongXMm;
  if (gw < L.graspMinMm) return `after scaling it is only ${r1(gw)} mm across, under the ${L.graspMinMm} mm the jaw needs`;
  if (gw > L.graspMaxMm) return `after scaling it is ${r1(gw)} mm across, over the ${L.graspMaxMm} mm the jaw can hold`;
  if (m.h * 1000 < L.heightMinMm) return `after scaling it is only ${r1(m.h * 1000)} mm tall, under the ${L.heightMinMm} mm the fingertips need`;
  if (m.h * 1000 > L.heightMaxMm) return `after scaling it is ${r1(m.h * 1000)} mm tall, over the ${L.heightMaxMm} mm limit`;
  if (m.footprintMm > L.footprintMaxMm) return `after scaling it is ${r1(m.footprintMm)} mm wide, over the ${L.footprintMaxMm} mm footprint`;
  if (m.massG > L.massMaxG) return `after scaling it weighs ${r0(m.massG)} g, over the ${L.massMaxG} g the arm can carry`;
  if (m.comOffsetMm > L.comOffsetMaxMm) return `its centre of mass is ${r1(m.comOffsetMm)} mm off the grip centre`;
  return null;
}

/**
 * Sanitize -> build -> measure -> guard -> bake the narrow side onto local +x and scale -> re-measure.
 * Gemini programs may not set densities (code owns them through materials).
 */
export function fabricateProgram(rawProgram: unknown, source: MeshInfo['source']): Fabricated | FabRejection {
  const program = sanitizeProgram(rawProgram, { allowDensity: source !== 'gemini' });
  const missing = program.parts.find((p) => p.kind === 'asset' && p.asset && !hasAsset(p.asset));
  if (missing) return { ok: false, code: 'ASSET_NOT_LOADED', reason: `the ${missing.asset} shape model is not loaded yet`, suggestion: 'try again in a moment?', program };
  let built;
  try {
    built = buildShape(program);
  } catch (e) {
    return { ok: false, code: 'BUILD_FAILED', reason: `the shape could not be built: ${String((e as Error).message).slice(0, 80)}`, suggestion: 'try a simpler description?', program };
  }
  const density = built.densityGcm3;
  const designed = measureGeometry(built.geometry, density);
  const fit = fitToGripper(designed, SAMPLE_LIMITS, built.floating);
  if (!fit.ok) {
    built.geometry.dispose();
    return { ok: false, code: fit.code, reason: fit.reason, suggestion: fit.suggestion, program, designed };
  }
  // The fingertip band moves with the height, so a shrink can need one more small correction.
  const L = SAMPLE_LIMITS;
  const yaw = designed.graspYaw;
  let scale = fit.scale;
  let geometry = orientGeometry(built.geometry.clone(), yaw, scale);
  let measured = measureGeometry(geometry, density);
  for (let i = 0; i < 3; i++) {
    const c = Math.min(1, (0.98 * L.graspMaxMm) / measured.widthAlongXMm, (0.98 * L.heightMaxMm) / (measured.h * 1000), (0.98 * L.footprintMaxMm) / measured.footprintMm, Math.cbrt((0.98 * L.massMaxG) / measured.massG));
    if (c > 0.995) break;
    scale *= c * 0.998;
    geometry.dispose();
    geometry = orientGeometry(built.geometry.clone(), yaw, scale);
    measured = measureGeometry(geometry, density);
  }
  built.geometry.dispose();
  const bad = hardViolation(measured);
  if (bad) {
    geometry.dispose();
    return { ok: false, code: 'GUARD_CHECK', reason: bad, suggestion: 'make it more compact, about as wide as it is tall?', program, designed };
  }
  scale = Math.round(scale * 10000) / 10000;
  const asset = program.parts.find((p) => p.kind === 'asset')?.asset;
  const mesh: MeshInfo = {
    program: program as unknown as ShapeProgram,
    graspWidthMm: r1(measured.widthAlongXMm),
    heightMm: r1(measured.h * 1000),
    massG: r1(measured.massG),
    scale,
    source,
    ...(asset ? { assetId: asset } : {}),
  };
  remember(meshKey(mesh.program, scale), geometry);
  const sentence = fitSentence(scale, fit.binding, fit.direction, measured);
  const reasons = [sentence];
  if (fit.binding) reasons.push(`why: ${WHY[fit.binding]}`);
  if (scale !== 1) reasons.push(`as designed it was ${r0(designed.graspWidthMm)} mm across, ${r0(designed.h * 1000)} mm tall and ${r0(designed.massG)} g`);
  if (measured.massG > L.massWarnG) reasons.push(`heavy for this arm: ${r0(measured.massG)} g is above the ${L.massWarnG} g comfort level`);
  const say = `Fabricated ${article(program.name)} ${program.name}: ${r0(mesh.graspWidthMm)} mm across, ${r0(mesh.heightMm)} mm tall, ${r0(mesh.massG)} grams.` +
    (scale !== 1 ? ` I ${sentence.replace(/:.*$/, '').replace(/^scaled (up )?to /, 'scaled it $1to ')}.` : '');
  return { ok: true, name: program.name, color: program.color, mesh, dims: { w: measured.w, d: measured.d, h: measured.h }, say, reasons, scale, binding: fit.binding, measured, designed, program };
}

/** Put a fabricated sample on the deck through the registry (placement, spacing and reach live there). */
export function placeFabricated(bay: BayApi, f: Fabricated, placement: Placement | undefined, by: Sample['createdBy']): Placed | Rejection {
  const created = bay.samples.createMesh({ name: f.name, color: f.color, mesh: f.mesh, dims: f.dims, ...(placement ?? {}) }, by);
  if (!created.ok) return created;
  const s = created.sample;
  const at = ` It is at x ${r0(s.pos[0] * 1000)}, y ${r0(s.pos[1] * 1000)} mm.`;
  return { ok: true, sample: s, say: f.say + at, reasons: f.reasons, fab: f };
}

/**
 * One click: fabricate a curated preset (NASA models are fetched first) and place it. mayPlace, if
 * given, is asked right before placing and can refuse (the designer's fallback uses it).
 */
export async function fabricatePreset(bay: BayApi, presetId: string, placement?: Placement, mayPlace?: () => Rejection | null): Promise<Placed | FabRejection> {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) return { ok: false, code: 'NO_PRESET', reason: `there is no preset called ${presetId}`, suggestion: `try one of: ${PRESETS.map((p) => p.id).join(', ')}` };
  await ensureAssets(preset.program);
  const f = fabricateProgram(preset.program, preset.source);
  if (!f.ok) return f;
  const refused = mayPlace?.();
  if (refused) return refused;
  return placeFabricated(bay, f, placement, 'preset');
}

/**
 * Geometry for a mesh sample, for the scene: built from the stored program exactly as it was measured
 * (narrow side on local +x, guardrail scale applied, bounding-box centre at the origin). Cached by program
 * hash + scale and shared: callers must not mutate it. Null if not a mesh or its shape model is not loaded.
 */
export function geometryForSample(s: Sample): BufferGeometry | null {
  if (s.kind !== 'mesh' || !s.mesh) return null;
  const key = meshKey(s.mesh.program, s.mesh.scale);
  const hit = cache.get(key);
  if (hit) return hit;
  const program = sanitizeProgram(s.mesh.program);
  const missing = program.parts.find((p) => p.kind === 'asset' && p.asset && !hasAsset(p.asset));
  if (missing) {
    void ensureAssets(program); // the next call after it loads will build
    return null;
  }
  try {
    const built = buildShape(program);
    const yaw = measureGeometry(built.geometry, built.densityGcm3).graspYaw;
    const g = orientGeometry(built.geometry, yaw, s.mesh.scale);
    remember(key, g);
    return g;
  } catch {
    return null;
  }
}
