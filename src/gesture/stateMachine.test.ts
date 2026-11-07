import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  GestureStateMachine,
  type GestureLabel,
  type MachineEvent,
} from './stateMachine';

// Test config mirrors the defaults so timing math below is explicit:
// minConfidence 0.6, debounce 120 ms, dwell 600 ms, e-stop dwell 1500 ms,
// refractory 1200 ms, loss grace 120 ms.
const CFG = { ...DEFAULT_CONFIG };
const STEP = 16; // ~60 fps sampling, like requestAnimationFrame

/** Feed a constant sample from `from` to `to` (inclusive), collecting events. */
function feed(
  m: GestureStateMachine,
  label: GestureLabel | null,
  confidence: number,
  from: number,
  to: number,
): MachineEvent[] {
  const events: MachineEvent[] = [];
  for (let t = from; t <= to; t += STEP) {
    events.push(...m.sample(label, confidence, t));
  }
  return events;
}

function ofType<T extends MachineEvent['type']>(
  events: MachineEvent[],
  type: T,
): Extract<MachineEvent, { type: T }>[] {
  return events.filter(
    (e): e is Extract<MachineEvent, { type: T }> => e.type === type,
  );
}

describe('confidence gate', () => {
  it('ignores detections below minConfidence', () => {
    const m = new GestureStateMachine(CFG);
    const events = feed(m, 'Open_Palm', 0.3, 0, 1000);
    expect(ofType(events, 'armed')).toHaveLength(0);
    expect(ofType(events, 'fired')).toHaveLength(0);
    expect(m.snapshot(1016).phase).toBe('idle');
  });

  it('still logs raw detections below the gate', () => {
    const m = new GestureStateMachine(CFG);
    const events = feed(m, 'Open_Palm', 0.3, 0, 160);
    expect(ofType(events, 'raw').length).toBeGreaterThan(0);
    expect(m.counters().raw).toBe(ofType(events, 'raw').length);
  });
});

describe('debounce window', () => {
  it('filters flickers shorter than debounceMs', () => {
    const m = new GestureStateMachine(CFG);
    const events = feed(m, 'Open_Palm', 0.9, 0, 96); // < 120 ms
    events.push(...feed(m, null, 0, 112, 600));
    expect(ofType(events, 'armed')).toHaveLength(0);
    expect(m.counters().falseStarts).toBe(0); // never armed, so no false start
  });

  it('arms once the gesture is stable for debounceMs', () => {
    const m = new GestureStateMachine(CFG);
    const events = feed(m, 'Open_Palm', 0.9, 0, 200);
    const armed = ofType(events, 'armed');
    expect(armed).toHaveLength(1);
    expect(armed[0].command).toBe('STOP');
    expect(armed[0].t).toBeGreaterThanOrEqual(CFG.debounceMs);
    expect(armed[0].t).toBeLessThan(CFG.debounceMs + 2 * STEP);
  });
});

describe('dwell arming and firing', () => {
  it('fires after debounce + dwell with measured latency', () => {
    const m = new GestureStateMachine(CFG);
    const events = feed(m, 'Open_Palm', 0.9, 0, 900);
    const fired = ofType(events, 'fired');
    expect(fired).toHaveLength(1);
    expect(fired[0].command).toBe('STOP');
    // Ideal latency = 120 debounce + 600 dwell = 720 ms (plus quantization).
    expect(fired[0].latencyMs).toBeGreaterThanOrEqual(700);
    expect(fired[0].latencyMs).toBeLessThanOrEqual(780);
    expect(m.counters().fired).toBe(1);
    expect(m.counters().avgLatencyMs).toBe(fired[0].latencyMs);
  });

  it('reports dwell progress between 0 and 1 while arming', () => {
    const m = new GestureStateMachine(CFG);
    feed(m, 'Open_Palm', 0.9, 0, 416); // armed near 128, ~288 ms into dwell
    const snap = m.snapshot(416);
    expect(snap.phase).toBe('arming');
    expect(snap.dwellProgress).toBeGreaterThan(0.35);
    expect(snap.dwellProgress).toBeLessThan(0.6);
    expect(snap.command).toBe('STOP');
  });

  it('respects an adjusted dwell time', () => {
    const m = new GestureStateMachine(CFG);
    m.setDwellMs(300);
    const events = feed(m, 'Thumb_Up', 0.9, 0, 500);
    expect(ofType(events, 'fired')).toHaveLength(1);
  });
});

