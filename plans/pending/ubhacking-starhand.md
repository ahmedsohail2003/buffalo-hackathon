# STARHAND: UB Hacking 2026 build plan

> **Working title.** STARHAND is one constant in `src/brand.ts`. Change it there to rename the project.

**What it is:** a sample-curation glovebox on an orbital station, simulated in the browser. You reach in with your bare hand: the webcam tracks it, and the SO-ARM100 arm follows it.

- **Gemini** sees the cell, designs new samples, plans and checks each step.
- **ElevenLabs** is mission control's voice.
- **Code** checks every object and every motion against what the real arm and gripper can do.
- **Hand gestures** stay the safety channel and override everything.

**Event:** UB Hacking 2026, University at Buffalo, November 7–8.

- **Deadline:** according to the official hacker guide (updated October 28), Devpost submission closes **Sunday November 8 at 11:30 AM**, and hacking ends at 1:30 PM. Devpost's API showed "about 23 hours left" at 14:33 on Saturday, which agrees.
- **Our target:** the user's own target is done by 22:00 Saturday, because of travel to Hamilton. Tomorrow morning is buffer.
- **Submission requirements:** a YouTube demo video under 3 minutes (judges watch only the first 3 minutes) and a live demo at judging.
- **Projects can enter "as many challenges as you like".**
- **Mid-event check-in:** optional, 19:00–22:00 Saturday, through the Discord bot.

**Builds on:** the EmberHacks "cell". It is in this repository as one disclosed vendor commit; see [PROVENANCE.md](../../PROVENANCE.md).

## Tracks we target

| Track | What it asks | Our angle |
| --- | --- | --- |
| Radial Atoms (Radial Ventures) | AI that senses, understands and acts on the physical world. Simulations of physical systems count. Disclose simulated data and what existed before. | **Sense:** webcam hand tracking and the cell camera. **Understand:** Gemini Robotics-ER scene understanding, plus measuring generated objects against the gripper. **Act:** the kinematic SO-ARM100, with forward and inverse kinematics validated against MuJoCo. |
| Spirit of the Hackathon (prize: a LEGO NASA Artemis rocket) | A project on the deep-space theme, where the team "took the time to learn a new skill along the way" | An orbital curation glovebox. Samples are asteroid fragments (including real NASA shape models), meteorites, canisters and CubeSat parts. New skills: MediaPipe teleop, procedural 3D, ElevenLabs, Vultr. |
| Best AI/ML (prize: a DJI Neo) | "Best use of ML, LLMs or agents with real engineering behind it" | Gemini designer + measured guardrails, ER agentic loop, on-device hand model |
| Best Overall | Judged on idea, execution, technical difficulty and demo | All of the above |
| MLH Best Use of Gemini API | Gemini is essential | Live voice, Robotics-ER vision and planning, a Gemini designer that writes shape programs, and Nano Banana prints |
| MLH Best Use of ElevenLabs | ElevenLabs is essential | Mission-control voice. Details depend on the ElevenLabs research. |
| MLH Best Use of Vultr | Deployed on Vultr | A key-holding Node server and the static app on a Vultr VPS |
| MLH GoDaddy Registry domain (optional) | A registered domain | A `.space` domain claimed through MLH, pointing at the Vultr box |

## Phases

### Phase 0: Foundation (DONE 14:35)

Verified when: the vendor commit plus the shared-types commit are on `claude/pensive-johnson-mek8ib`, `npx tsc --noEmit` is clean, and `npx vitest run` passes 71 tests.

- 0.1 Vendor EmberHacks `18a8e1f` as one disclosed commit, and add PROVENANCE.md. (S) ✅
- 0.2 Shared contracts: `ShapeProgram`, `MeshInfo`, `HandFrame`, `TeleopStatus`, `SceneObject.shape 'mesh'`, plus `setHandFrame`/`getHandFrame` in `refs.ts`. (S) ✅
- 0.3 One worktree per track in `/home/user/wt/<track>`, each on branch `track/<track>` with its own `npm ci`. (XS) ✅

### Phase 1: Parallel tracks (builders, 14:37 → about 16:40)

Each track is a builder agent working in its own worktree. Every track is verified by `npx tsc --noEmit`, `npx vitest run`, and a Playwright script on the track's own port that saves screenshots.

#### T: Hand teleoperation (M), port 5201. Blocked by: 0.2

- The gripper follows the hand over the deck. The webcam uses MediaPipe GestureRecognizer landmarks; without a camera, a simulated hand pad stands in.
- A pinch is a **click**: one click picks the nearest part within 35 mm through the existing `pick` primitive; the next click places it with `placeAt`, or with `placeInTray` when over the tray.
- Dead-man rule: with no hand in view, the arm holds its position.
- STOP freezes the servo, because speed factor 0 stops it. E-STOP disables teleop.
- A held fist is suppressed only while a pinch is closed.
- Files: `src/teleop/*`, `controller.ts` (`servo`), `HandPane.tsx`, small hunks in `App.tsx` and `CellScene.tsx`.

