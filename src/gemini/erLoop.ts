// ER agentic loop (PLAN.md §1.7): point → plan (function calling, mode ANY) → act → verify from a fresh frame → … → done.
// Code is the trust boundary: every tool call goes gate → CellApi (validator + IK + primitive). ER's opinion is
// measured and shown, never hidden. Node-safe (vitest + StubCell).

import type { Content, FunctionCall, FunctionDeclaration, Part } from '@google/genai/web';
import type { CellApi, CellState, FrameCapture, PrimResult, SceneObject } from '../contracts';
import { bus, fmtMs, fmtUsd } from '../telemetry/bus';
import { egress } from '../telemetry/egress';
import { callER } from './client';
import { imagePart, objectsForPrompt, pointAt, verifyStep, type PointResult } from './er';
import { DEMO } from './models';

export const ER_SYSTEM = `You control a 5-DOF SO-ARM100 arm in a simulated work cell through tools. You see the cell from a fixed front camera: image right is +x, objects nearer the camera have more negative y, z is up, units are millimetres. The tray (drop-off) is the square container at (-180, -130). The gripper is a two-finger pivoting jaw approaching from above; it closes to 8 mm and opens to about 95 mm; parts 15 to 45 mm wide are graspable.
The object list in the message is authoritative for ids, sizes and positions. Use the image to decide which object the task means, to sequence steps and to judge outcomes. Act one tool call at a time. After each tool you receive its result and a new frame. Tool results are authoritative for what happened: ok:true means the action succeeded and "held" tells you what is in the gripper; use the frame to judge the scene, but never undo a step that a tool result says succeeded. If a result has ok:false, read the reason and choose a different action or report failure. Never pick while something is held; place before picking another. To grasp a part use pick(object_id); do not descend with move_to. When the task is complete call done(true, summary). If it cannot be completed after two attempts call done(false, why). Never claim a result the frame does not show.`;

