// three.js view of the work cell (PLAN.md A4). Simplified look: standard materials,
// hemisphere + one directional light, no shadows, no tone mapping, sRGB output.
// Two renderers share one scene: the viewer (this pane) and a hidden 768×768
// snapshot renderer for the fixed cell camera (what Gemini Robotics-ER sees).
// Ported from repos/ahmedsohail2003.github.io/workcell/index.html (arm tree, tray,
// viewer camera placement). Meshes: MuJoCo Menagerie trs_so_arm100 (Apache-2.0).

import { useEffect, useRef, useState } from 'react';
import {
  Scene,
  Group,
  Mesh,
  Color,
  Object3D,
  Vector3,
  WebGLRenderer,
  PerspectiveCamera,
  HemisphereLight,
  DirectionalLight,
  MeshStandardMaterial,
  PlaneGeometry,
  BoxGeometry,
  CylinderGeometry,
  SphereGeometry,
  CanvasTexture,
  TextureLoader,
  SRGBColorSpace,
  NoToneMapping,
  RepeatWrapping,
} from 'three';
import type { ArmData, ArmGeom } from '../arm/armData';
import { ArmModel } from '../arm/armModel';
import { decodeAllMeshes } from '../arm/armMeshes';
import type { ArmController } from '../arm/controller';
import type { ObjectRegistry } from '../cell/objects';
import type { CobotCell } from '../cell/cellSim';
import type { SceneObject, FrameCapture, Vec3 } from '../contracts';
import { createCellCam, projectMujoco, unprojectER, CELL_FRAME_PX } from '../arm/cellCamera';
import { setSceneApi } from '../app/refs';
import { startLoop } from '../app/loop';

export interface CellSceneProps {
  data: ArmData;
  arm: ArmController;
  objects: ObjectRegistry;
  getCell: () => CobotCell | null;
}

interface ObjMesh {
  mesh: Mesh;
  shape: SceneObject['shape'];
  dims: string;
  held: boolean;
  /** data URL of the print currently applied (or being loaded) */
  texture?: string;
}

interface SceneState {
  renderer: WebGLRenderer;
  snap: WebGLRenderer;
  snapCanvas: HTMLCanvasElement;
  scene: Scene;
  root: Group;
  model: ArmModel;
  viewerCam: PerspectiveCamera;
  cellCam: PerspectiveCamera;
  tcpMesh: Mesh;
  objMeshes: Map<string, ObjMesh>;
  matWhite: MeshStandardMaterial;
  matBlack: MeshStandardMaterial;
  stopLoop: () => void;
  ro: ResizeObserver | null;
  estopTint: boolean;
}

const WHITE = 0xdedede;
const BLACK = 0x222222;
const RED_WHITE = 0xe06060;
const RED_BLACK = 0x5a1f1f;

/** 1.2 m floor texture with a 1 cm grid (ER scale cue) and 5 cm majors. */
function makeFloorTexture(): CanvasTexture {
  const px = 1200; // 1 px = 1 mm
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#c9ccd2';
  ctx.fillRect(0, 0, px, px);
  for (let i = 0; i <= px; i += 10) {
    const major = i % 50 === 0;
    ctx.strokeStyle = major ? 'rgba(70,76,90,0.55)' : 'rgba(70,76,90,0.18)';
    ctx.lineWidth = major ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(i + 0.5, 0);
    ctx.lineTo(i + 0.5, px);
    ctx.moveTo(0, i + 0.5);
    ctx.lineTo(px, i + 0.5);
    ctx.stroke();
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function makeRenderer(canvas: HTMLCanvasElement, preserve: boolean): WebGLRenderer {
  const r = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: preserve, powerPreference: 'low-power' });
  r.outputColorSpace = SRGBColorSpace;
  r.toneMapping = NoToneMapping;
  r.shadowMap.enabled = false;
  return r;
}

function objectGeometry(o: SceneObject) {
  const { w, d, h } = o.dims;
  if (o.shape === 'box') return new BoxGeometry(w, d, h);
  if (o.shape === 'cylinder') return new CylinderGeometry(w / 2, w / 2, h, 32);
  return new SphereGeometry(w / 2, 24, 16);
}

