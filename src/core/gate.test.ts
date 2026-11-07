import { describe, expect, it } from 'vitest';
import { BayGate, GateError } from './gate';
import { flush } from './testutil';

function gate() {
  const logs: string[] = [];
  const states: string[] = [];
  const g = new BayGate({ log: (t) => logs.push(t) });
  g.onChange((s) => states.push(s));
  return { g, logs, states };
}

describe('BayGate', () => {
  it('runs the normal cycle with speed factors 1 / 0.5 / 0', () => {
    const { g, states } = gate();
    expect(g.state()).toBe('IDLE');
    expect(g.speedFactor()).toBe(0);
    expect(g.apply('CYCLE_START').state).toBe('RUNNING');
    expect(g.speedFactor()).toBe(1);
    expect(g.apply('SLOW').state).toBe('SLOW');
    expect(g.speedFactor()).toBe(0.5);
    expect(g.apply('RESUME').state).toBe('RUNNING');
    expect(states).toEqual(['RUNNING', 'SLOW', 'RUNNING']);
  });

  it('STOP remembers whether it stopped RUNNING or SLOW', () => {
    const { g } = gate();
    g.apply('CYCLE_START');
    g.apply('SLOW');
    expect(g.apply('STOP').state).toBe('STOPPED');
    expect(g.speedFactor()).toBe(0);
    expect(g.apply('RESUME').state).toBe('SLOW');
    g.apply('RESUME');
    g.apply('STOP');
    expect(g.apply('RESUME').state).toBe('RUNNING');
  });

  it('ignores commands that do not apply, with a speakable note', () => {
    const { g } = gate();
    const r = g.apply('RESUME');
    expect(r.ok).toBe(false);
    expect(r.state).toBe('IDLE');
    expect(r.note).toMatch(/\.$/);
    expect(g.apply('SLOW').ok).toBe(false);
    expect(g.apply('STOP').ok).toBe(false);
    g.apply('CYCLE_START');
    expect(g.apply('CYCLE_START').ok).toBe(false);
  });

  it('ESTOP from any state; reset needs RESET_ARM then RESET_CONFIRM', () => {
    for (const setup of [[], ['CYCLE_START'], ['CYCLE_START', 'SLOW'], ['CYCLE_START', 'STOP']] as const) {
      const { g } = gate();
      for (const c of setup) g.apply(c);
      expect(g.apply('ESTOP').state).toBe('ESTOPPED');
      expect(g.speedFactor()).toBe(0);
      expect(g.apply('RESUME').ok).toBe(false);
      expect(g.apply('CYCLE_START').ok).toBe(false);
      expect(g.apply('RESET_CONFIRM').ok).toBe(false); // confirm without arming
      expect(g.state()).toBe('ESTOPPED');
      expect(g.apply('RESET_ARM').ok).toBe(true);
      expect(g.resetArmed()).toBe(true);
      expect(g.state()).toBe('ESTOPPED');
      expect(g.apply('RESET_CONFIRM').state).toBe('IDLE');
      expect(g.resetArmed()).toBe(false);
    }
  });

  it('a second ESTOP disarms a pending reset', () => {
    const { g } = gate();
    g.apply('ESTOP');
    g.apply('RESET_ARM');
    g.apply('ESTOP');
    expect(g.apply('RESET_CONFIRM').ok).toBe(false);
    expect(g.state()).toBe('ESTOPPED');
  });

  it('waitRunnable: resolves when running, auto-starts from IDLE with a log line', async () => {
    const { g, logs } = gate();
    await g.waitRunnable();
    expect(g.state()).toBe('RUNNING');
    expect(logs).toContain('TASK START - auto CYCLE START');
    g.apply('SLOW');
    await expect(g.waitRunnable()).resolves.toBeUndefined();
  });

  it('waitRunnable: waits while STOPPED and resolves on RESUME', async () => {
    const { g } = gate();
    g.apply('CYCLE_START');
    g.apply('STOP');
    let resolved = false;
    const p = g.waitRunnable().then(() => {
      resolved = true;
    });
    await flush();
    expect(resolved).toBe(false);
    g.apply('RESUME');
    await p;
    expect(resolved).toBe(true);
  });

  it('waitRunnable: rejects on ESTOPPED (now or while waiting) and on abort', async () => {
    const { g } = gate();
    g.apply('ESTOP');
    await expect(g.waitRunnable()).rejects.toBeInstanceOf(GateError);
    const { g: g2 } = gate();
    g2.apply('CYCLE_START');
    g2.apply('STOP');
    const p = g2.waitRunnable();
    g2.apply('ESTOP');
    await expect(p).rejects.toMatchObject({ code: 'ESTOPPED' });
    const { g: g3 } = gate();
    g3.apply('CYCLE_START');
    g3.apply('STOP');
    const ac = new AbortController();
    const p3 = g3.waitRunnable(ac.signal);
    ac.abort();
    await expect(p3).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('logs every transition', () => {
    const { g, logs } = gate();
    g.apply('CYCLE_START', 'gesture');
    g.apply('STOP', 'panel');
    expect(logs.some((l) => l.includes('CYCLE_START (gesture): IDLE -> RUNNING'))).toBe(true);
    expect(logs.some((l) => l.includes('STOP (panel): RUNNING -> STOPPED'))).toBe(true);
  });
});