const T = { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER', BOOLEAN: 'BOOLEAN' } as const;
export const ER_TOOLS: FunctionDeclaration[] = [
  { name: 'pick', description: 'Grasp a part by registry id from above and lift it.', parameters: { type: T.OBJECT as never, properties: { object_id: { type: T.STRING as never } }, required: ['object_id'] } },
  { name: 'place_in_tray', description: 'Lower the held part into the tray and release it.' },
  { name: 'place_at', description: 'Lower the held part onto the table at x_mm, y_mm and release it.', parameters: { type: T.OBJECT as never, properties: { x_mm: { type: T.NUMBER as never }, y_mm: { type: T.NUMBER as never } }, required: ['x_mm', 'y_mm'] } },
  { name: 'move_to', description: 'Move the gripper to a point (mm) without changing the jaw.', parameters: { type: T.OBJECT as never, properties: { x_mm: { type: T.NUMBER as never }, y_mm: { type: T.NUMBER as never }, z_mm: { type: T.NUMBER as never } }, required: ['x_mm', 'y_mm', 'z_mm'] } },
  { name: 'open_gripper', description: 'Open the jaw (releases anything held).' },
  { name: 'close_gripper', description: 'Close the jaw; grasps a part if one is between the fingers.' },
  { name: 'home', description: 'Return the arm to its upright home pose.' },
  { name: 'done', description: 'Finish the task with a verdict and a one-sentence summary.', parameters: { type: T.OBJECT as never, properties: { success: { type: T.BOOLEAN as never }, summary: { type: T.STRING as never } }, required: ['success', 'summary'] } },
];

const HIGH_LEVEL = new Set(['pick', 'place_in_tray', 'place_at', 'home', 'done']);
/** Tools ER sees this task: high-level only in DEMO_MODE (G3 fix 2), else the full set. */
export const erToolsForDemo = (): FunctionDeclaration[] => (DEMO.highLevelOnly ? ER_TOOLS.filter((t) => HIGH_LEVEL.has(t.name!)) : ER_TOOLS);

export interface TaskStep { tool: string; args: Record<string, unknown>; ok: boolean; reason?: string; verify: { ok: boolean; observation: string } | null; latencyMs: number }
export interface TaskReport { ok: boolean; summary: string; steps: TaskStep[]; calls: number; costUsd: number; aborted?: boolean; code?: string }
export type TaskPhase = 'idle' | 'point' | 'plan' | 'act' | 'verify' | 'paused' | 'done';
export interface FrameView { jpegB64: string; points: { label: string; yx: [number, number]; truthYx: [number, number] | null; err: number | null; kind: 'point' | 'grasp' }[] }
export interface TaskState { active: boolean; text: string; phase: TaskPhase; step: number; of: number | null; steps: TaskStep[]; points: PointResult[]; frame: FrameView | null; report: TaskReport | null; calls: number; costUsd: number; lastModel: string }

const initial = (): TaskState => ({ active: false, text: '', phase: 'idle', step: 0, of: null, steps: [], points: [], frame: null, report: null, calls: 0, costUsd: 0, lastModel: '' });
let state: TaskState = initial();
const stateSubs = new Set<(s: TaskState) => void>();
function setState(patch: Partial<TaskState>): void { state = { ...state, ...patch }; for (const cb of stateSubs) cb(state); }
/** Observable task state for the Coworker pane (plan card, thumbnail, 5th telemetry cell). */
export const taskStore = {
  get: () => state,
  subscribe(cb: (s: TaskState) => void) { stateSubs.add(cb); return () => { stateSubs.delete(cb); }; },
  /** B7: orange grasp point on the "What Gemini sees" thumbnail (frame = the one the check saw, if provided). */
  addGraspPoint(label: string, yx: [number, number], worldMm: [number, number] | null, jpegB64?: string) {
    const frame: FrameView = state.frame && !jpegB64 ? { ...state.frame } : { jpegB64: jpegB64 ?? state.frame?.jpegB64 ?? '', points: [] };
    frame.points = [...frame.points.filter((p) => !(p.kind === 'grasp' && p.label === label)), { label: `grasp ${label}${worldMm ? ` (${worldMm[0]},${worldMm[1]})` : ''}`, yx, truthYx: null, err: null, kind: 'grasp' }];
    setState({ frame });
  },
  _reset() { state = initial(); },
};

/** [CELL EVENT] channel to the Live session (spoken). Only the §1.6 events are emitted here. */
const eventSubs = new Set<(text: string) => void>();
export const cellEvents = { emit(text: string) { for (const cb of eventSubs) cb(text); }, subscribe(cb: (text: string) => void) { eventSubs.add(cb); return () => { eventSubs.delete(cb); }; } };

// Single-task mutex.
let activeTask: { id: number; text: string; abort: AbortController } | null = null;
let nextTaskId = 1;
export const activeTaskInfo = () => (activeTask ? { id: activeTask.id, text: activeTask.text } : null);
export function cancelTask(reason = 'cancelled by the operator'): { ok: boolean; aborted: boolean } {
  if (!activeTask) return { ok: true, aborted: false };
  activeTask.abort.abort(new Error(reason));
  return { ok: true, aborted: true };
}

const expectationFor = (tool: string, name: string): string | null =>
  tool === 'pick' ? `the ${name} is lifted off the table between the gripper jaws`
  : tool === 'place_in_tray' ? `the ${name} rests inside the tray and the gripper is open above it`
  : tool === 'place_at' ? `the ${name} rests at the new spot, on the table or on top of the part beneath it, gripper open above it`
  : tool === 'home' ? 'the arm is upright and nothing is held' : null;

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || d);

