// StubCell: a CellApi that needs no three.js scene. Fake motion (delayMs), plain registry, static JPEG,
// pinhole camera math matching the real cell camera, and gate.setState() for tests and the B dev server.
// Node-safe: only three math classes are imported.

import { PerspectiveCamera, Vector3 } from 'three';
import type { ArmApi, ArmSnapshot, CellApi, CellGateApi, CellState, CreateResult, FrameCapture, ObjectSpec, ObjectsApi, PrimResult, SceneObject, Vec3 } from '../contracts';

const HOME_Q = [0, -1.57, 1.57, 1.57, -1.57];
const TRAY: Vec3 = [-0.18, -0.13, 0];
const HOVER_Z = 0.075, LIFT_Z = 0.09;

/** 1x1 grey JPEG. The stub declares 768x768; the real cell renders a real frame. */
export const STUB_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

/** MuJoCo root (x, y, z) → three world (x, z, −y). */
const toThree = (p: Vec3) => new Vector3(p[0], p[2], -p[1]);

/** The fixed cell camera: MuJoCo (0,−0.60,0.42) looking at (−0.04,−0.18,0), fov 45, square. */
export function makeCellCamera(): PerspectiveCamera {
  const cam = new PerspectiveCamera(45, 1, 0.05, 5);
  cam.position.copy(toThree([0, -0.6, 0.42]));
  cam.up.set(0, 1, 0);
  cam.lookAt(toThree([-0.04, -0.18, 0]));
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

export function projectWith(cam: PerspectiveCamera, p: Vec3): [number, number] {
  const v = toThree(p).project(cam);
  return [Math.round((1 - v.y) * 500), Math.round((v.x + 1) * 500)];
}

export function unprojectWith(cam: PerspectiveCamera, yx: [number, number], zPlane: number): Vec3 | null {
  const ndc = new Vector3(yx[1] / 500 - 1, 1 - yx[0] / 500, 0.5).unproject(cam);
  const origin = cam.position.clone();
  const dir = ndc.sub(origin).normalize();
  if (Math.abs(dir.y) < 1e-6) return null;
  const t = (zPlane - origin.y) / dir.y;
  if (t <= 0) return null;
  const hit = origin.add(dir.multiplyScalar(t));
  return [hit.x, -hit.z, hit.y];
}

class StubGate implements CellGateApi {
  private s: CellState = 'IDLE';
  private cbs = new Set<(s: CellState) => void>();
  state(): CellState { return this.s; }
  setState(s: CellState): void { if (s === this.s) return; this.s = s; for (const cb of this.cbs) cb(s); }
  onChange(cb: (s: CellState) => void): () => void { this.cbs.add(cb); return () => { this.cbs.delete(cb); }; }
  waitRunnable(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        if (signal?.aborted) { reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })); return true; }
        const s = this.s;
        if (s === 'RUNNING' || s === 'SLOW') { resolve(); return true; }
        if (s === 'IDLE') { this.setState('RUNNING'); resolve(); return true; }
        if (s === 'ESTOPPED') { reject(Object.assign(new Error('the cell is in emergency stop'), { code: 'REJECTED_STATE', state: s })); return true; }
        return false; // STOPPED: wait
      };
      if (check()) return;
      const off = this.onChange(() => { if (check()) { off(); signal?.removeEventListener('abort', onAbort); } });
      const onAbort = () => { off(); check(); };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

