// Arm primitives (PLAN.md A3, §1.3): the ONLY things Gemini can call to move the arm.
// Every primitive: gate.waitRunnable() first, then IK for EVERY waypoint before anything
// moves (err > 1e-3 m → UNREACHABLE with mm), then the joint-space segments.
// Heights: hover 0.075, grasp max(0.027, h/2+0.015), lift/transport/retreat 0.09,
// tray lower 0.055, table lower graspZ+0.004. Attach rule: registry.attachCandidate.

import type { PrimResult, Vec3, SceneObject } from '../contracts';
import type { ArmController } from './controller';
import { HOME_Q, JAW_OPEN, Z_HOVER, Z_LIFT, Z_TRAY_LOWER, TRAY, graspZ } from './armData';
import { solveIK, rollForYaw } from './ik';
import { jawQForWidth } from './jaw';
import { graspWidthMm } from '../cell/objects';
import { isPrimResult, abortedResult } from './gate';

const IK_REJECT = 1e-3;
const JAW_CLOSE_S = 0.3;
const JAW_HOLD_S = 0.6;
const JAW_OPEN_S = 0.3;
const RELEASE_HOLD_S = 0.5;

interface Waypoint {
  p: Vec3;
  label: string;
}

type PrimFail = Extract<PrimResult, { ok: false }>;
type Path = { ok: true; qs: number[][] } | PrimFail;

/** Solve IK sequentially along waypoints from `from`; never moves the arm. */
function solvePath(ctl: ArmController, wps: Waypoint[], from: number[], roll: number): Path {
  const qs: number[][] = [];
  let q = from;
  for (const w of wps) {
    const r = solveIK(ctl.model, w.p, q, { roll });
    if (!(r.err <= IK_REJECT)) {
      const mm = Number.isFinite(r.err) ? Math.round(r.err * 1000 * 10) / 10 : Infinity;
      return {
        ok: false,
        code: 'UNREACHABLE',
        reason: `the arm cannot reach ${w.label} at (${Math.round(w.p[0] * 1000)}, ${Math.round(w.p[1] * 1000)}, ${Math.round(w.p[2] * 1000)}) mm; ${mm} mm short`,
        err_mm: mm,
      };
    }
    q = r.q;
    qs.push(r.q);
  }
  // the model was restored to `from` by solveIK; put the live pose back
  ctl.model.setPose(ctl.q);
  return { ok: true, qs };
}

/** Two-pass roll: solve the first waypoint with the current roll to learn the Rotation angle. */
function rollFor(ctl: ArmController, first: Vec3, yaw: number, from: number[]): number {
  const r = solveIK(ctl.model, first, from, { roll: from[4] });
  ctl.model.setPose(ctl.q);
  return rollForYaw(yaw, r.q[0]);
}

async function run(ctl: ArmController, fn: () => Promise<PrimResult>): Promise<PrimResult> {
  try {
    await ctl.gate.waitRunnable();
    return await fn();
  } catch (e) {
    if (isPrimResult(e)) return e;
    return abortedResult(e instanceof Error ? e.message : String(e));
  }
}

async function follow(ctl: ArmController, qs: number[][], labels: string[]): Promise<void> {
  for (let i = 0; i < qs.length; i++) await ctl.move(qs[i], labels[i]);
}

export function pick(ctl: ArmController, id: string): Promise<PrimResult> {
  return run(ctl, async () => {
    const obj = ctl.objects.get(id);
    if (!obj) return { ok: false, code: 'NO_OBJECT', reason: `there is no part called ${id} on the table` };
    if (ctl.heldId) return { ok: false, code: 'ALREADY_HELD', reason: `the gripper is already holding ${ctl.heldId}; place it first` };
    if (obj.held) return { ok: false, code: 'ALREADY_HELD', reason: `${obj.name} is already in the gripper` };
    const [x, y] = obj.pos;
    const h = obj.dims.h;
    // A part may rest on another part (stacking, no physics): descend relative to its bottom, not the table.
    const bottom = obj.pos[2] - h / 2;
    const descend = bottom + graspZ(h);
    const hover = Math.min(Z_LIFT, Math.max(Z_HOVER, descend + 0.03));
    const wps: Waypoint[] = [
      { p: [x, y, hover], label: 'pick: hover' },
      { p: [x, y, descend], label: 'pick: descend' },
      { p: [x, y, Z_LIFT], label: 'pick: lift' },
    ];
    const from = ctl.targetQ();
    const roll = rollFor(ctl, wps[0].p, obj.yaw, from);
    const path = solvePath(ctl, wps, from, roll);
    if (!path.ok) return path;
    const [qHover, qGrasp, qLift] = path.qs;
    await ctl.move(qHover, wps[0].label);
    await ctl.move(qGrasp, wps[1].label);
    await ctl.setJaw(jawQForWidth(graspWidthMm(obj)), JAW_CLOSE_S, 'pick: close');
    await ctl.hold(JAW_HOLD_S, 'pick: grip');
    const cand = ctl.objects.attachCandidate(ctl.tcp());
    if (!cand || cand.id !== id) {
      await ctl.setJaw(JAW_OPEN, JAW_OPEN_S, 'pick: reopen');
      const tcp = ctl.tcp();
      const d = Math.round(Math.hypot(obj.pos[0] - tcp[0], obj.pos[1] - tcp[1]) * 1000);
      return { ok: false, code: 'GRASP_MISSED', reason: `the jaw closed ${d} mm from ${obj.name} and did not take it`, err_mm: d };
    }
    ctl.attach(id);
    await ctl.move(qLift, wps[2].label);
    return ctl.okResult();
  });
}

