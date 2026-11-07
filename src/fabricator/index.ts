// STARHAND Fabricator: public API. Self-contained (three + src/contracts.ts only).
//
//   fabricateProgram(program, source)  sanitize -> build -> measure -> guard -> scale (no placement)
//   fabricatePreset(bay, id, placement?)    one click, offline; NASA models are fetched first
//   designAndFabricate(bay, description, placement, { generateJson })   Gemini designer + one repair turn
//   geometryForSample(sample)           what the scene draws (narrow side on local +x, scaled, centred)
//   materialForSample(sample)           MeshStandardMaterial parameters for it (vertex colours)

import type { Sample } from '../contracts';
import { materialParams } from './build';
import { sanitizeProgram } from './program';

export { fabricateProgram, fabricatePreset, placeFabricated, geometryForSample, meshKey, type Fabricated, type FabRejection, type Placed } from './fabricate';
export { designAndFabricate, designProgram, DESIGNER_SYSTEM, parseModelJson, type DesignerDeps, type GenerateJson, type Designed } from './designer';
export { PRESETS, matchPreset, type Preset } from './presets';
export { SAMPLE_LIMITS, fingertipHeightMm } from './limits';
export { PROGRAM_JSON_SCHEMA, MATERIAL_DENSITY, sanitizeProgram } from './program';
export { fitToGripper, WHY } from './guard';
export { measureGeometry, type Measured } from './measure';
export { registerAsset, hasAsset, type AssetFile } from './build';
export { ensureAssets, loadAsset } from './assets';
export type { FabProgram, FabPart, SampleMaterial } from './types';

/** Material parameters for a mesh sample: vertex colours carry the part colours. */
export function materialForSample(s: Sample): { vertexColors: true; roughness: number; metalness: number; opacity: number; transparent: boolean } | null {
  if (s.kind !== 'mesh' || !s.mesh) return null;
  return { vertexColors: true, ...materialParams(sanitizeProgram(s.mesh.program)) };
}
