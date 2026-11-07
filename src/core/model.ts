// SO-101 kinematic model built from public/assets/so101.json (see scripts/convert-so101.mjs for the format).
//
// Two views of the same chain:
//  - Kinematics: allocation-free forward kinematics on plain arrays (used by IK every frame).
//  - ArmModel: a three.js Object3D tree for rendering (meshes optional via a factory), plus the
//    bay-frame helpers the IK and the arm need: tcp, joint anchors and axes, approach and jaw axes.
// Node-safe: only three math/geometry classes, nothing touches window or document.

import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial, Object3D, SRGBColorSpace } from 'three';
import type { Vec3 } from '../contracts';

export type Quat4 = [number, number, number, number];

export interface So101Joint {
  name: string;
  axis: Vec3;
  range: [number, number];
}
export interface So101Geom {
  mesh: string;
  pos: Vec3;
  quat: Quat4;
  rgba: [number, number, number, number];
}
export interface So101Body {
  name: string;
  parent: string | null;
  pos: Vec3;
  quat: Quat4;
  joint: So101Joint | null;
  geoms: So101Geom[];
}
export interface So101Site {
  body: string;
  pos: Vec3;
  quat: Quat4;
}
export interface So101Pad {
  body: string;
  type: 'box' | 'sphere' | 'capsule';
  pos: Vec3;
  quat: Quat4;
  size: number[];
}
export interface So101Mesh {
  count: number;
  tris: number;
  min: Vec3;
  max: Vec3;
  index: 'u16' | 'u32';
  positions: string;
  indices: string;
}
export interface So101Data {
  format: string;
  joints: string[];
  bodies: So101Body[];
  sites: Record<string, So101Site>;
  tcp: string;
  pads: Record<string, So101Pad>;
  meshes: Record<string, So101Mesh>;
  bayTransform?: { yaw: number; panAxisMj: [number, number] };
}

/** Actuated joints, in ArmSnapshot.q order. */
export const JOINT_NAMES = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper'] as const;
export type JointName = (typeof JOINT_NAMES)[number];
export const NUM_JOINTS = 6;

// ---------- small quaternion / vector helpers on plain arrays (x y z w) ----------
function qmulInto(o: Float64Array, oi: number, a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number): void {
  const ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3];
  const bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
  o[oi] = aw * bx + ax * bw + ay * bz - az * by;
  o[oi + 1] = aw * by - ax * bz + ay * bw + az * bx;
  o[oi + 2] = aw * bz + ax * by - ay * bx + az * bw;
  o[oi + 3] = aw * bw - ax * bx - ay * by - az * bz;
}
/** rotate v by quaternion q[qi..], write to o[oi..] */
function qrotInto(o: Float64Array | number[], oi: number, q: ArrayLike<number>, qi: number, vx: number, vy: number, vz: number): void {
  const x = q[qi], y = q[qi + 1], z = q[qi + 2], w = q[qi + 3];
  const ix = w * vx + y * vz - z * vy;
  const iy = w * vy + z * vx - x * vz;
  const iz = w * vz + x * vy - y * vx;
  const iw = -x * vx - y * vy - z * vz;
  o[oi] = ix * w + iw * -x + iy * -z - iz * -y;
  o[oi + 1] = iy * w + iw * -y + iz * -x - ix * -z;
  o[oi + 2] = iz * w + iw * -z + ix * -y - iy * -x;
}

/**
 * Allocation-free forward kinematics. compute(q) fills world positions/quaternions of every body
 * (bay frame); the getters below read the last computed pose.
 */
export class Kinematics {
  readonly names: string[];
  readonly parent: Int32Array;
  readonly localPos: Float64Array;
  readonly localQuat: Float64Array;
  /** joint index (0..5) driving each body, or -1 */
  readonly jointOf: Int32Array;
  readonly axis: Float64Array;
  /** body index for each actuated joint */
  readonly jointBody: Int32Array;
  readonly ranges: [number, number][];
  readonly wpos: Float64Array;
  readonly wquat: Float64Array;
  readonly tcpBody: number;
  readonly tcpLocal: Vec3;
  readonly gripperBody: number;
  readonly movingJawBody: number;
  private readonly jq = new Float64Array(4);
  private readonly tmpQ = new Float64Array(4);

