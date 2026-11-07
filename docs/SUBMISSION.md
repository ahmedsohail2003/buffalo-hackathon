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

`<fill after integration: architecture diagram, stack, the trust boundary "Gemini proposes, code decides", safety precedence "hand signals > panel > code gate > AI">`

- three.js, React and Vite in the browser.
- MuJoCo Menagerie's SO-101 model, converted to the web.
- Damped least squares inverse kinematics, with the gripper held pointing down.
- MediaPipe Gesture Recognizer for hand landmarks and safety signals.
- Gemini: Gemini Flash designs samples and runs the coworker; Gemini Robotics-ER points at parts and checks the bay; Gemini Live listens to your voice.
- ElevenLabs: Flash v2.5 streaming speech at 24 kHz, with Apollo Quindar tones, plus sound effects.
- A dependency-free Node server, deployed on Vultr, that keeps every API key off the browser.

## Challenges we ran into

`<fill>`

## Accomplishments that we're proud of

`<fill>`

## What we learned (new skills)

`<fill: on-device hand-tracking teleoperation, procedural 3D from AI shape programs, ElevenLabs voice and sound design, deploying on Vultr>`

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
