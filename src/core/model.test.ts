import { describe, expect, it } from 'vitest';
import { Object3D, Quaternion, Vector3 } from 'three';
import fk from './__fixtures__/mujoco-fk.json';
import { ArmModel, JOINT_NAMES, decodeMesh } from './model';
import { HOME_Q, jawGapAt, rhoOf } from './constants';
import { armData, dist3 } from './testutil';

describe('so101.json + ArmModel', () => {
  it('loads every body, the six joints, the tcp site and the jaw pads', async () => {
    const d = await armData();
    expect(d.format).toBe('starhand-so101/1');
    expect(d.bodies.map((b) => b.name)).toEqual(['base', 'shoulder', 'upper_arm', 'lower_arm', 'wrist', 'gripper', 'camera_mount', 'moving_jaw_so101_v1']);
    expect(d.bodies.filter((b) => b.joint).map((b) => b.joint!.name)).toEqual([...JOINT_NAMES]);
    expect(d.sites.gripperframe.body).toBe('gripper');
    expect(d.pads.fixed_jaw_box4).toBeDefined();
    expect(d.pads.moving_jaw_box2).toBeDefined();
    for (const b of d.bodies) expect(Math.hypot(...b.quat)).toBeCloseTo(1, 6);
  });

  it('decodes the quantised meshes inside their bounds', async () => {
    const d = await armData();
    let tris = 0;
    for (const m of Object.values(d.meshes)) {
      const { positions, indices } = decodeMesh(m);
      expect(positions.length).toBe(m.count * 3);
      expect(indices.length).toBe(m.tris * 3);
      let maxIndex = 0;
      for (let i = 0; i < indices.length; i++) maxIndex = Math.max(maxIndex, indices[i]);
      expect(maxIndex).toBeLessThan(m.count);
      let outside = 0;
      for (let i = 0; i < positions.length; i++) {
        const k = i % 3;
        if (positions[i] < m.min[k] - 1e-6 || positions[i] > m.max[k] + 1e-6) outside++;
      }
      expect(outside).toBe(0);
      tris += m.tris;
    }
    expect(tris).toBeGreaterThan(30000);
  });

  it('matches MuJoCo forward kinematics (tcp, rotation, joint anchors and axes) to 1e-6 m', async () => {
    const m = new ArmModel(await armData());
    expect(fk.poses.length).toBeGreaterThanOrEqual(7);
    for (const p of fk.poses) {
      m.setPose(p.q);
      expect(dist3(m.tcp(), p.tcp)).toBeLessThan(1e-6);
      for (let j = 0; j < 6; j++) {
        expect(dist3(m.jointAnchor(j), p.anchors[j])).toBeLessThan(1e-6);
        expect(dist3(m.jointAxis(j), p.axes[j])).toBeLessThan(1e-6);
      }
      // gripperframe x axis is the approach axis; MuJoCo stores the site rotation matrix by rows
      const appr = m.approachAxis();
      const col0 = [p.tcpRot[0][0], p.tcpRot[1][0], p.tcpRot[2][0]];
      expect(dist3(appr, col0)).toBeLessThan(1e-6);
      expect(Math.abs(m.jawGap() - p.jawGap)).toBeLessThan(1e-6);
    }
  });

  it('reaches toward -y at shoulder_pan = 0 with the pan axis on the bay z axis', async () => {
    const m = new ArmModel(await armData());
    m.setPose([0, 0, 0, 0, 0, 0]);
    const t = m.tcp();
    expect(t[1]).toBeLessThan(-0.3);
    expect(Math.abs(t[0])).toBeLessThan(0.002);
    const pan = m.jointAnchor(0);
    expect(Math.hypot(pan[0], pan[1])).toBeLessThan(1e-7);
    // positive pan turns the arm toward -x (the operator's left)
    m.setPose([0.5, 0, 0, 0, 0, 0]);
    expect(m.tcp()[0]).toBeLessThan(-0.1);
  });

  it('puts the tcp at HOME in a plausible spot: in front, low, inside the reach band edge', async () => {
    const m = new ArmModel(await armData());
    m.setPose(HOME_Q);
    const t = m.tcp();
    expect(t[1]).toBeLessThan(0);
    expect(t[2]).toBeGreaterThan(0.06);
    expect(t[2]).toBeLessThan(0.1);
    expect(rhoOf(t[0], t[1])).toBeLessThan(0.13);
    expect(m.approachAxis()[2]).toBeLessThan(-0.95);
  });

  it('jaw gap follows the closed form and the MuJoCo table', async () => {
    const m = new ArmModel(await armData());
    for (const [g, gap] of fk.jawGapTable) {
      m.setPose([0, 0, 0, 0, 0, g]);
      expect(Math.abs(m.jawGap() - gap)).toBeLessThan(1e-6);
      expect(Math.abs(jawGapAt(g) - gap)).toBeLessThan(2e-6);
    }
  });

  it('places every visual mesh where MuJoCo does (world bounding boxes within 1.5 mm)', async () => {
    const d = await armData();
    const m = new ArmModel(d);
    m.setPose(fk.geomBoxes.q);
    const boxes = fk.geomBoxes.boxes;
    let checked = 0;
    for (const b of d.bodies) {
      const pose = m.bodyPose(b.name);
      const bq = new Quaternion(...pose.quat);
      for (const g of b.geoms) {
        const ref = boxes.find((x) => x.body === b.name && x.mesh === g.mesh);
        expect(ref, `${b.name}/${g.mesh}`).toBeDefined();
        const { positions } = decodeMesh(d.meshes[g.mesh]);
        const gq = new Quaternion(...g.quat);
        const v = new Vector3();
        const lo = [Infinity, Infinity, Infinity];
        const hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < positions.length; i += 3) {
          v.set(positions[i], positions[i + 1], positions[i + 2]).applyQuaternion(gq).add(new Vector3(...g.pos)).applyQuaternion(bq).add(new Vector3(...pose.pos));
          const a = [v.x, v.y, v.z];
          for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k], a[k]);
            hi[k] = Math.max(hi[k], a[k]);
          }
        }
        for (let k = 0; k < 3; k++) {
          expect(Math.abs(lo[k] - ref!.min[k]), `${b.name}/${g.mesh} min[${k}]`).toBeLessThan(1.5e-3);
          expect(Math.abs(hi[k] - ref!.max[k]), `${b.name}/${g.mesh} max[${k}]`).toBeLessThan(1.5e-3);
        }
        checked++;
      }
    }
    expect(checked).toBe(boxes.length);
  });

  it('builds the Object3D tree and calls the mesh factory once per visual geom', async () => {
    const d = await armData();
    let n = 0;
    const m = new ArmModel(d, {
      meshFactory: ({ geometry }) => {
        n++;
        expect(geometry.getAttribute('position').count).toBeGreaterThan(0);
        return new Object3D();
      },
    });
    expect(n).toBe(d.bodies.reduce((s, b) => s + b.geoms.length, 0));
    expect(m.links.gripper.parent?.name).toBe('wrist');
    // the render tree agrees with the fast kinematics
    m.setPose([0.3, -0.5, 0.8, 1.1, 0.4, 0.2]);
    const site = d.sites.gripperframe;
    const o = new Object3D();
    o.position.set(...site.pos);
    m.links.gripper.add(o);
    m.root.updateMatrixWorld(true);
    const w = o.getWorldPosition(o.position.clone());
    expect(dist3([w.x, w.y, w.z], m.tcp())).toBeLessThan(1e-6);
  });
});
