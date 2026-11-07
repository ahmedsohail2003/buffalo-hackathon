// TEMPORARY stand-in for the arm core (src/core), so the shell can run before it lands.
// A kinematic toy: straight-line tool moves, a simple two-link arm drawing, a minimal gate and a
// sample list. Delete this file once the real core is merged.
import * as THREE from 'three';
import type { ArmApi, ArmSnapshot, BayState, CreateResult, GateApi, MoveResult, PrimCode, Sample, SampleApi, Vec3 } from '../contracts';
import type { ArmRigParts, ArmRigSource, BayCore, BayLayout, SafetySignal, SignalSource } from './bayTypes';
import { log } from './bus';

export const MOCK_LAYOUT: BayLayout = {
  deckSize: 1.2,
  deckCenter: [0, -0.1],
  containment: { x: 0.17, y: -0.19, innerW: 0.08, innerD: 0.08, wallH: 0.025, wallT: 0.004 },
  bayCamera: { pos: [0, -0.6, 0.46], target: [0, -0.14, 0.03], fovDeg: 40 },
};

const Z_HOVER = 0.09;
const Z_LIFT = 0.12;
const HOME_TCP: Vec3 = [0, -0.16, 0.16];
const SPEED = 0.16; // m/s at speed factor 1
const L0 = 0.11; // shoulder height
const L1 = 0.116; // upper arm
const L2 = 0.135; // forearm
const L3 = 0.105; // wrist flex axis to tool-centre point

const graspZ = (h: number) => Math.max(0.008, h / 2);

// ---- Gate -----------------------------------------------------------------------------------

class MockGate implements GateApi {
  private s: BayState = 'IDLE';
  private subs = new Set<(s: BayState) => void>();
  private waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];

  state(): BayState {
    return this.s;
  }
  speedFactor(): number {
    return this.s === 'RUNNING' ? 1 : this.s === 'SLOW' ? 0.5 : 0;
  }
  set(next: BayState, why: string): void {
    if (next === this.s) return;
    this.s = next;
    log('safety', `Bay ${next} (${why})`);
    for (const cb of [...this.subs]) cb(next);
    if (next === 'RUNNING' || next === 'SLOW') this.flush((w) => w.resolve());
    if (next === 'ESTOPPED') this.flush((w) => w.reject(new Error('ESTOPPED')));
  }
  private flush(fn: (w: { resolve: () => void; reject: (e: Error) => void }) => void): void {
    const ws = this.waiters;
    this.waiters = [];
    ws.forEach(fn);
  }
  waitRunnable(signal?: AbortSignal): Promise<void> {
    if (this.s === 'RUNNING' || this.s === 'SLOW') return Promise.resolve();
    if (this.s === 'ESTOPPED') return Promise.reject(new Error('ESTOPPED'));
    if (this.s === 'IDLE') {
      this.set('RUNNING', 'auto cycle start');
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      this.waiters.push(w);
      signal?.addEventListener('abort', () => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error('aborted'));
      });
    });
  }
  onChange(cb: (s: BayState) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  apply(sig: SafetySignal): void {
    const s = this.s;
    if (sig === 'ESTOP') return this.set('ESTOPPED', 'E-STOP');
    if (s === 'ESTOPPED') return;
    if (sig === 'STOP') return this.set('STOPPED', 'STOP');
    if (sig === 'SLOW') return this.set(s === 'SLOW' ? 'RUNNING' : 'SLOW', 'SLOW');
    if (sig === 'RESUME' && s !== 'IDLE') return this.set('RUNNING', 'RESUME');
    if (sig === 'CYCLE_START') return this.set('RUNNING', 'CYCLE START');
  }
}

// ---- Samples --------------------------------------------------------------------------------

class MockSamples implements SampleApi {
  private items = new Map<string, Sample>();
  private subs = new Set<() => void>();
  private n = 0;

