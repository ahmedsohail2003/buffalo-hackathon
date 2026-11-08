// Test fakes for the bay contracts: a kinematic stand-in arm (no IK, no model), a sample list and
// a gate with the bay states. Only the behaviour teleop relies on is modelled.

import type { ArmApi, ArmSnapshot, BayApi, BayState, GateApi, HandLandmark, MoveResult, Sample, SampleApi, Vec3 } from '../contracts';
import { syntheticHand } from './handTemplate';

/** A pinched hand with middle / ring / pinky curled into the palm: what a fist looks like to the landmarks. */
export function fistLike(x = 0.5, y = 0.5): HandLandmark[] {
  const lm = syntheticHand(x, y, true);
  for (const [mcp, pip, dip, tip] of [
    [9, 10, 11, 12],
    [13, 14, 15, 16],
    [17, 18, 19, 20],
  ]) {
    lm[dip] = { x: (lm[pip].x + lm[mcp].x) / 2, y: lm[pip].y + 0.02, z: 0 };
    lm[tip] = { x: lm[mcp].x, y: lm[mcp].y + 0.04, z: 0 };
  }
  return lm;
}

export const CONTAINMENT: { xy: [number, number]; half: number } = { xy: [-0.17, -0.06], half: 0.045 };
export const Z_LIFT = 0.09;

export class FakeGate implements GateApi {
  s: BayState;
  lines: string[] = [];
  private subs = new Set<(s: BayState) => void>();
  constructor(initial: BayState = 'RUNNING') {
    this.s = initial;
  }
  state(): BayState {
    return this.s;
  }
  speedFactor(): number {
    return this.s === 'RUNNING' ? 1 : this.s === 'SLOW' ? 0.5 : 0;
  }
  set(s: BayState): void {
    this.s = s;
    for (const cb of [...this.subs]) cb(s);
  }
  waitRunnable(): Promise<void> {
    if (this.s === 'IDLE') {
      this.lines.push('TASK START — auto CYCLE START');
      this.set('RUNNING');
    }
    if (this.s === 'ESTOPPED') return Promise.reject(new Error('ESTOPPED'));
    return Promise.resolve();
  }
  onChange(cb: (s: BayState) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
}

export class FakeSamples implements SampleApi {
  items: Sample[] = [];
  add(id: string, x: number, y: number, h = 0.024): Sample {
    const s: Sample = { id, name: `sample ${id}`, color: 'red', kind: 'box', dims: { w: 0.024, d: 0.024, h }, pos: [x, y, h / 2], yaw: 0, held: false, createdBy: 'seed' };
    this.items.push(s);
    return s;
  }
  list(): Sample[] {
    return [...this.items];
  }
  get(id: string): Sample | undefined {
    return this.items.find((s) => s.id === id);
  }
  createPrimitive(): never {
    throw new Error('not in the fake');
  }
  createMesh(): never {
    throw new Error('not in the fake');
  }
  findSpot(): never {
    throw new Error('not in the fake');
  }
  remove(): boolean {
    return false;
  }
  reset(): void {}
  onChange(): () => void {
    return () => undefined;
  }
}

interface Job {
  frames: number;
  done: () => MoveResult;
  resolve: (r: MoveResult) => void;
}

/** Moves the tcp straight toward the servo target at 0.5 m/s * speed factor; primitives take 30 frames. */
export class FakeArm implements ArmApi {
  tcp: Vec3 = [0, -0.12, 0.15];
  heldId: string | null = null;
  servo: Vec3 | null = null;
  phase = 'idle';
  calls: string[] = [];
  private job: Job | null = null;

  constructor(
    private readonly gate: FakeGate,
    private readonly samples: FakeSamples,
  ) {}

