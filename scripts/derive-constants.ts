// Re-derive the numbers documented in src/core/constants.ts from public/assets/so101.json.
// Run: npx vite-node scripts/derive-constants.ts
import fs from 'node:fs';
import { PerspectiveCamera, Vector3 } from 'three';
import { ArmModel, FIXED_PAD, MOVING_PAD, type So101Data } from '../src/core/model';
import { IkSolver } from '../src/core/ik';
import {
  BAY_CAMERA,
  CONTAINMENT_OUTER_HALF,
  CONTAINMENT_XY,
  HOME_Q,
  JAW_OPEN,
  REACH,
  SLOTS,
  Z_HOVER,
  Z_LIFT,
  graspZ,
  jawGapAt,
  polarXY,
} from '../src/core/constants';

const data = JSON.parse(fs.readFileSync('public/assets/so101.json', 'utf8')) as So101Data;
const ik = new IkSolver(data);
const m = new ArmModel(data);
const f3 = (v: ArrayLike<number>, k = 1000, d = 1): string => Array.from(v, (x) => (x * k).toFixed(d)).join(', ');

// 1. gripper geometry in the gripper body frame
const site = data.sites.gripperframe;
const fp = data.pads[FIXED_PAD];
const mp = data.pads[MOVING_PAD];
const jawBody = data.bodies.find((b) => b.name === 'moving_jaw_so101_v1')!;
console.log('TCP (gripperframe) in gripper frame, mm:', f3(site.pos));
console.log('fixed pad +x face x, mm:', ((fp.pos[0] + fp.size[0]) * 1000).toFixed(2));
const tip = data.pads.fixed_jaw_box3; // capsule along y
console.log('fixed fingertip bottom below TCP, mm:', ((site.pos[2] - (tip.pos[2] - tip.size[0])) * 1000).toFixed(2));
// moving pad face in the jaw frame -> gripper frame at g = 0: R_x(90): (x, y, z) -> (x, -z, y)
const face = [mp.pos[0] - mp.size[0], mp.pos[1], mp.pos[2]];
console.log('jaw pivot x, mm:', (jawBody.pos[0] * 1000).toFixed(2), ' moving face rel. pivot (x, z) at g = 0, mm:', (face[0] * 1000).toFixed(2), (face[1] * 1000).toFixed(2));
console.log('JAW_C = pivot_x - fixed_face_x =', (jawBody.pos[0] - (fp.pos[0] + fp.size[0])).toFixed(5), ' JAW_X0 =', face[0].toFixed(5), ' JAW_Z0 =', face[1].toFixed(5));
let worstGap = 0;
for (let g = -0.17; g <= 1.74; g += 0.01) {
  m.setPose([0, 0, 0, 0, 0, g]);
  worstGap = Math.max(worstGap, Math.abs(m.jawGap() - jawGapAt(g)));
}
console.log('closed-form jaw gap vs FK, worst |diff| (m):', worstGap.toExponential(2), ' JAW_OPEN', JAW_OPEN.toFixed(4), 'rad ->', (jawGapAt(JAW_OPEN) * 1000).toFixed(1), 'mm');

// 2. gripper-down reach band per height (all wrist rolls)
const rolls = [-2.6, -2.0, -1.4, -0.8, -0.2, 0, 0.4, 1.0, 1.6, 2.2, 2.8];
for (const z of [graspZ(0.024), graspZ(0.045), 0.04, Z_HOVER, Z_LIFT, 0.08, 0.085]) {
  let lo = -1;
  let hi = -1;
  for (let rho = 0.04; rho <= 0.34; rho += 0.0025) {
    let worst = 0;
    for (const roll of rolls) worst = Math.max(worst, ik.solve([0, -rho, z], roll).err);
    if (worst < 1e-4) {
      if (lo < 0) lo = rho;
      hi = rho;
    }
  }
  console.log(`z ${(z * 1000).toFixed(1)} mm: tcp band rho ${(lo * 1000).toFixed(1)} - ${(hi * 1000).toFixed(1)} mm`);
}
// bearing check at the band edges (REACH as published, with the 12.5 mm grasp offset either way)
let worst = 0;
for (const z of [Z_HOVER, Z_LIFT])
  for (const r of [REACH.rhoMin - 0.0125, REACH.rhoMax + 0.0125])
    for (const b of [-REACH.bearingMax, 0, REACH.bearingMax])
      for (const roll of rolls) {
        const [x, y] = polarXY(r, b);
        worst = Math.max(worst, ik.solve([x, y, z], roll).err);
      }
console.log('REACH edges +- 12.5 mm at Z_HOVER/Z_LIFT, all rolls: worst IK err (m)', worst.toExponential(2));

// 3. home pose
m.setPose(HOME_Q);
console.log('HOME tcp mm:', f3(m.tcp()), ' approach:', f3(m.approachAxis(), 1, 3));

// 4. bay camera framing
const cam = new PerspectiveCamera(BAY_CAMERA.fovDeg, BAY_CAMERA.width / BAY_CAMERA.height, 0.01, 10);
cam.up.set(...BAY_CAMERA.up);
cam.position.set(...BAY_CAMERA.pos);
cam.lookAt(...BAY_CAMERA.target);
cam.updateProjectionMatrix();
cam.updateMatrixWorld();
const pts: number[][] = [];
for (let b = -REACH.bearingMax; b <= REACH.bearingMax + 1e-9; b += REACH.bearingMax / 6)
  for (const r of [REACH.rhoMin, REACH.rhoMax]) pts.push([...polarXY(r, b), 0]);
for (const s of SLOTS) pts.push([s[0], s[1], 0], [s[0], s[1], 0.045]);
for (const dx of [-1, 1]) for (const dy of [-1, 1]) pts.push([CONTAINMENT_XY[0] + dx * CONTAINMENT_OUTER_HALF, CONTAINMENT_XY[1] + dy * CONTAINMENT_OUTER_HALF, 0.02]);
pts.push([0, 0.07, 0], [0.056, 0.07, 0], [-0.056, 0.07, 0], [0, 0, 0.16]);
let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
for (const p of pts) {
  const v = new Vector3(p[0], p[1], p[2]).project(cam);
  const ix = (v.x + 1) / 2;
  const iy = (1 - v.y) / 2;
  x0 = Math.min(x0, ix); x1 = Math.max(x1, ix); y0 = Math.min(y0, iy); y1 = Math.max(y1, iy);
}
console.log(`bay camera: points of interest span x ${(x0 * 100).toFixed(1)}-${(x1 * 100).toFixed(1)} %, y ${(y0 * 100).toFixed(1)}-${(y1 * 100).toFixed(1)} % of the image`);
