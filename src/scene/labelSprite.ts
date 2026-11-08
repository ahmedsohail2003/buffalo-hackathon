// Name tags for the viewer: a dark rounded tag drawn on a canvas, as a sprite on the viewer-only
// layer (the bay camera never sees it), anchored at its bottom centre. Needs a DOM canvas.
import * as THREE from 'three';
import { VIEW_ONLY } from './environment';

/** World height of a name tag, m. */
export const LABEL_H = 0.013;
/** A sample's name tag floats this far above the sample's top, m. */
export const LABEL_GAP = 0.016;

export interface LabelStyle {
  /** border colour */
  stroke?: string;
  /** text colour */
  color?: string;
  /** world height, m (default LABEL_H) */
  height?: number;
  /** font weight */
  weight?: number;
}

export function makeLabelSprite(text: string, style: LabelStyle = {}): THREE.Sprite {
  const font = `${style.weight ?? 600} 40px Inter, system-ui, sans-serif`;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 44;
  c.width = w;
  c.height = 64;
  ctx.font = font;
  ctx.fillStyle = 'rgba(8,13,24,0.78)';
  ctx.beginPath();
  ctx.roundRect(2, 2, w - 4, 60, 30);
  ctx.fill();
  ctx.strokeStyle = style.stroke ?? 'rgba(56,189,248,0.55)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = style.color ?? '#e2e8f0';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 22, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  const h = style.height ?? LABEL_H;
  sprite.scale.set((h * w) / 64, h, 1);
  sprite.center.set(0.5, 0);
  sprite.layers.set(VIEW_ONLY);
  sprite.renderOrder = 5;
  return sprite;
}

export function disposeLabelSprite(s: THREE.Sprite): void {
  s.material.map?.dispose();
  s.material.dispose();
}
