import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Raycaster, Sprite, SpriteMaterial, Vector2, Vector3 } from 'three';
import type { Sample, SampleApi } from '../contracts';
import { CONTAINMENT_XY } from '../core/constants';
import { BinArrivals, LABEL_GAP_PX, LabelStagger, orderTags, screenBox, staggerUp, tagHidden, type LabelBox } from './labelLayout';
import { SampleLayer } from './samples';

const box = (id: string, left: number, top: number, w = 100, h = 14): LabelBox => ({ id, left, right: left + w, top, bottom: top + h });

describe('staggerUp: overlapping tags', () => {
  it('leaves tags that do not overlap where they are', () => {
    const s = staggerUp([box('a', 0, 100), box('b', 120, 100), box('c', 0, 130)]);
    expect([...s.values()]).toEqual([0, 0, 0]);
  });

  it('moves the later of two overlapping tags up, just clear of the earlier one', () => {
    // b overlaps a by 6 px vertically and 40 px across: its bottom goes to a.top - gap
    const s = staggerUp([box('a', 0, 100), box('b', 60, 108)]);
    expect(s.get('a')).toBe(0);
    expect(s.get('b')).toBe(108 + 14 - (100 - LABEL_GAP_PX));
    // the same pair the other way round: the later one still moves, even from above
    const r = staggerUp([box('b', 60, 108), box('a', 0, 100)]);
    expect(r.get('b')).toBe(0);
    expect(r.get('a')).toBe(100 + 14 - (108 - LABEL_GAP_PX));
  });

  it('stacks a third tag above both; tags that only touch do not move', () => {
    const s = staggerUp([box('a', 0, 100), box('b', 10, 100), box('c', 20, 100)]);
    expect(s.get('b')).toBe(14 + LABEL_GAP_PX);
    expect(s.get('c')).toBe(2 * (14 + LABEL_GAP_PX));
    // tags that only touch (overlap by 1 px or less) stay where they are
    expect(staggerUp([box('a', 0, 100), box('b', 0, 113)]).get('b')).toBe(0);
    expect(staggerUp([box('a', 0, 100), box('b', 0, 112)]).get('b')).toBe(112 + 14 - (100 - LABEL_GAP_PX));
    expect(staggerUp([box('a', 0, 100), box('b', 99, 105)]).get('b')).toBe(0);
    // side by side with no horizontal overlap: no move
    expect(staggerUp([box('a', 0, 100), box('b', 100, 100)]).get('b')).toBe(0);
  });

  it('a tag lifted past one tag is checked against the others too', () => {
    // b sits 6 px above a (clear); c overlaps a, and lifted above a it would hit b, so it ends above b
    const s = staggerUp([box('a', 0, 100), box('b', 0, 80), box('c', 0, 104)]);
    expect(s.get('b')).toBe(0);
    expect(104 + 14 - s.get('c')!).toBe(80 - LABEL_GAP_PX);
  });
});

describe('orderTags: extra tags stay with their sample', () => {
  it('places a tag naming a sample right after that sample, the others after all samples', () => {
    const t = (id: string) => ({ id, sprite: new Sprite(new SpriteMaterial()) });
    const er = new Sprite(new SpriteMaterial());
    er.userData.tagAfter = 'bennu';
    const loose = new Sprite(new SpriteMaterial());
    const orphan = new Sprite(new SpriteMaterial());
    orphan.userData.tagAfter = 'gone';
    const order = orderTags([t('cube'), t('bennu'), t('iron')], [loose, er, orphan]).map((x) => (x.sprite === er ? 'er' : x.sprite === loose ? 'loose' : x.sprite === orphan ? 'orphan' : x.id));
    expect(order).toEqual(['cube', 'bennu', 'er', 'iron', 'loose', 'orphan']);
  });
});

