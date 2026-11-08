// Bay constants for the SO-101, derived tonight from the converted Menagerie model.
// Reproduce every number with: npx vite-node scripts/derive-constants.ts
// (it sweeps the gripper-down IK and prints the bands, gaps and camera framing quoted below).
// constants.test.ts re-checks the important ones against the model.
//
// Bay frame: metres, z up, deck at z = 0, the shoulder-pan axis is the z axis (x = y = 0) and the
// arm reaches toward -y at shoulder_pan = 0. Bearing = atan2(x, -y): 0 straight ahead (-y),
// positive toward +x (the operator's right, the operator faces +y from the -y side).

import type { Vec3 } from '../contracts';

/** the shoulder-pan axis in the bay frame (the converter puts it on the z axis) */
export const PAN_AXIS_XY: [number, number] = [0, 0];

// ---------- gripper geometry (gripper body frame, from so101.json) ----------
// gripperframe (the TCP) sits at x = +12 mm, 98.1 mm below the wrist-roll origin.
// The fixed-jaw tip pad face (fixed_jaw_box4, +x face) is at x = -8.0 mm; the moving jaw is on +x.
export const TCP_X = 0.012;
export const FIXED_PAD_X = -0.008;
/**
 * The lowest point of the fingers (fixed-jaw tip capsule, bottom at gripper z = -104.1 mm) is
 * 6.0 mm below the TCP; the moving fingertip is 4.1 mm below at gripper = 0 and rises as it opens.
 */
export const FINGERTIP_BELOW_TCP = 0.006;
export const FINGERTIP_BELOW_TCP_MM = 6.0;
/**
 * Both jaws have contact pads from 4 mm below to 15 mm above the TCP (moving-jaw boxes 2 and 3
 * at grasp openings; the fixed jaw reaches higher). Their common centre is 5 mm above the TCP.
 */
export const PAD_CENTRE_ABOVE_TCP = 0.005;
/** fingertips never go closer than this to the deck (or the containment floor) */
export const DECK_CLEARANCE = 0.002;

/**
 * TCP height to grasp a sample of height h (m) resting on z = 0: the pad centre at mid-height,
 * but never lower than the fingertips plus DECK_CLEARANCE allow (8 mm).
 * graspZ(0.024) = 0.008, graspZ(0.045) = 0.0175.
 */
export function graspZ(h: number): number {
  return Math.max(h / 2 - PAD_CENTRE_ABOVE_TCP, FINGERTIP_BELOW_TCP + DECK_CLEARANCE);
}

/**
 * Horizontal offset (m) from a held sample's centre to the TCP, along the jaw axis (fixed jaw ->
 * moving jaw). Only the moving jaw moves, so a sample of grip width w is held with one face on
 * the fixed pad: its centre is at FIXED_PAD_X + w/2 in the gripper frame. 24 mm -> +8 mm.
 */
export function graspOffset(widthMm: number): number {
  return TCP_X - (FIXED_PAD_X + widthMm / 2000);
}

// ---------- jaw ----------
// The moving-jaw pad face rotates about the gripper joint (gripper-frame x = 20.2 mm), so the gap
// to the fixed pad face along the jaw axis is exactly sinusoidal in the joint angle g:
//   gap(g) = JAW_C + JAW_X0 cos g - JAW_Z0 sin g      (metres)
// with the face 12.3 mm behind and 76.0 mm below the joint at g = 0. Cross-checked against MuJoCo
// (src/core/__fixtures__/mujoco-fk.json jawGapTable): 15.90 mm at g = 0, 42.64 mm at 0.349,
// 104.2 mm at pi/2; max deviation 1e-6 m.
export const JAW_C = 0.0282;
export const JAW_X0 = -0.0123;
export const JAW_Z0 = -0.076;
export const JAW_RANGE: [number, number] = [-0.174533, 1.7453292];

