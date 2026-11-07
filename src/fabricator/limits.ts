// Guardrail numbers for fabricated samples (docs/ARCHITECTURE.md, "Guardrails for fabricated samples").
// Accept = hard limits; target = what the one uniform scale aims for.

import { FINGERTIP_BELOW_TCP, graspZ } from '../core/constants';

export const SAMPLE_LIMITS = {
  /** across-jaw width from fingertip level up, minimised over yaw; the pads are only parallel up to ~41-45 mm */
  graspMinMm: 15,
  graspMaxMm: 45,
  graspTargetMinMm: 16,
  graspTargetMaxMm: 40,
  /** at hover the fingertips are ~48 mm above the deck: a taller carried sample hits its neighbours */
  heightMinMm: 10,
  heightMaxMm: 45,
  heightTargetMinMm: 11,
  heightTargetMaxMm: 40,
  /** bounding-circle diameter: fits the 74 mm containment bin at any yaw */
  footprintMaxMm: 60,
  footprintTargetMm: 55,
  /** shoulder servos at 5 V with the gripper at 50 % torque leave ~90 g of payload at full reach */
  massMaxG: 100,
  massTargetG: 90,
  massWarnG: 50,
  /** a sample whose weight sits far from the grip twists out of the jaw */
  comOffsetMaxMm: 10,
};

export type SampleLimits = typeof SAMPLE_LIMITS;

/**
 * Height above a sample's bottom where the fingertips sit when it is gripped, mm. Taken from the SO-101
 * core (src/core/constants.ts) so the guardrail measures exactly the band the jaw will close on: the grasp
 * TCP sits graspZ(h) above the sample's bottom and the fingertips end FINGERTIP_BELOW_TCP below the TCP.
 * Only what is above the fingertips is between the fingers.
 */
export function fingertipHeightMm(hMm: number): number {
  return Math.max(1, (graspZ(hMm / 1000) - FINGERTIP_BELOW_TCP) * 1000);
}
