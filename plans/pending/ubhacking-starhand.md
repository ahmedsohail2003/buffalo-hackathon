# STARHAND: UB Hacking 2026 build plan

> **Working title.** STARHAND is set as one constant in `src/brand.ts`, so renaming it is a one-line change.

**What it is:** a sample-curation bay on a deep-space station, in the browser.

- **Hand control:** you reach in with your bare hand, the webcam tracks it, and a simulated SO-101 arm follows.
- **Gemini:** designs new samples and checks the bay through a fixed camera.
- **Code:** measures every sample and every move against what the real arm can do.
- **ElevenLabs:** is mission control's voice.
- **Hand signals:** stay the safety channel.

Architecture: [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md). Disclosures: [PROVENANCE.md](../../PROVENANCE.md).

## Event facts (from the UB Hacking 2026 Devpost rules, read at 15:05)

- **Deadline:** submissions close **November 8 at 1:30 PM EST**. Devpost also asks for a draft by 11 PM tonight.
- **Original work only:** project code written before hacking started means disqualification. Previously started projects, and projects submitted to another event, are not eligible. This is why this repository was restarted clean at 15:10.
- **Judging:** in person and required, with a 3-minute pitch and demo plus 2 minutes of questions. Judges evaluate work completed during the hackathon. A YouTube video under 3 minutes is also required.
- **Disclosure:** AI tools must be disclosed. Mock data and simulations must be shown clearly. The repo must be public, and the submission must credit the resources used.
- **Prizes:** a project can enter any number of categories.

| Track | Our angle |
| --- | --- |
| Best Overall (idea, execution, technical difficulty, demo) | Everything below |
| Radial Atoms (AI interacting with the physical world: Sense → Understand → Act) | **Sense:** webcam hand tracking and the bay camera. **Understand:** Gemini Robotics-ER checks, and the guardrail measures each sample. **Act:** the SO-101 arm, with kinematics from the Menagerie model. |
| Spirit of the Hackathon (deep-space theme, plus learning a new skill) | A sample-curation bay. Samples are real NASA asteroid shape models: Bennu, Itokawa, Eros and Kleopatra. New skills: MediaPipe hand teleop, procedural 3D, ElevenLabs, Vultr. |
| Best AI/ML; Best UI/UX | Gemini designer plus measured guardrails, the Robotics-ER loop and the on-device hand model; a mission-control interface |
| MLH: Gemini, ElevenLabs, Vultr, GoDaddy Registry domain, and Tiger Data if time allows | Gemini does real work (design, coworker, Robotics-ER). ElevenLabs speaks every line and makes the sounds. The app runs on a Vultr VPS behind a `tech.study` domain (`.us` or `.design`). |

## Build tracks (15:15 → about 18:00)

| Track | Builder | Status | Scope |
| --- | --- | --- | --- |
| C: arm core + safety | new builder | building | Convert the SO-101 model from Menagerie, kinematics (forward and inverse), controller with servo, primitives, sample registry and validator, bay gate, gesture state machine; tests |
| U: scene + UI shell | new builder | building | Mission-control layout, three.js bay with the bay camera, space environment, hand pane with the MediaPipe loop, log |
| A: Gemini + voice | new builder | building | Client and ledger with a proxy, coworker tool loop, Robotics-ER point and verify, Live voice to ElevenLabs, server, Vultr kit |
| Port T: teleop | teleop builder | **ported 15:13**: `clean/teleop`, 4 commits, 26 tests | `createTeleop(bay, cfg)`, camera-loop helpers, `TeleopPanel`, `SimHandPad`, scene hook |
| Port G: fabricator | fabricator builder | modules building; port pending | `src/fabricator/*` plus NASA asteroids move onto the C, U and A interfaces |
| Port S: theme | theme builder | stopped 15:08; U builds the look fresh from the research reference | — |
| Port V: voice/server | voice builder | stopped 15:08; A builds it fresh from the research prototypes | — |

The original T, G, S and V modules were written tonight (from 14:37 on) against a scratch base that has since been discarded. Only their own new files are copied into this repository; the scratch base never is.

## Decision log

