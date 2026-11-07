// Jaw command for a part width, from the MuJoCo jaw-gap probe
// (tests/fixtures/mujoco-jaw_gap_table.json; mean of pads 1–2 per jaw value).
// The probed gap is between pad centres; the pads take ~2 mm, so a part of width
// w sits between the pads when gap ≈ w + 2 mm. 24 mm → 0.113 (physics settled
// at 0.1127 holding the seed block).

/** [jaw joint value, mean pad gap in metres], ascending. */
const JAW_GAP: ReadonlyArray<readonly [number, number]> = [
  [-0.174, 0.00545], [-0.124, 0.009], [-0.074, 0.0125], [-0.024, 0.0161], [0.026, 0.01965],
  [0.076, 0.0233], [0.126, 0.02695], [0.176, 0.0306], [0.226, 0.03415], [0.276, 0.0378],
  [0.326, 0.0414], [0.376, 0.045], [0.426, 0.04845], [0.476, 0.0519], [0.526, 0.05535],
  [0.576, 0.0587], [0.626, 0.06195], [0.676, 0.06515], [0.726, 0.0682], [0.776, 0.0712],
  [0.826, 0.0741], [0.876, 0.0768], [0.926, 0.07945], [0.976, 0.08195], [1.026, 0.08435],
  [1.076, 0.08655], [1.126, 0.08865], [1.176, 0.0906], [1.226, 0.09235], [1.276, 0.094],
  [1.326, 0.09545], [1.376, 0.09675], [1.426, 0.0979], [1.476, 0.0988], [1.526, 0.09955],
  [1.576, 0.10015], [1.626, 0.10055], [1.676, 0.1008], [1.726, 0.1008],
];

const PAD_MM = 2;

/** Jaw joint value that holds a part `widthMm` wide (piecewise-linear inverse of the probe). */
export function jawQForWidth(widthMm: number): number {
  const g = (widthMm + PAD_MM) / 1000;
  if (g <= JAW_GAP[0][1]) return JAW_GAP[0][0];
  for (let i = 0; i < JAW_GAP.length - 1; i++) {
    const [j0, g0] = JAW_GAP[i];
    const [j1, g1] = JAW_GAP[i + 1];
    if (g >= g0 && g <= g1) return g1 === g0 ? j0 : j0 + ((j1 - j0) * (g - g0)) / (g1 - g0);
  }
  return JAW_GAP[JAW_GAP.length - 1][0];
}

/** Pad gap (metres) for a jaw joint value — the forward table, for display. */
export function jawGapForQ(q: number): number {
  if (q <= JAW_GAP[0][0]) return JAW_GAP[0][1];
  for (let i = 0; i < JAW_GAP.length - 1; i++) {
    const [j0, g0] = JAW_GAP[i];
    const [j1, g1] = JAW_GAP[i + 1];
    if (q >= j0 && q <= j1) return g0 + ((g1 - g0) * (q - j0)) / (j1 - j0);
  }
  return JAW_GAP[JAW_GAP.length - 1][1];
}
