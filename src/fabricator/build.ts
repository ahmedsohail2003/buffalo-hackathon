// Shape program -> one merged three.js BufferGeometry (metres, z up, bounding-box centre at the origin).
// Core three geometries only, node-safe (no DOM, no loaders): vitest builds and measures these in node.
// Every part is converted to non-indexed position/normal/color so mergeGeometries accepts the set.

import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  Float32BufferAttribute,
  IcosahedronGeometry,
  LatheGeometry,
  Matrix4,
  Quaternion,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { FabPart, FabProgram } from './types';
import { MAX_INSTANCES, partDensity } from './program';

// ---------------------------------------------------------------- seeded noise

/** Deterministic lattice hash in [-1, 1]. */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177) + Math.imul(seed, 144269504)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

/** Trilinear value noise with smoothstep fade, roughly [-1, 1]. */
function vnoise(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  let acc = 0;
  for (let dx = 0; dx < 2; dx++)
    for (let dy = 0; dy < 2; dy++)
      for (let dz = 0; dz < 2; dz++) {
        const wt = (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
        acc += wt * hash3(xi + dx, yi + dy, zi + dz, seed);
      }
  return acc;
}

/** Fractal value noise (4 octaves), roughly [-1, 1]. */
export function fbm(x: number, y: number, z: number, seed: number, octaves = 4): number {
  let a = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    a += amp * vnoise(x * f, y * f, z * f, seed + i * 101);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return a / norm;
}

/** mulberry32: small seeded PRNG in [0, 1). */
function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- assets (NASA shape models)

/** public/assets/samples/<id>.json: positions in metres, z up, bbox-centred; triangle indices. */
export interface AssetFile {
  positions: number[];
  indices: number[];
  dimsMm?: { w: number; d: number; h: number };
  graspWidthMm?: number;
}
/** unit-radius geometry (mm units after scaling by radius) + the model's own bounding radius, mm */
const assets = new Map<string, { unit: BufferGeometry; radiusMm: number }>();

/** Register a real shape model. The browser loads them in assets.ts; node tests may register from disk. */
export function registerAsset(id: string, data: AssetFile): void {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(data.positions, 3));
  g.setIndex(data.indices);
  g.computeBoundingSphere();
  const r = g.boundingSphere!.radius || 1;
  g.scale(1 / r, 1 / r, 1 / r);
  g.computeVertexNormals();
  assets.set(id, { unit: g, radiusMm: r * 1000 });
}
export const hasAsset = (id: string): boolean => assets.has(id);

// ---------------------------------------------------------------- parts (mm, base on z = 0)

const SEG = 40;

/** Geometry with only position/normal (+ color added later), non-indexed. */
function prep(g: BufferGeometry): BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(out.attributes)) if (name !== 'position' && name !== 'normal') out.deleteAttribute(name);
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  return out;
}

function paint(g: BufferGeometry, hex: string, shade?: Float32Array): void {
  const c = new Color(hex); // sRGB hex -> linear working colour
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = shade ? shade[i] : 1;
    col[i * 3] = c.r * k;
    col[i * 3 + 1] = c.g * k;
    col[i * 3 + 2] = c.b * k;
  }
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
}

