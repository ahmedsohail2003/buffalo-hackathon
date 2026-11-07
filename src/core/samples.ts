// Sample registry and validator: the trust boundary for every AI-proposed sample.
// Every rejection is { ok: false, code, reason, suggestion } with a one-sentence reason that can
// be spoken as is. Sizes in mm on the API, metres inside.

import type { CreateResult, MeshInfo, Placement, Rejection, Sample, SampleApi, SampleKind, Vec3 } from '../contracts';
import {
  CONTAINMENT_FLOOR_Z,
  CONTAINMENT_INNER,
  CONTAINMENT_KEEPOUT,
  CONTAINMENT_OUTER_HALF,
  CONTAINMENT_WALL_H,
  CONTAINMENT_XY,
  DEFAULT_RELATIVE_MM,
  DEPTH_MAX_MM,
  GRIP_MAX_MM,
  GRIP_MIN_MM,
  HEIGHT_MAX_MM,
  HEIGHT_MIN_MM,
  MAX_SAMPLES,
  MIN_SPACING,
  REACH,
  SLOTS,
  SPACING_EXTRA,
  ATTACH_BAND,
  ATTACH_XY_TOL,
  bearingOf,
  rhoOf,
} from './constants';

export type ValidationCode =
  | 'BAD_KIND'
  | 'BAD_SIZE'
  | 'TOO_WIDE'
  | 'TOO_NARROW'
  | 'TOO_TALL'
  | 'TOO_SHORT'
  | 'TOO_DEEP'
  | 'BAD_PLACEMENT'
  | 'NO_SAMPLE'
  | 'OUT_OF_REACH'
  | 'ON_CONTAINMENT'
  | 'TOO_CLOSE'
  | 'BAY_FULL'
  | 'UNREACHABLE';

/** Optional IK probe the factory injects: can the arm hover, grasp and lift a sample here? */
export type ReachProbe = (s: { x: number; y: number; yaw: number; w: number; d: number; h: number; gripWidthMm: number }) => Rejection | null;

export interface RegistryOptions {
  reachProbe?: ReachProbe;
  /** current TCP (for placements relative_to 'arm') */
  armTcp?: () => Vec3;
  /** skip the seed cube (tests) */
  noSeed?: boolean;
}

const mm = (m: number): string => `${Math.round(m * 1000)} mm`;
const deg = (r: number): string => `${Math.round((r * 180) / Math.PI)} degrees`;

function reject(code: ValidationCode | string, reason: string, suggestion?: string): Rejection {
  return suggestion ? { ok: false, code, reason, suggestion } : { ok: false, code, reason };
}

/** bounding-circle radius used for spacing: hypot(w, d) / 2 */
export function sampleRadius(dims: { w: number; d: number }): number {
  return Math.hypot(dims.w, dims.d) / 2;
}

/** grip width (mm) the jaw closes on: the measured mesh width, or dims.w */
export function gripWidthMm(s: Pick<Sample, 'kind' | 'dims' | 'mesh'>): number {
  return s.kind === 'mesh' && s.mesh ? s.mesh.graspWidthMm : s.dims.w * 1000;
}

const CSS_COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,24}|(rgb|hsl)a?\([\d\s.,%]+\))$/i;

function cloneSample(s: Sample): Sample {
  return { ...s, pos: [s.pos[0], s.pos[1], s.pos[2]], dims: { ...s.dims } };
}

export class SampleRegistry implements SampleApi {
  private items: Sample[] = [];
  private nextId = 1;
  private readonly listeners = new Set<() => void>();
  private readonly opts: RegistryOptions;

  constructor(opts: RegistryOptions = {}) {
    this.opts = opts;
    if (!opts.noSeed) this.seed();
  }

  /** inject the IK reach probe after construction (the factory builds the arm second) */
  setReachProbe(p: ReachProbe | undefined): void {
    this.opts.reachProbe = p;
  }
  setArmTcp(f: (() => Vec3) | undefined): void {
    this.opts.armTcp = f;
  }

