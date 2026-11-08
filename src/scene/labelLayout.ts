// Name-tag layout for the viewer: which sample tags show, and how tags that would overlap on screen
// are staggered. Samples resting in the containment bin keep their tag hidden unless they are the
// newest arrival there or under the pointer. When two visible tags would overlap on screen, the
// later one (registry order; a scene hook's tag after the samples') moves up just clear of the
// earlier. A tag moves by its sprite's anchor (center), never its position, so whoever owns the
// position keeps owning it. Tags stay on the viewer-only layer.
import * as THREE from 'three';

/** A tag's box on screen, CSS px, y down. */
export interface LabelBox {
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Space left between a lifted tag and the tag below it, px. */
export const LABEL_GAP_PX = 2;
/** Tags that overlap by no more than this (px, either way) count as touching, not overlapping. */
export const LABEL_SLACK_PX = 1;

function overlaps(a: { left: number; right: number; top: number; bottom: number }, b: LabelBox): boolean {
  const across = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const down = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return across > LABEL_SLACK_PX && down > LABEL_SLACK_PX;
}

/**
 * Upward shift (px) for each box so that no two overlap. Boxes are placed in order; a box that
 * overlaps one already placed moves up until its bottom is gapPx above that box's top, and is
 * then checked against the rest. Boxes that overlap nothing keep 0.
 */
export function staggerUp(boxes: readonly LabelBox[], gapPx: number = LABEL_GAP_PX): Map<string, number> {
  const shifts = new Map<string, number>();
  const placed: LabelBox[] = [];
  for (const b of boxes) {
    let shift = 0;
    // each pass either clears the box or lifts it above one more placed box, so this ends
    for (let guard = 0; guard <= placed.length; guard++) {
      const moved = { left: b.left, right: b.right, top: b.top - shift, bottom: b.bottom - shift };
      const hit = placed.find((p) => overlaps(moved, p));
      if (!hit) break;
      shift += moved.bottom - (hit.top - gapPx);
    }
    shifts.set(b.id, shift);
    placed.push({ id: b.id, left: b.left, right: b.right, top: b.top - shift, bottom: b.bottom - shift });
  }
  return shifts;
}

/**
 * The screen box of a tag anchored at its bottom centre (world point p, world size w x h) and the
 * size of one screen px in world units at its depth; null when it is behind the camera.
 */
export function screenBox(id: string, p: THREE.Vector3, w: number, h: number, cam: THREE.PerspectiveCamera, viewW: number, viewH: number): { box: LabelBox; worldPerPx: number } | null {
  const depth = -p.clone().applyMatrix4(cam.matrixWorldInverse).z;
  if (!(depth > cam.near)) return null;
  const ndc = p.clone().project(cam);
  const x = ((ndc.x + 1) / 2) * viewW;
  const y = ((1 - ndc.y) / 2) * viewH;
  const worldPerPx = (2 * depth * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / cam.zoom / viewH;
  const wPx = w / worldPerPx;
  const hPx = h / worldPerPx;
  return { box: { id, left: x - wPx / 2, right: x + wPx / 2, top: y - hPx, bottom: y }, worldPerPx };
}

/** Whether a sample's tag is hidden: it rests in the bin and is neither the newest arrival there nor hovered. */
export function tagHidden(id: string, restingInBin: boolean, newestInBin: string | null, hovered: string | null): boolean {
  return restingInBin && id !== newestInBin && id !== hovered;
}

/** Remembers the order samples came to rest in the bin; samples already there at the first look count in list order. */
export class BinArrivals {
  private seq = new Map<string, number>();
  private next = 0;

  /** Feed every sample once per frame (list order); returns the newest arrival still in the bin, or null. */
  update(entries: ReadonlyArray<{ id: string; inBin: boolean }>): string | null {
    const seen = new Set<string>();
    for (const e of entries) {
      seen.add(e.id);
      if (!e.inBin) this.seq.delete(e.id);
      else if (!this.seq.has(e.id)) this.seq.set(e.id, ++this.next);
    }
    for (const id of [...this.seq.keys()]) if (!seen.has(id)) this.seq.delete(id);
    let newest: string | null = null;
    let best = -Infinity;
    for (const [id, n] of this.seq) {
      if (n > best) {
        best = n;
        newest = id;
      }
    }
    return newest;
  }
}

export interface PlacedTag {
  id: string;
  sprite: THREE.Sprite;
}

/**
 * The order tags are placed in: sample tags in registry order, each followed by the extra tags that
 * belong to it (sprite.userData.tagAfter names the sample), then the remaining extra tags. A tag
 * placed right after its sample's tag stays next to it when other tags are staggered.
 */
export function orderTags(sampleTags: readonly PlacedTag[], extra: readonly THREE.Sprite[]): PlacedTag[] {
  const out: PlacedTag[] = [];
  const used = new Set<THREE.Sprite>();
  for (const t of sampleTags) {
    out.push(t);
    for (const s of extra) {
      if (!used.has(s) && s.userData.tagAfter === t.id) {
        used.add(s);
        out.push({ id: s.uuid, sprite: s });
      }
    }
  }
  for (const s of extra) if (!used.has(s)) out.push({ id: s.uuid, sprite: s });
  return out;
}

/** Eases each tag toward its staggered height (a few frames), so tags do not jump while the view orbits. */
export class LabelStagger {
  private shifts = new Map<string, number>();
  private v = new THREE.Vector3();

  /** Lay out the visible tags (in order) for this frame; dt in seconds (0 = jump to the target). */
  apply(tags: readonly PlacedTag[], cam: THREE.PerspectiveCamera, viewW: number, viewH: number, dt: number): Map<string, number> {
    cam.updateMatrixWorld();
    const metrics: Array<{ tag: PlacedTag; hPx: number }> = [];
    const boxes: LabelBox[] = [];
    for (const tag of tags) {
      if (!tag.sprite.visible) continue;
      const sb = screenBox(tag.id, tag.sprite.getWorldPosition(this.v), tag.sprite.scale.x, tag.sprite.scale.y, cam, viewW, viewH);
      if (!sb) continue;
      metrics.push({ tag, hPx: tag.sprite.scale.y / sb.worldPerPx });
      boxes.push(sb.box);
    }
    const targets = staggerUp(boxes);
    const k = dt > 0 ? Math.min(1, dt * 14) : 1;
    const next = new Map<string, number>();
    for (const { tag, hPx } of metrics) {
      const target = targets.get(tag.id) ?? 0;
      const prev = this.shifts.get(tag.id);
      const shift = prev === undefined ? target : prev + (target - prev) * k;
      next.set(tag.id, shift);
      // the sprite is drawn with its anchor at center: -1 lifts it by one full tag height on screen
      tag.sprite.center.y = shift > 0 && hPx > 0 ? -shift / hPx : 0;
    }
    for (const tag of tags) if (!next.has(tag.id)) tag.sprite.center.y = 0;
    this.shifts = next;
    return next;
  }
}