/** jaw gap (m) at gripper joint angle g (rad) */
export function jawGapAt(g: number): number {
  return JAW_C + JAW_X0 * Math.cos(g) - JAW_Z0 * Math.sin(g);
}
/** gripper joint angle for a gap (m), clamped to what the jaw can do (2.9 mm .. 105 mm) */
export function jawForGap(gap: number): number {
  const R = Math.hypot(JAW_X0, JAW_Z0);
  const phi = Math.atan2(-JAW_X0, -JAW_Z0); // gap = C + R sin(g - phi)
  const s = Math.max(-1, Math.min(1, (gap - JAW_C) / R));
  const g = phi + Math.asin(s);
  return Math.max(JAW_RANGE[0], Math.min(JAW_RANGE[1], g));
}
/** how much tighter than the part the jaw is commanded, so the pads visibly bite (mm) */
export const JAW_SQUEEZE_MM = 1.0;
/** gripper joint angle to hold a part of the given grip width (mm): 1 mm tighter than the part */
export function jawForWidth(widthMm: number): number {
  return jawForGap((widthMm - JAW_SQUEEZE_MM) / 1000);
}
/** open jaw: a 60 mm gap clears the widest allowed part (45 mm) by 15 mm on the moving side */
export const JAW_OPEN_GAP_MM = 60;
export const JAW_OPEN = jawForGap(JAW_OPEN_GAP_MM / 1000);
/** grip-width limits (mm) the validator enforces for primitives */
export const GRIP_MIN_MM = 15;
export const GRIP_MAX_MM = 45;
export const HEIGHT_MIN_MM = 10;
export const HEIGHT_MAX_MM = 45;
export const DEPTH_MAX_MM = 60;

// ---------- heights ----------
/**
 * Approach (hover) TCP height, empty gripper: the fingertips are 54 mm above the deck, 9 mm over
 * the tallest allowed sample. Gripper-down IK band at this height, all wrist rolls: rho 100-230 mm.
 */
export const Z_HOVER = 0.06;
/**
 * Carry TCP height: a 45 mm sample grasped at graspZ(45 mm) = 17.5 mm hangs to 52.5 mm, clearing
 * 45 mm neighbours (and every stack, see STACK_MAX_H) by >= 4.5 mm. Higher costs reach fast: the
 * wrist_flex limit (1.658 rad) caps a gripper-down TCP at ~86 mm. IK band here, all rolls:
 * rho 115-215 mm (at 80 mm it would be 130-200 mm).
 */
export const Z_LIFT = 0.07;
/** nothing on the deck may be taller than this (stacks included), so Z_LIFT carries clear it */
export const STACK_MAX_H = 0.048;

// ---------- reach ----------
/**
 * Valid band for sample centres and teleop hover targets, around the shoulder-pan axis.
 * The gripper-down IK solves (err < 1e-4 m, 11 wrist rolls from -2.6 to 2.8 rad) for every TCP
 * with rho in [115, 215] mm at Z_LIFT and [100, 230] mm at Z_HOVER (grasp heights: [70, 260] mm).
 * A held sample's centre is up to 12.5 mm from the TCP (graspOffset), plus 2.5 mm margin:
 * rho in [130, 200] mm. bearingMax keeps everything in front of the arm (pan limit is +-110 deg).
 */
export const REACH = { rhoMin: 0.13, rhoMax: 0.2, bearingMax: (85 * Math.PI) / 180 };

/** bearing of a bay point around the pan axis: 0 toward -y, positive toward +x (radians) */
export function bearingOf(x: number, y: number): number {
  return Math.atan2(x - PAN_AXIS_XY[0], -(y - PAN_AXIS_XY[1]));
}
export function rhoOf(x: number, y: number): number {
  return Math.hypot(x - PAN_AXIS_XY[0], y - PAN_AXIS_XY[1]);
}
/** bay xy for a (rho, bearing) pair */
export function polarXY(rho: number, bearing: number): [number, number] {
  return [PAN_AXIS_XY[0] + rho * Math.sin(bearing), PAN_AXIS_XY[1] - rho * Math.cos(bearing)];
}
/** true when (x, y) lies inside the REACH band, with an optional inward margin (m) */
export function inReach(x: number, y: number, margin = 0): boolean {
  const r = rhoOf(x, y);
  const b = Math.abs(bearingOf(x, y));
  return r >= REACH.rhoMin + margin && r <= REACH.rhoMax - margin && b <= REACH.bearingMax - margin / Math.max(r, 1e-6);
}
/** clamp a bay xy into the REACH band (for teleop hover targets) */
export function clampToReach(x: number, y: number): [number, number] {
  const r = Math.min(REACH.rhoMax, Math.max(REACH.rhoMin, rhoOf(x, y)));
  const b = Math.min(REACH.bearingMax, Math.max(-REACH.bearingMax, bearingOf(x, y)));
  return polarXY(r, b);
}

