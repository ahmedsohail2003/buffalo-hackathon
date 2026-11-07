// Deep-space decoration around the bay: starfield, nebula, Mars, a rim light, and a glass bay
// enclosure with glove ports. Everything here is on layer 1, which only the viewer camera renders:
// the fixed bay camera (what Gemini sees) never sees any of it.
import * as THREE from 'three';
import type { BayLayout } from '../app/bayTypes';

/** Layer for decoration only the viewer camera renders. */
export const VIEW_ONLY = 1;

export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function viewOnly<T extends THREE.Object3D>(o: T): T {
  o.traverse((c) => c.layers.set(VIEW_ONLY));
  return o;
}

// ---- Starfield: one draw call ---------------------------------------------------------------

function makeStarfield(n: number, radius: number, seed: number): THREE.Points {
  const rnd = mulberry32(seed);
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const u = rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    pos.set([radius * s * Math.cos(th), radius * s * Math.sin(th), radius * u], i * 3);
    const b = Math.pow(rnd(), 6) * 0.9 + 0.1; // a few bright stars, many faint ones
    c.setHSL(0.58 + (rnd() - 0.5) * 0.22, 0.55, 0.3 + 0.62 * b);
    col.set([c.r, c.g, c.b], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.5, sizeAttenuation: false, vertexColors: true, depthWrite: false, transparent: true, opacity: 0.95 }));
  pts.renderOrder = -2;
  pts.frustumCulled = false;
  return pts;
}

// ---- Nebula on a back-facing sphere ---------------------------------------------------------

