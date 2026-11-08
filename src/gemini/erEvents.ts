// point_at and check_bay results as viewer events (bus 'er:point' and 'er:check'): what the
// bay-camera inset and the deck marker draw. The dispatcher hands one event per result to the
// sink's er hook. Pure; no DOM.
import type { BayApi, ErCheckEvent, ErPointEvent, Vec3 } from '../contracts';

type Loose = Record<string, unknown>;

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function pair(v: unknown): [number, number] | null {
  return Array.isArray(v) && v.length >= 2 && finite(v[0]) && finite(v[1]) ? [v[0], v[1]] : null;
}

function triple(v: unknown): Vec3 | null {
  return Array.isArray(v) && v.length >= 3 && finite(v[0]) && finite(v[1]) && finite(v[2]) ? [v[0], v[1], v[2]] : null;
}

function obj(v: unknown): Loose | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : null;
}

function text(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * The event for a point_at result, or null when the model gave no point (nothing to draw).
 * truth_yx is the matched sample's registry position projected through the same bay camera.
 */
export function pointEvent(bay: BayApi, r: Loose, source: string, t: number = Date.now()): ErPointEvent | null {
  const point = pair(r.point_yx);
  if (!point) return null;
  const m = obj(r.match);
  const id = text(m?.id);
  const reported = triple(m?.registry_mm);
  const sample = id ? bay.samples.get(id) : undefined;
  // metres: the registry entry itself, else the position the tool reported
  const truth: Vec3 | null = sample ? [sample.pos[0], sample.pos[1], sample.pos[2]] : reported ? [reported[0] / 1000, reported[1] / 1000, reported[2] / 1000] : null;
  const projected = truth ? bay.project(truth) : null;
  const errorMm = m?.error_mm;
  return {
    kind: 'point',
    t,
    source,
    label: text(r.label) ?? '',
    point_yx: point,
    sample_id: id,
    sample_name: text(m?.name),
    found_mm: triple(r.bay_mm),
    error_mm: finite(errorMm) ? errorMm : null,
    truth_mm: reported ?? (truth ? [Math.round(truth[0] * 1000), Math.round(truth[1] * 1000), Math.round(truth[2] * 1000)] : null),
    truth_yx: projected ? [round1(projected[0]), round1(projected[1])] : null,
  };
}

const ANSWERS: ReadonlySet<string> = new Set(['yes', 'no', 'unsure']);

/** The event for a check_bay result, or null when the camera gave no answer (a refusal or an error). */
export function checkEvent(question: string, r: Loose, source: string, t: number = Date.now()): ErCheckEvent | null {
  const answer = text(r.answer);
  if (!answer || !ANSWERS.has(answer)) return null;
  if (r.decided_by !== 'code' && r.decided_by !== 'camera') return null;
  const registry = Array.isArray(r.registry) ? r.registry : [];
  const one = registry.length === 1 ? obj(registry[0]) : null;
  return {
    kind: 'check',
    t,
    source,
    question,
    decision: r.ok === true,
    decided_by: r.decided_by === 'code' ? 'registry' : 'camera',
    camera: answer as ErCheckEvent['camera'],
    agree: typeof r.agree === 'boolean' ? r.agree : null,
    observation: text(r.observation) ?? '',
    sample_id: text(one?.id),
    sample_name: text(one?.name),
  };
}

/** The overlay event for one tool result: point_at and check_bay only, and only when the camera answered. */
export function erEvent(bay: BayApi, name: string, args: Loose, r: Loose, source: string, t: number = Date.now()): ErPointEvent | ErCheckEvent | null {
  if (name === 'point_at') return pointEvent(bay, r, source, t);
  if (name === 'check_bay') return checkEvent((text(args.question) ?? '').trim().slice(0, 300), r, source, t);
  return null;
}
