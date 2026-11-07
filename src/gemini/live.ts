// Gemini Live voice session (PLAN.md §1.6): hold-to-talk audio in, 24 kHz audio out, tool calls through the
// code gate, [CELL EVENT] pushes from the ER loop. Module singleton; connect only from the Connect click.

import { Behavior, GoogleGenAI, Modality, Type } from '@google/genai/web';
import type { FunctionDeclaration, LiveServerMessage, Session } from '@google/genai/web';
import type { CellApi, ObjectSpec } from '../contracts';
import type { VoiceApi, VoiceStatus } from '../components/CoworkerPane';
import { bus } from '../telemetry/bus';
import { egress } from '../telemetry/egress';
import { graspCheck, objectsForPrompt, pointAt } from './er';
import { generatePartImage } from './imagegen';
import { activeTaskInfo, cancelTask, cellEvents, runTask, taskStore } from './erLoop';
import { MicCapture, Playback } from './liveAudio';
import { LIVE_MODEL } from './models';

export const LIVE_TOOLS: FunctionDeclaration[] = [
  { name: 'run_task', behavior: Behavior.NON_BLOCKING,
    description: 'Hand a manipulation task to the cell vision planner (Gemini Robotics-ER), which sees the cell camera, plans, moves the arm and verifies each step. Returns started immediately; the result arrives later as a [CELL EVENT].',
    parameters: { type: Type.OBJECT, properties: { task: { type: Type.STRING, description: 'Plain-language task, e.g. "put the red block in the tray"' } }, required: ['task'] } },
  { name: 'create_object',
    description: 'Add a test part to the table. Sizes in mm. Position: x_mm/y_mm, or relative_to (object id, "tray", "arm") + direction + distance_mm. Code validates size and reach and returns a reason and a suggestion if rejected; propose the suggestion to the operator.',
    parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, color: { type: Type.STRING }, shape: { type: Type.STRING, enum: ['box', 'cylinder', 'sphere'] },
      width_mm: { type: Type.NUMBER }, depth_mm: { type: Type.NUMBER }, height_mm: { type: Type.NUMBER }, x_mm: { type: Type.NUMBER }, y_mm: { type: Type.NUMBER },
      relative_to: { type: Type.STRING }, direction: { type: Type.STRING, enum: ['left', 'right', 'front', 'behind'] }, distance_mm: { type: Type.NUMBER } },
      required: ['color', 'shape', 'width_mm', 'height_mm'] } },
  { name: 'point_at', description: 'Ask the vision model to locate a part by name in the cell camera image; returns where it is and the localization error against the cell registry in mm.',
    parameters: { type: Type.OBJECT, properties: { label: { type: Type.STRING } }, required: ['label'] } },
  { name: 'remove_object', description: 'Remove a part from the table by id.', parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING } }, required: ['id'] } },
  { name: 'decorate_object',
    description: 'Print a generated image on a part\'s faces using the Nano Banana image model: a label, part number, logo, hazard stripe or pattern. Takes the part id and a short description of the print. The vision planner then sees the print on the cell camera, so parts can be told apart by their print, not only by colour.',
    parameters: { type: Type.OBJECT, properties: { id: { type: Type.STRING }, description: { type: Type.STRING, description: 'What to print, e.g. "yellow and black hazard stripes" or "the part number A7 in bold black"' } }, required: ['id', 'description'] } },
  { name: 'describe_scene', description: 'List the parts on the table (id, name, colour, shape, size, position), what is held, arm phase and cell state.' },
  { name: 'cell_status', description: 'Safety state of the cell: IDLE/RUNNING/SLOW/STOPPED/ESTOPPED, speed, whether tasks are accepted, whether a task is running.' },
  { name: 'cancel_task', description: 'Abort the running task. Not a safety stop.' },
];