| # | Decision | Chosen | Why |
| --- | --- | --- | --- |
| D1 | Codebase | Fresh repository history. Every file was written during the event, and earlier projects contribute ideas only. | The 2026 rules disqualify project code written before the hacking period. |
| D2 | Arm | SO-101, converted from MuJoCo Menagerie | It is current hardware (LeRobot), Apache-2.0, distinct from earlier work, and the arm the developer trained ACT and SmolVLA policies on. |
| D3 | Teleop | Shared autonomy: the hand sets the hover point, and a pinch-click calls the validated pick or place | The reach band is narrow and the gripper must point down. Mirroring raw hand motion jitters out of the workspace. |
| D4 | Hand tracking | MediaPipe on the device: one GestureRecognizer pass serves both teleop landmarks and safety signals | Gemini cannot run at 30 Hz. |
| D5 | Pinch | A pinch is a click, never held. Fist samples are suppressed only during a real pinch (two or more fingers extended) and for at most 500 ms. | A held pinch can be misread as a fist, but a real E-STOP must never be hidden. |
| D6 | Samples | Gemini writes a JSON shape program. Code builds it, measures it, then scales it to fit or rejects it. Real NASA shape models are presets. | Gemini proposes, code decides. There is no 3D model in the Gemini API, and no GPU is needed. |
| D7 | Guardrails | Grip 15–45 mm (scale to ≤40). Height 10–45 mm. Footprint ≤60 mm. Mass ≤100 g (warn above 50 g). Spacing max(40, r_a + r_b + 10) mm. | The arm-limits research: pads are parallel at 41–45 mm, and the STS3215 at 5 V leaves about 90 g of payload at full reach. To be re-derived for the SO-101 jaw. |
| D8 | Voice | Keep Gemini Live for listening, tools and events, with its audio muted. Live's transcript is spoken by ElevenLabs (24 kHz PCM, Quindar tones). The announcer speaks bay events. | `gemini-3.8-live` can only answer in audio. |
| D9 | Keys | The server proxies Gemini, injects the key, allows only our model ids and rate-limits. Live gets short-lived `authTokens`. The ElevenLabs key stays on the server. | Google disables keys it finds leaked, and the public deploy must not ship one. |
| D10 | Versions | genai 2.23.0, MediaPipe 0.10.35 (WASM from the CDN at the same version), three 0.186.0 | genai 3.0 defaults to API v1, where Live returns 404. |
| D11 | Theme | A light deck with a 1 cm grid fills every bay-camera frame. All decorations go on layer 1, so only the viewer camera sees them. | Dark asteroid samples must stay visible to Robotics-ER. |
| D12 | Infrastructure | Vultr VPS (`vc2-2c-4gb`) with cloud-init, Node 22, Caddy and systemd. Free domain from `tech.study`. Tiger Data only after 20:00. Skip Solana and GPUs. | From the infrastructure research. Vultr has no GPUs in stock. |

## Not yet specified

- A: are Live ephemeral tokens served on v1alpha or v1beta? This needs a smoke test with a real key.
- The user's Gemini key, ElevenLabs key, Vultr account and domain are needed to test these for real.
- The user: will you be at in-person judging Sunday 1:45–4:45 PM in Davis Hall?

## Always / Never

- **Always:**
  - Write all code during the event.
  - Credit every resource and AI tool.
  - Label anything simulated.
  - Hand signals override AI.
  - Code validates every AI-proposed sample and move.
  - Keep tests green.
- **Never:**
  - Copy code from earlier projects.
  - Commit secrets.
  - Push to `main` or open a PR without the user.
  - Create accounts or spend money without the user.
  - Solve CAPTCHAs.

## Progress

| Phase | Status |
| --- | --- |
| Research (9 agents) | Done 15:00 |
| Clean foundation | Done 15:00 (`be6251e`). Public tip made clean with a non-destructive merge at 15:10. |
| C: arm core + safety | **Done.** The SO-101 kinematics match MuJoCo to under 4e-8 m; constants are derived from the model; 88 tests. |
| U: mission-control UI + bay scene | **Done.** Real SO-101 meshes, space backdrop on layer 1 (the bay camera sees only the deck), keypad and the two-step E-STOP reset. |
| A: Gemini + voice + server + Vultr kit | **Done.** Tested with fakes and a fake upstream; no real keys yet. |
| T: teleop (port) | **Done.** |
| G: Fabricator (port) | **Done.** 13 presets, including 4 NASA asteroid models. |
| D: deck | **Done.** 12 slides with real screenshots and speaker notes. |
| Integration | **Done 16:33.** Install modules in `src/plugins.ts`. 229 tests pass and tsc is clean. In the Playwright end-to-end run, the simulated hand steers the arm onto the cube (0.1 mm), one pinch picks it, a second pinch stows it in containment ("Sample secured in containment."), STOP and RESUME are announced, and there are no console errors. |
| Safety and security review | Running (16:35) |
| Real-key smoke tests (Gemini, ElevenLabs, Live) | Waiting on the user's keys |
| Vultr deploy, domain | Waiting on the user's account |
| Devpost draft (due 23:00) | Text ready in `docs/SUBMISSION.md`; the user must create the project on Devpost |

