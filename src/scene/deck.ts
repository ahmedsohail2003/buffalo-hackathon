// The bay deck and the containment bin. Both are on layer 0, so the bay camera sees them.
// The deck stays light, with a 1 cm grid and 5 cm majors as a scale cue; seams, rivets and hazard
// stripes are drawn only outside the bay camera's footprint, so its image stays clean.
import * as THREE from 'three';
import type { BayLayout } from '../app/bayTypes';
import { mulberry32 } from './environment';

const TEX_PX = 2048;
export const DECK_COLOR = '#c4c9d0';

function insetPolygon(poly: [number, number][], margin: number): [number, number][] {
  const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length;
  const cy = poly.reduce((a, p) => a + p[1], 0) / poly.length;
  return poly.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return [x + (dx / len) * margin, y + (dy / len) * margin];
  });
}

/** Deck texture: brushed steel, grid, and decoration clipped to stay outside the footprint. */
function makeDeckTexture(layout: BayLayout, footprint: [number, number][]): THREE.CanvasTexture {
  const S = layout.deckSize;
  const [cx, cy] = layout.deckCenter;
  const pxPerM = TEX_PX / S;
  const X = (x: number) => (x - (cx - S / 2)) * pxPerM;
  const Y = (y: number) => (1 - (y - (cy - S / 2)) / S) * TEX_PX;
  const c = document.createElement('canvas');
  c.width = c.height = TEX_PX;
  const ctx = c.getContext('2d')!;

  // brushed steel
  ctx.fillStyle = DECK_COLOR;
  ctx.fillRect(0, 0, TEX_PX, TEX_PX);
  const rnd = mulberry32(11);
  for (let i = 0; i < 9000; i++) {
    const y = rnd() * TEX_PX;
    const x = rnd() * TEX_PX;
    const len = 40 + rnd() * 420;
    const light = rnd() > 0.5;
    ctx.strokeStyle = light ? `rgba(255,255,255,${0.025 + rnd() * 0.05})` : `rgba(40,48,60,${0.015 + rnd() * 0.035})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + (rnd() - 0.5) * 2);
    ctx.stroke();
  }

  // 1 cm grid with 5 cm majors, aligned to the bay frame (the arm base sits on a major crossing)
  const x0 = Math.ceil((cx - S / 2) * 100);
  const x1 = Math.floor((cx + S / 2) * 100);
  const y0 = Math.ceil((cy - S / 2) * 100);
  const y1 = Math.floor((cy + S / 2) * 100);
  const line = (major: boolean) => {
    ctx.strokeStyle = major ? 'rgba(46,56,76,0.42)' : 'rgba(46,56,76,0.17)';
    ctx.lineWidth = major ? 2.2 : 1.1;
  };
  for (const major of [false, true]) {
    line(major);
    ctx.beginPath();
    for (let i = x0; i <= x1; i++) {
      if ((i % 5 === 0) !== major) continue;
      const px = X(i / 100);
      ctx.moveTo(px, 0);
      ctx.lineTo(px, TEX_PX);
    }
    for (let j = y0; j <= y1; j++) {
      if ((j % 5 === 0) !== major) continue;
      const py = Y(j / 100);
      ctx.moveTo(0, py);
      ctx.lineTo(TEX_PX, py);
    }
    ctx.stroke();
  }

  // decoration, clipped to outside the bay camera footprint (plus a 2 cm margin)
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, TEX_PX, TEX_PX);
  const fp = insetPolygon(footprint, 0.02);
  fp.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(X(x), Y(y)) : ctx.lineTo(X(x), Y(y))));
  ctx.closePath();
  ctx.clip('evenodd');

  // plate seams every 30 cm, with a highlight edge
  const seamStep = 0.3;
  for (let k = Math.ceil((cx - S / 2) / seamStep); k * seamStep < cx + S / 2; k++) {
    const px = X(k * seamStep);
    ctx.fillStyle = 'rgba(30,36,48,0.55)';
    ctx.fillRect(px - 2, 0, 4, TEX_PX);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(px + 2, 0, 1.5, TEX_PX);
  }
  for (let k = Math.ceil((cy - S / 2) / seamStep); k * seamStep < cy + S / 2; k++) {
    const py = Y(k * seamStep);
    ctx.fillStyle = 'rgba(30,36,48,0.55)';
    ctx.fillRect(0, py - 2, TEX_PX, 4);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(0, py + 2, TEX_PX, 1.5);
  }
  // rivets near every seam crossing
  for (let i = Math.ceil((cx - S / 2) / seamStep); i * seamStep <= cx + S / 2; i++) {
    for (let j = Math.ceil((cy - S / 2) / seamStep); j * seamStep <= cy + S / 2; j++) {
      for (const [dx, dy] of [
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ] as const) {
        const px = X(i * seamStep) + dx * 22;
        const py = Y(j * seamStep) + dy * 22;
        const grad = ctx.createRadialGradient(px - 1.5, py - 1.5, 0.5, px, py, 6);
        grad.addColorStop(0, 'rgba(255,255,255,0.9)');
        grad.addColorStop(0.5, 'rgba(150,158,170,0.9)');
        grad.addColorStop(1, 'rgba(40,46,58,0.8)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(px, py, 5.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  // hazard border: a 3 cm band of amber and black stripes around the plate edge
  const band = 0.03 * pxPerM;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, TEX_PX, TEX_PX);
  ctx.rect(band, band, TEX_PX - 2 * band, TEX_PX - 2 * band);
  ctx.clip('evenodd');
  ctx.fillStyle = '#1b1d22';
  ctx.fillRect(0, 0, TEX_PX, TEX_PX);
  ctx.strokeStyle = '#e8a50c';
  ctx.lineWidth = band * 0.5;
  for (let i = -TEX_PX; i < TEX_PX * 2; i += band * 1.4) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + TEX_PX, TEX_PX);
    ctx.stroke();
  }
  ctx.restore();
  // stencil, near the operator edge
  ctx.fillStyle = 'rgba(40,48,62,0.55)';
  ctx.font = `600 ${Math.round(0.022 * pxPerM)}px Inter, system-ui, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('DECK A  ·  LOAD 2 KG MAX', band + 0.03 * pxPerM, TEX_PX - band - 0.025 * pxPerM);
  ctx.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function buildDeck(layout: BayLayout, footprint: [number, number][]): THREE.Group {
  const g = new THREE.Group();
  g.name = 'deck';
  const S = layout.deckSize;
  const [cx, cy] = layout.deckCenter;
  const top = new THREE.Mesh(
    new THREE.PlaneGeometry(S, S),
    new THREE.MeshStandardMaterial({ map: makeDeckTexture(layout, footprint), roughness: 0.62, metalness: 0.25 }),
  );
  top.position.set(cx, cy, 0);
  top.receiveShadow = true;
  const slab = new THREE.Mesh(new THREE.BoxGeometry(S, S, 0.014), new THREE.MeshStandardMaterial({ color: '#7d8590', roughness: 0.5, metalness: 0.5 }));
  slab.position.set(cx, cy, -0.0072);
  g.add(top, slab);
  return g;
}

function makeLabelTexture(text: string, wPx: number, hPx: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = wPx;
  c.height = hPx;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#161b24';
  ctx.fillRect(0, 0, wPx, hPx);
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = hPx * 0.08;
  ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, wPx - ctx.lineWidth, hPx - ctx.lineWidth);
  ctx.fillStyle = '#fbbf24';
  ctx.font = `700 ${Math.round(hPx * 0.5)}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, wPx / 2, hPx * 0.54, wPx * 0.9);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Amber anodized containment bin with a dark floor and a 'SAMPLE CONTAINMENT' plate in front. */
export function buildContainment(layout: BayLayout): THREE.Group {
  const { x, y, innerW, innerD, wallH, wallT } = layout.containment;
  const g = new THREE.Group();
  g.name = 'containment';
  const amber = new THREE.MeshStandardMaterial({ color: '#d98a12', roughness: 0.36, metalness: 0.55 });
  const outerW = innerW + 2 * wallT;
  const outerD = innerD + 2 * wallT;
  const wall = (w: number, d: number, px: number, py: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, d, wallH), amber);
    m.position.set(px, py, wallH / 2);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  };
  wall(outerW, wallT, x, y - innerD / 2 - wallT / 2);
  wall(outerW, wallT, x, y + innerD / 2 + wallT / 2);
  wall(wallT, innerD, x - innerW / 2 - wallT / 2, y);
  wall(wallT, innerD, x + innerW / 2 + wallT / 2, y);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(innerW, innerD, 0.002), new THREE.MeshStandardMaterial({ color: '#1c2129', roughness: 0.85, metalness: 0.2 }));
  floor.position.set(x, y, 0.001);
  floor.receiveShadow = true;
  g.add(floor);

  const labelW = Math.max(outerW + 0.03, 0.1);
  const labelH = 0.016;
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(labelW, labelH),
    new THREE.MeshStandardMaterial({ map: makeLabelTexture('SAMPLE CONTAINMENT', 1024, Math.round((1024 * labelH) / labelW)), roughness: 0.7, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  label.position.set(x, y - outerD / 2 - labelH / 2 - 0.008, 0.0004);
  label.receiveShadow = true;
  g.add(label);
  return g;
}
