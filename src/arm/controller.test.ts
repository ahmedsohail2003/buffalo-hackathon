import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildArmModel } from './armModel';
import { HOME_Q, JAW_OPEN } from './armData';
import type { ArmData } from './armData';
import { ArmController } from './controller';
import { CellGate } from './gate';
import { ObjectRegistry } from '../cell/objects';
import type { CellState, PrimResult } from '../contracts';
import type { CobotCell } from '../cell/cellSim';

const data = JSON.parse(readFileSync(new URL('../../public/arm-data.json', import.meta.url), 'utf8')) as ArmData;

/** Minimal cell stand-in driving the real CellGate. */
function makeCell(initial: CellState) {
  const cell = {
    state: initial,
    apply(cmd: string) {
      if (cmd === 'CYCLE_START' && this.state === 'IDLE') {
        this.state = 'RUNNING';
        return true;
      }
      return false;
    },
  };
  const lines: string[] = [];
  const gate = new CellGate(() => cell as unknown as CobotCell, { onLine: (l) => lines.push(l.text) });
  const setState = (s: CellState) => {
    cell.state = s;
    gate.notify();
  };
  return { cell, gate, setState, lines };
}

function makeArm(initial: CellState = 'RUNNING') {
  const model = buildArmModel(data);
  const objects = new ObjectRegistry(data.block);
  const c = makeCell(initial);
  const ctl = new ArmController(model, objects, c.gate);
  return { ctl, objects, ...c };
}

const yieldTask = () => new Promise<void>((r) => setImmediate(r));

/** Drive step(dt, speed) until the promise settles (or maxFrames). Returns frames used. */
async function drive<T>(ctl: ArmController, p: Promise<T>, speed: number, dt = 1 / 60, maxFrames = 5000): Promise<{ frames: number; settled: boolean; value?: T }> {
  let settled = false;
  let value: T | undefined;
  p.then((v) => {
    settled = true;
    value = v;
  }, () => {
    settled = true;
  });
  let frames = 0;
  while (!settled && frames < maxFrames) {
    ctl.step(dt, speed);
    frames++;
    await yieldTask();
  }
  return { frames, settled, value };
}

