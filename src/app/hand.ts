// The latest hand result (camera or simulated). Module-level on purpose: teleop and the app loop
// read it every tick without going through React state.
import type { HandFrame, HandLandmark } from '../contracts';

let latest: HandFrame | null = null;
let seq = 0;

/** Publish a new hand result. Call once per processed video frame, also when no hand is seen. */
export function setHandFrame(frame: HandFrame): void {
  latest = frame;
  seq += 1;
}

/** The latest hand result, or null before the first frame. */
export function getHandFrame(): HandFrame | null {
  return latest;
}

/** Increments on every setHandFrame, so a reader can tell a new frame from a repeated one. */
export function handFrameSeq(): number {
  return seq;
}

export function clearHandFrame(): void {
  latest = null;
  seq += 1;
}

/** True when the frame is recent and holds a full hand (21 landmarks). */
export function isHandPresent(frame: HandFrame | null, now: number, maxAgeMs = 250): frame is HandFrame {
  return !!frame && now - frame.t <= maxAgeMs && frame.landmarks.length >= 21;
}

/** A frame with no hand in view. */
export function emptyHandFrame(t: number, source: HandFrame['source']): HandFrame {
  return { t, landmarks: [], gesture: null, gestureScore: 0, source };
}

function toLandmarks(v: unknown): HandLandmark[] {
  if (!Array.isArray(v)) return [];
  return v.map((p) => {
    const o = (p ?? {}) as Partial<HandLandmark>;
    return { x: Number(o.x) || 0, y: Number(o.y) || 0, z: Number(o.z) || 0 };
  });
}

/**
 * Fill in the fields a hand-written frame may leave out (used by the DEV hook
 * `window.__hand.push(frame)` and by tests).
 */
export function normalizeHandFrame(input: Partial<HandFrame>, now: number): HandFrame {
  const gesture = typeof input.gesture === 'string' && input.gesture !== 'None' ? input.gesture : null;
  const frame: HandFrame = {
    t: typeof input.t === 'number' && Number.isFinite(input.t) ? input.t : now,
    landmarks: toLandmarks(input.landmarks),
    gesture,
    gestureScore: gesture === null ? 0 : typeof input.gestureScore === 'number' ? input.gestureScore : 1,
    source: input.source === 'camera' ? 'camera' : 'sim',
  };
  if (input.world) frame.world = toLandmarks(input.world);
  return frame;
}
