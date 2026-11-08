// The fabricator's exact shape-program schema. src/contracts.ts keeps ShapePart/ShapeProgram loose
// (the fabricator owns the schema); these types are what sanitizeProgram guarantees.

/** Materials a designer may name. Code owns the density of each (program.ts MATERIAL_DENSITY). */
export type SampleMaterial =
  | 'rubble_pile' | 'chondrite' | 'basalt' | 'iron_meteorite' | 'ice' | 'crystal' | 'glass' | 'ceramic'
  | 'aluminum' | 'hollow_aluminum' | 'titanium' | 'steel' | 'gold_foil' | 'plastic' | 'carbon_fiber' | 'foam';

export type PartKind = 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus' | 'capsule' | 'rock' | 'lathe' | 'extrude' | 'asset';

export type ProgramCategory = 'asteroid' | 'meteorite' | 'canister' | 'satellite_part' | 'crystal' | 'tool' | 'other';

/**
 * One primitive. Millimetres and degrees, z up. Each part starts with its base on z = 0, centred on
 * x = y = 0 (lathe: profile z as given; extrude: outline as given, extruded up from z = 0); rot_deg turns it
 * about its own base centre, then pos_mm moves it.
 */
export type FabPart = {
  kind: PartKind;
  /** box: [x, y, z] mm */
  size_mm?: [number, number, number];
  /** cylinder / sphere / cone (bottom) / torus (ring) / capsule / rock radius; asset bounding radius, mm */
  radius_mm?: number;
  /** cone top radius / torus tube radius, mm */
  radius2_mm?: number;
  /** cylinder / cone / capsule (total) / extrude height, mm */
  height_mm?: number;
  /** lathe profile: [radius_mm, z_mm] points, bottom to top */
  profile_mm?: [number, number][];
  /** extrude: closed outline [x_mm, y_mm], counter-clockwise, extruded up by height_mm */
  outline_mm?: [number, number][];
  /** rock: noise-displaced icosphere with crater dents and an optional flat cut base */
  rock?: { seed: number; roughness: number; craters: number; elongation?: [number, number, number]; frequency?: number; flat_base?: number };
  /** asset: id of a real shape model in public/assets/samples (e.g. 'bennu') */
  asset?: string;
  /** count copies; copy i is moved by i*step_mm and turned by i*step_deg about the object origin */
  repeat?: { count: number; step_mm?: [number, number, number]; step_deg?: [number, number, number] };
  pos_mm?: [number, number, number];
  rot_deg?: [number, number, number];
  color?: string;
  material?: SampleMaterial;
  metalness?: number;
  roughness?: number;
  /** 0.3-1; below 1 renders translucent (ice) */
  opacity?: number;
};

export type FabProgram = {
  name: string;
  category: ProgramCategory;
  description?: string;
  /** default colour for parts that do not set one */
  color: string;
  parts: FabPart[];
  /** default material for parts that do not set one */
  material?: SampleMaterial;
  /** effective density (g/cm^3) for parts without a material; presets may set it, Gemini may not */
  density_g_cm3: number;
  /**
   * Set by sanitizeProgram when it shrank an oversize design whole to fit its clamps: the program is this
   * fraction (0-1) of the real design. Absent = as designed. Code sets it; Gemini may not.
   */
  design_scale?: number;
};
