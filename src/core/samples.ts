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
  polarXY,
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
  | 'NO_SPOT'
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

/**
 * Where the registry looks for a free deck spot, in order: the five SLOTS, then the whole reach band,
 * rho 140-190 mm in 10 mm steps by bearings -80 to +80 degrees in 5 degree steps, nearest straight
 * ahead first, then nearest the 165 mm arc (then right before left, outer before inner). Every spot
 * still goes through checkSpot: reach, the bin keep-out, spacing and the IK probe.
 */
export const SEARCH_SPOTS: readonly [number, number][] = (() => {
  const band: { rho: number; bearing: number }[] = [];
  for (let rho = 140; rho <= 190; rho += 10) for (let bearing = -80; bearing <= 80; bearing += 5) band.push({ rho, bearing });
  band.sort((a, b) => Math.abs(a.bearing) - Math.abs(b.bearing) || Math.abs(a.rho - 165) - Math.abs(b.rho - 165) || b.bearing - a.bearing || b.rho - a.rho);
  return [...SLOTS, ...band.map((s) => polarXY(s.rho / 1000, (s.bearing * Math.PI) / 180))];
})();

export type DeckSide = NonNullable<Placement['side']>;
export const DECK_SIDES: readonly DeckSide[] = ['left', 'right', 'front', 'behind', 'center'];
const SIDE_WHERE: Record<DeckSide, string> = {
  left: 'on the left of the deck',
  right: 'on the right of the deck',
  front: 'at the front of the deck',
  behind: 'at the back of the deck',
  center: 'in the middle of the deck',
};

/**
 * Deck regions, bay frame: left is -x, right +x, front farther from the base (rho >= 170 mm), behind
 * nearer it (rho <= 160 mm), center within 20 degrees of straight ahead.
 */
export function onDeckSide(x: number, y: number, side: DeckSide): boolean {
  const eps = 1e-9;
  switch (side) {
    case 'left':
      return x < -eps;
    case 'right':
      return x > eps;
    case 'front':
      return rhoOf(x, y) >= 0.17 - eps;
    case 'behind':
      return rhoOf(x, y) <= 0.16 + eps;
    case 'center':
      return Math.abs(bearingOf(x, y)) <= (20 * Math.PI) / 180 + eps;
  }
}

function reject(code: ValidationCode | string, reason: string, suggestion?: string): Rejection {
  return suggestion ? { ok: false, code, reason, suggestion } : { ok: false, code, reason };
}

/** a refusal's suggestion naming a free deck spot, in mm: "try (-120, -60) mm" */
export function spotSuggestion(xy: readonly [number, number]): string {
  const r = (m: number) => Math.round(m * 1000) || 0;
  return `try (${r(xy[0])}, ${r(xy[1])}) mm`;
}

/** footprint radius used for spacing and the bin: the measured dims.r, else the bounding circle hypot(w, d) / 2 */
export function sampleRadius(dims: { w: number; d: number; r?: number }): number {
  const r = dims.r;
  return typeof r === 'number' && Number.isFinite(r) && r > 0 ? r : Math.hypot(dims.w, dims.d) / 2;
}

/**
 * A measured footprint radius, kept to what the extents allow: no part reaches less than max(w, d) / 2
 * or more than hypot(w, d) / 2 from its bounding-box centre. Undefined when missing or not a number.
 */
