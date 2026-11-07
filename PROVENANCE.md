# Provenance and disclosures

The UB Hacking 2026 rules say project code must be written during the official hacking period. Previously started projects, and projects submitted to another event, are not eligible. This file records how STARHAND meets those rules, and lists every resource and AI tool it uses.

## What existed before the event, and what did not come in

- **Ideas only.** At EmberHacks in September 2026 I built a different project, "the cell" (github.com/ahmedsohail2003/emberhacks-cell). It was a voice-instructed SO-ARM100 work cell. STARHAND reuses some of that project's *ideas*: a validator as the trust boundary between AI and the arm, gestures as the safety channel, and a fixed camera that Gemini looks through. The rules allow planning and ideas before the event.
- **No code.** No code, data file, test fixture or asset from that project, or from any of my earlier repositories, is in this repository. Every file in the commit history was written on November 7–8, 2026, after hacking started.
- **Robot arm.** STARHAND uses the newer SO-101 arm, converted tonight from the public MuJoCo Menagerie model, not the SO-ARM100 data from earlier work.

## Third-party resources (credits)

| Resource | Used for | License |
| --- | --- | --- |
| MuJoCo Menagerie `robotstudio_so101` (derived from TheRobotStudio SO-ARM100 repository) | Arm meshes and kinematics, converted by `scripts/convert-so101.mjs` | Apache-2.0 |
| NASA 3D Resources: asteroid shape models for Bennu, Itokawa (NASA/JAXA), Eros and Kleopatra; Mars texture | Real asteroid samples, decimated and scaled to fit the gripper; the planet outside the bay | NASA media are generally not subject to US copyright. Credit NASA; no endorsement is implied, and the NASA insignia is not used. |
| three.js, React, Vite, Vitest, TypeScript | Rendering and app framework | MIT / Apache-2.0 |
| MediaPipe Tasks Vision (Gesture Recognizer, with hand landmarks) | On-device hand tracking and safety gestures | Apache-2.0 |
| `@google/genai` | Gemini API client | Apache-2.0 |
| Inter and JetBrains Mono typefaces | UI and telemetry type: Latin subsets self-hosted in `public/fonts/` (licence text alongside) | SIL OFL-1.1 (Inter); Apache-2.0 / SIL OFL-1.1 (JetBrains Mono) |

CadPilot (an EmberHacks 2026 project) inspired one technique: asking a model for dimensions first, then repairing errors from validator feedback. No CadPilot code is used; its repository has no license.

## AI tools used to build this

- **Claude Code** (Anthropic) wrote most of the code under my direction: planning, implementation and tests. I chose the design, the safety rules and the scope.
- **At runtime**, Google Gemini designs samples, runs the coworker and Robotics-ER checks, and ElevenLabs provides the voice and sound effects. Both are described in the README.

## What is simulated

- The arm is a kinematic simulation of the SO-101 with no physics, not a real robot.
- Samples attach to the jaw by rule, and their masses come from assumed densities.
- Hand tracking and voice are real inputs.