describe('screenBox: a bottom-anchored tag on screen', () => {
  const cam = new PerspectiveCamera(36, 800 / 500, 0.01, 40);
  cam.position.set(0, -1, 0);
  cam.up.set(0, 0, 1);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();

  it('anchors the box bottom-centre at the projected point and sizes it by depth', () => {
    const sb = screenBox('t', new Vector3(0, 0, 0), 0.05, 0.013, cam, 800, 500)!;
    const worldPerPx = (2 * 1 * Math.tan((36 * Math.PI) / 360)) / 500;
    expect(sb.worldPerPx).toBeCloseTo(worldPerPx, 9);
    expect(sb.box.bottom).toBeCloseTo(250, 6);
    expect((sb.box.left + sb.box.right) / 2).toBeCloseTo(400, 6);
    expect(sb.box.bottom - sb.box.top).toBeCloseTo(0.013 / worldPerPx, 6);
    expect(sb.box.right - sb.box.left).toBeCloseTo(0.05 / worldPerPx, 6);
    // twice as far: half the size
    const far = screenBox('t', new Vector3(0, 1, 0), 0.05, 0.013, cam, 800, 500)!;
    expect(far.box.bottom - far.box.top).toBeCloseTo((sb.box.bottom - sb.box.top) / 2, 6);
    expect(screenBox('t', new Vector3(0, -2, 0), 0.05, 0.013, cam, 800, 500)).toBeNull();
  });
});

describe('bin rule', () => {
  it('hides tags of samples resting in the bin unless newest or hovered', () => {
    expect(tagHidden('a', false, 'b', null)).toBe(false);
    expect(tagHidden('a', true, 'a', null)).toBe(false);
    expect(tagHidden('a', true, 'b', 'a')).toBe(false);
    expect(tagHidden('a', true, 'b', null)).toBe(true);
  });

  it('remembers the order of arrival in the bin', () => {
    const order = new BinArrivals();
    // already in the bin at the first look: list order decides
    expect(order.update([{ id: 'a', inBin: true }, { id: 'b', inBin: true }, { id: 'c', inBin: false }])).toBe('b');
    // c arrives later: it is the newest
    expect(order.update([{ id: 'a', inBin: true }, { id: 'b', inBin: true }, { id: 'c', inBin: true }])).toBe('c');
    // a leaves and comes back: newest again
    order.update([{ id: 'a', inBin: false }, { id: 'b', inBin: true }, { id: 'c', inBin: true }]);
    expect(order.update([{ id: 'a', inBin: true }, { id: 'b', inBin: true }, { id: 'c', inBin: true }])).toBe('a');
    // a sample removed from the registry is forgotten
    expect(order.update([{ id: 'b', inBin: true }, { id: 'c', inBin: true }])).toBe('c');
    expect(order.update([{ id: 'b', inBin: false }])).toBeNull();
  });
});

describe('LabelStagger: moving tags by their anchor', () => {
  const cam = new PerspectiveCamera(36, 800 / 500, 0.01, 40);
  cam.position.set(0, -1, 0.3);
  cam.up.set(0, 0, 1);
  cam.lookAt(0, 0, 0);

  const tag = (x: number) => {
    const s = new Sprite(new SpriteMaterial());
    s.scale.set(0.06, 0.013, 1);
    s.center.set(0.5, 0);
    s.position.set(x, 0, 0.04);
    return s;
  };

  it('lifts the later of two overlapping tags by its own height plus the gap, without moving its position', () => {
    const a = tag(0);
    const b = tag(0.01);
    const st = new LabelStagger();
    const shifts = st.apply([{ id: 'a', sprite: a }, { id: 'b', sprite: b }], cam, 800, 500, 0);
    expect(a.center.y).toBe(0);
    const sb = screenBox('b', b.position, 0.06, 0.013, cam, 800, 500)!;
    const hPx = 0.013 / sb.worldPerPx;
    expect(shifts.get('b')).toBeGreaterThan(hPx);
    expect(b.center.y).toBeCloseTo(-shifts.get('b')! / hPx, 9);
    expect(b.position.toArray()).toEqual([0.01, 0, 0.04]);
  });

  it('eases toward a new target, and resets hidden tags', () => {
    const a = tag(0);
    const b = tag(0.01);
    const st = new LabelStagger();
    st.apply([{ id: 'a', sprite: a }, { id: 'b', sprite: b }], cam, 800, 500, 0);
    const lifted = b.center.y;
    b.position.x = 0.3; // no longer overlapping
    st.apply([{ id: 'a', sprite: a }, { id: 'b', sprite: b }], cam, 800, 500, 1 / 30);
    expect(b.center.y).toBeLessThan(0);
    expect(b.center.y).toBeGreaterThan(lifted);
    for (let i = 0; i < 40; i++) st.apply([{ id: 'a', sprite: a }, { id: 'b', sprite: b }], cam, 800, 500, 1 / 30);
    expect(b.center.y).toBeCloseTo(0, 3);
    b.position.x = 0.01;
    st.apply([{ id: 'a', sprite: a }, { id: 'b', sprite: b }], cam, 800, 500, 0);
    b.visible = false;
    st.apply([{ id: 'a', sprite: a }, { id: 'b', sprite: b }], cam, 800, 500, 0);
    expect(b.center.y).toBe(0);
  });
});

