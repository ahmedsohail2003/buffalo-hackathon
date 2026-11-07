// Shape programs: the JSON a designer (Gemini or a preset) proposes for a sample, the JSON Schema
// handed to Gemini, and the sanitizer that turns any input into a safe, bounded program.
// A program is a request, never trusted: every number is clamped here, before geometry exists.
// Node-safe: no three, no DOM.

import type { FabPart, FabProgram, ProgramCategory, SampleMaterial } from './types';

export const KINDS = ['box', 'cylinder', 'sphere', 'cone', 'torus', 'capsule', 'rock', 'lathe', 'extrude', 'asset'] as const;
export const CATEGORIES = ['asteroid', 'meteorite', 'canister', 'satellite_part', 'crystal', 'tool', 'other'] as const;
/** NASA shape models shipped under public/assets/samples. */
export const KNOWN_ASSETS = ['bennu', 'itokawa', 'eros', 'kleopatra'] as const;
export const MAX_PARTS = 12;
/** Instances after expanding `repeat` (keeps the mesh small). */
export const MAX_INSTANCES = 48;

/** Code owns densities (g/cm^3): the designer names a material, never a number. */
export const MATERIAL_DENSITY: Record<SampleMaterial, number> = {
  rubble_pile: 1.2, // Bennu-like rubble / porous carbonaceous material (Bennu bulk ~1.19)
  chondrite: 2.2, // carbonaceous chondrite meteorite
  basalt: 3.3, // basalt / stony meteorite
  iron_meteorite: 7.8,
  ice: 0.92,
  crystal: 2.65, // quartz
  glass: 2.5,
  ceramic: 2.4,
  aluminum: 2.7,
  hollow_aluminum: 1.0, // thin-walled canister, effective bulk density
  titanium: 4.5,
  steel: 7.85,
  gold_foil: 1.2, // MLI blanket: foil over a light core
  plastic: 1.24, // PLA
  carbon_fiber: 1.6,
  foam: 0.1,
};
export const MATERIALS = Object.keys(MATERIAL_DENSITY) as SampleMaterial[];

const DEFAULT_COLOR = '#8a8580';

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const pairs = (max: number, what: string) => ({ type: 'array', maxItems: max, description: what, items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } });

/** JSON Schema for Gemini `responseJsonSchema`. Only widely supported keywords; code re-validates everything. */
export const PROGRAM_JSON_SCHEMA = {
  type: 'object',
  description: 'A small sample for a robot glovebox. Millimetres, z up, the deck is z = 0. Every part starts with its base on z = 0 centred on x = y = 0; rot_deg turns it about its base centre, then pos_mm moves it.',
  properties: {
    name: { type: 'string', description: 'Short display name, e.g. "Bennu fragment".' },
    category: { type: 'string', enum: [...CATEGORIES] },
    description: { type: 'string', description: 'One sentence about the real object.' },
    color: { type: 'string', description: 'Default #RRGGBB colour.' },
    material: { type: 'string', enum: MATERIALS, description: 'Default material; code owns its density.' },
    parts: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_PARTS,
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: KINDS.filter((p) => p !== 'asset') },
          size_mm: { ...vec3, description: 'box only: [x, y, z] mm.' },
          radius_mm: { type: 'number', description: 'Radius (half the diameter): cylinder, sphere, cone bottom, torus ring, capsule, rock.' },
          radius2_mm: { type: 'number', description: 'cone top radius (0 = point) or torus tube radius.' },
          height_mm: { type: 'number', description: 'cylinder, cone, capsule (total) or extrude height.' },
          profile_mm: pairs(24, 'lathe only: [radius, z] points bottom to top, revolved about z.'),
          outline_mm: pairs(24, 'extrude only: closed [x, y] outline, extruded up by height_mm.'),
          rock: {
            type: 'object',
            description: 'rock only: a noise-displaced lump.',
            properties: {
              seed: { type: 'integer' },
              roughness: { type: 'number', description: '0 smooth pebble .. 1 jagged.' },
              craters: { type: 'integer', description: '0-12 impact pits.' },
              elongation: { ...vec3, description: 'Stretch [x, y, z], e.g. [1.3, 0.9, 0.7].' },
              flat_base: { type: 'number', description: 'Fraction of the height cut flat at the bottom so it rests stably, 0-0.35.' },
            },
          },
          repeat: {
            type: 'object',
            description: 'count copies; copy i moves by i*step_mm and turns by i*step_deg about the object origin.',
            properties: { count: { type: 'integer' }, step_mm: vec3, step_deg: vec3 },
          },
          pos_mm: vec3,
          rot_deg: vec3,
          color: { type: 'string', description: '#RRGGBB' },
          material: { type: 'string', enum: MATERIALS },
          metalness: { type: 'number' },
          roughness: { type: 'number' },
          opacity: { type: 'number', description: '0.3-1, below 1 is translucent (ice, glass).' },
        },
        required: ['kind'],
      },
    },
  },
  required: ['name', 'category', 'color', 'material', 'parts'],
} as const;