export function CellScene({ data, arm, objects, getCell }: CellSceneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<SceneState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Read the cell through a ref so a changing callback identity never remounts the renderers.
  const getCellRef = useRef(getCell);
  getCellRef.current = getCell;

  useEffect(() => {
    if (stateRef.current) return; // StrictMode double-mount guard
    const host = hostRef.current;
    if (!host) return;
    // A fresh canvas per mount: StrictMode unmounts/remounts, and a canvas whose
    // context was force-lost cannot host a second WebGLRenderer.
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', '3D SO-ARM100 work cell');
    host.appendChild(canvas);

    try {
      mount(canvas);
    } catch (e) {
      canvas.remove();
      setFailed(e instanceof Error ? e.message : String(e));
      return;
    }
    return () => {
      const s = stateRef.current;
      if (!s) return;
      s.stopLoop();
      s.ro?.disconnect();
      setSceneApi(null);
      s.renderer.dispose();
      s.renderer.forceContextLoss();
      s.snap.dispose();
      s.snap.forceContextLoss();
      stateRef.current = null;
      canvas.remove();
    };

    function mount(canvas: HTMLCanvasElement) {
    const scene = new Scene();
    scene.background = new Color(0x2a3040);
    const root = new Group();
    root.rotation.x = -Math.PI / 2;
    scene.add(root);

    const matWhite = new MeshStandardMaterial({ color: WHITE, roughness: 0.6, metalness: 0.02 });
    const matBlack = new MeshStandardMaterial({ color: BLACK, roughness: 0.55, metalness: 0.1 });
    const geoms = decodeAllMeshes(data);
    const geomFactory = (g: ArmGeom): Object3D => new Mesh(geoms[g.mesh], g.mat === 'white' ? matWhite : matBlack);
    const model = new ArmModel(data, { geom: geomFactory });
    scene.add(model.root); // model.root already carries the −90° x rotation

    scene.add(new HemisphereLight(0xffffff, 0x8a8f8a, 0.55));
    const sun = new DirectionalLight(0xffffff, 1.3);
    sun.position.set(0.8, 1.6, 1.0);
    scene.add(sun);

    const floor = new Mesh(new PlaneGeometry(1.2, 1.2), new MeshStandardMaterial({ map: makeFloorTexture(), roughness: 0.95, metalness: 0 }));
    floor.position.set(0, 0, -0.0005);
    root.add(floor);

    const matTray = new MeshStandardMaterial({ color: 0x3359a6, roughness: 0.55 });
    const tray = new Group();
    tray.position.set(data.tray[0], data.tray[1], data.tray[2]);
    (
      [
        [0.09, 0.09, 0.006, 0, 0, 0.003],
        [0.09, 0.008, 0.024, 0, 0.041, 0.012],
        [0.09, 0.008, 0.024, 0, -0.041, 0.012],
        [0.008, 0.09, 0.024, 0.041, 0, 0.012],
        [0.008, 0.09, 0.024, -0.041, 0, 0.012],
      ] as const
    ).forEach((s) => {
      const m = new Mesh(new BoxGeometry(s[0], s[1], s[2]), matTray);
      m.position.set(s[3], s[4], s[5]);
      tray.add(m);
    });
    root.add(tray);

    const tcpMesh = new Mesh(new SphereGeometry(0.004, 12, 8), new MeshStandardMaterial({ color: 0x7dd3fc, emissive: 0x1e5a7a }));
    root.add(tcpMesh);

    const viewerCam = new PerspectiveCamera(30, 1, 0.05, 10);
    {
      const target = new Vector3(-0.03, 0.07, 0.19);
      const az = 0.62;
      const el = 0.46;
      const dist = 0.86;
      viewerCam.position.set(
        target.x + dist * Math.cos(el) * Math.sin(az),
        target.y + dist * Math.sin(el),
        target.z + dist * Math.cos(el) * Math.cos(az),
      );
      viewerCam.lookAt(target);
    }
    const cellCam = createCellCam();

    const renderer = makeRenderer(canvas, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const snapCanvas = document.createElement('canvas');
    snapCanvas.width = CELL_FRAME_PX;
    snapCanvas.height = CELL_FRAME_PX;
    const snap = makeRenderer(snapCanvas, true);
    snap.setPixelRatio(1);
    snap.setSize(CELL_FRAME_PX, CELL_FRAME_PX, false);

    const st: SceneState = {
      renderer,
      snap,
      snapCanvas,
      scene,
      root,
      model,
      viewerCam,
      cellCam,
      tcpMesh,
      objMeshes: new Map(),
      matWhite,
      matBlack,
      stopLoop: () => undefined,
      ro: null,
      estopTint: false,
    };
    stateRef.current = st;
    if (import.meta.env.DEV) (window as unknown as { __scene?: SceneState }).__scene = st;

    const resize = () => {
      const el = canvas.parentElement;
      if (!el) return;
      const w = Math.max(1, el.clientWidth);
      const h = Math.max(1, el.clientHeight);
      renderer.setSize(w, h, false);
      viewerCam.aspect = w / h;
      viewerCam.updateProjectionMatrix();
    };
    resize();
    if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
      st.ro = new ResizeObserver(resize);
      st.ro.observe(canvas.parentElement);
    }

    const syncObjects = () => {
      const seen = new Set<string>();
      for (const o of objects.list()) {
        seen.add(o.id);
        const dimsKey = `${o.shape}:${o.dims.w}:${o.dims.d}:${o.dims.h}`;
        let om = st.objMeshes.get(o.id);
        if (om && om.dims !== dimsKey) {
          om.mesh.removeFromParent();
          om.mesh.geometry.dispose();
          st.objMeshes.delete(o.id);
          om = undefined;
        }
        if (!om) {
          const mesh = new Mesh(objectGeometry(o), new MeshStandardMaterial({ color: new Color(o.color), roughness: 0.5 }));
          if (o.shape === 'cylinder') mesh.rotation.x = Math.PI / 2; // three cylinder axis is y; root z is up
          mesh.name = o.id;
          root.add(mesh);
          om = { mesh, shape: o.shape, dims: dimsKey, held: false };
          st.objMeshes.set(o.id, om);
        }
        if ((o.texture ?? undefined) !== om.texture) {
          // Generated print (Nano Banana) on the part faces: load once per data URL, tint to white so the image shows true.
          om.texture = o.texture;
          const mat = om.mesh.material as MeshStandardMaterial;
          if (o.texture) {
            const url = o.texture;
            new TextureLoader().load(url, (tex) => {
              if (om!.texture !== url) { tex.dispose(); return; }
              tex.colorSpace = SRGBColorSpace;
              mat.map?.dispose();
              mat.map = tex;
              mat.color.set(0xffffff);
              mat.needsUpdate = true;
            });
          } else {
            mat.map?.dispose();
            mat.map = null;
            mat.color.set(new Color(o.color));
            mat.needsUpdate = true;
          }
        }
        if (o.held && !om.held) {
          model.nodes.Fixed_Jaw.joint.attach(om.mesh);
          om.held = true;
        } else if (!o.held && om.held) {
          root.attach(om.mesh);
          om.held = false;
        }
        if (!om.held) {
          om.mesh.position.set(o.pos[0], o.pos[1], o.pos[2]);
          if (o.shape === 'cylinder') om.mesh.rotation.set(Math.PI / 2, o.yaw, 0);
          else om.mesh.rotation.set(0, 0, o.yaw);
        }
      }
      for (const [id, om] of st.objMeshes) {
        if (!seen.has(id)) {
          om.mesh.removeFromParent();
          om.mesh.geometry.dispose();
          st.objMeshes.delete(id);
        }
      }
    };

    const syncScene = () => {
      model.setPose(arm.q);
      const tcp = arm.tcp();
      tcpMesh.position.set(tcp[0], tcp[1], tcp[2]);
      syncObjects();
      const estop = getCellRef.current()?.state === 'ESTOPPED';
      if (estop !== st.estopTint) {
        st.estopTint = estop;
        matWhite.color.set(estop ? RED_WHITE : WHITE);
        matBlack.color.set(estop ? RED_BLACK : BLACK);
      }
      root.updateMatrixWorld(true);
      model.root.updateMatrixWorld(true);
    };

    const capture = (): FrameCapture => {
      syncScene();
      snap.render(scene, cellCam);
      const url = snapCanvas.toDataURL('image/jpeg', 0.85);
      return { jpegB64: url.slice(url.indexOf(',') + 1), w: CELL_FRAME_PX, h: CELL_FRAME_PX, t: performance.now() };
    };

    setSceneApi({
      capture,
      projectMujoco: (p: Vec3) => projectMujoco(cellCam, p),
      unprojectER: (yx, z) => unprojectER(cellCam, yx, z),
      syncScene,
    });

    st.stopLoop = startLoop(() => {
      syncScene();
      renderer.render(scene, viewerCam);
    });
    }
  }, [data, arm, objects]);

  return (
    <div ref={hostRef} className="cell-scene-host">
      {failed && <div className="cell-loading">3D view unavailable — {failed}</div>}
    </div>
  );
}