/** Asteroid / meteorite lump: icosphere displaced by seeded fbm, crater dents, elongation, flat cut base. */
function rockGeometry(r: number, k: NonNullable<FabPart['rock']>, hex: string): BufferGeometry {
  const base = new IcosahedronGeometry(1, 12); // non-indexed, 3380 triangles
  base.deleteAttribute('normal');
  base.deleteAttribute('uv');
  const pos = base.getAttribute('position');
  const n = pos.count;
  const rand = rng(k.seed * 2654435761);
  const craters = Array.from({ length: k.craters }, () => {
    const u = rand() * 2 - 1, phi = rand() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    return { c: new Vector3(s * Math.cos(phi), s * Math.sin(phi), u), a: 0.2 + rand() * 0.25, depth: 0.05 + rand() * 0.07 };
  });
  const [ex, ey, ez] = k.elongation ?? [1, 1, 1];
  const freq = k.frequency ?? 1.6;
  const shade = new Float32Array(n);
  const d = new Vector3();
  for (let i = 0; i < n; i++) {
    d.fromBufferAttribute(pos, i).normalize();
    let f = 1 + k.roughness * 0.32 * fbm(d.x * freq + 11.3, d.y * freq - 4.1, d.z * freq + 7.7, k.seed);
    let sh = 0.86 + 0.22 * fbm(d.x * 4.2, d.y * 4.2, d.z * 4.2, k.seed + 17);
    for (const cr of craters) {
      const ang = Math.acos(Math.min(1, Math.max(-1, cr.c.dot(d))));
      if (ang < cr.a) {
        const t = ang / cr.a;
        f -= cr.depth * (1 - t * t);
        sh *= 0.8 + 0.2 * t;
      }
      const rim = (ang - cr.a) / (0.3 * cr.a);
      if (Math.abs(rim) < 1) f += 0.22 * cr.depth * Math.cos((rim * Math.PI) / 2) ** 2;
    }
    f = Math.max(0.55, f);
    pos.setXYZ(i, d.x * f * r * ex, d.y * f * r * ey, d.z * f * r * ez);
    shade[i] = sh;
  }
  // lab-sample cut face: clamp everything below a plane so the rock rests on a flat facet
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i < n; i++) {
    const z = pos.getZ(i);
    if (z < zmin) zmin = z;
    if (z > zmax) zmax = z;
  }
  const zcut = zmin + (k.flat_base ?? 0) * (zmax - zmin);
  if (zcut > zmin) for (let i = 0; i < n; i++) if (pos.getZ(i) < zcut) pos.setZ(i, zcut);
  base.setAttribute('color', new Float32BufferAttribute(new Float32Array(n * 3), 3));
  paint(base, hex, shade);
  const smooth = mergeVertices(base, 1e-6);
  smooth.computeVertexNormals();
  const out = smooth.toNonIndexed();
  out.translate(0, 0, -zcut);
  return out;
}

function assetGeometry(p: FabPart, hex: string): BufferGeometry {
  const a = p.asset ? assets.get(p.asset) : undefined;
  if (!a) throw new Error(`shape model ${p.asset ?? '?'} is not loaded`);
  const r = p.radius_mm ?? a.radiusMm;
  const g = a.unit.clone().toNonIndexed(); // never touch the cached model itself
  g.scale(r, r, r);
  g.computeBoundingBox();
  g.translate(0, 0, -g.boundingBox!.min.z);
  const out = prep(g);
  paint(out, hex, assetShade(out));
  return out;
}

/** Gentle albedo mottling for shape models (they carry no texture). */
function assetShade(g: BufferGeometry): Float32Array {
  const pos = g.getAttribute('position');
  const shade = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) shade[i] = 0.84 + 0.24 * fbm(pos.getX(i) * 0.15, pos.getY(i) * 0.15, pos.getZ(i) * 0.15, 77);
  return shade;
}

