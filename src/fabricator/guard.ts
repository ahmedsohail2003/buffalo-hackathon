// The guardrail: one uniform scale that makes a measured sample fit the gripper, or a spoken refusal.
// Gemini proposes; this code decides. Node-safe (no three, no DOM).

import { SAMPLE_LIMITS, type SampleLimits } from './limits';
import type { Measured } from './measure';

export type FitKey = 'grasp' | 'height' | 'footprint' | 'mass' | 'com';

export type GuardResult =
  | { ok: true; scale: number; binding: FitKey | null; direction: 'down' | 'up' | 'none'; reasons: string[] }
  | { ok: false; code: string; reason: string; suggestion: string };

interface Bound {
  s: number;
  key: FitKey;
}

const r0 = (v: number) => Math.round(v);
/** Two significant digits under 100 (2.9, 17), whole numbers above. */
const sig = (v: number) => (v >= 100 ? Math.round(v) : Number(v.toPrecision(2)));
/** A scale as a percentage: whole from 10 %, two significant digits below (a 3 m asteroid comes out 1.3 %). */
export const pct = (s: number) => `${s >= 0.1 ? Math.round(s * 100) : sig(s * 100)}%`;
const length = (mm: number) => (mm < 1000 ? `${r0(mm)} mm` : `${sig(mm / 1000)} m`);
const weight = (g: number) => (g < 1000 ? `${r0(g)} g` : g < 1e6 ? `${sig(g / 1000)} kg` : `${sig(g / 1e6)} t`);

/**
 * "48 mm across, 30 mm tall and 307 g": a design as measured, at its real size. designScale is the factor
 * sanitizeProgram shrank an oversize design by before it was built (lengths divide by it, mass by its cube).
 */
export function designedSize(m: Measured, designScale = 1): string {
  const k = designScale;
  return `${length(m.graspWidthMm / k)} across, ${length((m.h * 1000) / k)} tall and ${weight(m.massG / k ** 3)}`;
}

/** Why each limit exists, as one sentence a voice can read. */
export const WHY: Record<FitKey, string> = {
  grasp: 'the pads are only parallel up to about 41 to 45 mm of opening',
  height: 'at hover the fingertips are about 48 mm above the deck, so a carried part taller than about 45 mm hits its neighbours',
  footprint: 'it has to fit the 74 mm sample bin at any yaw',
  mass: "the arm's shoulder servos (STS3215 at 5 V, gripper capped at 50% torque) leave only about 90 g of payload at full reach",
  com: 'a part whose weight sits far from the grip twists out of the jaw',
};

function windowFor(m: Measured, L: SampleLimits, hard: boolean): { hi: Bound; lo: Bound } {
  const gw = m.graspWidthMm, h = m.h * 1000;
  const ups: Bound[] = [
    { s: (hard ? L.graspMaxMm : L.graspTargetMaxMm) / gw, key: 'grasp' },
    { s: (hard ? L.heightMaxMm : L.heightTargetMaxMm) / h, key: 'height' },
    { s: (hard ? L.footprintMaxMm : L.footprintTargetMm) / Math.max(1e-6, m.footprintMm), key: 'footprint' },
    { s: Math.cbrt((hard ? L.massMaxG : L.massTargetG) / Math.max(1e-6, m.massG)), key: 'mass' },
  ];
  if (m.comOffsetMm > 0.05) ups.push({ s: L.comOffsetMaxMm / m.comOffsetMm, key: 'com' });
  const los: Bound[] = [
    { s: (hard ? L.graspMinMm : L.graspTargetMinMm) / gw, key: 'grasp' },
    { s: (hard ? L.heightMinMm : L.heightTargetMinMm) / h, key: 'height' },
  ];
  return { hi: ups.reduce((a, b) => (b.s < a.s ? b : a)), lo: los.reduce((a, b) => (b.s > a.s ? b : a)) };
}

/**
 * The whole-number figures a measured sample is shown with (mm across the jaw, mm tall, g, mm wide), rounded
 * once from the measurement, so the card's numbers and its sentences never disagree by a millimetre.
 */
