// One-Euro filter (Casiez, Roussel & Vogel, CHI 2012): an adaptive low-pass for noisy
// pointing input. Slow hand motion gets a low cutoff (no jitter), fast motion raises the
// cutoff (little lag). Node-safe, no imports.

export interface OneEuroParams {
  /** cutoff at rest, Hz */
  minCutoff: number;
  /** cutoff increase per unit/s of filtered speed */
  beta: number;
  /** cutoff of the derivative filter, Hz */
  dCutoff: number;
}

export const ONE_EURO_DEFAULTS: OneEuroParams = { minCutoff: 1.0, beta: 0.02, dCutoff: 1.0 };

/** Smoothing factor of a first-order low-pass with the given cutoff at sample period dt. */
export function smoothingAlpha(cutoffHz: number, dtS: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtS);
}

export class OneEuroFilter {
  private x: number | null = null;
  private dx = 0;
  private tPrev = 0;

  constructor(readonly params: OneEuroParams = ONE_EURO_DEFAULTS) {}

  /** Forget the history: the next sample passes through unfiltered. */
  reset(): void {
    this.x = null;
    this.dx = 0;
  }

  /** Last filtered value, or null before the first sample. */
  value(): number | null {
    return this.x;
  }

  /** Filter one sample taken at time tS (seconds). Repeated or older timestamps return the held value. */
  filter(v: number, tS: number): number {
    if (!Number.isFinite(v)) return this.x ?? v;
    if (this.x === null) {
      this.x = v;
      this.dx = 0;
      this.tPrev = tS;
      return v;
    }
    const dt = tS - this.tPrev;
    if (!(dt > 0)) return this.x;
    this.tPrev = tS;
    const { minCutoff, beta, dCutoff } = this.params;
    const rawDx = (v - this.x) / dt;
    this.dx += smoothingAlpha(dCutoff, dt) * (rawDx - this.dx);
    const cutoff = minCutoff + beta * Math.abs(this.dx);
    this.x += smoothingAlpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}
