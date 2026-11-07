# STARHAND architecture

STARHAND simulates a sample-curation bay on a deep-space station. You reach in with your bare hand: the webcam tracks it, and a simulated SO-101 arm follows your hand. Gemini designs new samples and checks the bay through a fixed camera. Code measures every sample and every move against what the real arm can do. ElevenLabs is mission control's voice.

Every line of code in this repository was written during UB Hacking 2026. See [PROVENANCE.md](../PROVENANCE.md).

## Layers

| Layer | Folder | Runs in | What it does |
| --- | --- | --- | --- |
| Arm core | `src/core/` | Node and the browser; must not touch the DOM | Loads the SO-101 model, computes forward and inverse kinematics, steps arm motion and servoing, runs the pick and place primitives, keeps the sample registry and its validator, and runs the bay state and gate |
| Safety | `src/safety/` | Node and the browser | Hand-signal state machine: a dwell before each command fires, with stop, emergency stop, resume, slow and cycle start |
| Teleop | `src/teleop/` | Node and the browser, plus one React pad | Maps the hand to a tool-centre target, detects a pinch-click, and turns it into a shared-autonomy pick or place |
| Fabricator | `src/fabricator/` | Node and the browser, plus one React panel | Turns a shape program into geometry, measures it, applies the grip guardrail, and holds the presets and the Gemini designer |
| Scene | `src/scene/` | Browser | three.js bay: viewer camera, the fixed bay camera for Robotics-ER, the space environment, and sample meshes |
| Gemini | `src/gemini/` | Browser | Client and ledger (direct key in dev, server proxy in prod), the coworker tool loop, Robotics-ER point and verify, Live voice |
| Voice | `src/voice/` | Browser | ElevenLabs speaker (PCM 24 kHz, Quindar tones), mission-control announcer, sound effects |
| UI | `src/ui/`, `src/App.tsx` | Browser | Mission-control layout: Hand pane, Bay view, Mission pane, Log |
| Server | `server/index.mjs` | Node 22, no dependencies | Serves `dist/`, `/api/tts` (ElevenLabs), `/api/gemini/*` (adds the key, limits the allowed models, rate-limits), and `/api/gemini/live-token` |

Every layer talks to the others through `src/contracts.ts`, plus `src/core/index.ts` (constants and factories) and `src/app/bus.ts` (the log, the ledger and events).

## Fixed decisions

- **The arm** is the SO-101 from MuJoCo Menagerie, `robotstudio_so101` (Apache-2.0). `scripts/convert-so101.mjs` converts its MJCF and STL meshes into `public/assets/so101.json`, which holds the bodies, joints, sites and decimated meshes.
- **The model is kinematic only.** There is no physics engine. A sample attaches to the jaw when the jaw closes near it, and a released sample rests on the deck, in containment, or on top of the sample below it. The UI says so.
- **IK** is damped least squares on the four positioning joints, with the gripper held pointing down. Wrist roll is an input, wrapped by π to stay inside its joint range.
- **Bay frame:** z up, base at the origin, and the arm reaches toward −y, where the operator and the bay camera are. If the Menagerie model faces another way at `shoulder_pan = 0`, the converter applies a base yaw.
- **Shared-autonomy teleop.** The hand sets the hover point. Pinching once picks the nearest sample within 35 mm, using the validated `pick` primitive. Pinching again places it, using `placeAt`, or `placeInContainment` over the bin. With no hand in view the arm holds position. STOP freezes the arm because the speed factor drops to 0. ESTOP disables teleop.
- **Safety precedence:** hand signals beat the on-screen panel, which beats the code gate, which beats AI. Gemini can never start, stop, resume or reset the bay.
- **Guardrails for fabricated samples:**
  - grip width 15–45 mm, scaled down to 40 or less
  - height 10–45 mm, scaled down to 40 or less
  - footprint 60 mm or less
  - mass 100 g or less, with a warning above 50 g
  - density set by code from the material
  - spacing between samples of max(40, r_a + r_b + 10) mm
  - one uniform scale; if no scale satisfies every limit, the sample is rejected with a reason that can be spoken
- **The bay camera** is fixed and frames the deck, the samples and the containment bin. The deck stays light, with a 1 cm grid as a scale cue. Decorations such as stars, the planet, glass walls and rim lights go on layer 1, which only the viewer camera renders.
- **Keys** never reach the public bundle. In production the server holds them. `VITE_GEMINI_API_KEY` exists only for local development.
- **Pinned versions:**
  - `@google/genai` 2.23.0. Version 3.0 defaults to API v1, where Live and `auth_tokens` return 404.
  - `@mediapipe/tasks-vision` 0.10.35. Load its WASM from the CDN at the same version.
  - `three` 0.186.0.

## Constants published by `src/core/constants.ts`

These are derived from the SO-101 model tonight, and each one is documented where it is defined.

- `CONTAINMENT_XY`: the containment bin centre.
- `CONTAINMENT_INNER`: the inner size of the bin, at least 74 mm.
- `CONTAINMENT_WALL_H`.
- `Z_HOVER`, `Z_LIFT`: hover and carry heights of the tool-centre point.
- `graspZ(h)`.
- `REACH`: the valid band, `{ rhoMin, rhoMax, bearingMax }` around the shoulder-pan axis.
- `SLOTS`: default sample spots.
- `JAW_OPEN`, `jawForWidth(mm)`.
- `HOME_Q`.
- The bay camera pose.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173 (?sim=1 forces simulated hand input)
npm test
npm run build
npm run server     # optional: key-holding API server on :8787 (Vite proxies /api to it)
```