#### S: Deep-space theme (M), port 5202. Blocked by: 0.2

- An orbital curation glovebox:
  - a light steel deck that keeps the 1 cm grid as a scale cue for Robotics-ER
  - glass walls with glove ports
  - an amber containment bin
  - a starfield and a planet, kept out of the cell camera's view
  - mission-control CSS and `src/brand.ts`
- Files: `src/space/*`, `src/brand.ts`, the environment block in `CellScene.tsx`, `styles.css`, `index.html`, the topbar brand lines in `App.tsx`.

#### G: AI-designed samples with grasp guardrails (L, split by priority), port 5203. Blocked by: 0.2

1. Core, which works offline:
   - `sanitizeProgram`: clamps every number.
   - `buildGeometry`: builds box, cylinder, sphere, cone, torus, capsule, lathe, rock (a noise-displaced icosphere with craters) and asset parts.
   - `measure`: grasp width across the jaw axis (minimum over yaw), height, volume and mass.
   - `fitToGripper`: scales uniformly into the limits, or rejects with a sentence that can be spoken.
   - Presets: Bennu fragment, iron meteorite, sample canister, CubeSat reaction wheel, ice core.
   - Registry `createMesh`.
   - Rendering in `CellScene`.
   - A Fabricator UI panel.
2. Gemini designer: text becomes a shape program through `responseJsonSchema`. Add a `design_object` tool to Live and Flash; it is gated like `create_object`, and Robotics-ER grasp-checks the result.
3. Real NASA asteroid shape models (decimated), as `asset` parts.

A mesh object's `yaw` is set to its `graspYaw`, so the existing `pick` aligns the jaw with the narrow side.

#### V: ElevenLabs voice, key-holding server, Vultr deploy kit (M), port 5204. Blocked by: 0.2 and the ElevenLabs/Gemini research

- `server/index.mjs` is a dependency-free Node 22 server. It serves `dist/`, proxies ElevenLabs text-to-speech, and keeps the Gemini key on the server. The exact method waits on the Gemini research: ephemeral tokens or a base-URL proxy.
- `src/voice/*`
- Optional sound effects
- `deploy/vultr/*`: cloud-init with Node, Caddy and systemd, plus a README.

#### D: Docs and submission (S), no port. Blocked by: the event research

- A new README: story, how it works, what is simulated, provenance.
- `docs/SUBMISSION.md`: Devpost fields.
- A slide deck in the repository.
- A video shot list and script outline.

### Phase 2: Integration (lead, about 16:30 → 17:20)

Verified when, on the integration branch:

- `tsc` is clean, `vitest` is all green, and `vite build` succeeds.
- A Playwright end-to-end run on `?sim=1` passes:
  1. Teleop picks the Bennu fragment and places it in containment.
  2. The Fabricator makes an iron meteorite, and the mass guardrail scales it.
  3. Gestures stop and E-STOP mid-carry.
- Screenshots are saved and the branch is pushed.

Merge order: S → G → T → V → D. These shared files need hand merges: `App.tsx`, `CellScene.tsx`, `HandPane.tsx`, `live.ts`, `styles.css`.

### Phase 3: Human check-in (17:30)

The user answers the gate questions below, provides keys, and tests on a laptop with webcam and microphone.

### Phase 4: Polish and stretch (17:30 → 22:00)

- Deploy to Vultr; this needs the account.
- The domain.
- Generate the ElevenLabs sound effects; this needs the key.
- Tiger Data telemetry, only if time is left.
- The user records the video.
- Finalize the slides.

### Phase 5: Submit (by 23:30)

Devpost: links, video, track selections, and the provenance text.

## Decision log

