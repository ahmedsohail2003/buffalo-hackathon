#!/usr/bin/env node
// Convert the MuJoCo Menagerie SO-101 (robotstudio_so101, Apache-2.0) into public/assets/so101.json.
//
// Usage: node scripts/convert-so101.mjs <menagerie-so101-dir> [out.json] [--cell=0.0007]
//   <menagerie-so101-dir> holds so101.xml and assets/*.stl. Run once; the output is committed.
//
// Output format "starhand-so101/1" (all lengths in metres, quaternions as three.js [x, y, z, w]):
// {
//   format, source, license,
//   frame:  "bay": z up; the shoulder-pan axis is the z axis (x = y = 0); the deck/floor is z = 0;
//           the arm reaches toward -y at shoulder_pan = 0.
//   bayTransform: { yaw, panAxisMj: [x, y] }   how a MuJoCo world point p maps into the bay frame:
//           p_bay = Rz(yaw) * (p - [panAxisMj.x, panAxisMj.y, 0]). Already applied to the root body.
//   joints: ["shoulder_pan", ...]                actuated joints in ArmSnapshot.q order
//   bodies: [{ name, parent (null for the root), pos, quat,        pose in the parent body frame
//              joint: { name, axis, range: [lo, hi] } | null,      hinge through the body origin
//              geoms: [{ mesh, pos, quat, rgba }] }]               visual meshes in the body frame
//           Bodies are listed parents first. FK: world(body) = world(parent) * T(pos) * R(quat) * R(axis, q).
//   sites:  { [name]: { body, pos, quat } }      gripperframe is the tool-centre point (TCP)
//   tcp:    "gripperframe"
//   pads:   { [geomName]: { body, type: 'box'|'sphere'|'capsule', pos, quat, size } }
//           the fixed-jaw (body gripper) and moving-jaw (body moving_jaw_so101_v1) contact primitives
//           from the collision model, used to measure the jaw gap and the fingertip depth.
//   meshes: { [id]: { count: vertices, tris, min: [x,y,z], max: [x,y,z], index: 'u16'|'u32',
//                     positions: base64 Uint16 xyz, little endian, quantised: p = min + q / 65535 * (max - min),
//                     indices: base64 Uint16/Uint32 triangle list } }
//           Decimated by vertex clustering on a uniform grid (cell size --cell, metres; default 0.7 mm), with one
//           quadric-error-minimising representative per cell so flat faces and sharp edges survive.
// }
//
// MJCF handling: default classes are resolved (main -> nested classes, childclass inheritance);
// MuJoCo quaternions (w x y z, not necessarily normalised) are normalised and reordered to x y z w;
// euler angles use MuJoCo's default intrinsic "xyz" sequence. Only raw STL vertices are used, so the
// geom pos/quat from the XML apply directly (MuJoCo's internal mesh re-centring cancels out).

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opts = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const pos = args.filter((a) => !a.startsWith('--'));
if (pos.length < 1) {
  console.error('usage: node scripts/convert-so101.mjs <menagerie-so101-dir> [out.json] [--cell=0.0007]');
  process.exit(1);
}
const srcDir = pos[0];
const outPath = pos[1] ?? 'public/assets/so101.json';
const CELL = Number(opts.cell ?? 0.0007);

// ---------- tiny XML parser (elements, attributes, comments; enough for MJCF) ----------
function parseXml(text) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[0].startsWith('<!--') || m[0].startsWith('<?')) continue;
    if (m[1]) {
      const top = stack.pop();
      if (top.tag !== m[1]) throw new Error(`XML: </${m[1]}> closes <${top.tag}>`);
      continue;
    }
    const attrs = {};
    for (const a of m[3].matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = a[2];
    const el = { tag: m[2], attrs, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!m[4]) stack.push(el);
  }
  if (stack.length !== 1) throw new Error('XML: unclosed elements');
  return root;
}
const nums = (s) => s.trim().split(/\s+/).map(Number);
const kids = (el, tag) => el.children.filter((c) => c.tag === tag);

// ---------- quaternion helpers (three order x y z w) ----------
const qnorm = (q) => {
  const n = Math.hypot(...q);
  return q.map((v) => v / n);
};
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qaxis = (ax, ang) => {
  const s = Math.sin(ang / 2);
  return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(ang / 2)];
};
const qrot = (q, v) => {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
};
const r6 = (v) => Math.round(v * 1e7) / 1e7;
const rv = (a) => a.map(r6);

