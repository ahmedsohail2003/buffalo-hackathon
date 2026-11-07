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
  shape: 'box' | 'cylinder' | 'sphere';
  /** metres: w along x, d along y, h along z (sphere: w = d = h = diameter) */
  dims: { w: number; d: number; h: number };
  /** centre position, metres, root frame */
  pos: Vec3;
  /** yaw about z, radians */
  yaw: number;
  held: boolean;
  createdBy: 'seed' | 'voice' | 'text';
  /** Optional generated print (data URL) applied to the part's faces (Nano Banana). */
  texture?: string;
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
