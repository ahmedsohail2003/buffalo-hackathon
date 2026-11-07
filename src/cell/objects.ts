// Object registry (ground truth for every part on the table) and the object
// validator — the code trust boundary between Gemini and the world (PLAN.md §1.4).
// Node-safe: no three imports, no DOM.

import type { CreateResult, ObjectSpec, ObjectsApi, SceneObject, Vec3 } from '../contracts';

export const TRAY_XY: [number, number] = [-0.18, -0.13];
export const TRAY_HALF_M = 0.037;
export const ARM_XY: [number, number] = [0, -0.045];
const PIVOT_Y = -0.0452;

export const LIMITS = {
  widthMin: 15,
  widthMax: 45,
  heightMin: 10,
  heightMax: 60,
  rhoMin: 0.13,
  rhoMax: 0.21,
  bearingMax: 1.6,
  trayExclusion: 0.06,
  spacing: 0.04,
  maxObjects: 8,
  attachXY: 0.015,
  defaultDistance: 80,
  reachErrMm: 1,
};

const DEFAULT_SLOTS: [number, number][] = [
  [60, -210],
  [-60, -210],
  [0, -180],
  [110, -190],
];

/** Worst-case IK error (mm) at a table xy for a part of height h. Injected by the app. */
export type ReachProbe = (xy: [number, number], h: number) => number;

export type Validated = {
  ok: true;
  name: string;
  dims: { w: number; d: number; h: number };
  pos: Vec3;
  yaw: number;
  graspWidthMm: number;
};

export type ValidationFail = { ok: false; code: string; reason: string; suggestion?: string };

const round1 = (v: number) => Math.round(v * 10) / 10;

export function graspWidthMm(o: { shape: SceneObject['shape']; dims: { w: number; d: number } }): number {
  return o.shape === 'box' ? Math.min(o.dims.w, o.dims.d) * 1000 : o.dims.w * 1000;
}

export function insideTray(x: number, y: number, half = TRAY_HALF_M): boolean {
  return Math.abs(x - TRAY_XY[0]) < half && Math.abs(y - TRAY_XY[1]) < half;
}