export function figures(m: Measured): { gw: number; h: number; g: number; fp: number } {
  return { gw: r0(m.widthAlongXMm || m.graspWidthMm), h: r0(m.h * 1000), g: r0(m.massG), fp: r0(m.footprintMm) };
}

/**
 * The guardrail sentence for a sample measured after scaling. scale is the overall scale against the real
 * design (the guardrail's own scale times any design_scale).
 */
export function fitSentence(scale: number, binding: FitKey | null, direction: 'down' | 'up' | 'none', after: Measured): string {
  const { gw, h, g, fp } = figures(after);
  if (direction === 'none' || !binding) {
    return scale === 1
      ? `fits as designed: ${gw} mm across the jaw, ${h} mm tall, ${g} g`
      : `scaled to ${pct(scale)} to fit the fabricator's build volume: ${gw} mm across the jaw, ${h} mm tall, ${g} g`;
  }
  if (direction === 'up') {
    return binding === 'height'
      ? `scaled up to ${pct(scale)} so the fingertips can reach it: ${h} mm tall, ${gw} mm across, ${g} g`
      : `scaled up to ${pct(scale)} so the jaw has something to hold: ${gw} mm across, ${g} g`;
  }
  switch (binding) {
    case 'grasp': return `scaled to ${pct(scale)} so the jaw can close on it: ${gw} mm across, ${g} g`;
    case 'height': return `scaled to ${pct(scale)} so it clears its neighbours when carried: ${h} mm tall, ${gw} mm across, ${g} g`;
    case 'footprint': return `scaled to ${pct(scale)} to fit the sample bin: ${fp} mm wide, ${gw} mm across the jaw, ${g} g`;
    case 'mass': return `scaled to ${pct(scale)} so the arm can lift it: ${g} g, ${gw} mm across`;
    case 'com': return `scaled to ${pct(scale)} so its centre of mass stays within 10 mm of the grip: ${gw} mm across, ${g} g`;
  }
}

/** A refusal. Its first clause, up to the ';', is what mission control speaks (voice/announcer.ts). */
function reject(m: Measured, L: SampleLimits, lo: Bound, hi: Bound): GuardResult {
  const gw = m.graspWidthMm, h = m.h * 1000, fp = m.footprintMm;
  const at = (s: number) => ({ gw: r0(gw * s), h: r0(h * s), mass: r0(m.massG * s ** 3), fp: r0(fp * s) });
  const a = at(hi.s);
  const b = at(lo.s);
  if (lo.key === 'grasp' && hi.key === 'height') {
    return { ok: false, code: 'TOO_THIN', reason: `it is too tall and thin for the jaw; short enough to carry (${L.heightMaxMm} mm) it would be only ${a.gw} mm across, and the jaw needs at least ${L.graspMinMm} mm`,
      suggestion: `make it at least ${Math.ceil((h * L.graspMinMm) / L.heightMaxMm)} mm across, or no taller than ${Math.max(1, Math.floor((gw * L.heightMaxMm) / L.graspMinMm))} mm?` };
  }
  if (lo.key === 'grasp' && hi.key === 'footprint') {
    return { ok: false, code: 'TOO_THIN', reason: `it is too long and thin; inside the ${L.footprintMaxMm} mm footprint it would be only ${a.gw} mm across, and the jaw needs at least ${L.graspMinMm} mm`,
      suggestion: `make it at least ${Math.ceil((fp * L.graspMinMm) / L.footprintMaxMm)} mm thick for its ${r0(fp)} mm length?` };
  }
  if (hi.key === 'mass') {
    return { ok: false, code: 'TOO_DENSE', reason: `it is too dense to lift; at the smallest size the gripper can hold it would still weigh ${b.mass} g, over the ${L.massMaxG} g the arm can carry`,
      suggestion: 'make it hollow, or a lighter material such as aluminium or rock?' };
  }
  if (hi.key === 'com') {
    return { ok: false, code: 'OFF_CENTRE', reason: `its weight sits ${r0(m.comOffsetMm * lo.s)} mm off the grip centre even at the smallest size the jaw can hold; it would twist out of the jaw`,
      suggestion: 'balance it so the heavy part is over the middle?' };
  }
  if (lo.key === 'height' && (hi.key === 'grasp' || hi.key === 'footprint')) {
    const lim = hi.key === 'grasp' ? L.graspMaxMm : L.footprintMaxMm;
    const size = hi.key === 'grasp' ? gw : fp;
    return { ok: false, code: 'TOO_FLAT', reason: `it is too flat and wide; small enough for the ${hi.key === 'grasp' ? 'jaw' : 'footprint'} it would be only ${a.h} mm tall, and the fingertips need at least ${L.heightMinMm} mm`,
      suggestion: `make it at least ${Math.ceil((size * L.heightMinMm) / lim)} mm tall, or narrower?` };
  }
  return { ok: false, code: 'NO_SCALE_FITS', reason: `no single scale makes it fit; it is ${r0(gw)} mm across, ${r0(h)} mm tall and ${r0(m.massG)} g`, suggestion: 'make it more compact, about as wide as it is tall?' };
}

