// Shared contracts between the arm/scene track (A) and the Gemini track (B).
// Types only. No imports, no runtime code, so every module can depend on it.
// Frames: MuJoCo root frame everywhere in data — x right, y away from the cell
// camera, z up, metres. Millimetres only at the Gemini tool boundary (suffix _mm).

export type Vec3 = [number, number, number];

export type CellState = 'IDLE' | 'RUNNING' | 'SLOW' | 'STOPPED' | 'ESTOPPED';

export interface SceneObject {
  id: string;
  name: string;
  color: string;
  /** 'mesh' = an AI-generated or asset shape (UB Hacking); dims are then its axis-aligned bounds at yaw 0. */
  shape: 'box' | 'cylinder' | 'sphere' | 'mesh';
  /** metres: w along x, d along y, h along z (sphere: w = d = h = diameter) */
  dims: { w: number; d: number; h: number };
  /** centre position, metres, root frame */
  pos: Vec3;
  /** yaw about z, radians */
  yaw: number;
  held: boolean;
  createdBy: 'seed' | 'voice' | 'text' | 'designer' | 'teleop';
  /** Optional generated print (data URL) applied to the part's faces (Nano Banana). */
  texture?: string;
  /** Present when shape === 'mesh': the shape program and what code measured on it (UB Hacking). */
  mesh?: MeshInfo;
}

/** What Gemini may ask for when creating a part. Code validates it. */
export interface ObjectSpec {
  name?: string;
  color: string;
  shape: 'box' | 'cylinder' | 'sphere';
  width_mm: number;
  depth_mm?: number;
  height_mm: number;
  x_mm?: number;
  y_mm?: number;
  relative_to?: string;
  direction?: 'left' | 'right' | 'front' | 'behind';
  distance_mm?: number;
  yaw_deg?: number;
}

export interface ArmSnapshot {
  q: number[];
  tcp: Vec3;
  jaw: number;
  jawOpen: boolean;
  phase: string;
  heldId: string | null;
  queueLen: number;
}

export type PrimCode =
  | 'REJECTED_STATE'
  | 'UNREACHABLE'
  | 'NO_OBJECT'
  | 'ALREADY_HELD'
  | 'NOTHING_HELD'
  | 'GRASP_MISSED'
  | 'ABORTED';

export type PrimResult =
  | { ok: true; tcp_mm: Vec3; held: string | null; phase: string }
  | { ok: false; code: PrimCode; reason: string; state?: CellState; err_mm?: number };

/** The ONLY surface through which Gemini can move the arm. */
export interface ArmApi {
  pick(id: string): Promise<PrimResult>;
  placeInTray(): Promise<PrimResult>;
  placeAt(xy: [number, number]): Promise<PrimResult>;
  moveTo(p: Vec3): Promise<PrimResult>;
  home(): Promise<PrimResult>;
  open(): Promise<PrimResult>;
  close(): Promise<PrimResult>;
  abortAll(reason: string): void;
  snapshot(): ArmSnapshot;
}

export type CreateResult =
  | { ok: true; obj: SceneObject; suggestion?: undefined }
  | { ok: false; code: string; reason: string; suggestion?: string };

export interface ObjectsApi {
  list(): SceneObject[];
  get(id: string): SceneObject | undefined;
  create(spec: ObjectSpec): CreateResult;
  remove(id: string): boolean;
  reset(): void;
  /** Apply (or clear with null) a generated print on a part. Optional: stub cells may not render. */
  setTexture?(id: string, dataUrl: string | null): boolean;
}

/** Cell safety gate. Gestures and the e-stop panel own the state; Gemini only reads it. */
export interface CellGateApi {
  state(): CellState;
  /** Resolves when the cell is RUNNING or SLOW; rejects on ESTOPPED or abort. */
  waitRunnable(signal?: AbortSignal): Promise<void>;
  onChange(cb: (s: CellState) => void): () => void;
}

export interface FrameCapture {
  jpegB64: string;
  w: number;
  h: number;
  t: number;
}

