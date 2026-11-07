// STARHAND arm core: everything the UI, teleop, fabricator and Gemini layers use from src/core.
//
// Typical use (browser):
//   const data = await loadArmData();
//   const bay = createBay(data, { log: (text, kind) => bus.log(text, kind) });
//   scene.add(bay.model.root)            // or build a mesh-carrying ArmModel, see below
//   every frame: bay.step(dt)            // advances the arm at the gate's speed factor
//   gestures:    bay.gate.apply('STOP')  // ESTOP also aborts every arm move
// For a rendered arm, pass { meshFactory: defaultMeshFactory } through opts.model.

import type { Rejection, Vec3 } from '../contracts';
import { Arm, type ArmOptions } from './arm';
import { BayGate, type GateCommand } from './gate';
import { ArmModel, type MeshFactory, type So101Data } from './model';
import { SampleRegistry } from './samples';

export * from './constants';
export * from './model';
export * from './ik';
export * from './gate';
export * from './samples';
export * from './arm';

export type BayLogKind = 'info' | 'safety' | 'reject';
export type BayLog = (text: string, kind: BayLogKind) => void;

export interface Bay {
  arm: Arm;
  samples: SampleRegistry;
  gate: BayGate;
  model: ArmModel;
  /** advance the arm by dt seconds at the gate's speed factor */
  step(dt: number): void;
  /** apply an operator command; ESTOP also aborts every arm move */
  command(cmd: GateCommand, source?: string): ReturnType<BayGate['apply']>;
}

export interface CreateBayOptions {
  log?: BayLog;
  /** build arm meshes (browser): e.g. defaultMeshFactory */
  meshFactory?: MeshFactory;
  arm?: Omit<ArmOptions, 'log'>;
  /** skip the seed cube */
  noSeed?: boolean;
}

/** Wire the gate, the arm, the registry (with its IK reach probe) and logging. */
export function createBay(armData: So101Data, opts: CreateBayOptions = {}): Bay {
  const log: BayLog = opts.log ?? (() => {});
  const model = new ArmModel(armData, { meshFactory: opts.meshFactory });
  const gate = new BayGate({ log });
  const samples = new SampleRegistry({ noSeed: opts.noSeed });
  const arm = new Arm(model, samples, gate, { ...opts.arm, log });
  samples.setArmTcp(() => arm.snapshot().tcp);
  samples.setReachProbe((p): Rejection | null => {
    const where = arm.reachProbe(p);
    if (!where) return null;
    const what = where === 'grasp' ? 'grasp it' : where === 'hover' ? 'hover above it' : 'lift it clear of its neighbours';
    return {
      ok: false,
      code: 'UNREACHABLE',
      reason: `the arm cannot ${what} at that spot with the gripper pointing down.`,
      suggestion: 'move it closer to the middle of the reach band',
    };
  });
  gate.onChange((s) => {
    if (s === 'ESTOPPED') arm.abortAll('emergency stop');
  });
  return {
    arm,
    samples,
    gate,
    model,
    step: (dt: number) => arm.step(dt, gate.speedFactor()),
    command: (cmd, source) => gate.apply(cmd, source),
  };
}

/** Browser: fetch the converted SO-101 (public/assets/so101.json). */
export async function loadArmData(url = './assets/so101.json'): Promise<So101Data> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`so101.json: HTTP ${res.status}`);
  return (await res.json()) as So101Data;
}

/** Node (tests, scripts): read so101.json from disk. */
export async function loadArmDataNode(path = 'public/assets/so101.json'): Promise<So101Data> {
  // a non-literal specifier keeps node types out of the browser build and the bundler away from it
  const spec = 'node:fs/promises';
  const fs = (await import(/* @vite-ignore */ spec)) as { readFile(p: string, enc: 'utf8'): Promise<string> };
  return JSON.parse(await fs.readFile(path, 'utf8')) as So101Data;
}

/** mm helpers for tool arguments */
export const toMm = (v: Vec3): Vec3 => [v[0] * 1000, v[1] * 1000, v[2] * 1000];
export const fromMm = (v: Vec3): Vec3 => [v[0] / 1000, v[1] / 1000, v[2] / 1000];
