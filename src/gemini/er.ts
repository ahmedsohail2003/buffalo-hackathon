// Gemini Robotics-ER on the fixed bay camera: point at things, answer yes/no questions, and check
// a new sample. Gemini sees; code decides: every answer is set against the sample registry, and
// where the registry can answer (positions, containment), the registry wins.
// No DOM; the frame comes from bay.capture().
import type { BayApi, FrameCapture, Sample, Vec3 } from '../contracts';
import { callGemini, type CallFn, statusOf } from './client';
import { ROBOTICS_ER, type Purpose, type ThinkingLevel } from './models';

/** Robotics-ER pointing format: [{ point: [y, x], label }] with y, x normalized 0-1000. */
export const POINT_SCHEMA = {
  type: 'array',
  maxItems: 5,
  items: {
    type: 'object',
    properties: {
      point: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 1000 }, minItems: 2, maxItems: 2 },
      label: { type: 'string' },
    },
    required: ['point', 'label'],
  },
} as const;

export const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', enum: ['yes', 'no', 'unsure'] },
    observation: { type: 'string' },
  },
  required: ['answer', 'observation'],
} as const;

export const GRASP_SCHEMA = {
  type: 'object',
  properties: {
    visible: { type: 'boolean' },
    point: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 1000 }, minItems: 2, maxItems: 2 },
    clear: { type: 'string', enum: ['yes', 'no', 'unsure'] },
    observation: { type: 'string' },
  },
  required: ['visible', 'clear', 'observation'],
} as const;

/** Plane used to unproject a point when the label matches no registry sample (m above the deck). */
export const DEFAULT_PLANE_Z = 0.015;
/** How far the camera may place a new sample from its registry position before the check fails. */
export const GRASP_TOLERANCE_MM = 30;

export interface ErDeps {
  call?: CallFn;
  model?: string;
  level?: ThinkingLevel;
  signal?: AbortSignal;
  /** registry answer to "is this sample in containment?" (wired from the arm core's constants) */
  inContainment?: (s: Sample) => boolean;
  toleranceMm?: number;
}

export type Answer = 'yes' | 'no' | 'unsure';

export interface RawPoint {
  yx: [number, number];
  label: string;
}

export interface PointMatch {
  id: string;
  name: string;
  /** distance in the deck plane between where the camera points and the registry centre, mm */
  error_mm: number | null;
  /** the same miss in image units (0-1000 scale) */
  image_error: number;
  registry_mm: [number, number, number];
}

export interface PointResult {
  ok: boolean;
  label: string;
  point_yx?: [number, number];
  bay_mm?: [number, number, number] | null;
  match?: PointMatch;
  points: RawPoint[];
  reason?: string;
  schema?: boolean;
}

export interface VerifyResult {
  ok: boolean;
  answer: Answer;
  observation: string;
  /** 'code' when the registry could answer the question itself */
  decided_by: 'code' | 'camera';
  agree?: boolean;
  registry: Array<{ id: string; name: string; held: boolean; x_mm: number; y_mm: number; in_containment?: boolean }>;
  schema?: boolean;
}

export interface GraspCheckResult {
  ok: boolean;
  id: string;
  visible: boolean;
  clear: Answer;
  observation: string;
  error_mm: number | null;
  nearest_mm: number | null;
  spacing_ok: boolean;
  reason: string;
  schema?: boolean;
}

// ---- One Robotics-ER request ----------------------------------------------------------------

export interface ErAnswer {
  json: unknown;
  text: string;
  frame: FrameCapture;
  schemaUsed: boolean;
}

/** Fresh frame + prompt -> JSON. On a 400 (schema not accepted) retries once without the schema. */
export async function askEr(bay: BayApi, purpose: Purpose, prompt: string, schema: object, deps: ErDeps = {}): Promise<ErAnswer> {
  const frame = bay.capture();
  const call = deps.call ?? callGemini;
  const contents = [
    {
      role: 'user',
      parts: [{ inlineData: { mimeType: 'image/jpeg', data: stripDataUrl(frame.jpegB64) } }, { text: prompt }],
    },
  ];
  const req = { purpose, model: deps.model ?? ROBOTICS_ER, level: deps.level, contents, signal: deps.signal };
  try {
    const res = await call({ ...req, config: { responseMimeType: 'application/json', responseJsonSchema: schema } });
    return { json: parseJsonLoose(res.text), text: res.text, frame, schemaUsed: true };
  } catch (err) {
    if (statusOf(err) !== 400) throw err;
    const res = await call({ ...req, config: {} });
    return { json: parseJsonLoose(res.text), text: res.text, frame, schemaUsed: false };
  }
}

