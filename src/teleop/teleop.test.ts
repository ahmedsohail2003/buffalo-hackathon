import { describe, it, expect } from 'vitest';
import type { BayState, HandFrame } from '../contracts';
import { createTeleop, isSafetySignal, type TeleopConfig } from './teleop';
import { simHandFrame } from './handTemplate';
import { workspaceToUV } from './mapping';
import { getTeleopStatus, isTeleopEnabled, shouldSuppressFist } from './state';
import { CONTAINMENT, Z_LIFT, fistLike, makeBay } from './testFakes';

const DT = 1 / 60;
const Z_HOVER = 0.075;
const REACH = { rhoMin: 0.13, rhoMax: 0.21, bearingMax: 1.35 };
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function rig(initial: BayState = 'RUNNING', extra: Partial<TeleopConfig> = {}) {
  const { bay, gate, samples, arm } = makeBay(initial);
  samples.add('s1', 0, -0.18);
  const logs: { text: string; kind?: string }[] = [];
  const teleop = createTeleop(bay, {
    reach: REACH,
    zHover: Z_HOVER,
    zLift: Z_LIFT,
    containment: CONTAINMENT,
    log: (text, kind) => logs.push({ text, kind }),
    ...extra,
  });
  let now = 1000;
  const run = async (n: number, hand: (t: number) => HandFrame | null, phase?: string) => {
    for (let i = 0; i < n; i++) {
      now += 1000 * DT;
      teleop.step(now, hand(now), phase);
      arm.tick(DT);
      await flush();
    }
  };
  const handAt = (x: number, y: number, pinch = false) => (t: number) => {
    const { u, v } = workspaceToUV(x, y, REACH);
    return simHandFrame(u, v, pinch, t);
  };
  const camAt = (x: number, y: number, gesture: string | null, score: number, pinch = false) => (t: number): HandFrame => ({
    ...handAt(x, y, pinch)(t),
    gesture,
    gestureScore: score,
    source: 'camera',
  });
  const tcpErr = (x: number, y: number, z: number) => Math.hypot(arm.tcp[0] - x, arm.tcp[1] - y, arm.tcp[2] - z);
  return { teleop, bay, gate, samples, arm, logs, run, handAt, camAt, tcpErr, texts: () => logs.map((l) => l.text) };
}

describe('teleop: following and the dead-man', () => {
  it('servos to the mapped hover target and reports it', async () => {
    const r = rig();
    r.teleop.enable();
    expect(isTeleopEnabled()).toBe(true);
    await r.run(60, r.handAt(0.06, -0.17));
    expect(r.arm.servo).toEqual([expect.closeTo(0.06, 9), expect.closeTo(-0.17, 9), Z_HOVER]);
    expect(r.tcpErr(0.06, -0.17, Z_HOVER)).toBeLessThan(1e-3);
    expect(r.teleop.status()).toMatchObject({ mode: 'following', handPresent: true, target_mm: [60, -170, 75] });
    expect(getTeleopStatus()?.mode).toBe('following');
  });

  it('a stale or missing frame clears the servo target and holds', async () => {
    const r = rig();
    r.teleop.enable();
    await r.run(30, r.handAt(0.06, -0.17));
    const stale = simHandFrame(0.3, 0.3, false, 0);
    await r.run(5, () => stale);
    expect(r.arm.servo).toBeNull();
    expect(r.teleop.status()).toMatchObject({ mode: 'holding', handPresent: false, target_mm: null, note: 'no hand in view — holding position' });
    const tcp = [...r.arm.tcp];
    await r.run(30, () => null);
    expect(r.arm.tcp).toEqual(tcp);
  });
});

