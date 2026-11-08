// The tools Gemini may call (typed coworker and Live voice share them) and the one dispatcher
// that runs them. Moving and creating tools are refused while the bay is STOPPED or ESTOPPED, and
// arm moves also while it is IDLE (AI never starts a cycle), with a reason that can be spoken;
// read-only tools always answer (the camera checks first send an idle arm home, while RUNNING only,
// when it would hide the view). Every call is a log line.
// No DOM at import time.
import type { BayApi, MoveResult, Placement, Sample } from '../contracts';
import { HOME_Q } from '../core/constants';
import { BAY_FACTS, BAY_FRAME_TEXT, defaultInContainment } from './bayFacts';
import { errorText, generateJson as defaultGenerateJson, type CallFn } from './client';
import { matchSample, mentionedSamples, pointAt, verifyQuestion } from './er';
import { logTo, type FabricateFn, type FabricatorDeps, type LogSink } from './types';

export type ToolName =
  | 'describe_bay'
  | 'bay_status'
  | 'pick_sample'
  | 'place_sample'
  | 'place_in_containment'
  | 'go_home'
  | 'design_sample'
  | 'check_bay'
  | 'point_at';

export type ToolSource = 'coworker' | 'live' | 'operator' | 'test';

/** OpenAPI-style schema, as Gemini function declarations take it. */
export interface SchemaLite {
  type: 'OBJECT' | 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN' | 'ARRAY';
  description?: string;
  properties?: Record<string, SchemaLite>;
  required?: string[];
  enum?: string[];
  items?: SchemaLite;
}

export interface ToolDeclaration {
  name: ToolName;
  description: string;
  parameters?: SchemaLite;
  behavior?: 'BLOCKING' | 'NON_BLOCKING';
}

export interface ToolResult {
  ok: boolean;
  [key: string]: unknown;
}

/** Tools that move the arm or create a sample: refused while STOPPED or ESTOPPED. */
export const MOVING_TOOLS: ReadonlySet<string> = new Set(['pick_sample', 'place_sample', 'place_in_containment', 'go_home', 'design_sample']);
/** Tools that move the arm: also refused while IDLE, because only the operator starts a cycle. */
export const ARM_TOOLS: ReadonlySet<string> = new Set(['pick_sample', 'place_sample', 'place_in_containment', 'go_home']);
/** Tools that answer at once from the registry (no arm motion, no Gemini call). */
export const INSTANT_TOOLS: ReadonlySet<string> = new Set(['describe_bay', 'bay_status']);

const MM = (description: string): SchemaLite => ({ type: 'NUMBER', description });

