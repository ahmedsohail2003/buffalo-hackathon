// The three.js bay: one scene, two renderers.
//  - viewer: fills the Bay pane, renders layers 0 and 1 (bay + space decoration), gentle orbit/zoom
//  - bay camera: hidden 768x768 renderer (preserveDrawingBuffer) for BayApi.capture(), layer 0 only
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { FrameCapture } from '../contracts';
import type { ArmRigParts, BayCore } from '../app/bayTypes';
import type { SceneLink } from '../app/runtime';
import { BAY_CAPTURE_SIZE, type BayCameraModel } from './bayCamera';
import { buildContainment, buildDeck } from './deck';
import { VIEW_ONLY, buildSpaceEnvironment, type SpaceEnvironment } from './environment';
import { onSceneHooksChange, registeredSceneHooks, type SceneHook } from './registry';
import { SampleLayer } from './samples';

const MARS_URL = `${import.meta.env.BASE_URL}assets/space/mars_1024.jpg`;
const ESTOP_TINT = new THREE.Color('#ef4444');
/** live preview refresh of the bay camera canvas, ms */
const PREVIEW_MS = 500;
const VIEW_HOME = { pos: new THREE.Vector3(-0.36, -0.88, 0.47), target: new THREE.Vector3(0.03, -0.1, 0.08) };

interface TintSlot {
  mat: THREE.MeshStandardMaterial;
  emissive: THREE.Color;
  intensity: number;
}

export class BayView implements SceneLink {
  readonly scene = new THREE.Scene();
  readonly root = new THREE.Group();
  readonly viewerCam: THREE.PerspectiveCamera;
  readonly viewer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  private bayRenderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private env: SpaceEnvironment;
  private samples: SampleLayer;
  private rig: ArmRigParts;
  private tcp = new THREE.Matrix4();
  private tcpMarker: THREE.Group;
  private plumb: THREE.Line;
  private tint: TintSlot[] = [];
  private tinted = false;
  private hooks = new Map<SceneHook, { update(): void; dispose?(): void }>();
  private offs: (() => void)[] = [];
  private lastNow = 0;
  private lastBayRender = -Infinity;
  /** the bay camera's own canvas (768x768): the UI shows it as a live preview */
  readonly bayCanvas: HTMLCanvasElement;