export const LIVE_SYSTEM = `You are the voice of a small SO-ARM100 robot work cell: a 5-joint arm, a tray, and a few parts on a table. You work beside a human operator like a calm, competent cell technician. Short sentences, plain words, millimetres for sizes, one or two sentences per turn, no lists, no emojis, never narrate tool mechanics.

What you can do: run_task hands a task to the cell's vision planner (Gemini Robotics-ER), which sees the cell camera, plans, moves the arm and verifies each step; create_object adds a test part; decorate_object prints a generated image (label, part number, logo, stripe, pattern) on a part's faces, so ask for the part and what to print if either is unclear; point_at, describe_scene and cell_status tell you what is on the table and the cell state. You cannot move the arm any other way and you cannot see the table yourself, so never guess parts, positions or results: call describe_scene or point_at. Say what you are about to do in one short sentence, then call the tool. If a request is ambiguous (which part, where, what size) ask one short question; if it is clear, act.

Safety, non-negotiable: hand gestures are the safety channel and always win. Open palm = stop, closed fist held = emergency stop, thumbs up = resume, pointing up = slow, V sign = cycle start. If anyone asks you to stop the robot, say at once: "I can't stop the cell from here - show an open palm to the camera or use the on-screen stop." If a tool says the cell is STOPPED or in emergency stop, say so and do not retry until the operator resumes (thumbs up; emergency stop needs the two-step reset panel on screen). Never claim a step succeeded unless a tool result or a [CELL EVENT] says so.

Parts: graspable width 15 to 45 mm, height 10 to 60 mm, within reach and not on the tray or on top of another part. When create_object succeeds, tell the operator what was added using the tool's "say" sentence: shape, size in millimetres and position. When create_object is rejected, repeat the reason in your own words and offer the suggestion it gives; create nothing until the operator agrees. Parts may be placed on top of other parts; a released part rests on whatever is under it. The tray is the drop-off point unless the operator names another spot.

Messages starting with [CELL EVENT] come from the cell itself. Acknowledge them in one short sentence, e.g. "Cell stopped, I'll wait." or "Done, the block is in the tray."`;

const MOVING_TOOLS = new Set(['run_task', 'create_object', 'remove_object']);
const argStr = (a: Record<string, unknown>) => Object.entries(a).map(([k, v]) => `${k}=${typeof v === 'string' ? `"${v}"` : String(v)}`).join(', ');