| # | Decision | Chosen option | Why |
| --- | --- | --- | --- |
| D1 | How to bring in EmberHacks code | One disclosed vendor commit plus PROVENANCE.md, not trickled in over many commits | Radial's rules ask teams to "clearly identify what was built during the hackathon and what components existed beforehand". The EmberHacks repo and Devpost are public, so trickling the code in would look like concealment. Disclosure is safe, and judges then score the new work. |
| D2 | Teleop control law | Shared autonomy: the hand sets the hover point, and a pinch-click triggers the validated pick/place primitives | The reach band is only about 8 cm deep (rho 0.13–0.21 m), and IK keeps the gripper pointing down. Mirroring the hand raw would jitter out of the workspace. The primitives already check IK, jaw width and attachment. |
| D3 | Real-time hand tracking | MediaPipe on the device, sharing one GestureRecognizer pass with the safety gestures | Gemini cannot run a 30 Hz control loop. The recognizer already returns `res.landmarks`. |
| D4 | Pinch semantics | A click (toggle), never held. Fist samples are suppressed while a pinch is closed. | A held pinch can be misread as `Closed_Fist`. Clicks are shorter than the 1.5 s E-STOP dwell. |
| D5 | Generated objects | Gemini writes a JSON shape program. Code builds it, measures grasp width, height and mass, then scales it to fit or rejects it. | Fits in the browser and gives exact measurements. "Gemini proposes, code decides" is the existing trust boundary. Open-source text-to-3D needs a GPU and is research-dependent; it is a stretch goal. |
| D6 | Theme | Orbital sample-curation glovebox. The deck is light so Robotics-ER can read it; the space backdrop is kept out of the cell camera. | Real-world grounding: NASA JSC curates the Bennu and Ryugu samples in sealed gloveboxes. Dark asteroid samples must stay visible to the camera. |
| D7 | Keys | The public deploy never ships a key in the bundle. A small Node server holds the keys. | `VITE_GEMINI_API_KEY` is inlined into `dist/` today. |
| D10 | Guardrail numbers for fabricated samples | Grasp width 15–45 mm (scale to ≤40); height 10–45 mm (scale to ≤40); footprint ≤60 mm; mass ≤100 g (warn above 50, scale to ≤90); spacing max(40, r_a+r_b+10) mm; densities owned by code, by material | From the arm-limits research. Pads are only parallel at 41–45 mm. Fingertips at hover are about 48 mm up. With the STS3215 servos at 5 V and LeRobot capping the gripper at 50% torque, about 90 g of payload remains at rho 0.21. The legacy `create_object` limits are unchanged. |
| D11 | Grasp axis | Bake the narrowest width onto the object's local +x in the geometry | `pick` closes the jaw along the object's local x at any yaw, as the code map verified. |
| D12 | ElevenLabs as the coworker's voice | Keep Gemini Live for speech recognition, tools and cell events. Mute its audio and send `outputAudioTranscription` sentences to ElevenLabs as 24 kHz PCM through the existing player. Gemini's own voice stays available as a toggle. | `gemini-3.8-live` outputs audio only (TEXT gets close code 1007). This path is the lowest risk and keeps Gemini essential. |
| D13 | Gemini keys for the public deploy | `httpOptions.baseUrl` points at a server proxy that injects the key, allows only our model ids, and rate-limits per IP. Live uses `authTokens.create` short-lived tokens (no `lockAdditionalFields`, because of a bug in 2.23). | The research verified both against SDK 2.23. Google disables keys it detects as leaked. |
| D14 | SDK versions | Stay on @google/genai 2.23.0 and the current @mediapipe/tasks-vision | genai 3.0.0 shipped November 6 and defaults to API v1, where Live and auth_tokens return 404. |
| D9 | Radial "must be new" rule | The new code alone forms a full Sense→Understand→Act loop: webcam hand sensing, an AI fabricator with measured guardrails, and teleop action. The prior simulator is disclosed as a component. The user should ask Radial on Discord to confirm. | Radial: "Prebuilt or finished projects are not permitted… Software and AI developed for the project must be new", and also "clearly identify… what components existed beforehand". |
| D8 | Solana, Tiger Data | Skip Solana tonight. Do Tiger Data only if there is time after 20:00. | The user deprioritized Solana. Both add accounts and risk for little gain on the core story. |

## Not yet specified

- V: Live ephemeral tokens need a smoke test with a real key: is the API version v1alpha or v1beta?
- Integration fixes for the lead:
  - `rollForYaw` can exceed the ±2.79 rad Wrist_Roll limit at far-right bearings; wrap it by π.
  - `IMAGE_COST_USD` should be 0.0336, not 0.02.
  - Box grasp width uses min(w, d), but the jaw grips w; this is cosmetic.
- **Eligibility, which the user must ask organizers:** is building on the user's own disclosed EmberHacks simulator allowed? UB Hacking's 2025 FAQ said "you may not submit your past projects". The 2026 FAQ dropped that question, and the 2026 Devpost rules page couldn't be read by a bot.
- D: the exact Devpost submission form fields, waiting on the event research. The deadline and tracks are confirmed from the hacker guide.
- The user: will you be back in Buffalo for in-person judging after the 11:30 AM close on Sunday? If not, ask an organizer on Discord whether a remote or video-only judging slot is possible.
- Phase 4: Vultr. It needs the user's account and payment, and only the user can create those.

## Always / Never

- **Always:**
  - Disclose what existed before the event.
  - Label simulated input and data.
  - Gestures override AI.
  - Code validates every AI-proposed object and motion.
  - Keep tests green.
  - Keep keys out of git.
- **Never:**
  - Claim it controls a real robot.
  - Push to `main` or open a PR without the user.
  - Create accounts, spend money or post publicly on the user's behalf without asking.
  - Commit secrets.
  - Solve CAPTCHAs.

## Progress

| Phase | Status |
| --- | --- |
| 0 Foundation | done 14:35 |
| 1 T teleop | building (started 14:37) |
| 1 S theme | building (started 14:37) |
| 1 G samples | building (started 14:45) |
| 1 V voice/server | building (started 14:45) |
| 1 D docs | waiting for research |
| 2 Integration | not started |
