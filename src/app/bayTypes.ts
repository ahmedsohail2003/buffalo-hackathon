// What the shell (runtime, scene, UI) needs from the bay core, beyond the public BayApi contract.
import type { Vec3 } from '../contracts';
import type { Arm, ArmModel, BayGate, SampleRegistry } from '../core';

/** A bay command from the on-screen panel (hand signals reach the gate through src/safety). */
export type SafetySignal = 'STOP' | 'RESUME' | 'SLOW' | 'CYCLE_START' | 'ESTOP';
export type SignalSource = 'panel';

/** Fixed bay geometry the scene draws, in bay-frame metres (z up, arm base at the origin). */
export interface BayLayout {
  /** edge length of the square deck plate */
  deckSize: number;
  /** deck plate centre (x, y) */
  deckCenter: [number, number];
  containment: { x: number; y: number; innerW: number; innerD: number; wallH: number; wallT: number; floorZ: number };
  /** fixed bay camera: the only view Gemini gets */
  bayCamera: { pos: Vec3; target: Vec3; fovDeg: number };
}

export interface ResetResult {
  ok: boolean;
  reason?: string;
}

/** The bay core as the shell drives it: the core objects plus the shell's layout. */
export interface BayCore {
  arm: Arm;
  samples: SampleRegistry;
  gate: BayGate;
  model: ArmModel;
  layout: BayLayout;
}
