"""Cross-check STARHAND's SO-101 forward kinematics against MuJoCo itself.

Usage (run once; the output is a committed test fixture):
    python3 -I scripts/mujoco_fk_check.py <menagerie-so101-dir>/so101.xml src/core/__fixtures__/mujoco-fk.json

For a fixed list of joint poses it records, in the STARHAND bay frame
(p_bay = Rz(-pi/2) * (p_mujoco - [pan_x, pan_y, 0])):
  - the gripperframe site (the TCP) position and its rotation matrix,
  - every joint anchor and axis,
  - the jaw gap: distance along the gripper x axis between the fixed-jaw pad face
    (+x face of fixed_jaw_box4) and the moving-jaw pad face (-x face of moving_jaw_box2).
src/core/model.test.ts compares the TypeScript forward kinematics with these numbers.
"""

import json
import math
import sys

import mujoco
import numpy as np

YAW = -math.pi / 2


def main() -> None:
    xml_path, out_path = sys.argv[1], sys.argv[2]
    m = mujoco.MjModel.from_xml_path(xml_path)
    d = mujoco.MjData(m)

    shoulder = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, "shoulder")
    mujoco.mj_forward(m, d)
    pan_axis = d.xpos[shoulder][:2].copy()
    rz = np.array([[math.cos(YAW), -math.sin(YAW), 0], [math.sin(YAW), math.cos(YAW), 0], [0, 0, 1]])

    def to_bay(p: np.ndarray) -> list[float]:
        q = p.copy()
        q[:2] -= pan_axis
        return [float(v) for v in rz @ q]

    def vec_bay(v: np.ndarray) -> list[float]:
        return [float(x) for x in rz @ v]

    site = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_SITE, "gripperframe")
    gripper = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, "gripper")
    fixed_pad = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, "fixed_jaw_box4")
    moving_pad = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, "moving_jaw_box2")
    joint_names = [mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_JOINT, j) for j in range(m.njnt)]

    poses = [
        [0, 0, 0, 0, 0, 0],
        [0.0, -1.2, 1.4, 1.2, 0.0, 0.3],
        [0.5, -0.4, 0.8, 1.1, 0.7, 0.9],
        [-0.8, 0.3, -0.2, 0.6, -1.5, 0.1],
        [1.2, -1.0, 1.6, -0.5, 2.4, 1.6],
        [-1.6, 1.1, -1.3, 1.5, -2.6, -0.15],
        [0.25, 0.75, 0.35, -1.2, 1.0, 0.5],
    ]
    out = {
        "generator": "scripts/mujoco_fk_check.py",
        "mujoco": mujoco.__version__,
        "panAxisMj": [float(v) for v in pan_axis],
        "yaw": YAW,
        "joints": joint_names,
        "poses": [],
    }
    for q in poses:
        d.qpos[:] = q
        mujoco.mj_forward(m, d)
        gx = d.xmat[gripper].reshape(3, 3)[:, 0]
        fx = d.geom_xmat[fixed_pad].reshape(3, 3)[:, 0]
        mx = d.geom_xmat[moving_pad].reshape(3, 3)[:, 0]
        fixed_face = d.geom_xpos[fixed_pad] + fx * m.geom_size[fixed_pad][0]
        moving_face = d.geom_xpos[moving_pad] - mx * m.geom_size[moving_pad][0]
        gap = float(np.dot(moving_face - fixed_face, gx))
        rot = (rz @ d.site_xmat[site].reshape(3, 3)).tolist()
        out["poses"].append(
            {
                "q": q,
                "tcp": to_bay(d.site_xpos[site]),
                "tcpRot": rot,
                "anchors": [to_bay(d.xanchor[j]) for j in range(m.njnt)],
                "axes": [vec_bay(d.xaxis[j]) for j in range(m.njnt)],
                "jawGap": gap,
                "fixedPadFace": to_bay(fixed_face),
                "movingPadFace": to_bay(moving_face),
            }
        )
        print(f"q={q} tcp={np.round(out['poses'][-1]['tcp'], 5)} jawGap={gap * 1000:.2f} mm")

    gaps = []
    for g in np.linspace(m.jnt_range[5][0], m.jnt_range[5][1], 23):
        d.qpos[:] = 0
        d.qpos[5] = g
        mujoco.mj_forward(m, d)
        gx = d.xmat[gripper].reshape(3, 3)[:, 0]
        fx = d.geom_xmat[fixed_pad].reshape(3, 3)[:, 0]
        mx = d.geom_xmat[moving_pad].reshape(3, 3)[:, 0]
        fixed_face = d.geom_xpos[fixed_pad] + fx * m.geom_size[fixed_pad][0]
        moving_face = d.geom_xpos[moving_pad] - mx * m.geom_size[moving_pad][0]
        gaps.append([float(g), float(np.dot(moving_face - fixed_face, gx))])
    out["jawGapTable"] = gaps
    print("jaw gap table (rad, mm):", [(round(a, 3), round(b * 1000, 2)) for a, b in gaps])

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main()
