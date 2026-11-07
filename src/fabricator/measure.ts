// Measure a built sample the way the gripper meets it. Node-safe (three math only).
// The jaw closes along the sample's local +x at any yaw, so "grasp width" is the extent across that axis
// of everything the fingers straddle: from the fingertips (limits.ts fingertipHeightMm) up to the top,
// minimised over yaw to find the narrow side, which fabricate then bakes onto local +x.

import type { BufferGeometry } from 'three';
import { fingertipHeightMm } from './limits';

export interface Measured {
  /** axis-aligned extents at yaw 0, metres */
  w: number;
  d: number;
  h: number;
  /** narrowest width across the jaw axis over all yaws (fingertip band), mm */
  graspWidthMm: number;
  /** yaw (rad, [0, pi)) of the direction that narrowest width lies along */
  graspYaw: number;
  /** extent along local +x of the fingertip band: what the jaw closes across at yaw 0, mm */
  widthAlongXMm: number;
  /** bounding-circle diameter about the centre (xy), mm */
  footprintMm: number;
  volumeCm3: number;
  massG: number;
  /** horizontal distance from the centre of mass to the grip centre (bbox centre), mm */
  comOffsetMm: number;
}

/** Extent of points (xs, ys) projected on the direction at angle t. */
function extent(xs: Float64Array, ys: Float64Array, t: number): number {
  const c = Math.cos(t), s = Math.sin(t);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const p = xs[i] * c + ys[i] * s;
    if (p < lo) lo = p;
    if (p > hi) hi = p;
  }
  return hi - lo;
}

export function measureGeometry(g: BufferGeometry, densityGcm3: number): Measured {
  const pos = g.getAttribute('position');
  const a = pos.array as ArrayLike<number>;
  const n = pos.count;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  const w = x1 - x0, d = y1 - y0, h = z1 - z0;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;

  // fingertip band: everything from the fingertips up to the top
  const tip = z0 + fingertipHeightMm(h * 1000) / 1000;
  let m = 0;
  for (let i = 0; i < n; i++) if (a[i * 3 + 2] >= tip) m++;
  const useAll = m < 3;
  const xs = new Float64Array(useAll ? n : m), ys = new Float64Array(useAll ? n : m);
  let k = 0, r2 = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i * 3] - cx, y = a[i * 3 + 1] - cy;
    r2 = Math.max(r2, x * x + y * y);
    if (useAll || a[i * 3 + 2] >= tip) {
      xs[k] = x;
      ys[k] = y;
      k++;
    }
  }
  let best = Infinity, bestT = 0;
  const step = Math.PI / 90; // 2 degrees
  for (let t = 0; t < Math.PI - 1e-9; t += step) {
    const e = extent(xs, ys, t);
    if (e < best - 1e-12) {
      best = e;
      bestT = t;
    }
  }
  // refine +/- 2 degrees in 0.1 degree steps
  for (let t = bestT - step; t <= bestT + step; t += Math.PI / 1800) {
    const e = extent(xs, ys, t);
    if (e < best - 1e-12) {
      best = e;
      bestT = t;
    }
  }
  bestT = ((bestT % Math.PI) + Math.PI) % Math.PI;
  const alongX = extent(xs, ys, 0);

  // volume + centre of mass by the divergence theorem over the triangles
  const idx = g.index ? (g.index.array as ArrayLike<number>) : null;
  const tris = idx ? idx.length / 3 : n / 3;
  let vol = 0, mx = 0, my = 0;
  for (let t = 0; t < tris; t++) {
    const i0 = idx ? idx[t * 3] : t * 3, i1 = idx ? idx[t * 3 + 1] : t * 3 + 1, i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
    const ax = a[i0 * 3] - cx, ay = a[i0 * 3 + 1] - cy, az = a[i0 * 3 + 2];
    const bx = a[i1 * 3] - cx, by = a[i1 * 3 + 1] - cy, bz = a[i1 * 3 + 2];
    const qx = a[i2 * 3] - cx, qy = a[i2 * 3 + 1] - cy, qz = a[i2 * 3 + 2];
    const v = (ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx)) / 6;
    vol += v;
    mx += (v * (ax + bx + qx)) / 4;
    my += (v * (ay + by + qy)) / 4;
  }
  const box = w * d * h;
  let v = Math.abs(vol);
  // overlapping parts over-count and open surfaces under-count: keep it inside a sane band of the box
  if (v > box) v = box;
  if (!(v > 0.02 * box)) v = 0.3 * box;
  const comOffsetMm = Math.abs(vol) > 1e-12 ? Math.hypot(mx / vol, my / vol) * 1000 : 0;
  const volumeCm3 = v * 1e6;
  return {
    w, d, h,
    graspWidthMm: best * 1000,
    graspYaw: bestT,
    widthAlongXMm: alongX * 1000,
    footprintMm: 2 * Math.sqrt(r2) * 1000,
    volumeCm3,
    massG: volumeCm3 * densityGcm3,
    comOffsetMm,
  };
}
