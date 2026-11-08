// Sample meshes: one per registry entry. The registry is ground truth; this layer only draws it.
// Poses are read every frame (the core moves a held sample with the jaw without emitting onChange).
// Name tags of samples resting in the containment bin stay hidden unless the sample is the newest
// arrival there or under the pointer (labelLayout.ts); the view staggers the visible ones.
import * as THREE from 'three';
import type { Sample, SampleApi } from '../contracts';
import { inContainment } from '../core/constants';
import { BinArrivals, tagHidden, type PlacedTag } from './labelLayout';
import { LABEL_GAP, disposeLabelSprite, makeLabelSprite } from './labelSprite';
import { buildRegisteredSample, onSampleGeometryChange } from './registry';

const PLACEHOLDER_COLOR = '#8d939c';
const RETRY_MS = 200;

interface Item {
  mesh: THREE.Mesh;
  /** viewer-only name tag */
  label: THREE.Sprite;
  key: string;
  /** true when this layer created the geometry (and must dispose it) */
  ownsGeometry: boolean;
  /** drawn as the placeholder while a registered factory has nothing yet */
  placeholder: boolean;
}

function lookKey(s: Sample): string {
  const m = s.mesh;
  const meshKey = m ? `${m.assetId ?? ''}|${m.scale}|${m.source}|${JSON.stringify(m.program)}` : '';
  return `${s.name}|${s.kind}|${s.dims.w.toFixed(5)}|${s.dims.d.toFixed(5)}|${s.dims.h.toFixed(5)}|${s.color}|${meshKey}`;
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

/** Resting (not held) inside the containment bin. */
function restingInBin(s: Sample): boolean {
  return !s.held && inContainment(s.pos[0], s.pos[1]);
}

export class SampleLayer {
  readonly group = new THREE.Group();
  private items = new Map<string, Item>();
  private dirty = true;
  private lastRetry = 0;
  private offs: (() => void)[] = [];
  private arrivals = new BinArrivals();
  private hovered: string | null = null;
  /** sample ids in registry order, as of the last sync */
  private order: string[] = [];

  /** makeTag draws a name tag (tests pass one that needs no canvas). */
  constructor(
    private api: SampleApi,
    private makeTag: (text: string) => THREE.Sprite = makeLabelSprite,
  ) {
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
    const list = this.api.list();
    const newest = this.arrivals.update(list.map((s) => ({ id: s.id, inBin: restingInBin(s) })));
    this.order = list.map((s) => s.id);
    for (const s of list) {
      const item = this.items.get(s.id);
      if (!item) continue;
      item.mesh.position.set(s.pos[0], s.pos[1], s.pos[2]);
      item.mesh.rotation.set(0, 0, s.yaw);
      item.label.position.set(s.pos[0], s.pos[1], s.pos[2] + s.dims.h / 2 + LABEL_GAP);
      item.label.visible = !tagHidden(s.id, restingInBin(s), newest, this.hovered);
    }
  }

  /** The sample under the pointer (its tag shows even in the bin); null for none. */
  setHovered(id: string | null): void {
    this.hovered = id;
  }

  /** The sample whose mesh the ray hits first, or null. */
  pick(ray: THREE.Raycaster): string | null {
    this.group.updateMatrixWorld();
    const hit = ray.intersectObjects([...this.items.values()].map((i) => i.mesh), false)[0];
    const id = hit?.object.userData.sampleId;
    return typeof id === 'string' ? id : null;
  }

  /** The visible name tags in registry order (earlier samples keep their place when tags overlap). */
  tags(): PlacedTag[] {
    const out: PlacedTag[] = [];
    for (const id of this.order) {
      const item = this.items.get(id);
      if (item?.label.visible) out.push({ id, sprite: item.label });
    }
    return out;
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
      const label = this.makeTag(s.name);
      this.group.add(mesh, label);
      this.items.set(s.id, { mesh, label, key, ownsGeometry: look.ownsGeometry, placeholder: look.placeholder });
    }
    for (const id of [...this.items.keys()]) if (!seen.has(id)) this.drop(id);
  }

  private drop(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    this.group.remove(item.mesh, item.label);
    if (item.ownsGeometry) item.mesh.geometry.dispose();
    (item.mesh.material as THREE.Material).dispose();
    disposeLabelSprite(item.label);
    this.items.delete(id);
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    for (const id of [...this.items.keys()]) this.drop(id);
  }
}
