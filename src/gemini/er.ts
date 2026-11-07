// Gemini Robotics-ER: pointing (localization vs registry ground truth), per-step verification, grasp check.
// Prompts verbatim from PLAN.md §1.7. Node-safe (no window/document).

import type { Content } from '@google/genai/web';
import type { CellApi, FrameCapture, SceneObject, Vec3 } from '../contracts';
import { bus, fmtMs, fmtUsd } from '../telemetry/bus';
import { egress } from '../telemetry/egress';
import { callER, parseJson } from './client';
import { DEMO } from './models';

export const ER_POINT = (labels: string) =>
  `Point to the following items in the image: ${labels}. Point at the centre of each item's top face. The label returned should be the exact requested name. The answer should follow the json format: [{"point": <point>, "label": <label>}, ...]. The points are in [y, x] format normalized to 0-1000. Omit items you cannot see.`;

export const ER_VERIFY = (step: string, expectation: string) =>
  `This rendered cell-camera frame was captured after the arm executed: "${step}". Expected outcome: "${expectation}". Judge only from the image and be strict: a part must be between the jaws or inside the tray, not merely near it. Return {"ok": true|false, "observation": "<one sentence>"}.`;

export const ER_GRASP = (o: { shape: string; width_mm: number; depth_mm: number; height_mm: number; color: string; x_mm: number; y_mm: number }) =>
  `The gripper is a two-finger pivoting jaw that approaches from above; it opens to about 95 mm, closes to 8 mm and grips reliably between 15 and 45 mm. A new part was just added: ${o.shape}, ${o.width_mm} x ${o.depth_mm} x ${o.height_mm} mm, ${o.color}, at (${o.x_mm}, ${o.y_mm}). From the image, can it be grasped from above? Return {"graspable": true|false, "grasp_point": [y, x] normalized 0-1000 on the part's top face, "approach_yaw_deg": angle of the jaw closing axis in the image (0 = image horizontal), "reason": "<one sentence>"}.`;

export const POINT_SCHEMA = {
  type: 'array',
  items: { type: 'object', properties: { point: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 }, label: { type: 'string' } }, required: ['point', 'label'] },
};
export const VERIFY_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' }, observation: { type: 'string' } }, required: ['ok', 'observation'] };
export const GRASP_SCHEMA = { type: 'object', properties: { graspable: { type: 'boolean' }, grasp_point: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 }, approach_yaw_deg: { type: 'number' }, reason: { type: 'string' } }, required: ['graspable', 'grasp_point', 'approach_yaw_deg', 'reason'] };

export interface PointResult {
  label: string;
  /** ER image point [y, x] 0-1000 (median over consensus samples) */
  image_point: [number, number];
  /** unprojected root-frame xy in mm, on the plane z = matched object's height (top face) or 0 */
  world_mm: [number, number] | null;
  /** nearest registry object within 25 mm, else null */
  matched: string | null;
  /** |unprojected − registry xy| in mm (null when unmatched/unprojectable) */
  error_mm: number | null;
  samples: number;
  latencyMs: number;
}

export const imagePart = (f: FrameCapture) => ({ inlineData: { mimeType: 'image/jpeg', data: f.jpegB64 } });

function frameContent(f: FrameCapture, text: string): Content[] {
  egress.bumpCellFrames();
  return [{ role: 'user', parts: [imagePart(f), { text }] }];
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

/** JSON call with the responseJsonSchema on; on a 400 mentioning the schema, retry once schema-off (fence-strip + validation). */
async function jsonCall<T>(opts: Parameters<typeof callER>[0], schema: unknown, validate: (v: unknown) => v is T): Promise<{ value: T; latencyMs: number; costUsd: number; entryLevel: string }> {
  const base = { ...(opts.config ?? {}), responseMimeType: 'application/json' as const };
  const attempt = async (withSchema: boolean) => {
    const r = await callER({ ...opts, config: withSchema ? { ...base, responseJsonSchema: schema } : base });
    const value = parseJson<unknown>(r.text);
    if (!validate(value)) throw new Error(`ER ${opts.purpose}: unexpected JSON ${r.text.slice(0, 120)}`);
    return { value, latencyMs: r.latencyMs, costUsd: r.entry.costUsd, entryLevel: opts.level };
  };
  if (!DEMO.pointSchema) return attempt(false);
  try { return await attempt(true); }
  catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 400) { DEMO.pointSchema = false; bus.fallback('SCHEMA-OFF', `responseJsonSchema rejected (400) — using responseMimeType + fence-strip`); return attempt(false); }
    throw e;
  }
}