describe('false starts', () => {
  it('counts a release during arming as a false start', () => {
    const m = new GestureStateMachine(CFG);
    const events = feed(m, 'Open_Palm', 0.9, 0, 400); // armed, dwell incomplete
    events.push(...feed(m, null, 0, 416, 900));
    const fs = ofType(events, 'false_start');
    expect(fs).toHaveLength(1);
    expect(fs[0].command).toBe('STOP');
    expect(fs[0].heldMs).toBeGreaterThanOrEqual(400);
    expect(ofType(events, 'fired')).toHaveLength(0);
    expect(m.counters().falseStarts).toBe(1);
  });

  it('tolerates dropouts shorter than the loss grace', () => {
    const m = new GestureStateMachine(CFG);
    const events = feed(m, 'Open_Palm', 0.9, 0, 300);
    events.push(...feed(m, null, 0, 316, 380)); // 80 ms gap < 120 ms grace
    events.push(...feed(m, 'Open_Palm', 0.9, 396, 1100));
    expect(ofType(events, 'fired')).toHaveLength(1);
    expect(m.counters().falseStarts).toBe(0);
  });

  it('counts a mid-arming gesture switch as a false start and re-arms', () => {
    const m = new GestureStateMachine(CFG);
    const events = feed(m, 'Open_Palm', 0.9, 0, 400);
    events.push(...feed(m, 'Thumb_Up', 0.9, 416, 1300));
    const fs = ofType(events, 'false_start');
    expect(fs).toHaveLength(1);
    expect(fs[0].command).toBe('STOP');
    const fired = ofType(events, 'fired');
    expect(fired).toHaveLength(1);
    expect(fired[0].command).toBe('RESUME');
  });
});

describe('emergency stop long hold', () => {
  it('does not fire EMERGENCY_STOP for a hold shorter than 1.5 s', () => {
    const m = new GestureStateMachine(CFG);
    const events = feed(m, 'Closed_Fist', 0.9, 0, 1000);
    events.push(...feed(m, null, 0, 1016, 1400));
    expect(ofType(events, 'armed')).toHaveLength(1);
    expect(ofType(events, 'fired')).toHaveLength(0);
    expect(m.counters().falseStarts).toBe(1);
  });

  it('fires EMERGENCY_STOP after the full 1.5 s dwell', () => {
    const m = new GestureStateMachine(CFG);
    const events = feed(m, 'Closed_Fist', 0.9, 0, 1700);
    const fired = ofType(events, 'fired');
    expect(fired).toHaveLength(1);
    expect(fired[0].command).toBe('EMERGENCY_STOP');
    expect(fired[0].latencyMs).toBeGreaterThanOrEqual(CFG.estopDwellMs);
  });
});

describe('refractory period', () => {
  it('a continuously held gesture fires exactly once', () => {
    const m = new GestureStateMachine(CFG);
    const events = feed(m, 'Thumb_Up', 0.9, 0, 3000);
    expect(ofType(events, 'fired')).toHaveLength(1);
    expect(m.counters().falseStarts).toBe(0);
  });

  it('the same gesture can fire again after release + refractory', () => {
    const m = new GestureStateMachine(CFG);
    const events = feed(m, 'Thumb_Up', 0.9, 0, 800); // fires ~728
    events.push(...feed(m, null, 0, 816, 2100)); // released past refractory
    events.push(...feed(m, 'Thumb_Up', 0.9, 2116, 3100));
    expect(ofType(events, 'fired')).toHaveLength(2);
  });

  it('the same gesture cannot re-fire inside refractory after a brief release', () => {
    const m = new GestureStateMachine(CFG);
    const events = feed(m, 'Thumb_Up', 0.9, 0, 800); // fires ~728
    events.push(...feed(m, null, 0, 816, 1016)); // ~200 ms release, well inside refractory
    events.push(...feed(m, 'Thumb_Up', 0.9, 1032, 1900)); // re-presented before ~1928
    expect(ofType(events, 'fired')).toHaveLength(1); // suppressed until refractory ends
    events.push(...feed(m, null, 0, 1916, 2100)); // fresh release past refractory
    events.push(...feed(m, 'Thumb_Up', 0.9, 2116, 3000));
    expect(ofType(events, 'fired')).toHaveLength(2);
  });

  it('a different gesture can arm during refractory (STOP is never delayed)', () => {
    const m = new GestureStateMachine(CFG);
    const events = feed(m, 'Thumb_Up', 0.9, 0, 736); // RESUME fires ~728
    events.push(...feed(m, 'Open_Palm', 0.9, 752, 1600));
    const fired = ofType(events, 'fired');
    expect(fired).toHaveLength(2);
    expect(fired[1].command).toBe('STOP');
    // STOP fired well inside RESUME's 1200 ms refractory window.
    expect(fired[1].t).toBeLessThan(fired[0].t + CFG.refractoryMs);
  });
});

describe('logging for study measures', () => {
  it('counts every raw detection', () => {
    const m = new GestureStateMachine(CFG);
    const events = feed(m, 'Victory', 0.9, 0, 320);
    const rawFed = Math.floor(320 / STEP) + 1;
    expect(ofType(events, 'raw')).toHaveLength(rawFed);
    expect(m.counters().raw).toBe(rawFed);
  });

  it('averages dwell-to-fire latency across fires', () => {
    const m = new GestureStateMachine(CFG);
    feed(m, 'Open_Palm', 0.9, 0, 800);
    feed(m, null, 0, 816, 2200);
    feed(m, 'Thumb_Up', 0.9, 2216, 3100);
    const c = m.counters();
    expect(c.fired).toBe(2);
    expect(c.avgLatencyMs).toBeGreaterThanOrEqual(700);
    expect(c.avgLatencyMs).toBeLessThanOrEqual(800);
  });
});