export function stripDataUrl(b64: string): string {
  const i = b64.indexOf('base64,');
  return i >= 0 ? b64.slice(i + 7) : b64;
}

/** JSON from a model reply: plain, fenced, or embedded in prose. null if none. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    // fall through to the embedded search
  }
  for (const [open, close] of [
    ['[', ']'],
    ['{', '}'],
  ] as const) {
    const a = t.indexOf(open);
    const b = t.lastIndexOf(close);
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        // try the other bracket kind
      }
    }
  }
  return null;
}

// ---- Pointing -------------------------------------------------------------------------------

/** Accepts [{point, label}], {points: [...]}, a single {point}, or a bare [y, x]. */
export function readPoints(json: unknown): RawPoint[] {
  let items: unknown[] = [];
  if (Array.isArray(json)) {
    items = json.length === 2 && json.every((v) => typeof v === 'number') ? [{ point: json }] : json;
  } else if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    if (Array.isArray(o.points)) items = o.points;
    else if (Array.isArray(o.point)) items = [o];
  }
  const out: RawPoint[] = [];
  for (const it of items) {
    const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
    const p = Array.isArray(it) ? it : Array.isArray(o.point) ? o.point : null;
    if (!p || p.length < 2) continue;
    const y = Number(p[0]);
    const x = Number(p[1]);
    if (!Number.isFinite(y) || !Number.isFinite(x)) continue;
    out.push({ yx: [clamp(y, 0, 1000), clamp(x, 0, 1000)], label: typeof o.label === 'string' ? o.label : '' });
  }
  return out;
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'sample', 'samples', 'piece', 'one', 'that', 'this', 'on', 'in', 'is', 'it', 'to', 'at']);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP_WORDS.has(w));
}