describe('ArmController', () => {
  it('(a) speed 0 leaves q untouched and the promise pending', async () => {
    const { ctl } = makeArm();
    const q0 = [...ctl.q];
    const p = ctl.move([0.5, -1.2, 1.2, 1.2, -1.57], 'test');
    let settled = false;
    p.then(() => (settled = true), () => (settled = true));
    for (let i = 0; i < 50; i++) ctl.step(0.1, 0);
    await yieldTask();
    expect(ctl.q).toEqual(q0);
    expect(settled).toBe(false);
    expect(ctl.queue.length).toBe(1);
    ctl.abortAll('test end');
    await p.catch(() => undefined);
  });

  it('(b) speed 0.5 takes twice the frames of speed 1 (±10 %)', async () => {
    const a = makeArm();
    const b = makeArm();
    const target = [0.6, -1.3, 1.3, 1.4, -1.57, JAW_OPEN];
    const r1 = await drive(a.ctl, a.ctl.move(target, 'm'), 1);
    const r2 = await drive(b.ctl, b.ctl.move(target, 'm'), 0.5);
    expect(r1.settled && r2.settled).toBe(true);
    expect(r2.frames / r1.frames).toBeGreaterThan(1.8);
    expect(r2.frames / r1.frames).toBeLessThan(2.2);
    expect(a.ctl.q).toEqual(target);
  });

  it('(c) abortAll rejects pending motion with ABORTED and fails a running primitive', async () => {
    const { ctl } = makeArm();
    const p = ctl.move([0.3, -1.4, 1.4, 1.5, -1.57], 'm');
    const pick = ctl.pick('block_1');
    ctl.step(1 / 60, 1);
    await yieldTask();
    ctl.abortAll('EMERGENCY STOP');
    await expect(p).rejects.toMatchObject({ ok: false, code: 'ABORTED' });
    const r = await pick;
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('ABORTED');
    expect(ctl.queue.length).toBe(0);
    expect(ctl.phase).toContain('ABORTED');
  });

  it('(d) pick(block_1) with a RUNNING gate lifts the block to (0,-230,90) mm', async () => {
    const { ctl, objects } = makeArm('RUNNING');
    const r = await drive(ctl, ctl.pick('block_1'), 1);
    expect(r.settled).toBe(true);
    const res = r.value as PrimResult;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.held).toBe('block_1');
    const tcp = ctl.tcp();
    expect(Math.hypot(tcp[0] - 0, tcp[1] - -0.23, tcp[2] - 0.09)).toBeLessThan(2e-3);
    const blk = objects.get('block_1')!;
    expect(blk.held).toBe(true);
    // block centre rides 15 mm below the tcp (grasp z = h/2 + 0.015)
    expect(Math.abs(blk.pos[2] - (0.09 - 0.015))).toBeLessThan(2e-3);
    expect(ctl.q[5]).toBeCloseTo(0.113, 2);
    console.log(`pick: ${r.frames} frames at 60 Hz, tcp ${tcp.map((v) => (v * 1000).toFixed(1)).join(',')} mm`);

    const t = await drive(ctl, ctl.placeInTray(), 1);
    const tres = t.value as PrimResult;
    expect(tres.ok).toBe(true);
    expect(blk.held).toBe(false);
    expect(Math.abs(blk.pos[0] - -0.18)).toBeLessThan(2e-3);
    expect(Math.abs(blk.pos[1] - -0.13)).toBeLessThan(2e-3);
    expect(blk.pos[2]).toBeCloseTo(0.006 + 0.012, 4);
    expect(ctl.heldId).toBeNull();
  });

  it('(e) STOPPED gate keeps pick pending; RUNNING releases it (IDLE auto-starts)', async () => {
    const { ctl, setState, lines } = makeArm('STOPPED');
    const p = ctl.pick('block_1');
    let settled = false;
    p.then(() => (settled = true), () => (settled = true));
    for (let i = 0; i < 100; i++) {
      ctl.step(1 / 60, 0);
      await yieldTask();
    }
    expect(settled).toBe(false);
    expect(ctl.queue.length).toBe(0);
    expect(lines).toContain('PAUSED: cell STOPPED — waiting for thumbs-up');
    setState('RUNNING');
    const r = await drive(ctl, p, 1);
    expect(r.settled).toBe(true);
    expect((r.value as PrimResult).ok).toBe(true);
    expect(lines).toContain('RESUMED');

    const idle = makeArm('IDLE');
    const h = await drive(idle.ctl, idle.ctl.home(), 1);
    expect((h.value as PrimResult).ok).toBe(true);
    expect(idle.cell.state).toBe('RUNNING');
    expect(idle.lines).toContain('TASK START — auto CYCLE START');
    expect(idle.ctl.q.slice(0, 5)).toEqual(HOME_Q);
  });

  it('rejects unreachable, missing and empty-gripper cases before moving', async () => {
    const { ctl, objects } = makeArm();
    const missing = await ctl.pick('nope');
    expect(missing).toMatchObject({ ok: false, code: 'NO_OBJECT' });
    const empty = await ctl.placeInTray();
    expect(empty).toMatchObject({ ok: false, code: 'NOTHING_HELD' });
    const far = await ctl.moveTo([0, -0.4, 0.015]);
    expect(far).toMatchObject({ ok: false, code: 'UNREACHABLE' });
    expect(ctl.queue.length).toBe(0);
    const est = makeArm('ESTOPPED');
    const r = await est.ctl.pick('block_1');
    expect(r).toMatchObject({ ok: false, code: 'REJECTED_STATE', state: 'ESTOPPED' });
    expect(objects.list().length).toBe(1);
  });
});