class StubObjects implements ObjectsApi {
  private objs = new Map<string, SceneObject>();
  private n = 0;
  constructor() { this.reset(); }
  list(): SceneObject[] { return [...this.objs.values()]; }
  get(id: string): SceneObject | undefined { return this.objs.get(id); }
  create(spec: ObjectSpec): CreateResult {
    const w = spec.width_mm, d = spec.depth_mm ?? spec.width_mm, h = spec.shape === 'sphere' ? spec.width_mm : spec.height_mm;
    const grip = spec.shape === 'box' ? Math.min(w, d) : w;
    if (grip < 15 || grip > 45) return { ok: false, code: 'WIDTH', reason: `${grip} mm is ${grip > 45 ? 'wider' : 'narrower'} than the ${grip > 45 ? '45' : '15'} mm the gripper can hold`, suggestion: `make it ${grip > 45 ? 40 : 20} mm?` };
    if (h < 10 || h > 60) return { ok: false, code: 'HEIGHT', reason: `${h} mm is outside the 10 to 60 mm height range`, suggestion: 'make it 30 mm tall?' };
    let x = spec.x_mm, y = spec.y_mm;
    if (spec.relative_to) {
      const base = spec.relative_to === 'tray' ? [-180, -130] : spec.relative_to === 'arm' ? [0, -45] : (() => { const o = this.objs.get(spec.relative_to!); return o ? [o.pos[0] * 1000, o.pos[1] * 1000] : null; })();
      if (!base) return { ok: false, code: 'NO_OBJECT', reason: `there is no part called ${spec.relative_to}` };
      const dist = spec.distance_mm ?? 80, dir = spec.direction ?? 'right';
      x = base[0] + (dir === 'left' ? -dist : dir === 'right' ? dist : 0);
      y = base[1] + (dir === 'front' ? -dist : dir === 'behind' ? dist : 0);
    }
    if (x === undefined || y === undefined) {
      const free = [[60, -210], [-60, -210], [0, -180], [110, -190]].find(([fx, fy]) => this.list().every((o) => Math.hypot(o.pos[0] * 1000 - fx, o.pos[1] * 1000 - fy) >= 40));
      if (!free) return { ok: false, code: 'NO_SPACE', reason: 'there is no free spot on the table' };
      [x, y] = free;
    }
    const rho = Math.hypot(x / 1000, y / 1000 + 0.0452);
    if (rho < 0.13 || rho > 0.21) return { ok: false, code: 'UNREACHABLE', reason: `(${x}, ${y}) is ${rho > 0.21 ? 'beyond' : 'inside'} the arm's reach`, suggestion: 'put it about 200 mm in front of the arm?' };
    if (this.objs.size >= 8) return { ok: false, code: 'TOO_MANY', reason: 'the table already has 8 parts' };
    const id = `${spec.shape}_${++this.n + 1}`;
    const obj: SceneObject = { id, name: spec.name ?? `${spec.color} ${spec.shape}`, color: spec.color, shape: spec.shape, dims: { w: w / 1000, d: d / 1000, h: h / 1000 },
      pos: [x / 1000, y / 1000, h / 2000], yaw: ((spec.yaw_deg ?? 0) * Math.PI) / 180, held: false, createdBy: 'text' };
    this.objs.set(id, obj);
    return { ok: true, obj };
  }
  remove(id: string): boolean { return this.objs.delete(id); }
  reset(): void {
    this.objs.clear(); this.n = 0;
    this.objs.set('block_1', { id: 'block_1', name: 'red block', color: 'red', shape: 'box', dims: { w: 0.024, d: 0.024, h: 0.024 }, pos: [0, -0.23, 0.012], yaw: 0, held: false, createdBy: 'seed' });
  }
}