export const TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: 'describe_bay',
    description:
      'Read the sample registry and arm: every sample on the deck (id, name, grip width, height, mass, position in mm, held), the arm phase and the bay safety state. Read-only; always available.',
  },
  {
    name: 'bay_status',
    description: 'Bay safety state (IDLE, RUNNING, SLOW, STOPPED, ESTOPPED), speed factor, arm phase and what the gripper holds. Read-only; always available.',
  },
  {
    name: 'pick_sample',
    description:
      'Pick up one sample with the gripper, by its id from describe_bay. Code checks reach, grip width and the bay state, and may refuse with a reason.',
    parameters: { type: 'OBJECT', properties: { id: { type: 'STRING', description: 'sample id, for example "s2"' } }, required: ['id'] },
  },
  {
    name: 'place_sample',
    description:
      `Put the held sample down on the deck. Easiest: give side (left, right, front, behind or center of the deck) and code chooses a free, checked spot there. Or give relative_to (a sample id, "containment" or "arm") with a direction and optional distance_mm; or nothing, for any free spot. Exact x_mm and y_mm also work; if code refuses that spot, the result suggests the nearest free one. ${BAY_FRAME_TEXT} Reachable: ${BAY_FACTS.reach.minMm} to ${BAY_FACTS.reach.maxMm} mm from the base, within ${BAY_FACTS.reach.bearingDeg} degrees of straight ahead. Parts need ${BAY_FACTS.spacingMinMm} mm or more between centres and must keep clear of the containment bin. Code checks reach and spacing and may refuse.`,
    parameters: {
      type: 'OBJECT',
      properties: {
        side: { type: 'STRING', enum: ['left', 'right', 'front', 'behind', 'center'], description: 'part of the deck; code picks a free spot there' },
        relative_to: { type: 'STRING', description: 'a sample id, "containment" or "arm"' },
        direction: { type: 'STRING', enum: ['left', 'right', 'front', 'behind'] },
        distance_mm: MM('distance from relative_to in mm'),
        x_mm: MM('deck x in mm'),
        y_mm: MM('deck y in mm'),
      },
    },
  },
  {
    name: 'place_in_containment',
    description: `Put the held sample into the containment bin, centred at (${BAY_FACTS.containmentMm[0]}, ${BAY_FACTS.containmentMm[1]}) mm.`,
  },
  {
    name: 'go_home',
    description: 'Move the arm to its home pose.',
  },
  {
    name: 'design_sample',
    description:
      `Fabricate a new sample from a short description (for example "a 30 mm chondrite meteorite fragment"). The fabricator designs it; code measures it and scales it to fit (grip ${BAY_FACTS.grip.minMm}-${BAY_FACTS.grip.maxMm} mm, height ${BAY_FACTS.height.minMm}-${BAY_FACTS.height.maxMm} mm, at most ${BAY_FACTS.massMaxG} g) or refuses it. Optional placement: absolute x_mm/y_mm, or relative_to a sample id, "containment" or "arm", with a direction and distance.`,
    parameters: {
      type: 'OBJECT',
      properties: {
        description: { type: 'STRING', description: 'what to make, in one sentence' },
        x_mm: MM('deck x in mm'),
        y_mm: MM('deck y in mm'),
        relative_to: { type: 'STRING', description: 'a sample id, "containment" or "arm"' },
        direction: { type: 'STRING', enum: ['left', 'right', 'front', 'behind'] },
        distance_mm: MM('distance from relative_to in mm'),
      },
      required: ['description'],
    },
  },
  {
    name: 'check_bay',
    description:
      'Ask the fixed bay camera (Gemini Robotics-ER) a yes/no question about what it sees now, for example "Is Itokawa inside the containment bin?". When the question is about one sample, also give its sample_id. Where the registry can answer, the registry decides and the result says whether the camera agrees. Always available; while the bay is RUNNING, an idle, empty arm parked over the bin or the sample moves home first so it does not hide the view.',
    parameters: {
      type: 'OBJECT',
      properties: {
        question: { type: 'STRING' },
        sample_id: { type: 'STRING', description: 'optional: id of the sample the question is about, for example "sample_3"' },
      },
      required: ['question'],
    },
  },
  {
    name: 'point_at',
    description:
      'Find something on the bay camera image (Gemini Robotics-ER pointing) and compare it with the registry: returns the deck position in mm and the localization error in mm. When it is a sample, also give its sample_id. Always available; while the bay is RUNNING, an idle, empty arm parked over the sample moves home first so it does not hide the view.',
    parameters: {
      type: 'OBJECT',
      properties: {
        label: { type: 'STRING', description: 'what to find, for example "the Itokawa sample"' },
        sample_id: { type: 'STRING', description: 'optional: id of the sample to find, for example "sample_3"' },
      },
      required: ['label'],
    },
  },
];

/** The same tools for Live: long tools run NON_BLOCKING and answer at once; instant tools block. */
export function liveToolDeclarations(): ToolDeclaration[] {
  return TOOL_DECLARATIONS.map((d) => ({ ...d, behavior: INSTANT_TOOLS.has(d.name) ? 'BLOCKING' : 'NON_BLOCKING' }));
}

export interface ToolContext {
  sink?: LogSink | null;
  /** src/fabricator designAndFabricate; until wired, design_sample refuses with FABRICATOR_OFFLINE */
  fabricate?: FabricateFn | null;
  generateJson?: FabricatorDeps['generateJson'];
  /** Gemini call used by check_bay and point_at (tests inject a fake) */
  call?: CallFn;
  /** registry answer to "is this sample in containment?" */
  inContainment?: (s: Sample) => boolean;
  /** containment bin centre, bay frame mm (shown by describe_bay) */
  containmentMm?: [number, number];
  signal?: AbortSignal;
}

let defaults: ToolContext = {};

/** App-wide tool wiring: the log sink, the fabricator, the containment predicate. */
export function configureTools(ctx: ToolContext): void {
  defaults = { ...defaults, ...defined(ctx) };
}

/** Drop undefined values so an unset field never overrides a configured one. */
function defined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

export const FABRICATOR_OFFLINE: ToolResult = {
  ok: false,
  code: 'FABRICATOR_OFFLINE',
  reason: 'The fabricator is not loaded, so I cannot make new samples yet.',
  suggestion: 'Use one of the samples already on the deck.',
};

