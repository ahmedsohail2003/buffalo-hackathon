/// <reference types="vite/client" />
// SO-ARM100 arm data: bodies, joints, keyframes and quantized meshes.
//
// Provenance: MuJoCo Menagerie `trs_so_arm100` (Apache-2.0), exported to
// `public/arm-data.json` by the portfolio work-cell page
// (repos/ahmedsohail2003.github.io/workcell) before EmberHacks and vendored here.
// Frames: MuJoCo root frame — x right, y away from the cell camera, z up, metres.
// Body quaternions are stored **xyzw** (three.js order), not MuJoCo's wxyz.
//
// This module is DOM/FS-free at import time so vitest (node) can import it.

import type { Vec3 } from '../contracts';

export interface ArmGeom {
  mesh: string;
  mat: 'white' | 'black';
}

export interface ArmJoint {
  name: string;
  /** joint axis in the body frame */
  axis: Vec3;
  range: [number, number];
}

export interface ArmBody {
  name: string;
  parent: string | null;
  /** position in the parent body frame, metres */
  pos: Vec3;
  /** orientation in the parent body frame, xyzw */
  quat: [number, number, number, number];
  joint: ArmJoint | null;
  geoms: ArmGeom[];
}

export interface ArmMesh {
  /** vertex count */
  n: number;
  tris: number;
  /** quantization origin */
  lo: Vec3;
  /** quantization span */
  span: Vec3;
  /** base64 Uint16 quantized positions (n*3) */
  v: string;
  /** base64 index buffer */
  i: string;
  /** index buffer is Uint32 (else Uint16) */
  i32: boolean;
}

export interface ArmKey {
  t: number;
  /** 6 joints: Rotation, Pitch, Elbow, Wrist_Pitch, Wrist_Roll, Jaw */
  q: number[];
}

export interface ArmData {
  source?: string;
  /** 7 bodies: Base … Moving_Jaw, parent-before-child order */
  bodies: ArmBody[];
  /** joint order for q vectors */
  order: string[];
  /** tcp site, local to Fixed_Jaw */
  tcp: Vec3;
  wrist_cam: Vec3;
  /** seed block centre */
  block: Vec3;
  tray: Vec3;
  front_cam: Vec3;
  rgbd_cam: Vec3;
  keys: ArmKey[];
  grasp: [number, number];
  meshes: Record<string, ArmMesh>;
}

// ---- kinematic constants (from MuJoCo probes; see PLAN.md §1.3) ----

/** 5-joint home pose (Rotation, Pitch, Elbow, Wrist_Pitch, Wrist_Roll). */
export const HOME_Q: number[] = [0, -1.57, 1.57, 1.57, -1.57];
/** Rotation pivot in the root frame. */
export const PIVOT: Vec3 = [0, -0.0452, 0.0165];
/** Tray centre xy (root frame, metres). */
export const TRAY: [number, number] = [-0.18, -0.13];
/** Tray inner half-extent used for the "inside the tray" footprint test. */
export const TRAY_HALF = 0.037;
/** Tray floor top surface z. */
export const TRAY_FLOOR_Z = 0.006;
/** Jaw joint value for "open". */
export const JAW_OPEN = 0.7;
/** Approach height above a part. */
export const Z_HOVER = 0.075;
/** Lift / transport / retreat height (0.10 fails beyond rho 0.21; 0.12 unreachable). */
export const Z_LIFT = 0.09;
/** Lowering height over the tray before release. */
export const Z_TRAY_LOWER = 0.055;
/** Grasp height for a part of height h (kinematic equivalent of the physics stall at 0.026). */
export const graspZ = (h: number): number => Math.max(0.027, h / 2 + 0.015);

let cached: Promise<ArmData> | null = null;

/** Browser loader; module-cached. Tests use loadArmDataNode() defined in the test file. */
export function loadArmData(): Promise<ArmData> {
  if (!cached) {
    cached = fetch(import.meta.env.BASE_URL + 'arm-data.json').then((r) => {
      if (!r.ok) throw new Error(`arm-data.json: HTTP ${r.status}`);
      return r.json() as Promise<ArmData>;
    });
  }
  return cached;
}