describe('teleop: pinch clicks', () => {
  it('first click picks the nearest sample within 35 mm, the next places it in containment', async () => {
    const r = rig();
    r.samples.add('far', 0.1, -0.15); // 100+ mm away: never picked from over s1
    r.teleop.enable();
    await r.run(60, r.handAt(0.01, -0.19)); // ~14 mm from s1
    expect(r.teleop.status().note).toContain('pinch to pick');
    await r.run(3, r.handAt(0.01, -0.19, true));
    expect(r.arm.calls).toEqual(['pick s1']);
    expect(r.teleop.status().mode).toBe('grasping');
    await r.run(60, r.handAt(0.1, -0.15, true)); // pinch held during the move: ignored
    expect(r.arm.heldId).toBe('s1');
    expect(r.texts()).toContain('TELEOP pick s1 → ok, holding s1');
    // carry without pinching, at lift height, over the bin
    await r.run(90, r.handAt(CONTAINMENT.xy[0], CONTAINMENT.xy[1]));
    expect(r.tcpErr(CONTAINMENT.xy[0], CONTAINMENT.xy[1], Z_LIFT)).toBeLessThan(1e-3);
    expect(r.teleop.status().note).toContain('in containment');
    await r.run(3, r.handAt(CONTAINMENT.xy[0], CONTAINMENT.xy[1], true));
    expect(r.teleop.status().mode).toBe('placing');
    await r.run(60, r.handAt(CONTAINMENT.xy[0], CONTAINMENT.xy[1]));
    expect(r.arm.calls).toEqual(['pick s1', 'placeInContainment']);
    expect(r.arm.heldId).toBeNull();
    expect(r.texts()).toContain('TELEOP place s1 in containment → ok');
    expect(r.teleop.status().mode).toBe('following');
  });

  it('outside the bin the click places at the gripper; over nothing it is only a note', async () => {
    const r = rig();
    r.teleop.enable();
    await r.run(60, r.handAt(0.1, -0.15));
    await r.run(3, r.handAt(0.1, -0.15, true));
    expect(r.arm.calls).toEqual([]);
    expect(r.teleop.status().note).toContain('nothing under the gripper');
    await r.run(60, r.handAt(0, -0.18));
    await r.run(3, r.handAt(0, -0.18, true));
    await r.run(40, r.handAt(0, -0.18));
    await r.run(60, r.handAt(0.1, -0.15));
    await r.run(3, r.handAt(0.1, -0.15, true));
    await r.run(40, r.handAt(0.1, -0.15));
    expect(r.arm.calls).toEqual(['pick s1', 'placeAt 100,-150']);
    const placed = r.samples.get('s1')!.pos;
    expect(Math.hypot(placed[0] - 0.1, placed[1] + 0.15)).toBeLessThan(1e-3); // the filtered hover point
    expect(r.texts()).toContain('TELEOP place s1 at (100, -150) mm → ok');
  });

  it('a fist never clicks; a pinch the recognizer calls Closed_Fist still does', async () => {
    const r = rig();
    r.teleop.enable();
    await r.run(60, r.handAt(0, -0.18));
    const { u, v } = workspaceToUV(0, -0.18, REACH);
    const fist = (t: number): HandFrame => ({ ...simHandFrame(u, v, true, t), landmarks: fistLike(1 - u, v) });
    await r.run(10, fist);
    expect(r.arm.calls).toEqual([]);
    await r.run(5, r.handAt(0, -0.18));
    await r.run(3, r.camAt(0, -0.18, 'Closed_Fist', 0.8, true));
    expect(r.arm.calls).toEqual(['pick s1']);
  });
});