/** One part in its own frame (mm): base on z = 0, centred on x = y = 0; colour attribute set. */
function partGeometry(p: FabPart, prog: FabProgram): BufferGeometry {
  const hex = p.color ?? prog.color;
  const r = p.radius_mm ?? 15;
  const h = p.height_mm ?? 30;
  let g: BufferGeometry;
  switch (p.kind) {
    case 'box': {
      const [x, y, z] = p.size_mm ?? [20, 20, 20];
      g = new BoxGeometry(x, y, z).translate(0, 0, z / 2);
      break;
    }
    case 'cylinder':
      g = new CylinderGeometry(r, r, h, SEG).rotateX(Math.PI / 2).translate(0, 0, h / 2);
      break;
    case 'cone':
      g = new CylinderGeometry(p.radius2_mm ?? 0, r, h, SEG).rotateX(Math.PI / 2).translate(0, 0, h / 2);
      break;
    case 'sphere':
      g = new SphereGeometry(r, 32, 20).translate(0, 0, r);
      break;
    case 'torus': {
      const t = p.radius2_mm ?? r / 4;
      g = new TorusGeometry(r, t, 16, 48).translate(0, 0, t);
      break;
    }
    case 'capsule': {
      const len = Math.max(0, h - 2 * r);
      g = new CapsuleGeometry(r, len, 8, 24).rotateX(Math.PI / 2).translate(0, 0, len / 2 + r);
      break;
    }
    case 'lathe': {
      const prof = [...(p.profile_mm ?? [[10, 0], [10, 20]])];
      if (prof[0][0] > 0) prof.unshift([0, prof[0][1]]); // close the bottom
      if (prof[prof.length - 1][0] > 0) prof.push([0, prof[prof.length - 1][1]]); // close the top
      g = new LatheGeometry(prof.map(([rr, z]) => new Vector2(rr, z)), SEG).rotateX(Math.PI / 2);
      break;
    }
    case 'extrude': {
      const shape = new Shape((p.outline_mm ?? []).map(([x, y]) => new Vector2(x, y)));
      g = new ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 1 });
      break;
    }
    case 'rock':
      return rockGeometry(r, p.rock ?? { seed: 1, roughness: 0.45, craters: 3 }, hex);
    case 'asset':
      return assetGeometry(p, hex);
    default:
      g = new BoxGeometry(20, 20, 20).translate(0, 0, 10);
  }
  const out = prep(g);
  paint(out, hex);
  return out;
}

const _q = new Quaternion();
const _e = new Euler();
const _one = new Vector3(1, 1, 1);
const deg = (v: number) => (v * Math.PI) / 180;

function partMatrix(p: FabPart): Matrix4 {
  const [x, y, z] = p.pos_mm ?? [0, 0, 0];
  const [rx, ry, rz] = p.rot_deg ?? [0, 0, 0];
  _q.setFromEuler(_e.set(deg(rx), deg(ry), deg(rz), 'XYZ'));
  return new Matrix4().compose(new Vector3(x, y, z), _q.clone(), _one);
}

function stepMatrix(p: FabPart, i: number): Matrix4 {
  const sm = p.repeat?.step_mm ?? [0, 0, 0];
  const sd = p.repeat?.step_deg ?? [0, 0, 0];
  _q.setFromEuler(_e.set(deg(sd[0] * i), deg(sd[1] * i), deg(sd[2] * i), 'XYZ'));
  return new Matrix4().compose(new Vector3(sm[0] * i, sm[1] * i, sm[2] * i), _q.clone(), _one);
}

/** Signed volume (divergence theorem) of a non-indexed triangle soup, in the geometry's units cubed. */
export function signedVolume(g: BufferGeometry): number {
  const a = g.getAttribute('position').array as ArrayLike<number>;
  let v = 0;
  for (let i = 0; i + 8 < a.length; i += 9) {
    const x0 = a[i], y0 = a[i + 1], z0 = a[i + 2], x1 = a[i + 3], y1 = a[i + 4], z1 = a[i + 5], x2 = a[i + 6], y2 = a[i + 7], z2 = a[i + 8];
    v += x0 * (y1 * z2 - z1 * y2) - y0 * (x1 * z2 - z1 * x2) + z0 * (x1 * y2 - y1 * x2);
  }
  return v / 6;
}

export interface BuiltShape {
  /** metres, z up, bounding-box centre at the origin, non-indexed position/normal/color */
  geometry: BufferGeometry;
  /** volume-weighted density of the parts, g/cm^3 */
  densityGcm3: number;
  /** labels of parts whose bounding box sits far from every other part (a placement bug) */
  floating: string[];
  instances: number;
}

