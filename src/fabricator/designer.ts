// The designer: Gemini turns a plain-language description into a shape program (JSON, schema-constrained).
// Code sanitizes, builds, measures and guards it. On a guardrail refusal Gemini gets ONE repair turn with the
// refusal sentence; if the repaired design is refused too, that refusal is the answer (code decides). The
// closest preset is fabricated only when Gemini cannot answer: an HTTP error, a timeout or no usable JSON.
// Node-safe: the model call is injected (deps.generateJson), so tests use a fake.

import type { BayApi, Placement, Rejection } from '../contracts';
import { fabricatePreset, fabricateProgram, placeFabricated, type FabRejection, type Fabricated, type Placed } from './fabricate';
import { SAMPLE_LIMITS as L } from './limits';
import { MATERIAL_DENSITY, PROGRAM_JSON_SCHEMA, sanitizeProgram } from './program';
import { matchPreset } from './presets';
import type { FabProgram } from './types';

/** Builder A's JSON call: system + prompt + schema in, model text out. */
export type GenerateJson = (a: { system: string; prompt: string; schema: object; signal?: AbortSignal }) => Promise<{ text: string; latencyMs: number }>;
export interface DesignerDeps {
  generateJson: GenerateJson;
}

export const DESIGNER_SYSTEM = `You design small physical samples for STARHAND, an orbital sample-curation bay where a robot arm handles asteroid samples, meteorites and spacecraft parts. Answer with ONE JSON shape program that follows the schema. Code builds it, measures it and decides: it scales the whole sample uniformly to fit the gripper or rejects it, so design at the REAL size of the real object and let code scale it.

The gripper: an asymmetric parallel jaw (one fixed finger, one pivoting finger, 2 mm pads) that approaches from above and opens to about 66 mm. It holds ${L.graspMinMm} to ${L.graspMaxMm} mm across the narrowest side (best at most ${L.graspTargetMaxMm} mm), samples ${L.heightMinMm} to ${L.heightMaxMm} mm tall, at most ${L.footprintMaxMm} mm wide seen from above, and at most ${L.massMaxG} g (about 90 g of payload at full reach). The arm reaches 130 to 210 mm from its base.

Frame: millimetres, z up, the deck is z = 0. Every part starts with its base on z = 0, centred on x = y = 0; rot_deg (XYZ Euler, degrees) turns it about its own base centre, then pos_mm moves it. Stack parts by setting pos_mm z to the height of what is below. All parts must touch: nothing floating.
Kinds: box (size_mm [x, y, z]); cylinder (radius_mm, height_mm); cone (radius_mm bottom, radius2_mm top, height_mm); sphere (radius_mm); torus (radius_mm ring, radius2_mm tube; lies flat); capsule (radius_mm, height_mm total, vertical); lathe (profile_mm [radius, z] points bottom to top, revolved about z: canisters, vials, bottles); extrude (outline_mm [x, y] polygon extruded up by height_mm: plates, brackets, crystals); rock (radius_mm plus rock {seed, roughness 0-1, craters 0-12, elongation [x, y, z], flat_base 0-0.35}): use rock for asteroid fragments, meteorites and pebbles. repeat {count, step_mm, step_deg} copies a part (bolt circles, grid lines, layers). Use at most 12 parts; prefer 1 to 6. Radii are half the diameter.
Materials (code owns the density; never give a number): ${Object.entries(MATERIAL_DENSITY).map(([k, v]) => `${k} ${v}`).join(', ')} g/cm3. Bennu or Ryugu material is rubble_pile; carbonaceous meteorites chondrite; stony meteorites and Mars rocks basalt; iron meteorites iron_meteorite; thin-walled containers hollow_aluminum.
Colours are #RRGGBB and should look real: Bennu #4a4744, Ryugu #2a2928, iron #77777c (metalness 0.85), Mars #9a4a2c, aluminium #c9ccd2 (metalness 0.8), solar cell #1b2a5e, ice #cfe8f7 (opacity 0.75).

Example, "a fragment of asteroid Bennu": {"name":"Bennu fragment","category":"asteroid","color":"#4a4744","material":"rubble_pile","parts":[{"kind":"rock","radius_mm":17,"rock":{"seed":101,"roughness":0.6,"craters":5,"elongation":[1.25,1,0.8],"flat_base":0.12},"roughness":0.95}]}
Example, "a sample canister": {"name":"Sample canister","category":"canister","color":"#c9ccd2","material":"hollow_aluminum","parts":[{"kind":"lathe","profile_mm":[[12,0],[13.5,1.5],[13.5,30],[12.8,31]],"metalness":0.8,"roughness":0.32},{"kind":"cylinder","radius_mm":14.5,"height_mm":6,"pos_mm":[0,0,31],"color":"#a9adb5","metalness":0.8},{"kind":"torus","radius_mm":13.5,"radius2_mm":0.9,"pos_mm":[0,0,14],"color":"#d4a017","metalness":0.9}]}`;

/** Parse model text leniently: strip a code fence, else take the outermost {...}. Throws on no JSON. */
export function parseModelJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error(`the designer did not return JSON: ${t.slice(0, 60)}`);
  }
}

export interface RepairContext {
  program: FabProgram;
  reason: string;
  suggestion?: string;
}

/** One design call: description (+ optional repair context) -> sanitized program (densities from materials). */
export async function designProgram(description: string, deps: DesignerDeps, repair?: RepairContext, signal?: AbortSignal): Promise<{ program: FabProgram; latencyMs: number }> {
  let prompt = `Design this sample: ${description}`;
  if (repair) {
    prompt += `\n\nYour previous design was: ${JSON.stringify(repair.program)}\nThe code guardrail rejected it: ${repair.reason}.${repair.suggestion ? ` Suggestion: ${repair.suggestion}` : ''}\nReturn a corrected shape program for the same object.`;
  }
  const r = await deps.generateJson({ system: DESIGNER_SYSTEM, prompt, schema: PROGRAM_JSON_SCHEMA, signal });
  return { program: sanitizeProgram(parseModelJson(r.text), { allowDensity: false, allowDesignScale: false }), latencyMs: r.latencyMs };
}