type RawPoint = { point: [number, number]; label: string };
const isPoints = (v: unknown): v is RawPoint[] => Array.isArray(v) && v.every((p) => p && Array.isArray(p.point) && p.point.length === 2 && p.point.every((n: unknown) => typeof n === 'number' && n >= 0 && n <= 1000) && typeof p.label === 'string');
const isVerify = (v: unknown): v is { ok: boolean; observation: string } => !!v && typeof (v as { ok?: unknown }).ok === 'boolean' && typeof (v as { observation?: unknown }).observation === 'string';
const isGrasp = (v: unknown): v is GraspResult => !!v && typeof (v as { graspable?: unknown }).graspable === 'boolean' && Array.isArray((v as { grasp_point?: unknown }).grasp_point);

/** Registry-side matching: nearest object by name (case-insensitive contains), else by unprojected xy within 25 mm. */
function matchObject(objects: SceneObject[], label: string, xyMm: [number, number] | null): SceneObject | null {
  const l = label.toLowerCase();
  const byName = objects.find((o) => o.name.toLowerCase() === l || o.id.toLowerCase() === l) ?? objects.find((o) => l.includes(o.name.toLowerCase()) || o.name.toLowerCase().includes(l));
  if (byName) return byName;
  if (!xyMm) return null;
  let best: SceneObject | null = null, bd = 25;
  for (const o of objects) { const d = Math.hypot(o.pos[0] * 1000 - xyMm[0], o.pos[1] * 1000 - xyMm[1]); if (d < bd) { bd = d; best = o; } }
  return best;
}

/**
 * Point at labels in a frame; n samples (median per coordinate; temperature 0.4 when n = 3, else 0).
 * Unprojects through the cell camera onto z = matched object's height (top face), else z = 0.
 */
export async function pointAt(cell: CellApi, frame: FrameCapture, labels: string[], n: 1 | 3 = DEMO.consensusN, signal?: AbortSignal): Promise<PointResult[]> {
  const t0 = performance.now();
  const objects = cell.objects.list();
  const samples: RawPoint[][] = [];
  let cost = 0;
  for (let i = 0; i < n; i++) {
    const r = await jsonCall<RawPoint[]>({ purpose: 'point', level: 'LOW', contents: frameContent(frame, ER_POINT(labels.join(', '))), config: { temperature: n === 3 ? 0.4 : 0 }, signal }, POINT_SCHEMA, isPoints);
    samples.push(r.value); cost += r.costUsd;
  }
  const out: PointResult[] = [];
  for (const label of labels) {
    const hits = samples.map((s) => s.find((p) => p.label.toLowerCase() === label.toLowerCase()) ?? s.find((p) => p.label.toLowerCase().includes(label.toLowerCase()))).filter((p): p is RawPoint => !!p);
    if (!hits.length) continue;
    const image_point: [number, number] = [median(hits.map((h) => h.point[0])), median(hits.map((h) => h.point[1]))];
    // first guess on z = 0 to find a match by position, then re-unproject on the matched top face
    const guess = cell.unprojectER(image_point, 0);
    const m = matchObject(objects, label, guess ? [guess[0] * 1000, guess[1] * 1000] : null);
    const zPlane = m ? m.pos[2] + m.dims.h / 2 : 0;
    const w = cell.unprojectER(image_point, zPlane);
    const world_mm: [number, number] | null = w ? [Math.round(w[0] * 1000 * 10) / 10, Math.round(w[1] * 1000 * 10) / 10] : null;
    const error_mm = m && world_mm ? Math.round(Math.hypot(world_mm[0] - m.pos[0] * 1000, world_mm[1] - m.pos[1] * 1000) * 10) / 10 : null;
    out.push({ label, image_point, world_mm, matched: m?.id ?? null, error_mm, samples: hits.length, latencyMs: Math.round(performance.now() - t0) });
  }
  const latencyMs = Math.round(performance.now() - t0);
  const summary = out.map((p) => `${p.matched ?? p.label}${p.error_mm !== null ? ` err ${p.error_mm} mm` : ' (unmatched)'}`).join(', ');
  bus.emit({ kind: 'gemini', text: `ER point LOW ${fmtMs(latencyMs)}  ${summary || 'nothing found'}  ${fmtUsd(cost)}` });
  return out;
}