describe('SampleLayer name tags', () => {
  const [bx, by] = CONTAINMENT_XY;
  const mk = (id: string, x: number, y: number, held = false): Sample => ({
    id,
    name: id,
    color: '#888',
    kind: 'box',
    dims: { w: 0.024, d: 0.024, h: 0.024 },
    pos: [x, y, 0.015],
    yaw: 0,
    held,
    createdBy: 'seed',
  });

  function api(samples: Sample[]): SampleApi {
    return {
      list: () => samples,
      get: (id: string) => samples.find((s) => s.id === id),
      onChange: () => () => {},
    } as unknown as SampleApi;
  }

  const stubTag = (text: string) => {
    const s = new Sprite(new SpriteMaterial());
    s.name = `tag:${text}`;
    s.layers.set(1);
    return s;
  };

  it('shows only the newest bin arrival among samples resting in the bin, and the hovered one', () => {
    const samples = [mk('itokawa', bx - 0.02, by), mk('deck', 0.05, -0.16), mk('bennu', bx + 0.02, by)];
    const layer = new SampleLayer(api(samples), stubTag);
    layer.sync(0);
    const visible = () => layer.tags().map((t) => t.id);
    expect(visible()).toEqual(['deck', 'bennu']);
    layer.setHovered('itokawa');
    layer.sync(16);
    expect(visible()).toEqual(['itokawa', 'deck', 'bennu']);
    layer.setHovered(null);
    // held over the bin it is not resting there: its tag shows
    samples[0] = mk('itokawa', bx - 0.02, by, true);
    layer.sync(32);
    expect(visible()).toEqual(['itokawa', 'deck', 'bennu']);
    // set down again it is the newest arrival, so Bennu's tag hides
    samples[0] = mk('itokawa', bx - 0.02, by);
    layer.sync(48);
    expect(visible()).toEqual(['itokawa', 'deck']);
    // every tag stays on the viewer-only layer
    for (const c of layer.group.children) if (c instanceof Sprite) expect(c.layers.mask).toBe(1 << 1);
    layer.dispose();
  });

  it('picks the sample under the pointer from its mesh', () => {
    const samples = [mk('deck', 0, -0.16)];
    const layer = new SampleLayer(api(samples), stubTag);
    layer.sync(0);
    const cam = new PerspectiveCamera(36, 1.6, 0.01, 40);
    cam.position.set(0, -0.7, 0.3);
    cam.up.set(0, 0, 1);
    cam.lookAt(0, -0.16, 0.015);
    cam.updateMatrixWorld();
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2(0, 0), cam);
    expect(layer.pick(ray)).toBe('deck');
    ray.setFromCamera(new Vector2(0.9, 0.9), cam);
    expect(layer.pick(ray)).toBeNull();
    layer.dispose();
  });
});
