// Test helpers (node only): NASA models from disk and a fake bay that records createMesh calls.

import { readFileSync } from 'node:fs';
import type { BayApi, CreateResult, Placement, Sample, SampleApi } from '../contracts';
import { registerAsset } from './build';

/** Register the NASA shape models from disk (the browser fetches them; node never does). */
export function registerNasaAssets(): void {
  for (const id of ['bennu', 'itokawa', 'eros', 'kleopatra']) {
    registerAsset(id, JSON.parse(readFileSync(new URL(`../../public/assets/samples/${id}.json`, import.meta.url), 'utf8')));
  }
}

/** A SampleApi fake: records createMesh inputs, places at x_mm/y_mm or a default spot. */
export function fakeBay(opts: { reject?: CreateResult } = {}): BayApi & { created: { input: Parameters<SampleApi['createMesh']>[0]; by?: Sample['createdBy'] }[] } {
  const list: Sample[] = [];
  const created: { input: Parameters<SampleApi['createMesh']>[0]; by?: Sample['createdBy'] }[] = [];
  const samples: SampleApi = {
    list: () => [...list],
    get: (id) => list.find((s) => s.id === id),
    createPrimitive: () => ({ ok: false, code: 'UNSUPPORTED', reason: 'fake' }),
    createMesh: (input, by) => {
      created.push({ input, by });
      if (opts.reject) return opts.reject;
      const p = input as Placement;
      const s: Sample = { id: `sample_${list.length + 1}`, name: input.name, color: input.color, kind: 'mesh', dims: input.dims,
        pos: [(p.x_mm ?? 60) / 1000, (p.y_mm ?? -200) / 1000, input.dims.h / 2], yaw: 0, held: false, mesh: input.mesh, createdBy: by ?? 'operator' };
      list.push(s);
      return { ok: true, sample: s };
    },
    remove: () => false,
    reset: () => { list.length = 0; },
    onChange: () => () => undefined,
  };
  const ok = { ok: true as const, tcp_mm: [0, 0, 0] as [number, number, number], held: null };
  return {
    created,
    samples,
    arm: { pick: async () => ok, placeAt: async () => ok, placeInContainment: async () => ok, home: async () => ok, servoTo: () => undefined, abortAll: () => undefined,
      snapshot: () => ({ q: [0, 0, 0, 0, 0, 0], tcp: [0, 0, 0], jawOpen: 1, phase: 'idle', heldId: null, busy: false }) },
    gate: { state: () => 'RUNNING', speedFactor: () => 1, waitRunnable: async () => undefined, onChange: () => () => undefined },
    capture: () => ({ jpegB64: '', w: 1, h: 1, t: 0 }),
    project: () => [0, 0],
    unproject: () => null,
  };
}

