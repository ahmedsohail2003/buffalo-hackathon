// The fixed bay camera as pure math: the pose Gemini sees through, and the mapping between
// bay-frame points and image points ([y, x], normalized 0-1000, origin top-left).
import * as THREE from 'three';
import type { Vec3 } from '../contracts';

export interface BayCameraPose {
  pos: Vec3;
  target: Vec3;
  fovDeg: number;
}

export const BAY_CAPTURE_SIZE = 768;

export class BayCameraModel {
  readonly camera: THREE.PerspectiveCamera;

  constructor(pose: BayCameraPose) {
    const cam = new THREE.PerspectiveCamera(pose.fovDeg, 1, 0.01, 20);
    cam.up.set(0, 0, 1);
    cam.position.set(...pose.pos);
    cam.lookAt(new THREE.Vector3(...pose.target));
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    cam.layers.set(0); // the bay camera never sees layer-1 decoration
    this.camera = cam;
  }

  /** bay-frame point -> image point [y, x], 0-1000 (may fall outside 0-1000 when off-frame) */
  project(p: Vec3): [number, number] {
    const v = new THREE.Vector3(...p).project(this.camera);
    return [((1 - v.y) / 2) * 1000, ((v.x + 1) / 2) * 1000];
  }

  /** image point [y, x] 0-1000 -> bay-frame point on the plane z = zPlane, or null if the ray misses it */
  unproject([y, x]: [number, number], zPlane: number): Vec3 | null {
    const cam = this.camera;
    const ndc = new THREE.Vector3((x / 1000) * 2 - 1, 1 - (y / 1000) * 2, 0.5).unproject(cam);
    const dir = ndc.sub(cam.position);
    if (Math.abs(dir.z) < 1e-9) return null;
    const t = (zPlane - cam.position.z) / dir.z;
    if (!(t > 0)) return null;
    const hit = cam.position.clone().addScaledVector(dir, t);
    return [hit.x, hit.y, hit.z];
  }

  /**
   * Where the image corners land on the deck (z = 0), clockwise from top-left. A corner whose ray
   * never reaches the deck (it looks above the horizon) is pushed far out along the view direction.
   */
  deckFootprint(): [number, number][] {
    const corners: [number, number][] = [
      [0, 0],
      [0, 1000],
      [1000, 1000],
      [1000, 0],
    ];
    return corners.map(([y, x]) => {
      const hit = this.unproject([y, x], 0);
      if (hit) return [hit[0], hit[1]] as [number, number];
      const far = new THREE.Vector3((x / 1000) * 2 - 1, 1 - (y / 1000) * 2, 0.5).unproject(this.camera).sub(this.camera.position);
      far.z = 0;
      far.setLength(50);
      return [this.camera.position.x + far.x, this.camera.position.y + far.y] as [number, number];
    });
  }
}