export interface CellApi {
  arm: ArmApi;
  objects: ObjectsApi;
  gate: CellGateApi;
  /** Render the fixed cell camera to a 768x768 JPEG (what Gemini sees). */
  capture(): FrameCapture;
  /** Root-frame point → ER image coordinates [y, x] normalized 0-1000. */
  projectMujoco(p: Vec3): [number, number];
  /** ER image point [y, x] 0-1000 → root-frame point on the plane z = zPlane. */
  unprojectER(yx: [number, number], zPlane: number): Vec3 | null;
}

export interface GeminiCallEntry {
  t: number;
  model: string;
  purpose: 'point' | 'plan' | 'act' | 'verify' | 'grasp_check' | 'live_tool' | 'flash_console' | 'image';
  thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  latencyMs: number;
  promptTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  costUsd: number;
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// UB Hacking 2026 additions (everything below this line was added at UB Hacking).
// ---------------------------------------------------------------------------

/**
 * One primitive of an AI-generated shape program. Millimetres and degrees, z up,
 * positions relative to the object's own origin (centre of its footprint, z = 0 at its base).
 * Code clamps every number before building geometry: a program is a request, never trusted.
 */
export interface ShapePart {
  prim: 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus' | 'capsule' | 'rock' | 'lathe' | 'asset';
  /** box: [w, d, h] mm */
  size_mm?: [number, number, number];
  /** cylinder / sphere / cone (bottom) / torus (major) / capsule / rock radius, mm */
  radius_mm?: number;
  /** cone top radius / torus tube radius, mm */
  radius2_mm?: number;
  /** cylinder / cone / capsule height, mm */
  height_mm?: number;
  /** lathe profile: [radius_mm, z_mm] points, bottom to top */
  profile_mm?: [number, number][];
  /** rock: noise-displaced icosphere (asteroid fragments, meteorites) */
  rock?: { seed: number; roughness: number; craters: number; elongation?: [number, number, number] };
  /** asset: id of a real shape model shipped in public/assets (e.g. 'bennu'), scaled to radius_mm */
  asset?: string;
  pos_mm?: [number, number, number];
  rot_deg?: [number, number, number];
  color?: string;
  metalness?: number;
  roughness?: number;
}

export interface ShapeProgram {
  name: string;
  category: 'asteroid' | 'meteorite' | 'canister' | 'satellite_part' | 'crystal' | 'tool' | 'other';
  description?: string;
  /** default colour for parts that do not set one */
  color: string;
  parts: ShapePart[];
  /** g/cm^3, e.g. rubble-pile asteroid 1.2, stony meteorite 3.3, iron meteorite 7.8, aluminium 2.7 */
  density_g_cm3: number;
}

/** What code measured on a built shape program. Gemini proposes; these numbers decide. */
export interface MeshInfo {
  program: ShapeProgram;
  /** narrowest width across the jaw closing axis, after scaling, mm */
  graspWidthMm: number;
  /** object yaw (rad) at which that narrowest width lies along the jaw axis */
  graspYaw: number;
  volumeCm3: number;
  massG: number;
  /** uniform scale the guardrail applied so the gripper can hold it (1 = as designed) */
  scale: number;
  source: 'gemini' | 'preset' | 'nasa';
}

/** One MediaPipe hand result, published by the camera loop (or the simulated hand) every frame. */
export interface HandLandmark {
  x: number;
  y: number;
  z: number;
}

export interface HandFrame {
  /** performance.now() ms */
  t: number;
  /** 21 landmarks, x/y normalized 0-1 in the UNMIRRORED video frame, z relative depth */
  landmarks: HandLandmark[];
  /** 21 metric landmarks relative to the hand centre (m), when available */
  world?: HandLandmark[];
  handedness?: 'Left' | 'Right';
  /** GestureRecognizer top category for this hand (e.g. 'Open_Palm'), or null */
  gesture: string | null;
  gestureScore: number;
  source: 'camera' | 'sim';
}

/** Teleoperation status for the UI and telemetry. */
export interface TeleopStatus {
  enabled: boolean;
  handPresent: boolean;
  pinched: boolean;
  /** hover target the arm is following, mm (root frame) */
  target_mm: Vec3 | null;
  mode: 'off' | 'following' | 'holding' | 'grasping' | 'placing' | 'blocked';
  /** one short sentence for the UI, e.g. 'no hand in view — holding position' */
  note: string;
}