  constructor() {
    this.seed();
  }
  private seed(): void {
    const mk = (s: Omit<Sample, 'id' | 'held' | 'createdBy' | 'yaw'> & { yaw?: number }): void => {
      const id = `s${++this.n}`;
      this.items.set(id, { yaw: 0, ...s, id, held: false, createdBy: 'seed' });
    };
    mk({ name: 'Basalt cube', color: '#3f4652', kind: 'box', dims: { w: 0.03, d: 0.03, h: 0.03 }, pos: [-0.11, -0.2, 0.015], yaw: 0.3 });
    mk({ name: 'Core canister', color: '#e2e8f0', kind: 'cylinder', dims: { w: 0.028, d: 0.028, h: 0.04 }, pos: [-0.03, -0.23, 0.02] });
    mk({ name: 'Chondrule', color: '#7c5a3c', kind: 'sphere', dims: { w: 0.03, d: 0.03, h: 0.03 }, pos: [0.05, -0.22, 0.015] });
    mk({
      name: 'Bennu fragment',
      color: '#57534e',
      kind: 'mesh',
      dims: { w: 0.032, d: 0.0312, h: 0.0313 },
      pos: [0.0, -0.3, 0.01565],
      mesh: { program: { name: 'Bennu fragment', category: 'asteroid', parts: [] }, graspWidthMm: 31.2, heightMm: 31.3, massG: 38, scale: 1, source: 'nasa', assetId: 'bennu' },
    });
  }
  private changed(): void {
    for (const cb of [...this.subs]) cb();
  }
  list(): Sample[] {
    return [...this.items.values()];
  }
  get(id: string): Sample | undefined {
    return this.items.get(id);
  }
  update(id: string, patch: Partial<Sample>): void {
    const s = this.items.get(id);
    if (!s) return;
    this.items.set(id, { ...s, ...patch });
    this.changed();
  }
  createPrimitive(spec: Parameters<SampleApi['createPrimitive']>[0], by: Sample['createdBy'] = 'operator'): CreateResult {
    const w = spec.width_mm / 1000;
    const h = spec.height_mm / 1000;
    if (spec.width_mm < 15 || spec.width_mm > 45) return { ok: false, code: 'GRIP_WIDTH', reason: `width ${spec.width_mm} mm is outside 15-45 mm` };
    const id = `s${++this.n}`;
    const s: Sample = {
      id,
      name: spec.name ?? `${spec.kind} ${id}`,
      color: spec.color,
      kind: spec.kind,
      dims: { w, d: (spec.depth_mm ?? spec.width_mm) / 1000, h },
      pos: [(spec.x_mm ?? 0) / 1000, (spec.y_mm ?? -200) / 1000, h / 2],
      yaw: 0,
      held: false,
      createdBy: by,
    };
    this.items.set(id, s);
    this.changed();
    return { ok: true, sample: s };
  }
  createMesh(input: Parameters<SampleApi['createMesh']>[0], by: Sample['createdBy'] = 'operator'): CreateResult {
    const id = `s${++this.n}`;
    const s: Sample = {
      id,
      name: input.name,
      color: input.color,
      kind: 'mesh',
      dims: input.dims,
      pos: [(input.x_mm ?? 0) / 1000, (input.y_mm ?? -200) / 1000, input.dims.h / 2],
      yaw: 0,
      held: false,
      mesh: input.mesh,
      createdBy: by,
    };
    this.items.set(id, s);
    this.changed();
    return { ok: true, sample: s };
  }
  remove(id: string): boolean {
    const ok = this.items.delete(id);
    if (ok) this.changed();
    return ok;
  }
  reset(): void {
    this.items.clear();
    this.seed();
    this.changed();
  }
  onChange(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
}

// ---- Arm ------------------------------------------------------------------------------------

type Job = { to: Vec3; done: () => void; fail: (code: PrimCode, why: string) => void };

class MockArm implements ArmApi {
  tcp: Vec3 = [...HOME_TCP];
  jaw = 1;
  roll = 0;
  phase = 'idle';
  heldId: string | null = null;
  private job: Job | null = null;
  private servo: Vec3 | null = null;
  private busyCount = 0;

  constructor(private gate: MockGate, private samples: MockSamples) {}

