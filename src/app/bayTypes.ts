// What the shell (runtime, scene, UI) needs from the bay core, beyond the public BayApi contract.
import type { ArmApi, ArmSnapshot, GateApi, SampleApi, Vec3 } from '../contracts';

/** A command fired by the hand-signal machine, the keypad or the on-screen panel. */
export type SafetySignal = 'STOP' | 'RESUME' | 'SLOW' | 'CYCLE_START' | 'ESTOP';
export type SignalSource = 'hand' | 'keypad' | 'panel';

/** Fixed bay geometry the scene draws, in bay-frame metres (z up, arm base at the origin). */
export interface BayLayout {
  /** edge length of the square deck plate */
  deckSize: number;
  /** deck plate centre (x, y) */
  deckCenter: [number, number];
  containment: { x: number; y: number; innerW: number; innerD: number; wallH: number; wallT: number };
  /** fixed bay camera: the only view Gemini gets */
  bayCamera: { pos: Vec3; target: Vec3; fovDeg: number };
}

/** A drawable arm: meshes plus a pose update from the arm snapshot. */
export interface ArmRigSource {
  /** Build the meshes (called once by the scene). */
  build(): ArmRigParts;
}

export interface ArmRigParts {
  /** one entry per rigid body; the scene adds each object to the bay root */
  bodies: { name: string; object: import('three').Object3D }[];
  /** Pose every body from a snapshot; also writes the tool-centre frame into `tcpOut`. */
  pose(snap: ArmSnapshot, tcpOut: import('three').Matrix4): void;
}

export interface ResetResult {
  ok: boolean;
  reason?: string;
}

/** The bay core as the shell drives it: the public APIs plus the loop and safety entry points. */
export interface BayCore {
  arm: ArmApi;
  samples: SampleApi;
  gate: GateApi;
  layout: BayLayout;
  rig: ArmRigSource;
  /** advance arm motion by dt seconds at the gate's speed factor */
  stepArm(dt: number, speedFactor: number): void;
  /** feed a fired safety command into the gate (ESTOP also aborts the arm) */
  applySignal(signal: SafetySignal, source: SignalSource): void;
  /** clear an emergency stop back to IDLE (the panel asks twice before calling this) */
  resetEstop(source: SignalSource): ResetResult;
  /** true while the core is a stand-in for the real arm core */
  mock: boolean;
}