function idMentioned(id: string, text: string): boolean {
  const esc = id.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_-])${esc}($|[^a-z0-9_-])`).test(text.toLowerCase());
}

/** How well a label names a sample: 1 for its id, else the share of its name's words present. */
export function nameScore(s: Sample, label: string): number {
  if (idMentioned(s.id, label)) return 1;
  const nameWords = words(s.name);
  if (!nameWords.length) return 0;
  const labelWords = new Set(words(label));
  return nameWords.filter((w) => labelWords.has(w)).length / nameWords.length;
}

/** The registry sample a label refers to (id, or at least half of its name's words), if any. */
export function matchSample(samples: Sample[], label: string): Sample | undefined {
  let best: Sample | undefined;
  let bestScore = 0;
  for (const s of samples) {
    const score = nameScore(s, label);
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return bestScore >= 0.5 ? best : undefined;
}

/** Every registry sample the text mentions. */
export function mentionedSamples(samples: Sample[], text: string): Sample[] {
  return samples.filter((s) => nameScore(s, text) >= 0.5);
}

/** Where the camera pointed vs where the registry says the sample is. */
export function compareToRegistry(bay: BayApi, sample: Sample, yx: [number, number]): PointMatch {
  const at = bay.unproject(yx, sample.pos[2]);
  const proj = bay.project(sample.pos);
  return {
    id: sample.id,
    name: sample.name,
    error_mm: at ? round1(Math.hypot(at[0] - sample.pos[0], at[1] - sample.pos[1]) * 1000) : null,
    image_error: round1(Math.hypot(proj[0] - yx[0], proj[1] - yx[1])),
    registry_mm: mmVec(sample.pos),
  };
}

/** Pure part of point_at: pick the point, unproject it, match it to the registry. */
export function localize(bay: BayApi, label: string, points: RawPoint[]): PointResult {
  if (!points.length) return { ok: false, label, points, reason: `The bay camera cannot see ${label}.` };
  const samples = bay.samples.list();
  const target = matchSample(samples, label);
  // Several points: prefer the one whose own label names the target best.
  const best = target && points.length > 1 ? [...points].sort((a, b) => nameScore(target, b.label) - nameScore(target, a.label))[0] : points[0];
  const z = target ? target.pos[2] : DEFAULT_PLANE_Z;
  const at = bay.unproject(best.yx, z);
  let sample = target;
  if (!sample && at) {
    let bestD = Infinity;
    for (const s of samples) {
      const d = Math.hypot(s.pos[0] - at[0], s.pos[1] - at[1]);
      if (d < bestD) {
        bestD = d;
        sample = s;
      }
    }
    if (bestD > 0.06) sample = undefined; // nothing in the registry within 60 mm
  }
  return {
    ok: !!at,
    label,
    point_yx: best.yx,
    bay_mm: at ? mmVec(at) : null,
    ...(sample ? { match: compareToRegistry(bay, sample, best.yx) } : {}),
    points,
    ...(at ? {} : { reason: 'That point does not land on the deck.' }),
  };
}

export async function pointAt(bay: BayApi, label: string, deps: ErDeps = {}): Promise<PointResult> {
  const prompt =
    `Point to ${label} in the image. ` +
    'The answer should follow the JSON format: [{"point": [y, x], "label": "<what it is>"}]. ' +
    'The points are in [y, x] format normalized to 0-1000. Return at most 3 points, best first. ' +
    'If it is not visible, return [].';
  const ans = await askEr(bay, 'point', prompt, POINT_SCHEMA, deps);
  return { ...localize(bay, label, readPoints(ans.json)), schema: ans.schemaUsed };
}

// ---- Verification ---------------------------------------------------------------------------

function readAnswer(v: unknown): Answer {
  const s = String(v ?? '').toLowerCase();
  if (s === 'yes' || s === 'true') return 'yes';
  if (s === 'no' || s === 'false') return 'no';
  return 'unsure';
}

/** Code's own answer to "is X in containment?", or undefined when code cannot answer this one. */
function registryAnswer(question: string, mentioned: Sample[], deps: ErDeps): boolean | undefined {
  if (!deps.inContainment || mentioned.length !== 1) return undefined;
  if (!/contain|\bbin\b|\btray\b/i.test(question)) return undefined;
  return deps.inContainment(mentioned[0]);
}

/** Ask Robotics-ER a yes/no question about a fresh bay frame. */
export async function verifyQuestion(bay: BayApi, question: string, deps: ErDeps = {}): Promise<VerifyResult> {
  const prompt =
    'You are the inspection camera of an orbital sample-curation bay: a light deck with a 1 cm grid, ' +
    'a containment bin and small samples. Answer using only what is visible in this image.\n' +
    `Question: ${question}\n` +
    'Reply as JSON: {"answer": "yes" | "no" | "unsure", "observation": "<one short sentence>"}.';
  const ans = await askEr(bay, 'verify', prompt, VERIFY_SCHEMA, deps);
  const o = (ans.json && typeof ans.json === 'object' ? ans.json : {}) as Record<string, unknown>;
  const answer = readAnswer(o.answer);
  const observation = String(o.observation ?? (ans.json === null ? ans.text : '')).slice(0, 240).trim();
  const mentioned = mentionedSamples(bay.samples.list(), question);
  const code = registryAnswer(question, mentioned, deps);
  const camera = answer === 'yes' ? true : answer === 'no' ? false : undefined;
  return {
    ok: code ?? camera ?? false,
    answer,
    observation,
    decided_by: code !== undefined ? 'code' : 'camera',
    ...(code !== undefined && camera !== undefined ? { agree: code === camera } : {}),
    registry: mentioned.map((s) => ({
      id: s.id,
      name: s.name,
      held: s.held,
      x_mm: Math.round(s.pos[0] * 1000),
      y_mm: Math.round(s.pos[1] * 1000),
      ...(deps.inContainment ? { in_containment: deps.inContainment(s) } : {}),
    })),
    schema: ans.schemaUsed,
  };
}

/** "Is the <sample> inside containment?" Camera and registry both answer; the registry decides. */
export function verifyContainment(bay: BayApi, sampleId: string, deps: ErDeps = {}): Promise<VerifyResult> {
  const s = bay.samples.get(sampleId);
  return verifyQuestion(bay, `Is the ${s ? `${s.name} (${s.id})` : sampleId} inside the containment bin?`, deps);
}

// ---- Grasp check for a new sample -----------------------------------------------------------

/** Footprint radius, mm. */
function radiusMm(s: Sample): number {
  return (Math.hypot(s.dims.w, s.dims.d) / 2) * 1000;
}

/** Required centre spacing between two samples, mm: max(40, r_a + r_b + 10). */
export function requiredSpacingMm(a: Sample, b: Sample): number {
  return Math.max(40, radiusMm(a) + radiusMm(b) + 10);
}

export async function graspCheck(bay: BayApi, sampleId: string, deps: ErDeps = {}): Promise<GraspCheckResult> {
  const s = bay.samples.get(sampleId);
  const base = { id: sampleId, visible: false, clear: 'unsure' as Answer, observation: '', error_mm: null, nearest_mm: null, spacing_ok: false };
  if (!s) return { ...base, ok: false, reason: `No sample ${sampleId} in the registry.` };

  // Code: spacing against every other sample on the deck.
  let nearest: { s: Sample; d: number } | null = null;
  for (const o of bay.samples.list()) {
    if (o.id === s.id || o.held) continue;
    const d = Math.hypot(o.pos[0] - s.pos[0], o.pos[1] - s.pos[1]) * 1000;
    if (!nearest || d < nearest.d) nearest = { s: o, d };
  }
  const spacingOk = !nearest || nearest.d >= requiredSpacingMm(s, nearest.s);

  // Camera: is it there, and is there room for the fingers?
  const wMm = Math.round(s.dims.w * 1000);
  const hMm = Math.round(s.dims.h * 1000);
  const prompt =
    `A new sample, "${s.name}" (about ${wMm} mm wide and ${hMm} mm tall), was just placed on the deck. ` +
    'Is it visible? Point to its centre as [y, x] normalized 0-1000. ' +
    'Is there free deck space on both sides of it for the fingers of a parallel-jaw gripper (about 20 mm each side)? ' +
    'Reply as JSON: {"visible": true | false, "point": [y, x], "clear": "yes" | "no" | "unsure", "observation": "<one short sentence>"}.';
  const ans = await askEr(bay, 'grasp_check', prompt, GRASP_SCHEMA, deps);
  const o = (ans.json && typeof ans.json === 'object' ? ans.json : {}) as Record<string, unknown>;
  const pts = readPoints(Array.isArray(o.point) ? { point: o.point } : null);
  const visible = o.visible === true || String(o.visible).toLowerCase() === 'true';
  const match = visible && pts.length ? compareToRegistry(bay, s, pts[0].yx) : null;
  const errorMm = match?.error_mm ?? null;
  const tol = deps.toleranceMm ?? GRASP_TOLERANCE_MM;
  const located = errorMm !== null && errorMm <= tol;
  const nearestMm = nearest ? Math.round(nearest.d) : null;

  let reason: string;
  if (!visible) reason = `The bay camera cannot see ${s.name}.`;
  else if (errorMm === null) reason = `The camera sees ${s.name} but gave no usable point.`;
  else if (!located) reason = `The camera places ${s.name} ${Math.round(errorMm)} mm from its registry position (limit ${tol} mm).`;
  else if (!spacingOk && nearest) reason = `${s.name} is ${nearestMm} mm from ${nearest.s.name}; it needs ${Math.round(requiredSpacingMm(s, nearest.s))} mm.`;
  else reason = `${s.name} confirmed on camera, ${Math.round(errorMm)} mm from its registry position.`;

  return {
    ok: visible && located && spacingOk,
    id: s.id,
    visible,
    clear: readAnswer(o.clear),
    observation: String(o.observation ?? '').slice(0, 240).trim(),
    error_mm: errorMm,
    nearest_mm: nearestMm,
    spacing_ok: spacingOk,
    reason,
    schema: ans.schemaUsed,
  };
}

// ---- small helpers --------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function mmVec(v: Vec3): [number, number, number] {
  return [Math.round(v[0] * 1000), Math.round(v[1] * 1000), Math.round(v[2] * 1000)];
}