function footprintRadius(dims: { w: number; d: number; r?: number }): number | undefined {
  const r = dims.r;
  if (typeof r !== 'number' || !Number.isFinite(r) || r <= 0) return undefined;
  return Math.min(Math.hypot(dims.w, dims.d) / 2, Math.max(Math.max(dims.w, dims.d) / 2, r));
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

  /**
   * Where a placement points, for a part of these dims; ignoreId (a sample being moved) never blocks
   * the search. what names the part in refusals.
   */
  private resolvePlacement(
    p: Placement,
    dims: Sample['dims'],
    gripMm: number,
    yaw = 0,
    ignoreId: string | null = null,
    what = 'a part this size',
  ): { x: number; y: number } | Rejection {
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
    const side = p.side;
    if (side !== undefined && !(DECK_SIDES as readonly string[]).includes(side)) {
      return reject('BAD_PLACEMENT', 'say which part of the deck to use: left, right, front, behind or center.', 'side: left, right, front, behind or center');
    }
    // the first spot that passes every check: the slots, then the rest of the reach band
    for (const [x, y] of SEARCH_SPOTS) {
      if (side && !onDeckSide(x, y, side)) continue;
      if (this.checkSpot(x, y, dims, gripMm, yaw, ignoreId) === null) return { x, y };
    }
    if (side) return reject('NO_SPOT', `there is no free spot ${SIDE_WHERE[side]} for ${what}.`, 'try another side, or leave the side out for any free spot');
    return reject('BAY_FULL', `there is no free spot on the deck for ${what}.`, 'stow a sample in containment first');
  }

  /**
   * A free, checked deck spot for an existing sample, which may be held: it never blocks itself.
   * x_mm/y_mm is checked as given, relative_to + direction is resolved and checked, side is the first
   * free spot of the search in that region, and no placement the first free spot anywhere.
   */
  findSpot(id: string, placement: Placement = {}): { ok: true; xy: [number, number] } | Rejection {
    const s = this.resolve(String(id));
    if (!s) return reject('NO_SAMPLE', `there is no sample called ${id} in the bay.`, 'use the id of a sample in the bay');
    const grip = gripWidthMm(s);
    const at = this.resolvePlacement(placement ?? {}, s.dims, grip, s.yaw, s.id, s.name);
    if ('ok' in at) return at;
    const bad = this.checkSpot(at.x, at.y, s.dims, grip, s.yaw, s.id);
    if (bad) {
      // crowded or on the bin: name the nearest free spot, so one more call recovers
      const near = bad.code === 'TOO_CLOSE' || bad.code === 'ON_CONTAINMENT' ? this.nearestFreeSpot(s.id, [at.x, at.y]) : null;
      return near ? { ...bad, suggestion: spotSuggestion(near) } : bad;
    }
    return { ok: true, xy: [at.x, at.y] };
  }

  /**
   * The free spot of the search (slots and reach band) nearest to xy for an existing sample, which may
   * be held (it never blocks itself); null when none is free. Rounded to the millimetre, and checked
   * as rounded, so a suggestion that names it in mm is a spot that passes.
   */
  nearestFreeSpot(id: string, xy: [number, number]): [number, number] | null {
    const s = this.resolve(String(id));
    if (!s) return null;
    const grip = gripWidthMm(s);
    const d = (p: readonly [number, number]) => Math.hypot(p[0] - xy[0], p[1] - xy[1]);
    for (const p of [...SEARCH_SPOTS].sort((a, b) => d(a) - d(b))) {
      const q: [number, number] = [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000];
      if (this.checkSpot(q[0], q[1], s.dims, grip, s.yaw, s.id) === null) return q;
    }
    return null;
  }

  /** placement checks shared by createPrimitive and createMesh; null when the spot is fine */
  checkSpot(x: number, y: number, dims: Sample['dims'], gripMm: number, yaw: number, ignoreId: string | null): Rejection | null {
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
    input: { name: string; color: string; mesh: MeshInfo; dims: { w: number; d: number; h: number; r?: number } } & Placement,
    by: Sample['createdBy'] = 'gemini',
  ): CreateResult {
    const given = input.dims;
    if (!given || ![given.w, given.d, given.h].every((v) => Number.isFinite(v) && v > 0 && v < 0.2)) {
      return reject('BAD_SIZE', 'the fabricated part has no valid size.', 'measure the part again');
    }
    const r = footprintRadius(given);
    const dims = { w: given.w, d: given.d, h: given.h, ...(r !== undefined ? { r } : {}) };
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