const NAMED: Record<string, string> = {
  black: '#1c1c1c', white: '#f2f2f2', grey: '#8a8a8a', gray: '#8a8a8a', red: '#c0392b', green: '#2e8b57', blue: '#2f5db8',
  yellow: '#e2b93b', orange: '#e07a2e', brown: '#6b4a32', silver: '#c0c4cc', gold: '#d4a017', copper: '#b87333',
  purple: '#7d4fb3', cyan: '#5bc8d9', teal: '#2a8c8c', tan: '#b8a07a', charcoal: '#36454f', rust: '#8e3b1f', ice: '#cfe8f7',
};

/** '#rrggbb' from a hex string or a few colour names; null if unusable. */
export function cleanColor(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return '#' + s.slice(1).split('').map((c) => c + c).join('');
  return NAMED[s] ?? null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Finite number clamped into [lo, hi], else the default. */
function num(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? clamp(n, lo, hi) : dflt;
}
function optNum(v: unknown, lo: number, hi: number): number | undefined {
  const n = num(v, lo, hi, NaN);
  return Number.isFinite(n) ? n : undefined;
}
function tri(v: unknown, lo: number, hi: number, dflt: [number, number, number]): [number, number, number] {
  if (!Array.isArray(v)) return [...dflt];
  return [num(v[0], lo, hi, dflt[0]), num(v[1], lo, hi, dflt[1]), num(v[2], lo, hi, dflt[2])];
}
function material(v: unknown): SampleMaterial | undefined {
  return typeof v === 'string' && v in MATERIAL_DENSITY ? (v as SampleMaterial) : undefined;
}
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Lathe profile: <= 24 points, r 0-60 mm, z strictly ascending (sorted, 0.1 mm apart). */
function cleanProfile(v: unknown): [number, number][] | null {
  if (!Array.isArray(v)) return null;
  const pts = v
    .filter((p): p is unknown[] => Array.isArray(p) && p.length >= 2)
    .map((p) => [num(p[0], 0, 60, NaN), num(p[1], -80, 120, NaN)] as [number, number])
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .slice(0, 24)
    .sort((a, b) => a[1] - b[1]);
  for (let i = 1; i < pts.length; i++) if (pts[i][1] < pts[i - 1][1] + 0.1) pts[i][1] = pts[i - 1][1] + 0.1;
  return pts.length >= 2 && pts.some((p) => p[0] > 0.5) ? pts : null;
}

/** Extrude outline: 3-24 points within +/-60 mm with a non-zero area. */
function cleanOutline(v: unknown): [number, number][] | null {
  if (!Array.isArray(v)) return null;
  const pts = v
    .filter((p): p is unknown[] => Array.isArray(p) && p.length >= 2)
    .map((p) => [num(p[0], -60, 60, NaN), num(p[1], -60, 60, NaN)] as [number, number])
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .slice(0, 24);
  if (pts.length < 3) return null;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    a += x0 * y1 - x1 * y0;
  }
  if (Math.abs(a) / 2 < 1) return null;
  return a < 0 ? pts.reverse() : pts; // counter-clockwise
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % 100000;
}

