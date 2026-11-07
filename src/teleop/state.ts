// Module-level teleop state for readers outside React: the camera loop (hand frames, the fist
// mask) and the three.js scene (hover-target marker). The teleop controller writes the status
// every step; the camera loop or the simulated hand publishes hand frames. Node-safe.

import type { HandFrame, TeleopStatus } from '../contracts';
import { FistPinchMask } from './mapping';

let status: TeleopStatus | null = null;
let pinch = Infinity;
let hand: HandFrame | null = null;
const fistMask = new FistPinchMask();

export function setTeleopStatus(s: TeleopStatus | null): void {
  status = s;
}
/** Latest teleop status, or null before teleop exists. */
export function getTeleopStatus(): TeleopStatus | null {
  return status;
}
export function isTeleopEnabled(): boolean {
  return status?.enabled === true;
}

export function setPinchRatio(r: number): void {
  pinch = r;
}
/** Latest pinch ratio seen by teleop (Infinity when no hand). */
export function getPinchRatio(): number {
  return pinch;
}

/** Camera loop or simulated hand: publish this frame's hand (null when no hand is seen). */
export function publishHandFrame(f: HandFrame | null): void {
  hand = f;
}
/** Latest published hand frame, or null. Teleop checks its age (dead-man). */
export function latestHandFrame(): HandFrame | null {
  return hand;
}

/**
 * Camera loop, every frame, before passing the recognizer label to the safety gesture machine:
 * true means "withhold this Closed_Fist sample" (pass null instead). Only while teleop is on and
 * the hand is in a real pinch pose, for at most 500 ms per continuous pinch.
 */
export function shouldSuppressFist(frame: HandFrame | null, nowMs: number): boolean {
  return fistMask.suppress(frame?.gesture ?? null, frame?.landmarks, isTeleopEnabled(), nowMs);
}

/**
 * The safety label filter: the label to feed the gesture machine for this sample. The mask is
 * consulted on EVERY sample (so its pinch timer resets when the pose ends), and only a
 * Closed_Fist label is ever withheld.
 */
export function fistMaskFilter(label: string | null, frame: HandFrame | null, nowMs: number): string | null {
  const hide = shouldSuppressFist(frame, nowMs);
  return label === 'Closed_Fist' && hide ? null : label;
}