  private seed(): void {
    const [x, y] = SLOTS[0];
    const h = 0.024;
    this.items.push({
      id: `sample_${this.nextId++}`,
      name: 'sample cube',
      color: '#d9480f',
      kind: 'box',
      dims: { w: 0.024, d: 0.024, h },
      pos: [x, y, h / 2],
      yaw: 0,
      held: false,
      createdBy: 'seed',
    });
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb();
  }

  list(): Sample[] {
    return this.items.map(cloneSample);
  }

  get(id: string): Sample | undefined {
    const s = this.items.find((x) => x.id === id);
    return s ? cloneSample(s) : undefined;
  }

  /** find by id, or by name (case-insensitive) */
  resolve(ref: string): Sample | undefined {
    const r = ref.trim().toLowerCase();
    const s = this.items.find((x) => x.id.toLowerCase() === r) ?? this.items.find((x) => x.name.toLowerCase() === r);
    return s ? cloneSample(s) : undefined;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  remove(id: string): boolean {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this.emit();
    return true;
  }

  reset(): void {
    this.items = [];
    this.nextId = 1;
    if (!this.opts.noSeed) this.seed();
    this.emit();
  }

  // ---------- validation ----------

  private resolvePlacement(p: Placement, dims: { w: number; d: number; h: number }, gripMm: number): { x: number; y: number } | Rejection {
    const hasXY = p.x_mm !== undefined || p.y_mm !== undefined;
    if (hasXY) {
      if (!Number.isFinite(p.x_mm) || !Number.isFinite(p.y_mm)) {
        return reject('BAD_PLACEMENT', 'a position needs both x and y in millimetres.', 'give x_mm and y_mm, or leave them out to use the next free spot');
      }
      return { x: (p.x_mm as number) / 1000, y: (p.y_mm as number) / 1000 };
    }
    if (p.relative_to !== undefined) {
      const ref = String(p.relative_to).trim();
      let base: [number, number];
      let label: string;
      if (ref.toLowerCase() === 'containment') {
        base = CONTAINMENT_XY;
        label = 'the containment bin';
      } else if (ref.toLowerCase() === 'arm') {
        const t = this.opts.armTcp?.() ?? [0, 0, 0];
        base = [t[0], t[1]];
        label = 'the gripper';
      } else {
        const s = this.resolve(ref);
        if (!s) return reject('NO_SAMPLE', `there is no sample called ${ref} on the deck.`, 'use the id or name of a sample in the bay');
        base = [s.pos[0], s.pos[1]];
        label = s.name;
      }
      const dir = p.direction;
      const dist = (p.distance_mm ?? DEFAULT_RELATIVE_MM) / 1000;
      if (!Number.isFinite(dist) || dist < 0) return reject('BAD_PLACEMENT', 'the distance must be a positive number of millimetres.');
      const v: Record<string, [number, number]> = { left: [-1, 0], right: [1, 0], front: [0, -1], behind: [0, 1] };
      if (!dir || !v[dir]) {
        return reject('BAD_PLACEMENT', `say which side of ${label} to use: left, right, front or behind.`, 'add direction: left, right, front or behind');
      }
      return { x: base[0] + v[dir][0] * dist, y: base[1] + v[dir][1] * dist };
    }
    // first free slot that passes every check
    for (const [x, y] of SLOTS) {
      if (this.checkSpot(x, y, dims, gripMm, 0, null) === null) return { x, y };
    }
    return reject('BAY_FULL', 'none of the default spots is free for a part this size.', 'give x_mm and y_mm inside the reach band, or remove a sample');
  }

  /** placement checks shared by createPrimitive and createMesh; null when the spot is fine */
  checkSpot(x: number, y: number, dims: { w: number; d: number; h: number }, gripMm: number, yaw: number, ignoreId: string | null): Rejection | null {
    const r = rhoOf(x, y);
    const b = bearingOf(x, y);
    if (r < REACH.rhoMin || r > REACH.rhoMax) {
      return reject(
        'OUT_OF_REACH',
        `that spot is ${mm(r)} from the arm's axis, and the gripper only works between ${mm(REACH.rhoMin)} and ${mm(REACH.rhoMax)}.`,
        `move it to between ${Math.round(REACH.rhoMin * 1000)} and ${Math.round(REACH.rhoMax * 1000)} mm from the arm`,
      );
    }
    if (Math.abs(b) > REACH.bearingMax) {
      return reject(
        'OUT_OF_REACH',
        `that spot is ${deg(Math.abs(b))} to the side, and the arm only works within ${deg(REACH.bearingMax)} of straight ahead.`,
        'move it further in front of the arm',
      );
    }
    const rad = sampleRadius(dims);
    const dx = Math.abs(x - CONTAINMENT_XY[0]);
    const dy = Math.abs(y - CONTAINMENT_XY[1]);
    if (dx < CONTAINMENT_KEEPOUT + rad && dy < CONTAINMENT_KEEPOUT + rad) {
      return reject(
        'ON_CONTAINMENT',
        `that spot is on or next to the containment bin; parts need ${mm(CONTAINMENT_KEEPOUT + rad)} of clearance from its centre.`,
        'pick a spot further from the bin',
      );
    }
    for (const o of this.items) {
      if (o.held || o.id === ignoreId) continue;
      const need = Math.max(MIN_SPACING, rad + sampleRadius(o.dims) + SPACING_EXTRA);
      const dist = Math.hypot(x - o.pos[0], y - o.pos[1]);
      if (dist < need) {
        return reject(
          'TOO_CLOSE',
          `that spot is ${mm(dist)} from ${o.name}, and these parts need ${mm(need)} between centres.`,
          `move it at least ${Math.ceil((need - dist) * 1000)} mm further from ${o.name}`,
        );
      }
    }
    const probe = this.opts.reachProbe?.({ x, y, yaw, w: dims.w, d: dims.d, h: dims.h, gripWidthMm: gripMm });
    if (probe) return probe;
    return null;
  }

  private add(s: Omit<Sample, 'id'>): Sample {
    const sample: Sample = { ...s, id: `sample_${this.nextId++}` };
    this.items.push(sample);
    this.emit();
    return cloneSample(sample);
  }

  createPrimitive(
    spec: { name?: string; color: string; kind: 'box' | 'cylinder' | 'sphere'; width_mm: number; depth_mm?: number; height_mm: number } & Placement,
    by: Sample['createdBy'] = 'operator',
  ): CreateResult {
    const kind = spec.kind as SampleKind;
    if (kind !== 'box' && kind !== 'cylinder' && kind !== 'sphere') {
      return reject('BAD_KIND', `a ${String(spec.kind)} is not a shape the bay can make; use a box, a cylinder or a sphere.`, 'kind: box, cylinder or sphere');
    }
    const w = Number(spec.width_mm);
    const hIn = kind === 'sphere' ? w : Number(spec.height_mm);
    const dIn = kind === 'box' ? Number(spec.depth_mm ?? spec.width_mm) : w;
    if (![w, hIn, dIn].every(Number.isFinite) || w <= 0 || hIn <= 0 || dIn <= 0) {
      return reject('BAD_SIZE', 'every size must be a positive number of millimetres.', 'give width_mm and height_mm');
    }
    if (w > GRIP_MAX_MM) {
      return reject('TOO_WIDE', `a ${Math.round(w)} mm part is wider than the ${GRIP_MAX_MM} mm the gripper can hold.`, `make it ${GRIP_MAX_MM} mm wide or less`);
    }
    if (w < GRIP_MIN_MM) {
      return reject('TOO_NARROW', `a ${Math.round(w)} mm part is narrower than the ${GRIP_MIN_MM} mm the gripper can hold reliably.`, `make it at least ${GRIP_MIN_MM} mm wide`);
    }
    if (hIn > HEIGHT_MAX_MM) {
      return reject('TOO_TALL', `a ${Math.round(hIn)} mm tall part is taller than the ${HEIGHT_MAX_MM} mm the arm can carry over its neighbours.`, `make it ${HEIGHT_MAX_MM} mm tall or less`);
    }
    if (hIn < HEIGHT_MIN_MM) {
      return reject('TOO_SHORT', `a ${Math.round(hIn)} mm tall part is too flat for the fingertips; it needs at least ${HEIGHT_MIN_MM} mm.`, `make it at least ${HEIGHT_MIN_MM} mm tall`);
    }
    if (dIn > DEPTH_MAX_MM) {
      return reject('TOO_DEEP', `a ${Math.round(dIn)} mm deep part is longer than the ${DEPTH_MAX_MM} mm footprint the bay allows.`, `make it ${DEPTH_MAX_MM} mm deep or less`);
    }
    if (dIn < HEIGHT_MIN_MM) {
      return reject('BAD_SIZE', `a ${Math.round(dIn)} mm deep part is too thin to stand on the deck; it needs at least ${HEIGHT_MIN_MM} mm.`, `make it at least ${HEIGHT_MIN_MM} mm deep`);
    }
    if (this.items.length >= MAX_SAMPLES) {
      return reject('BAY_FULL', `the bay already holds ${MAX_SAMPLES} samples, the most it can track.`, 'remove a sample first');
    }
    const dims = { w: w / 1000, d: dIn / 1000, h: hIn / 1000 };
    const at = this.resolvePlacement(spec, dims, w);
    if ('ok' in at) return at;
    const bad = this.checkSpot(at.x, at.y, dims, w, 0, null);
    if (bad) return bad;
    const color = typeof spec.color === 'string' && CSS_COLOR.test(spec.color.trim()) ? spec.color.trim() : '#9aa5b1';
    const name = (typeof spec.name === 'string' && spec.name.trim() ? spec.name.trim() : `${kind} ${this.nextId}`).slice(0, 40);
    return { ok: true, sample: this.add({ name, color, kind, dims, pos: [at.x, at.y, dims.h / 2], yaw: 0, held: false, createdBy: by }) };
  }

  createMesh(
    input: { name: string; color: string; mesh: MeshInfo; dims: { w: number; d: number; h: number } } & Placement,
    by: Sample['createdBy'] = 'gemini',
  ): CreateResult {
    const dims = input.dims;
    if (!dims || ![dims.w, dims.d, dims.h].every((v) => Number.isFinite(v) && v > 0 && v < 0.2)) {
      return reject('BAD_SIZE', 'the fabricated part has no valid size.', 'measure the part again');
    }
    const grip = input.mesh?.graspWidthMm;
    if (!Number.isFinite(grip)) return reject('BAD_SIZE', 'the fabricated part has no measured grip width.', 'measure the part again');
    if (grip > GRIP_MAX_MM) {
      return reject('TOO_WIDE', `a ${Math.round(grip)} mm part is wider than the ${GRIP_MAX_MM} mm the gripper can hold.`, 'scale it down');
    }
    if (grip < GRIP_MIN_MM) {
      return reject('TOO_NARROW', `a ${Math.round(grip)} mm part is narrower than the ${GRIP_MIN_MM} mm the gripper can hold reliably.`, 'scale it up');
    }
    if (dims.h * 1000 > HEIGHT_MAX_MM + 0.5) {
      return reject('TOO_TALL', `a ${Math.round(dims.h * 1000)} mm tall part is taller than the ${HEIGHT_MAX_MM} mm the arm can carry over its neighbours.`, 'scale it down');
    }
    if (this.items.length >= MAX_SAMPLES) {
      return reject('BAY_FULL', `the bay already holds ${MAX_SAMPLES} samples, the most it can track.`, 'remove a sample first');
    }
    const at = this.resolvePlacement(input, dims, grip);
    if ('ok' in at) return at;
    const bad = this.checkSpot(at.x, at.y, dims, grip, 0, null);
    if (bad) return bad;
    const color = typeof input.color === 'string' && CSS_COLOR.test(input.color.trim()) ? input.color.trim() : '#9aa5b1';
    const name = (typeof input.name === 'string' && input.name.trim() ? input.name.trim() : `sample ${this.nextId}`).slice(0, 40);
    return {
      ok: true,
      sample: this.add({ name, color, kind: 'mesh', dims: { ...dims }, pos: [at.x, at.y, dims.h / 2], yaw: 0, held: false, mesh: input.mesh, createdBy: by }),
    };
  }

  // ---------- helpers the arm uses ----------

  /** nearest sample (not held) to xy, optionally within maxDist (m) */
  nearest(xy: [number, number], maxDist = Infinity): Sample | undefined {
    let best: Sample | undefined;
    let bd = maxDist;
    for (const s of this.items) {
      if (s.held) continue;
      const d = Math.hypot(s.pos[0] - xy[0], s.pos[1] - xy[1]);
      if (d <= bd) {
        bd = d;
        best = s;
      }
    }
    return best ? cloneSample(best) : undefined;
  }

  /**
   * Attach rule: the sample (not held) whose centre is within ATTACH_XY_TOL of the TCP in xy and
   * whose bottom is between ATTACH_BAND[0] and ATTACH_BAND[1] below the TCP. Nearest wins.
   */
  attachCandidate(tcp: Vec3, onlyId?: string): Sample | undefined {
    let best: Sample | undefined;
    let bd = Infinity;
    for (const s of this.items) {
      if (s.held || (onlyId && s.id !== onlyId)) continue;
      const d = Math.hypot(s.pos[0] - tcp[0], s.pos[1] - tcp[1]);
      const below = tcp[2] - (s.pos[2] - s.dims.h / 2);
      if (d <= ATTACH_XY_TOL && below >= ATTACH_BAND[0] && below <= ATTACH_BAND[1] && d < bd) {
        bd = d;
        best = s;
      }
    }
    return best ? cloneSample(best) : undefined;
  }

  /** samples resting on top of this one */
  coveredBy(id: string): Sample | undefined {
    const s = this.items.find((x) => x.id === id);
    if (!s) return undefined;
    const top = s.pos[2] + s.dims.h / 2;
    const o = this.items.find(
      (x) =>
        x.id !== id &&
        !x.held &&
        Math.abs(x.pos[2] - x.dims.h / 2 - top) < 0.002 &&
        Math.hypot(x.pos[0] - s.pos[0], x.pos[1] - s.pos[1]) < sampleRadius(x.dims) + sampleRadius(s.dims),
    );
    return o ? cloneSample(o) : undefined;
  }

  /**
   * What a sample released at (x, y) would rest on: the deck, the containment floor, the bin wall,
   * or the top of the highest sample whose bounding circle overlaps it. z is the sample's centre.
   */
  restZ(sample: Pick<Sample, 'id' | 'dims'>, x: number, y: number): { z: number; support: number; on: 'deck' | 'containment' | 'wall' | 'sample'; underId: string | null } {
    let support = 0;
    let on: 'deck' | 'containment' | 'wall' | 'sample' = 'deck';
    const dx = Math.abs(x - CONTAINMENT_XY[0]);
    const dy = Math.abs(y - CONTAINMENT_XY[1]);
    if (dx <= CONTAINMENT_INNER / 2 && dy <= CONTAINMENT_INNER / 2) {
      support = CONTAINMENT_FLOOR_Z;
      on = 'containment';
    } else if (dx <= CONTAINMENT_OUTER_HALF && dy <= CONTAINMENT_OUTER_HALF) {
      support = CONTAINMENT_WALL_H;
      on = 'wall';
    }
    let underId: string | null = null;
    const r = sampleRadius(sample.dims);
    for (const o of this.items) {
      if (o.held || o.id === sample.id) continue;
      const d = Math.hypot(x - o.pos[0], y - o.pos[1]);
      if (d < r + sampleRadius(o.dims) - 0.002) {
        const top = o.pos[2] + o.dims.h / 2;
        if (top > support) {
          support = top;
          on = 'sample';
          underId = o.id;
        }
      }
    }
    return { z: support + sample.dims.h / 2, support, on, underId };
  }

  /** mark held / released (emits onChange) */
  setHeld(id: string, held: boolean): void {
    const s = this.items.find((x) => x.id === id);
    if (!s || s.held === held) return;
    s.held = held;
    this.emit();
  }

  /**
   * Move a sample (the arm calls this every step for the held sample). Pose-only updates do not
   * emit onChange; read list() each frame for poses.
   */
  updatePose(id: string, pos: Vec3, yaw: number, emit = false): void {
    const s = this.items.find((x) => x.id === id);
    if (!s) return;
    s.pos = [pos[0], pos[1], pos[2]];
    s.yaw = yaw;
    if (emit) this.emit();
  }
}