function frameOf(attrs) {
  const p = attrs.pos ? nums(attrs.pos) : [0, 0, 0];
  let q = [0, 0, 0, 1];
  if (attrs.quat) {
    const [w, x, y, z] = nums(attrs.quat);
    q = qnorm([x, y, z, w]);
  } else if (attrs.euler) {
    const [a, b, c] = nums(attrs.euler); // intrinsic x, then y, then z
    q = qnorm(qmul(qmul(qaxis([1, 0, 0], a), qaxis([0, 1, 0], b)), qaxis([0, 0, 1], c)));
  } else if (attrs.axisangle || attrs.xyaxes || attrs.zaxis) {
    throw new Error('unsupported orientation attribute');
  }
  return { pos: p, quat: q };
}

// ---------- load MJCF ----------
const xml = parseXml(fs.readFileSync(path.join(srcDir, 'so101.xml'), 'utf8'));
const mj = xml.children.find((c) => c.tag === 'mujoco');
const compiler = kids(mj, 'compiler')[0]?.attrs ?? {};
if ((compiler.angle ?? 'degree') !== 'radian') throw new Error('expected compiler angle="radian"');
const meshdir = compiler.meshdir ?? '.';

// default classes: name -> { parent, byTag: { geom: {...}, joint: {...} } }
const classes = new Map();
function readDefaults(el, parent) {
  const name = el.attrs.class ?? 'main';
  const byTag = {};
  for (const c of el.children) if (c.tag !== 'default') byTag[c.tag] = { ...c.attrs };
  classes.set(name, { parent, byTag });
  for (const c of kids(el, 'default')) readDefaults(c, name);
}
for (const d of kids(mj, 'default')) readDefaults(d, null);
function resolved(tag, cls, own) {
  const chain = [];
  for (let c = cls; c; c = classes.get(c)?.parent) chain.unshift(c);
  const out = {};
  for (const c of chain) Object.assign(out, classes.get(c)?.byTag[tag] ?? {});
  return Object.assign(out, own);
}

// assets
const meshFiles = new Map();
const materials = new Map();
for (const a of kids(mj, 'asset')) {
  for (const m of kids(a, 'mesh')) meshFiles.set(m.attrs.name ?? path.basename(m.attrs.file, path.extname(m.attrs.file)), m.attrs.file);
  for (const m of kids(a, 'material')) materials.set(m.attrs.name, m.attrs.rgba ? nums(m.attrs.rgba) : [1, 1, 1, 1]);
}

// bodies (depth first, parents first)
const bodies = [];
const sites = {};
const pads = {};
const usedMeshes = new Set();
function walk(el, parent, childclass) {
  const cc = el.attrs.childclass ?? childclass;
  const f = frameOf(el.attrs);
  const joints = kids(el, 'joint');
  if (joints.length > 1) throw new Error(`body ${el.attrs.name}: more than one joint`);
  let joint = null;
  if (joints.length === 1) {
    const ja = resolved('joint', joints[0].attrs.class ?? cc, joints[0].attrs);
    if ((ja.type ?? 'hinge') !== 'hinge') throw new Error('only hinge joints are supported');
    if (ja.pos && nums(ja.pos).some((v) => Math.abs(v) > 1e-12)) throw new Error('joint pos must be the body origin');
    joint = { name: ja.name, axis: rv(qnorm([...(ja.axis ? nums(ja.axis) : [0, 0, 1]), 0]).slice(0, 3)), range: rv(nums(ja.range)) };
  }
  const geoms = [];
  for (const g of kids(el, 'geom')) {
    const ga = resolved('geom', g.attrs.class ?? cc, g.attrs);
    const gf = frameOf(g.attrs);
    const type = ga.type ?? 'sphere';
    if (type === 'mesh' && ga.group === '2') {
      const rgba = ga.material ? materials.get(ga.material) : ga.rgba ? nums(ga.rgba) : [0.5, 0.5, 0.5, 1];
      geoms.push({ mesh: ga.mesh, pos: rv(gf.pos), quat: rv(gf.quat), rgba });
      usedMeshes.add(ga.mesh);
    }
    if (ga.name && /^(fixed|moving)_jaw_/.test(ga.name) && type !== 'mesh') {
      pads[ga.name] = { body: el.attrs.name, type, pos: rv(gf.pos), quat: rv(gf.quat), size: nums(ga.size) };
    }
  }
  for (const s of kids(el, 'site')) {
    const sf = frameOf(s.attrs);
    sites[s.attrs.name] = { body: el.attrs.name, pos: rv(sf.pos), quat: rv(sf.quat) };
  }
  bodies.push({ name: el.attrs.name, parent, pos: f.pos, quat: f.quat, joint, geoms });
  for (const b of kids(el, 'body')) walk(b, el.attrs.name, cc);
}
const world = kids(mj, 'worldbody')[0];
const roots = kids(world, 'body');
if (roots.length !== 1) throw new Error('expected one root body');
walk(roots[0], null, null);