  private start(label: string, done: () => MoveResult): Promise<MoveResult> {
    this.calls.push(label);
    if (this.gate.state() === 'ESTOPPED') return Promise.resolve({ ok: false, code: 'REJECTED_STATE', reason: 'E-STOP' });
    this.servo = null;
    this.phase = label;
    return new Promise((resolve) => {
      this.job = { frames: 30, done, resolve };
    });
  }
  pick(id: string): Promise<MoveResult> {
    return this.start(`pick ${id}`, () => {
      const s = this.samples.get(id)!;
      s.held = true;
      this.heldId = id;
      this.tcp = [s.pos[0], s.pos[1], Z_LIFT];
      return { ok: true, tcp_mm: this.tcp.map((v) => v * 1000) as Vec3, held: id };
    });
  }
  private release(x: number, y: number, floor: number): MoveResult {
    const s = this.samples.get(this.heldId!)!;
    s.held = false;
    s.pos = [x, y, floor + s.dims.h / 2];
    this.heldId = null;
    return { ok: true, tcp_mm: this.tcp.map((v) => v * 1000) as Vec3, held: null };
  }
  placeAt(xy: [number, number]): Promise<MoveResult> {
    if (!this.heldId) return Promise.resolve({ ok: false, code: 'NOTHING_HELD', reason: 'the gripper is empty' });
    return this.start(`placeAt ${Math.round(xy[0] * 1000)},${Math.round(xy[1] * 1000)}`, () => this.release(xy[0], xy[1], 0));
  }
  placeInContainment(): Promise<MoveResult> {
    if (!this.heldId) return Promise.resolve({ ok: false, code: 'NOTHING_HELD', reason: 'the gripper is empty' });
    return this.start('placeInContainment', () => this.release(CONTAINMENT.xy[0], CONTAINMENT.xy[1], 0.004));
  }
  home(): Promise<MoveResult> {
    return this.start('home', () => ({ ok: true, tcp_mm: [0, -120, 150], held: this.heldId }));
  }
  servoTo(target: Vec3 | null): void {
    if (this.job) return; // ignored while a move is running
    this.servo = target ? [...target] : null;
  }
  abortAll(reason: string): void {
    const j = this.job;
    this.job = null;
    this.servo = null;
    this.phase = `ABORTED: ${reason}`;
    j?.resolve({ ok: false, code: 'ABORTED', reason });
  }
  snapshot(): ArmSnapshot {
    return { q: [0, 0, 0, 0, 0, 1], tcp: [...this.tcp], jawOpen: 1, phase: this.phase, heldId: this.heldId, busy: this.job !== null };
  }
  /** One frame of motion (the bay's arm step). */
  tick(dt: number): void {
    const k = this.gate.speedFactor();
    if (this.job) {
      if (k > 0 && --this.job.frames <= 0) {
        const j = this.job;
        this.job = null;
        this.phase = 'idle';
        j.resolve(j.done());
      }
      return;
    }
    if (!this.servo || k === 0) return;
    const d = [this.servo[0] - this.tcp[0], this.servo[1] - this.tcp[1], this.servo[2] - this.tcp[2]];
    const n = Math.hypot(d[0], d[1], d[2]);
    const step = 0.5 * k * dt;
    const s = n <= step ? 1 : step / n;
    this.tcp = [this.tcp[0] + d[0] * s, this.tcp[1] + d[1] * s, this.tcp[2] + d[2] * s];
    this.phase = 'teleop';
    if (this.heldId) {
      const o = this.samples.get(this.heldId)!;
      o.pos = [this.tcp[0], this.tcp[1], this.tcp[2] - 0.015];
    }
  }
}

export function makeBay(initial: BayState = 'RUNNING') {
  const gate = new FakeGate(initial);
  const samples = new FakeSamples();
  const arm = new FakeArm(gate, samples);
  const bay: BayApi = {
    arm,
    samples,
    gate,
    capture: () => ({ jpegB64: '', w: 0, h: 0, t: 0 }),
    project: () => [0, 0],
    unproject: () => null,
  };
  return { bay, gate, samples, arm };
}
