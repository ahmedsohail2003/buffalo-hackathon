// The pointing answer on the deck: a pulsing violet ring where the bay-camera model pointed, with
// a short floating label (who pointed, the miss in mm) above the sample's own name tag, for about
// 6 s. Viewer-only (layer 1): the bay camera, and so Gemini, never sees it. Added to the scene
// through registerSceneHook (src/gemini/install.tsx wires it to the bus event 'er:point').
import * as THREE from 'three';
import { ER_FADE_MS, ER_OVERLAY_MS, markerText } from '../app/erView';
import type { ErPointEvent, Vec3 } from '../contracts';
import { CONTAINMENT_FLOOR_Z, inContainment } from '../core/constants';
import { VIEW_ONLY } from './environment';
import { LABEL_GAP, LABEL_H, disposeLabelSprite, makeLabelSprite } from './labelSprite';
import type { SceneHook } from './registry';

const VIOLET = 0x8b5cf6;
/** ring radius, m: just outside the footprint of the largest sample the arm takes */
export const ER_RING_R = 0.028;
const RING_HALF_W = 0.0024;
/** the ring sits this far above the deck (or the bin floor), m */
const RING_LIFT = 0.0012;
/** the marker label's bottom edge sits this far above the sample's own name tag, m */
const LABEL_CLEAR = 0.004;
const PULSE_MS = 1000;

export interface MarkerLook {
  /** overall opacity, 0-1 */
  alpha: number;
  /** ring scale, about 1 */
  pulse: number;
  /** ripple ring scale (1 to 1.7) and opacity */
  ripple: number;
  rippleAlpha: number;
}

/** The marker at age ms: fades in, pulses once a second, fades out over the last ER_FADE_MS; null once it is over. */
export function markerLook(ageMs: number): MarkerLook | null {
  if (!(ageMs >= 0) || ageMs >= ER_OVERLAY_MS) return null;
  const alpha = Math.max(0, Math.min(1, ageMs / 150, (ER_OVERLAY_MS - ageMs) / ER_FADE_MS));
  const phase = (ageMs % PULSE_MS) / PULSE_MS;
  return {
    alpha,
    pulse: 1 + 0.1 * Math.sin(phase * 2 * Math.PI),
    ripple: 1 + 0.7 * phase,
    rippleAlpha: alpha * 0.7 * (1 - phase),
  };
}

/**
 * Where the ring and its label go, bay frame metres. The ring lies on the deck (or the bin floor)
 * under the found point. The found point is on the plane of the sample's centre, so the sample's
 * top is about twice that height above the floor; the label floats above the sample's name tag.
 */
export function markerPlacement(ev: ErPointEvent): { ring: Vec3; label: Vec3 } | null {
  const f = ev.found_mm;
  if (!f) return null;
  const x = f[0] / 1000;
  const y = f[1] / 1000;
  const floor = inContainment(x, y) ? CONTAINMENT_FLOOR_Z : 0;
  const centre = (ev.truth_mm ? ev.truth_mm[2] : f[2]) / 1000;
  const top = floor + 2 * Math.max(0, centre - floor);
  return { ring: [x, y, floor + RING_LIFT], label: [x, y, top + LABEL_GAP + LABEL_H + LABEL_CLEAR] };
}

export interface ErMarker {
  readonly group: THREE.Group;
  /** the current floating label (null when none is shown) */
  label(): THREE.Sprite | null;
  show(ev: ErPointEvent, now: number): void;
  update(now: number): void;
  dispose(): void;
}

export type MarkerLabelFactory = (text: string) => THREE.Sprite;

const violetLabel: MarkerLabelFactory = (text) =>
  makeLabelSprite(text, { stroke: 'rgba(139,92,246,1)', color: '#f5f3ff', weight: 700, height: LABEL_H * 1.2 });

