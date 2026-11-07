import { describe, expect, it } from 'vitest';
import { DwellMachine } from './safetyAdapter';

describe('temporary dwell machine', () => {
  it('fires once after the dwell and latches until release', () => {
    const m = new DwellMachine();
    expect(m.feed('Open_Palm', 0.9, 0)).toBeNull();
    expect(m.snapshot().phase).toBe('debouncing');
    expect(m.feed('Open_Palm', 0.9, 150)).toBeNull();
    expect(m.snapshot().phase).toBe('arming');
    expect(m.feed('Open_Palm', 0.9, 310)).toBe('STOP');
    expect(m.feed('Open_Palm', 0.9, 900)).toBeNull();
    expect(m.snapshot().phase).toBe('fired');
    expect(m.feed(null, 0, 950)).toBeNull();
    expect(m.snapshot().phase).toBe('idle');
    m.feed('Open_Palm', 0.9, 1000);
    expect(m.feed('Open_Palm', 0.9, 1400)).toBe('STOP');
  });

  it('ignores low scores and unknown gestures, and restarts the dwell on a change', () => {
    const m = new DwellMachine();
    expect(m.feed('Closed_Fist', 0.3, 0)).toBeNull();
    expect(m.feed('ILoveYou', 0.99, 0)).toBeNull();
    expect(m.snapshot().phase).toBe('idle');
    m.feed('Thumb_Up', 0.9, 0);
    m.feed('Closed_Fist', 0.9, 500);
    expect(m.feed('Closed_Fist', 0.9, 900)).toBeNull();
    expect(m.feed('Closed_Fist', 0.9, 1110)).toBe('ESTOP');
  });
});
