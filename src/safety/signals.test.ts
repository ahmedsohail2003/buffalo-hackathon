import { describe, expect, it } from 'vitest';
import { BayGate } from '../core/gate';
import { CONFIDENCE_MIN, ESTOP_DWELL_MS, HandSignals, REFRACTORY_MS, bindSignalsToGate, type SignalEvent } from './signals';

const FRAME = 1000 / 30;

/** feed `label` from t0 for durMs at 30 Hz; returns the events and the next timestamp */
function hold(sig: HandSignals, label: string | null, t0: number, durMs: number, score = 0.9): { events: SignalEvent[]; t: number } {
  const events: SignalEvent[] = [];
  let t = t0;
  for (; t < t0 + durMs - 1e-9; t += FRAME) events.push(...sig.feed(label, score, t));
  return { events, t };
}
const types = (ev: SignalEvent[]): string[] => ev.map((e) => `${e.type}:${e.command}`);

describe('HandSignals', () => {
  it('arms after the debounce and fires STOP after a 600 ms dwell', () => {
    const sig = new HandSignals();
    const { events } = hold(sig, 'Open_Palm', 0, 700);
    expect(types(events)).toEqual(['armed:STOP', 'fired:STOP']);
    expect(events[0].heldMs).toBeGreaterThanOrEqual(120);
    expect(events[0].heldMs).toBeLessThan(120 + FRAME);
    expect(events[1].heldMs).toBeGreaterThanOrEqual(600);
    expect(events[1].heldMs).toBeLessThan(600 + FRAME);
  });

  it('maps every safety gesture to its command', () => {
    const want: Record<string, string> = { Open_Palm: 'STOP', Thumb_Up: 'RESUME', Pointing_Up: 'SLOW', Victory: 'CYCLE_START', Closed_Fist: 'ESTOP' };
    for (const [label, cmd] of Object.entries(want)) {
      const sig = new HandSignals();
      const { events } = hold(sig, label, 0, 1600);
      expect(events.filter((e) => e.type === 'fired').map((e) => e.command)).toEqual([cmd]);
    }
  });

  it('ignores low-confidence and unknown labels', () => {
    const sig = new HandSignals();
    expect(hold(sig, 'Open_Palm', 0, 1000, CONFIDENCE_MIN - 0.01).events).toEqual([]);
    expect(hold(sig, 'Thumb_Down', 1000, 1000).events).toEqual([]);
    expect(hold(sig, 'None', 2000, 1000).events).toEqual([]);
    expect(sig.snapshot().phase).toBe('idle');
  });

  it('a blip shorter than the debounce does nothing', () => {
    const sig = new HandSignals();
    const a = hold(sig, 'Victory', 0, 90);
    const b = hold(sig, null, a.t, 500);
    expect([...a.events, ...b.events]).toEqual([]);
  });

  it('releasing after arming but before the dwell is a false start', () => {
    const sig = new HandSignals();
    const a = hold(sig, 'Thumb_Up', 0, 300);
    const b = hold(sig, null, a.t, 300);
    expect(types([...a.events, ...b.events])).toEqual(['armed:RESUME', 'false_start:RESUME']);
    expect(b.events[0].heldMs).toBeGreaterThan(300);
  });

  it('short dropouts inside a hold do not reset the dwell', () => {
    const sig = new HandSignals();
    const a = hold(sig, 'Open_Palm', 0, 300);
    const gap = hold(sig, null, a.t, 70);
    const c = hold(sig, 'Open_Palm', gap.t, 400);
    const ev = [...a.events, ...gap.events, ...c.events];
    expect(types(ev)).toEqual(['armed:STOP', 'fired:STOP']);
    expect(ev[1].t).toBeLessThan(600 + FRAME * 2);
  });

  it('the fist needs 1500 ms for E-STOP', () => {
    const sig = new HandSignals();
    const a = hold(sig, 'Closed_Fist', 0, 1400);
    expect(types(a.events)).toEqual(['armed:ESTOP']);
    expect(sig.snapshot().progress).toBeGreaterThan(0.9);
    expect(sig.snapshot().progress).toBeLessThan(1);
    const b = hold(sig, 'Closed_Fist', a.t, 200);
    expect(types(b.events)).toEqual(['fired:ESTOP']);
    expect(b.events[0].heldMs).toBeGreaterThanOrEqual(ESTOP_DWELL_MS);
    // a fist released at 1.2 s is a false start, not an E-STOP
    const sig2 = new HandSignals();
    const c = hold(sig2, 'Closed_Fist', 0, 1200);
    const d = hold(sig2, null, c.t, 300);
    expect(types([...c.events, ...d.events])).toEqual(['armed:ESTOP', 'false_start:ESTOP']);
  });

  it('holding on after firing does not fire again', () => {
    const sig = new HandSignals();
    const { events } = hold(sig, 'Open_Palm', 0, 4000);
    expect(events.filter((e) => e.type === 'fired')).toHaveLength(1);
    expect(sig.snapshot()).toMatchObject({ phase: 'fired', progress: 1 });
  });

  it('refractory: the same gesture cannot arm again for 1000 ms after firing', () => {
    const sig = new HandSignals();
    const a = hold(sig, 'Pointing_Up', 0, 620); // fires at ~600
    const fireT = a.events.find((e) => e.type === 'fired')!.t;
    const b = hold(sig, null, a.t, 150);
    const c = hold(sig, 'Pointing_Up', b.t, fireT + REFRACTORY_MS - b.t - FRAME); // re-shown inside the refractory window
    expect(c.events).toEqual([]);
    expect(sig.snapshot().phase).toBe('idle');
    // still held past the window: the dwell starts when the window ends
    const d = hold(sig, 'Pointing_Up', c.t, 800);
    const fired = d.events.filter((e) => e.type === 'fired');
    expect(fired).toHaveLength(1);
    expect(fired[0].t - (fireT + REFRACTORY_MS)).toBeGreaterThanOrEqual(600 - FRAME);
  });

  it('a different gesture may arm at once after a fire', () => {
    const sig = new HandSignals();
    const a = hold(sig, 'Open_Palm', 0, 650);
    const b = hold(sig, 'Thumb_Up', a.t, 800);
    expect(types([...a.events, ...b.events])).toEqual(['armed:STOP', 'fired:STOP', 'armed:RESUME', 'fired:RESUME']);
  });

  it('switching gestures mid-dwell: a false start for the first, the second keeps its own onset', () => {
    const sig = new HandSignals();
    const a = hold(sig, 'Open_Palm', 0, 300);
    const b = hold(sig, 'Closed_Fist', a.t, 1600);
    const ev = types([...a.events, ...b.events]);
    expect(ev).toEqual(['armed:STOP', 'false_start:STOP', 'armed:ESTOP', 'fired:ESTOP']);
    const fired = b.events.find((e) => e.type === 'fired')!;
    expect(fired.t - a.t).toBeGreaterThanOrEqual(ESTOP_DWELL_MS);
    expect(fired.t - a.t).toBeLessThan(ESTOP_DWELL_MS + 2 * FRAME);
  });

  it('snapshot drives the UI ring: debounce -> armed -> fired with progress 0..1', () => {
    const sig = new HandSignals();
    expect(sig.snapshot()).toEqual({ phase: 'idle', gesture: null, command: null, progress: 0, heldMs: 0 });
    sig.feed('Victory', 0.9, 0);
    sig.feed('Victory', 0.9, 60);
    expect(sig.snapshot()).toMatchObject({ phase: 'debounce', gesture: 'Victory', command: 'CYCLE_START' });
    sig.feed('Victory', 0.9, 300);
    expect(sig.snapshot().phase).toBe('armed');
    expect(sig.snapshot().progress).toBeCloseTo(0.5, 9);
    sig.feed('Victory', 0.9, 600);
    expect(sig.snapshot()).toMatchObject({ phase: 'fired', progress: 1 });
  });

  it('ignores samples that go back in time; reset clears everything', () => {
    const sig = new HandSignals();
    sig.feed('Open_Palm', 0.9, 1000);
    expect(sig.feed('Open_Palm', 0.9, 500)).toEqual([]);
    sig.reset();
    expect(sig.snapshot().phase).toBe('idle');
    expect(hold(sig, 'Open_Palm', 0, 700).events).toHaveLength(2);
  });

  it('bindSignalsToGate sends fired commands to the gate as gestures', () => {
    const logs: string[] = [];
    const gate = new BayGate({ log: (t) => logs.push(t) });
    const sig = new HandSignals();
    const seen: SignalEvent[] = [];
    sig.onEvent((e) => seen.push(e));
    bindSignalsToGate(sig, gate);
    let t = hold(sig, 'Victory', 0, 700).t;
    expect(gate.state()).toBe('RUNNING');
    t = hold(sig, null, t, 200).t;
    t = hold(sig, 'Open_Palm', t, 700).t;
    expect(gate.state()).toBe('STOPPED');
    t = hold(sig, 'Closed_Fist', t, 1600).t;
    expect(gate.state()).toBe('ESTOPPED');
    expect(logs.some((l) => l.includes('(gesture)'))).toBe(true);
    expect(seen.filter((e) => e.type === 'fired')).toHaveLength(3);
  });
});
