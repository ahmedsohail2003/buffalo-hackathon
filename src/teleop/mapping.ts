// Hand -> tool-centre mapping for teleop. Pure and node-safe.
//   palm point  = mean of landmarks 0, 5, 9, 13, 17, mirrored (u = 1 - x, v = y)
//   pinch ratio = |lm4 - lm8| / |lm0 - lm9|, with hysteresis and a click on the close edge
//   workspace   = the central 70 % of the image -> the bounding box of the arm's reach band,
//                 then projected into the band in polar coordinates about the base z-axis.
// Bay frame: base at the origin, the arm reaches toward -y (where the operator stands).

import type { HandLandmark } from '../contracts';

/** The valid reach band about the shoulder-pan axis (bearing 0 = toward the operator, -y). */
export interface ReachBand {
  rhoMin: number;
  rhoMax: number;
  bearingMax: number;
}

export const PALM_LANDMARKS = [0, 5, 9, 13, 17] as const;

/** Pinch closes below this ratio (for PINCH_FRAMES frames) and opens above PINCH_OPEN. */
export const PINCH_CLOSE = 0.28;
export const PINCH_OPEN = 0.45;
export const PINCH_FRAMES = 2;
/** Image margin ignored on each side (normalized). */
export const IMG_MARGIN = 0.15;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, s: number) => a + (b - a) * s;
const dist2d = (a: HandLandmark, b: HandLandmark) => Math.hypot(a.x - b.x, a.y - b.y);

/** Palm point in MIRRORED image units (u = 0 at the operator's left as they see the preview). */
export function palmPoint(lm: readonly HandLandmark[]): { u: number; v: number } {
  let x = 0;
  let y = 0;
  for (const i of PALM_LANDMARKS) {
    x += lm[i].x;
    y += lm[i].y;
  }
  return { u: 1 - x / PALM_LANDMARKS.length, v: y / PALM_LANDMARKS.length };
}

/** Palm scale |lm0 - lm9| in normalized image units. */
export function palmScale(lm: readonly HandLandmark[]): number {
  return dist2d(lm[0], lm[9]);
}

/** Thumb-tip to index-tip distance over the palm scale; Infinity for a degenerate hand. */
export function pinchRatio(lm: readonly HandLandmark[]): number {
  if (lm.length < 21) return Infinity;
  const s = palmScale(lm);
  if (!(s > 1e-6)) return Infinity;
  return dist2d(lm[4], lm[8]) / s;
}

/** Middle, ring and pinky as [tip, PIP] landmark pairs. */
const OTHER_FINGERS: readonly [number, number][] = [
  [12, 10],
  [16, 14],
  [20, 18],
];

/** How many of middle / ring / pinky are extended (tip farther from the wrist than its PIP). */
export function fingersExtended(lm: readonly HandLandmark[]): number {
  if (lm.length < 21) return 0;
  let n = 0;
  for (const [tip, pip] of OTHER_FINGERS) if (dist2d(lm[tip], lm[0]) > dist2d(lm[pip], lm[0])) n++;
  return n;
}

/**
 * A teleop PINCH pose: thumb tip near the index finger (ratio < PINCH_OPEN) with at least two of
 * middle / ring / pinky extended. A fist also brings the thumb to the index finger, but curls the
 * other fingers, so it is never a pinch pose.
 */
export function isPinchPose(lm: readonly HandLandmark[]): boolean {
  return pinchRatio(lm) < PINCH_OPEN && fingersExtended(lm) >= 2;
}

/**
 * Pinch click detector. CLOSED after PINCH_FRAMES consecutive frames below PINCH_CLOSE, OPEN
 * above PINCH_OPEN (hysteresis band in between). update() returns true on the close edge only.
 * A click needs an open hand first, so a hand that enters the view already pinched never clicks.
 */
export class PinchDetector {
  closed = false;
  private below = 0;
  private armed = false;

  update(ratio: number): boolean {
    if (Number.isNaN(ratio)) return false;
    if (ratio > PINCH_OPEN) {
      this.closed = false;
      this.below = 0;
      this.armed = true;
      return false;
    }
    if (this.closed) return false;
    if (ratio < PINCH_CLOSE) {
      this.below += 1;
      if (this.below >= PINCH_FRAMES) {
        this.closed = true;
        this.below = 0;
        const click = this.armed;
        this.armed = false;
        return click;
      }
    } else {
      this.below = 0;
    }
    return false;
  }

