// Hover-target marker for hand teleop: a thin ring on the deck under the point the hand is
// steering to. Cyan while following, red when the arm reports the target out of reach, hidden
// when teleop is off or no hand is seen. It is a viewer-only overlay: drawn on layer 1 (never in
// the bay camera frames Gemini sees) and without depth test, so the bin walls never hide it.

import { Mesh, MeshBasicMaterial, TorusGeometry, type Object3D } from 'three';
import type { TeleopStatus } from '../contracts';
import { getTeleopStatus } from './state';

const CYAN = 0x22d3ee;
const RED = 0xef4444;
/** Viewer-only layer (docs/ARCHITECTURE.md: decorations go on layer 1). */
const VIEWER_LAYER = 1;

export interface TargetMarker {
  update(status: TeleopStatus | null): void;
  dispose(): void;
}

/** Add the marker to the bay root (bay frame: metres, z up; the ring lies in the deck plane). */
export function createTargetMarker(root: Object3D): TargetMarker {
  const mat = new MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false });
  const geo = new TorusGeometry(0.02, 0.0018, 8, 48);
  const ring = new Mesh(geo, mat);
  ring.name = 'teleop-target';
  ring.visible = false;
  ring.renderOrder = 10;
  ring.layers.set(VIEWER_LAYER);
  root.add(ring);
  return {
    update(s) {
      const t = s?.enabled ? s.target_mm : null;
      if (!s || !t) {
        ring.visible = false;
        return;
      }
      ring.visible = true;
      ring.position.set(t[0] / 1000, t[1] / 1000, 0.001);
      mat.color.setHex(s.mode === 'blocked' ? RED : CYAN);
    },
    dispose() {
      ring.removeFromParent();
      geo.dispose();
      mat.dispose();
    },
  };
}

/**
 * For the scene's registerSceneHook: builds the marker under the bay root and updates it from
 * the teleop status every rendered frame.
 */
export function teleopSceneHook(getStatus: () => TeleopStatus | null = getTeleopStatus): (ctx: { root: Object3D }) => { update(): void } {
  return (ctx) => {
    const marker = createTargetMarker(ctx.root);
    return { update: () => marker.update(getStatus()) };
  };
}