const NEBULA_FRAG = /* glsl */ `
varying vec3 vDir;
float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z); }
float fbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p *= 2.02; a *= 0.5; } return s; }
void main(){
  vec3 d = normalize(vDir);
  float w = fbm(d * 1.7);
  float n = fbm(d * 3.0 + w * 2.0);
  float band = exp(-pow(dot(d, normalize(vec3(0.35, -0.2, 1.0))) * 2.4, 2.0));
  vec3 col = vec3(0.006, 0.008, 0.02);
  col += vec3(0.16, 0.05, 0.24) * smoothstep(0.45, 0.85, n) * (0.25 + band);
  col += vec3(0.02, 0.09, 0.2) * smoothstep(0.55, 0.95, w * n * 1.6) * band;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

function makeNebula(radius: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: NEBULA_FRAG,
    }),
  );
  m.renderOrder = -3;
  m.frustumCulled = false;
  return m;
}

// ---- Mars: its own sun direction, so the planet keeps a lit limb whatever the bay lights do ---

const PLANET_VERT = /* glsl */ `
varying vec2 vUv; varying vec3 vNw; varying vec3 vNv;
void main(){
  vUv = uv;
  vNw = normalize(mat3(modelMatrix) * normal);
  vNv = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const PLANET_FRAG = /* glsl */ `
uniform sampler2D map; uniform vec3 sunDir; uniform vec3 hazeColor;
varying vec2 vUv; varying vec3 vNw; varying vec3 vNv;
void main(){
  vec3 albedo = texture2D(map, vUv).rgb;
  float d = dot(normalize(vNw), normalize(sunDir));
  float lit = smoothstep(-0.12, 0.45, d);
  float fres = pow(1.0 - max(normalize(vNv).z, 0.0), 2.5);
  vec3 col = albedo * (0.015 + 1.1 * lit) + hazeColor * fres * (0.15 + 0.85 * lit) * 0.55;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const HALO_FRAG = /* glsl */ `
uniform vec3 hazeColor; uniform vec3 sunDir; uniform float inner;
varying vec3 vNw; varying vec3 vNv;
void main(){
  // 0 at the halo's outer edge, 1 at the planet's limb
  float rim = smoothstep(0.0, inner, -normalize(vNv).z);
  float lit = 0.12 + 0.88 * smoothstep(-0.35, 0.5, dot(normalize(vNw), normalize(sunDir)));
  gl_FragColor = vec4(hazeColor * pow(rim, 1.6) * lit * 0.9, 1.0);
}`;

function makePlanet(map: THREE.Texture, radius: number, sunDir: THREE.Vector3): THREE.Group {
  const haze = new THREE.Color('#ffae7a');
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 96, 48),
    new THREE.ShaderMaterial({
      uniforms: { map: { value: map }, sunDir: { value: sunDir }, hazeColor: { value: haze } },
      vertexShader: PLANET_VERT,
      fragmentShader: PLANET_FRAG,
    }),
  );
  body.rotation.x = Math.PI / 2; // texture poles on the bay z axis
  const haloScale = 1.07;
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(radius * haloScale, 96, 48),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { hazeColor: { value: haze }, sunDir: { value: sunDir }, inner: { value: Math.sqrt(1 - 1 / (haloScale * haloScale)) } },
      vertexShader: PLANET_VERT,
      fragmentShader: HALO_FRAG,
    }),
  );
  g.add(body, halo);
  g.userData.body = body;
  return g;
}

// ---- Glass enclosure with glove ports -------------------------------------------------------

function makeEnclosure(layout: BayLayout): THREE.Group {
  const g = new THREE.Group();
  const S = layout.deckSize;
  const [cx, cy] = layout.deckCenter;
  const H = 0.62;
  const x0 = cx - S / 2;
  const x1 = cx + S / 2;
  const y0 = cy - S / 2;
  const y1 = cy + S / 2;

  const glass = new THREE.MeshStandardMaterial({ color: '#7dd3fc', transparent: true, opacity: 0.085, roughness: 0.08, metalness: 0, depthWrite: false, side: THREE.DoubleSide });
  const wall = (w: number, h: number) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), glass);
  const back = wall(S, H);
  back.rotation.x = Math.PI / 2;
  back.position.set(cx, y1, H / 2);
  const left = wall(S, H);
  left.rotation.set(Math.PI / 2, Math.PI / 2, 0);
  left.position.set(x0, cy, H / 2);
  const right = left.clone();
  right.position.x = x1;
  g.add(back, left, right);

  // cyan frame edges: posts, top rails and the deck-level sill (no front wall)
  const pts: number[] = [];
  const seg = (a: [number, number, number], b: [number, number, number]) => pts.push(...a, ...b);
  for (const [x, y] of [
    [x0, y0],
    [x0, y1],
    [x1, y1],
    [x1, y0],
  ] as const)
    seg([x, y, 0], [x, y, H]);
  seg([x0, y0, H], [x0, y1, H]);
  seg([x0, y1, H], [x1, y1, H]);
  seg([x1, y1, H], [x1, y0, H]);
  seg([x0, y0, 0.002], [x0, y1, 0.002]);
  seg([x0, y1, 0.002], [x1, y1, 0.002]);
  seg([x1, y1, 0.002], [x1, y0, 0.002]);
  const edgeGeom = new THREE.BufferGeometry();
  edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.add(new THREE.LineSegments(edgeGeom, new THREE.LineBasicMaterial({ color: '#38bdf8', transparent: true, opacity: 0.85 })));

  // soft cyan light strip along the top of the back wall
  const strip = new THREE.Mesh(new THREE.BoxGeometry(S, 0.006, 0.01), new THREE.MeshBasicMaterial({ color: '#7dd3fc', transparent: true, opacity: 0.5 }));
  strip.position.set(cx, y1, H - 0.005);
  g.add(strip);

  // two glove ports in the back wall
  const ringMat = new THREE.MeshStandardMaterial({ color: '#9aa7b8', metalness: 0.85, roughness: 0.3 });
  const glowMat = new THREE.MeshBasicMaterial({ color: '#38bdf8', transparent: true, opacity: 0.65 });
  const membrane = new THREE.MeshStandardMaterial({ color: '#1e3a5f', transparent: true, opacity: 0.22, roughness: 0.6, side: THREE.DoubleSide, depthWrite: false });
  for (const dx of [-0.2, 0.2]) {
    const port = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.056, 0.008, 16, 64), ringMat);
    const glow = new THREE.Mesh(new THREE.TorusGeometry(0.046, 0.0018, 8, 64), glowMat);
    const skin = new THREE.Mesh(new THREE.CircleGeometry(0.048, 48), membrane);
    port.add(ring, glow, skin);
    port.rotation.x = Math.PI / 2;
    port.position.set(cx + dx, y1 - 0.004, 0.2);
    g.add(port);
  }

  // dark station frame under the deck, so the plate reads as part of a structure
  const frame = new THREE.Mesh(new THREE.BoxGeometry(S + 0.08, S + 0.08, 0.06), new THREE.MeshStandardMaterial({ color: '#1a202b', metalness: 0.6, roughness: 0.5 }));
  frame.position.set(cx, cy, -0.043);
  g.add(frame);
  return g;
}

export interface SpaceEnvironment {
  group: THREE.Group;
  rimLight: THREE.DirectionalLight;
  update(dt: number): void;
}

/** Build the viewer-only space decoration around a bay. */
export function buildSpaceEnvironment(layout: BayLayout, marsUrl: string): SpaceEnvironment {
  const group = new THREE.Group();
  group.name = 'space-environment';
  const sunDir = new THREE.Vector3(-0.95, -0.25, 0.3).normalize();

  group.add(makeNebula(9));
  group.add(makeStarfield(4500, 8, 7));

  const tex = new THREE.TextureLoader().load(marsUrl);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mars = makePlanet(tex, 1.2, sunDir);
  mars.position.set(4.0, 4.2, -0.75);
  group.add(mars);

  group.add(makeEnclosure(layout));

  // cool rim light from behind the bay; viewer only, so the bay camera image keeps flat, even light
  const rimLight = new THREE.DirectionalLight('#8fd3ff', 1.6);
  rimLight.position.set(0.5, 1.4, 0.9);
  group.add(rimLight);
  group.add(rimLight.target);

  viewOnly(group);
  const body = mars.userData.body as THREE.Mesh;
  return {
    group,
    rimLight,
    update(dt: number) {
      body.rotation.y += dt * 0.004;
    },
  };
}