  private go(to: Vec3): Promise<void> {
    return new Promise((resolve, reject) => {
      this.job = { to, done: resolve, fail: (code, why) => reject(Object.assign(new Error(why), { code })) };
    });
  }
  private async run(phase: string, body: () => Promise<void>): Promise<MoveResult> {
    try {
      await this.gate.waitRunnable();
    } catch {
      return { ok: false, code: 'REJECTED_STATE', reason: `bay is ${this.gate.state()}` };
    }
    this.busyCount++;
    this.phase = phase;
    try {
      await body();
      return { ok: true, tcp_mm: this.tcp.map((v) => Math.round(v * 1000)) as Vec3, held: this.heldId };
    } catch (e) {
      const code = ((e as { code?: PrimCode }).code ?? 'ABORTED') as PrimCode;
      return { ok: false, code, reason: (e as Error).message };
    } finally {
      this.busyCount--;
      this.phase = 'idle';
    }
  }
  pick(id: string): Promise<MoveResult> {
    const s = this.samples.get(id);
    if (!s) return Promise.resolve({ ok: false, code: 'NO_SAMPLE', reason: `no sample ${id}` });
    if (this.heldId) return Promise.resolve({ ok: false, code: 'ALREADY_HELD', reason: 'already holding a sample' });
    return this.run('pick', async () => {
      const [x, y] = s.pos;
      this.jaw = 1;
      await this.go([x, y, Z_HOVER]);
      await this.go([x, y, graspZ(s.dims.h)]);
      this.jaw = 0.35;
      this.heldId = id;
      this.samples.update(id, { held: true });
      await this.go([x, y, Z_LIFT]);
    });
  }
  placeAt(xy: [number, number]): Promise<MoveResult> {
    if (!this.heldId) return Promise.resolve({ ok: false, code: 'NOTHING_HELD', reason: 'nothing held' });
    return this.run('place', () => this.dropAt(xy, 0));
  }
  placeInContainment(): Promise<MoveResult> {
    if (!this.heldId) return Promise.resolve({ ok: false, code: 'NOTHING_HELD', reason: 'nothing held' });
    const c = MOCK_LAYOUT.containment;
    return this.run('place', () => this.dropAt([c.x, c.y], 0.003));
  }
  private async dropAt([x, y]: [number, number], floor: number): Promise<void> {
    const id = this.heldId!;
    const s = this.samples.get(id)!;
    await this.go([x, y, Z_LIFT]);
    await this.go([x, y, floor + graspZ(s.dims.h)]);
    this.jaw = 1;
    this.heldId = null;
    this.samples.update(id, { held: false, pos: [x, y, floor + s.dims.h / 2] });
    await this.go([x, y, Z_HOVER]);
  }
  home(): Promise<MoveResult> {
    return this.run('home', () => this.go([...HOME_TCP]));
  }
  servoTo(target: Vec3 | null): void {
    this.servo = target;
  }
  abortAll(reason: string): void {
    const j = this.job;
    this.job = null;
    this.servo = null;
    j?.fail('ABORTED', reason);
  }
  snapshot(): ArmSnapshot {
    return { q: ik(this.tcp, this.roll), tcp: [...this.tcp], jawOpen: this.jaw, phase: this.phase, heldId: this.heldId, busy: this.busyCount > 0 };
  }
  step(dt: number, speed: number): void {
    const target = this.job?.to ?? (this.busyCount === 0 ? this.servo : null);
    if (!target || speed <= 0) return;
    const d = new THREE.Vector3(target[0] - this.tcp[0], target[1] - this.tcp[1], target[2] - this.tcp[2]);
    const len = d.length();
    const stepLen = SPEED * speed * dt;
    if (len <= stepLen) {
      this.tcp = [...target];
      if (this.job) {
        const j = this.job;
        this.job = null;
        j.done();
      }
      return;
    }
    d.multiplyScalar(stepLen / len);
    this.tcp = [this.tcp[0] + d.x, this.tcp[1] + d.y, this.tcp[2] + d.z];
  }
}

/** Toy inverse kinematics for drawing: [pan, lift, elbow, wristFlex, roll, gripper]. */
function ik(tcp: Vec3, roll: number): number[] {
  const pan = Math.atan2(tcp[0], -tcp[1]);
  const r = Math.max(0.02, Math.hypot(tcp[0], tcp[1]));
  const wz = tcp[2] + L3 - L0;
  const dist = Math.min(L1 + L2 - 1e-4, Math.hypot(r, wz));
  const cosE = (L1 * L1 + L2 * L2 - dist * dist) / (2 * L1 * L2);
  const elbow = Math.PI - Math.acos(Math.max(-1, Math.min(1, cosE)));
  const a = Math.atan2(wz, r) + Math.atan2(L2 * Math.sin(elbow), L1 + L2 * Math.cos(elbow));
  const lift = Math.PI / 2 - a; // 0 = upper arm vertical
  const wristFlex = Math.PI / 2 - (a - elbow) - Math.PI / 2;
  return [pan, lift, elbow, wristFlex, roll, 0];
}

// ---- Drawing --------------------------------------------------------------------------------

class MockRig implements ArmRigSource {
  build(): ArmRigParts {
    const white = new THREE.MeshStandardMaterial({ color: '#eef1f5', roughness: 0.45, metalness: 0.05 });
    const black = new THREE.MeshStandardMaterial({ color: '#16181d', roughness: 0.5, metalness: 0.2 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, L0 * 0.7, 32), black);
    base.rotation.x = Math.PI / 2;
    const baseG = new THREE.Group();
    base.position.z = L0 * 0.35;
    baseG.add(base);
    const link = (len: number, w: number, mat: THREE.Material) => {
      const g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, len, w * 0.8), mat);
      m.position.y = len / 2;
      g.add(m);
      return g;
    };
    const upper = link(L1, 0.036, white);
    const fore = link(L2, 0.03, white);
    const hand = new THREE.Group();
    const wrist = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.03, 0.05), black);
    const finger = new THREE.BoxGeometry(0.008, 0.02, 0.05);
    const fa = new THREE.Mesh(finger, white);
    const fb = new THREE.Mesh(finger, white);
    fa.position.z = fb.position.z = 0.022;
    wrist.position.z = 0.065;
    hand.add(wrist, fa, fb);
    const sh = new THREE.Vector3(0, 0, L0);
    const up = new THREE.Vector3(0, 1, 0);
    const seg = (g: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3) => {
      g.position.copy(from);
      g.quaternion.setFromUnitVectors(up, to.clone().sub(from).normalize());
    };
    return {
      bodies: [
        { name: 'base', object: baseG },
        { name: 'upper_arm', object: upper },
        { name: 'lower_arm', object: fore },
        { name: 'gripper', object: hand },
      ],
      pose(snap, tcpOut) {
        const [pan = 0, lift = 0] = snap.q;
        const dir = new THREE.Vector3(Math.sin(pan), -Math.cos(pan), 0);
        const a = Math.PI / 2 - lift;
        const el = sh.clone().addScaledVector(dir, L1 * Math.cos(a)).add(new THREE.Vector3(0, 0, L1 * Math.sin(a)));
        const tcp = new THREE.Vector3(...snap.tcp);
        const wr = tcp.clone().add(new THREE.Vector3(0, 0, L3));
        seg(upper, sh, el);
        seg(fore, el, wr);
        hand.position.copy(tcp);
        hand.rotation.set(0, 0, pan + (snap.q[4] ?? 0));
        const gap = 0.006 + 0.02 * snap.jawOpen;
        fa.position.x = -gap;
        fb.position.x = gap;
        tcpOut.makeRotationZ(pan + (snap.q[4] ?? 0)).setPosition(tcp);
      },
    };
  }
}

export function createMockBay(): BayCore {
  const gate = new MockGate();
  const samples = new MockSamples();
  const arm = new MockArm(gate, samples);
  return {
    arm,
    samples,
    gate,
    layout: MOCK_LAYOUT,
    rig: new MockRig(),
    mock: true,
    stepArm: (dt, speed) => arm.step(dt, speed),
    applySignal(sig: SafetySignal, source: SignalSource) {
      if (sig === 'ESTOP') arm.abortAll(`E-STOP from ${source}`);
      gate.apply(sig);
    },
    resetEstop(source: SignalSource) {
      if (gate.state() !== 'ESTOPPED') return { ok: false, reason: 'not in E-STOP' };
      gate.set('IDLE', `E-STOP reset from ${source}`);
      return { ok: true };
    },
  };
}
