# Submission — EmberHacks 2026 ("Give AI a way to interact with the world")

Paste-ready fields. Confirm the platform's exact field names before submitting
(Devpost assumed). Fill the `<…>` placeholders at freeze.

## Title

The cell — a robot work cell you instruct the way you'd instruct a coworker.

## Tagline (≤ 60 chars)

Voice in, Gemini plans and verifies, gestures keep it safe.

## Description (≤ 150 words)

A browser work cell with a 3D SO-ARM100. You talk to it. Gemini 3.8 Live is
the coworker's voice: it listens on hold-to-talk, asks one question when a
request is ambiguous, negotiates part sizes, and hands tasks to Gemini
Robotics-ER 2, its eyes: ER looks at the fixed cell camera, points at the
part you named (localization error against ground truth shown in mm), plans,
drives the arm through validated tool calls and verifies every step from a
fresh frame before continuing. Gemini 3.8 Flash runs the same coworker over
typed text. Code is the trust boundary: size, reach and cell-state checks,
exact coordinates. Hand gestures recognised on-device (MediaPipe) remain the
safety channel and override everything: open palm freezes the arm mid-move
and pauses the task, thumbs-up resumes it, a held fist e-stops and aborts;
Gemini's motion tools are refused while the cell is stopped. Every model call
is on screen with model, thinking level, latency, tokens and cost.

## How Gemini is used in the loop

- `gemini-3.8-live` — voice in/out, clarifying questions, tools
  `run_task` / `create_object` / `decorate_object` / `point_at` /
  `describe_scene` / `cell_status` / `cancel_task` / `remove_object`.
  Interprets "add a blue cylinder 30 mm wide to the right of the red block"
  into a validated part spec, reads the size back, and negotiates when the
  spec is rejected. `run_task` is NON_BLOCKING and completion arrives as a
  spoken `[CELL EVENT]`.
- `gemini-robotics-er-2-preview` — pointing on rendered cell frames → mm
  error vs registry (typically 1 mm); agentic plan/act loop via function
  calling with a fresh frame after every action; per-step verification;
  narrates its plan (thought summary shown and spoken); grasp-feasibility
  check on every created part; thinking HIGH for plan, LOW for
  act/verify/point. Tool results are authoritative; ER's frame verdict is
  advisory and disagreements are shown, never hidden.
- `gemini-3.1-flash-lite-image` (Nano Banana 2 Lite) — prints a generated
  label, logo or pattern onto a part's faces (`decorate_object`, ~2.6 s,
  ≈$0.02); the print renders into the cell camera. Honest limit: at ~40 px
  per part ER sees that a part is printed but cannot read which print.
- `gemini-3.8-flash` — typed coworker path with the same tools; fallback
  brain.
- No physics: parts snap to the gripper within 15 mm and rest on the table,
  the tray floor or the part beneath them, so parts can be stacked.
- DEMO_MODE: `planLevel=HIGH`, `consensusN=1`, `fcShape=A`, `pointSchema=ON`,
  `highLevelOnly=true`, `attachRadius=15`. Fallbacks taken: none.

## Tech / APIs

Gemini API via `@google/genai` 2.23 web build (Live API WebSocket with
NON_BLOCKING tools and manual activity signals; `generateContent` with
function calling, JSON-schema structured output and thinking levels);
MediaPipe Tasks Vision GestureRecognizer; three.js 0.186; React 18 + Vite 5 +
TypeScript; vitest; Web Audio (16 kHz PCM in / 24 kHz PCM out); MuJoCo 3.10
offline for fixture generation only.

## Team

Ahmed Sohail Butt (+ teammates as registered): `<names / MLH registration>`.

## Links

- Repository: `<https://github.com/ahmedsohail2003/emberhacks-cell>` (tag `freeze`)
- Video (≤ 2 min): `<unlisted link — backup rehearsal recording or final take>`
- Export JSON evidence: `docs/gates/G3-export.json` in the repository

## Provenance / disclosure (verbatim in README)

> **Pre-existing before EmberHacks:** the HandSignal app (webcam gesture
> recognition, gesture state machine, cobot cell state model, telemetry,
> guided demo and its 28 tests; github.com/ahmedsohail2003/handsignal, commit
> `a8d643b99d90355c67cf607fd721cf40c35d40a3`); the SO-ARM100 meshes, joint
> data and keyframes vendored from my portfolio work-cell page (commit
> `04e4c25a55c17bf8d49731027f25156532d23a58`; meshes from MuJoCo Menagerie
> `trs_so_arm100`, Apache-2.0); the damped-least-squares IK formulation from
> my `workcell-partA-imitation` MuJoCo project (commit
> `5822ac1dd508c92183fd8ecc99f91d6ec386549b`). **Built during the hackathon:**
> the three.js cell inside HandSignal, browser FK/IK validated against MuJoCo
> fixtures generated today (heights re-derived for a kinematic arm: grasp
> 27 mm instead of the physics-stalled 15 mm, retreat 90 mm instead of the
> unreachable 120 mm), the motion executor and pick/place primitives, the
> object registry and validator, the fixed cell camera with ER point
> un-projection, all Gemini integration (Live voice, Robotics-ER
> pointing/planning/verification, Flash text path, telemetry and cost
> accounting), the coworker console, and these disclosures. There is no
> physics: parts snap to the gripper when the jaw closes within 15 mm of
> them. Nothing here controls a real robot. Fallbacks taken today: `<from
> PROGRESS.md, or "none">`.
>
> **What leaves this machine:** microphone audio while TALK is held in a
> connected voice session (Gemini Live); rendered cell-camera frames during
> tasks (Gemini Robotics-ER); nothing else. Gesture recognition stays
> on-device. Webcam frames never leave this machine in this build. HandSignal
> previously stated all processing was on-device; that is no longer true here
> and the top-bar counters say so. The API key lives in this browser build;
> never deploy `dist/`.

## Video shot list (≤ 2 min, two continuous takes, plan wait trimmed and stated on screen)

- Take 1 (≈60 s): ✌ Victory → RUNNING. Hold TALK: "Put the red block in the
  tray." → Live "On it." → console: `ER point … err N mm`, `ER plan … s $`,
  `TOOL pick`, `ER check ✓`. Open palm mid-carry → arm freezes, `PAUSED: cell
  STOPPED`, Live: "Cell stopped, I'll wait." Thumbs-up → `RESUMED`, `TOOL
  place_in_tray`, `ER check ✓`, `ER done ✓`, Live: "Done, the block is in the
  tray."
- Take 2 (≈30 s): "Add a blue cylinder about 30 mm wide, 60 mm to the right
  of the red block." → cylinder appears. "Make it 70 mm." → spoken rejection
  quoting 45 mm. "Put the cylinder in the tray." → during the carry, closed
  fist 1.5 s → arm red, `ABORTED: EMERGENCY STOP`, Live: "Emergency stop. I
  won't move until you reset it on the panel." → two-step reset.
- Tail (10 s): egress badge close-up; exported JSON `gemini[]` entries; one
  sentence on camera naming what pre-existed.