/** Build a sanitized program into one merged geometry. */
export function buildShape(prog: FabProgram): BuiltShape {
  const geoms: BufferGeometry[] = [];
  const boxes: { label: string; min: Vector3; max: Vector3 }[] = [];
  let volW = 0, vol = 0;
  prog.parts.forEach((p, pi) => {
    const local = partGeometry(p, prog);
    const n = Math.max(1, p.repeat?.count ?? 1);
    const m = partMatrix(p);
    const rho = partDensity(p, prog);
    for (let i = 0; i < n && geoms.length < MAX_INSTANCES; i++) {
      const g = i === n - 1 ? local : local.clone();
      g.applyMatrix4(i === 0 ? m : stepMatrix(p, i).multiply(m));
      g.computeBoundingBox();
      const bb = g.boundingBox!;
      boxes.push({ label: `part ${pi + 1} (${p.kind})`, min: bb.min.clone(), max: bb.max.clone() });
      const v = Math.abs(signedVolume(g));
      vol += v;
      volW += v * rho;
      geoms.push(g);
    }
  });
  const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
  if (!merged) throw new Error('could not merge the parts');
  for (const g of geoms) if (g !== merged) g.dispose();
  // floating: nearest-box gap > 12 % of the overall diagonal
  const floating: string[] = [];
  if (boxes.length > 1) {
    const all = { min: new Vector3(Infinity, Infinity, Infinity), max: new Vector3(-Infinity, -Infinity, -Infinity) };
    for (const b of boxes) {
      all.min.min(b.min);
      all.max.max(b.max);
    }
    const diag = all.max.clone().sub(all.min).length();
    const gap = (a: (typeof boxes)[number], b: (typeof boxes)[number]) =>
      Math.hypot(...(['x', 'y', 'z'] as const).map((k) => Math.max(a.min[k] - b.max[k], b.min[k] - a.max[k], 0)));
    boxes.forEach((b, i) => {
      const nearest = Math.min(...boxes.filter((_, j) => j !== i).map((o) => gap(b, o)));
      if (nearest > 0.12 * diag && !floating.includes(b.label)) floating.push(b.label);
    });
  }
  merged.scale(0.001, 0.001, 0.001);
  recentre(merged);
  return { geometry: merged, densityGcm3: vol > 0 ? volW / vol : prog.density_g_cm3, floating, instances: geoms.length };
}

/** Merged geometry of a program (metres, centred). */
export function buildGeometry(prog: FabProgram): BufferGeometry {
  return buildShape(prog).geometry;
}

/** Move the bounding-box centre to the origin (SceneObject.pos is the centre). */
export function recentre(g: BufferGeometry): BufferGeometry {
  g.computeBoundingBox();
  const c = g.boundingBox!.getCenter(new Vector3());
  g.translate(-c.x, -c.y, -c.z);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * Bake the grasp orientation and the guardrail scale into the geometry (in place): turn it by -bakedYaw
 * about z so its narrowest width lies along local +x (the jaw always closes along the object's local x),
 * then scale uniformly and re-centre.
 */
export function orientGeometry(g: BufferGeometry, bakedYaw: number, scale: number): BufferGeometry {
  if (bakedYaw) g.rotateZ(-bakedYaw);
  if (scale !== 1) g.scale(scale, scale, scale);
  return recentre(g);
}

/** The exact geometry of a fabricated sample: built, turned by -bakedYaw about z, scaled, centred. */
export function buildBakedGeometry(program: FabProgram, bakedYaw: number, scale: number): BufferGeometry {
  return orientGeometry(buildGeometry(program), bakedYaw, scale);
}

/** Surface look of a program: part roughness/metalness averaged, translucent if any part asks. */
export function materialParams(prog: FabProgram): { roughness: number; metalness: number; opacity: number; transparent: boolean } {
  const n = Math.max(1, prog.parts.length);
  const roughness = prog.parts.reduce((s, p) => s + (p.roughness ?? (p.kind === 'rock' || p.kind === 'asset' ? 0.92 : 0.55)), 0) / n;
  const metalness = prog.parts.reduce((s, p) => s + (p.metalness ?? (p.kind === 'rock' || p.kind === 'asset' ? 0.05 : 0.15)), 0) / n;
  const opacity = Math.min(1, ...prog.parts.map((p) => p.opacity ?? 1));
  // Rendered without an environment map: real metal values read as black, so cap what the material shows.
  return { roughness: Math.max(0.25, roughness), metalness: Math.min(0.45, metalness), opacity, transparent: opacity < 0.99 };
}
