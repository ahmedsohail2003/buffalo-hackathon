# Demo and video script (draft)

Judging is in person: **3 minutes to pitch and demo, then 2 minutes of questions**. The YouTube video must be under 3 minutes, because judges watch only the first 3. Both use the same beats.

## Beats (about 2:50)

| Time | Beat | On screen | Say (roughly) |
| --- | --- | --- | --- |
| 0:00–0:15 | Hook | Bay view: Earth/Mars outside, the arm, Bennu and Itokawa samples on the deck | "NASA brought back 121 grams of asteroid Bennu, and nobody is allowed to touch it. Curators work through sealed gloveboxes. STARHAND lets you reach in with your bare hand." |
| 0:15–0:50 | **Sense → Act:** hand teleop | Hand pane (webcam) next to the bay. Move your hand and the arm follows. Pinch over Bennu, then carry it to containment. | "MediaPipe tracks my hand on my own laptop. I only say *where* and *when*. Pinch: the arm's checked code does the precise descent and grip. Pinch again." Mission control (ElevenLabs): "Sample secured in containment." |
| 0:50–1:05 | Safety | Open palm in the middle of a carry: the arm freezes. Thumbs up: it resumes. | "An open palm stops the arm. Hand signals always beat the AI." |
| 1:05–1:45 | **Understand:** the Fabricator | Type or say: "Fabricate an iron meteorite, about five centimetres." The result card shows "designed 38 mm, 204 g, too heavy; scaled ×0.76 to 28.9 mm, 90 g". The sample appears. | "Gemini designs the sample as a 3D program. Code measures it against the real SO-101 gripper: width between the jaws, height, mass. Gemini proposes, code decides." |
| 1:45–2:15 | Gemini sees | "Put the meteorite in containment." Robotics-ER points at the sample; the plan and its check show on screen. | "Gemini Robotics-ER looks through the bay camera, finds it to within millimetres, and checks the result." |
| 2:15–2:40 | Real data and stack | Load the NASA Eros preset: at full length it is shrunk ×0.57 to fit the 60 mm footprint. Ask for an "antenna boom": it is refused ("too tall and thin…"). Architecture slide. | "These are real NASA shape models, and code shrinks them to fit or refuses them, out loud. It runs on a Vultr server that keeps every key off the browser." |
| 2:40–2:50 | Close | Title card plus the URL | "STARHAND: reach into deep space, safely." |

## Questions to prepare for (2 minutes)

- **"Is it a real robot?"** No. It's a kinematic simulation of the SO-101, the arm I used to train ACT and SmolVLA policies with LeRobot. The kinematics come from the official MuJoCo model. Next step: record teleop sessions as LeRobot datasets.
- **"What did you build this weekend?"** Everything in the repository was written during the event. Earlier projects contributed ideas only. One early commit that copied an earlier project was discarded once we read the rules; PROVENANCE.md discloses it.
- **"What if Gemini is wrong?"** It can't move the arm directly, and it can't even start the arm: only I can start the cycle. Every sample and move goes through code checks, and hand signals override it.
- **"Latency?"** Hand tracking runs at about 30 Hz on the device. Gemini checks take about 1–3 s each and never sit in the safety loop.

## Recording checklist

- Chrome, at 1280×720 or 1440×900. Allow camera and microphone. Use `?present=1` for the projector layout.
- Record the screen plus system audio, so ElevenLabs is audible.
- Have a backup take using the simulated hand pad (no webcam needed).
- The YouTube shot list, voice-over and description are in [VIDEO-SCRIPT.md](VIDEO-SCRIPT.md).
