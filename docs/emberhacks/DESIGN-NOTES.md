# HandSignal — working notes

Gesture-based safety commands for a collaborative robot cell, grounded in the
ASME B30.5 crane signalperson vocabulary. Prototype lives in the repository
root, one directory up from these notes (Vite + React + TypeScript; state
machine in `src/gesture/stateMachine.ts`, unit-tested with Vitest).

## Concept

Operators near a cobot cell often cannot use a touchscreen (hands busy,
gloves), cannot use voice (hearing protection, 85+ dB floors), and should not
have to walk to a pendant to pause a cycle. HandSignal explores a third
channel: a small vocabulary of hand signals, recognized by a camera, that maps
to the cell's safety-relevant commands — STOP, EMERGENCY STOP, RESUME, SLOW,
CYCLE START.

Research question: **Can a standardized industrial hand-signal vocabulary
serve as a reliable, learnable command channel for cobot cells, and what dwell
time best trades false activations against responsiveness?**

## Why crane signals

- ASME B30.5 signalperson signals are a real, learned, safety-critical gesture
  language already in daily use on industrial floors. Riggers, crane
  operators, and many general laborers arrive with pre-existing literacy in
  it; we are not inventing a gesture set operators must memorize from scratch.
- Gestures need no wake word, work at a distance and through glass, and
  survive hands-busy, gloved, hearing-protected environments where voice and
  touch fail.
- A vocabulary that already means "stop" on the floor carries its meaning
  across to the cobot cell — the STOP palm is arguably the most
  over-learned safety gesture in industry.

### Honest adaptation note

The prototype recognizes MediaPipe's canonical single-hand **static** poses,
which constrains the vocabulary. Only one mapping is close to literal:

| Pose (MediaPipe)       | Command         | Provenance |
| ---------------------- | --------------- | ---------- |
| Open_Palm              | STOP            | Matches the crane STOP signal (open hand, palm out) |
| Closed_Fist, hold 1.5 s | EMERGENCY STOP | **Adapted** from "dog everything" (clasped hands = halt all operations) |
| Thumb_Up               | RESUME          | **Adapted** — not a B30.5 signal; universal confirm gesture |
| Pointing_Up            | SLOW MODE       | **Adapted** from the "move slowly" hand-over-signal modifier |
| Victory (V)            | CYCLE START     | **Adapted** — no crane equivalent; chosen as a visually distinct pose |

Real B30.5 signals are largely dynamic (swinging forearms, circular motions)
and sometimes two-handed; a production system would train recognizers on the
actual dynamic signals. The prototype says this plainly in its About panel and
labels every adapted mapping in the legend. The claim under test is about the
*approach* (borrowing an existing industrial gesture language), not that these
five static poses are the B30.5 standard.

## State-machine design

`src/gesture/stateMachine.ts` — pure TypeScript, no DOM, identical for real
(MediaPipe) and simulated (keyboard-injected) classifications.

Pipeline: raw classification → confidence gate → debounce window → dwell-time
arming → command fires → refractory period.

Parameters (defaults):

| Parameter        | Default  | Role |
| ---------------- | -------- | ---- |
| minConfidence    | 0.60     | Classifications below the gate count as "no gesture" |
| debounceMs       | 120 ms   | Gesture must persist this long before arming begins (filters classifier flicker) |
| dwellMs          | 600 ms (slider 300–1200) | Arming hold before a normal command fires; a radial ring fills during the hold |
| estopDwellMs     | 1500 ms (fixed) | Longer hold for EMERGENCY STOP — a false e-stop halts production, so it must cost more intent |
| refractoryMs     | 1200 ms  | After a fire, the same gesture cannot re-fire until this elapses AND the hand was released |
| lossGraceMs      | 120 ms   | Dropouts shorter than this do not cancel a debounce or arming hold |

Design decisions worth defending in a crit:

- **Dwell, not instantaneous triggering.** A command is a deliberate hold,
  never a passing pose. The filling ring gives continuous feedback and an
  abort affordance (drop the hand before the ring closes).
