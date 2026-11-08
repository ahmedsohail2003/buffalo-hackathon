// Bay facts for tool descriptions, prompts and fallbacks, as published by the arm core
// (src/core/constants.ts). The integrator may pass the core's own predicate instead:
//   configureTools({ inContainment: (s) => !s.held && inContainment(s.pos[0], s.pos[1]) })
// Millimetres unless the name says otherwise. No DOM.
import type { Sample } from '../contracts';

export const BAY_FACTS = {
  /** containment bin centre, bay frame */
  containmentMm: [-127, -127] as [number, number],
  containmentInnerMm: 80,
  containmentWallMm: 20,
  /** sample centres the arm can reach: distance from the base axis and bearing from straight ahead (-y) */
  reach: { minMm: 130, maxMm: 200, bearingDeg: 85 },
  firstSlotMm: [0, -165] as [number, number],
  jawOpenMm: 60,
  grip: { minMm: 15, maxMm: 45 },
  height: { minMm: 10, maxMm: 45 },
  massMaxG: 100,
  /** least distance between two sample centres on the deck (larger parts need more) */
  spacingMinMm: 40,
  /** deck keep-out around the bin: this much plus the part's radius from the bin centre */
  binKeepoutMm: 50,
} as const;

export const BAY_FRAME_TEXT =
  'Bay frame, millimetres: the arm base is at (0, 0), x is to the right and y points away from the operator, so the arm reaches toward negative y; z is up from the deck.';

const f = BAY_FACTS;

/** One paragraph for system prompts. */
export const BAY_FACTS_TEXT = [
  BAY_FRAME_TEXT,
  `The arm reaches sample centres ${f.reach.minMm} to ${f.reach.maxMm} mm from its base, up to ${f.reach.bearingDeg} degrees either side of straight ahead.`,
  `The containment bin is centred at (${f.containmentMm[0]}, ${f.containmentMm[1]}) mm, ${f.containmentInnerMm} mm wide inside, with ${f.containmentWallMm} mm walls.`,
  `The first sample slot is at (${f.firstSlotMm[0]}, ${f.firstSlotMm[1]}) mm.`,
  `The gripper opens to about ${f.jawOpenMm} mm. Code keeps every sample ${f.grip.minMm} to ${f.grip.maxMm} mm across the jaw, ${f.height.minMm} to ${f.height.maxMm} mm tall and at most ${f.massMaxG} g.`,
  `Parts on the deck need ${f.spacingMinMm} mm or more between centres (larger parts need more), and the bin has a keep-out: no deck spot within ${f.binKeepoutMm} mm plus the part's radius of its centre.`,
  'To put a held sample down, give place_sample a side of the deck (left, right, front, behind or center) and code chooses a free spot there.',
].join(' ');

/** Registry answer to "is this sample in containment?": its centre inside the bin's inner square. */
export function defaultInContainment(s: Sample): boolean {
  if (s.held) return false;
  const half = f.containmentInnerMm / 2000;
  return Math.abs(s.pos[0] - f.containmentMm[0] / 1000) <= half && Math.abs(s.pos[1] - f.containmentMm[1] / 1000) <= half;
}