/**
 * Choose ONE uniform scale s: the largest s <= 1 that meets every upper target (mass scales with s^3), or, if the
 * sample is too small, the smallest s >= 1 that meets the lower targets. If the targets conflict but the hard limits
 * still leave a window, sit inside it; if not, reject with a speakable reason and a concrete suggestion.
 */
export function fitToGripper(m: Measured, limits: SampleLimits = SAMPLE_LIMITS, floating: string[] = []): GuardResult {
  if (floating.length) {
    return { ok: false, code: 'FLOATING_PART', reason: `${floating[0]} is floating away from the rest of the sample`, suggestion: 'move it so it touches the main body?' };
  }
  if (!(m.graspWidthMm > 0.1) || !(m.h > 1e-4)) {
    return { ok: false, code: 'EMPTY', reason: 'the design came out empty, there is nothing to hold', suggestion: 'describe it again with a size?' };
  }
  const T = windowFor(m, limits, false);
  let s: number;
  let binding: FitKey | null = null;
  let direction: 'down' | 'up' | 'none' = 'none';
  if (T.lo.s <= T.hi.s) {
    if (T.hi.s < 1) {
      s = T.hi.s;
      binding = T.hi.key;
      direction = 'down';
    } else if (T.lo.s > 1) {
      s = T.lo.s;
      binding = T.lo.key;
      direction = 'up';
    } else s = 1;
  } else {
    const H = windowFor(m, limits, true);
    if (H.lo.s > H.hi.s * 0.99) return reject(m, limits, H.lo, H.hi);
    s = Math.min(H.hi.s * 0.99, Math.max(H.lo.s * 1.01, 1));
    if (s < 1) {
      binding = H.hi.key;
      direction = 'down';
    } else if (s > 1) {
      binding = H.lo.key;
      direction = 'up';
    }
  }
  if (Math.abs(s - 1) < 0.005) {
    s = 1;
    direction = 'none';
    binding = null;
  }
  const predicted: Measured = {
    ...m, w: m.w * s, d: m.d * s, h: m.h * s, graspWidthMm: m.graspWidthMm * s, widthAlongXMm: m.graspWidthMm * s,
    footprintMm: m.footprintMm * s, volumeCm3: m.volumeCm3 * s ** 3, massG: m.massG * s ** 3, comOffsetMm: m.comOffsetMm * s,
  };
  const reasons = [fitSentence(s, binding, direction, predicted)];
  if (binding) reasons.push(`why: ${WHY[binding]}`);
  if (s !== 1) reasons.push(`as designed it was ${designedSize(m)}`);
  if (predicted.massG > limits.massWarnG) reasons.push(`heavy for this arm: ${r0(predicted.massG)} g is above the ${limits.massWarnG} g comfort level`);
  return { ok: true, scale: s, binding, direction, reasons };
}
