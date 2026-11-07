# Devpost submission (draft)

Paste-ready fields for https://ubhacking2026.devpost.com/. Update the `<…>` placeholders before submitting. The Devpost draft is due at 11 PM Saturday; final submissions close Sunday November 8 at 1:30 PM EST.

## Project name

STARHAND

## Tagline (60 characters or fewer)

Reach into a deep-space sample bay with your bare hand.

## Prize categories to select

- Best Overall (automatic)
- Radial Atoms (Radial Ventures)
- Spirit of the Hackathon (deep-space theme)
- Best AI/ML
- Best UI/UX Hack
- MLH Best Use of Gemini API (needs the Google AI Studio / Cloud project number: `<project number>`)
- MLH Best Use of ElevenLabs
- MLH Best Use of Vultr (if deployed)
- MLH Best Domain Name from GoDaddy Registry (if a domain is registered)
- MLH Best Use of Tiger Data (only if built)

## Inspiration

NASA's OSIRIS-REx mission brought back 121.6 g of asteroid Bennu. Curators at Johnson Space Center open it inside sealed gloveboxes, because nothing may touch it except clean tools. Two fasteners stuck, and they needed new tools to get in. The samples turned out to contain all five nucleobases and 14 of the 20 amino acids life uses.

We asked a simple question: what if a curator, or anyone, could reach into that glovebox with their bare hand, from anywhere, and an AI made sure nothing went wrong?

## What it does

STARHAND is a sample-curation bay on a deep-space station, running in your browser.

- **Sense:** your webcam tracks your hand on your own device with MediaPipe, and a simulated SO-101 robot arm follows it. Pinch once to pick up the asteroid sample under the gripper; pinch again to set it down. Open your palm and the arm freezes. Hold a fist and the bay goes to emergency stop.
- **Understand:** ask Gemini for a new sample, for example "an iron meteorite, about 5 cm". Gemini designs it as a 3D shape program. Code then builds the object and measures it: the width across the gripper's jaws, its height and its mass. It scales the sample until the real SO-101 gripper could actually hold it, or it refuses and explains why. Gemini Robotics-ER watches the bay through a fixed camera and checks every placement.
- **Act:** the arm carries out the plan with inverse kinematics on the real SO-101 geometry, and ElevenLabs gives mission control its voice: "Sample secured in containment."
- **Real data:** the asteroids in the bay are real NASA shape models of Bennu, Itokawa, Eros and Kleopatra, scaled down to fit the gripper.

## How we built it

- **Arm.** We converted the SO-101 from MuJoCo Menagerie (MJCF plus STL) into a compact web model. We wrote forward and inverse kinematics for the browser, using damped least squares with the gripper held pointing down. We checked them against MuJoCo itself: the tool-centre point, joints and jaw gap agree to under 4e-8 m. Hover height, carry height, reach band and jaw-gap mapping are all derived from the model, not guessed.
- **Shared-autonomy teleop.** MediaPipe's Gesture Recognizer gives 21 hand landmarks and a gesture label in one pass on your device. The hand sets a hover target, smoothed with a One-Euro filter and clamped into the reach band. A pinch is a click that calls the same checked pick and place routines the AI uses. If the hand leaves view, the arm holds. A fist is masked only during a real pinch, for at most 500 ms, so a real emergency stop is never hidden.
- **Fabricator.** Gemini Flash writes a JSON shape program constrained by a JSON schema. Code then:
  - clamps every number;
  - builds a mesh from primitives, rocks (noise-displaced icospheres with craters), lathes, extrusions or NASA shape models;
  - measures the width across the jaws within the band the pads actually touch;
  - scales the sample to fit, or refuses it with a sentence the voice can say.
- **Gemini Robotics-ER** looks through a fixed 768 × 768 bay camera to point at samples (error shown in millimetres) and to verify placements.
- **Voice.** Gemini Live listens on hold-to-talk and calls the same tools. Its replies are spoken by ElevenLabs, streamed as 24 kHz PCM with Apollo Quindar tones. A mission-control announcer speaks safety events.
- **Server.** A dependency-free Node server holds every key. It proxies Gemini with a model allowlist and per-IP rate limits, mints short-lived Live tokens, and streams speech. It deploys to a Vultr VPS behind Caddy.
- **Safety order:** hand signals, then the on-screen panel, then the code gate, then AI. Gemini proposes; code decides.