// ---------- bay transform ----------
// The shoulder-pan joint must be vertical in the MuJoCo world at q = 0; its axis becomes the bay z axis.
const root = bodies[0];
const shoulder = bodies.find((b) => b.joint?.name === 'shoulder_pan');
if (shoulder.parent !== root.name) throw new Error('shoulder_pan body must be a child of the root');
const shoulderWorld = qrot(root.quat, shoulder.pos).map((v, i) => v + root.pos[i]);
const panAxisWorld = qrot(qmul(root.quat, shoulder.quat), shoulder.joint.axis);
if (Math.abs(Math.abs(panAxisWorld[2]) - 1) > 1e-9) throw new Error('shoulder_pan axis is not vertical');
const panAxisMj = [shoulderWorld[0], shoulderWorld[1]];
// At q = 0 the Menagerie arm points along MuJoCo +x. Yaw -90 deg maps +x to bay -y (toward the operator).
const yaw = -Math.PI / 2;
const qyaw = qaxis([0, 0, 1], yaw);
{
  const p = [root.pos[0] - panAxisMj[0], root.pos[1] - panAxisMj[1], root.pos[2]];
  root.pos = qrot(qyaw, p);
  root.quat = qnorm(qmul(qyaw, root.quat));
}
for (const b of bodies) {
  b.pos = rv(b.pos);
  b.quat = rv(b.quat);
}

// ---------- meshes: STL -> clustered, quantised, base64 ----------
function readStl(file) {
  const buf = fs.readFileSync(file);
  const n = buf.readUInt32LE(80);
  if (84 + n * 50 !== buf.length) throw new Error(`${file}: not a binary STL`);
  const v = new Float64Array(n * 9);
  for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) v[i * 9 + k] = buf.readFloatLE(84 + i * 50 + 12 + k * 4);
  return v;
}