export function validateObjectSpec(
  spec: ObjectSpec,
  existing: SceneObject[],
  reachProbe?: ReachProbe,
): Validated | ValidationFail {
  const fail = (code: string, reason: string, suggestion?: string): ValidationFail => ({ ok: false, code, reason, suggestion });

  if (!['box', 'cylinder', 'sphere'].includes(spec.shape)) {
    return fail('BAD_SHAPE', `${String(spec.shape)} is not a shape I can make; box, cylinder or sphere`, 'make it a box?');
  }
  if (existing.length >= LIMITS.maxObjects) {
    return fail('TOO_MANY', `there are already ${existing.length} parts on the table, the limit is ${LIMITS.maxObjects}`, 'remove one first?');
  }
  const wMm = Number(spec.width_mm);
  const dMm = spec.depth_mm != null && spec.shape === 'box' ? Number(spec.depth_mm) : wMm;
  let hMm = Number(spec.height_mm);
  if (spec.shape === 'sphere') hMm = wMm;
  if (!Number.isFinite(wMm) || !Number.isFinite(hMm) || !Number.isFinite(dMm)) {
    return fail('BAD_SIZE', 'I need a width and a height in millimetres', 'say a width like 30 mm?');
  }
  const gw = spec.shape === 'box' ? Math.min(wMm, dMm) : wMm;
  if (gw > LIMITS.widthMax) {
    return fail('TOO_WIDE', `${round1(gw)} mm is wider than the ${LIMITS.widthMax} mm the gripper can hold`, `make it ${LIMITS.widthMax - 5} mm?`);
  }
  if (gw < LIMITS.widthMin) {
    return fail('TOO_NARROW', `${round1(gw)} mm is narrower than the ${LIMITS.widthMin} mm the gripper can hold`, `make it ${LIMITS.widthMin + 5} mm?`);
  }
  if (hMm > LIMITS.heightMax) {
    return fail('TOO_TALL', `${round1(hMm)} mm is taller than the ${LIMITS.heightMax} mm limit`, `make it ${LIMITS.heightMax - 10} mm tall?`);
  }
  if (hMm < LIMITS.heightMin) {
    return fail('TOO_SHORT', `${round1(hMm)} mm is shorter than the ${LIMITS.heightMin} mm minimum`, `make it ${LIMITS.heightMin + 5} mm tall?`);
  }

  // ---- position ----
  let xMm: number | undefined;
  let yMm: number | undefined;
  if (spec.x_mm != null && spec.y_mm != null) {
    xMm = Number(spec.x_mm);
    yMm = Number(spec.y_mm);
  } else if (spec.relative_to) {
    const ref = spec.relative_to.toLowerCase();
    let base: [number, number] | null = null;
    if (ref === 'tray') base = [TRAY_XY[0] * 1000, TRAY_XY[1] * 1000];
    else if (ref === 'arm') base = [ARM_XY[0] * 1000, ARM_XY[1] * 1000];
    else {
      const o = existing.find((e) => e.id.toLowerCase() === ref || e.name.toLowerCase() === ref);
      if (!o) return fail('NO_REFERENCE', `I don't see a part called ${spec.relative_to} on the table`, 'name a part that is there, or give me x and y?');
      base = [o.pos[0] * 1000, o.pos[1] * 1000];
    }
    const dist = spec.distance_mm != null ? Number(spec.distance_mm) : LIMITS.defaultDistance;
    const dir = spec.direction ?? 'right';
    const off: Record<string, [number, number]> = { left: [-dist, 0], right: [dist, 0], front: [0, -dist], behind: [0, dist] };
    const o = off[dir] ?? off.right;
    xMm = base[0] + o[0];
    yMm = base[1] + o[1];
  } else {
    for (const s of DEFAULT_SLOTS) {
      const free = existing.every((e) => Math.hypot(e.pos[0] * 1000 - s[0], e.pos[1] * 1000 - s[1]) >= LIMITS.spacing * 1000);
      if (free) {
        [xMm, yMm] = s;
        break;
      }
    }
    if (xMm == null || yMm == null) return fail('NO_FREE_SPOT', 'the usual spots are all taken', 'tell me where to put it, in millimetres?');
  }
  if (!Number.isFinite(xMm) || !Number.isFinite(yMm)) return fail('BAD_POSITION', 'I need a position in millimetres', 'say something like 60 mm right of the block?');

  const x = xMm / 1000;
  const y = yMm / 1000;
  const rho = Math.hypot(x, y - PIVOT_Y);
  const bearing = Math.atan2(x, -(y - PIVOT_Y));
  if (rho < LIMITS.rhoMin) {
    return fail('TOO_CLOSE', `${Math.round(rho * 1000)} mm from the base is too close for the arm; it needs at least ${LIMITS.rhoMin * 1000} mm`, 'move it further out?');
  }
  if (rho > LIMITS.rhoMax) {
    return fail('TOO_FAR', `${Math.round(rho * 1000)} mm from the base is out of reach; the arm reaches ${LIMITS.rhoMax * 1000} mm`, 'move it closer to the base?');
  }
  if (Math.abs(bearing) > LIMITS.bearingMax) {
    return fail('BEHIND_ARM', 'that spot is behind the arm where it cannot reach', 'put it in front of the arm?');
  }
  if (Math.abs(x - TRAY_XY[0]) < LIMITS.trayExclusion && Math.abs(y - TRAY_XY[1]) < LIMITS.trayExclusion) {
    return fail('ON_TRAY', 'that spot is on the tray; parts start on the table', 'put it 80 mm to the right of the tray?');
  }
  for (const e of existing) {
    const d = Math.hypot(e.pos[0] - x, e.pos[1] - y);
    if (d < LIMITS.spacing) {
      return fail('TOO_CLOSE_TO', `that is only ${Math.round(d * 1000)} mm from ${e.name}; parts need ${LIMITS.spacing * 1000} mm between centres`, `put it ${LIMITS.defaultDistance} mm away instead?`);
    }
  }
  if (reachProbe) {
    const err = reachProbe([x, y], hMm / 1000);
    if (err > LIMITS.reachErrMm) {
      return fail('UNREACHABLE', `the arm cannot reach that spot cleanly (${round1(err)} mm off at best)`, 'move it a little closer to the base?');
    }
  }

  const name = (spec.name && spec.name.trim()) || `${spec.color} ${spec.shape}`;
  return {
    ok: true,
    name,
    dims: { w: wMm / 1000, d: dMm / 1000, h: hMm / 1000 },
    pos: [x, y, hMm / 2000],
    yaw: ((spec.yaw_deg ?? 0) * Math.PI) / 180,
    graspWidthMm: gw,
  };
}