/** A refusal for a moving or creating tool while the bay is stopped (or, for arm moves, idle), else null. */
export function gateRefusal(bay: BayApi, name: string): ToolResult | null {
  if (!MOVING_TOOLS.has(name)) return null;
  const state = bay.gate.state();
  if (state === 'ESTOPPED') {
    return { ok: false, code: 'BAY_ESTOPPED', bay_state: state, reason: 'Emergency stop is active. The arm is locked until the operator resets the bay.' };
  }
  if (state === 'STOPPED') {
    return { ok: false, code: 'BAY_STOPPED', bay_state: state, reason: 'The bay is stopped. The arm will not move until the operator resumes.' };
  }
  if (state === 'IDLE' && ARM_TOOLS.has(name)) {
    return {
      ok: false,
      code: 'BAY_IDLE',
      bay_state: state,
      reason: 'The bay is idle. The operator has to start the cycle first: show the Victory sign or press CYCLE START.',
    };
  }
  return null;
}

// ---- Registry views -------------------------------------------------------------------------

export interface SampleBrief {
  id: string;
  name: string;
  kind: Sample['kind'];
  color: string;
  grip_width_mm: number;
  height_mm: number;
  mass_g?: number;
  x_mm: number;
  y_mm: number;
  z_mm: number;
  held: boolean;
  created_by: Sample['createdBy'];
}

export function sampleBrief(s: Sample): SampleBrief {
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    color: s.color,
    grip_width_mm: Math.round(s.mesh?.graspWidthMm ?? s.dims.w * 1000),
    height_mm: Math.round(s.mesh?.heightMm ?? s.dims.h * 1000),
    ...(s.mesh ? { mass_g: Math.round(s.mesh.massG * 10) / 10 } : {}),
    x_mm: Math.round(s.pos[0] * 1000),
    y_mm: Math.round(s.pos[1] * 1000),
    z_mm: Math.round(s.pos[2] * 1000),
    held: s.held,
    created_by: s.createdBy,
  };
}

export function bayStatus(bay: BayApi): ToolResult {
  const arm = bay.arm.snapshot();
  return {
    ok: true,
    bay_state: bay.gate.state(),
    speed_factor: bay.gate.speedFactor(),
    arm_phase: arm.phase,
    arm_busy: arm.busy,
    holding: arm.heldId,
    sample_count: bay.samples.list().length,
  };
}

export function describeBay(bay: BayApi, containmentMm: [number, number] = [...BAY_FACTS.containmentMm]): ToolResult {
  const arm = bay.arm.snapshot();
  return {
    ok: true,
    bay_state: bay.gate.state(),
    speed_factor: bay.gate.speedFactor(),
    arm: {
      phase: arm.phase,
      busy: arm.busy,
      holding: arm.heldId,
      tcp_mm: arm.tcp.map((v) => Math.round(v * 1000)),
    },
    samples: bay.samples.list().map(sampleBrief),
    containment_mm: containmentMm,
    frame: BAY_FRAME_TEXT,
  };
}

// ---- Dispatcher -----------------------------------------------------------------------------

function str(a: Record<string, unknown>, k: string): string | undefined {
  const v = a[k];
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t : undefined;
}