  constructor(data: So101Data) {
    const n = data.bodies.length;
    this.names = data.bodies.map((b) => b.name);
    this.parent = new Int32Array(n);
    this.localPos = new Float64Array(n * 3);
    this.localQuat = new Float64Array(n * 4);
    this.jointOf = new Int32Array(n).fill(-1);
    this.axis = new Float64Array(n * 3);
    this.jointBody = new Int32Array(NUM_JOINTS).fill(-1);
    this.ranges = JOINT_NAMES.map(() => [-Math.PI, Math.PI] as [number, number]);
    data.bodies.forEach((b, i) => {
      const p = b.parent === null ? -1 : this.names.indexOf(b.parent);
      if (b.parent !== null && (p < 0 || p >= i)) throw new Error(`so101: body ${b.name} listed before its parent`);
      this.parent[i] = p;
      this.localPos.set(b.pos, i * 3);
      this.localQuat.set(b.quat, i * 4);
      if (b.joint) {
        const j = JOINT_NAMES.indexOf(b.joint.name as JointName);
        if (j >= 0) {
          this.jointOf[i] = j;
          this.jointBody[j] = i;
          this.ranges[j] = [b.joint.range[0], b.joint.range[1]];
          this.axis.set(b.joint.axis, i * 3);
        }
      }
    });
    JOINT_NAMES.forEach((name, j) => {
      if (this.jointBody[j] < 0) throw new Error(`so101: missing joint ${name}`);
    });
    this.wpos = new Float64Array(n * 3);
    this.wquat = new Float64Array(n * 4);
    const site = data.sites[data.tcp];
    if (!site) throw new Error('so101: missing tcp site');
    this.tcpBody = this.names.indexOf(site.body);
    this.tcpLocal = [site.pos[0], site.pos[1], site.pos[2]];
    this.gripperBody = this.jointBody[4];
    this.movingJawBody = this.jointBody[5];
  }

  compute(q: ArrayLike<number>): void {
    const n = this.names.length;
    const { wpos, wquat, localPos, localQuat, parent, jointOf, axis, jq, tmpQ } = this;
    for (let i = 0; i < n; i++) {
      const p = parent[i];
      const j = jointOf[i];
      if (p < 0) {
        wpos[i * 3] = localPos[i * 3];
        wpos[i * 3 + 1] = localPos[i * 3 + 1];
        wpos[i * 3 + 2] = localPos[i * 3 + 2];
        tmpQ.set(localQuat.subarray(i * 4, i * 4 + 4));
      } else {
        qrotInto(wpos, i * 3, wquat, p * 4, localPos[i * 3], localPos[i * 3 + 1], localPos[i * 3 + 2]);
        wpos[i * 3] += wpos[p * 3];
        wpos[i * 3 + 1] += wpos[p * 3 + 1];
        wpos[i * 3 + 2] += wpos[p * 3 + 2];
        qmulInto(tmpQ, 0, wquat, p * 4, localQuat, i * 4);
      }
      if (j >= 0) {
        const h = q[j] / 2;
        const s = Math.sin(h);
        jq[0] = axis[i * 3] * s;
        jq[1] = axis[i * 3 + 1] * s;
        jq[2] = axis[i * 3 + 2] * s;
        jq[3] = Math.cos(h);
        qmulInto(wquat, i * 4, tmpQ, 0, jq, 0);
      } else {
        wquat.set(tmpQ, i * 4);
      }
    }
  }