export interface VerifyResult { ok: boolean; observation: string; latencyMs: number; costUsd: number }

/** Strict per-step verification from a fresh frame (LOW). */
export async function verifyStep(cell: CellApi, frame: FrameCapture, step: string, expectation: string, signal?: AbortSignal): Promise<VerifyResult> {
  void cell;
  const r = await jsonCall<{ ok: boolean; observation: string }>({ purpose: 'verify', level: 'LOW', contents: frameContent(frame, ER_VERIFY(step, expectation)), config: { temperature: 0 }, signal }, VERIFY_SCHEMA, isVerify);
  bus.emit({ kind: 'gemini', text: `ER check LOW ${fmtMs(r.latencyMs)} ${r.value.ok ? '✓' : '✗'} "${r.value.observation}"` });
  return { ok: r.value.ok, observation: r.value.observation, latencyMs: r.latencyMs, costUsd: r.costUsd };
}

export interface GraspResult { graspable: boolean; grasp_point: [number, number]; approach_yaw_deg: number; reason: string }

/** Grasp-feasibility check on a freshly created part (MEDIUM). Never blocks creation; callers catch. */
export async function graspCheck(cell: CellApi, frame: FrameCapture, obj: SceneObject, signal?: AbortSignal): Promise<GraspResult & { world_mm: [number, number] | null; latencyMs: number }> {
  const spec = { shape: obj.shape, width_mm: Math.round(obj.dims.w * 1000), depth_mm: Math.round(obj.dims.d * 1000), height_mm: Math.round(obj.dims.h * 1000), color: obj.color, x_mm: Math.round(obj.pos[0] * 1000), y_mm: Math.round(obj.pos[1] * 1000) };
  const r = await jsonCall<GraspResult>({ purpose: 'grasp_check', level: 'MEDIUM', contents: frameContent(frame, ER_GRASP(spec)), config: { temperature: 0 }, signal }, GRASP_SCHEMA, isGrasp);
  const w = cell.unprojectER(r.value.grasp_point, obj.pos[2] + obj.dims.h / 2);
  const world_mm: [number, number] | null = w ? [Math.round(w[0] * 1000), Math.round(w[1] * 1000)] : null;
  bus.emit({ kind: 'gemini', text: `ER grasp MEDIUM ${fmtMs(r.latencyMs)} ${r.value.graspable ? '✓' : '✗'} "${r.value.reason}"` });
  return { ...r.value, world_mm, latencyMs: r.latencyMs };
}

/** Convenience for the registry → ER text block. */
export function objectsForPrompt(objects: SceneObject[]) {
  return objects.map((o) => ({ id: o.id, name: o.name, color: o.color, shape: o.shape, width_mm: Math.round(o.dims.w * 1000), height_mm: Math.round(o.dims.h * 1000), x_mm: Math.round(o.pos[0] * 1000), y_mm: Math.round(o.pos[1] * 1000), held: o.held }));
}

export const mm = (p: Vec3): Vec3 => [Math.round(p[0] * 1000), Math.round(p[1] * 1000), Math.round(p[2] * 1000)];
