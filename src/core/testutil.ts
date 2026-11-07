// Test helpers (node): load the arm data once and run the arm on a simulated clock.
import type { So101Data } from './model';
import { createBay, loadArmDataNode, type Bay, type CreateBayOptions } from './index';

let cached: So101Data | null = null;
export async function armData(): Promise<So101Data> {
  if (!cached) cached = await loadArmDataNode('public/assets/so101.json');
  return cached;
}

export async function makeBay(opts: CreateBayOptions = {}): Promise<Bay & { logs: string[] }> {
  const logs: string[] = [];
  const bay = createBay(await armData(), { ...opts, log: (t) => logs.push(t) });
  return Object.assign(bay, { logs });
}

/** let pending promise continuations run */
export async function flush(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

/** step the bay at dt until p settles (or maxSteps); returns p's value */
export async function runUntil<T>(bay: Pick<Bay, 'step'>, p: Promise<T>, maxSteps = 20000, dt = 1 / 60): Promise<T> {
  let done = false;
  let value!: T;
  let error: unknown;
  let failed = false;
  p.then(
    (v) => {
      done = true;
      value = v;
    },
    (e) => {
      done = true;
      failed = true;
      error = e;
    },
  );
  await flush();
  for (let i = 0; i < maxSteps && !done; i++) {
    bay.step(dt);
    await flush();
  }
  if (!done) throw new Error(`runUntil: not settled after ${maxSteps} steps`);
  if (failed) throw error;
  return value;
}

/** step n times */
export async function steps(bay: Pick<Bay, 'step'>, n: number, dt = 1 / 60): Promise<void> {
  for (let i = 0; i < n; i++) {
    bay.step(dt);
    await flush();
  }
}

export const dist2 = (a: ArrayLike<number>, b: ArrayLike<number>): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const dist3 = (a: ArrayLike<number>, b: ArrayLike<number>): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