class StubArm implements ArmApi {
  q = HOME_Q.slice();
  tcp: Vec3 = [0, -0.23, 0.15];
  jawOpen = true;
  phase = 'idle';
  heldId: string | null = null;
  private pending = new Set<(e: PrimResult) => void>();
  constructor(private objects: StubObjects, private gate: StubGate, public delayMs = 300) {}
  private move(phase: string, to: Vec3): Promise<PrimResult> {
    this.phase = phase;
    return new Promise<PrimResult>((resolve) => {
      const rejectFn = (r: PrimResult) => { clearTimeout(t); this.pending.delete(rejectFn); this.phase = 'idle'; resolve(r); };
      this.pending.add(rejectFn);
      const t = setTimeout(() => {
        this.pending.delete(rejectFn);
        this.tcp = to; this.phase = 'idle';
        if (this.heldId) { const o = this.objects.get(this.heldId); if (o) o.pos = [to[0], to[1], to[2] - 0.015 + o.dims.h / 2]; }
        resolve({ ok: true, tcp_mm: this.tcpMm(), held: this.heldId, phase: this.phase });
      }, this.delayMs);
    });
  }
  private tcpMm(): Vec3 { return [Math.round(this.tcp[0] * 1000), Math.round(this.tcp[1] * 1000), Math.round(this.tcp[2] * 1000)]; }
  private gated(): PrimResult | null {
    const s = this.gate.state();
    if (s === 'ESTOPPED') return { ok: false, code: 'REJECTED_STATE', reason: 'the cell is in emergency stop', state: s };
    return null;
  }
  async pick(id: string): Promise<PrimResult> {
    const g = this.gated(); if (g) return g;
    if (this.heldId) return { ok: false, code: 'ALREADY_HELD', reason: `${this.heldId} is already held; place it first` };
    const o = this.objects.get(id);
    if (!o) return { ok: false, code: 'NO_OBJECT', reason: `there is no part called ${id}` };
    const r1 = await this.move('hover', [o.pos[0], o.pos[1], HOVER_Z]); if (!r1.ok) return r1;
    this.jawOpen = false; this.heldId = id; o.held = true;
    return this.move('lift', [o.pos[0], o.pos[1], LIFT_Z]);
  }
  async placeInTray(): Promise<PrimResult> {
    const g = this.gated(); if (g) return g;
    if (!this.heldId) return { ok: false, code: 'NOTHING_HELD', reason: 'nothing is held' };
    const r = await this.move('transport', [TRAY[0], TRAY[1], LIFT_Z]); if (!r.ok) return r;
    const o = this.objects.get(this.heldId);
    if (o) { o.held = false; o.pos = [TRAY[0], TRAY[1], 0.006 + o.dims.h / 2]; }
    this.heldId = null; this.jawOpen = true;
    return this.move('retreat', [TRAY[0], TRAY[1], LIFT_Z]);
  }
  async placeAt(xy: [number, number]): Promise<PrimResult> {
    const g = this.gated(); if (g) return g;
    if (!this.heldId) return { ok: false, code: 'NOTHING_HELD', reason: 'nothing is held' };
    const r = await this.move('transport', [xy[0], xy[1], LIFT_Z]); if (!r.ok) return r;
    const o = this.objects.get(this.heldId);
    if (o) { o.held = false; o.pos = [xy[0], xy[1], o.dims.h / 2]; }
    this.heldId = null; this.jawOpen = true;
    return this.move('retreat', [xy[0], xy[1], LIFT_Z]);
  }
  async moveTo(p: Vec3): Promise<PrimResult> { const g = this.gated(); if (g) return g; return this.move('move', p); }
  async home(): Promise<PrimResult> { const g = this.gated(); if (g) return g; const r = await this.move('home', [0, -0.23, 0.15]); this.q = HOME_Q.slice(); return r; }
  async open(): Promise<PrimResult> { this.jawOpen = true; if (this.heldId) { const o = this.objects.get(this.heldId); if (o) { o.held = false; o.pos = [this.tcp[0], this.tcp[1], o.dims.h / 2]; } this.heldId = null; } return { ok: true, tcp_mm: this.tcpMm(), held: null, phase: this.phase }; }
  async close(): Promise<PrimResult> {
    this.jawOpen = false;
    const near = this.objects.list().find((o) => !o.held && Math.hypot(o.pos[0] - this.tcp[0], o.pos[1] - this.tcp[1]) < 0.015);
    if (near) { this.heldId = near.id; near.held = true; }
    return { ok: true, tcp_mm: this.tcpMm(), held: this.heldId, phase: this.phase };
  }
  abortAll(reason: string): void {
    for (const rej of [...this.pending]) rej({ ok: false, code: 'ABORTED', reason });
    this.pending.clear();
  }
  snapshot(): ArmSnapshot { return { q: this.q.slice(), tcp: [...this.tcp] as Vec3, jaw: this.jawOpen ? 0.7 : 0.11, jawOpen: this.jawOpen, phase: this.phase, heldId: this.heldId, queueLen: this.pending.size }; }
}

export class StubCell implements CellApi {
  gate = new StubGate();
  objects = new StubObjects();
  arm: StubArm;
  cam = makeCellCamera();
  frames = 0;
  constructor(delayMs = 300) { this.arm = new StubArm(this.objects, this.gate, delayMs); }
  capture(): FrameCapture { this.frames++; return { jpegB64: STUB_JPEG_B64, w: 768, h: 768, t: Date.now() }; }
  projectMujoco(p: Vec3): [number, number] { return projectWith(this.cam, p); }
  unprojectER(yx: [number, number], zPlane: number): Vec3 | null { return unprojectWith(this.cam, yx, zPlane); }
}
