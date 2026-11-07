// Test double for BayApi: an in-memory registry, a scripted arm and gate, and an invertible
// oblique camera model so pointing math can be checked exactly. Tests only.
import type { ArmSnapshot, BayApi, BayState, FrameCapture, MoveResult, Sample, Vec3 } from '../../contracts';

export const FAKE_CONTAINMENT: [number, number] = [0.15, -0.15];

export function makeSample(p: Partial<Sample> & { id: string }): Sample {
  const dims = p.dims ?? { w: 0.03, d: 0.03, h: 0.03 };
  return {
    name: p.name ?? p.id,
    color: p.color ?? '#c0392b',
    kind: p.kind ?? 'box',
    dims,
    pos: p.pos ?? [0, -0.2, dims.h / 2],
    yaw: p.yaw ?? 0,
    held: p.held ?? false,
    createdBy: p.createdBy ?? 'seed',
    ...p,
  };
}

/** image x = 500 + 2000 x; image y = 500 + 1600 (-0.2 - y) - 1200 z (bay metres -> 0-1000). */
export function fakeProject(p: Vec3): [number, number] {
  return [500 + 1600 * (-0.2 - p[1]) - 1200 * p[2], 500 + 2000 * p[0]];
}

export function fakeUnproject(yx: [number, number], z: number): Vec3 {
  const [yi, xi] = yx;
  return [(xi - 500) / 2000, -0.2 - (yi - 500 + 1200 * z) / 1600, z];
}

export interface FakeBay extends BayApi {
  setState(s: BayState): void;
  calls: Array<{ fn: string; args: unknown[] }>;
  /** force the next arm result */
  nextMove: MoveResult | null;
  /** hold arm moves until release() is called */
  holdMoves: boolean;
  release(): void;
  sampleList: Sample[];
}

export function makeFakeBay(opts: { samples?: Sample[]; state?: BayState } = {}): FakeBay {
  let state: BayState = opts.state ?? 'RUNNING';
  const samples: Sample[] = opts.samples ? opts.samples.map((s) => ({ ...s })) : [];
  const gateListeners = new Set<(s: BayState) => void>();
  const sampleListeners = new Set<() => void>();
  let heldId: string | null = samples.find((s) => s.held)?.id ?? null;
  let tcp: Vec3 = [0, -0.15, 0.12];
  const waiters: Array<() => void> = [];

  const bay: FakeBay = {
    calls: [],
    nextMove: null,
    holdMoves: false,
    sampleList: samples,
    release() {
      while (waiters.length) waiters.shift()?.();
    },
    setState(s) {
      state = s;
      for (const cb of [...gateListeners]) cb(s);
    },
    gate: {
      state: () => state,
      speedFactor: () => (state === 'RUNNING' ? 1 : state === 'SLOW' ? 0.5 : 0),
      waitRunnable: async () => {
        if (state === 'ESTOPPED') throw new Error('ESTOPPED');
      },
      onChange(cb) {
        gateListeners.add(cb);
        return () => {
          gateListeners.delete(cb);
        };
      },
    },
    samples: {
      list: () => samples.map((s) => ({ ...s })),
      get: (id) => samples.find((s) => s.id === id),
      createPrimitive: () => ({ ok: false, code: 'UNSUPPORTED', reason: 'fake bay' }),
      createMesh: () => ({ ok: false, code: 'UNSUPPORTED', reason: 'fake bay' }),
      remove: (id) => {
        const i = samples.findIndex((s) => s.id === id);
        if (i < 0) return false;
        samples.splice(i, 1);
        return true;
      },
      reset: () => {},
      onChange(cb) {
        sampleListeners.add(cb);
        return () => {
          sampleListeners.delete(cb);
        };
      },
    },
    arm: {
      pick: (id) => move('pick', [id], () => {
        const s = samples.find((x) => x.id === id);
        if (!s) return { ok: false, code: 'NO_SAMPLE', reason: `No sample ${id}.` };
        if (heldId) return { ok: false, code: 'ALREADY_HELD', reason: `Already holding ${heldId}.` };
        heldId = id;
        s.held = true;
        tcp = [s.pos[0], s.pos[1], 0.08];
        return { ok: true, tcp_mm: mm(tcp), held: id };
      }),
      placeAt: (xy) => move('placeAt', [xy], () => {
        const s = samples.find((x) => x.id === heldId);
        if (!s) return { ok: false, code: 'NOTHING_HELD', reason: 'Nothing is held.' };
        s.pos = [xy[0], xy[1], s.dims.h / 2];
        s.held = false;
        heldId = null;
        tcp = [xy[0], xy[1], 0.08];
        return { ok: true, tcp_mm: mm(tcp), held: null };
      }),
      placeInContainment: () => move('placeInContainment', [], () => {
        const s = samples.find((x) => x.id === heldId);
        if (!s) return { ok: false, code: 'NOTHING_HELD', reason: 'Nothing is held.' };
        s.pos = [FAKE_CONTAINMENT[0], FAKE_CONTAINMENT[1], s.dims.h / 2];
        s.held = false;
        heldId = null;
        return { ok: true, tcp_mm: mm(tcp), held: null };
      }),
      home: () => move('home', [], () => ({ ok: true, tcp_mm: mm(tcp), held: heldId })),
      servoTo: () => {},
      abortAll: (reason) => {
        bay.calls.push({ fn: 'abortAll', args: [reason] });
      },
      snapshot: (): ArmSnapshot => ({ q: [0, 0, 0, 0, 0, 0], tcp, jawOpen: 1, phase: 'idle', heldId, busy: false }),
    },
    capture: (): FrameCapture => {
      bay.calls.push({ fn: 'capture', args: [] });
      return { jpegB64: 'ZmFrZS1qcGVn', w: 640, h: 640, t: Date.now() };
    },
    project: fakeProject,
    unproject: fakeUnproject,
  };

  async function move(fn: string, args: unknown[], run: () => MoveResult): Promise<MoveResult> {
    bay.calls.push({ fn, args });
    if (bay.holdMoves) await new Promise<void>((r) => waiters.push(r));
    if (bay.nextMove) {
      const r = bay.nextMove;
      bay.nextMove = null;
      return r;
    }
    return run();
  }

  return bay;
}

function mm(v: Vec3): Vec3 {
  return [Math.round(v[0] * 1000), Math.round(v[1] * 1000), Math.round(v[2] * 1000)];
}
