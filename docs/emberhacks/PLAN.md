# The cell — a simulated SO-ARM100 work cell you instruct by voice the way you'd instruct a coworker, with Gemini seeing, planning and verifying, and on-device hand gestures as the safety channel (EmberHacks 2026 build plan)

Repo: `C:\Users\sohai\Documents\EmberHacks Hackathon\cell` (copy of HandSignal; `.git` exists on `master` with **zero commits**; `node_modules` present with `three@0.186.0`, `@google/genai@2.23.0`; **`@types/three` NOT installed**; `public/arm-data.json` 328 KB present; `tests/fixtures/mujoco-{fk_samples,ik_grid,jaw_gap_table,reach_envelope,expert_trace}.json` + `ik-truth.json` present; `scripts/smoke.mjs` present but its Live step asks for TEXT; no `.env.local`; baseline `npx vitest run` = 28 passed). Verified 12:25 EDT.

Clock anchor: **12:40**. Freeze **15:30**. Submit **16:00**. 170 build minutes, three parallel sessions (A = arm/scene/App, B = Gemini, C = relabel/docs), four checker gates.

Decisions locked (do not reopen): auto CYCLE_START from IDLE when a task starts (logged); `run_task` answered immediately with an ack, completion via `[CELL EVENT]`; ER loop = function calling with the turn shape validated by the smoke, structured-plan mode as fallback; grasps always use registry ground truth (ER's localization error is measured and displayed); idle keyframe loop, unions, paper pick-list, labels/Nano Banana, video textures, Lyria, fleetline, Antigravity all dropped; simplified three.js look is the default; consensus pointing off in demo mode; plan thinking level chosen from measured latency.

---

## 0. Setup checklist for the human (everything blocking, first; 12:25–12:50)

1. **API key (12:30).** https://aistudio.google.com/api-keys → Create key in the project holding the $40 credits. Keys created after 2026-05-28 are "auth keys", restricted to the Gemini API by default [gemini facts: api-key doc]. If the row shows **Unrestricted**: hover → Add restrictions → **Restrict to Gemini API only** → Restrict key. Do **not** add HTTP-referrer or IP restrictions (none documented for localhost; they can block the Live WebSocket). On the same page confirm the project's billing tier is not "Restricted/Unavailable" (that is a different 403 [forum facts]).
2. **Write the key** to `cell\.env.local` as one line `VITE_GEMINI_API_KEY=AIza...` (gitignored by `*.local`, verified in `.gitignore`). Never paste it into chat. After worktrees exist (A0), copy it: `Copy-Item cell\.env.local cell-b\.env.local; Copy-Item cell\.env.local cell-c\.env.local`.
3. **Rate limits (12:35).** Open https://aistudio.google.com/rate-limit; paste the RPM/TPM for `gemini-robotics-er-2-preview`, `gemini-3.8-live` (sessions), `gemini-3.8-flash` into `PROGRESS.md` header (rate limits are unpublished per model [gemini facts]).
4. **Chrome** (not Edge): at http://localhost:5173 allow microphone and camera when prompted. Close other apps using the webcam. Laptop speakers for output; hold-to-talk (not open mic) is enforced by the app, so headphones are optional.
5. **Submission platform (13:00).** Confirm whether EmberHacks uses Devpost and copy its exact required fields into `docs/SUBMISSION.md` (Track C fills it). Confirm team registration/MLH names.
6. **GitHub**: create an empty public repo (suggested `emberhacks-cell`; no README). `gh auth status` logged in. Push happens at Gate 4 only.
7. **Recording**: test a 30 s screen recording with system audio + mic now (Win+G Game Bar or OBS). Phone hotspot paired to the laptop as network backup. HDMI adapter + charger + external speaker in the bag.
8. **Three sessions**: open Claude Code session A in `cell` (Fable high), session B in `cell-b` (Fable high) after A0 creates it (~12:52), session C in `cell-c` (Fable medium) at 14:15. Checker sessions (Fable Ultra) at 13:50, 14:40, 15:05, 15:30 in `cell`.
9. **Commit rule** (global CLAUDE.md): builders show `git diff --cached --stat` and wait for your "yes"; answer fast. No attribution trailers; author Ahmed Sohail Butt. If you are away, builders keep working and batch the commit at the next gate — no step waits on a commit.

---

## 1. Architecture

### 1.1 Models and jobs

| Model id | Job | Where |
|---|---|---|
| `gemini-3.8-live` | ears/voice/personality: hold-to-talk audio in, 24 kHz audio out, clarifying questions, tool calls `run_task, create_object, point_at, describe_scene, cell_status, cancel_task, remove_object` | `src/gemini/live.ts` |
| `gemini-robotics-er-2-preview` (fallback `gemini-3.8-flash`, never ER-1.6: deprecated end of Aug 2026 [gemini facts: robotics-overview]) | eyes + planner: pointing on rendered cell frames (localization error vs ground truth in mm), plan + per-step tool calls in an agentic loop, per-step verification from a fresh frame, grasp-feasibility check on created parts | `src/gemini/er.ts`, `src/gemini/erLoop.ts` |
| `gemini-3.8-flash` | the same coworker over typed text (same tool declarations, function calling); whole voice brain in FALLBACK-VOICE; ER fallback for point/verify/plan | `src/gemini/console.ts` |

Code is the trust boundary: every tool call passes `gate(cell state) → validator → IK pre-check` before anything moves; rejections return as speakable sentences; the registry (ground truth) drives motion; ER's opinion is measured, shown, and never hidden. Pricing (per M tokens, through 2026-12-31): ER $1/$5, Flash $0.75/$3.75, Live audio $0.005/min in, $0.018/min out, Live text $0.75/$4.50 [gemini facts: pricing]. Cost is cents; RPM and latency are the constraints.

### 1.2 Data flow

```
webcam → MediaPipe (on-device) → gesture state machine → CobotCell (IDLE/RUNNING/SLOW/STOPPED/ESTOPPED)   [unchanged]
                                                            │ speedFactor 1/0.5/0 ──► ArmController.step(dt·f)  (STOP freezes mid-move; ESTOP abortAll)
mic (hold TALK) → 16 kHz PCM → Live ── toolCall ──► dispatcher ── gate/validator ──► primitives ──► three.js scene
                                   ◄─ [CELL EVENT] ─┘                                     │
typed text → Flash (or ER-direct) ─┘                                                       ▼
ER loop: cellCam frame (768², second renderer) → point → plan/act (function calls) → primitive → fresh frame → verify → next …
every call → telemetry bus → strip line + ledger row + export JSON + egress badge
```

Frames: MuJoCo root frame (x right, y toward +y = away from camera, z up, metres) everywhere in data; three world = (x, z, −y) [arm3d facts]. Cell camera at MuJoCo (0,−0.60,0.42) looking at (−0.04,−0.18,0), fov 45, square 768 — frames base, whole reach band and tray; block at ER [y,x]≈[564,577]; 1 ER unit ≈ 0.75 mm at the block [arm3d facts]. The viewer camera is separate and never used for ER.

### 1.3 Kinematic constants (from MuJoCo probes, not the Python literals)

- Home q = `[0,-1.57,1.57,1.57,-1.57]`, jaw open `0.7`, jaw closed for width w: `jawQForWidth(w_mm)` = piecewise-linear inverse of `tests/fixtures/mujoco-jaw_gap_table.json` (mean of pads 1–2) minus 2 mm; 24 mm → ≈0.11 (physics settled at 0.1127 holding the block) [mujoco facts].
- Pivot at (0,−0.0452,0.0165): `rho = hypot(x, y+0.0452)`, `bearing = atan2(x, −(y+0.0452))` [mujoco facts]. Grasp yaw: `roll = −1.57 + (objYaw − q_rot)` (Wrist_Roll is the finger axis when pointing down) [mujoco facts].
- Heights: hover 0.075; grasp `max(0.027, h/2 + 0.015)` (kinematic equivalent of the physics stall at 0.026; 0.015 pushes fingertips 11 mm through the table); lift/transport/retreat **0.09** (0.10 fails beyond pivot rho 0.21; 0.12 unreachable everywhere); tray lower 0.055; table lower `grasp z + 0.004`; release z = `0.006 + h/2` inside the tray footprint (|dx|,|dy| < 0.037 of (−0.18,−0.13)) else `h/2` [mujoco facts].
- Attach rule (no physics): on jaw close, an object attaches if its centre is within 15 mm (xy) of the tcp and its bottom is within [tcp.z−0.03, tcp.z+0.005]; else `GRASP_MISSED`.
- IK: damped least squares, 4 rows (xyz + down-sum `q1+q2+q3 = 1.57`) × 4 columns (Rotation, Pitch, Elbow, Wrist_Pitch), Wrist_Roll pinned as an input; λ = 1e-3, step clip 0.3, joint clamp, 100 iters, tol 1e-4; returns `{q, err, iters}` and **never throws; callers reject err > 1e-3 m** (Python silently ignored a 13.6 mm retreat error) [ik.py:20-74; mujoco facts].

### 1.4 Validator rules (`src/cell/objects.ts`, code trust boundary)

1. shape ∈ box|cylinder|sphere; graspable width = min(w,d) for box, diameter otherwise: **15–45 mm** (physical jaw 8–95 mm; pads bracket 15–50 safely; 45 leaves ER room to disagree on shape, not width) [mujoco facts]; height 10–60 mm (sphere: = diameter).
2. Position: absolute `x_mm,y_mm`, or `relative_to` ∈ object id | `'tray'` | `'arm'` (= (0,−45)) with `direction` left=−x, right=+x, front=−y (toward camera), behind=+y and `distance_mm` (default 80); if none given, first free of (60,−210), (−60,−210), (0,−180), (110,−190).
3. `rho ∈ [0.13, 0.21]` m and `|bearing| ≤ 1.6` rad; tray exclusion `|x+0.18| < 0.06 ∧ |y+0.13| < 0.06` rejected; centre ≥ 40 mm from every object; ≤ 8 objects.
4. Then **actually run IK** at that xy for hover 0.075 / grasp z / lift 0.09; any err > 1 mm → `UNREACHABLE` with mm.
5. Every rejection: `{ok:false, code, reason, suggestion}` where `reason` is one sentence written for speech, e.g. `"70 mm is wider than the 45 mm the gripper can hold"`, `suggestion: "make it 40 mm?"`.

### 1.5 Cell gate and STOP semantics (deterministic)

- `gate.state()` reads `cellRef.current.state` **at call time** (startDemo replaces the instance, App.tsx:352).
- **New Live/Flash tool calls** that move or change the world (`run_task`, `create_object`, `remove_object`) are rejected while STOPPED/ESTOPPED: `{ok:false, code:'REJECTED_STATE', reason:'the cell is STOPPED by the operator; motion is locked until a thumbs-up resumes it'}`. Read-only tools (`describe_scene`, `cell_status`, `point_at`, `cancel_task`) always answer.
- **Inside a running task**, before every primitive and before every ER call, `gate.waitRunnable(signal)`: RUNNING/SLOW → resolve; IDLE → `cell.apply('CYCLE_START')` + line `TASK START — auto CYCLE START`; STOPPED → emit `PAUSED: cell STOPPED — waiting for thumbs-up`, push `[CELL EVENT] cell stopped mid-task; waiting for the operator` to Live (spoken), await state change (fed from `pushSample` and the e-stop reset), then `RESUMED`; ESTOPPED → reject `REJECTED_STATE ESTOPPED` (task fails, `abortAll`). Mid-segment STOP freezes the motion promise (speedFactor 0), which resumes on thumbs-up. Motion promises have **no timeouts**; only ESTOP or cancel rejects them. Verify is never run on a frozen frame.
- Single-task mutex: module-level `activeTask: {id, text, abort} | null` in `erLoop.ts`; a second `run_task` returns `{ok:false, reason:'a task is already running: "<text>"; say cancel to stop it'}`; `cancel_task`, ESTOP and task end clear it.
- Safety precedence: gestures (MediaPipe, local) > e-stop panel > code gate > Gemini. Gemini cannot stop, resume or reset the cell; the Live prompt says so.

### 1.6 Live session (`src/gemini/live.ts`)

```ts
import { GoogleGenAI, Modality, Behavior, Type } from '@google/genai/web';
session = await ai.live.connect({ model: 'gemini-3.8-live', callbacks, config: {
  responseModalities: [Modality.AUDIO],
  speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
  systemInstruction: LIVE_SYSTEM,
  tools: [{ functionDeclarations: LIVE_TOOLS }],
  inputAudioTranscription: {}, outputAudioTranscription: {},
  realtimeInputConfig: { automaticActivityDetection: { disabled: true } },   // hold-to-talk, no room-noise turns
  contextWindowCompression: { slidingWindow: {} },                            // audio-only cap is 15 min otherwise
  temperature: 0.6 } });
```
- Connect only from the Connect click on a module singleton (StrictMode-safe); both AudioContexts (16 kHz capture, 24 kHz playback) created and `resume()`d in that click handler.
- TALK press → `sendRealtimeInput({activityStart:{}})`, then PCM16 LE 16 kHz base64 chunks `sendRealtimeInput({audio:{data, mimeType:'audio/pcm;rate=16000'}})` while held; release → `activityEnd` + `audioStreamEnd`. Chunks are never sent while not held. `egress.micStreaming = held`.
- Playback: decode `serverContent.modelTurn.parts[].inlineData.data` (24 kHz PCM16) into scheduled `AudioBufferSource`s with a running `nextStartTime`; on `serverContent.interrupted` stop all and reset.
- `toolCall.functionCalls` → dispatcher (§1.5) → `sendToolResponse({functionResponses:[{id, name, response}]})`. `run_task` is `NON_BLOCKING` and answered at once with `response: {ok:true, status:'started', scheduling:'SILENT'}`; completion/failure arrives later via `sendClientContent({turns:[{role:'user',parts:[{text:'[CELL EVENT] task finished: <summary>'}]}], turnComplete:true})`. Pending-id map: `toolCallCancellation.ids` aborts only ids still unanswered (run_task never is), so barge-in cannot kill the arm task. `cancel_task` is the explicit voice cancel.
- `[CELL EVENT]` pushes (spoken) only for: task start-blocked, PAUSED/RESUMED while a task is active, ESTOP, task finished/failed, object rejected. Never per gesture otherwise.
- `goAway.timeLeft` → status pill "session ending — reconnect"; transcripts → telemetry `live` lines.

**LIVE_TOOLS** (zero-argument tools have **no `parameters` key** — an empty OBJECT schema is a 400):
```ts
export const LIVE_TOOLS = [
 { name:'run_task', behavior: Behavior.NON_BLOCKING,
   description:'Hand a manipulation task to the cell vision planner (Gemini Robotics-ER), which sees the cell camera, plans, moves the arm and verifies each step. Returns started immediately; the result arrives later as a [CELL EVENT].',
   parameters:{ type:Type.OBJECT, properties:{ task:{ type:Type.STRING, description:'Plain-language task, e.g. "put the red block in the tray"' } }, required:['task'] } },
 { name:'create_object',
   description:'Add a test part to the table. Sizes in mm. Position: x_mm/y_mm, or relative_to (object id, "tray", "arm") + direction + distance_mm. Code validates size and reach and returns a reason and a suggestion if rejected; propose the suggestion to the operator.',
   parameters:{ type:Type.OBJECT, properties:{ name:{type:Type.STRING}, color:{type:Type.STRING}, shape:{type:Type.STRING, enum:['box','cylinder','sphere']},
     width_mm:{type:Type.NUMBER}, depth_mm:{type:Type.NUMBER}, height_mm:{type:Type.NUMBER}, x_mm:{type:Type.NUMBER}, y_mm:{type:Type.NUMBER},
     relative_to:{type:Type.STRING}, direction:{type:Type.STRING, enum:['left','right','front','behind']}, distance_mm:{type:Type.NUMBER} },
     required:['color','shape','width_mm','height_mm'] } },
 { name:'point_at', description:'Ask the vision model to locate a part by name in the cell camera image; returns where it is and the localization error against the cell registry in mm.',
   parameters:{ type:Type.OBJECT, properties:{ label:{type:Type.STRING} }, required:['label'] } },
 { name:'remove_object', description:'Remove a part from the table by id.', parameters:{ type:Type.OBJECT, properties:{ id:{type:Type.STRING} }, required:['id'] } },
 { name:'describe_scene', description:'List the parts on the table (id, name, colour, shape, size, position), what is held, arm phase and cell state.' },
 { name:'cell_status', description:'Safety state of the cell: IDLE/RUNNING/SLOW/STOPPED/ESTOPPED, speed, whether tasks are accepted, whether a task is running.' },
 { name:'cancel_task', description:'Abort the running task. Not a safety stop.' },
];
```
Responses: `run_task → {ok, status:'started'} | {ok:false, code, reason}`; `create_object → {ok, object_id, x_mm, y_mm, width_mm, graspable?, grasp_reason?} | {ok:false, code, reason, suggestion}`; `point_at → {ok, image_point:[y,x], world_mm:[x,y], error_mm, latency_ms}`; `describe_scene → {cell_state, objects:[{id,name,color,shape,width_mm,height_mm,x_mm,y_mm,held}], arm:{phase, tcp_mm, jaw_open}, task:{active, text, step, of}}`; `cell_status → {state, speed_pct, reset_step, cycles, accepts_tasks, task_active}`; `cancel_task → {ok, aborted}`; `remove_object → {ok}`.

**LIVE_SYSTEM** (verbatim):
```
You are the voice of a small SO-ARM100 robot work cell: a 5-joint arm, a tray, and a few parts on a table. You work beside a human operator like a calm, competent cell technician. Short sentences, plain words, millimetres for sizes, one or two sentences per turn, no lists, no emojis, never narrate tool mechanics.

What you can do: run_task hands a task to the cell's vision planner (Gemini Robotics-ER), which sees the cell camera, plans, moves the arm and verifies each step; create_object adds a test part; point_at, describe_scene and cell_status tell you what is on the table and the cell state. You cannot move the arm any other way and you cannot see the table yourself, so never guess parts, positions or results: call describe_scene or point_at. Say what you are about to do in one short sentence, then call the tool. If a request is ambiguous (which part, where, what size) ask one short question; if it is clear, act.

Safety, non-negotiable: hand gestures are the safety channel and always win. Open palm = stop, closed fist held = emergency stop, thumbs up = resume, pointing up = slow, V sign = cycle start. If anyone asks you to stop the robot, say at once: "I can't stop the cell from here - show an open palm to the camera or use the on-screen stop." If a tool says the cell is STOPPED or in emergency stop, say so and do not retry until the operator resumes (thumbs up; emergency stop needs the two-step reset panel on screen). Never claim a step succeeded unless a tool result or a [CELL EVENT] says so.

Parts: graspable width 15 to 45 mm, height 10 to 60 mm, within reach and not on the tray or on top of another part. When create_object is rejected, repeat the reason in your own words and offer the suggestion it gives; create nothing until the operator agrees. The tray is the drop-off point unless the operator names another spot.

Messages starting with [CELL EVENT] come from the cell itself. Acknowledge them in one short sentence, e.g. "Cell stopped, I'll wait." or "Done, the block is in the tray."
```

### 1.7 ER loop (`src/gemini/erLoop.ts`, generateContent with function calling)

ER tool declarations (`ER_TOOLS`): `pick(object_id:STRING)`, `place_in_tray` (no parameters), `place_at(x_mm:NUMBER, y_mm:NUMBER)`, `move_to(x_mm, y_mm, z_mm)`, `open_gripper`, `close_gripper`, `home` (no parameters), `done(success:BOOLEAN, summary:STRING)`.

```
runTask(text, {signal}):
 0 mutex check; gate.waitRunnable
 1 f0 = capture(); pts = pointAt(f0, names of all objects, n = DEMO.consensusN)   → localization table (mm error per object)
 2 history = [user: [image f0, SCENE_TEXT]]; call ER {systemInstruction: ER_SYSTEM, tools:[{functionDeclarations: ER_TOOLS}],
     toolConfig:{functionCallingConfig:{mode:'ANY'}}, thinkingConfig:{thinkingLevel: DEMO.planLevel}, temperature:0, abortSignal}
 3 loop (≤ 12 iterations, ≤ 20 ER calls, ≤ $1):
     push candidates[0].content verbatim (keeps thoughtSignature parts)
     for each functionCall fc (in order): gate.waitRunnable; res = dispatch(fc) via CellApi (validator + IK + primitive; registry position used for pick);
        f = capture(); v = (fc is pick/place_*/home) ? verifyStep(f, stepText, expectation, LOW) : null
        responsePart = { functionResponse: { id: fc.id, name: fc.name, response: {...res, verify: v},
                         parts: [{ inlineData: { mimeType:'image/jpeg', data: f.jpegB64 } }] } }      // shape A (smoke-validated)
        // shape B if the smoke says A is rejected: user turn [functionResponse parts] then user turn [image, "Frame after executing the above."]
     stop if fc.name === 'done'; else push user turn, call ER {mode:'AUTO', thinkingLevel: LOW}
 4 identical (name+args) call failing 3× → abort with reason; no functionCalls → return {ok:false, summary:text}
 5 return {ok, summary, steps:[{tool, args, ok, verify, latencyMs}], calls, costUsd}
```
Expectations (code-generated): pick → "the {name} is lifted off the table between the gripper jaws"; place_in_tray → "the {name} rests inside the tray and the gripper is open above it"; place_at → "the {name} rests on the table at the new spot, gripper open above it"; home → "the arm is upright and nothing is held". Code verdict (`held`, tray-footprint test) is included as `ok`; ER's verdict as `verify`. Disagreement → telemetry `DISAGREE code=… ER=…`; code's `ok` is what ER receives as the action result, ER decides the next action.

SCENE_TEXT: `Cell state: {state}. Objects (ids, sizes and positions are authoritative): {JSON [{id,name,color,shape,width_mm,height_mm,x_mm,y_mm,held}]}. Your pointing localized: {label} at ({x},{y}) mm, error {e} mm vs registry. Tray at (-180,-130). Task: "{task}". Choose the first tool call.`

**ER_SYSTEM** (verbatim):
```
You control a 5-DOF SO-ARM100 arm in a simulated work cell through tools. You see the cell from a fixed front camera: image right is +x, objects nearer the camera have more negative y, z is up, units are millimetres. The tray (drop-off) is the square container at (-180, -130). The gripper is a two-finger pivoting jaw approaching from above; it closes to 8 mm and opens to about 95 mm; parts 15 to 45 mm wide are graspable.
The object list in the message is authoritative for ids, sizes and positions. Use the image to decide which object the task means, to sequence steps and to judge outcomes. Act one tool call at a time. After each tool you receive its result and a new frame; check the frame before continuing. If a result has ok:false, read the reason and choose a different action or report failure. Never pick while something is held; place before picking another. When the task is complete call done(true, summary). If it cannot be completed after two attempts call done(false, why). Never claim a result the frame does not show.
```

**ER_POINT** (LOW, `responseMimeType:'application/json'`, `responseJsonSchema` = array of `{point:[integer,integer], label:string}`; temperature 0, or 0.4 when consensus n=3) [docs wording, gemini facts]:
```
Point to the following items in the image: {labels}. Point at the centre of each item's top face. The label returned should be the exact requested name. The answer should follow the json format: [{"point": <point>, "label": <label>}, ...]. The points are in [y, x] format normalized to 0-1000. Omit items you cannot see.
```
Parse: fence-strip + JSON.parse; validate 0..1000; consensus = median per coordinate; unproject through `cellCam` onto **z = object height h** (prompt asks for the top face; unprojecting to the centre instead shifts xy by ~11 mm [arm3d facts]); z = 0 for bare table spots. `error_mm = |unprojected − registry xy|`; `matched` = nearest registry object within 25 mm.

**ER_VERIFY** (LOW, JSON `{ok:boolean, observation:string}`):
```
This rendered cell-camera frame was captured after the arm executed: "{step}". Expected outcome: "{expectation}". Judge only from the image and be strict: a part must be between the jaws or inside the tray, not merely near it. Return {"ok": true|false, "observation": "<one sentence>"}.
```

**ER_GRASP** (MEDIUM, JSON `{graspable:boolean, grasp_point:[integer,integer], approach_yaw_deg:number, reason:string}`; COULD item):
```
The gripper is a two-finger pivoting jaw that approaches from above; it opens to about 95 mm, closes to 8 mm and grips reliably between 15 and 45 mm. A new part was just added: {shape}, {width_mm} x {depth_mm} x {height_mm} mm, {color}, at ({x_mm}, {y_mm}). From the image, can it be grasped from above? Return {"graspable": true|false, "grasp_point": [y, x] normalized 0-1000 on the part's top face, "approach_yaw_deg": angle of the jaw closing axis in the image (0 = image horizontal), "reason": "<one sentence>"}.
```

Thinking levels: plan `DEMO.planLevel` (HIGH if the smoke's HIGH latency ≤ 12 s, else MEDIUM — the docs recommend medium [gemini facts]), act LOW, verify LOW, point LOW, grasp MEDIUM, never MINIMAL. Timeouts 15 s LOW / 25 s MEDIUM / 45 s HIGH (`abortSignal`). Retry: one retry on network/5xx after 2 s; on 429 wait `Retry-After` or 4 s once, then fail the call as a red ledger row — **no automatic model switch**. Concurrency-1 queue for all ER calls. Caps: 12 iterations, 20 ER calls, $1 per task, 3 identical failures. `DEMO_MODE = {consensusN: 1, planLevel, maxIdenticalFailures: 3}` in `models.ts`, toggled from the console pane, recorded in PROGRESS.md and README.

FALLBACK-LOOP (F4, only if both function-response shapes fail the smoke): one plan call (JSON `{understanding, clarification_needed|null, impossible_reason|null, steps:[{n, action:'pick'|'place_in_tray'|'place_at'|'home', object_id?, x_mm?, y_mm?, expectation}]}`), code executes steps with gate + verify per step, ≤2 retries per step, one replan with the failure note. Gemini still points, plans and verifies; README says "plan/verify/replan".

### 1.8 On-screen trace (every call, no exceptions)

Telemetry strip line kinds `gemini` (blue) `tool` (teal) `reject` (orange) `live` (purple) + 5th cell "Gemini in the loop" (phase, step i/n, last model·level·ms, running $) + CoworkerPane ledger (last 12 calls: t, model, purpose, level, ms, in/out/thought tokens, $) + plan card (steps ✓/✗ + verify observation) + "What Gemini sees" thumbnail (last 768² frame, ER points yellow, ground truth green, `err N mm`, grasp point orange) + topbar egress badge `LEAVING THIS MACHINE · mic ●/○ · cell frames N · webcam frames 0`. Export JSON gains `gemini: GeminiCallEntry[]`, `geminiTotals`, `demoMode`, `fallbacks`. Example:
```
LIVE ▶ "put the red block in the tray"
ER point LOW 1.4 s  block_1 err 3.1 mm  $0.004
ER plan MEDIUM 6.2 s  1.9k/0.3k/1.1k tok  $0.006
TOOL pick(block_1) → ok held  tcp (0,-230,90) mm
ER check LOW 0.9 s ✓ "the red block is lifted between the jaws"
PAUSED: cell STOPPED — waiting for thumbs-up            RESUMED
TOOL place_in_tray → ok
ER check LOW 1.0 s ✓ "the block rests inside the tray"
ER done ✓ "moved the red block into the tray"  6 calls  $0.02
```

---

## 2. Schedule with gates (12:40 → 16:00 EDT)

| Time | Track A — arm/scene/App | Track B — Gemini | Track C — relabel/docs | Human |
|---|---|---|---|---|
| 12:40–12:52 | A0 baseline, `@types/three`, contracts, commit 0, worktrees | (waits for `cell-b`) | — | key → `.env.local`; rate-limit page; confirm commit 0 |
| 12:52–13:10 | A1 arm model + FK test | B0 fix + run smoke (`cell-b`), decisions in PROGRESS.md | — | copy `.env.local` to worktrees; confirm submission platform |
| 13:10–13:30 | A2 IK + tests | B1 models/client/bus/egress/stubs + browser Live smoke | — | click browser smoke Connect once |
| 13:30–13:50 | A3 controller + primitives + registry + tests | B2 er.ts + tests, B3 erLoop start | — | — |
| **13:50 G1** | checker ≤10 min (A continues) | | | |
| 13:50–14:25 | A4 CellScene + cellCamera + snapshot (35-min box) | B3 erLoop + test (→14:10), B4 CoworkerPane + EgressBadge (→14:25) | — | — |
| 14:25–14:40 | A5 App wiring, keyboard guard, `window.__cell`, merge `track-b` | B5 liveAudio + live.ts | C1 strings relabel (from 14:15) | mic/camera permission; hotspot test |
| **14:40 G2** | checker ≤10 min | | | |
| 14:40–15:05 | A6 validator + object meshes + telemetry 5th cell/export | B6 integration on the real arm: typed ER task → Live → create_object → DEMO_MODE | C2 README/provenance/licences/SUBMISSION.md, merge 15:00 | test by voice; **record the 15:00 rehearsal** |
| **15:05 G3** | checker ≤10 min; rehearsal recording = backup video | | | upload backup video (unlisted) |
| 15:05–15:25 | A7 fixes, presentation CSS, evidence button | B7 grasp check (only if G3 clean) else fixes | C3 fallback lines into README | venue rehearsal at 1280×720 |
| **15:30 G4 FREEZE** | build, tag `freeze`, push (after diff confirm) | | | |
| 15:30–15:50 | — | — | — | final video only if better than the backup; upload |
| 15:50–16:00 | — | — | — | submit (paste from `docs/SUBMISSION.md`) |

### GATE 1 — 13:50 (kinematics + Gemini access). Checker in `cell` and `cell-b`.
1. `cd cell; npx tsc --noEmit` → no output. `npx vitest run` → **≥ 41 passed, 0 failed** (28 + fk 2 + ik 6 + controller 5). `cd ..\cell-b; npx tsc --noEmit` clean; `npx vitest run` → ≥ 32 (28 + er 4).
2. `git -C cell log --oneline` shows commit 0; `git -C cell status --short` does not list `.env.local`.
3. `PROGRESS.md` smoke block has these lines with values: `SMOKE flash PASS`, `SMOKE er2 point schema PASS|SCHEMA-OFF` (points printed), `SMOKE er2 fc shapeA PASS|FAIL, shapeB PASS|FAIL`, `SMOKE er2 latency HIGH __ ms MEDIUM __ ms thoughts __`, `SMOKE live audio PASS` (audio bytes or outputTranscription received), `SMOKE live toolcall PASS` (`cell_status` id round-tripped), `SMOKE live ack+event PASS` (spoken turn after `[CELL EVENT]`), `BROWSER LIVE PASS` (audio played in Chrome from localhost:5174), `DECISION planLevel=…, fcShape=A|B|F4, voice=live|fallback, erModel=…`. Any FAIL has a fallback line with a time.
4. Oversight scan (read only `src/arm/armModel.ts`, `src/arm/ik.ts`, `src/arm/controller.ts`, `src/gemini/client.ts`): `quaternion.set(q[0],q[1],q[2],q[3])` (xyzw, not reordered); tcp transformed from the Fixed_Jaw **joint** node; IK returns err and every caller checks `err > 1e-3`; Wrist_Roll pinned as an input; heights `max(0.027, h/2+0.015)` and 0.09 (no 0.015/0.10/0.12 waypoints); `rho` uses `y + 0.0452`; `getAI()` lazy; camelCase `config.thinkingConfig.thinkingLevel`; no `interactions`; import from `@google/genai/web`.

### GATE 2 — 14:40 (3D cell driven by gestures; safety; trace plumbing). Checker uses Claude Browser on http://localhost:5173/?sim=1 (A runs `npm run dev`).
1. Screenshot: 3D SO-ARM100 at home, red block ahead, tray at left, badge text "3D kinematic model — SO-ARM100 meshes, no physics, not a real robot", third column (Coworker) with a text input, topbar egress badge `cell frames 0`.
2. `read_console_messages onlyErrors` → no "too many active WebGL contexts", no uncaught errors after a reload (StrictMode).
3. `javascript_tool`: `window.__cell.arm.pick('block_1').then(r=>JSON.stringify(r))` → `{"ok":true,...,"held":"block_1"}` and the block visibly rides the jaw; press `1` (hold) mid-lift → arm freezes, banner STOPPED; `3` → continues; `4` → visibly half speed; hold `2` 1.5 s → arm tinted red, telemetry `ABORTED: EMERGENCY STOP`, pending promise rejected `{code:'ABORTED'}`, e-stop panel shown; two-step reset returns IDLE.
4. Type `12345` into the Coworker input → no gesture line appears (keyboard guard on keydown and keyup).
5. `javascript_tool`: `window.__cell.capture().jpegB64.length > 20000`; open the data URL → image as bright as the viewer (not dark), block visible; `window.__cell.projectMujoco([0,-0.23,0.012])` → within ±15 of [564,577].
6. `npx tsc --noEmit` clean; `npx vitest run` → ≥ 55 (adds objects 7, camera 2, erLoop 5, bus 1). `docs/gates/G2-cell.jpg` + `G2-log.txt` saved via the evidence button.
7. Oversight scan (`src/arm/controller.ts`, `src/App.tsx` diff, `src/components/CellScene.tsx`): no `setTimeout` around motion promises; `armRef.current?.abortAll('EMERGENCY STOP')` in the fired branch; `step()` updates the held object's `pos` from the tcp; `capture()` calls `syncScene()` before rendering with the second renderer; cylinders get `rotation.x = Math.PI/2`; keyboard guard is the first statement of both `down` and `up` (before the Escape branch).

### GATE 3 — 15:05 (Gemini in the loop, end to end; rehearsal recorded).
1. Typed (ER-direct) `put the red block in the tray` with egress badge visible before the first call → within 90 s: ≥1 `ER point` line with `err N mm` (N < 15; 15–25 acceptable; >25 = investigate plane height), one `ER plan <LEVEL> N s` line with tokens and $, `TOOL pick(block_1) → ok`, `ER check ✓`, `TOOL place_in_tray → ok`, `ER check ✓`, `ER done ✓`; block inside the tray; 5th cell shows call count and $ < $0.10; ledger rows have ms/tokens/$.
2. Repeat with `1` held during the carry → `PAUSED: cell STOPPED — waiting for thumbs-up` line, arm frozen, no ER call during the pause (ledger idle); `3` → `RESUMED`, task completes. Hold `2` during another run → `ABORTED`, task reports failure, no further tool calls, no console errors.
3. Voice (or FALLBACK-VOICE): Connect → `mic ○`; hold TALK → `mic ●`; "what's on the table?" → `describe_scene` tool line → spoken answer names the red block. "Put the red block in the tray" → `run_task` line, ack `started`, arm moves, spoken sentence after `[CELL EVENT] task finished`. "Add a blue cylinder about 30 mm wide, 60 mm to the right of the red block" → cylinder appears, `create_object → ok`. "Make it 70 mm" → spoken rejection quoting 45 mm and offering a size. Open palm during a voice task → spoken acknowledgement within 3 s.
4. Latency decision: from the ledger, p50 of `ER plan`; if > 15 s → `DEMO.planLevel = MEDIUM` (PROGRESS.md + README); consensusN stays 1 unless RPM ≥ 30.
5. Export JSON (`docs/gates/G3-export.json`) contains `gemini[]` entries with `latencyMs`, `thinkingLevel`, `costUsd`, `purpose`; `docs/gates/G3-cell.jpg` present.
6. Backup video: `docs/gates/rehearsal-1500.mp4` exists (or the operator states its path) and is being uploaded unlisted.
7. Oversight scan (`src/gemini/erLoop.ts`, `src/gemini/live.ts`): mutex; `waitRunnable` before every primitive and ER call; identical-failure cap 3; abort signal checked between steps; `run_task` answered immediately; cancellation honoured only for unanswered ids; `[CELL EVENT]` pushed only for the §1.6 events; chunks sent only while TALK held; `automaticActivityDetection.disabled: true`; `git grep AIza` empty.

### GATE 4 — 15:30 FREEZE.
1. `npm run build` → exit 0; `npx vitest run` green; `git status` clean after commit; `git tag freeze`; pushed to `origin/master` after the operator confirms the diff; `git ls-files | Select-String "\.env"` returns only `.env.example`.
2. `git grep -n -i "on-device only\|2D kinematic\|cartoon\|No gesture data leaves\|no video or gesture data leaves"` → only the README Provenance sentence describing HandSignal's former behaviour.
3. README has sections "How Gemini is used" (three model ids + actual model used + DEMO_MODE values), "Provenance" (§7 text verbatim + source commit hashes), "What leaves this machine", "Run it"; test count in README/DESIGN-NOTES equals the vitest total; `THIRD_PARTY_LICENSES.md`, `.env.example`, `docs/SUBMISSION.md`, `docs/gates/G3-export.json` present; `index.html` title and `package.json` description updated; `AboutPanel`, `HandPane`, `CellPane` strings relabelled.
4. `PROGRESS.md` complete: every step row done/skipped with evidence, gate log, fallbacks list.
5. Backup video uploaded (link in `docs/SUBMISSION.md`).

---

## 3. Step list

Rules for all tracks: absolute paths; vitest runs in node (`vite.config.ts`), so `src/arm/**`, `src/cell/objects.ts`, `src/gemini/{er,erLoop,client,models}.ts` never touch `window`/`document` at import time and import only three math classes (`Object3D, Group, Vector3, Vector2, Quaternion, Matrix4, PerspectiveCamera, Raycaster, Plane`); `tsconfig` has `noUnusedLocals/Parameters` — no WIP imports; run `npx tsc --noEmit` at every "done when". Each step ends by appending its PROGRESS.md row (§8) and staging a commit for the operator.

### Track A (`cell`, master)

**A0 (12:40, 12 min) baseline + contracts + worktrees.**
- `npm i -D @types/three@0.186.0` (missing; `three` ships no types); `npx tsc --noEmit` → clean; `npx vitest run` → 28.
- `src/contracts.ts` (types only, no imports):
```ts
export type Vec3 = [number, number, number];   // MuJoCo root frame, metres, z up
export type CellState = 'IDLE'|'RUNNING'|'SLOW'|'STOPPED'|'ESTOPPED';
export interface SceneObject { id:string; name:string; color:string; shape:'box'|'cylinder'|'sphere'; dims:{w:number;d:number;h:number}; pos:Vec3; yaw:number; held:boolean; createdBy:'seed'|'voice'|'text' }
export interface ObjectSpec { name?:string; color:string; shape:'box'|'cylinder'|'sphere'; width_mm:number; depth_mm?:number; height_mm:number; x_mm?:number; y_mm?:number; relative_to?:string; direction?:'left'|'right'|'front'|'behind'; distance_mm?:number; yaw_deg?:number }
export interface ArmSnapshot { q:number[]; tcp:Vec3; jaw:number; jawOpen:boolean; phase:string; heldId:string|null; queueLen:number }
export type PrimCode = 'REJECTED_STATE'|'UNREACHABLE'|'NO_OBJECT'|'ALREADY_HELD'|'NOTHING_HELD'|'GRASP_MISSED'|'ABORTED';
export type PrimResult = { ok:true; tcp_mm:Vec3; held:string|null; phase:string } | { ok:false; code:PrimCode; reason:string; state?:CellState; err_mm?:number };
export interface ArmApi { pick(id:string):Promise<PrimResult>; placeInTray():Promise<PrimResult>; placeAt(xy:[number,number]):Promise<PrimResult>; moveTo(p:Vec3):Promise<PrimResult>; home():Promise<PrimResult>; open():Promise<PrimResult>; close():Promise<PrimResult>; abortAll(reason:string):void; snapshot():ArmSnapshot }
export type CreateResult = { ok:true; obj:SceneObject; suggestion?:undefined } | { ok:false; code:string; reason:string; suggestion?:string };
export interface ObjectsApi { list():SceneObject[]; get(id:string):SceneObject|undefined; create(spec:ObjectSpec):CreateResult; remove(id:string):boolean; reset():void }
export interface CellGateApi { state():CellState; waitRunnable(signal?:AbortSignal):Promise<void>; onChange(cb:(s:CellState)=>void):()=>void }
export interface FrameCapture { jpegB64:string; w:number; h:number; t:number }
export interface CellApi { arm:ArmApi; objects:ObjectsApi; gate:CellGateApi; capture():FrameCapture; projectMujoco(p:Vec3):[number,number]; unprojectER(yx:[number,number], zPlane:number):Vec3|null }
export interface GeminiCallEntry { t:number; model:string; purpose:'point'|'plan'|'act'|'verify'|'grasp_check'|'live_tool'|'flash_console'; thinkingLevel?:'LOW'|'MEDIUM'|'HIGH'; latencyMs:number; promptTokens:number; outputTokens:number; thoughtTokens:number; costUsd:number; ok:boolean; error?:string }
```
- `PROGRESS.md` (§8 template). `git add -A; git diff --cached --stat` → operator "yes" → `git commit -m "step 0: vendor HandSignal + SO-ARM100 arm-data + MuJoCo fixtures (pre-existing) + contracts"`.
- `git worktree add ..\cell-b -b track-b; git worktree add ..\cell-c -b track-c`; tell the operator to copy `.env.local` and run `npm ci` in each (B/C do it themselves as their first command).
- Done when: commit 0 exists; `cell-b`, `cell-c` exist; tsc clean.

**A1 (12:52, 18 min) `src/arm/armData.ts`, `src/arm/armModel.ts`, `src/arm/fk.test.ts`.**
- `armData.ts`: `ArmData` type (bodies[7] {name,parent,pos,quat[xyzw],joint{name,axis,range}|null,geoms[{mesh,mat}]}, order[6], tcp, wrist_cam, block, tray, front_cam, rgbd_cam, keys[11]{t,q}, grasp[2], meshes{n,tris,lo,span,v,i,i32}); `loadArmData()` = module-cached `fetch(import.meta.env.BASE_URL + 'arm-data.json')`; `loadArmDataNode()` = `JSON.parse(readFileSync(new URL('../../public/arm-data.json', import.meta.url),'utf8'))` (tests only, in the test file itself so the app module stays DOM/FS-free). Constants: `HOME_Q`, `PIVOT`, `TRAY=[-0.18,-0.13]`, `TRAY_HALF=0.037`, `TRAY_FLOOR_Z=0.006`, `JAW_OPEN=0.7`, `Z_HOVER=0.075`, `Z_LIFT=0.09`, `Z_TRAY_LOWER=0.055`, `graspZ(h)=Math.max(0.027, h/2+0.015)`. Provenance comment: MuJoCo Menagerie `trs_so_arm100` (Apache-2.0), vendored from the portfolio work-cell page.
- `armModel.ts`: port `workcell/index.html:1687-1701` exactly: per body `Object3D` with `position.set(...pos)`, `quaternion.set(q[0],q[1],q[2],q[3])` (**xyzw as stored**), child joint `Object3D`, geoms under the joint (only when `{meshes:true}`), child bodies under **the parent's joint node**, Base under `root`; `root.rotation.x = -Math.PI/2`. `setPose(q6)` = `joints[order[i]].node.quaternion.setFromAxisAngle(axis, q[i])`. `tcpRoot(out)`: `root.updateMatrixWorld(true); out.set(-0.005,-0.08,0); nodes.Fixed_Jaw.joint.localToWorld(out); root.worldToLocal(out)`. `jointRoot(name): {axis:Vector3, anchor:Vector3}` in root frame (world axis = joint axis rotated by the joint node's parent world quaternion, then root-inverse). `fixedJawRoot(): {pos, quatXYZW}` = joint node world pos/quat mapped into root. Mesh decode (`index.html:1672-1682`) in `src/arm/armMeshes.ts`.
- `fk.test.ts`: (1) all 60 rows of `mujoco-fk_samples.json`: `|tcpRoot(q) − tcp| < 1e-5`, `|fixedJawRoot.pos − fixed_jaw_pos| < 1e-5`, `|dot(quat, wxyz→xyzw(row.quat))| > 1 − 1e-5`; (2) `keys[2].q` → tcp ≈ (0,−0.230,0.015) ±1e-3; at `keys[0].q` the Fixed_Jaw joint's local −y in root frame ≈ (0,0,−1) ±1e-3.
- Done when: `npx vitest run src/arm` → fk green. **Do not start A2 before this is green.**

**A2 (13:10, 20 min) `src/arm/ik.ts`, `src/arm/ik.test.ts`.**
- `solveIK(model, target:Vec3, q0:number[6], {roll?:number}) → {q:number[5], err, iters}` per §1.3: analytic J (4×4) `col_j = a_j × (p − o_j)` from `jointRoot`, row 4 `[0,1,1,1]`; `A = JJᵀ + 1e-3·I`; Gaussian elimination; `dq = Jᵀ y`; clip ±0.3; clamp ranges; restore `model.setPose(q0)` before returning. Fallback if the analytic tests fail after 10 min: finite differences h=1e-6. Helpers `pivotPolar(x,y)`, `rollForYaw(objYaw, qRot) = -1.57 + (objYaw − qRot)`, `reachProbe(model, xy, h) → worstErrMm` (hover/grasp/lift).
- Tests: (a) (0,−0.23,0.015) from home with roll pinned at `keys[2].q[4]` → err < 1e-3 and `|q[0..3] − keys[2].q[0..3]| < 0.05` (measured 0.016 with roll free [arm3d facts]); (b) (0,−0.23,0.027) from home → err < 1e-3, `|q1+q2+q3−1.57| < 1e-3` (no keyframe comparison — keys[2] is the z=0.015 pose); (c) 20 rows sampled deterministically (every 15th) from `mujoco-ik_grid.json` with `err_m < 1e-3`, `z ≤ 0.075`, `r ≤ 0.25` → `|FK(q_js) − (x,y,z)| < 2e-3` and down-sum < 1e-3, tolerating ≤ 1 failure (logged); (d) (−0.18,−0.13,0.12) → err > 5e-3 (unreachable retreat regression); (e) (0,−0.40,0.015) → err > 0.05 and no throw; (f) (−0.18,−0.13,0.045) from `keys[3].q` → `|q[0..3] − keys[6].q[0..3]| < 0.08` (measured ≤ 0.045; roll ignored).
- Done when: 6 tests green; PROGRESS row records ms per solve (< 15 ms in node).

**A3 (13:30, 22 min) `src/arm/controller.ts`, `src/arm/primitives.ts`, `src/cell/objects.ts` (registry + attach/release only), `src/arm/controller.test.ts`.**
- `ArmController implements ArmApi`: `q[6]`, `phase`, `heldId`, `queue: Segment[]` (`{q0,q1,durS,u,resolve,reject,label}`); `step(dt, speedFactor)`: `u += dt·speedFactor/durS`, `q = lerp(q0,q1,smoothstep(u))`, resolve at u ≥ 1; speedFactor 0 leaves u untouched; `durS = max(0.35, maxΔq/1.5)`; while `heldId`, set that object's `pos` = tcp every step; `abortAll(reason)` rejects all pending with `{ok:false, code:'ABORTED', reason}` and clears. Constructor takes `getCell: () => CobotCell` and `gate: CellGateApi` (real gate in `src/arm/gate.ts`: `waitRunnable` per §1.5, state change fed by `notify()` that App calls from `pushSample` and the e-stop reset).
- Primitives (the ONLY things exposed to Gemini): every one starts `await gate.waitRunnable()`; solves IK for **every** waypoint first (roll = `rollForYaw(obj.yaw, qRot)` two-pass); any `err > 1e-3` → `{ok:false, code:'UNREACHABLE', err_mm}` **before moving**. `pick(id)`: hover → grasp z → `setJaw(jawQForWidth(w))` (0.3 s + 0.6 s hold) → `attachIfGraspable` (§1.3; miss → reopen + `GRASP_MISSED`) → lift 0.09. `placeInTray()`: transport 0.09 → lower 0.055 → open (0.3 s + 0.5 s) → release at `0.006 + h/2` → retreat 0.09. `placeAt(xy)`: lower `graspZ(h)+0.004`. `moveTo`, `home()` (`HOME_Q`, jaw 0.7), `open`, `close`. Phase text per waypoint (`pick: descend`).
- `objects.ts`: `ObjectRegistry implements ObjectsApi` seeded with `block_1` = red 24 mm cube at `data.block` (0,−0.23,0.012), yaw 0, `createdBy:'seed'`; `create()` calls `validateObjectSpec` (full rules land in A6; for now accept-all with the spacing/count rule so tests can seed); `nearest(xy)`.
- Tests: (a) `step(0.1,0)`×50 → q unchanged, promise pending; (b) speed 0.5 takes 2× the frames of speed 1 (±10 %); (c) `abortAll` rejects with `ABORTED`; (d) `pick('block_1')` with a RUNNING stub gate resolves `held:'block_1'`, tcp within 2 mm of (0,−0.23,0.09) when driving `step(1/60,1)` in a loop; (e) STOPPED stub gate → `pick` stays pending, and after `setState('RUNNING')` it completes.
- Done when: `npx vitest run` ≥ 41; tsc clean. → **G1**.

**A4 (13:50, 35-min HARD BOX → 14:25) `src/components/CellScene.tsx`, `src/arm/cellCamera.ts`, `src/arm/camera.test.ts`.**
- Default look = simplified: `MeshStandardMaterial` (white 0xdedede / black 0x222222 per geom `mat`), `HemisphereLight` + one `DirectionalLight`, **no shadows, no tone mapping**, `outputColorSpace = SRGBColorSpace`, floor = 1.2 m plane with a canvas-drawn 1 cm grid (ER scale cue), tray = 5 boxes (`index.html:1708-1711` sizes), tcp = 4 mm sphere, object meshes synced from the registry (`BoxGeometry(w,d,h)` under root; `CylinderGeometry` with `rotation.x = Math.PI/2`; `SphereGeometry`), held object attached to `nodes.Fixed_Jaw.joint` via `Object3D.attach`, back to root on release; arm meshes tinted red when `getCell().state === 'ESTOPPED'`. Viewer camera `PerspectiveCamera(30)` at az 0.62 / el 0.46 / dist 0.86 around three (−0.03,0.07,0.19) (`index.html:1729-1738`), no parallax. `ResizeObserver` on `.cell-stage` → `renderer.setSize(w,h,false)`. StrictMode: `if (stateRef.current) return`; cleanup cancels RAF, `renderer.dispose()`, `forceContextLoss()`, nulls the ref. `syncScene()` = `setPose(arm.q)` + mesh sync + `root.updateMatrixWorld(true)`; RAF calls `syncScene(); renderer.render(scene, viewerCam)`.
- `cellCamera.ts`: `cellCam = PerspectiveCamera(45,1,0.05,5)` at three (0,0.42,0.60), `lookAt(three(−0.04,0,0.18))`, in world; `mujocoToThree=(x,z,−y)`, `threeToMujoco=(X,−Z,Y)`; `projectMujoco(p) → [y,x]` = `Vector3.project(cellCam)` → `y=round((1−ndc.y)/2·1000)`, `x=round((ndc.x+1)/2·1000)`; `unprojectER([y,x], zPlane)` = `Raycaster.setFromCamera(Vector2(x/500−1, 1−y/500), cellCam)` ∩ `Plane((0,1,0), −zPlane)` → `threeToMujoco`. Snapshot: **second** `WebGLRenderer` on a hidden 768×768 canvas, `preserveDrawingBuffer:true`, same colour settings (render targets skip the sRGB/tone-mapping output pass [arm3d facts]); `capture()` = `syncScene(); snap.render(scene, cellCam); toDataURL('image/jpeg', 0.85)` → `{jpegB64, w:768, h:768, t}` and `egress.cellFrames++`.
- `camera.test.ts` (pure three math): `projectMujoco([0,−0.23,0.012])` within ±15 of [564,577]; round trip through `unprojectER(_, 0.012)` returns (0,−0.23) within 1 mm.
- Fallback at 14:25 if nothing renders: drop the grid texture and object meshes; arm + tray + block only. Never spend past 14:30.
- Done when: arm renders in `CellPane`; `capture()` opened in a tab is bright; camera test green.

**A5 (14:25, 15 min) App wiring + merge.**
- `App.tsx`: `armRef`, `objectsRef`, `cellApiRef` beside `cellRef` (59–60), constructed once when `loadArmData()` resolves (pane shows "loading arm…" until then); after `cellRef.current!.tick(dt)` (191) `armRef.current?.step(dt, cellRef.current!.speedFactor())`; in the fired branch (143–154) `if (ev.command==='EMERGENCY_STOP' && accepted) armRef.current?.abortAll('EMERGENCY STOP')` and `gate.notify()` after every `apply`/reset; `startDemo` (352) also `abortAll('guided demo')` + `objectsRef.current?.reset()`; widen `LogLine.kind` (28) with `'gemini'|'tool'|'reject'|'live'`; `slice(-60)` (101) → `-200`; subscribe to `telemetry/bus` in a `useEffect` mapping `performance.now()` through `sessionT`; `UiSync.gemini = {calls, lastLatencyMs, costUsd, phase, stepText}`; export payload (417–424) gains `gemini`, `geminiTotals`, `demoMode`, `fallbacks`; export note (420) reworded.
- **Keyboard guard**: first statement of both `down` (258) and `up` (271), before the Escape branch: `const el = e.target as HTMLElement | null; if (el && (el.tagName==='INPUT' || el.tagName==='TEXTAREA' || el.isContentEditable)) return;`.
- `src/app/refs.ts`: `setCellApi(api)`, `getCellApi()`, `getCell()`; in dev `window.__cell = api`. `CellPane.tsx:81` → `<CellScene …/>`; badge (64) → `3D kinematic model — SO-ARM100 meshes, no physics, not a real robot`; `PhaseReadout` shows `arm.phase`; delete `src/cell/arm.ts`; BANNERS RUNNING/STOPPED wording → "Arm tasks accepted." / "Arm frozen mid-move; Gemini tasks wait for thumbs-up.". `styles.css:154` → `0.9fr 1.3fr 0.9fr`; ~908 breakpoint → `1fr`; `.telemetry` (698) → `1fr 1fr 0.9fr 1.1fr 1.6fr`; log colours next to 800–814; mount `<CoworkerPane/>` (B) as the third column and `<EgressBadge/>` in the header (446).
- `git merge track-b` (disjoint files; resolve `main.tsx` livesmoke line by keeping it) → run tests → stage commit.
- Done when: G2 checks 1–5 pass locally; tsc clean.

**A6 (14:40, 25 min) validator + create path + telemetry cell.**
- `validateObjectSpec(spec, existing, reachProbe)` per §1.4 with 7 tests (accept, width, height, rho/bearing, tray exclusion, spacing/count, unreachable); `objects.create` wires the probe (`reachProbe` from ik.ts using the real model). Object meshes appear via A4 sync. `TelemetryStrip.tsx` 5th cell "Gemini in the loop". `docs/gates/` evidence button (dev only): downloads `G{n}-cell.jpg`, `G{n}-export.json`, `G{n}-log.txt` (last 50 lines); builder moves them with `Move-Item $env:USERPROFILE\Downloads\G*-* docs\gates\`.
- Done when: typed `/create blue cylinder 30 right-of block_1 60` in the console input adds a cylinder; `npx vitest run` ≥ 55.

**A7 (15:05, 20 min) fixes from G3; `?present=1` body class (telemetry 200 px tall, 15 px mono, transcript 16 px); README test count; freeze prep.** Done when: `npm run build` exit 0.

### Track B (`cell-b`, branch track-b; first command `npm ci`; dev server `npm run dev -- --port 5174`)

**B0 (12:52, 18 min) fix and run `scripts/smoke.mjs`.**
- Read the key from `.env.local` if `GEMINI_API_KEY` is unset (5 lines; never print it). Replace/add steps:
  1. `flash text` (keep).
  2. `er2 point schema`: exact production config — `responseMimeType:'application/json'`, `responseJsonSchema` (§1.7), `thinkingConfig:{thinkingLevel:'low'}` on `repos/.../workcell/media/partC_rgbd_rgb.png` (a rendered cell image) asking for "red block, tray, gripper"; on 400 retry without the schema and print `SCHEMA-OFF`.
  3. `er2 fc shapeA/shapeB`: tools `move_to(x_mm,y_mm,z_mm)` + `done(success,summary)`, `mode:'ANY'`, LOW; turn 1 image + "Move above the red block, then call done."; expect a functionCall; turn 2 shape A = user Content with `{functionResponse:{id,name,response:{ok:true}, parts:[{inlineData:{mimeType:'image/png', data}}]}}` (+ `candidates[0].content` pushed verbatim); expect a functionCall/done; if 400 → shape B = functionResponse-only user Content followed by a second user Content `[image, "Frame after executing the above."]`. Print which shape passed.
  4. `er2 latency`: the plan-like prompt of step 3 at `thinkingLevel:'high'` and `'medium'`; print ms and `usageMetadata.thoughtsTokenCount`.
  5. `er1.6 point`: keep, print INFO only (deprecated).
  6. `live audio+toolcall+ack+event`: `responseModalities: [Modality.AUDIO], outputAudioTranscription: {}`, `tools:[{functionDeclarations:[{name:'run_task', behavior:'NON_BLOCKING', parameters:{type:'OBJECT', properties:{task:{type:'STRING'}}, required:['task']}}, {name:'cell_status', description:'Return the cell state'}]}]`; send text "What is the cell status?" → expect `toolCall` `cell_status` → `sendToolResponse({functionResponses:[{id,name,response:{state:'IDLE'}}]})` → PASS when an `inlineData` audio part or `outputTranscription.text` arrives followed by `turnComplete`; then "Run the task: put the block in the tray" → `run_task` toolCall → respond immediately `{result:'started', scheduling:'SILENT'}` → 3 s later `sendClientContent({turns:[{role:'user',parts:[{text:'[CELL EVENT] task finished: block in tray'}]}], turnComplete:true})` → PASS when a spoken/transcribed turn follows; while it speaks send `sendRealtimeInput({text:'okay'})` and print whether a `toolCallCancellation` arrives. Auth failure = 401/403 or WebSocket close 1008 right after connect; a modality/schema error is NOT an auth failure.
- Write the `SMOKE …` and `DECISION …` lines (G1 check 3) into `PROGRESS.md`. Done when: all lines present.

**B1 (13:10, 20 min) `src/gemini/models.ts`, `src/gemini/client.ts`, `src/telemetry/bus.ts`, `src/telemetry/egress.ts`, `src/gemini/stubs.ts`, `src/dev/liveSmoke.ts`.**
- `models.ts`: ids, `ER_MODEL` (decided by B0), `PRICE`, `DEMO` (§1.7). `client.ts`: lazy `getAI()` (`new GoogleGenAI({apiKey: import.meta.env.VITE_GEMINI_API_KEY})` on first use, from `@google/genai/web`); `callER({purpose, level, contents, config, timeoutMs})` = concurrency-1 queue → `ai.models.generateContent` with camelCase config + `abortSignal` → `GeminiCallEntry` from `usageMetadata` (`promptTokenCount, candidatesTokenCount, thoughtsTokenCount`) → `bus.emit`; retry policy §1.7; `stripFences` + `parseJson<T>()`. `bus.ts`: `emit(line:{kind,text}, entry?)`, `subscribe`. `egress.ts`: `{micStreaming, cellFrames, webcamFrames, lastAt}` + subscribe. `stubs.ts`: `StubCell implements CellApi` (300 ms fake motion, plain registry, static 768² JPEG from a base64 constant, `gate.setState()` for tests). `src/dev/liveSmoke.ts` + 3-line guard in `main.tsx`: `?livesmoke=1` renders a Connect button that runs smoke step 6 in the browser and plays the audio. Test: one bus/pricing unit test.
- Done when: tsc clean; operator clicks Connect on http://localhost:5174/?livesmoke=1 → `BROWSER LIVE PASS` line in PROGRESS.md.

**B2 (13:30, 20 min) `src/gemini/er.ts`, `src/gemini/er.test.ts` (mocked `callER`).** `pointAt(cell, labels, n)`, `verifyStep(cell, frame, step, expectation)`, `graspCheck(cell, obj)` per §1.7 with prompts verbatim; tests: median of 3 points; error mm against a fake registry; unproject plane = h; fenced JSON parse; schema-off fallback path. Done when: 4 tests green.

**B3 (13:50, 20 min) `src/gemini/erLoop.ts`, `src/gemini/erLoop.test.ts` (StubCell + mocked `callER`).** Algorithm §1.7 incl. mutex, `waitRunnable`, shape A/B switch from `DECISION`, caps, abort. Tests: 2-step happy path; verify false then true; STOPPED stub → loop waits (no ER call) and finishes after `setState('RUNNING')`; ESTOP → `ABORTED` report; second `runTask` rejected by the mutex. Done when: 5 tests green.

**B4 (14:10, 15 min) `src/components/CoworkerPane.tsx` + `CoworkerPane.css`, `src/components/EgressBadge.tsx` + `EgressBadge.css`.** Column: Connect voice / TALK (hold: mouse, touch, Space while focused) / status pill; typed `<input>` + Run (ER-direct default; "Flash coworker" toggle when B6 lands) + Cancel; transcript; plan card; "What Gemini sees" thumbnail (256 px) with overlays; ledger; DEMO_MODE toggles (consensus, plan level). All inputs are real `<input>/<textarea>`. Done when: renders against `StubCell` in the B dev server; typed task shows trace lines.

**B5 (14:25, 15 min) `src/gemini/liveAudio.ts`, `src/gemini/live.ts`.** Per §1.6: `getUserMedia({audio:{channelCount:1, echoCancellation:true, noiseSuppression:true}})`, `AudioContext({sampleRate:16000})` + `ScriptProcessorNode(4096)` → Int16 LE → base64 (no AudioWorklet); playback context 24 kHz; both created in the Connect handler; singleton; dispatcher; pending-id map; `[CELL EVENT]` pushes subscribed from the bus. Done when: loopback test (record 1 s, play it back) works in the B dev server.

**B6 (14:40, 25 min) integrate on the real arm (in `cell` after A5's merge; B pulls master into track-b: `git merge master`).** Typed `put the red block in the tray` end-to-end → fix; Live end-to-end (status question, task, PAUSED event, create_object + rejection); `src/gemini/console.ts` (Flash typed coworker with `LIVE_TOOLS`, `toolConfig mode AUTO`, `candidates[0].content` kept before the functionResponse) if time remains; set DEMO_MODE from ledger numbers. Done when: G3 checks 1–3 pass.

**B7 (15:05, 15 min, COULD, only if G3 checks 1–3 passed clean)** ER grasp check on `create_object`: `capture → graspCheck (MEDIUM) → overlay orange point on the thumbnail + 4 mm orange sphere in the scene; append {graspable, grasp_reason}` to the tool response (never blocks creation). Else: fixes only. COULD-2 (hand-in-zone via a webcam frame) only if ≥ 15 min remain after B7 — otherwise the disclosure states webcam frames never leave the machine.

### Track C (`cell-c`, branch track-c; medium; from 14:15; owns only these files)

**C1 (14:15, 25 min) strings.** `README.md` 1–27 (title/pitch), 24–25, 161–163, 169–172, 181, 186–188; `AboutPanel.tsx` 143–146, 155–158; `HandPane.tsx` 611–613, 617; `docs/DESIGN-NOTES.md` 140, 147–148, 219; `index.html` 6–10 (title "The cell — voice-instructed robot work cell"); `package.json:6`; `src/demo/script.ts` 44/56 captions (3D arm wording; "Gemini tasks wait while the cell is stopped"; keep total 40–50 s — `script.test.ts` asserts timings only). Privacy replacement text (verbatim): *"Gesture recognition stays on-device (MediaPipe). While a voice session is connected and TALK is held, microphone audio streams to Gemini Live; rendered cell-camera frames go to Gemini Robotics-ER during tasks. Webcam frames never leave this machine in this build. Nothing is recorded by this app. The counters in the top bar show exactly what has left this machine."*
**C2 (14:40, 20 min) README sections** "How Gemini is used", "Provenance" (§7 verbatim + `git -C repos\handsignal rev-parse HEAD` and `git -C repos\ahmedsohail2003.github.io rev-parse HEAD` hashes + "compare with `git diff <commit0>..HEAD`"), "What leaves this machine", "Run it" (`npm ci; copy .env.example .env.local; npm run dev`), warning that `VITE_GEMINI_API_KEY` is inlined into `dist/` (never deploy `dist/`); `.env.example` (variable name only); `THIRD_PARTY_LICENSES.md` (Menagerie Apache-2.0, three.js MIT, MediaPipe Apache-2.0, React MIT); `docs/SUBMISSION.md` with every platform field pre-filled from §7. Merge into master at 15:00 (A runs `git merge track-c`).
**C3 (15:05, 10 min)** fallback lines from PROGRESS.md into README + SUBMISSION.md; test count. If no C session exists: A does C1 at 15:05 (strings only) and B6 writes C2's README sections at 15:15.

---

## 4. Fallback triggers (time + condition → action; every trigger taken is a line in PROGRESS.md "Fallbacks")

| Time | Condition | Action |
|---|---|---|
| 13:00 | smoke `er2` 403 with "unrestricted" wording | operator restricts the key (§0.1), rerun once at 13:05 |
| 13:10 | `er2` still 403/404, or "project denied access" (billing) | `ER_MODEL = 'gemini-3.8-flash'` with identical prompts/schemas (`thinkingLevel` low/medium/high supported); README/Devpost say so. Never ER-1.6 (deprecated) |
| 13:10 | `er2 point schema` 400 | `SCHEMA-OFF`: `responseMimeType` only + fence-strip + validation |
| 13:10 | `er2 fc shapeA` fails | use shape B; if shape B also fails → **F4 structured-plan loop** (§1.7) from B3 |
| 13:10 | `er2 latency HIGH` > 12 s | `DEMO.planLevel = MEDIUM` |
| 13:10 / 13:30 | Live smoke auth failure (401/403/1008) in node, or `BROWSER LIVE FAIL` | **FALLBACK-VOICE**: B5 becomes Web Speech push-to-talk (`fleetline/src/ui/CommandConsole.tsx:45-65, 238-244, 359-412, 612-635`) + `gemini-3.8-flash` function calling with `LIVE_TOOLS` + `speechSynthesis`; same egress badge (Chrome speech leaves the machine too) |
| 13:10 | `live ack+event` FAIL (no spoken turn after the event) | keep the immediate ack; push completion with `scheduling:'INTERRUPT'` in a second `sendToolResponse` for the same id (tested at once); if that also fails, Live speaks only from its own next turn and the console shows the result |
| 14:25 | no 3D arm on screen | strip to arm + tray + block, `MeshBasicMaterial`, one light; by 14:30 at the latest |
| 14:30 | still nothing | keep the 2D `CellCanvas`, draw `arm.q` FK as a 2D side projection (`x = tcp.x, y = tcp.z`); ER gets frames from that canvas; disclose |
| 14:40 (G2) | `pick` never attaches | attach radius 25 mm for the demo, logged |
| 15:05 (G3) | ER loop never reaches `done` twice in a row | **F4** structured-plan loop (already coded if shape tests failed; else 20 min) |
| 15:05 | 429s during a task | consensus off, verify only after pick and place, one rehearsal at a time; red ledger rows stay visible |
| 15:05 | Live flaky (≥1 failure in 2 rehearsals) | demo uses typed input (Flash coworker or ER-direct) for tasks; voice only for status/one question; say so on camera |
| 15:05 | `create_object` by voice unreliable | pre-seed a blue cylinder at load; demo line becomes "which one is the cylinder?" → `point_at` |
| 15:15 | grasp check not started | drop B7; README says grasp check not shipped |
| any | `npx tsc --noEmit` red > 10 min in a track | stop feature work, fix, then continue |
| any | a step 15 min over its box | skip to the next step; PROGRESS.md notes it; MUST order: arm+IK → ER loop typed → voice |
| 15:30 | anything | freeze; the backup video is the submission video; disclose what is missing |
| demo | venue network dies | play the local video; show the exported JSON |

---

## 5. Resolved oversights (critique item → resolution)

Critique set 1
1. `@types/three` missing → A0 installs `@types/three@0.186.0` before anything; tsc clean is commit 0's evidence.
2. Smoke asks Live for TEXT → B0 step 6 uses `Modality.AUDIO` + `outputAudioTranscription`; PASS = audio part or transcription + `turnComplete`; only 401/403/1008 counts as auth failure.
3. Empty OBJECT schemas → zero-arg tools omit `parameters`; unions dropped from the voice surface; the exact `run_task`/`cell_status` declarations are validated in the smoke before any UI code.
4. Nondeterministic STOP → §1.5 split gate: new tool calls rejected while STOPPED; in-task `waitRunnable` pauses (no ER calls, no verify) and resumes on thumbs-up; only ESTOP/cancel fail a task; G3 check 2 is deterministic.
5. Barge-in cancels pending run_task → immediate ack (`scheduling:'SILENT'`), completion via `[CELL EVENT]`, cancellation honoured only for unanswered ids; barge-in case in the smoke.
6. No task mutex → `activeTask` module-level; second run_task rejected with a speakable sentence; tested in erLoop.test.
7. functionResponse + image shape untested → shape A (`FunctionResponse.parts`) and shape B (separate user turn) smoke-tested at B0; F4 structured-plan fallback.
8. IK test vs wrong keyframe → z=0.015 compared to keys[2] (roll pinned at the keyframe roll); z=0.027 checked by FK round trip + down-sum only; tray comparison 0.08 rad.
9. All 307 grid rows from home → 20 interior rows, 2 mm FK tolerance, ≤1 failure tolerated; hard regressions (d)/(e) kept.
10. Demo latency → two takes (§7), one task per take, plan level from measured latency (MEDIUM unless HIGH ≤ 12 s), consensus off, continuous recording cut in the edit.
11. Unknown RPM + concurrent testing + 3× consensus → rate-limit page in PROGRESS.md before G1, concurrency-1 queue, consensus default 1, 429 = red row (no model switch), one track rehearses at a time (B owns ER calls 14:40–15:05; A tests with `window.__cell` only).
12. ER loop last (Plan 1) → B builds the loop against `StubCell` by 14:10; integration 14:40.
13. Stale schedules/over-booked Track A → re-anchored 12:40; G1 13:50, G2 14:40; validator deferred to A6 (seed-only registry at A3); scene box 35 min with the simplified look as default; idle loop deleted.
14. Grasp at ER's raw point → registry position always drives motion; ER point matched within 25 mm; error shown; unproject at top-face height.
15. AudioWorklet URL/autoplay → `ScriptProcessorNode(4096)`; both AudioContexts created + resumed in the Connect click.
16. Speaker→mic echo → chunks only while TALK held, `activityStart/End`, `automaticActivityDetection.disabled: true`; headphones optional.
17. Keyboard guard scope → first statement of both `down` and `up`, before the Escape branch (A5).
18. Stale held `pos` / stale capture → `step()` writes the held object's pos from the tcp; `capture()` calls `syncScene()` first.
19. Cylinders on their side → `rotation.x = Math.PI/2` under root.
20. Eager `GoogleGenAI` breaks vitest → lazy `getAI()`; tests mock `callER`.
21. `responseJsonSchema`/MINIMAL unverified → exact pointing config in the smoke, SCHEMA-OFF fallback, MINIMAL never used.

Critique set 2
1. No backup video/network plan → the 15:00 rehearsal is recorded (screen + system audio + mic) and uploaded unlisted at 15:05; final take only if better; local mp4 + export JSON kept; hotspot; app pre-loaded; play the video if the network dies.
2. ER-1.6 dead → informational in the smoke; `gemini-3.8-flash` is the real ER fallback; actual model written into README/Devpost.
3. Shared working tree → three worktrees (`cell`, `cell-b`, `cell-c`) on branches with disjoint file ownership; component CSS files (`CoworkerPane.css`, `EgressBadge.css`) so `styles.css` is A-only; merges at gates; commits batched at gates when the operator is busy.
4. Relabel last / phantom webcam button → Track C runs the string relabel from 14:15 (merge 15:00); disclosure says webcam frames never leave in this build; G4 greps for the exact wording.
5. Live before ER loop → not applicable (B3 precedes B5; ER loop is the 14:40 integration).
6. Room noise/VAD → hold-to-talk with VAD disabled (see 16); speakers for output; rehearsal in the venue at 15:10.
7. Live decided from node only → `?livesmoke=1` browser smoke at B1 (Chrome, localhost:5174) is G1 check 3.
8. Gates not verifiable by a second session → command-based checks + Claude Browser screenshots/`javascript_tool` for G2/G3, `docs/gates/` evidence files, headless proofs (`controller.test` (d), `erLoop.test`), checker reads only the files named per gate.
9. Projector/venue → `?present=1` presentation class (A7), rehearsal at 1280×720 with the checker's `resize_window`, gestures tested under venue light, keys-vs-camera decided before recording, HDMI/charger/speaker in §0.
10. Unassigned operator tasks → §6 has owner=human rows with clocks; platform confirmed by 13:00; `docs/SUBMISSION.md` pre-filled by 15:00.
11. Depth items dropped silently → grasp check is B7 (COULD, gated on G3); hand-in-zone COULD-2 only with ≥15 min spare; loop described accurately (agentic function calling, or "plan/verify/replan" if F4); Flash has a real job (typed coworker + fallbacks).
12. Key inlined in `dist/` → README warning, `dist` gitignored, never deployed.
13. Attribution artifacts → `THIRD_PARTY_LICENSES.md`, source commit hashes and `git diff <commit0>..HEAD` instructions in Provenance.
14. Small setup errors → `.git` exists (no `git init`), `@types/three` first, no AudioWorklet, idle loop cut, A's slot re-budgeted.
15. Live chatter / IDLE friction → `[CELL EVENT]` only for the §1.6 events while a task is active; logged auto CYCLE_START.
16. Rate-limit behaviour for the recording → `DEMO_MODE` in `models.ts` toggled from the pane; values fixed at G3 and written to PROGRESS.md + README.

---

## 6. Human operator tasks (only the human can do these)

| Clock | Task |
|---|---|
| 12:30 | Create/restrict the API key; write `cell\.env.local`; confirm billing tier |
| 12:35 | Paste rate limits into `PROGRESS.md` header |
| 12:45 | Confirm commit 0 diff ("yes") |
| 12:52 | Open session B in `cell-b`, copy `.env.local` there; later (14:15) session C in `cell-c` |
| 13:00 | Confirm the submission platform + required fields; team names; MLH registration state |
| 13:20 | Click Connect on http://localhost:5174/?livesmoke=1 (Chrome), report whether audio played |
| 13:50, 14:40, 15:05, 15:30 | Start the checker session (Fable Ultra) with the gate number; paste its verdict if it does not write PROGRESS.md itself |
| 14:30 | Allow mic + camera for http://localhost:5173; test the hotspot; plug in the charger |
| 14:40–15:05 | Test by voice with B; log bugs as one-liners in `PROGRESS.md` "Bugs" |
| 15:00 | **Record the rehearsal** (screen + system audio + mic) = backup video; start the unlisted upload at 15:05 |
| 15:10 | Venue rehearsal: 1280×720, Chrome zoom 125 %, `?present=1`, gestures under venue light, decide keys vs camera for the live demo |
| 15:30 | Confirm the freeze diff; push |
| 15:32–15:48 | Final take only if the freeze build is better than the backup; upload; keep local copies |
| 15:50 | Submit from `docs/SUBMISSION.md`; verify links open in a private window |
| Judging | Tab pre-loaded with MediaPipe/three.js ready, Live connected, video file open in a second tab, hotspot on |

Commit approvals: ~6 per track; answer "yes" after glancing at `git diff --cached --stat`. Never paste the key anywhere but `.env.local`.

---

## 7. Devpost submission (pre-filled in `docs/SUBMISSION.md`)

- **Title:** The cell — a robot work cell you instruct the way you'd instruct a coworker.
- **Description (≤150 words):** A browser work cell with a 3D SO-ARM100. You talk to it. Gemini 3.8 Live is the coworker's voice: it listens on hold-to-talk, asks one question when a request is ambiguous, negotiates part sizes, and hands tasks to Gemini Robotics-ER 2, its eyes: ER looks at the fixed cell camera, points at the part you named (localization error against ground truth shown in mm), plans, drives the arm through validated tool calls and verifies every step from a fresh frame before continuing. Gemini 3.8 Flash runs the same coworker over typed text. Code is the trust boundary: size, reach and cell-state checks, exact coordinates. Hand gestures recognised on-device (MediaPipe) remain the safety channel and override everything: open palm freezes the arm mid-move and pauses the task, thumbs-up resumes it, a held fist e-stops and aborts; Gemini's motion tools are refused while the cell is stopped. Every model call is on screen with model, thinking level, latency, tokens and cost.
- **How Gemini is used in the loop:** `gemini-3.8-live` (voice in/out, clarifying questions, tools run_task/create_object/point_at/describe_scene/cell_status/cancel_task); `gemini-robotics-er-2-preview` (pointing on rendered cell frames → mm error vs registry; agentic plan/act loop via function calling with a fresh frame after every action; per-step verification; grasp-feasibility check on created parts if shipped; thinking {planLevel} for plan, low for act/verify); `gemini-3.8-flash` (typed coworker path with the same tools; fallback brain). DEMO_MODE values and any fallback taken are listed verbatim from PROGRESS.md.
- **Tech/APIs:** Gemini API via `@google/genai` 2.23 web build (Live API WebSocket with NON_BLOCKING tools and manual activity signals; generateContent with function calling, JSON schema structured output and thinking levels); MediaPipe Tasks Vision GestureRecognizer; three.js 0.186; React 18 + Vite 5 + TypeScript; vitest; Web Audio (16 kHz PCM in / 24 kHz PCM out); MuJoCo 3.10 offline for fixture generation only.
- **Team:** Ahmed Sohail Butt (+ teammates as registered).
- **Provenance / disclosure (verbatim in README and the submission):**
  > **Pre-existing before EmberHacks:** the HandSignal app (webcam gesture recognition, gesture state machine, cobot cell state model, telemetry, guided demo and its 28 tests; github.com/ahmedsohail2003/handsignal, commit <hash>); the SO-ARM100 meshes, joint data and keyframes vendored from my portfolio work-cell page (commit <hash>; meshes from MuJoCo Menagerie `trs_so_arm100`, Apache-2.0); the damped-least-squares IK formulation from my `workcell-partA-imitation` MuJoCo project. **Built during the hackathon:** the three.js cell inside HandSignal, browser FK/IK validated against MuJoCo fixtures generated today (heights re-derived for a kinematic arm: grasp 27 mm instead of the physics-stalled 15 mm, retreat 90 mm instead of the unreachable 120 mm), the motion executor and pick/place primitives, the object registry and validator, the fixed cell camera with ER point un-projection, all Gemini integration (Live voice, Robotics-ER pointing/planning/verification, Flash text path, telemetry and cost accounting), the coworker console, and these disclosures. There is no physics: parts snap to the gripper when the jaw closes within 15 mm of them. Nothing here controls a real robot. Fallbacks taken today: <from PROGRESS.md, or "none">.
  > **What leaves this machine:** microphone audio while TALK is held in a connected voice session (Gemini Live); rendered cell-camera frames during tasks (Gemini Robotics-ER); nothing else. Gesture recognition stays on-device. Webcam frames never leave this machine in this build. HandSignal previously stated all processing was on-device; that is no longer true here and the top-bar counters say so. The API key lives in this browser build; never deploy `dist/`.
- **Video shot list (≤ 2 min total; two continuous takes, plan wait trimmed, stated on screen):**
  - Take 1 (≈60 s): 0:00 ✌ Victory → RUNNING line. 0:05 hold TALK: "Put the red block in the tray." → Live "On it." → console: `ER point … err N mm`, `ER plan … s $`, `TOOL pick`, `ER check ✓`. 0:30 open palm mid-carry → arm freezes, `PAUSED: cell STOPPED`, Live: "Cell stopped, I'll wait." Thumbs-up → `RESUMED`, `TOOL place_in_tray`, `ER check ✓`, `ER done ✓`, Live: "Done, the block is in the tray."
  - Take 2 (≈30 s): "Add a blue cylinder about 30 mm wide, 60 mm to the right of the red block." → cylinder appears (+ grasp point if shipped). "Make it 70 mm." → spoken rejection quoting 45 mm. "Put the cylinder in the tray." → during the carry, closed fist 1.5 s → arm red, `ABORTED: EMERGENCY STOP`, Live: "Emergency stop. I won't move until you reset it on the panel." → two-step reset.
  - Tail (10 s): egress badge close-up; exported JSON `gemini[]` entries; one sentence on camera naming what pre-existed.

---

## 8. Model-usage protocol

**Builders (do the typing):**
- Track A: **Fable high** for A1–A3 (frames, quaternion order, DLS, executor — silent numeric mistakes cost an hour), **medium** for A4–A7 (verbatim ports and UI).
- Track B: **Fable high** for B0, B3, B5 (protocol edge cases: modality, function-response shape, NON_BLOCKING, cancellation, audio scheduling), **medium** for B1, B2, B4, B6, B7.
- Track C: **Fable medium** (strings and docs).
- Builders never read `.env.local`, never print the key, never commit without showing the diff, never write outside their owned files (A: `src/arm/*`, `src/cell/*`, `src/app/*`, `src/components/{CellScene,CellPane,TelemetryStrip}.tsx`, `App.tsx`, `styles.css`; B: `src/gemini/*`, `src/telemetry/*`, `src/dev/*`, `main.tsx` guard, `src/components/{CoworkerPane,EgressBadge}.*`, `scripts/*`; C: `README.md`, `docs/*`, `index.html`, `package.json:description`, `AboutPanel.tsx`, `HandPane.tsx` strings, `src/demo/script.ts`, `THIRD_PARTY_LICENSES.md`, `.env.example`).

**Checker (Fable Ultra / highest effort, 4 sessions × ≤10 min, in `cell`):** reads `PLAN.md` §2 for its gate + `PROGRESS.md`; runs exactly the numbered commands; uses Claude Browser (`preview_start` http://localhost:5173/?sim=1, `computer screenshot`, `javascript_tool`, `read_console_messages`) for the visual checks; reads only the ≤4 files named in that gate's oversight scan; appends to `PROGRESS.md` "Gate log": `G{n} HH:MM — check 1 PASS | check 2 FAIL (why) … — fixes: file:line one-liner (≤3) — risks for next block (≤3)`. It never builds. Exception: a gate failure with the builder stuck > 15 min → the checker fixes **one file**, bounded to 15 min, noted in the log. Why not the other way round: Ultra minutes buy the most where one missed detail costs an hour (frames, auth, gating, turn shapes); typing ports and UI is where medium/high is already reliable and the gates catch slips.

**PROGRESS.md (single source of truth; updated by the builder at every "done when", before the commit is staged):**
```
# PROGRESS — anchor 12:40, freeze 15:30, submit 16:00
Rate limits: ER-2 __ RPM/__ TPM · Live __ · Flash __ (aistudio.google.com/rate-limit, HH:MM)
Decisions: planLevel=__ fcShape=A|B|F4 voice=live|fallback erModel=__ consensusN=1 attachRadius=15
| step | owner | status | clock | claim (command → expected → actual) |
| A0 | A | done | 12:52 | npx tsc --noEmit → empty → empty; npx vitest run → 28 passed → 28 passed; commit 0 abc1234 |
| A1 | A | done | 13:10 | npx vitest run src/arm → fk 2 green → 2 green (60 rows, max err 3e-7) |
…
## Smoke (B0)   SMOKE … / DECISION … lines
## Gate log     G1 … G2 … G3 … G4 …
## Fallbacks    HH:MM NAME because …
## Bugs         HH:MM one line each, owner
## Human        item | clock | done
```
A row is "done" only when its claim names a command and the observed output; "skipped" rows name the fallback taken. The checker marks any row whose claim it cannot reproduce as `UNVERIFIED` and the builder re-runs it before the next gate.
