// Curated sample programs: always available, no API key needed. Sizes are realistic; the guardrail
// scales them to the gripper (the iron meteorite is shrunk for mass, Eros for its length) or refuses
// (the antenna boom is too long and thin at any single scale).
// Node-safe data only.

import type { FabProgram } from './types';

export interface Preset {
  id: string;
  label: string;
  /** one sentence for tooltips and the card */
  description: string;
  /** 'nasa' = a real shape model (public/assets/samples) */
  source: 'preset' | 'nasa';
  /** words that make a free-text description match this preset (offline fallback) */
  keywords: string[];
  program: FabProgram;
}

const rock = (seed: number, roughness: number, craters: number, elongation: [number, number, number], flat_base = 0.12, frequency = 1.6) => ({
  seed, roughness, craters, elongation, flat_base, frequency,
});

export const PRESETS: Preset[] = [
  {
    id: 'bennu',
    label: 'Bennu fragment',
    description: 'A dark, porous carbonaceous fragment like the rubble OSIRIS-REx sampled from asteroid Bennu.',
    source: 'preset',
    keywords: ['bennu', 'carbonaceous', 'rubble', 'fragment', 'osiris', 'regolith'],
    program: {
      name: 'Bennu fragment',
      category: 'asteroid',
      description: 'A dark, porous carbonaceous fragment like the rubble OSIRIS-REx sampled from asteroid Bennu.',
      color: '#4a4744',
      material: 'rubble_pile',
      density_g_cm3: 1.2,
      parts: [{ kind: 'rock', radius_mm: 17, rock: rock(101, 0.6, 5, [1.25, 1.0, 0.8]), roughness: 0.95, metalness: 0.02 }],
    },
  },
  {
    id: 'ryugu',
    label: 'Ryugu pebble',
    description: 'A rounded, very dark pebble like the grains Hayabusa2 returned from asteroid Ryugu.',
    source: 'preset',
    keywords: ['ryugu', 'hayabusa', 'pebble', 'round', 'dark'],
    program: {
      name: 'Ryugu pebble',
      category: 'asteroid',
      description: 'A rounded, very dark pebble like the grains Hayabusa2 returned from asteroid Ryugu.',
      color: '#2a2928',
      material: 'rubble_pile',
      density_g_cm3: 1.2,
      parts: [{ kind: 'rock', radius_mm: 13, rock: rock(77, 0.32, 2, [1.12, 1.0, 0.88], 0.1, 1.2), roughness: 0.9, metalness: 0.02 }],
    },
  },
  {
    id: 'iron',
    label: 'Iron meteorite',
    description: 'A dense iron-nickel meteorite, 48 mm long and about 200 g as designed: the guardrail shrinks it for mass.',
    source: 'preset',
    keywords: ['iron', 'meteorite', 'metal', 'nickel', 'metallic', 'heavy', 'gibeon'],
    program: {
      name: 'Iron meteorite',
      category: 'meteorite',
      description: 'A dense iron-nickel meteorite with thumbprint pits from its fall through the atmosphere.',
      color: '#77777c',
      material: 'iron_meteorite',
      density_g_cm3: 7.8,
      parts: [{ kind: 'rock', radius_mm: 20, rock: rock(4242, 0.3, 9, [1.2, 0.95, 0.75], 0.14, 1.3), roughness: 0.38, metalness: 0.85 }],
    },
  },
  {
    id: 'mars',
    label: 'Martian rock',
    description: 'A rust-red basaltic rock like the cores Perseverance is caching in Jezero crater.',
    source: 'preset',
    keywords: ['mars', 'martian', 'red', 'basalt', 'perseverance', 'jezero'],
    program: {
      name: 'Martian rock',
      category: 'meteorite',
      description: 'A rust-red basaltic rock like the cores Perseverance is caching in Jezero crater.',
      color: '#9a4a2c',
      material: 'basalt',
      density_g_cm3: 2.9,
      parts: [{ kind: 'rock', radius_mm: 16, rock: rock(2020, 0.62, 1, [1.15, 1.0, 0.8], 0.16, 1.9), roughness: 0.9, metalness: 0.03 }],
    },
  },
  {
    id: 'canister',
    label: 'Sample canister',
    description: 'A thin-walled aluminium sample canister with a lid and a gold seal band.',
    source: 'preset',
    keywords: ['canister', 'container', 'tube', 'jar', 'vial', 'sample return', 'capsule'],
    program: {
      name: 'Sample canister',
      category: 'canister',
      description: 'A thin-walled aluminium sample canister with a screw lid and a gold seal band.',
      color: '#c9ccd2',
      material: 'hollow_aluminum',
      density_g_cm3: 1.0,
      parts: [
        { kind: 'lathe', profile_mm: [[12, 0], [13.5, 1.5], [13.5, 30], [12.8, 31]], metalness: 0.8, roughness: 0.32 },
        { kind: 'torus', radius_mm: 13.5, radius2_mm: 0.9, pos_mm: [0, 0, 14], color: '#d4a017', metalness: 0.9, roughness: 0.25 },
        { kind: 'cylinder', radius_mm: 14.5, height_mm: 6, pos_mm: [0, 0, 31], color: '#a9adb5', metalness: 0.8, roughness: 0.3 },
        { kind: 'cylinder', radius_mm: 5, height_mm: 3, pos_mm: [0, 0, 37], color: '#8d9199', metalness: 0.8, roughness: 0.3 },
      ],
    },
  },
  {
    id: 'wheel',
    label: 'CubeSat wheel',
    description: 'A small CubeSat reaction wheel: a flywheel on an anodised housing.',
    source: 'preset',
    keywords: ['cubesat', 'reaction', 'wheel', 'flywheel', 'satellite', 'attitude', 'momentum'],
    program: {
      name: 'CubeSat reaction wheel',
      category: 'satellite_part',
      description: 'A small reaction wheel for CubeSat attitude control: a spinning flywheel on an anodised housing.',
      color: '#2d3138',
      density_g_cm3: 2.0,
      parts: [
        { kind: 'box', size_mm: [44, 44, 8], color: '#2d3138', metalness: 0.4, roughness: 0.5 },
        { kind: 'cylinder', radius_mm: 18, height_mm: 10, pos_mm: [0, 0, 8], color: '#b8bcc4', metalness: 0.85, roughness: 0.28 },
        { kind: 'torus', radius_mm: 17, radius2_mm: 2.6, pos_mm: [0, 0, 10.4], color: '#d9dce1', metalness: 0.9, roughness: 0.22 },
        { kind: 'cylinder', radius_mm: 5, height_mm: 4, pos_mm: [0, 0, 18], color: '#3a3d42', metalness: 0.6, roughness: 0.4 },
        { kind: 'cylinder', radius_mm: 1.6, height_mm: 1.2, pos_mm: [18.5, 18.5, 8], color: '#c0c4cc', metalness: 0.9, roughness: 0.3, repeat: { count: 4, step_deg: [0, 0, 90] } },
      ],
    },
  },
  {
    id: 'ice',
    label: 'Ice core',
    description: 'A translucent ice core with dust layers, like a drill sample from a comet or an icy moon.',
    source: 'preset',
    keywords: ['ice', 'core', 'comet', 'frozen', 'europa', 'water'],
    program: {
      name: 'Ice core',
      category: 'other',
      description: 'A translucent ice core with darker dust layers, like a drill sample from a comet or an icy moon.',
      color: '#cfe8f7',
      material: 'ice',
      density_g_cm3: 0.92,
      parts: [
        { kind: 'cylinder', radius_mm: 12, height_mm: 40, roughness: 0.12, metalness: 0, opacity: 0.78 },
        { kind: 'cylinder', radius_mm: 12.15, height_mm: 1.2, pos_mm: [0, 0, 9], color: '#8fb8d6', opacity: 0.85, repeat: { count: 3, step_mm: [0, 0, 10] } },
      ],
    },
  },
  {
    id: 'solar',
    label: 'Solar cell coupon',
    description: 'A solar cell coupon on a ceramic carrier, flown to test radiation damage.',
    source: 'preset',
    keywords: ['solar', 'cell', 'panel', 'coupon', 'photovoltaic', 'wafer'],
    program: {
      name: 'Solar cell coupon',
      category: 'satellite_part',
      description: 'A triple-junction solar cell coupon on a ceramic carrier, flown to test radiation damage.',
      color: '#1b2a5e',
      density_g_cm3: 2.4,
      parts: [
        { kind: 'box', size_mm: [44, 26, 11], color: '#e8e4da', roughness: 0.7 },
        { kind: 'box', size_mm: [42, 24, 0.6], pos_mm: [0, 0, 11], color: '#1b2a5e', metalness: 0.3, roughness: 0.25 },
        { kind: 'box', size_mm: [42, 0.6, 0.3], pos_mm: [0, -9, 11.6], color: '#c0c4cc', metalness: 0.9, roughness: 0.3, repeat: { count: 4, step_mm: [0, 6, 0] } },
        { kind: 'box', size_mm: [1.4, 24, 0.35], pos_mm: [0, 0, 11.6], color: '#d8dbe0', metalness: 0.9, roughness: 0.3 },
      ],
    },
  },
  {
    id: 'nasa_bennu',
    label: 'Bennu (NASA model)',
    description: 'NASA shape model of asteroid Bennu (OSIRIS-REx), a rubble pile about 490 m across.',
    source: 'nasa',
    keywords: ['nasa bennu', 'shape model', 'real bennu', 'whole bennu'],
    program: { name: 'Bennu (NASA shape model)', category: 'asteroid', description: 'Asteroid Bennu, NASA shape model, as a rubble-pile sample.', color: '#4f4b47', density_g_cm3: 1.2, parts: [{ kind: 'asset', asset: 'bennu', roughness: 0.95, metalness: 0.02 }] },
  },
  {
    id: 'nasa_itokawa',
    label: 'Itokawa (NASA/JAXA)',
    description: 'NASA/JAXA shape model of asteroid Itokawa (Hayabusa), a peanut-shaped rubble pile.',
    source: 'nasa',
    keywords: ['itokawa', 'peanut'],
    program: { name: 'Itokawa (NASA/JAXA shape model)', category: 'asteroid', description: 'Asteroid Itokawa, NASA/JAXA shape model.', color: '#8a7f70', density_g_cm3: 1.9, parts: [{ kind: 'asset', asset: 'itokawa', roughness: 0.9, metalness: 0.03 }] },
  },
  {
    id: 'nasa_eros',
    label: 'Eros, full length',
    description: 'NASA shape model of asteroid Eros (NEAR Shoemaker) at a full 90 mm length: the guardrail must shrink it.',
    source: 'nasa',
    keywords: ['eros', 'near shoemaker', 'banana'],
    program: { name: 'Eros (NASA shape model)', category: 'asteroid', description: 'Asteroid Eros, NASA shape model, stony (S-type).', color: '#8c7b62', density_g_cm3: 2.7, parts: [{ kind: 'asset', asset: 'eros', radius_mm: 48, roughness: 0.9, metalness: 0.04 }] },
  },
  {
    id: 'nasa_kleopatra',
    label: 'Kleopatra (NASA)',
    description: 'NASA shape model of the dog-bone asteroid Kleopatra, metal-rich.',
    source: 'nasa',
    keywords: ['kleopatra', 'dog bone', 'dogbone', 'metal-rich'],
    program: { name: 'Kleopatra (NASA shape model)', category: 'asteroid', description: 'Asteroid Kleopatra, NASA shape model, metal-rich.', color: '#7d7a76', density_g_cm3: 4.0, parts: [{ kind: 'asset', asset: 'kleopatra', roughness: 0.6, metalness: 0.35 }] },
  },
  {
    id: 'antenna',
    label: 'Antenna boom',
    description: 'A 4 mm whip antenna, 120 mm long: no single scale lets the jaw hold it.',
    source: 'preset',
    keywords: ['antenna', 'whip', 'boom', 'rod', 'needle', 'wire'],
    program: { name: 'Antenna boom', category: 'satellite_part', description: 'A thin deployable whip antenna.', color: '#d8dbe0', material: 'aluminum', density_g_cm3: 2.7, parts: [{ kind: 'cylinder', radius_mm: 2, height_mm: 120, metalness: 0.8, roughness: 0.3 }] },
  },
];

/** Offline fallback: the preset whose keywords best match a free-text description (Bennu if none). */
export function matchPreset(description: string): Preset {
  const t = description.toLowerCase();
  let best = PRESETS[0];
  let bestScore = 0;
  for (const p of PRESETS) {
    if (p.id === 'antenna') continue; // a fallback must be something the jaw can hold
    const score = p.keywords.reduce((s, k) => s + (t.includes(k) ? k.length : 0), 0);
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}
