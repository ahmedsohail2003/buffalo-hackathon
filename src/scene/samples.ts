// Sample meshes: one per registry entry. The registry is ground truth; this layer only draws it.
// Poses are read every frame (the core moves a held sample with the jaw without emitting onChange).
import * as THREE from 'three';
import type { Sample, SampleApi } from '../contracts';
import { buildRegisteredSample, onSampleGeometryChange } from './registry';

const PLACEHOLDER_COLOR = '#8d939c';
const RETRY_MS = 200;

interface Item {
  mesh: THREE.Mesh;
  key: string;
  /** true when this layer created the geometry (and must dispose it) */
  ownsGeometry: boolean;
  /** drawn as the placeholder while a registered factory has nothing yet */
  placeholder: boolean;
}

const keyCache = new WeakMap<Sample, string>();

function lookKey(s: Sample): string {
  let k = keyCache.get(s);
  if (k === undefined) {
    const m = s.mesh;
    const meshKey = m ? `${m.assetId ?? ''}|${m.scale}|${m.source}|${JSON.stringify(m.program)}` : '';
    k = `${s.kind}|${s.dims.w.toFixed(5)}|${s.dims.d.toFixed(5)}|${s.dims.h.toFixed(5)}|${s.color}|${meshKey}`;
    keyCache.set(s, k);
  }
  return k;
}

function primitiveGeometry(s: Sample): THREE.BufferGeometry {
  const { w, d, h } = s.dims;
  switch (s.kind) {
    case 'box':
      return new THREE.BoxGeometry(w, d, h);
    case 'cylinder': {
      const g = new THREE.CylinderGeometry(0.5, 0.5, 1, 40);
      g.rotateX(Math.PI / 2); // axis along z
      g.scale(w, d, h);
      return g;
    }
    case 'sphere': {
      const g = new THREE.SphereGeometry(0.5, 32, 20);
      g.scale(w, d, h);
      return g;
    }
    default: {
      const g = new THREE.IcosahedronGeometry(0.5, 1);
      g.scale(w, d, h);
      return g;
    }
  }
}

interface Look {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  ownsGeometry: boolean;
  placeholder: boolean;
}

function buildLook(s: Sample): Look {
  const reg = buildRegisteredSample(s);
  if (reg) {
    const vertexColors = reg.material?.vertexColors ?? !!reg.geometry.getAttribute('color');
    // vertex colours carry the part colours: keep the base colour white so they are not tinted
    const params: THREE.MeshStandardMaterialParameters = { color: vertexColors ? '#ffffff' : s.color, roughness: 0.88, metalness: 0.05, ...(reg.material ?? {}), vertexColors };
    return { geometry: reg.geometry, material: new THREE.MeshStandardMaterial(params), ownsGeometry: false, placeholder: false };
  }
  if (s.kind === 'mesh') {
    return {
      geometry: primitiveGeometry(s),
      material: new THREE.MeshStandardMaterial({ color: PLACEHOLDER_COLOR, roughness: 0.9, metalness: 0.05, flatShading: true }),
      ownsGeometry: true,
      placeholder: true,
    };
  }
  return {
    geometry: primitiveGeometry(s),
    material: new THREE.MeshStandardMaterial({ color: s.color, roughness: 0.55, metalness: 0.12 }),
    ownsGeometry: true,
    placeholder: false,
  };
}

export class SampleLayer {
  readonly group = new THREE.Group();
  private items = new Map<string, Item>();
  private dirty = true;
  private lastRetry = 0;
  private offs: (() => void)[] = [];

  constructor(private api: SampleApi) {
    this.group.name = 'samples';
    this.offs.push(api.onChange(() => (this.dirty = true)));
    this.offs.push(
      onSampleGeometryChange(() => {
        for (const item of this.items.values()) item.key = ''; // rebuild every mesh
        this.dirty = true;
      }),
    );
  }

  /** Bring meshes in line with the registry and place them at their current poses. */
  sync(now: number): void {
    if (this.dirty) this.reconcile();
    if (now - this.lastRetry > RETRY_MS) {
      this.lastRetry = now;
      for (const [id, item] of this.items) {
        if (!item.placeholder) continue;
        const s = this.api.get(id);
        if (s && buildRegisteredSample(s)) {
          item.key = ''; // a factory can draw it now
          this.dirty = true;
        }
      }
      if (this.dirty) this.reconcile();
    }
    for (const s of this.api.list()) {
      const mesh = this.items.get(s.id)?.mesh;
      if (!mesh) continue;
      mesh.position.set(s.pos[0], s.pos[1], s.pos[2]);
      mesh.rotation.set(0, 0, s.yaw);
    }
  }

  private reconcile(): void {
    this.dirty = false;
    const seen = new Set<string>();
    for (const s of this.api.list()) {
      seen.add(s.id);
      const key = lookKey(s);
      const item = this.items.get(s.id);
      if (item && item.key === key) continue;
      if (item) this.drop(s.id);
      const look = buildLook(s);
      const mesh = new THREE.Mesh(look.geometry, look.material);
      mesh.name = `sample:${s.id}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.sampleId = s.id;
      this.group.add(mesh);
      this.items.set(s.id, { mesh, key, ownsGeometry: look.ownsGeometry, placeholder: look.placeholder });
    }
    for (const id of [...this.items.keys()]) if (!seen.has(id)) this.drop(id);
  }

  private drop(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    this.group.remove(item.mesh);
    if (item.ownsGeometry) item.mesh.geometry.dispose();
    (item.mesh.material as THREE.Material).dispose();
    this.items.delete(id);
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    for (const id of [...this.items.keys()]) this.drop(id);
  }
}