  /** world point of a body-local point (after compute) */
  point(body: number, lx: number, ly: number, lz: number, out: number[] | Float64Array, oi = 0): void {
    qrotInto(out, oi, this.wquat, body * 4, lx, ly, lz);
    out[oi] += this.wpos[body * 3];
    out[oi + 1] += this.wpos[body * 3 + 1];
    out[oi + 2] += this.wpos[body * 3 + 2];
  }
  /** world direction of a body-local direction (after compute) */
  dir(body: number, lx: number, ly: number, lz: number, out: number[] | Float64Array, oi = 0): void {
    qrotInto(out, oi, this.wquat, body * 4, lx, ly, lz);
  }
  tcp(out: number[] | Float64Array, oi = 0): void {
    this.point(this.tcpBody, this.tcpLocal[0], this.tcpLocal[1], this.tcpLocal[2], out, oi);
  }
  /** joint j anchor (hinge through the body origin) */
  anchor(j: number, out: number[] | Float64Array, oi = 0): void {
    const b = this.jointBody[j];
    out[oi] = this.wpos[b * 3];
    out[oi + 1] = this.wpos[b * 3 + 1];
    out[oi + 2] = this.wpos[b * 3 + 2];
  }
  /** joint j axis, world unit vector */
  jointAxis(j: number, out: number[] | Float64Array, oi = 0): void {
    const b = this.jointBody[j];
    qrotInto(out, oi, this.wquat, b * 4, this.axis[b * 3], this.axis[b * 3 + 1], this.axis[b * 3 + 2]);
  }
  /** approach axis: from the wrist toward the fingertips (gripper body -z) */
  approach(out: number[] | Float64Array, oi = 0): void {
    this.dir(this.gripperBody, 0, 0, -1, out, oi);
  }
  /** jaw closing axis: gripper body +x, from the fixed jaw toward the moving jaw */
  jawAxis(out: number[] | Float64Array, oi = 0): void {
    this.dir(this.gripperBody, 1, 0, 0, out, oi);
  }
}

/** Pad faces that define the jaw gap: fixed-jaw tip pad (+x face) and moving-jaw tip pad (-x face). */
export const FIXED_PAD = 'fixed_jaw_box4';
export const MOVING_PAD = 'moving_jaw_box2';

function padFaceLocal(pad: So101Pad, sign: 1 | -1): Vec3 {
  // face centre along the pad's local x, expressed in its body frame
  const o = [0, 0, 0];
  qrotInto(o, 0, pad.quat, 0, sign * pad.size[0], 0, 0);
  return [pad.pos[0] + o[0], pad.pos[1] + o[1], pad.pos[2] + o[2]];
}

export interface MeshGeomFactoryArgs {
  geom: So101Geom;
  body: string;
  geometry: BufferGeometry;
}
export type MeshFactory = (args: MeshGeomFactoryArgs) => Object3D | null;

export interface ArmModelOptions {
  /** build a renderable object for each visual geom (browser); omit in node */
  meshFactory?: MeshFactory;
}

const b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const b64lookup = (() => {
  const t = new Uint8Array(128);
  for (let i = 0; i < b64chars.length; i++) t[b64chars.charCodeAt(i)] = i;
  return t;
})();
/** base64 -> bytes, without atob/Buffer so it runs anywhere */
export function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const n = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(n);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = b64lookup[clean.charCodeAt(i)];
    const b = b64lookup[clean.charCodeAt(i + 1)];
    const c = i + 2 < clean.length ? b64lookup[clean.charCodeAt(i + 2)] : 0;
    const d = i + 3 < clean.length ? b64lookup[clean.charCodeAt(i + 3)] : 0;
    const v = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < n) out[o++] = (v >> 16) & 255;
    if (o < n) out[o++] = (v >> 8) & 255;
    if (o < n) out[o++] = v & 255;
  }
  return out;
}