describe('teleop: the safety channel', () => {
  it('STOP holds and ignores clicks; RUNNING resumes', async () => {
    const r = rig();
    r.teleop.enable();
    await r.run(60, r.handAt(0.06, -0.17));
    r.gate.set('STOPPED');
    await r.run(30, r.handAt(-0.06, -0.15));
    await r.run(3, r.handAt(0, -0.18, true));
    expect(r.arm.servo).toBeNull();
    expect(r.arm.calls).toEqual([]);
    expect(r.tcpErr(0.06, -0.17, Z_HOVER)).toBeLessThan(1e-3);
    expect(r.teleop.status()).toMatchObject({ mode: 'holding', note: 'bay STOPPED — thumbs-up to resume' });
    r.gate.set('RUNNING');
    await r.run(60, r.handAt(-0.06, -0.15));
    expect(r.tcpErr(-0.06, -0.15, Z_HOVER)).toBeLessThan(1e-3);
  });

  it('E-STOP turns teleop off at once; enabling is refused until the reset; IDLE auto-starts', async () => {
    const r = rig();
    r.teleop.enable();
    await r.run(30, r.handAt(0.06, -0.17));
    r.gate.set('ESTOPPED');
    expect(r.teleop.status()).toMatchObject({ enabled: false, mode: 'off', target_mm: null });
    expect(r.teleop.status().note).toContain('E-STOP');
    expect(r.arm.servo).toBeNull();
    expect(r.logs).toContainEqual({ text: 'TELEOP OFF — E-STOP', kind: 'safety' });
    r.teleop.enable();
    expect(r.teleop.status().enabled).toBe(false);
    r.gate.set('IDLE'); // panel reset
    r.teleop.enable();
    expect(r.gate.state()).toBe('RUNNING');
    expect(r.gate.lines).toEqual(['TASK START — auto CYCLE START']);
    expect(r.teleop.status().enabled).toBe(true);
  });

  it('an E-STOP during a teleop pick aborts it and leaves teleop off', async () => {
    const r = rig();
    r.teleop.enable();
    await r.run(60, r.handAt(0, -0.18));
    await r.run(3, r.handAt(0, -0.18, true));
    r.gate.set('ESTOPPED');
    r.arm.abortAll('EMERGENCY STOP');
    await r.run(3, r.handAt(0, -0.18));
    expect(r.texts().some((t) => t.startsWith('TELEOP pick s1 → ABORTED'))).toBe(true);
    expect(r.teleop.status().enabled).toBe(false);
  });

  it('a safety label or a forming signal freezes the target and blocks clicks', async () => {
    const r = rig();
    r.teleop.enable();
    await r.run(60, r.handAt(0.06, -0.17));
    await r.run(60, r.camAt(-0.06, -0.15, 'Open_Palm', 0.9));
    expect(r.tcpErr(0.06, -0.17, Z_HOVER)).toBeLessThan(1e-3);
    expect(r.teleop.status()).toMatchObject({ mode: 'holding', note: 'safety signal — steering paused, target frozen' });
    await r.run(60, r.handAt(-0.06, -0.15), 'arming');
    await r.run(3, r.handAt(0, -0.18, true), 'debouncing');
    expect(r.arm.calls).toEqual([]);
    expect(r.tcpErr(0.06, -0.17, Z_HOVER)).toBeLessThan(1e-3);
    await r.run(60, r.camAt(-0.06, -0.15, 'Open_Palm', 0.4), 'idle'); // under the 0.6 gate: steers
    expect(r.tcpErr(-0.06, -0.15, Z_HOVER)).toBeLessThan(1e-3);
    expect(isSafetySignal(r.camAt(0, -0.18, 'Victory', 0.7)(0))).toBe(true);
    expect(isSafetySignal(r.camAt(0, -0.18, 'None', 0.95)(0))).toBe(false);
  });

  it('a hand that comes back into view already signalling never steers toward itself', async () => {
    for (const gesture of ['Open_Palm', 'Closed_Fist']) {
      const r = rig();
      r.teleop.enable();
      await r.run(60, r.handAt(0.07, -0.17));
      expect(r.tcpErr(0.07, -0.17, Z_HOVER)).toBeLessThan(1e-3);
      await r.run(1, () => null); // one dropped frame clears the target
      await r.run(36, r.camAt(-0.07, -0.17, gesture, 0.9)); // back at the far side, showing a signal
      expect(r.tcpErr(0.07, -0.17, Z_HOVER)).toBeLessThan(1e-3);
      expect(r.arm.servo).toBeNull();
      expect(r.teleop.status().mode).toBe('holding');
    }
  });

  it('never fights a task that owns the arm, and turns off for an AI task', async () => {
    let task = false;
    const r = rig('RUNNING', { taskActive: () => task });
    r.teleop.enable();
    await r.run(30, r.handAt(0.06, -0.17));
    const home = r.arm.home();
    await r.run(3, r.handAt(0.06, -0.17, true));
    expect(r.teleop.status()).toMatchObject({ mode: 'holding', note: 'arm busy with a task — waiting' });
    expect(r.arm.calls).toEqual(['home']);
    await r.run(40, r.handAt(0.06, -0.17));
    expect((await home).ok).toBe(true);
    task = true;
    await r.run(1, r.handAt(0.06, -0.17));
    expect(r.teleop.status()).toMatchObject({ enabled: false, mode: 'off' });
    r.teleop.enable();
    expect(r.teleop.status().enabled).toBe(false);
  });

  it('shouldSuppressFist: only while teleop is on, on a real pinch pose, for at most 500 ms', async () => {
    const r = rig();
    const pinch = (t: number): HandFrame => ({ ...simHandFrame(0.5, 0.5, true, t), gesture: 'Closed_Fist', gestureScore: 0.9, source: 'camera' });
    r.teleop.disable();
    expect(shouldSuppressFist(pinch(0), 0)).toBe(false);
    r.teleop.enable();
    expect(shouldSuppressFist(pinch(100), 100)).toBe(true);
    expect(shouldSuppressFist(pinch(550), 550)).toBe(true);
    expect(shouldSuppressFist(pinch(650), 650)).toBe(false);
    const fist: HandFrame = { ...pinch(700), landmarks: fistLike() };
    expect(shouldSuppressFist(fist, 700)).toBe(false);
    expect(shouldSuppressFist(pinch(800), 800)).toBe(true);
  });
});