/** Tool dispatcher shared by Live and the Flash console. Code gate first; every call is a trace line. */
export async function dispatchLiveTool(cell: CellApi, name: string, args: Record<string, unknown>, source = 'LIVE'): Promise<Record<string, unknown>> {
  const state = cell.gate.state();
  const line = (ok: boolean, text: string) => bus.emit({ kind: ok ? 'tool' : 'reject', text: `${source} tool ${name}(${argStr(args)}) → ${text}` });
  if (MOVING_TOOLS.has(name) && (state === 'STOPPED' || state === 'ESTOPPED')) {
    const reason = state === 'STOPPED' ? 'the cell is STOPPED by the operator; motion is locked until a thumbs-up resumes it' : 'the cell is in emergency stop; it needs the two-step reset panel on screen';
    line(false, `REJECTED_STATE ${state}`);
    return { ok: false, code: 'REJECTED_STATE', reason };
  }
  switch (name) {
    case 'run_task': {
      const text = String(args.task ?? '').trim();
      if (!text) { line(false, 'no task text'); return { ok: false, code: 'NO_TASK', reason: 'I did not get a task to run' }; }
      const active = activeTaskInfo();
      if (active) { line(false, 'BUSY'); return { ok: false, code: 'BUSY', reason: `a task is already running: "${active.text}"; say cancel to stop it` }; }
      line(true, 'started');
      void runTask(cell, text);
      return { ok: true, status: 'started', scheduling: 'SILENT' };
    }
    case 'create_object': {
      const r = cell.objects.create(args as unknown as ObjectSpec);
      if (!r.ok) { line(false, `${r.code} ${r.reason}`); return { ok: false, code: r.code, reason: r.reason, suggestion: r.suggestion }; }
      const o = r.obj;
      line(true, `ok ${o.id} at (${Math.round(o.pos[0] * 1000)},${Math.round(o.pos[1] * 1000)})`);
      const w = Math.round(o.dims.w * 1000), d = Math.round(o.dims.d * 1000), h = Math.round(o.dims.h * 1000);
      const size = o.shape === 'sphere' ? `${w} mm diameter` : o.shape === 'cylinder' ? `${w} mm across and ${h} mm tall` : `${w} by ${d} by ${h} mm`;
      const out: Record<string, unknown> = { ok: true, object_id: o.id, name: o.name, shape: o.shape, color: o.color, x_mm: Math.round(o.pos[0] * 1000), y_mm: Math.round(o.pos[1] * 1000), width_mm: w, depth_mm: d, height_mm: h,
        say: `Added a ${o.color} ${o.shape}, ${size}, at x ${Math.round(o.pos[0] * 1000)}, y ${Math.round(o.pos[1] * 1000)} mm.` };
      // B7: ER grasp-feasibility check (MEDIUM) on the fresh frame. Creation never waits on the verdict beyond 8 s and never depends on it.
      try {
        const f = cell.capture();
        const g = await Promise.race([graspCheck(cell, f, o), new Promise<null>((res) => setTimeout(() => res(null), 8000))]);
        if (g) { out.graspable = g.graspable; out.grasp_reason = g.reason; taskStore.addGraspPoint(o.name, g.grasp_point, g.world_mm, f.jpegB64); }
      } catch (e) { bus.emit({ kind: 'reject', text: `ER grasp check skipped: ${String((e as Error).message).slice(0, 80)}` }); }
      return out;
    }
    case 'decorate_object': {
      const id = String(args.id ?? '').trim();
      const desc = String(args.description ?? '').trim();
      const o = cell.objects.get(id) ?? cell.objects.list().find((x) => x.name === id);
      if (!o) { line(false, `NO_OBJECT ${id}`); return { ok: false, code: 'NO_OBJECT', reason: `there is no part called ${id}; ask describe_scene for the ids` }; }
      if (!desc) { line(false, 'no description'); return { ok: false, code: 'NO_DESCRIPTION', reason: 'I need to know what to print' }; }
      if (!cell.objects.setTexture) { line(false, 'UNSUPPORTED'); return { ok: false, code: 'UNSUPPORTED', reason: 'this cell cannot print on parts' }; }
      try {
        const img = await generatePartImage(`${desc}, on a ${o.color} background`);
        cell.objects.setTexture(o.id, img.dataUrl);
        line(true, `printed on ${o.id} in ${(img.latencyMs / 1000).toFixed(1)} s`);
        return { ok: true, object_id: o.id, latency_ms: img.latencyMs, note: 'the print is on the part and visible to the vision planner on the cell camera' };
      } catch (e) {
        const msg = String((e as Error).message).slice(0, 120);
        line(false, `IMAGE_FAILED ${msg}`);
        return { ok: false, code: 'IMAGE_FAILED', reason: `the image model did not return a print: ${msg}` };
      }
    }
    case 'point_at': {
      const label = String(args.label ?? '');
      try {
        const f = cell.capture();
        const pts = await pointAt(cell, f, [label]);
        const p = pts[0];
        if (!p) { line(false, 'not found'); return { ok: false, reason: `I could not find ${label} in the camera image` }; }
        line(true, `[${p.image_point}] ${p.matched ?? '?'} err ${p.error_mm ?? '?'} mm`);
        return { ok: true, image_point: p.image_point, world_mm: p.world_mm, matched: p.matched, error_mm: p.error_mm, latency_ms: p.latencyMs };
      } catch (e) { line(false, String((e as Error).message)); return { ok: false, reason: 'the vision model did not answer' }; }
    }
    case 'remove_object': {
      const id = String(args.id ?? '');
      const ok = cell.objects.remove(id);
      line(ok, ok ? 'ok' : 'NO_OBJECT');
      return ok ? { ok: true } : { ok: false, code: 'NO_OBJECT', reason: `there is no part called ${id}` };
    }
    case 'describe_scene': {
      const snap = cell.arm.snapshot();
      const t = taskStore.get();
      line(true, `${cell.objects.list().length} objects`);
      return { cell_state: state, objects: objectsForPrompt(cell.objects.list()), arm: { phase: snap.phase, tcp_mm: snap.tcp.map((v) => Math.round(v * 1000)), jaw_open: snap.jawOpen, held: snap.heldId },
        task: { active: t.active, text: t.active ? t.text : null, step: t.step, of: t.of } };
    }
    case 'cell_status': {
      const active = !!activeTaskInfo();
      line(true, state);
      return { state, speed_pct: state === 'RUNNING' || state === 'IDLE' ? 100 : state === 'SLOW' ? 50 : 0, accepts_tasks: state !== 'STOPPED' && state !== 'ESTOPPED' && !active, task_active: active, task_text: activeTaskInfo()?.text ?? null };
    }
    case 'cancel_task': { const r = cancelTask(); line(true, r.aborted ? 'aborted' : 'nothing running'); return r; }
    default: line(false, 'unknown tool'); return { ok: false, reason: `unknown tool ${name}` };
  }
}

