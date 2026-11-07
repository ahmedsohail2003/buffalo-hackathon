import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadArmDataNode, type So101Data } from '../core';
import { getLog, resetBus } from './bus';
import { setHandFrame } from './hand';
import { bootRuntime, resetRuntimeForTests, type Runtime } from './runtime';

let data: So101Data;
let rt: Runtime;
let t = 0;

/** advance the app by ms in 33 ms ticks */
function run(ms: number): void {
  const end = t + ms;
  while (t < end) {
    t += 33;
    rt.tick(t);
  }
}

beforeAll(async () => {
  data = await loadArmDataNode();
});

beforeEach(async () => {
  resetRuntimeForTests();
  resetBus();
  setHandFrame(null);
  rt = await bootRuntime(data);
  t = performance.now() + 1000;
  rt.tick(t);
});

describe('runtime safety wiring', () => {
  it('drives the gate from the keypad: cycle start, stop, a held fist, then the two-step reset', () => {
    const gate = rt.core.gate;
    rt.setSimGesture('Victory');
    run(800);
    rt.setSimGesture(null);
    run(300);
    expect(gate.state()).toBe('RUNNING');

    rt.setSimGesture('Open_Palm');
    run(700);
    rt.setSimGesture(null);
    run(300);
    expect(gate.state()).toBe('STOPPED');

    rt.setSimGesture('Closed_Fist');
    run(900);
    expect(gate.state()).toBe('STOPPED'); // a fist needs 1.5 s
    run(800);
    expect(gate.state()).toBe('ESTOPPED');

    // the panel cannot reset while the fist is still held
    expect(rt.resetEstop('arm').ok).toBe(false);
    rt.setSimGesture(null);
    run(300);
    expect(rt.resetEstop('confirm').ok).toBe(false); // step 2 before step 1
    expect(rt.resetEstop('arm').ok).toBe(true);
    expect(rt.resetEstop('confirm').ok).toBe(true);
    expect(gate.state()).toBe('IDLE');
    expect(getLog().some((l) => l.kind === 'safety' && l.text.includes('ESTOP'))).toBe(true);
  });

  it('feeds camera frames and routes every label through the filter', () => {
    const seen: (string | null)[] = [];
    rt.setSafetyLabelFilter((label) => {
      seen.push(label);
      return label === 'Closed_Fist' ? null : label; // e.g. teleop masking a pinch
    });
    for (let i = 0; i < 70; i++) {
      t += 33;
      setHandFrame({ t, landmarks: [], gesture: 'Closed_Fist', gestureScore: 0.95, source: 'camera' });
      rt.tick(t);
    }
    expect(seen).toContain('Closed_Fist');
    expect(rt.core.gate.state()).toBe('IDLE');
    rt.setSafetyLabelFilter(null);
  });

  it('ignores stale hand frames', () => {
    setHandFrame({ t, landmarks: [], gesture: 'Victory', gestureScore: 0.95, source: 'camera' });
    run(2000);
    expect(rt.core.gate.state()).toBe('IDLE');
  });
});

describe('runtime loop', () => {
  it('runs tick hooks before the arm steps and hands them the safety snapshot', () => {
    const order: string[] = [];
    const arm = rt.core.arm;
    const step = arm.step.bind(arm);
    arm.step = (dt: number, speed?: number) => {
      order.push('arm');
      step(dt, speed);
    };
    const off = rt.registerTickHook((now, dt, ctx) => {
      order.push('hook');
      expect(now).toBeGreaterThan(0);
      expect(dt).toBeGreaterThanOrEqual(0);
      expect(ctx.safety.phase).toBe('idle');
      expect(ctx.bayState).toBe('IDLE');
    });
    run(66);
    off();
    run(33);
    expect(order).toEqual(['hook', 'arm', 'hook', 'arm', 'arm']);
  });

  it('keeps going when a hook throws', () => {
    rt.registerTickHook(() => {
      throw new Error('boom');
    });
    const err = console.error;
    console.error = () => {};
    expect(() => run(100)).not.toThrow();
    console.error = err;
    expect(getLog().filter((l) => l.text.includes('boom'))).toHaveLength(1);
  });

  it('publishes telemetry and maps the bay camera both ways', () => {
    run(200);
    const tm = rt.getTelemetry();
    expect(tm.state).toBe('IDLE');
    expect(tm.tcp_mm[2]).toBeGreaterThan(40);
    const yx = rt.bay.project([0.05, -0.15, 0]);
    expect(yx[0]).toBeGreaterThan(0);
    expect(yx[0]).toBeLessThan(1000);
    const back = rt.bay.unproject(yx, 0)!;
    expect(back[0]).toBeCloseTo(0.05, 6);
    expect(back[1]).toBeCloseTo(-0.15, 6);
    expect(() => rt.bay.capture()).toThrow(/not mounted/);
  });
});