/** Decode one quantised mesh to float positions (metres, geom frame) and a triangle index list. */
export function decodeMesh(m: So101Mesh): { positions: Float32Array; indices: Uint16Array | Uint32Array } {
  const pb = base64ToBytes(m.positions);
  const q = new Uint16Array(pb.buffer, pb.byteOffset, m.count * 3);
  const positions = new Float32Array(m.count * 3);
  for (let i = 0; i < m.count; i++) {
    for (let k = 0; k < 3; k++) positions[i * 3 + k] = m.min[k] + (q[i * 3 + k] / 65535) * (m.max[k] - m.min[k]);
  }
  const ib = base64ToBytes(m.indices);
  const indices = m.index === 'u32' ? new Uint32Array(ib.buffer, ib.byteOffset, m.tris * 3) : new Uint16Array(ib.buffer, ib.byteOffset, m.tris * 3);
  return { positions, indices };
}

/** BufferGeometry for a mesh id (normals computed; use flatShading for a crisp CAD look). */
export function meshGeometry(m: So101Mesh): BufferGeometry {
  const { positions, indices } = decodeMesh(m);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setIndex(new BufferAttribute(indices, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** A ready-made browser mesh factory: MeshStandardMaterial in the MJCF colour, flat shaded. */
export const defaultMeshFactory: MeshFactory = ({ geom, geometry }) => {
  const color = new Color().setRGB(geom.rgba[0], geom.rgba[1], geom.rgba[2], SRGBColorSpace);
  const mat = new MeshStandardMaterial({ color, flatShading: true, roughness: 0.55, metalness: geom.rgba[0] < 0.2 ? 0.2 : 0.05 });
  const mesh = new Mesh(geometry, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
};

/**
 * The SO-101 in the bay frame. root is a plain Object3D (identity) to add to a scene; links[name]
 * is the Object3D of each body. setPose updates both the render tree and the fast kinematics.
 */
export class ArmModel {
  readonly data: So101Data;
  readonly kin: Kinematics;
  readonly root: Object3D;
  readonly links: Record<string, Object3D> = {};
  /** current joint values (radians), ArmSnapshot order */
  readonly q: number[] = [0, 0, 0, 0, 0, 0];
  readonly ranges: [number, number][];
  private readonly fixedFace: Vec3;
  private readonly movingFace: Vec3;
  private readonly tmp = [0, 0, 0];
  private readonly tmp2 = [0, 0, 0];

  constructor(data: So101Data, opts: ArmModelOptions = {}) {
    this.data = data;
    this.kin = new Kinematics(data);
    this.ranges = this.kin.ranges;
    this.root = new Object3D();
    this.root.name = 'so101';
    const geoCache = new Map<string, BufferGeometry>();
    for (const b of data.bodies) {
      const o = new Object3D();
      o.name = b.name;
      o.position.set(b.pos[0], b.pos[1], b.pos[2]);
      o.quaternion.set(b.quat[0], b.quat[1], b.quat[2], b.quat[3]);
      (b.parent === null ? this.root : this.links[b.parent]).add(o);
      this.links[b.name] = o;
      if (opts.meshFactory) {
        for (const g of b.geoms) {
          const md = data.meshes[g.mesh];
          if (!md) continue;
          let geometry = geoCache.get(g.mesh);
          if (!geometry) {
            geometry = meshGeometry(md);
            geoCache.set(g.mesh, geometry);
          }
          const obj = opts.meshFactory({ geom: g, body: b.name, geometry });
          if (!obj) continue;
          obj.position.set(g.pos[0], g.pos[1], g.pos[2]);
          obj.quaternion.set(g.quat[0], g.quat[1], g.quat[2], g.quat[3]);
          o.add(obj);
        }
      }
    }
    const fp = data.pads[FIXED_PAD];
    const mp = data.pads[MOVING_PAD];
    if (!fp || !mp) throw new Error('so101: missing jaw pad geometry');
    this.fixedFace = padFaceLocal(fp, 1);
    this.movingFace = padFaceLocal(mp, -1);
    this.setPose(this.q);
  }

  /** Set all six joints (radians, clamped to the joint ranges) and refresh the render tree. */
  setPose(q: ArrayLike<number>): void {
    for (let j = 0; j < NUM_JOINTS; j++) {
      const r = this.ranges[j];
      this.q[j] = Math.min(r[1], Math.max(r[0], q[j] ?? 0));
    }
    this.kin.compute(this.q);
    for (let i = 0; i < this.data.bodies.length; i++) {
      const b = this.data.bodies[i];
      const o = this.links[b.name];
      o.quaternion.set(b.quat[0], b.quat[1], b.quat[2], b.quat[3]);
      const j = this.kin.jointOf[i];
      if (j >= 0) {
        const h = this.q[j] / 2;
        const s = Math.sin(h);
        const ax = b.joint!.axis;
        const qx = ax[0] * s, qy = ax[1] * s, qz = ax[2] * s, qw = Math.cos(h);
        const { x, y, z, w } = o.quaternion;
        o.quaternion.set(w * qx + x * qw + y * qz - z * qy, w * qy - x * qz + y * qw + z * qx, w * qz + x * qy - y * qx + z * qw, w * qw - x * qx - y * qy - z * qz);
      }
    }
    this.root.updateMatrixWorld(true);
  }

  /** tool-centre point (gripperframe site), bay frame, metres */
  tcp(): Vec3 {
    const o: Vec3 = [0, 0, 0];
    this.kin.tcp(o);
    return o;
  }
  jointAnchor(j: number): Vec3 {
    const o: Vec3 = [0, 0, 0];
    this.kin.anchor(j, o);
    return o;
  }
  jointAxis(j: number): Vec3 {
    const o: Vec3 = [0, 0, 0];
    this.kin.jointAxis(j, o);
    return o;
  }
  /** unit vector from the wrist toward the fingertips; (0, 0, -1) when the gripper points down */
  approachAxis(): Vec3 {
    const o: Vec3 = [0, 0, 0];
    this.kin.approach(o);
    return o;
  }
  /** unit jaw closing axis (fixed jaw -> moving jaw), bay frame */
  jawAxis(): Vec3 {
    const o: Vec3 = [0, 0, 0];
    this.kin.jawAxis(o);
    return o;
  }
  /** world pose of a body: position and quaternion [x, y, z, w] */
  bodyPose(name: string): { pos: Vec3; quat: Quat4 } {
    const i = this.kin.names.indexOf(name);
    if (i < 0) throw new Error(`so101: no body ${name}`);
    const p = this.kin.wpos, q = this.kin.wquat;
    return { pos: [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]], quat: [q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3]] };
  }
  /** fixed-jaw and moving-jaw pad face centres, bay frame */
  padFaces(): { fixed: Vec3; moving: Vec3 } {
    const k = this.kin;
    const fixed: Vec3 = [0, 0, 0];
    const moving: Vec3 = [0, 0, 0];
    k.point(k.gripperBody, this.fixedFace[0], this.fixedFace[1], this.fixedFace[2], fixed);
    k.point(k.movingJawBody, this.movingFace[0], this.movingFace[1], this.movingFace[2], moving);
    return { fixed, moving };
  }
  /** jaw gap (m): moving pad face minus fixed pad face, measured along the jaw axis */
  jawGap(): number {
    const { fixed, moving } = this.padFaces();
    this.kin.jawAxis(this.tmp);
    const t = this.tmp;
    return (moving[0] - fixed[0]) * t[0] + (moving[1] - fixed[1]) * t[1] + (moving[2] - fixed[2]) * t[2];
  }
  /** a point given in the gripper body frame, in the bay frame */
  gripperPoint(local: Vec3): Vec3 {
    const k = this.kin;
    k.point(k.gripperBody, local[0], local[1], local[2], this.tmp2);
    return [this.tmp2[0], this.tmp2[1], this.tmp2[2]];
  }
  /** pad face centres in the gripper body frame (fixed) and moving-jaw body frame (moving) */
  padFacesLocal(): { fixed: Vec3; moving: Vec3 } {
    return { fixed: [...this.fixedFace] as Vec3, moving: [...this.movingFace] as Vec3 };
  }
}
