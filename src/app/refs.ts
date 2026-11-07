// Module-level handles shared between App, the scene and the Gemini track.
// App sets them once the arm data has loaded; in dev, `window.__cell` = CellApi.

import type { CellApi, FrameCapture, HandFrame, Vec3 } from '../contracts';
import type { CobotCell } from '../cell/cellSim';
import type { ArmController } from '../arm/controller';
import type { ObjectRegistry } from '../cell/objects';
import type { CellGate } from '../arm/gate';
import type { ArmData } from '../arm/armData';

/** What the three.js scene provides once mounted. */
export interface SceneApi {
  capture(): FrameCapture;
  projectMujoco(p: Vec3): [number, number];
  unprojectER(yx: [number, number], zPlane: number): Vec3 | null;
  syncScene(): void;
}

/** The kinematic runtime built by App when arm-data.json resolves. */
export interface ArmRuntime {
  data: ArmData;
  arm: ArmController;
  objects: ObjectRegistry;
  gate: CellGate;
}

let cellApi: CellApi | null = null;
let sceneApi: SceneApi | null = null;
let cellGetter: () => CobotCell | null = () => null;
let runtime: ArmRuntime | null = null;
const sceneListeners = new Set<(s: SceneApi | null) => void>();

export function setCellApi(api: CellApi | null): void {
  cellApi = api;
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    (window as unknown as { __cell?: CellApi | null }).__cell = api;
  }
}
export function getCellApi(): CellApi | null {
  return cellApi;
}

export function setCellGetter(fn: () => CobotCell | null): void {
  cellGetter = fn;
}
export function getCell(): CobotCell | null {
  return cellGetter();
}

export function setSceneApi(api: SceneApi | null): void {
  sceneApi = api;
  for (const cb of [...sceneListeners]) cb(api);
}
export function getSceneApi(): SceneApi | null {
  return sceneApi;
}
export function onSceneApi(cb: (s: SceneApi | null) => void): () => void {
  sceneListeners.add(cb);
  return () => {
    sceneListeners.delete(cb);
  };
}

export function setArmRuntime(rt: ArmRuntime | null): void {
  runtime = rt;
}
export function getArmRuntime(): ArmRuntime | null {
  return runtime;
}

// ---- UB Hacking 2026: latest hand frame (camera loop or simulated hand -> teleop) ----

let handFrame: HandFrame | null = null;

/** Called by the camera loop (HandPane) or the simulated hand every frame; null when no hand is seen. */
export function setHandFrame(f: HandFrame | null): void {
  handFrame = f;
}
/** Latest hand frame, or null. Consumers must check `t` for staleness. */
export function getHandFrame(): HandFrame | null {
  return handFrame;
}