- three.js, React and Vite in the browser.
- MuJoCo Menagerie's SO-101 model, converted to the web.
- Damped least squares inverse kinematics, with the gripper held pointing down.
- MediaPipe Gesture Recognizer for hand landmarks and safety signals.
- Gemini: Gemini Flash designs samples and runs the coworker; Gemini Robotics-ER points at parts and checks the bay; Gemini Live listens to your voice.
- ElevenLabs: Flash v2.5 streaming speech at 24 kHz, with Apollo Quindar tones, plus sound effects.
- A dependency-free Node server, deployed on Vultr, that keeps every API key off the browser.

## Challenges we ran into

- **A tight workspace.** With the gripper pointing straight down, the SO-101's wrist limit caps the tool-centre point at about 86 mm, which leaves a narrow reach band. Shared autonomy was the answer: the hand gives intent, and checked code does the fine motion.
- **Pinch versus fist.** A pinch can look like a fist to a gesture model. Pinches became short clicks, and the fist mask became pose-checked and time-capped.
- **Keeping the AI's view clean.** Stars, Mars and glass are drawn on a render layer the bay camera cannot see, so Robotics-ER only ever sees a light deck with a 1 cm grid.

## Accomplishments that we're proud of

- **A tested end-to-end loop on the real SO-101 kinematics.** A simulated hand steers the arm to within 0.1 mm of a sample. One pinch picks it, a second pinch stows it in containment, and mission control says "Sample secured in containment."
- **Physically plausible AI-made objects.** Every sample on the deck fits the real gripper: an iron meteorite designed at 204 g is shrunk to 90 g, and an antenna boom is refused with a reason.
- **About 230 automated tests**, written during the event.

## What we learned (new skills)

On-device hand-tracking teleoperation with MediaPipe. Converting and validating a MuJoCo robot model for the web. Procedural 3D from AI shape programs, with geometric guardrails. ElevenLabs streaming voice and sound design. Deploying a key-holding server on Vultr.

## What's next

- Recording every teleop session as a LeRobot-format demonstration dataset, to train ACT policies (Zhao et al., 2023) for the real SO-101.
- Running the same loop on a physical arm.

## Honest scope: what is real and what is simulated

- **Real:** your hand tracking (webcam, on device), your voice, the Gemini and ElevenLabs calls, and the SO-101 geometry (MuJoCo Menagerie).
- **Simulated:** the arm itself. It is a kinematic simulation with no physics, not a real robot. Samples attach to the jaw by rule, and their masses come from assumed densities.
- **Leaves your machine:** microphone audio while TALK is held (Gemini Live), bay-camera frames when Gemini checks the bay, and the text mission control speaks (ElevenLabs). Webcam frames never leave your machine.

## Built with

`three.js` `react` `typescript` `vite` `mediapipe` `gemini-api` `gemini-robotics-er` `gemini-live` `elevenlabs` `node.js` `vultr` `mujoco-menagerie` `nasa-3d-resources`

## Credits and AI-tool disclosure

See [PROVENANCE.md](../PROVENANCE.md).

- **Resources:**
  - the SO-101 model from MuJoCo Menagerie (Apache-2.0)
  - NASA 3D Resources asteroid shape models (Itokawa credited to NASA/JAXA)
  - a NASA Mars texture
  - three.js, React, MediaPipe and `@google/genai`
- **AI tools:** Claude Code wrote most of the code under my direction. Gemini and ElevenLabs run in the app.
- **Earlier work:** the ideas build on my earlier EmberHacks project. No code from it, or from any earlier repository, is used; all code was written during UB Hacking.

## Links

- Code: `<https://github.com/ahmedsohail2003/buffalo-hackathon>`
- Live: `<https://your-domain>` on Vultr
- Video (under 3 minutes): `<YouTube link>`

## Team

Ahmed Sohail Butt `<+ teammates if any>`
