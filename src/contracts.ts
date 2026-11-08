// STARHAND shared contracts: types only, no runtime code, no imports.
//
// Bay frame: metres, z up, the arm base at the origin. The operator and the bay camera are on
// the −y side and the arm reaches toward −y. Samples rest on the deck (z = 0). Tool arguments
// shown to Gemini use millimetres, with an _mm suffix.

export type Vec3 = [number, number, number];

/** Bay safety state. Only the operator (gestures, the on-screen panel) changes it; AI only reads it. */
export type BayState = 'IDLE' | 'RUNNING' | 'SLOW' | 'STOPPED' | 'ESTOPPED';

export type SampleKind = 'box' | 'cylinder' | 'sphere' | 'mesh';

/** One part on the deck. The registry is ground truth; the scene only draws it. */
export interface Sample {
  id: string;
  name: string;
  /** CSS colour */
  color: string;
  kind: SampleKind;
  /**
   * Extents in the sample's local frame, metres. The jaw always closes along local +x, so
   * w is the width the gripper holds, d is the depth along the fingers and h is the height.
   * r, when present, is the measured footprint radius: the largest horizontal distance of the part
   * from pos (fabricated meshes). Spacing and the containment bin use it instead of hypot(w, d) / 2.
   */
  dims: { w: number; d: number; h: number; r?: number };
  /** centre of the bounding box, bay frame, metres (z = h/2 when resting on the deck) */
  pos: Vec3;
  /** rotation about z, radians */
  yaw: number;
  held: boolean;
  /** present when kind === 'mesh': how to build it and what code measured on it */
  mesh?: MeshInfo;
  createdBy: 'seed' | 'operator' | 'gemini' | 'preset' | 'teleop';
}

/** One primitive in a generated shape program. Millimetres and degrees, z up, base at z = 0. */
export interface ShapePart {
  kind: string;
  [param: string]: unknown;
}

/** A generated (or preset) sample design. The fabricator owns the exact schema; code clamps everything. */
export interface ShapeProgram {
  name: string;
  category: string;
  parts: ShapePart[];
  [field: string]: unknown;
}

/** What code measured on a built sample, after the guardrail scaled it. Gemini proposes; these decide. */
export interface MeshInfo {
  program: ShapeProgram;
  /** width across the jaw axis (local x), mm */
  graspWidthMm: number;
  heightMm: number;
  massG: number;
  /** uniform scale the guardrail applied (1 = as designed) */
  scale: number;
  source: 'gemini' | 'preset' | 'nasa';
  /** optional id of a real shape model in public/assets/samples (e.g. 'bennu') */
  assetId?: string;
}

/** Where to put a new sample. Absolute xy, or relative to a sample id, 'containment' or 'arm'. */
export interface Placement {
  x_mm?: number;
  y_mm?: number;
  relative_to?: string;
  direction?: 'left' | 'right' | 'front' | 'behind';
  distance_mm?: number;
}

export type Rejection = { ok: false; code: string; reason: string; suggestion?: string };
export type CreateResult = { ok: true; sample: Sample } | Rejection;

/** The sample registry. Code here is the trust boundary for every AI-proposed sample. */
export interface SampleApi {
  list(): Sample[];
  get(id: string): Sample | undefined;
  /** A primitive part (box / cylinder / sphere), sizes in mm. Validated against grip, height and reach. */
  createPrimitive(spec: { name?: string; color: string; kind: 'box' | 'cylinder' | 'sphere'; width_mm: number; depth_mm?: number; height_mm: number } & Placement, by?: Sample['createdBy']): CreateResult;
  /** A measured mesh sample (the fabricator has already built, measured and scaled it). dims.r: footprint radius, metres. */
  createMesh(input: { name: string; color: string; mesh: MeshInfo; dims: { w: number; d: number; h: number; r?: number } } & Placement, by?: Sample['createdBy']): CreateResult;
  remove(id: string): boolean;
  reset(): void;
  onChange(cb: () => void): () => void;
}