async function dispatch(cell: CellApi, fc: FunctionCall): Promise<PrimResult> {
  const a = (fc.args ?? {}) as Record<string, unknown>;
  switch (fc.name) {
    case 'pick': return cell.arm.pick(String(a.object_id ?? ''));
    case 'place_in_tray': return cell.arm.placeInTray();
    case 'place_at': return cell.arm.placeAt([num(a.x_mm) / 1000, num(a.y_mm) / 1000]);
    case 'move_to': return cell.arm.moveTo([num(a.x_mm) / 1000, num(a.y_mm) / 1000, num(a.z_mm, 90) / 1000]);
    case 'open_gripper': return cell.arm.open();
    case 'close_gripper': return cell.arm.close();
    case 'home': return cell.arm.home();
    default: return { ok: false, code: 'NO_OBJECT', reason: `there is no tool called ${fc.name}` };
  }
}

const inTray = (o: SceneObject) => Math.abs(o.pos[0] + 0.18) < 0.037 && Math.abs(o.pos[1] + 0.13) < 0.037;

/** Code's own verdict on the outcome, from the registry (never from ER). */
function codeVerdict(cell: CellApi, tool: string, args: Record<string, unknown>, res: PrimResult, heldBefore: string | null): boolean {
  if (!res.ok) return false;
  const snap = cell.arm.snapshot();
  if (tool === 'pick') return snap.heldId === String(args.object_id);
  if (tool === 'place_in_tray') { const o = heldBefore ? cell.objects.get(heldBefore) : undefined; return !!o && !o.held && inTray(o) && snap.heldId === null; }
  if (tool === 'place_at') { const o = heldBefore ? cell.objects.get(heldBefore) : undefined; return !!o && !o.held && snap.heldId === null; }
  if (tool === 'home') return snap.heldId === null;
  return true;
}

function frameView(cell: CellApi, f: FrameCapture, pts: PointResult[]): FrameView {
  return { jpegB64: f.jpegB64, points: pts.map((p) => {
    const o = p.matched ? cell.objects.get(p.matched) : undefined;
    return { label: p.label, yx: p.image_point, truthYx: o ? cell.projectMujoco([o.pos[0], o.pos[1], o.pos[2] + o.dims.h / 2]) : null, err: p.error_mm, kind: 'point' as const };
  }) };
}

const sceneText = (cell: CellApi, pts: PointResult[], task: string) =>
  `Cell state: ${cell.gate.state()}. Objects (ids, sizes and positions are authoritative): ${JSON.stringify(objectsForPrompt(cell.objects.list()))}. ` +
  (pts.length ? `Your pointing localized: ${pts.map((p) => `${p.label} at (${p.world_mm?.[0] ?? '?'},${p.world_mm?.[1] ?? '?'}) mm${p.error_mm !== null ? `, error ${p.error_mm} mm vs registry` : ''}`).join('; ')}. ` : '') +
  `Tray at (-180,-130). Task: "${task}". Choose the first tool call.`;

class TaskAbort extends Error { constructor(msg: string, public code: 'ABORTED' | 'REJECTED_STATE' = 'ABORTED') { super(msg); } }

/** PAUSED/RESUMED trace + spoken events, once per stop, whether the STOP lands between steps or mid-motion. */
class PauseTracker {
  paused = false;
  private phaseBefore: TaskPhase = 'act';
  onStopped(): void {
    if (this.paused) return;
    this.paused = true; this.phaseBefore = state.phase;
    bus.emit({ kind: 'reject', text: 'PAUSED: cell STOPPED — waiting for thumbs-up' });
    setState({ phase: 'paused' });
    cellEvents.emit('cell stopped mid-task; waiting for the operator');
  }
  onRunnable(): void {
    if (!this.paused) return;
    this.paused = false;
    bus.emit({ kind: 'tool', text: 'RESUMED' });
    setState({ phase: this.phaseBefore === 'paused' ? 'act' : this.phaseBefore });
    cellEvents.emit('cell resumed; continuing the task');
  }
}