// ---------- containment bin ----------
/** bin centre: front-left of the arm, rho 180 mm at bearing -45 deg */
export const CONTAINMENT_XY: [number, number] = polarXY(0.18, (-45 * Math.PI) / 180);
/** inner width of the square bin (m): fits a 45 x 60 mm part with room around it */
export const CONTAINMENT_INNER = 0.08;
export const CONTAINMENT_WALL_T = 0.004;
/** outer half-width (m): teleop treats a drop anywhere over the bin (walls included) as containment */
export const CONTAINMENT_OUTER_HALF = CONTAINMENT_INNER / 2 + CONTAINMENT_WALL_T;
/** wall height: 20 mm, far below a carried sample's lowest point at Z_LIFT (52.5 mm) */
export const CONTAINMENT_WALL_H = 0.02;
/** top of the bin floor plate */
export const CONTAINMENT_FLOOR_Z = 0.003;
/** the lowest TCP height inside the bin: fingertips DECK_CLEARANCE above the floor (11 mm) */
export const Z_CONTAINMENT_LOWER = CONTAINMENT_FLOOR_Z + FINGERTIP_BELOW_TCP + DECK_CLEARANCE;
/** samples must keep |dx|, |dy| >= this + their radius from the bin centre */
export const CONTAINMENT_KEEPOUT = 0.05;

/** true when (x, y) is inside the bin's inner square, shrunk by margin */
export function inContainment(x: number, y: number, margin = 0): boolean {
  const h = CONTAINMENT_INNER / 2 - margin;
  return Math.abs(x - CONTAINMENT_XY[0]) <= h && Math.abs(y - CONTAINMENT_XY[1]) <= h;
}

// ---------- default sample spots ----------
/**
 * Five deck spots on the rho = 165 mm arc (the middle of REACH), at bearings 0, +20, -18, +40 and
 * +60 deg: 51.6-57.3 mm apart, all at least 70 mm (|dx| or |dy|) from the bin centre. New samples
 * try these first, then the rest of the reach band (samples.ts SEARCH_SPOTS).
 */
export const SLOTS: [number, number][] = [0, 20, -18, 40, 60].map((d) => polarXY(0.165, (d * Math.PI) / 180));

// ---------- arm poses ----------
/**
 * Home: a compact ready pose, gripper nearly down (approach z = -0.98), TCP at rho 110 mm and
 * 76 mm high, inside the band's inner edge so it does not hide the slots from the bay camera.
 * The jaw is open.
 */
export const HOME_Q: number[] = [0, -1.2, 0.9, 1.65, 0, JAW_OPEN];

// ---------- attach rule ----------
/** a closing jaw attaches a sample whose centre is within this of the TCP in xy (m) */
export const ATTACH_XY_TOL = 0.015;
/**
 * ... and whose bottom is between ATTACH_BAND[0] and ATTACH_BAND[1] metres below the TCP (a sample
 * grasped on the deck has its bottom graspZ(h) = 8-17.5 mm below the TCP)
 */
export const ATTACH_BAND: [number, number] = [-0.002, 0.03];

// ---------- registry ----------
/** the most samples the registry tracks, deck and bin together (the reach band holds 7-9 typical ones) */
export const MAX_SAMPLES = 10;
export const MIN_SPACING = 0.04;
export const SPACING_EXTRA = 0.01;
export const DEFAULT_RELATIVE_MM = 80;

// ---------- bay camera ----------
/**
 * Fixed 768 x 768 bay camera on the -y side, looking down at the deck at 62 deg (z up). It frames
 * the whole REACH band (bearing +-85 deg), every slot (with 45 mm samples on them), the bin, the
 * arm's base and its shoulder: those points project inside x 6-93 % and y 9-77 % of the image
 * (derive-constants.ts searched camera heights, distances and fields of view for the tightest fit).
 * Vertical field of view, as three.js PerspectiveCamera.fov.
 */
export const BAY_CAMERA: { pos: Vec3; target: Vec3; up: Vec3; fovDeg: number; width: number; height: number } = {
  pos: [0, -0.35, 0.5],
  target: [0, -0.08, 0],
  up: [0, 0, 1],
  fovDeg: 42,
  width: 768,
  height: 768,
};
