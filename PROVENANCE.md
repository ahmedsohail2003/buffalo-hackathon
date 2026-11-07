# Provenance: what existed before UB Hacking 2026

UB Hacking asks every team to say what they built during the event and what existed beforehand. This file is that disclosure.

## The commit that holds the pre-existing work

One commit holds all the work that existed before the event. Its message starts with `Vendor pre-existing EmberHacks cell`. It is a copy of the tree of [`ahmedsohail2003/emberhacks-cell`](https://github.com/ahmedsohail2003/emberhacks-cell) at commit `18a8e1f`, which was frozen on 2026-09-19 at EmberHacks 2026.

The copy changes no file contents. It only moves files and merges one file:

| In `emberhacks-cell@18a8e1f` | In this repository |
| --- | --- |
| `README.md`, `PLAN.md`, `PROGRESS.md` | `docs/emberhacks/` |
| `docs/*` | `docs/emberhacks/*` |
| `.gitignore` | Added to the end of this repository's `.gitignore` |
| Every other file | The same path, unchanged |

To see everything built at UB Hacking, compare that commit with the latest one:

```bash
git diff "$(git log --format=%h --grep='^Vendor pre-existing EmberHacks cell')" HEAD --stat
```

## What the pre-existing EmberHacks cell already did

- It shows a 3D SO-ARM100 robot arm in the browser, using three.js and MuJoCo Menagerie meshes. The arm is kinematic only: there is no physics.
- It checks its forward and inverse kinematics against MuJoCo fixtures.
- It has pick-and-place primitives, an object registry, and a size and reach validator. Objects can only be boxes, cylinders and spheres.
- Gemini Live listens on hold-to-talk and answers by voice. Gemini Robotics-ER points at parts, plans, and checks each step. Gemini Flash runs the same tools from typed text.
- MediaPipe recognizes safety gestures on the device: open palm means stop, held fist means emergency stop, thumbs-up means resume.

For the full EmberHacks disclosure, see [`docs/emberhacks/README.md`](docs/emberhacks/README.md#provenance). That project was itself built on an earlier one, HandSignal.

## Built during UB Hacking 2026 (November 7–8)

Every commit after the vendor commit. The project README describes these features.