  /** Hand lost: forget the state; the next click needs an open hand again. */
  reset(): void {
    this.closed = false;
    this.below = 0;
    this.armed = false;
  }
}

export interface WorkspacePoint {
  x: number;
  y: number;
  /** true when the point was pulled into the reach band */
  clamped: boolean;
}

/** Polar coordinates about the base z-axis: bearing 0 toward the operator (-y), positive toward +x. */
export function toPolar(x: number, y: number): { rho: number; bearing: number } {
  return { rho: Math.hypot(x, y), bearing: Math.atan2(x, -y) };
}

/** Project a deck point into the reach band (radius and bearing clamped independently). */
export function clampToReach(x: number, y: number, band: ReachBand): WorkspacePoint {
  const { rho, bearing } = toPolar(x, y);
  const r = Math.min(band.rhoMax, Math.max(band.rhoMin, rho));
  const b = Math.min(band.bearingMax, Math.max(-band.bearingMax, bearing));
  if (Math.abs(r - rho) < 1e-12 && Math.abs(b - bearing) < 1e-12) return { x, y, clamped: false };
  return { x: r * Math.sin(b), y: -r * Math.cos(b), clamped: true };
}

/**
 * The deck rectangle the image maps onto: the bounding box of the reach band, so every point
 * the arm can reach has a hand position. yBase is the edge nearest the base (top of the image),
 * yOperator the edge nearest the operator (bottom of the image).
 */
export function workspaceRect(band: ReachBand): { xMin: number; xMax: number; yBase: number; yOperator: number } {
  const b = Math.min(band.bearingMax, Math.PI / 2);
  const xMax = band.rhoMax * Math.sin(b);
  return { xMin: -xMax, xMax, yBase: -band.rhoMin * Math.cos(b), yOperator: -band.rhoMax };
}

/** Mirrored palm point (u, v) -> deck target (bay frame, metres), clamped into the band. */
export function mapToWorkspace(u: number, v: number, band: ReachBand): WorkspacePoint {
  const r = workspaceRect(band);
  const span = 1 - 2 * IMG_MARGIN;
  const su = clamp01((u - IMG_MARGIN) / span);
  const sv = clamp01((v - IMG_MARGIN) / span);
  // hand higher in the image = farther from the operator = toward the base
  return clampToReach(lerp(r.xMin, r.xMax, su), lerp(r.yBase, r.yOperator, sv), band);
}

/** Inverse of the rectangle map (no clamping): where the palm must be to target deck (x, y). */
export function workspaceToUV(x: number, y: number, band: ReachBand): { u: number; v: number } {
  const r = workspaceRect(band);
  const span = 1 - 2 * IMG_MARGIN;
  return {
    u: IMG_MARGIN + span * ((x - r.xMin) / (r.xMax - r.xMin)),
    v: IMG_MARGIN + span * ((y - r.yBase) / (r.yOperator - r.yBase)),
  };
}

/** Longest a continuous pinch may hide Closed_Fist samples from the safety gesture machine. */
export const FIST_MASK_MS = 500;

/**
 * Camera-side safety mitigation, stateful: a pinch can be classified Closed_Fist. While teleop is
 * on and the hand is in a PINCH pose, a Closed_Fist sample is withheld for at most FIST_MASK_MS of
 * continuous pinch; after that fist samples pass through again, so a real fist still reaches the
 * E-STOP dwell. Feed it every camera frame (the pinch timer resets when the pose ends).
 */
export class FistPinchMask {
  private since: number | null = null;

  suppress(gesture: string | null, lm: readonly HandLandmark[] | null | undefined, teleopOn: boolean, t: number): boolean {
    if (!teleopOn || !lm || !isPinchPose(lm)) {
      this.since = null;
      return false;
    }
    if (this.since === null) this.since = t;
    return gesture === 'Closed_Fist' && t - this.since < FIST_MASK_MS;
  }
}