async function placeCommon(ctl: ArmController, xy: [number, number], lowerZ: (o: SceneObject) => number, what: string): Promise<PrimResult> {
  const id = ctl.heldId;
  if (!id) return { ok: false, code: 'NOTHING_HELD', reason: 'the gripper is empty; pick something first' };
  const obj = ctl.objects.get(id);
  if (!obj) return { ok: false, code: 'NOTHING_HELD', reason: 'the held part is gone from the registry' };
  const wps: Waypoint[] = [
    { p: [xy[0], xy[1], Z_LIFT], label: `${what}: transport` },
    { p: [xy[0], xy[1], lowerZ(obj)], label: `${what}: lower` },
  ];
  const from = ctl.targetQ();
  const roll = rollFor(ctl, wps[0].p, obj.yaw, from);
  const path = solvePath(ctl, wps, from, roll);
  if (!path.ok) return path;
  const [qTransport, qLower] = path.qs;
  await follow(ctl, [qTransport, qLower], [wps[0].label, wps[1].label]);
  await ctl.setJaw(JAW_OPEN, JAW_OPEN_S, `${what}: open`);
  await ctl.hold(RELEASE_HOLD_S, `${what}: release`);
  ctl.release();
  await ctl.move(qTransport, `${what}: retreat`);
  return ctl.okResult();
}

export function placeInTray(ctl: ArmController): Promise<PrimResult> {
  return run(ctl, () => placeCommon(ctl, TRAY, () => Z_TRAY_LOWER, 'place'));
}

export function placeAt(ctl: ArmController, xy: [number, number]): Promise<PrimResult> {
  // Lower to where the part will rest (table, or on top of another part) plus the grasp offset, so a
  // stacked part is set down on the part below instead of being pushed through it.
  return run(ctl, () => placeCommon(ctl, xy, (o) => ctl.objects.restZ(o, xy[0], xy[1]) + (graspZ(o.dims.h) - o.dims.h / 2) + 0.004, 'place'));
}

export function moveTo(ctl: ArmController, p: Vec3): Promise<PrimResult> {
  return run(ctl, async () => {
    const from = ctl.targetQ();
    const path = solvePath(ctl, [{ p, label: 'move' }], from, from[4]);
    if (!path.ok) return path;
    await ctl.move(path.qs[0], 'move');
    return ctl.okResult();
  });
}

export function home(ctl: ArmController): Promise<PrimResult> {
  return run(ctl, async () => {
    await ctl.move([...HOME_Q, JAW_OPEN], 'home');
    return ctl.okResult();
  });
}

export function open(ctl: ArmController): Promise<PrimResult> {
  return run(ctl, async () => {
    await ctl.setJaw(JAW_OPEN, JAW_OPEN_S, 'open');
    if (ctl.heldId) {
      await ctl.hold(RELEASE_HOLD_S, 'release');
      ctl.release();
    }
    return ctl.okResult();
  });
}

export function close(ctl: ArmController): Promise<PrimResult> {
  return run(ctl, async () => {
    if (ctl.heldId) return { ok: false, code: 'ALREADY_HELD', reason: `the gripper is already holding ${ctl.heldId}` };
    const cand = ctl.objects.attachCandidate(ctl.tcp());
    const target = cand ? jawQForWidth(graspWidthMm(cand)) : 0;
    await ctl.setJaw(target, JAW_CLOSE_S, 'close');
    await ctl.hold(JAW_HOLD_S, 'grip');
    const now = ctl.objects.attachCandidate(ctl.tcp());
    if (now) ctl.attach(now.id);
    return ctl.okResult();
  });
}