// Jacobi eigen-decomposition of a symmetric 3x3 (row-major array of 9), returns { values, vectors (columns) }
function eigSym3(a) {
  const A = a.slice();
  const V = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 30; sweep++) {
    const off = A[1] * A[1] + A[2] * A[2] + A[5] * A[5];
    if (off < 1e-30) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      const apq = A[p * 3 + q];
      if (Math.abs(apq) < 1e-300) continue;
      const theta = (A[q * 3 + q] - A[p * 3 + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = A[k * 3 + p], akq = A[k * 3 + q];
        A[k * 3 + p] = c * akp - s * akq;
        A[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = A[p * 3 + k], aqk = A[q * 3 + k];
        A[p * 3 + k] = c * apk - s * aqk;
        A[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = V[k * 3 + p], vkq = V[k * 3 + q];
        V[k * 3 + p] = c * vkp - s * vkq;
        V[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: [A[0], A[4], A[8]], vectors: V };
}

function decimate(tri, cell) {
  const nT = tri.length / 9;
  const cellOf = new Map(); // key -> cluster id
  const clusters = []; // { sum: [x,y,z], n, A: [9], b: [3] }
  const vid = new Int32Array(nT * 3);
  for (let t = 0; t < nT; t++) {
    const p = [0, 1, 2].map((k) => [tri[t * 9 + k * 3], tri[t * 9 + k * 3 + 1], tri[t * 9 + k * 3 + 2]]);
    const e1 = p[1].map((v, i) => v - p[0][i]);
    const e2 = p[2].map((v, i) => v - p[0][i]);
    const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    const len = Math.hypot(nx, ny, nz);
    const area = len / 2;
    const n = len > 0 ? [nx / len, ny / len, nz / len] : [0, 0, 0];
    const d = -(n[0] * p[0][0] + n[1] * p[0][1] + n[2] * p[0][2]);
    for (let k = 0; k < 3; k++) {
      const key = `${Math.floor(p[k][0] / cell)},${Math.floor(p[k][1] / cell)},${Math.floor(p[k][2] / cell)}`;
      let id = cellOf.get(key);
      if (id === undefined) {
        id = clusters.length;
        cellOf.set(key, id);
        clusters.push({ sum: [0, 0, 0], n: 0, A: new Float64Array(9), b: new Float64Array(3) });
      }
      const c = clusters[id];
      c.sum[0] += p[k][0];
      c.sum[1] += p[k][1];
      c.sum[2] += p[k][2];
      c.n++;
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) c.A[i * 3 + j] += area * n[i] * n[j];
        c.b[i] += area * d * n[i];
      }
      vid[t * 3 + k] = id;
    }
  }
  // representative = argmin of the summed quadric, solved by a truncated pseudo-inverse around the mean
  const rep = clusters.map((c) => {
    const mean = c.sum.map((v) => v / c.n);
    const { values, vectors } = eigSym3(Array.from(c.A));
    const maxEv = Math.max(...values.map(Math.abs));
    // residual r = -(A mean + b); x = mean + pinv(A) r
    const r = [0, 1, 2].map((i) => -(c.A[i * 3] * mean[0] + c.A[i * 3 + 1] * mean[1] + c.A[i * 3 + 2] * mean[2] + c.b[i]));
    const x = mean.slice();
    for (let k = 0; k < 3; k++) {
      if (maxEv <= 0 || Math.abs(values[k]) < maxEv * 1e-3) continue;
      const vk = [vectors[k], vectors[3 + k], vectors[6 + k]];
      const s = (vk[0] * r[0] + vk[1] * r[1] + vk[2] * r[2]) / values[k];
      for (let i = 0; i < 3; i++) x[i] += s * vk[i];
    }
    const off = Math.hypot(x[0] - mean[0], x[1] - mean[1], x[2] - mean[2]);
    return off > cell * 1.5 ? mean : x;
  });
  // rebuild the triangle list: drop collapsed and duplicate triangles, compact vertices
  const seen = new Set();
  const outTris = [];
  for (let t = 0; t < nT; t++) {
    const a = vid[t * 3], b = vid[t * 3 + 1], c = vid[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    const key = [a, b, c].sort((x, y) => x - y).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    outTris.push(a, b, c);
  }
  const remap = new Map();
  const verts = [];
  const idx = outTris.map((v) => {
    let r = remap.get(v);
    if (r === undefined) {
      r = verts.length;
      remap.set(v, r);
      verts.push(rep[v]);
    }
    return r;
  });
  return { verts, idx };
}

function encodeMesh(verts, idx) {
  const min = [0, 1, 2].map((k) => Math.min(...verts.map((v) => v[k])));
  const max = [0, 1, 2].map((k) => Math.max(...verts.map((v) => v[k])));
  const q = new Uint16Array(verts.length * 3);
  verts.forEach((v, i) => {
    for (let k = 0; k < 3; k++) {
      const span = max[k] - min[k] || 1;
      q[i * 3 + k] = Math.round(((v[k] - min[k]) / span) * 65535);
    }
  });
  const big = verts.length > 65535;
  const I = big ? new Uint32Array(idx) : new Uint16Array(idx);
  return {
    count: verts.length,
    tris: idx.length / 3,
    min: rv(min),
    max: rv(max),
    index: big ? 'u32' : 'u16',
    positions: Buffer.from(q.buffer).toString('base64'),
    indices: Buffer.from(I.buffer).toString('base64'),
  };
}

const meshes = {};
let triIn = 0, triOut = 0;
for (const id of [...usedMeshes].sort()) {
  const tri = readStl(path.join(srcDir, meshdir, meshFiles.get(id)));
  const { verts, idx } = decimate(tri, CELL);
  meshes[id] = encodeMesh(verts, idx);
  triIn += tri.length / 9;
  triOut += idx.length / 3;
  console.log(`${id.padEnd(44)} ${String(tri.length / 9).padStart(6)} -> ${String(idx.length / 3).padStart(6)} tris`);
}

const out = {
  format: 'starhand-so101/1',
  source: 'MuJoCo Menagerie robotstudio_so101 (so101.xml + assets/*.stl), converted by scripts/convert-so101.mjs',
  license: 'Apache-2.0 (MuJoCo Menagerie / The Robot Studio)',
  frame: 'bay: metres, z up, shoulder-pan axis on the z axis, deck at z = 0, arm reaches -y at shoulder_pan = 0',
  bayTransform: { yaw: r6(yaw), panAxisMj: rv(panAxisMj) },
  joints: ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'],
  bodies,
  sites,
  tcp: 'gripperframe',
  pads,
  meshes,
};
for (const j of out.joints) if (!bodies.some((b) => b.joint?.name === j)) throw new Error(`missing joint ${j}`);
if (!sites.gripperframe) throw new Error('missing gripperframe site');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
const json = JSON.stringify(out);
fs.writeFileSync(outPath, json);
console.log(`triangles ${triIn} -> ${triOut}; wrote ${outPath} (${(json.length / 1024 / 1024).toFixed(2)} MB)`);
