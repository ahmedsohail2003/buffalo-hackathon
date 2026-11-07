import { describe, it, expect } from 'vitest';
import { Group, Mesh, MeshBasicMaterial } from 'three';
import type { TeleopStatus } from '../contracts';
import { createTargetMarker, teleopSceneHook } from './targetMarker';

const status = (over: Partial<TeleopStatus>): TeleopStatus => ({
  enabled: true,
  handPresent: true,
  pinched: false,
  target_mm: [40, -180, 75],
  mode: 'following',
  note: '',
  ...over,
});

describe('teleop target marker', () => {
  it('lies on the deck at the target, viewer layer only, red when blocked, hidden when off', () => {
    const root = new Group();
    const m = createTargetMarker(root);
    const ring = root.getObjectByName('teleop-target') as Mesh;
    expect(ring.visible).toBe(false);
    m.update(status({}));
    expect(ring.visible).toBe(true);
    expect(ring.position.toArray()).toEqual([0.04, -0.18, 0.001]);
    expect(ring.layers.mask).toBe(1 << 1);
    expect((ring.material as MeshBasicMaterial).color.getHex()).toBe(0x22d3ee);
    m.update(status({ mode: 'blocked' }));
    expect((ring.material as MeshBasicMaterial).color.getHex()).toBe(0xef4444);
    m.update(status({ enabled: false }));
    expect(ring.visible).toBe(false);
    m.update(status({ target_mm: null }));
    expect(ring.visible).toBe(false);
    m.dispose();
    expect(root.getObjectByName('teleop-target')).toBeUndefined();
  });

  it('teleopSceneHook builds the marker under ctx.root and updates it from the status getter', () => {
    const root = new Group();
    let s: TeleopStatus | null = null;
    const hook = teleopSceneHook(() => s)({ root });
    hook.update();
    const ring = root.getObjectByName('teleop-target') as Mesh;
    expect(ring.visible).toBe(false);
    s = status({ target_mm: [-100, -120, 90] });
    hook.update();
    expect(ring.visible).toBe(true);
    expect(ring.position.x).toBeCloseTo(-0.1, 9);
  });
});
