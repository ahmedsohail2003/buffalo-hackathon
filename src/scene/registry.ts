// Extension points of the bay scene. Other layers register here; the scene picks them up even if
// they register after it is built.
import type * as THREE from 'three';
import type { Sample } from '../contracts';

/**
 * Returns the geometry of a sample, or null to pass (for example while an asset is still loading;
 * the scene keeps a placeholder and asks again). The geometry is centred on its bounding box,
 * z up, metres, narrow side along local +x, already at its final size. It may be cached and
 * shared: the scene never mutates or disposes it.
 */
export type SampleGeometryFactory = (s: Sample) => THREE.BufferGeometry | null;

/** Optional material parameters for a sample built by the matching geometry factory. */
export type SampleMaterialFactory = (s: Sample) => THREE.MeshStandardMaterialParameters | null;

export interface SceneHookContext {
  scene: THREE.Scene;
  /** the bay frame: z up, metres, arm base at the origin */
  root: THREE.Group;
  viewerCam: THREE.PerspectiveCamera;
}

/** What a scene hook adds: update() runs every rendered frame; labels() lists its floating tags, if any. */
export interface SceneHookInstance {
  update(): void;
  dispose?(): void;
  /**
   * Viewer-only tags anchored at their bottom centre. The view staggers them with the sample tags:
   * right after the tag of the sample named by sprite.userData.tagAfter, else after all of them.
   */
  labels?(): readonly THREE.Sprite[];
}

/** Called once with the scene. */
export type SceneHook = (ctx: SceneHookContext) => SceneHookInstance;

interface GeometryEntry {
  geometry: SampleGeometryFactory;
  material?: SampleMaterialFactory;
}

const geometryFactories: GeometryEntry[] = [];
const geometryListeners = new Set<() => void>();
const sceneHooks: SceneHook[] = [];
const hookListeners = new Set<(hook: SceneHook, added: boolean) => void>();

/**
 * Register a sample geometry builder (the fabricator does), with optional material parameters.
 * The newest factory is tried first; returning null falls through to older ones and finally to
 * the built-in placeholder. Every sample mesh is rebuilt when a factory is added or removed.
 */
export function registerSampleGeometry(geometry: SampleGeometryFactory, material?: SampleMaterialFactory): () => void {
  const entry: GeometryEntry = material ? { geometry, material } : { geometry };
  geometryFactories.push(entry);
  geometryListeners.forEach((cb) => cb());
  return () => {
    const i = geometryFactories.indexOf(entry);
    if (i >= 0) geometryFactories.splice(i, 1);
    geometryListeners.forEach((cb) => cb());
  };
}

export interface RegisteredSampleLook {
  /** shared geometry: never mutate or dispose */
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterialParameters | null;
}

/** Try the registered factories, newest first. A factory that throws is skipped. */
export function buildRegisteredSample(s: Sample): RegisteredSampleLook | null {
  for (let i = geometryFactories.length - 1; i >= 0; i--) {
    const entry = geometryFactories[i]!;
    try {
      const geometry = entry.geometry(s);
      if (!geometry) continue;
      let material: THREE.MeshStandardMaterialParameters | null = null;
      try {
        material = entry.material?.(s) ?? null;
      } catch (err) {
        console.error('[scene] sample material factory failed', err);
      }
      return { geometry, material };
    } catch (err) {
      console.error('[scene] sample geometry factory failed', err);
    }
  }
  return null;
}

export function hasSampleGeometryFactories(): boolean {
  return geometryFactories.length > 0;
}

export function onSampleGeometryChange(cb: () => void): () => void {
  geometryListeners.add(cb);
  return () => geometryListeners.delete(cb);
}

/** Add something to the bay scene, for example the teleop target marker (keep it on layer 1). */
export function registerSceneHook(fn: SceneHook): () => void {
  sceneHooks.push(fn);
  hookListeners.forEach((cb) => cb(fn, true));
  return () => {
    const i = sceneHooks.indexOf(fn);
    if (i < 0) return;
    sceneHooks.splice(i, 1);
    hookListeners.forEach((cb) => cb(fn, false));
  };
}

export function registeredSceneHooks(): readonly SceneHook[] {
  return sceneHooks;
}

export function onSceneHooksChange(cb: (hook: SceneHook, added: boolean) => void): () => void {
  hookListeners.add(cb);
  return () => hookListeners.delete(cb);
}