  constructor(private core: BayCore, private bayCam: BayCameraModel) {
    const scene = this.scene;
    this.root.name = 'bay-root';
    scene.add(this.root);

    // ---- lights: key and fill on layer 0 (both cameras); the rim light is decoration (layer 1)
    const hemi = new THREE.HemisphereLight('#e8f0ff', '#39414f', 1.15);
    hemi.position.set(0, 0, 1);
    const key = new THREE.DirectionalLight('#ffffff', 2.3);
    key.position.set(-0.45, -0.75, 1.35);
    key.target.position.set(0.02, -0.12, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = -0.6;
    sc.right = 0.6;
    sc.top = 0.6;
    sc.bottom = -0.6;
    sc.near = 0.1;
    sc.far = 3.5;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.004;
    key.shadow.radius = 4;
    const fill = new THREE.DirectionalLight('#dbe6ff', 0.55);
    fill.position.set(0.9, -0.25, 0.55);
    this.root.add(hemi, key, key.target, fill);

    // ---- bay contents (layer 0)
    this.root.add(buildDeck(core.layout, bayCam.deckFootprint()));
    this.root.add(buildContainment(core.layout));
    this.samples = new SampleLayer(core.samples);
    this.root.add(this.samples.group);
    this.rig = core.rig.build();
    for (const b of this.rig.bodies) {
      b.object.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const own = mats.map((m) => {
          const c = m.clone();
          if ((c as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
            const sm = c as THREE.MeshStandardMaterial;
            this.tint.push({ mat: sm, emissive: sm.emissive.clone(), intensity: sm.emissiveIntensity });
          }
          return c;
        });
        mesh.material = Array.isArray(mesh.material) ? own : own[0]!;
      });
      this.root.add(b.object);
    }

    // ---- viewer-only overlays: tool-centre marker and a plumb line to the deck
    this.tcpMarker = new THREE.Group();
    const cyan = new THREE.MeshBasicMaterial({ color: '#38bdf8', transparent: true, opacity: 0.9, depthTest: false });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.007, 0.0012, 8, 40), cyan);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.0022, 12, 8), cyan);
    ring.renderOrder = dot.renderOrder = 10;
    this.tcpMarker.add(ring, dot);
    this.tcpMarker.traverse((o) => o.layers.set(VIEW_ONLY));
    this.root.add(this.tcpMarker);
    const plumbGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
    this.plumb = new THREE.Line(plumbGeom, new THREE.LineDashedMaterial({ color: '#38bdf8', dashSize: 0.006, gapSize: 0.005, transparent: true, opacity: 0.75 }));
    this.plumb.layers.set(VIEW_ONLY);
    this.root.add(this.plumb);

    // ---- space decoration (layer 1 only)
    this.env = buildSpaceEnvironment(core.layout, MARS_URL);
    this.root.add(this.env.group);

    // ---- viewer
    this.viewerCam = new THREE.PerspectiveCamera(36, 16 / 10, 0.01, 40);
    this.viewerCam.up.set(0, 0, 1);
    this.viewerCam.position.copy(VIEW_HOME.pos);
    this.viewerCam.layers.enable(VIEW_ONLY);
    this.viewer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.viewer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.viewer.setClearColor('#05070d', 1);
    this.viewer.toneMapping = THREE.ACESFilmicToneMapping;
    this.viewer.toneMappingExposure = 1.05;
    this.viewer.shadowMap.enabled = true;
    this.viewer.shadowMap.type = THREE.PCFShadowMap;
    this.canvas = this.viewer.domElement;
    this.canvas.setAttribute('aria-label', 'Bay view: the simulated arm, samples and containment bin');
    this.canvas.setAttribute('role', 'img');
    this.controls = new OrbitControls(this.viewerCam, this.canvas);
    this.controls.target.copy(VIEW_HOME.target);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 0.7;
    this.controls.minDistance = 0.45;
    this.controls.maxDistance = 2.2;
    this.controls.minPolarAngle = 0.2;
    this.controls.maxPolarAngle = 1.36;
    this.controls.update();
    this.canvas.addEventListener('dblclick', () => this.resetView());

    // ---- bay camera renderer (offscreen)
    this.bayRenderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.bayRenderer.setPixelRatio(1);
    this.bayRenderer.setSize(BAY_CAPTURE_SIZE, BAY_CAPTURE_SIZE, false);
    this.bayRenderer.setClearColor('#2f3540', 1);
    this.bayRenderer.toneMapping = THREE.NeutralToneMapping;
    this.bayRenderer.toneMappingExposure = 1.0;
    this.bayRenderer.shadowMap.enabled = true;
    this.bayRenderer.shadowMap.type = THREE.PCFShadowMap;
    this.bayCanvas = this.bayRenderer.domElement;
    this.bayCanvas.setAttribute('role', 'img');
    this.bayCanvas.setAttribute('aria-label', 'Live bay camera: the fixed view Gemini sees');

    // ---- scene hooks (teleop marker and friends)
    for (const h of registeredSceneHooks()) this.addHook(h);
    this.offs.push(onSceneHooksChange((h, added) => (added ? this.addHook(h) : this.removeHook(h))));
  }

  private addHook(h: SceneHook): void {
    if (this.hooks.has(h)) return;
    try {
      this.hooks.set(h, h({ scene: this.scene, root: this.root, viewerCam: this.viewerCam }));
    } catch (err) {
      console.error('[scene] scene hook failed to start', err);
    }
  }

  private removeHook(h: SceneHook): void {
    const inst = this.hooks.get(h);
    this.hooks.delete(h);
    try {
      inst?.dispose?.();
    } catch (err) {
      console.error('[scene] scene hook failed to dispose', err);
    }
  }

  resetView(): void {
    this.viewerCam.position.copy(VIEW_HOME.pos);
    this.controls.target.copy(VIEW_HOME.target);
    this.controls.update();
  }

  setSize(w: number, h: number): void {
    if (w < 2 || h < 2) return;
    this.viewer.setSize(w, h, false);
    this.viewerCam.aspect = w / h;
    this.viewerCam.updateProjectionMatrix();
  }

  /** Pose the arm, samples and overlays from the core. */
  sync(now: number = performance.now()): void {
    const snap = this.core.arm.snapshot();
    this.rig.pose(snap, this.tcp);
    const estop = this.core.gate.state() === 'ESTOPPED';
    if (estop !== this.tinted) {
      this.tinted = estop;
      for (const t of this.tint) {
        if (estop) {
          t.mat.emissive.copy(ESTOP_TINT);
          t.mat.emissiveIntensity = 0.42;
        } else {
          t.mat.emissive.copy(t.emissive);
          t.mat.emissiveIntensity = t.intensity;
        }
      }
    }
    this.samples.sync(this.tcp, now);
    const p = new THREE.Vector3().setFromMatrixPosition(this.tcp);
    this.tcpMarker.position.copy(p);
    this.plumb.position.copy(p);
    this.plumb.scale.set(1, 1, Math.max(0.001, p.z - 0.0005));
    this.plumb.computeLineDistances();
  }

  /** SceneLink: called by the runtime every tick. */
  frame(dt: number, now: number): void {
    this.lastNow = now;
    this.controls.update();
    this.sync(now);
    this.env.update(dt);
    for (const inst of this.hooks.values()) {
      try {
        inst.update();
      } catch (err) {
        console.error('[scene] scene hook update failed', err);
      }
    }
    this.viewer.render(this.scene, this.viewerCam);
    if (now - this.lastBayRender > PREVIEW_MS && this.bayCanvas.isConnected) this.renderBay(now);
  }

  private renderBay(now: number): void {
    this.lastBayRender = now;
    this.bayRenderer.render(this.scene, this.bayCam.camera);
  }

  /** SceneLink: render the fixed bay camera to a square JPEG (what Gemini sees). */
  capture(): FrameCapture {
    const now = this.lastNow || performance.now();
    this.sync(now);
    this.renderBay(now);
    const url = this.bayRenderer.domElement.toDataURL('image/jpeg', 0.9);
    return { jpegB64: url.slice(url.indexOf(',') + 1), w: BAY_CAPTURE_SIZE, h: BAY_CAPTURE_SIZE, t: Date.now() };
  }

  dispose(): void {
    this.offs.forEach((off) => off());
    for (const h of [...this.hooks.keys()]) this.removeHook(h);
    this.samples.dispose();
    this.controls.dispose();
    this.viewer.dispose();
    this.bayRenderer.dispose();
  }
}
