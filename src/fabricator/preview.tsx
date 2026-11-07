// Dev-only preview (open /src/fabricator/preview.html under `npm run dev`): every preset built, measured and
// drawn the way the bay will draw it (yaw 0, the jaw axis is local x, shown as a red bar), plus the panel on
// an in-memory bay. Not part of the app bundle.

import { createRoot } from 'react-dom/client';
import { AmbientLight, BoxGeometry, CanvasTexture, Color, DirectionalLight, Group, HemisphereLight, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Scene, SRGBColorSpace, WebGLRenderer } from 'three';
import type { BayApi, Placement, Sample, SampleApi } from '../contracts';
import { FabricatorPanel } from './FabricatorPanel';
import { ensureAssets } from './assets';
import { fabricateProgram, geometryForSample } from './fabricate';
import { materialForSample, PRESETS } from './index';

function grid(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 1000;
  const g = c.getContext('2d')!;
  g.fillStyle = '#c9ccd2';
  g.fillRect(0, 0, 1000, 1000);
  for (let i = 0; i <= 1000; i += 10) {
    g.strokeStyle = i % 50 === 0 ? 'rgba(70,76,90,0.5)' : 'rgba(70,76,90,0.18)';
    g.beginPath(); g.moveTo(i + 0.5, 0); g.lineTo(i + 0.5, 1000); g.moveTo(0, i + 0.5); g.lineTo(1000, i + 0.5); g.stroke();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

function memoryBay(): BayApi {
  const list: Sample[] = [];
  let n = 0;
  const samples: SampleApi = {
    list: () => [...list], get: (id) => list.find((s) => s.id === id),
    createPrimitive: () => ({ ok: false, code: 'UNSUPPORTED', reason: 'preview' }),
    createMesh: (input, by) => {
      const p = input as Placement;
      const s: Sample = { id: `sample_${++n}`, name: input.name, color: input.color, kind: 'mesh', dims: input.dims, pos: [(p.x_mm ?? 60) / 1000, (p.y_mm ?? -200) / 1000, input.dims.h / 2], yaw: 0, held: false, mesh: input.mesh, createdBy: by ?? 'operator' };
      list.push(s);
      return { ok: true, sample: s };
    },
    remove: () => false, reset: () => { list.length = 0; }, onChange: () => () => undefined,
  };
  const ok = async () => ({ ok: true as const, tcp_mm: [0, 0, 0] as [number, number, number], held: null });
  return { samples, arm: { pick: ok, placeAt: ok, placeInContainment: ok, home: ok, servoTo: () => undefined, abortAll: () => undefined, snapshot: () => ({ q: [], tcp: [0, 0, 0], jawOpen: 1, phase: 'idle', heldId: null, busy: false }) },
    gate: { state: () => 'RUNNING', speedFactor: () => 1, waitRunnable: async () => undefined, onChange: () => () => undefined },
    capture: () => ({ jpegB64: '', w: 0, h: 0, t: 0 }), project: () => [0, 0], unproject: () => null };
}

async function main() {
  const view = document.getElementById('view')!;
  const renderer = new WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setSize(view.clientWidth, 820);
  view.appendChild(renderer.domElement);
  const scene = new Scene();
  scene.background = new Color(0x1a2030);
  const root = new Group();
  root.rotation.x = -Math.PI / 2; // z up
  scene.add(root);
  scene.add(new HemisphereLight(0xffffff, 0x8a8f8a, 0.7), new AmbientLight(0xffffff, 0.25));
  const sun = new DirectionalLight(0xffffff, 1.6);
  sun.position.set(0.4, 1.2, 0.8);
  scene.add(sun);
  const deck = new Mesh(new PlaneGeometry(0.5, 0.3), new MeshStandardMaterial({ map: grid(), roughness: 0.95 }));
  root.add(deck);
  const cam = new PerspectiveCamera(36, view.clientWidth / 820, 0.01, 5);
  cam.position.set(0, 0.36, 0.42);
  cam.lookAt(0, 0, 0.01);
  const cols = 5;
  for (const [i, p] of PRESETS.entries()) {
    await ensureAssets(p.program);
    const f = fabricateProgram(p.program, p.source);
    const x = ((i % cols) - (cols - 1) / 2) * 0.085;
    const y = (Math.floor(i / cols) - 1) * 0.085;
    if (!f.ok) {
      const bad = new Mesh(new BoxGeometry(0.004, 0.004, 0.06), new MeshStandardMaterial({ color: 0xef4444 }));
      bad.position.set(x, y, 0.03);
      root.add(bad);
      continue;
    }
    const s: Sample = { id: p.id, name: f.name, color: f.color, kind: 'mesh', dims: f.dims, pos: [x, y, f.dims.h / 2], yaw: 0, held: false, mesh: f.mesh, createdBy: 'preset' };
    const m = new Mesh(geometryForSample(s)!, new MeshStandardMaterial(materialForSample(s)!));
    m.position.set(x, y, f.dims.h / 2);
    root.add(m);
    // jaw axis (local x) at the grip width: two red pads either side of the sample
    for (const sx of [-1, 1]) {
      const pad = new Mesh(new BoxGeometry(0.002, 0.012, 0.012), new MeshStandardMaterial({ color: 0xff3b30, emissive: 0x401010 }));
      pad.position.set(x + sx * (f.dims.w / 2 + 0.002), y, 0.006);
      root.add(pad);
    }
  }
  renderer.render(scene, cam);
  (window as unknown as { __previewReady?: boolean }).__previewReady = true;
  createRoot(document.getElementById('panel')!).render(<FabricatorPanel bay={memoryBay()} log={(t) => console.log(t)} />);
}

void main();