function num(a: Record<string, unknown>, k: string): number | undefined {
  const v = a[k];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function badArgs(reason: string): ToolResult {
  return { ok: false, code: 'BAD_ARGS', reason };
}

/** A refusal as a tool result; the suggestion (for example the nearest free spot) passes through. */
function asRefusal(r: { code: string; reason: string; suggestion?: string }): ToolResult {
  return { ok: false, code: r.code, reason: r.reason, ...(r.suggestion ? { suggestion: r.suggestion } : {}) };
}

function fromMove(r: MoveResult, extra: Record<string, unknown> = {}): ToolResult {
  if (r.ok) return { ok: true, holding: r.held, tcp_mm: r.tcp_mm.map((v) => Math.round(v)), ...extra };
  return asRefusal(r);
}

const DIRECTIONS: ReadonlySet<string> = new Set(['left', 'right', 'front', 'behind']);
const SIDES: ReadonlySet<string> = new Set(['left', 'right', 'front', 'behind', 'center']);

/** The relative placement arguments design_sample and place_sample share. */
function relativePlacement(a: Record<string, unknown>): Placement {
  const p: Placement = {};
  const rel = str(a, 'relative_to');
  const dir = str(a, 'direction');
  const dist = num(a, 'distance_mm');
  if (rel) p.relative_to = rel;
  if (dir && DIRECTIONS.has(dir)) p.direction = dir as Placement['direction'];
  if (dist !== undefined) p.distance_mm = dist;
  return p;
}

/** true when the argument was given at all (null counts as left out) */
function given(a: Record<string, unknown>, k: string): boolean {
  return a[k] !== undefined && a[k] !== null;
}

/** A sample by id, or by a unique name match (models sometimes pass the name). */
function resolveSample(bay: BayApi, ref: string): Sample | undefined {
  const exact = bay.samples.get(ref);
  if (exact) return exact;
  const lower = ref.toLowerCase();
  const named = bay.samples.list().filter((s) => s.id.toLowerCase() === lower || s.name.toLowerCase() === lower);
  return named.length === 1 ? named[0] : undefined;
}

function noSuchSample(bay: BayApi, ref: string): ToolResult {
  const ids = bay.samples.list().map((x) => x.id);
  return { ok: false, code: 'NO_SAMPLE', reason: `There is no sample ${ref}.${ids.length ? ` Samples on deck: ${ids.join(', ')}.` : ' The deck is empty.'}` };
}

/** The sample a sample_id argument names (an id, a name, or a word only its name has); a refusal if none. */
function chosenSample(bay: BayApi, a: Record<string, unknown>): { sample?: Sample; refusal?: ToolResult } {
  const ref = str(a, 'sample_id');
  if (!ref) return {};
  const sample = resolveSample(bay, ref) ?? matchSample(bay.samples.list(), ref);
  return sample ? { sample } : { refusal: noSuchSample(bay, ref) };
}

/** How close (xy, mm) the gripper may be to the bin centre or to the sample a camera check is about. */
export const CAMERA_CLEAR_MM = 70;
/** A question or label about containment. */
const ABOUT_BIN = /\b(contain\w*|bin|tray)\b/i;

/**
 * Before a camera check: an open gripper parked over the bin or the sample looks, on camera, as if it
 * held the sample. When the bay is RUNNING and the arm is idle and empty, with its TCP within
 * CAMERA_CLEAR_MM (xy) of the bin centre (a question about containment) or of a sample in question,
 * move it home first. Never in another bay state and never while holding: then the result carries a
 * note that the gripper may hide the sample.
 */
async function clearCameraView(bay: BayApi, text: string, about: Sample[], c: ToolContext, source: ToolSource): Promise<string | undefined> {
  const arm = bay.arm.snapshot();
  const near = (x: number, y: number) => Math.hypot(arm.tcp[0] - x, arm.tcp[1] - y) * 1000 <= CAMERA_CLEAR_MM;
  const bin = c.containmentMm ?? BAY_FACTS.containmentMm;
  if (!(ABOUT_BIN.test(text) && near(bin[0] / 1000, bin[1] / 1000)) && !about.some((s) => near(s.pos[0], s.pos[1]))) return undefined;
  if (arm.heldId) {
    const held = bay.samples.get(arm.heldId);
    return `The gripper is holding ${held?.name ?? arm.heldId}, so it may hide the sample from the camera.`;
  }
  if (bay.gate.state() !== 'RUNNING' || arm.busy || atHome(arm.q)) return undefined;
  logTo(c.sink, 'gemini', `[${source}] moving the arm clear of the camera first`);
  await bay.arm.home();
  return undefined;
}

/** Already in the home pose (joints 0-4 within about a degree): its TCP is close to two seed slots, but it hides nothing. */
function atHome(q: number[]): boolean {
  return HOME_Q.slice(0, 5).every((h, j) => Math.abs((q[j] ?? Number.NaN) - h) < 0.02);
}

async function runTool(bay: BayApi, name: string, a: Record<string, unknown>, c: ToolContext, source: ToolSource): Promise<ToolResult> {
  switch (name) {
    case 'describe_bay':
      return describeBay(bay, c.containmentMm);
    case 'bay_status':
      return bayStatus(bay);
    case 'check_bay': {
      const question = str(a, 'question');
      if (!question) return badArgs('check_bay needs a question.');
      const { sample, refusal } = chosenSample(bay, a);
      if (refusal) return refusal;
      const q = question.slice(0, 300);
      const note = await clearCameraView(bay, q, sample ? [sample] : mentionedSamples(bay.samples.list(), q), c, source);
      const r = await verifyQuestion(bay, q, { call: c.call, inContainment: c.inContainment, signal: c.signal }, sample?.id);
      return { ...r, ...(note ? { note } : {}) };
    }
    case 'point_at': {
      const label = str(a, 'label');
      if (!label) return badArgs('point_at needs a label.');
      const { sample, refusal } = chosenSample(bay, a);
      if (refusal) return refusal;
      const l = label.slice(0, 120);
      const note = await clearCameraView(bay, l, sample ? [sample] : mentionedSamples(bay.samples.list(), l), c, source);
      const r = await pointAt(bay, l, { call: c.call, signal: c.signal }, sample?.id);
      return { ...r, ...(note ? { note } : {}) };
    }
  }

  const refused = gateRefusal(bay, name);
  if (refused) return refused;

  switch (name) {
    case 'pick_sample': {
      const ref = str(a, 'id');
      if (!ref) return badArgs('pick_sample needs a sample id.');
      const s = resolveSample(bay, ref);
      if (!s) return noSuchSample(bay, ref);
      return fromMove(await bay.arm.pick(s.id), { sample: s.id, name: s.name });
    }
    case 'place_sample': {
      const heldId = bay.arm.snapshot().heldId;
      if (given(a, 'x_mm') || given(a, 'y_mm')) {
        // an exact spot: the arm checks it; a refusal names the nearest free spot
        const x = num(a, 'x_mm');
        const y = num(a, 'y_mm');
        if (x === undefined || y === undefined) return badArgs('place_sample needs both x_mm and y_mm as numbers, or neither (then give side, or relative_to and direction).');
        const r = await bay.arm.placeAt([x / 1000, y / 1000]);
        return fromMove(r, { sample: heldId, placed_mm: [Math.round(x), Math.round(y)] });
      }
      const placement = relativePlacement(a);
      const side = str(a, 'side');
      if (side !== undefined && !SIDES.has(side)) return badArgs('side must be left, right, front, behind or center.');
      if (side) placement.side = side as Placement['side'];
      // a direction with nothing to be relative to means that side of the deck
      if (!placement.relative_to && !placement.side && placement.direction) {
        placement.side = placement.direction;
        delete placement.direction;
      }
      if (!heldId) return { ok: false, code: 'NOTHING_HELD', reason: 'The gripper is not holding anything to place.' };
      // code chooses the spot: free, reachable, spaced and clear of the bin
      const spot = bay.samples.findSpot(heldId, placement);
      if (!spot.ok) return asRefusal(spot);
      const r = await bay.arm.placeAt(spot.xy);
      return fromMove(r, { sample: heldId, placed_mm: [Math.round(spot.xy[0] * 1000), Math.round(spot.xy[1] * 1000)] });
    }
    case 'place_in_containment': {
      const heldId = bay.arm.snapshot().heldId;
      const r = await bay.arm.placeInContainment();
      const s = heldId ? bay.samples.get(heldId) : undefined;
      const registry = s && c.inContainment ? { in_containment: c.inContainment(s) } : {};
      return fromMove(r, { sample: heldId, ...registry });
    }
    case 'go_home':
      return fromMove(await bay.arm.home());
    case 'design_sample': {
      const description = str(a, 'description');
      if (!description) return badArgs('design_sample needs a description.');
      if (!c.fabricate) return { ...FABRICATOR_OFFLINE };
      const placement = relativePlacement(a);
      const x = num(a, 'x_mm');
      const y = num(a, 'y_mm');
      if (x !== undefined) placement.x_mm = x;
      if (y !== undefined) placement.y_mm = y;
      const r = await c.fabricate(
        bay,
        description.slice(0, 300),
        Object.keys(placement).length ? placement : undefined,
        { generateJson: c.generateJson ?? defaultGenerateJson },
        c.signal,
      );
      if (r.ok) return { ok: true, sample: sampleBrief(r.sample), say: r.say };
      return { ok: false, code: r.code, reason: r.reason, ...(r.suggestion ? { suggestion: r.suggestion } : {}) };
    }
    default:
      return { ok: false, code: 'UNKNOWN_TOOL', reason: `There is no tool called ${name}.` };
  }
}

/**
 * Run one tool call. Never throws: failures come back as { ok: false, code, reason }.
 * Logs the call and its result (kind 'gemini').
 */
export async function dispatchTool(
  bay: BayApi,
  name: string,
  args: Record<string, unknown> | undefined,
  source: ToolSource,
  ctx: ToolContext = {},
): Promise<ToolResult> {
  const c: ToolContext = { containmentMm: [...BAY_FACTS.containmentMm], inContainment: defaultInContainment, ...defined(defaults), ...defined(ctx) };
  const a = args && typeof args === 'object' ? args : {};
  logTo(c.sink, 'gemini', `[${source}] ${name}(${formatArgs(a)})`);
  let result: ToolResult;
  try {
    result = await runTool(bay, name, a, c, source);
  } catch (err) {
    result = { ok: false, code: 'TOOL_ERROR', reason: `${name} failed: ${errorText(err)}`.slice(0, 220) };
  }
  logTo(c.sink, 'gemini', `[${source}] ${name} -> ${summarizeResult(name, result)}`);
  return result;
}

export function formatArgs(a: Record<string, unknown>): string {
  return Object.entries(a)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v.length > 60 ? `${v.slice(0, 57)}...` : v) : JSON.stringify(v)}`)
    .join(', ');
}

/**
 * check_bay leads with the decision, then the camera: "yes (registry decides); camera says no: <observation>",
 * or "no (camera decides): <observation>" when only the camera could answer.
 */
function checkBaySummary(r: ToolResult): string {
  const answer = String(r.answer);
  const obs = String(r.observation ?? '').trim();
  const head =
    r.decided_by === 'code'
      ? `${r.ok ? 'yes' : 'no'} (registry decides); ${answer === 'unsure' ? 'camera is unsure' : `camera says ${answer}`}`
      : `${answer} (camera decides)`;
  return obs ? `${head}: ${obs}` : head;
}

/** text that ends in exactly one full stop (or the ? or ! it already has) */
export function sentence(s: string): string {
  const t = s.trim();
  return !t || /[.!?]$/.test(t) ? t : `${t}.`;
}

/** One short line for the log, the chat and the Live [BAY EVENT] messages (a camera check's note included). */
export function summarizeResult(name: string, r: ToolResult): string {
  const line = summaryLine(name, r);
  return (name === 'check_bay' || name === 'point_at') && typeof r.note === 'string' ? `${sentence(line)} ${r.note}` : line;
}

function summaryLine(name: string, r: ToolResult): string {
  if (!r.ok) {
    const reason = typeof r.reason === 'string' ? r.reason : 'refused';
    if (name === 'check_bay' && 'answer' in r) return checkBaySummary(r);
    if (name === 'point_at' && !('code' in r)) return `not found: ${reason}`;
    const tip = typeof r.suggestion === 'string' ? r.suggestion.trim() : '';
    if (tip) return `refused (${String(r.code ?? 'ERROR')}): ${sentence(reason)} ${sentence(tip[0].toUpperCase() + tip.slice(1))}`;
    return `refused (${String(r.code ?? 'ERROR')}): ${reason}`;
  }
  switch (name) {
    case 'describe_bay': {
      const n = Array.isArray(r.samples) ? r.samples.length : 0;
      return `${n} sample${n === 1 ? '' : 's'} on deck, bay ${String(r.bay_state)}`;
    }
    case 'bay_status':
      return `bay ${String(r.bay_state)}, arm ${String(r.arm_phase)}, holding ${String(r.holding ?? 'nothing')}`;
    case 'pick_sample':
      return `ok, holding ${String(r.holding ?? r.sample)}`;
    case 'place_sample': {
      const p = r.placed_mm as number[] | undefined;
      return `ok, ${String(r.sample ?? 'sample')} down at ${p ? `(${p[0]}, ${p[1]}) mm` : 'the target'}`;
    }
    case 'place_in_containment':
      return `ok, ${String(r.sample ?? 'sample')} released over containment${r.in_containment === false ? ' (registry: NOT inside)' : r.in_containment ? ' (registry: inside)' : ''}`;
    case 'go_home':
      return 'ok, arm at home';
    case 'design_sample': {
      const s = r.sample as SampleBrief | undefined;
      return s ? `ok, ${s.name} (${s.id}): grip ${s.grip_width_mm} mm, height ${s.height_mm} mm${s.mass_g !== undefined ? `, ${s.mass_g} g` : ''}` : 'ok';
    }
    case 'check_bay':
      return checkBaySummary(r);
    case 'point_at': {
      const m = r.match as { name: string; error_mm: number | null } | undefined;
      const p = r.bay_mm as number[] | null | undefined;
      const at = p ? `(${p[0]}, ${p[1]}) mm` : 'off the deck';
      return m ? `found at ${at}; ${m.name} is ${m.error_mm ?? '?'} mm from the registry` : `found at ${at}; no registry match`;
    }
    default:
      return 'ok';
  }
}