class Voice implements VoiceApi {
  private st: VoiceStatus = 'off';
  private subs = new Set<(s: VoiceStatus) => void>();
  private session: Session | null = null;
  private mic: MicCapture | null = null;
  private playback: Playback | null = null;
  private pending = new Map<string, string>();
  private inText = '';
  private outText = '';
  private offEvents: (() => void) | null = null;
  private reduced = false;
  constructor(public cell: CellApi) {}

  status(): VoiceStatus { return this.st; }
  subscribe(cb: (s: VoiceStatus) => void): () => void { this.subs.add(cb); return () => { this.subs.delete(cb); }; }
  private set(s: VoiceStatus): void { if (this.st !== s) { this.st = s; for (const cb of this.subs) cb(s); } }

  async connect(): Promise<void> {
    if (this.session) return;
    this.set('connecting');
    try {
      // Both audio contexts in the click handler (autoplay policy).
      this.playback ??= new Playback();
      await this.playback.resume();
      if (!this.mic) {
        try { this.mic = await MicCapture.create((b64) => { if (this.session && this.mic?.isHeld()) this.session.sendRealtimeInput({ audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } }); }); }
        catch (e) { bus.emit({ kind: 'reject', text: `LIVE mic unavailable (${String((e as Error)?.message ?? e).slice(0, 80)}) — typed text to the voice session only` }); }
      }
      await this.open();
    } catch (e) {
      bus.emit({ kind: 'reject', text: `LIVE connect failed: ${String((e as Error)?.message ?? e).slice(0, 160)}` });
      this.set('error');
    }
  }

  private config() {
    const base: Record<string, unknown> = {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
      systemInstruction: LIVE_SYSTEM,
      tools: [{ functionDeclarations: LIVE_TOOLS }],
      inputAudioTranscription: {}, outputAudioTranscription: {},
      temperature: 0.6,
    };
    if (!this.reduced) {
      base.realtimeInputConfig = { automaticActivityDetection: { disabled: true } }; // hold-to-talk, no room-noise turns
      base.contextWindowCompression = { slidingWindow: {} }; // audio-only cap is 15 min otherwise
    }
    return base;
  }

  private async open(): Promise<void> {
    const key = import.meta.env.VITE_GEMINI_API_KEY as string | undefined;
    if (!key) throw new Error('VITE_GEMINI_API_KEY missing');
    const ai = new GoogleGenAI({ apiKey: key });
    let gotMessage = false;
    const t0 = performance.now();
    const session = await ai.live.connect({ model: LIVE_MODEL, config: this.config() as never, callbacks: {
      onopen: () => { bus.emit({ kind: 'live', text: `LIVE connected ${LIVE_MODEL}${this.reduced ? ' (reduced config)' : ''}` }); },
      onmessage: (m) => { gotMessage = true; this.onMessage(m); },
      onerror: (e) => { bus.emit({ kind: 'reject', text: `LIVE error ${(e as ErrorEvent)?.message ?? ''}` }); },
      onclose: (e) => {
        const early = performance.now() - t0 < 4000 && !gotMessage;
        bus.emit({ kind: early || (e?.code && e.code !== 1000) ? 'reject' : 'live', text: `LIVE closed ${e?.code ?? ''} ${e?.reason ?? ''}`.trim() });
        this.teardownSession();
        if (early && e?.code && e.code !== 1000 && !this.reduced) {
          this.reduced = true;
          bus.fallback('LIVE-REDUCED-CONFIG', `setup rejected (${e.code} ${e.reason ?? ''}); retrying without activity-detection/compression options`);
          void this.open().catch(() => this.set('error'));
        } else this.set(early ? 'error' : 'off');
      },
    } });
    this.session = session;
    egress.setLive(true);
    this.offEvents?.();
    this.offEvents = cellEvents.subscribe((text) => {
      if (!this.session) return;
      bus.emit({ kind: 'live', text: `CELL EVENT ▶ ${text}` });
      this.session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: `[CELL EVENT] ${text}` }] }], turnComplete: true });
    });
    this.set('ready');
  }

  private teardownSession(): void {
    this.session = null; this.pending.clear();
    this.offEvents?.(); this.offEvents = null;
    this.mic?.setHeld(false); egress.setMic(false); egress.setLive(false);
    this.playback?.stop();
  }

  disconnect(): void {
    const s = this.session;
    this.teardownSession();
    try { s?.close(); } catch { /* closed */ }
    this.mic?.close(); this.mic = null;
    this.set('off');
  }

  hasMic(): boolean { return !!this.mic; }

  /** Typed text into the voice session (no-mic fallback; same tools, same spoken reply). */
  sendText(text: string): void {
    if (!this.session) return;
    this.playback?.stop();
    bus.emit({ kind: 'live', text: `YOU ▶ "${text}" (typed)` });
    this.session.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true });
  }

  setTalk(held: boolean): void {
    if (!this.session || !this.mic) return;
    if (held) {
      this.playback?.stop(); // barge-in locally; the server sends interrupted for its side
      this.session.sendRealtimeInput({ activityStart: {} });
      this.mic.setHeld(true); egress.setMic(true); this.set('listening');
    } else {
      this.mic.setHeld(false); egress.setMic(false);
      this.session.sendRealtimeInput({ activityEnd: {} });
      this.session.sendRealtimeInput({ audioStreamEnd: true });
      this.set('ready');
    }
  }

  private onMessage(m: LiveServerMessage): void {
    const sc = m.serverContent;
    if (sc?.interrupted) { this.playback?.stop(); bus.emit({ kind: 'live', text: 'LIVE interrupted' }); }
    for (const p of sc?.modelTurn?.parts ?? []) if (p.inlineData?.data) { this.playback?.play(p.inlineData.data); if (this.st === 'ready') this.set('speaking'); }
    if (sc?.inputTranscription?.text) this.inText += sc.inputTranscription.text;
    if (sc?.outputTranscription?.text) this.outText += sc.outputTranscription.text;
    if (sc?.turnComplete) {
      if (this.inText.trim()) bus.emit({ kind: 'live', text: `YOU ▶ "${this.inText.trim()}"` });
      if (this.outText.trim()) bus.emit({ kind: 'live', text: `LIVE ◀ ${this.outText.trim()}` });
      this.inText = ''; this.outText = '';
      if (this.playback) { this.playback.onIdle = () => { if (this.st === 'speaking') this.set('ready'); }; if (!this.playback.speaking && this.st === 'speaking') this.set('ready'); }
    }
    if (m.toolCall?.functionCalls) {
      for (const fc of m.toolCall.functionCalls) {
        if (!fc.name) continue;
        const id = fc.id ?? `${fc.name}-${Date.now()}`;
        this.pending.set(id, fc.name);
        void dispatchLiveTool(this.cell, fc.name, (fc.args ?? {}) as Record<string, unknown>).then((response) => {
          if (!this.session || !this.pending.has(id)) return; // cancelled or gone
          this.pending.delete(id);
          this.session.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response }] });
        });
      }
    }
    if (m.toolCallCancellation?.ids) {
      // Only ids still unanswered are dropped. run_task is answered at once, so barge-in never kills the arm task.
      for (const id of m.toolCallCancellation.ids) if (this.pending.delete(id)) bus.emit({ kind: 'live', text: `LIVE cancelled tool ${id}` });
    }
    if (m.goAway) { bus.emit({ kind: 'reject', text: `LIVE goAway in ${m.goAway.timeLeft ?? '?'}` }); this.set('ending'); }
  }
}

let voice: Voice | null = null;
/** Module singleton (StrictMode-safe). The cell reference is refreshed on every call. */
export function getVoice(cell: CellApi): VoiceApi {
  if (!voice) voice = new Voice(cell); else voice.cell = cell;
  return voice;
}