export class ObjectRegistry implements ObjectsApi {
  private objs = new Map<string, SceneObject>();
  private counters: Record<string, number> = {};
  private listeners = new Set<() => void>();
  reachProbe?: ReachProbe;

  constructor(private readonly seedBlock: Vec3 = [0, -0.23, 0.012]) {
    this.reset();
  }

  /** Apply (or clear) a generated print on a part's faces. The scene picks it up on its next sync. */
  setTexture(id: string, dataUrl: string | null): boolean {
    const o = this.objs.get(id);
    if (!o) return false;
    o.texture = dataUrl ?? undefined;
    this.emit();
    return true;
  }

  /** Subscribe to registry changes (create/remove/reset). */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit(): void {
    for (const cb of [...this.listeners]) cb();
  }

  list(): SceneObject[] {
    return [...this.objs.values()];
  }

  get(id: string): SceneObject | undefined {
    return this.objs.get(id);
  }

  reset(): void {
    this.objs.clear();
    this.counters = { block: 1 };
    this.objs.set('block_1', {
      id: 'block_1',
      name: 'red block',
      color: 'red',
      shape: 'box',
      dims: { w: 0.024, d: 0.024, h: 0.024 },
      pos: [...this.seedBlock] as Vec3,
      yaw: 0,
      held: false,
      createdBy: 'seed',
    });
    this.emit();
  }

  create(spec: ObjectSpec, createdBy: SceneObject['createdBy'] = 'text'): CreateResult {
    const v = validateObjectSpec(spec, this.list(), this.reachProbe);
    if (!v.ok) return v;
    const key = spec.shape === 'box' ? 'block' : spec.shape;
    const n = (this.counters[key] ?? 0) + 1;
    this.counters[key] = n;
    const obj: SceneObject = {
      id: `${key}_${n}`,
      name: v.name,
      color: spec.color,
      shape: spec.shape,
      dims: v.dims,
      pos: v.pos,
      yaw: v.yaw,
      held: false,
      createdBy,
    };
    this.objs.set(obj.id, obj);
    this.emit();
    return { ok: true, obj };
  }

  remove(id: string): boolean {
    const ok = this.objs.delete(id);
    if (ok) this.emit();
    return ok;
  }

  nearest(xy: [number, number]): SceneObject | undefined {
    let best: SceneObject | undefined;
    let bd = Infinity;
    for (const o of this.objs.values()) {
      const d = Math.hypot(o.pos[0] - xy[0], o.pos[1] - xy[1]);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  /**
   * Attach rule (no physics, PLAN.md §1.3): an unheld object attaches on jaw close if its
   * centre is within `radius` (xy) of the tcp and its bottom is within [tcp.z-(h/2+0.02), tcp.z+0.005].
   * The lower bound follows the part height because pick() descends to graspZ(h) = max(0.027, h/2+0.015):
   * a fixed 0.03 window excluded every part taller than 30 mm (G3 checker finding, 14:21).
   */
  attachCandidate(tcp: Vec3, radius = LIMITS.attachXY): SceneObject | null {
    let best: SceneObject | null = null;
    let bd = Infinity;
    for (const o of this.objs.values()) {
      if (o.held) continue;
      const d = Math.hypot(o.pos[0] - tcp[0], o.pos[1] - tcp[1]);
      const bottom = o.pos[2] - o.dims.h / 2;
      const below = Math.max(0.03, o.dims.h / 2 + 0.02);
      if (d <= radius && bottom >= tcp[2] - below && bottom <= tcp[2] + 0.005 && d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  /** Rest height (centre z) for an object released at xy. */
  restZ(o: SceneObject, x: number, y: number): number {
    // No physics: a released part rests on the tray floor, the table, or the top of the highest
    // unheld part whose footprint overlaps (circle approximation), so parts stack instead of interpenetrating.
    let top = insideTray(x, y) ? 0.006 : 0;
    const rO = Math.max(o.dims.w, o.dims.d) / 2;
    for (const p of this.objs.values()) {
      if (p.id === o.id || p.held) continue;
      const rP = Math.max(p.dims.w, p.dims.d) / 2;
      if (Math.hypot(p.pos[0] - x, p.pos[1] - y) < rO + rP) top = Math.max(top, p.pos[2] + p.dims.h / 2);
    }
    return top + o.dims.h / 2;
  }
}