/** Sanitize one part; null drops it (unknown prim, unusable profile/outline/asset). */
function cleanPart(raw: unknown, index: number, programColor: string, nameSeed: number): FabPart | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = { ...(raw as Record<string, unknown>) }; // never mutate the caller's object
  const kind = typeof r.kind === 'string' ? r.kind.toLowerCase() : typeof r.prim === 'string' ? r.prim.toLowerCase() : '';
  if (!(KINDS as readonly string[]).includes(kind)) return null;
  const p: FabPart = { kind: kind as FabPart['kind'] };
  // accept a diameter where a radius is expected (designers often think in diameters)
  if (r.radius_mm == null && r.diameter_mm != null) r.radius_mm = Number(r.diameter_mm) / 2;
  const size = (v: unknown, d: number) => num(v, 1, 120, d);
  switch (p.kind) {
    case 'box':
      p.size_mm = tri(r.size_mm, 1, 120, [20, 20, 20]);
      break;
    case 'sphere':
      p.radius_mm = size(r.radius_mm, 15);
      break;
    case 'cylinder':
      p.radius_mm = size(r.radius_mm, 15);
      p.height_mm = size(r.height_mm, 30);
      break;
    case 'cone':
      p.radius_mm = size(r.radius_mm, 15);
      p.radius2_mm = num(r.radius2_mm, 0, 120, 0);
      p.height_mm = size(r.height_mm, 30);
      break;
    case 'torus':
      p.radius_mm = size(r.radius_mm, 15);
      p.radius2_mm = num(r.radius2_mm, 1, 60, Math.max(1, (p.radius_mm ?? 15) / 4));
      break;
    case 'capsule':
      p.radius_mm = size(r.radius_mm, 10);
      p.height_mm = size(r.height_mm, 30);
      break;
    case 'rock': {
      p.radius_mm = size(r.radius_mm, 15);
      const k = (r.rock && typeof r.rock === 'object' ? r.rock : {}) as Record<string, unknown>;
      p.rock = {
        seed: Math.round(num(k.seed, 0, 1e6, nameSeed + index * 7919)),
        roughness: num(k.roughness ?? k.bumpiness, 0, 1, 0.45),
        craters: Math.round(num(k.craters, 0, 12, 3)),
        elongation: tri(k.elongation, 0.4, 2.5, [1, 1, 1]),
        frequency: num(k.frequency, 0.5, 4, 1.6),
        flat_base: num(k.flat_base, 0, 0.35, 0.12),
      };
      break;
    }
    case 'lathe': {
      const prof = cleanProfile(r.profile_mm);
      if (!prof) return null;
      p.profile_mm = prof;
      break;
    }
    case 'extrude': {
      const out = cleanOutline(r.outline_mm);
      if (!out) return null;
      p.outline_mm = out;
      p.height_mm = size(r.height_mm, 10);
      break;
    }
    case 'asset': {
      const id = typeof r.asset === 'string' ? r.asset.toLowerCase() : '';
      if (!(KNOWN_ASSETS as readonly string[]).includes(id)) return null;
      p.asset = id;
      const ar = optNum(r.radius_mm, 1, 120);
      if (ar !== undefined) p.radius_mm = ar; // absent = the model's own size
      break;
    }
  }
  if (r.repeat && typeof r.repeat === 'object') {
    const rp = r.repeat as Record<string, unknown>;
    const count = Math.round(num(rp.count, 1, 12, 1));
    if (count > 1) p.repeat = { count, step_mm: tri(rp.step_mm, -40, 40, [0, 0, 0]), step_deg: tri(rp.step_deg, -360, 360, [0, 0, 0]) };
  }
  p.pos_mm = tri(r.pos_mm ?? r.position_mm, -80, 80, [0, 0, 0]);
  p.rot_deg = tri(r.rot_deg ?? r.rotation_deg, -360, 360, [0, 0, 0]);
  p.color = cleanColor(r.color) ?? programColor;
  const m = material(r.material);
  if (m) p.material = m;
  const metal = optNum(r.metalness, 0, 1);
  if (metal !== undefined) p.metalness = metal;
  const rough = optNum(r.roughness, 0, 1);
  if (rough !== undefined) p.roughness = rough;
  const op = optNum(r.opacity, 0.3, 1);
  if (op !== undefined && op < 1) p.opacity = op;
  return p;
}

/** The program every unusable input falls back to: one plain rock. */
export function fallbackProgram(name = 'sample'): FabProgram {
  return {
    name,
    category: 'other',
    color: DEFAULT_COLOR,
    material: 'chondrite',
    density_g_cm3: MATERIAL_DENSITY.chondrite,
    parts: [{ kind: 'rock', radius_mm: 15, rock: { seed: hashString(name), roughness: 0.45, craters: 3, elongation: [1.15, 0.95, 0.8], frequency: 1.6, flat_base: 0.12 }, pos_mm: [0, 0, 0], rot_deg: [0, 0, 0], color: DEFAULT_COLOR }],
  };
}

export interface SanitizeOptions {
  /** Accept a raw density_g_cm3 number (presets). Gemini programs pass false: code owns densities via materials. */
  allowDensity?: boolean;
}

/** Turn anything into a bounded FabProgram. Never throws; junk becomes a single rock. */
export function sanitizeProgram(raw: unknown, opts: SanitizeOptions = {}): FabProgram {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallbackProgram();
    const r = raw as Record<string, unknown>;
    const name = str(r.name, 40) || 'sample';
    const color = cleanColor(r.color) ?? DEFAULT_COLOR;
    const category: ProgramCategory = (CATEGORIES as readonly string[]).includes(String(r.category)) ? (r.category as ProgramCategory) : 'other';
    const mat = material(r.material);
    const allowDensity = opts.allowDensity ?? true;
    const rawDensity = allowDensity ? optNum(r.density_g_cm3, 0.3, 8) : undefined;
    const density = rawDensity ?? (mat ? MATERIAL_DENSITY[mat] : MATERIAL_DENSITY.chondrite);
    const seed = hashString(name);
    const parts = (Array.isArray(r.parts) ? r.parts : [])
      .slice(0, MAX_PARTS * 2)
      .map((p, i) => cleanPart(p, i, color, seed))
      .filter((p): p is FabPart => !!p)
      .slice(0, MAX_PARTS);
    if (!parts.length) return { ...fallbackProgram(name), color, parts: fallbackProgram(name).parts.map((p) => ({ ...p, color })) };
    const out: FabProgram = { name, category, color, parts, density_g_cm3: Math.round(density * 1000) / 1000 };
    if (mat) out.material = mat;
    const desc = str(r.description, 200);
    if (desc) out.description = desc;
    return out;
  } catch {
    return fallbackProgram();
  }
}

/** Density of one part: its own material, else the program material, else the program density. */
export function partDensity(p: FabPart, prog: FabProgram): number {
  if (p.material) return MATERIAL_DENSITY[p.material];
  if (prog.material && !(prog.density_g_cm3 > 0)) return MATERIAL_DENSITY[prog.material];
  return prog.density_g_cm3 > 0 ? prog.density_g_cm3 : MATERIAL_DENSITY.chondrite;
}