/** The ring, its ripple and the label, under the bay root. labelFactory is for tests (the default draws on a canvas). */
export function createErMarker(root: THREE.Object3D, labelFactory: MarkerLabelFactory = violetLabel): ErMarker {
  const group = new THREE.Group();
  group.name = 'er-marker';
  group.visible = false;
  const geo = new THREE.RingGeometry(ER_RING_R - RING_HALF_W, ER_RING_R + RING_HALF_W, 72);
  const discGeo = new THREE.CircleGeometry(ER_RING_R - RING_HALF_W, 48);
  // depth-tested, so the sample hides the far side of the ring as if it were painted on the deck;
  // not tone-mapped, so the violet stays crisp on the light deck
  const ringMat = new THREE.MeshBasicMaterial({ color: VIOLET, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const rippleMat = ringMat.clone();
  const discMat = ringMat.clone();
  const ring = new THREE.Mesh(geo, ringMat);
  const ripple = new THREE.Mesh(geo, rippleMat);
  const disc = new THREE.Mesh(discGeo, discMat);
  ring.name = 'er-ring';
  ripple.name = 'er-ripple';
  disc.name = 'er-disc';
  ring.renderOrder = ripple.renderOrder = disc.renderOrder = 9;
  group.add(disc, ring, ripple);
  group.traverse((o) => o.layers.set(VIEW_ONLY));
  root.add(group);

  let shown: { ev: ErPointEvent; at: number; label: THREE.Sprite | null } | null = null;

  const dropLabel = () => {
    if (!shown?.label) return;
    shown.label.removeFromParent();
    disposeLabelSprite(shown.label);
    shown.label = null;
  };

  const hide = () => {
    dropLabel();
    shown = null;
    group.visible = false;
  };

  const update = (now: number) => {
    if (!shown) return;
    const look = markerLook(now - shown.at);
    if (!look) {
      hide();
      return;
    }
    ring.scale.setScalar(look.pulse);
    ringMat.opacity = 0.95 * look.alpha;
    ripple.scale.setScalar(look.ripple);
    rippleMat.opacity = look.rippleAlpha;
    disc.scale.setScalar(look.pulse);
    discMat.opacity = 0.16 * look.alpha;
    if (shown.label) shown.label.material.opacity = look.alpha;
  };

  const show = (ev: ErPointEvent, now: number) => {
    dropLabel();
    const at = markerPlacement(ev);
    if (!at) {
      hide();
      return;
    }
    group.position.set(...at.ring);
    const label = labelFactory(markerText(ev));
    label.name = 'er-label';
    label.layers.set(VIEW_ONLY);
    label.renderOrder = 6;
    label.material.depthTest = false;
    label.material.toneMapped = false;
    label.position.set(...at.label);
    // staggered right after the pointed-at sample's own tag, so the two stay together
    if (ev.sample_id) label.userData.tagAfter = ev.sample_id;
    root.add(label);
    shown = { ev, at: now, label };
    group.visible = true;
    update(now);
  };

  return {
    group,
    label: () => shown?.label ?? null,
    show,
    update,
    dispose() {
      hide();
      group.removeFromParent();
      geo.dispose();
      discGeo.dispose();
      ringMat.dispose();
      rippleMat.dispose();
      discMat.dispose();
    },
  };
}

/** For registerSceneHook: the marker under the bay root, shown on each event from subscribe. */
export function erMarkerHook(
  subscribe: (cb: (ev: ErPointEvent) => void) => () => void,
  clock: () => number = () => performance.now(),
  labelFactory?: MarkerLabelFactory,
): SceneHook {
  return (ctx) => {
    const marker = createErMarker(ctx.root, labelFactory);
    const off = subscribe((ev) => marker.show(ev, clock()));
    return {
      update: () => marker.update(clock()),
      labels: () => {
        const l = marker.label();
        return l ? [l] : [];
      },
      dispose: () => {
        off();
        marker.dispose();
      },
    };
  };
}
