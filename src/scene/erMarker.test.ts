import { describe, expect, it } from 'vitest';
import { Group, Mesh, MeshBasicMaterial, PerspectiveCamera, RingGeometry, Scene, Sprite, SpriteMaterial } from 'three';
import { ER_OVERLAY_MS } from '../app/erView';
import type { ErPointEvent } from '../contracts';
import { CONTAINMENT_FLOOR_Z, CONTAINMENT_XY } from '../core/constants';
import { ER_RING_R, createErMarker, erMarkerHook, markerLook, markerPlacement } from './erMarker';
import { LABEL_GAP, LABEL_H } from './labelSprite';

function point(over: Partial<ErPointEvent> = {}): ErPointEvent {
  return {
    kind: 'point',
    t: 1,
    source: 'coworker',
    label: 'the Bennu sample',
    point_yx: [612, 571],
    sample_id: 'sample_2',
    sample_name: 'Bennu (NASA shape model)',
    found_mm: [57, -156, 16],
    error_mm: 1.5,
    truth_mm: [56, -155, 16],
    truth_yx: [613.2, 569.5],
    ...over,
  };
}

/** A label factory without a canvas (node): a plain sprite that remembers its text. */
const texts: string[] = [];
const stubLabel = (text: string) => {
  texts.push(text);
  const s = new Sprite(new SpriteMaterial());
  s.userData.text = text;
  return s;
};

describe('deck marker timing', () => {
  it('fades in, pulses about once a second, fades out over the last 1.5 s and ends at 6 s', () => {
    expect(markerLook(-1)).toBeNull();
    expect(markerLook(0)!.alpha).toBe(0);
    expect(markerLook(150)!.alpha).toBe(1);
    expect(markerLook(3000)!.alpha).toBe(1);
    expect(markerLook(5250)!.alpha).toBeCloseTo(0.5, 6);
    expect(markerLook(ER_OVERLAY_MS)).toBeNull();
    expect(markerLook(1250)!.pulse).toBeCloseTo(1.1, 6);
    expect(markerLook(1750)!.pulse).toBeCloseTo(0.9, 6);
    expect(markerLook(2000)!.ripple).toBe(1);
    expect(markerLook(2500)!.ripple).toBeCloseTo(1.35, 6);
    expect(markerLook(2500)!.rippleAlpha).toBeCloseTo(0.35, 6);
  });
});

describe('deck marker placement', () => {
  it('puts the ring on the deck under the found point and the label above the sample name tag', () => {
    const at = markerPlacement(point())!;
    expect(at.ring[0]).toBeCloseTo(0.057, 9);
    expect(at.ring[1]).toBeCloseTo(-0.156, 9);
    expect(at.ring[2]).toBeCloseTo(0.0012, 9);
    // centre at 16 mm: top at 32 mm; the name tag spans top + gap to top + gap + height
    expect(at.label[2]).toBeGreaterThan(0.032 + LABEL_GAP + LABEL_H);
    expect(at.label[2]).toBeLessThan(0.032 + LABEL_GAP + LABEL_H + 0.01);
    expect(markerPlacement(point({ found_mm: null }))).toBeNull();
  });

  it('inside the containment bin, the ring lies on the bin floor', () => {
    const [x, y] = CONTAINMENT_XY;
    const at = markerPlacement(point({ found_mm: [x * 1000 + 5, y * 1000, 15], truth_mm: [x * 1000, y * 1000, 15] }))!;
    expect(at.ring[2]).toBeCloseTo(CONTAINMENT_FLOOR_Z + 0.0012, 9);
  });
});

describe('deck marker', () => {
  it('shows a viewer-only ring and label at the found point, then hides and drops the label after 6 s', () => {
    const root = new Group();
    const m = createErMarker(root, stubLabel);
    const group = root.getObjectByName('er-marker') as Group;
    expect(group.visible).toBe(false);
    m.show(point(), 1000);
    expect(group.visible).toBe(true);
    expect(group.position.x).toBeCloseTo(0.057, 9);
    expect(group.position.y).toBeCloseTo(-0.156, 9);
    const ring = root.getObjectByName('er-ring') as Mesh;
    const label = m.label()!;
    expect(label.userData.text).toBe('Robotics-ER · 1.5 mm off');
    for (const o of [group, ring, root.getObjectByName('er-ripple')!, root.getObjectByName('er-disc')!, label]) expect(o.layers.mask).toBe(1 << 1);
    expect(label.parent).toBe(root);
    expect((ring.geometry as RingGeometry).parameters.outerRadius).toBeGreaterThan(ER_RING_R);
    m.update(1000 + 3000);
    expect((ring.material as MeshBasicMaterial).opacity).toBeCloseTo(0.95, 6);
    m.update(1000 + ER_OVERLAY_MS);
    expect(group.visible).toBe(false);
    expect(m.label()).toBeNull();
    expect(root.getObjectByName('er-label')).toBeUndefined();
    m.dispose();
    expect(root.getObjectByName('er-marker')).toBeUndefined();
  });

  it('a new point replaces the old label; a point off the deck shows nothing', () => {
    const root = new Group();
    const m = createErMarker(root, stubLabel);
    m.show(point(), 0);
    m.show(point({ error_mm: 3.2 }), 100);
    expect(root.children.filter((c) => c.name === 'er-label')).toHaveLength(1);
    expect(m.label()!.userData.text).toBe('Robotics-ER · 3.2 mm off');
    m.show(point({ found_mm: null }), 200);
    expect(m.label()).toBeNull();
    expect(m.group.visible).toBe(false);
  });

  it('erMarkerHook shows each subscribed event on the bay root and unsubscribes on dispose', () => {
    const root = new Group();
    let emit: ((ev: ErPointEvent) => void) | null = null;
    let now = 0;
    const hook = erMarkerHook(
      (cb) => {
        emit = cb;
        return () => (emit = null);
      },
      () => now,
      stubLabel,
    )({ scene: new Scene(), root, viewerCam: new PerspectiveCamera() });
    emit!(point());
    hook.update();
    expect(root.getObjectByName('er-marker')!.visible).toBe(true);
    now = ER_OVERLAY_MS + 1;
    hook.update();
    expect(root.getObjectByName('er-marker')!.visible).toBe(false);
    hook.dispose?.();
    expect(emit).toBeNull();
    expect(root.getObjectByName('er-marker')).toBeUndefined();
  });
});
