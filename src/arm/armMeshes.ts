// Quantized mesh decode, ported from the portfolio work-cell page
// (repos/ahmedsohail2003.github.io/workcell/index.html:1672-1682).
// Meshes: MuJoCo Menagerie `trs_so_arm100` (Apache-2.0).
// Browser-only in practice (BufferGeometry); not imported by the FK/IK modules.

import { BufferGeometry, BufferAttribute } from 'three';
import type { ArmData, ArmMesh } from './armData';

function b64(s: string): Uint8Array {
  const bin = atob(s);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

export function decodeMesh(m: ArmMesh): BufferGeometry {
  const vq = new Uint16Array(b64(m.v).buffer);
  const pos = new Float32Array(m.n * 3);
  for (let i = 0; i < m.n; i++) {
    for (let k = 0; k < 3; k++) pos[i * 3 + k] = m.lo[k] + (vq[i * 3 + k] / 65535) * m.span[k];
  }
  const idx = m.i32 ? new Uint32Array(b64(m.i).buffer) : new Uint16Array(b64(m.i).buffer);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

export function decodeAllMeshes(data: ArmData): Record<string, BufferGeometry> {
  const out: Record<string, BufferGeometry> = {};
  for (const name in data.meshes) out[name] = decodeMesh(data.meshes[name]);
  return out;
}