- **Refractory is per-gesture, not global.** A held gesture fires exactly once
  (release-before-repeat), but a *different* gesture can arm immediately — so
  a STOP is never queued behind a RESUME's refractory window. Safety-directed
  commands must never wait.
- **E-stop recovery is not gesture-driven.** Resetting the e-stop is a
  deliberate two-step act on screen (reset, then confirm), and it returns the
  cell only to IDLE — a fresh CYCLE START is required. Rationale: a misread
  hand pose must never re-energize a locked-out cell. Gestures can only make
  the cell safer; making it live again requires an explicit interlock.
- **Asymmetric costs.** Stopping is cheap (600 ms), e-stopping is deliberate
  (1.5 s), restarting is gated (gesture + machine state), un-e-stopping is
  the most expensive act in the interface.

## Rejected alternatives

- **Custom-trained gesture set vs. MediaPipe's canonical set.** A
  custom-trained recognizer could target the actual dynamic B30.5 signals,
  but it would need a dataset, training loop, and validation study of its own
  before the interaction question could even be asked. The canonical set is
  weaker ecologically but lets the dwell/debounce/refractory design be tested
  now, with an honest note about the substitution. Chosen: canonical set +
  disclosure.
- **Voice vs. gesture.** Voice needs a wake word, fails at 85+ dB and under
  hearing protection, and is socially awkward on a shared floor. Gesture
  works in exactly the environments this cell lives in. (A voice channel is a
  sensible complement for parameter-setting tasks, not for STOP.)
- **Toggle vs. dwell.** A toggle ("gesture flips state instantly") minimizes
  latency but converts every classifier flicker into a command — in early
  bench testing of the pipeline with synthetic noise, that is exactly the
  failure the debounce + dwell design removes. Dwell also creates a natural
  measurable variable (the study's independent variable).
- **Gesture-based e-stop reset.** Rejected outright; see rationale above.

## What the logs let a study measure

Every raw detection, armed event, fired command, and false start is
timestamped and exportable as JSON from the telemetry strip. Dependent
measures this yields directly:

- **False-activation rate** — fired commands the participant did not intend
  (from post-task review of the log against task instructions).
- **False-start rate** — armed-but-released-early events per command; a proxy
  for a dwell time set too long (users bail out) or unstable recognition.
- **Dwell-to-fire latency** — time from first raw detection to command fire,
  per gesture and per dwell setting (the responsiveness cost of each dwell).
- **Refractory collisions** — commands attempted during refractory (visible
  as raw detections with no arming), a measure of pacing friction.
- **Learnability** — change in false starts and latency across blocks.

Sketch of the pending study: within-subjects, dwell time at 400 / 600 / 900 ms
(counterbalanced), tasks that mix urgent stops with routine starts, with the
simulated cell providing consequences for false activations. Signal-detection
framing: dwell trades hits against false alarms.

**Status: [Evaluation designed; sessions pending].** No participants have been
run; no findings exist. Nothing in the prototype or these notes reports study
data.

## What is simulated (honesty inventory)

- The work cell is a 3D kinematic model of an SO-ARM100: MuJoCo Menagerie
  meshes, browser FK/IK validated against MuJoCo fixtures, joint-space motion
  segments, no physics (parts snap to the gripper when the jaw closes within
  15 mm). It is labeled "3D kinematic model — SO-ARM100 meshes, no physics,
  not a real robot" in the UI.
- Simulated-input mode (auto-active without a camera, or via `?sim=1`)
  injects synthetic classifications from keys 1–5 with adjustable synthetic
  confidence, labeled "SIMULATED INPUT" in the UI. Everything downstream of
  the classifier — state machine, cell commands, logging — is the same code
  path for real and simulated input, so simulator findings about the state
  machine transfer.
- Camera mode lazily loads MediaPipe's GestureRecognizer (official CDN-hosted
  model) and runs entirely in the browser.

## Test coverage

Vitest, 66 tests across eleven files (the 28 pre-existing HandSignal tests
below, plus arm FK/IK/controller/camera, the object validator and the Gemini
ER/loop/bus tests added during EmberHacks; see README "Development" for the
live count):

