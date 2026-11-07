import { describe, it, expect } from 'vitest';
import { OneEuroFilter, smoothingAlpha } from './oneEuro';

/** Deterministic pseudo-noise in [-1, 1]. */
function noise(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return (s / 4294967296) * 2 - 1;
  };
}

const std = (a: number[]) => {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
};

describe('One-Euro filter', () => {
  it('passes the first sample through and holds on repeated timestamps', () => {
    const f = new OneEuroFilter();
    expect(f.filter(0.4, 1)).toBe(0.4);
    expect(f.filter(0.9, 1)).toBe(0.4);
    expect(f.filter(0.9, 0.5)).toBe(0.4);
    f.reset();
    expect(f.filter(0.9, 2)).toBe(0.9);
  });

  it('smooths jitter on a still hand by more than 3x', () => {
    const f = new OneEuroFilter();
    const rnd = noise(7);
    const raw: number[] = [];
    const out: number[] = [];
    for (let i = 0; i < 600; i++) {
      const v = 0.5 + 0.004 * rnd();
      raw.push(v);
      const y = f.filter(v, i / 30);
      if (i > 60) out.push(y);
    }
    expect(std(out)).toBeLessThan(std(raw.slice(61)) / 3);
  });

  it('follows a step without overshoot and settles within about a second at 1 Hz', () => {
    const f = new OneEuroFilter();
    f.filter(0, 0);
    let y = 0;
    let prev = 0;
    for (let i = 1; i <= 60; i++) {
      y = f.filter(1, i / 60);
      expect(y).toBeGreaterThanOrEqual(prev);
      expect(y).toBeLessThanOrEqual(1);
      prev = y;
    }
    expect(y).toBeGreaterThan(0.99);
    // speed raises the cutoff: a larger beta lags less on a ramp
    const slow = new OneEuroFilter({ minCutoff: 1, beta: 0, dCutoff: 1 });
    const fast = new OneEuroFilter({ minCutoff: 1, beta: 5, dCutoff: 1 });
    let es = 0;
    let ef = 0;
    for (let i = 0; i <= 30; i++) {
      const t = i / 60;
      es = Math.abs(slow.filter(t, t) - t);
      ef = Math.abs(fast.filter(t, t) - t);
    }
    expect(ef).toBeLessThan(es);
    expect(smoothingAlpha(1, 1 / 60)).toBeCloseTo(1 / (1 + 60 / (2 * Math.PI)), 9);
  });
});