export type PrimCode = 'REJECTED_STATE' | 'UNREACHABLE' | 'NO_SAMPLE' | 'ALREADY_HELD' | 'NOTHING_HELD' | 'GRASP_MISSED' | 'ABORTED';

export type MoveResult =
  | { ok: true; tcp_mm: Vec3; held: string | null }
  | { ok: false; code: PrimCode; reason: string };

export interface ArmSnapshot {
  /** joint values, radians: shoulder_pan, shoulder_lift, elbow_flex, wrist_flex, wrist_roll, gripper */
  q: number[];
  /** tool-centre point, bay frame, metres */
  tcp: Vec3;
  /** 0 = closed, 1 = fully open (display only) */
  jawOpen: number;
  phase: string;
  heldId: string | null;
  busy: boolean;
}

/** The only surface through which AI or teleop can move the arm. Every call checks the bay state first. */
export interface ArmApi {
  pick(id: string): Promise<MoveResult>;
  placeAt(xy: [number, number]): Promise<MoveResult>;
  placeInContainment(): Promise<MoveResult>;
  home(): Promise<MoveResult>;
  /** Teleop: follow a tool-centre target at hover height (rate-limited; ignored while a move is running). */
  servoTo(target: Vec3 | null): void;
  abortAll(reason: string): void;
  snapshot(): ArmSnapshot;
}

/** Bay safety gate. Gestures and the panel own the state; AI can only read it and wait. */
export interface GateApi {
  state(): BayState;
  /** 1 RUNNING, 0.5 SLOW, 0 otherwise */
  speedFactor(): number;
  /** Resolves when RUNNING or SLOW (auto CYCLE START from IDLE, logged); rejects on ESTOPPED or abort. */
  waitRunnable(signal?: AbortSignal): Promise<void>;
  onChange(cb: (s: BayState) => void): () => void;
}

/** One rendered frame of the fixed bay camera: what Gemini Robotics-ER sees. */
export interface FrameCapture {
  jpegB64: string;
  w: number;
  h: number;
  t: number;
}

/** Everything the Gemini, voice, teleop and fabricator layers may touch. */
export interface BayApi {
  arm: ArmApi;
  samples: SampleApi;
  gate: GateApi;
  /** render the fixed bay camera to a square JPEG */
  capture(): FrameCapture;
  /** bay-frame point -> bay-camera image point [y, x] normalized 0-1000 */
  project(p: Vec3): [number, number];
  /** bay-camera image point [y, x] 0-1000 -> bay-frame point on the plane z = zPlane */
  unproject(yx: [number, number], zPlane: number): Vec3 | null;
}

/** One MediaPipe hand result (camera or simulated), published every frame. */
export interface HandLandmark {
  x: number;
  y: number;
  z: number;
}

export interface HandFrame {
  /** performance.now() ms */
  t: number;
  /** 21 landmarks, x/y normalized 0-1 in the UNMIRRORED video frame */
  landmarks: HandLandmark[];
  world?: HandLandmark[];
  /** GestureRecognizer top category for this hand, or null */
  gesture: string | null;
  gestureScore: number;
  source: 'camera' | 'sim';
}

export interface TeleopStatus {
  enabled: boolean;
  handPresent: boolean;
  pinched: boolean;
  /** hover target the arm is following, bay frame mm */
  target_mm: Vec3 | null;
  mode: 'off' | 'following' | 'holding' | 'grasping' | 'placing' | 'blocked';
  note: string;
}

/** A line in the mission log (and the source of mission-control voice callouts). */
export interface LogLine {
  t: number;
  kind: 'info' | 'safety' | 'teleop' | 'fabricator' | 'gemini' | 'voice' | 'reject';
  text: string;
}

/** One Gemini call, for the on-screen ledger: model, purpose, latency, tokens, cost. */
export interface GeminiCallEntry {
  t: number;
  model: string;
  purpose: 'design' | 'coworker' | 'point' | 'verify' | 'grasp_check' | 'live' | 'image';
  latencyMs: number;
  promptTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  costUsd: number;
  ok: boolean;
  error?: string;
}
