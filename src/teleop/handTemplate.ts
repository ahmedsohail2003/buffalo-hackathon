// Canonical open right hand, palm toward the camera, as 21 MediaPipe hand landmarks in
// normalized image units of the UNMIRRORED video frame (x right, y down). Palm size
// |lm0 - lm9| = 0.18. Used by the simulated hand (no camera) and by the tests. Node-safe.

import type { HandFrame, HandLandmark } from '../contracts';

const P = (x: number, y: number): HandLandmark => ({ x, y, z: 0 });

/** Landmark order: wrist, thumb 1-4, index 5-8, middle 9-12, ring 13-16, pinky 17-20. */
export const OPEN_HAND: readonly HandLandmark[] = [
  P(0.5, 0.62), // 0 wrist
  P(0.545, 0.595), // 1 thumb CMC
  P(0.58, 0.56), // 2 thumb MCP
  P(0.605, 0.525), // 3 thumb IP
  P(0.625, 0.495), // 4 thumb tip
  P(0.545, 0.455), // 5 index MCP
  P(0.555, 0.395), // 6 index PIP
  P(0.56, 0.355), // 7 index DIP
  P(0.565, 0.32), // 8 index tip
  P(0.5, 0.44), // 9 middle MCP
  P(0.5, 0.37), // 10
  P(0.5, 0.325), // 11
  P(0.5, 0.285), // 12 middle tip
  P(0.458, 0.452), // 13 ring MCP
  P(0.45, 0.39), // 14
  P(0.445, 0.35), // 15
  P(0.44, 0.315), // 16 ring tip
  P(0.42, 0.475), // 17 pinky MCP
  P(0.405, 0.43), // 18
  P(0.397, 0.4), // 19
  P(0.39, 0.372), // 20 pinky tip
];

/** Bone list for drawing (pairs of landmark indices). */
export const HAND_BONES: readonly [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const PALM = [0, 5, 9, 13, 17];

/**
 * The template moved so its palm point sits at (x, y) in unmirrored image units. When
 * pinching, the thumb tip (4) moves onto the index tip (8) and the thumb IP (3) halfway.
 */
export function syntheticHand(x: number, y: number, pinch: boolean): HandLandmark[] {
  let px = 0;
  let py = 0;
  for (const i of PALM) {
    px += OPEN_HAND[i].x;
    py += OPEN_HAND[i].y;
  }
  const dx = x - px / PALM.length;
  const dy = y - py / PALM.length;
  const lm = OPEN_HAND.map((p) => ({ x: p.x + dx, y: p.y + dy, z: 0 }));
  if (pinch) {
    lm[3] = { x: (lm[3].x + lm[8].x) / 2, y: (lm[3].y + lm[8].y) / 2, z: 0 };
    lm[4] = { ...lm[8] };
  }
  return lm;
}

/**
 * Synthetic hand frame for a pointer at (u, v) over the pad (0-1, u = 0 at the pad's left).
 * The camera view is mirrored, so the pad's left is the video's right: x = 1 - u.
 */
export function simHandFrame(u: number, v: number, pinch: boolean, t: number): HandFrame {
  return { t, landmarks: syntheticHand(1 - u, v, pinch), gesture: null, gestureScore: 0, source: 'sim' };
}
