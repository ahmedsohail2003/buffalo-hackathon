// Browser loader for the NASA shape models in public/assets/samples (fetched once each).
// In node the fetch fails harmlessly: tests register models from disk with build.registerAsset.

import type { FabProgram } from './types';
import { hasAsset, registerAsset, type AssetFile } from './build';

const pending = new Map<string, Promise<boolean>>();

function assetUrl(id: string): string {
  const base = (import.meta.env?.BASE_URL as string | undefined) ?? './';
  return `${base}assets/samples/${id}.json`;
}

/** Load one model; resolves false if it cannot be fetched (the program is then refused, never faked). */
export function loadAsset(id: string): Promise<boolean> {
  if (hasAsset(id)) return Promise.resolve(true);
  let p = pending.get(id);
  if (!p) {
    p = fetch(assetUrl(id))
      .then((r) => (r.ok ? (r.json() as Promise<AssetFile>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => { registerAsset(id, data); return true; })
      .catch(() => { pending.delete(id); return false; });
    pending.set(id, p);
  }
  return p;
}

/** Load every model a program uses. */
export async function ensureAssets(program: FabProgram): Promise<void> {
  const ids = [...new Set(program.parts.filter((p) => p.kind === 'asset' && p.asset).map((p) => p.asset!))];
  await Promise.all(ids.map(loadAsset));
}