/** Refusals that are about the spot or the bay, not the design: no repair turn for those. */
const NOT_DESIGN = new Set(['TOO_MANY', 'NO_FREE_SPOT', 'TOO_CLOSE_TO', 'ON_CONTAINMENT', 'ON_TRAY', 'TOO_FAR', 'TOO_CLOSE', 'BEHIND_ARM', 'UNREACHABLE', 'NO_REFERENCE', 'BAD_POSITION', 'REJECTED_STATE']);

export type Designed = Placed & { attempts: number; latencyMs: number; source: 'gemini' | 'preset' | 'nasa' };
/**
 * A refusal. program is the Gemini design that was refused (absent when none got that far, or a preset was);
 * after a refused repair turn, note says what the guardrail said about the first design.
 */
export type DesignRefusal = Rejection & { program?: FabProgram; note?: string };

const ABORTED: Rejection = { ok: false, code: 'ABORTED', reason: 'the request was cancelled, so no sample was made' };

/** A cancelled model call (GeminiError 'ABORTED' or a DOM AbortError). */
function isAbort(e: unknown): boolean {
  return !!e && typeof e === 'object' && ((e as { code?: unknown }).code === 'ABORTED' || (e as { name?: unknown }).name === 'AbortError');
}

/** Why nothing may be placed now: the request was cancelled, or the bay is stopped or E-stopped. */
function halted(bay: BayApi, signal?: AbortSignal): Rejection | null {
  if (signal?.aborted) return { ...ABORTED };
  const s = bay.gate.state();
  if (s === 'ESTOPPED') return { ok: false, code: 'BAY_ESTOPPED', reason: 'emergency stop is active, so the sample was not placed' };
  if (s === 'STOPPED') return { ok: false, code: 'BAY_STOPPED', reason: 'the bay is stopped, so the sample was not placed' };
  return null;
}

/**
 * Description -> Gemini program -> fabricate -> bay.samples.createMesh(..., 'gemini'), with one repair turn on a
 * design refusal. If Gemini answered both times and the guardrail refused both designs, the second refusal is
 * returned (code, reason, suggestion). A keyword-matched preset is fabricated only when Gemini cannot answer.
 * Placement refusals come back as they are. A cancelled request (signal aborted, e.g. by an emergency stop)
 * returns ABORTED with no fallback, and nothing is placed while the bay is STOPPED or ESTOPPED (checked right
 * before placing).
 */
export async function designAndFabricate(bay: BayApi, description: string, placement: Placement | undefined, deps: DesignerDeps, signal?: AbortSignal): Promise<Designed | DesignRefusal> {
  let latencyMs = 0;
  let attempts = 0;
  const fallback = async (why: string): Promise<Designed | Rejection> => {
    const stop = halted(bay, signal);
    if (stop) return stop;
    const p = matchPreset(description);
    const r = await fabricatePreset(bay, p.id, placement, () => halted(bay, signal));
    if (!r.ok) return { ok: false, code: r.code, reason: r.reason, ...(r.suggestion ? { suggestion: r.suggestion } : {}) }; // no Gemini design
    const note = `${why}; fabricated the closest preset (${p.label}) instead.`;
    return { ...r, say: `${r.say} ${note}`, note, attempts, latencyMs, source: p.source };
  };
  const place = (f: Fabricated, note?: string): Designed | DesignRefusal => {
    const stop = halted(bay, signal);
    if (stop) return { ...stop, program: f.program };
    const r = placeFabricated(bay, f, placement, 'gemini');
    if (!r.ok) return { ...r, program: f.program };
    return { ...r, say: note ? `${r.say} ${note}` : r.say, ...(note ? { note } : {}), attempts, latencyMs, source: 'gemini' };
  };
  let first: { program: FabProgram; latencyMs: number };
  try {
    attempts++;
    first = await designProgram(description, deps, undefined, signal);
  } catch (e) {
    if (signal?.aborted || isAbort(e)) return { ...ABORTED };
    return fallback(`Gemini did not answer (${String((e as Error).message).slice(0, 60)})`);
  }
  latencyMs += first.latencyMs;
  const f1 = fabricateProgram(first.program, 'gemini');
  if (f1.ok) return place(f1);
  if (NOT_DESIGN.has(f1.code)) return f1;
  let second: { program: FabProgram; latencyMs: number };
  try {
    attempts++;
    second = await designProgram(description, deps, { program: first.program, reason: f1.reason, suggestion: f1.suggestion }, signal);
  } catch (e) {
    if (signal?.aborted || isAbort(e)) return { ...ABORTED };
    return fallback(`the guardrail refused the design (${f1.reason}) and the repair turn did not answer`);
  }
  latencyMs += second.latencyMs;
  const f2: Fabricated | FabRejection = fabricateProgram(second.program, 'gemini');
  if (f2.ok) return place(f2, `Gemini repaired its design after the guardrail said: ${f1.reason}.`);
  // Gemini answered twice and the guardrail refused both designs: the refusal is the answer, not a preset.
  return {
    ok: false,
    code: f2.code,
    reason: f2.reason,
    ...(f2.suggestion ? { suggestion: f2.suggestion } : {}),
    ...(f2.program ? { program: f2.program } : {}),
    note: `Gemini redesigned it once after the guardrail said: ${f1.reason}.`,
  };
}
