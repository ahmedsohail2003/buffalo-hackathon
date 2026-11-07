import { describe, expect, it } from 'vitest';
import { clearHandFrame, emptyHandFrame, getHandFrame, handFrameSeq, isHandPresent, normalizeHandFrame, setHandFrame } from './hand';

const hand21 = Array.from({ length: 21 }, (_, i) => ({ x: i / 21, y: 0.5, z: 0 }));

describe('hand frame store', () => {
  it('keeps the latest frame and counts updates', () => {
    const s0 = handFrameSeq();
    setHandFrame(emptyHandFrame(100, 'camera'));
    setHandFrame({ t: 120, landmarks: hand21, gesture: 'Open_Palm', gestureScore: 0.9, source: 'camera' });
    expect(handFrameSeq()).toBe(s0 + 2);
    expect(getHandFrame()?.gesture).toBe('Open_Palm');
    clearHandFrame();
    expect(getHandFrame()).toBeNull();
  });

  it('treats only fresh, complete frames as a present hand', () => {
    const f = { t: 1000, landmarks: hand21, gesture: null, gestureScore: 0, source: 'sim' as const };
    expect(isHandPresent(f, 1100)).toBe(true);
    expect(isHandPresent(f, 1400)).toBe(false);
    expect(isHandPresent(emptyHandFrame(1000, 'sim'), 1000)).toBe(false);
    expect(isHandPresent(null, 0)).toBe(false);
  });

  it('normalizes a partial frame pushed by hand', () => {
    const f = normalizeHandFrame({ gesture: 'Closed_Fist' }, 42);
    expect(f).toEqual({ t: 42, landmarks: [], gesture: 'Closed_Fist', gestureScore: 1, source: 'sim' });
    const g = normalizeHandFrame({ gesture: 'None', landmarks: [{ x: 0.5 } as never], source: 'camera' }, 7);
    expect(g.gesture).toBeNull();
    expect(g.gestureScore).toBe(0);
    expect(g.landmarks[0]).toEqual({ x: 0.5, y: 0, z: 0 });
    expect(g.source).toBe('camera');
  });
});