/** Gate wait before every primitive and ER call. Rejects with TaskAbort on ESTOP/abort. */
async function waitGate(cell: CellApi, signal: AbortSignal, pause: PauseTracker): Promise<void> {
  if (signal.aborted) throw new TaskAbort(String((signal.reason as Error)?.message ?? 'aborted'));
  const s = cell.gate.state();
  if (s === 'ESTOPPED') throw new TaskAbort('the cell is in emergency stop', 'REJECTED_STATE');
  if (s === 'IDLE') bus.emit({ kind: 'tool', text: 'TASK START — auto CYCLE START' });
  if (s === 'STOPPED') pause.onStopped();
  try { await cell.gate.waitRunnable(signal); }
  catch (e) { const code = (e as { code?: string })?.code; throw new TaskAbort(String((e as Error)?.message ?? e), code === 'REJECTED_STATE' ? 'REJECTED_STATE' : 'ABORTED'); }
  pause.onRunnable();
}

export interface RunOpts { signal?: AbortSignal; planLevel?: typeof DEMO.planLevel }

/** Run one manipulation task through the ER loop. Resolves with a report; never throws. */
export async function runTask(cell: CellApi, text: string, opts: RunOpts = {}): Promise<TaskReport> {
  if (activeTask) return { ok: false, summary: `a task is already running: "${activeTask.text}"; say cancel to stop it`, steps: [], calls: 0, costUsd: 0, code: 'BUSY' };
  const abort = new AbortController();
  const signal = abort.signal;
  opts.signal?.addEventListener('abort', () => abort.abort(opts.signal?.reason ?? new Error('aborted')), { once: true });
  activeTask = { id: nextTaskId++, text, abort };
  const pause = new PauseTracker();
  const offGate = cell.gate.onChange((s: CellState) => {
    if (!activeTask) return;
    if (s === 'ESTOPPED') { abort.abort(new TaskAbort('EMERGENCY STOP', 'REJECTED_STATE')); cellEvents.emit('emergency stop; the task was aborted'); }
    else if (s === 'STOPPED') pause.onStopped(); // mid-motion STOP: the motion promise is frozen by the controller; trace it now
    else if (s === 'RUNNING' || s === 'SLOW') pause.onRunnable();
  });
  const steps: TaskStep[] = [];
  let calls = 0, cost = 0, points: PointResult[] = [];
  const report0 = bus.totals();
  const tally = () => { const t = bus.totals(); calls = t.calls - report0.calls; cost = t.costUsd - report0.costUsd; setState({ calls, costUsd: cost }); };
  setState({ ...initial(), active: true, text, phase: 'point' });
  bus.emit({ kind: 'tool', text: `TASK ▶ "${text}"` });
  const finish = (r: Omit<TaskReport, 'steps' | 'calls' | 'costUsd'>): TaskReport => {
    tally();
    const rep: TaskReport = { ...r, steps, calls, costUsd: cost };
    bus.emit({ kind: rep.ok ? 'gemini' : 'reject', text: `ER done ${rep.ok ? '✓' : '✗'} "${rep.summary}"  ${calls} calls  ${fmtUsd(cost)}` });
    cellEvents.emit(rep.ok ? `task finished: ${rep.summary}` : `task failed: ${rep.summary}`);
    setState({ active: false, phase: 'done', report: rep });
    offGate(); activeTask = null;
    return rep;
  };
  try {
    await waitGate(cell, signal, pause);
    // 1. localize every object (ground truth stays in the registry; the error is displayed)
    const f0 = cell.capture();
    const names = cell.objects.list().map((o) => o.name);
    if (names.length) {
      try { points = await pointAt(cell, f0, names, DEMO.consensusN, signal); }
      catch (e) { if (signal.aborted) throw new TaskAbort('aborted'); bus.emit({ kind: 'reject', text: `ER point failed: ${(e as Error).message} — continuing on registry positions` }); }
    }
    setState({ points, frame: frameView(cell, f0, points), phase: 'plan' });
    tally();
    // 2. plan
    const history: Content[] = [{ role: 'user', parts: [imagePart(f0), { text: sceneText(cell, points, text) }] }];
    egress.bumpCellFrames();
    const failures = new Map<string, number>();
    for (let iter = 0; iter < DEMO.maxIterations; iter++) {
      if (calls >= DEMO.maxCalls) return finish({ ok: false, summary: `stopped after ${calls} model calls`, code: 'CAP' });
      if (cost >= DEMO.maxCostUsd) return finish({ ok: false, summary: `stopped at ${fmtUsd(cost)}`, code: 'CAP' });
      await waitGate(cell, signal, pause);
      const first = iter === 0;
      setState({ phase: first ? 'plan' : 'act', step: steps.length, lastModel: 'ER' });
      const level = first ? (opts.planLevel ?? DEMO.planLevel) : 'LOW';
      const r = await callER({ purpose: first ? 'plan' : 'act', level, contents: history, signal, includeThoughts: first,
        config: { systemInstruction: ER_SYSTEM, tools: [{ functionDeclarations: erToolsForDemo() }], toolConfig: { functionCallingConfig: { mode: (first ? 'ANY' : 'AUTO') as never } }, temperature: 0 } });
      tally();
      const content = r.res.candidates?.[0]?.content;
      const fcs = (r.res.functionCalls ?? []).filter((fc): fc is FunctionCall & { name: string } => !!fc.name);
      if (first) {
        // The planner narrates: thought summaries (thought: true parts) become a trace line and one spoken cell event.
        const thought = (content?.parts ?? []).filter((p) => (p as { thought?: boolean }).thought && p.text).map((p) => String(p.text).trim()).join(' ').replace(/\s+/g, ' ');
        if (thought) {
          bus.emit({ kind: 'gemini', text: `ER thinks: ${thought.slice(0, 280)}${thought.length > 280 ? '…' : ''}` });
          const firstSentence = thought.split(/(?<=[.!?])\s/)[0].slice(0, 160);
          cellEvents.emit(`planner: ${firstSentence}`);
        }
      }
      bus.emit({ kind: 'gemini', text: `ER ${first ? 'plan' : 'act'} ${level} ${fmtMs(r.latencyMs)}  ${r.entry.promptTokens}/${r.entry.outputTokens}/${r.entry.thoughtTokens} tok  ${fmtUsd(r.entry.costUsd)}${fcs.length ? '  → ' + fcs.map((f) => `${f.name}(${Object.values(f.args ?? {}).join(',')})`).join(', ') : ''}` });
      if (!fcs.length) return finish({ ok: false, summary: r.text || 'the planner returned no action', code: 'NO_ACTION' });
      history.push(content ?? { role: 'model', parts: fcs.map((fc) => ({ functionCall: fc })) }); // verbatim: keeps thoughtSignature parts
      const responseParts: Part[] = [];
      const frameParts: Part[] = [];
      for (const fc of fcs) {
        const args = (fc.args ?? {}) as Record<string, unknown>;
        if (fc.name === 'done') {
          const ok = args.success === true || String(args.success) === 'true';
          return finish({ ok, summary: String(args.summary ?? (ok ? 'done' : 'failed')) });
        }
        await waitGate(cell, signal, pause);
        setState({ phase: 'act', step: steps.length + 1 });
        const heldBefore = cell.arm.snapshot().heldId;
        const objName = fc.name === 'pick' ? (cell.objects.get(String(args.object_id))?.name ?? String(args.object_id)) : (heldBefore ? cell.objects.get(heldBefore)?.name ?? heldBefore : 'part');
        const t0 = performance.now();
        const res = await dispatch(cell, fc);
        const latencyMs = Math.round(performance.now() - t0);
        if (!res.ok && res.code === 'ABORTED') throw new TaskAbort(res.reason);
        const ok = codeVerdict(cell, fc.name, args, res, heldBefore);
        const stepText = `${fc.name}(${Object.entries(args).map(([k, v]) => `${k}=${v}`).join(', ')})`;
        bus.emit({ kind: res.ok ? 'tool' : 'reject', text: res.ok ? `TOOL ${stepText} → ok${res.held ? ` held ${res.held}` : ''}  tcp (${res.tcp_mm.join(',')}) mm` : `TOOL ${stepText} → ${res.code} ${res.reason}` });
        const key = `${fc.name}:${JSON.stringify(args)}`;
        if (!res.ok) { const n = (failures.get(key) ?? 0) + 1; failures.set(key, n); if (n >= DEMO.maxIdenticalFailures) return finish({ ok: false, summary: `${stepText} failed ${n} times: ${res.reason}`, code: 'REPEAT' }); }
        // fresh frame + verification (never on a frozen frame: gate first)
        await waitGate(cell, signal, pause);
        const f = cell.capture();
        egress.bumpCellFrames();
        const expectation = res.ok ? expectationFor(fc.name, objName) : null;
        let verify: TaskStep['verify'] = null;
        if (expectation) {
          setState({ phase: 'verify' });
          try { const v = await verifyStep(cell, f, stepText, expectation, signal); verify = { ok: v.ok, observation: v.observation }; }
          catch (e) { if (signal.aborted) throw new TaskAbort('aborted'); verify = { ok: ok, observation: `verify unavailable: ${(e as Error).message.slice(0, 80)}` }; }
          if (verify.ok !== ok) bus.emit({ kind: 'reject', text: `DISAGREE code=${ok} ER=${verify.ok} "${verify.observation}"` });
          tally();
        }
        const step: TaskStep = { tool: fc.name, args, ok, reason: res.ok ? undefined : res.reason, verify, latencyMs };
        steps.push(step);
        setState({ steps: [...steps], frame: { jpegB64: f.jpegB64, points: state.frame?.points ?? [] } });
        const response: Record<string, unknown> = res.ok ? { ok, tcp_mm: res.tcp_mm, held: res.held, phase: res.phase } : { ok: false, code: res.code, reason: res.reason };
        // The registry is ground truth in this kinematic cell. When ER's frame reading disagrees with a
        // tool result, the disagreement stays visible (DISAGREE line, plan card) but ER is told which is
        // authoritative, so a false-negative check cannot send it into an undo/redo loop.
        if (verify) response.verify = verify.ok === ok ? verify : { ...verify, note: ok ? 'the cell registry (authoritative) confirms this action succeeded; treat your frame reading as advisory and continue the task' : 'the tool reported failure; trust the tool result' };
        const img = { inlineData: { mimeType: 'image/jpeg', data: f.jpegB64 } };
        if (DEMO.fcShape === 'A') responseParts.push({ functionResponse: { id: fc.id, name: fc.name, response, parts: [img] } } as Part);
        else { responseParts.push({ functionResponse: { id: fc.id, name: fc.name, response } }); frameParts.length = 0; frameParts.push(img, { text: 'Frame after executing the above.' }); }
      }
      history.push({ role: 'user', parts: responseParts });
      if (frameParts.length) history.push({ role: 'user', parts: frameParts });
    }
    return finish({ ok: false, summary: `stopped after ${DEMO.maxIterations} planning rounds`, code: 'CAP' });
  } catch (e) {
    const sr = signal.reason as unknown;
    const ta = sr instanceof TaskAbort ? sr : e instanceof TaskAbort ? e : new TaskAbort(String((e as Error)?.message ?? e));
    const reason = signal.aborted ? String((sr as Error)?.message ?? ta.message) : ta.message;
    bus.emit({ kind: 'reject', text: `ABORTED: ${reason}` });
    if (signal.aborted || ta.code === 'REJECTED_STATE') cell.arm.abortAll(reason);
    return finish({ ok: false, summary: reason, aborted: true, code: ta.code });
  }
}