- `src/gesture/stateMachine.test.ts` (18): confidence gating, debounce
  flicker filtering, dwell arming and firing with latency bounds, adjustable
  dwell, false-start counting on release and on mid-arming gesture switch,
  loss-grace tolerance, e-stop long-hold vs. short-hold, single-fire-per-hold,
  release-plus-refractory re-fire, same-gesture suppression inside the
  refractory window, cross-gesture interrupt during refractory,
  raw-detection counting, latency averaging.
- `src/cell/cellSim.test.ts` (4): start-from-idle only, pause/resume
  mid-move, slow halving, e-stop lockout and two-step reset.
- `src/demo/script.test.ts` (6): guided-demo invariants — total duration ~45 s,
  confidence above the gate, every hold long enough to fire and released
  within its step, same-gesture repeats spaced beyond the refractory period,
  reset steps ordered after the e-stop; plus a full replay of the script
  through the real state machine + cell asserting the fired-command sequence
  (CYCLE START, SLOW, STOP, RESUME, RESUME, EMERGENCY STOP — all accepted)
  and an IDLE cell at the end. The demo cannot silently break when pipeline
  parameters change.

## Final inventory (as shipped)

Prototype at the repository root — `npm run build` clean,
66/66 tests passing (2026-09-19, EmberHacks build).

Features:

- Dual input, one pipeline: opt-in MediaPipe camera mode (lazy-loaded
  recognizer, landmark overlay, graceful failure back to simulation) and
  first-class simulated input (keys 1–5, adjustable synthetic confidence,
  auto-default without a camera, `?sim=1` to force).
- On-screen signal keypad: five press-and-hold cards (mouse/touch/Space on
  focus) with line-icon glyphs per gesture, key numbers, command colors, and
  per-card provenance tags (literal vs. adapted); cards highlight while their
  gesture debounces/arms; reference-only (disabled) in camera mode.
- Guided demo (~45 s, "Guided demo · 45 s" button or `?demo=1`): scripted
  simulated gestures through cycle start → slow → stop → resume → resume →
  e-stop → two-step reset, with narration captions, step counter, progress
  bar, stop button; any gesture key or Esc cancels and hands over control;
  demo traffic runs through the real pipeline and is logged like any input.
- Safety state machine: confidence gate → 120 ms debounce → dwell arming
  (600 ms default, 300–1200 ms slider; 1.5 s fixed for e-stop) → fire →
  per-gesture refractory with release-before-repeat; radial dwell ring,
  false-start logging, JSON session export.
- Work cell simulation (labeled "3D kinematic model — SO-ARM100 meshes, no
  physics, not a real robot"): three.js SO-ARM100 driven by browser FK/IK,
  tray, object registry, fixed cell camera for Gemini, andon stack light,
  state banner; STOP freezes the arm mid-move and pauses the running Gemini
  task, SLOW halves speed, RESUME restores the pre-stop state, CYCLE START
  from IDLE only (a task auto-starts the cycle, logged), E-STOP aborts the
  task and locks out with a deliberate two-step on-screen reset.
- Telemetry strip: last gesture + confidence, dwell meter, session counters
  (fired / false starts / avg ms to fire), timestamped command log.
- About panel: research question, crane-signal rationale, honest adaptation
  note, safeguards, simulation inventory, evaluation status.

Test count: **28** (18 state machine, 4 cell, 6 demo script).

Screenshots (1440x900, in `img/`):

- `handsignal-overview.png` — guided demo mid-story (hero image in README)
- `handsignal-armed.png` — STOP dwell ring just over half full, cell running
- `handsignal-estop.png` — e-stop lockout, flashing banner, reset step 1 latched
- `handsignal-about.png` — About panel over the app

README (`../README.md`): hero screenshot, pitch, 60-second
tour, gesture vocabulary table with provenance, mermaid diagrams for both
state machines, design-decision rationale, research question + logged
measures, honest limitations (canonical-pose stand-ins, kinematic 3D cell
without physics, labeled simulation, what leaves this machine), run
instructions, how Gemini is used, provenance.

Evaluation status unchanged: **[Evaluation designed; sessions pending]** — no
participant data exists anywhere in the project.
