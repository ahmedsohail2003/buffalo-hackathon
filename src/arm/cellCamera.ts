// The fixed cell camera Gemini Robotics-ER sees (PLAN.md A4, §1.2).
// MuJoCo (0,−0.60,0.42) looking at (−0.04,−0.18,0), fov 45, square 768.
// Frames: MuJoCo root (x, y, z up) ↔ three world (X=x, Y=z, Z=−y).
// Pure three math; node-safe (camera.test.ts).

import { PerspectiveCamera, Vector3, Vector2, Raycaster, Plane } from 'three';
import type { Vec3 } from '../contracts';

export const CELL_CAM_POS_MUJOCO: Vec3 = [0, -0.6, 0.42];
export const CELL_CAM_TARGET_MUJOCO: Vec3 = [-0.04, -0.18, 0];
export const CELL_CAM_FOV = 45;
export const CELL_FRAME_PX = 768;

export const mujocoToThree = (p: Vec3, out: Vector3 = new Vector3()): Vector3 => out.set(p[0], p[2], -p[1]);
export const threeToMujoco = (v: Vector3): Vec3 => [v.x, -v.z, v.y];

/** Build the cell camera in three world coordinates (aspect 1). */
export function createCellCam(): PerspectiveCamera {
  const cam = new PerspectiveCamera(CELL_CAM_FOV, 1, 0.05, 5);
  mujocoToThree(CELL_CAM_POS_MUJOCO, cam.position);
  cam.lookAt(mujocoToThree(CELL_CAM_TARGET_MUJOCO));
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();
  return cam;
}

const _v = new Vector3();
const _ndc = new Vector2();
const _ray = new Raycaster();
const _plane = new Plane();
const _hit = new Vector3();

/** Root-frame point → ER image coordinates [y, x], normalized 0–1000. */
export function projectMujoco(cam: PerspectiveCamera, p: Vec3): [number, number] {
  mujocoToThree(p, _v).project(cam);
  const y = Math.round(((1 - _v.y) / 2) * 1000);
  const x = Math.round(((_v.x + 1) / 2) * 1000);
  return [y, x];
}

/** ER image point [y, x] (0–1000) → root-frame point on the horizontal plane z = zPlane. */
export function unprojectER(cam: PerspectiveCamera, yx: [number, number], zPlane: number): Vec3 | null {
  const [y, x] = yx;
  _ndc.set(x / 500 - 1, 1 - y / 500);
  _ray.setFromCamera(_ndc, cam);
  // MuJoCo z = zPlane ⇔ three Y = zPlane: plane normal (0,1,0), constant −zPlane
  _plane.set(new Vector3(0, 1, 0), -zPlane);
  const hit = _ray.ray.intersectPlane(_plane, _hit);
  if (!hit) return null;
  return threeToMujoco(hit);
}
