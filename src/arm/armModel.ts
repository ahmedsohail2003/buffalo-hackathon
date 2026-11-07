// three.js Object3D tree for the SO-ARM100, ported from the portfolio work-cell
// page (repos/ahmedsohail2003.github.io/workcell/index.html:1687-1701).
// Only three math/scene-graph classes are imported so vitest (node) can run FK.
//
// Frames: `root` carries rotation.x = -PI/2 so that root-local coordinates are the
// MuJoCo root frame (z up) while three world is y up. All *Root() helpers return
// values in the MuJoCo root frame.

import { Object3D, Group, Vector3, Quaternion } from 'three';
import type { Vec3 } from '../contracts';
import type { ArmData, ArmGeom } from './armData';

export interface ArmNode {
  body: Object3D;
  joint: Object3D;
}

export interface ArmJointNode {
  node: Object3D;
  axis: Vector3;
  range: [number, number];
}

export interface BuildOptions {
  /** Optional geom factory (CellScene supplies meshes; tests pass nothing). */
  geom?: (g: ArmGeom) => Object3D;
}

const _p = new Vector3();
const _q = new Quaternion();
const _rootQ = new Quaternion();
const _rootQInv = new Quaternion();

export class ArmModel {
  readonly root: Group;
  readonly nodes: Record<string, ArmNode> = {};
  readonly joints: Record<string, ArmJointNode> = {};
  readonly order: string[];
  readonly tcpLocal: Vector3;
  /** every Object3D produced by the geom factory, for tinting */
  readonly geomNodes: Object3D[] = [];

  constructor(readonly data: ArmData, opts: BuildOptions = {}) {
    this.order = data.order;
    this.tcpLocal = new Vector3(data.tcp[0], data.tcp[1], data.tcp[2]);
    this.root = new Group();
    this.root.name = 'arm-root';
    this.root.rotation.x = -Math.PI / 2;

    for (const b of data.bodies) {
      const body = new Object3D();
      body.name = b.name;
      body.position.set(b.pos[0], b.pos[1], b.pos[2]);
      body.quaternion.set(b.quat[0], b.quat[1], b.quat[2], b.quat[3]); // xyzw as stored
      const j = new Object3D();
      j.name = b.name + ':joint';
      body.add(j);
      if (b.joint) {
        this.joints[b.joint.name] = {
          node: j,
          axis: new Vector3(b.joint.axis[0], b.joint.axis[1], b.joint.axis[2]),
          range: b.joint.range,
        };
      }
      if (opts.geom) {
        for (const g of b.geoms) {
          const m = opts.geom(g);
          j.add(m);
          this.geomNodes.push(m);
        }
      }
      this.nodes[b.name] = { body, joint: j };
      (b.parent ? this.nodes[b.parent].joint : this.root).add(body);
    }
    this.root.updateMatrixWorld(true);
  }

  /** Set joint angles in `data.order`. Accepts 5 (no jaw) or 6 values. */
  setPose(q: ArrayLike<number>): void {
    const n = Math.min(q.length, this.order.length);
    for (let i = 0; i < n; i++) {
      const jt = this.joints[this.order[i]];
      if (jt) jt.node.quaternion.setFromAxisAngle(jt.axis, q[i]);
    }
  }

  /** Current joint angle of one joint (from its quaternion; sign-aware about the axis). */
  jointAngle(name: string): number {
    const jt = this.joints[name];
    const qq = jt.node.quaternion;
    const s = qq.x * jt.axis.x + qq.y * jt.axis.y + qq.z * jt.axis.z;
    return 2 * Math.atan2(s, qq.w);
  }

  /** Recompute world matrices (call after setPose, before any *Root query). */
  update(): void {
    this.root.updateMatrixWorld(true);
  }

  /** TCP (site local to Fixed_Jaw) in the root frame. Calls updateMatrixWorld. */
  tcpRoot(out: Vector3 = new Vector3()): Vector3 {
    this.root.updateMatrixWorld(true);
    out.copy(this.tcpLocal);
    this.nodes.Fixed_Jaw.joint.localToWorld(out);
    this.root.worldToLocal(out);
    return out;
  }

  /** TCP as a plain Vec3. */
  tcp(): Vec3 {
    const v = this.tcpRoot(_p);
    return [v.x, v.y, v.z];
  }

  /** Joint axis and anchor in the root frame (for the IK Jacobian). Assumes update() done. */
  jointRoot(name: string, outAxis: Vector3 = new Vector3(), outAnchor: Vector3 = new Vector3()): { axis: Vector3; anchor: Vector3 } {
    const jt = this.joints[name];
    const body = jt.node.parent as Object3D;
    this.root.getWorldQuaternion(_rootQ);
    _rootQInv.copy(_rootQ).invert();
    // world axis = body-frame axis rotated by the body's world quaternion (the joint's
    // own rotation is about this axis and leaves it invariant), then into root.
    body.getWorldQuaternion(_q);
    outAxis.copy(jt.axis).applyQuaternion(_q).applyQuaternion(_rootQInv).normalize();
    body.getWorldPosition(outAnchor);
    this.root.worldToLocal(outAnchor);
    return { axis: outAxis, anchor: outAnchor };
  }

  /** Fixed_Jaw joint node pose in the root frame. Calls updateMatrixWorld. */
  fixedJawRoot(): { pos: Vec3; quatXYZW: [number, number, number, number] } {
    this.root.updateMatrixWorld(true);
    const j = this.nodes.Fixed_Jaw.joint;
    j.getWorldPosition(_p);
    this.root.worldToLocal(_p);
    this.root.getWorldQuaternion(_rootQ);
    _rootQInv.copy(_rootQ).invert();
    j.getWorldQuaternion(_q);
    _q.premultiply(_rootQInv);
    return { pos: [_p.x, _p.y, _p.z], quatXYZW: [_q.x, _q.y, _q.z, _q.w] };
  }

  /** A local direction of the Fixed_Jaw joint node expressed in the root frame (unit). */
  fixedJawDirRoot(local: Vec3, out: Vector3 = new Vector3()): Vector3 {
    this.root.updateMatrixWorld(true);
    const j = this.nodes.Fixed_Jaw.joint;
    this.root.getWorldQuaternion(_rootQ);
    _rootQInv.copy(_rootQ).invert();
    j.getWorldQuaternion(_q);
    out.set(local[0], local[1], local[2]).applyQuaternion(_q).applyQuaternion(_rootQInv).normalize();
    return out;
  }
}

export function buildArmModel(data: ArmData, opts: BuildOptions = {}): ArmModel {
  return new ArmModel(data, opts);
}
