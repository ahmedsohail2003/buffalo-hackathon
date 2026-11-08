# Demo and video script (draft)

Judging is in person: **3 minutes to pitch and demo, then 2 minutes of questions**. The YouTube video must be under 3 minutes, because judges watch only the first 3. Both use the same beats.

## Beats (about 2:50)

Times come from a rehearsal with real Gemini (Saturday evening). On a normal laptop a Gemini design takes 4–8 s, one CAPCOM step takes 2–3 s, a pick or a place takes about 4 s of arm motion, and a Robotics-ER check takes 3–6 s. Two habits keep the beats on time:
- **Type the next command while you talk** about the current beat, then press Enter on cue. The Fabricator box starts empty.
- **Keep the bin for two samples:** Bennu (teleop) and the meteorite (CAPCOM). In the safety beat, put Itokawa back on the deck, not in the bin.

| Time | Beat | On screen | Say (roughly) |
| --- | --- | --- | --- |
| 0:00–0:15 | Hook | Bay view: Mars outside, the arm, Bennu and Itokawa samples on the deck | "NASA brought back 121 grams of asteroid Bennu, and nobody is allowed to touch it. Curators work through sealed gloveboxes. STARHAND lets you reach in with your bare hand." |
| 0:15–0:45 | **Sense → Act:** hand teleop | Show the Victory sign: cycle start. Turn on **Hand teleop**. Move your hand and the arm follows. Pinch over Bennu, carry it to the bin, pinch again. | "MediaPipe tracks my hand on my own laptop. I only say *where* and *when*. Pinch: the arm's checked code does the precise descent and grip. Pinch again." Mission control: "Bennu secured in containment." |
| 0:45–1:00 | Safety | Pinch Itokawa. Open your palm in the middle of the carry: the arm freezes. Thumbs up: it resumes. Pinch to set Itokawa back down on the deck. | "An open palm stops the arm. Hand signals always beat the AI, and Gemini can't even start the arm." |
| 1:00–1:35 | **Understand:** the Fabricator | Enter "an iron meteorite, about five centimetres". In 4–8 s the result card shows Gemini's design and what code did, for example "scaled to 71% so the arm can lift it: 90 g, 29 mm across". The numbers change with each design. | "Gemini designs the sample as a 3D program. Code measures it against the real SO-101 gripper: width between the jaws, height, mass. Gemini proposes, code decides." |
| 1:35–2:15 | Gemini sees | Run the pre-typed CAPCOM line "Point at the meteorite, then put it in containment." The bay-camera inset marks where Robotics-ER pointed and how many millimetres off it was; the arm picks and stows; the camera check shows on the inset. | Talk over the motion: "Gemini Robotics-ER looks through a fixed bay camera, finds the meteorite to within millimetres, and checks the result. The registry has the final say." |
| 2:15–2:40 | Real data and stack | Click the **Eros, full length** chip: shrunk ×0.57 to fit the 60 mm footprint. Click the **Antenna boom** chip: refused ("too tall and thin for the jaw"). Architecture slide. | "These are real NASA shape models, and code shrinks them to fit or refuses them, out loud. It runs on a Vultr server that keeps every key off the browser." Mission control: "Negative. It is too tall and thin for the jaw." |
| 2:40–2:50 | Close | Title card plus the URL | "STARHAND: reach into deep space, safely." |

If Gemini is slow (over 10 s), keep talking about the guardrails; the card appears when it is ready. If the network fails, the preset chips still work offline.

**Optional extra, if there is time:** type "an antenna boom, 30 cm long". Gemini's design is refused. Gemini then gets one repair turn. The card shows the repaired design with a note, or the second refusal. The result changes from run to run, so the scripted refusal uses the chip.

## Questions to prepare for (2 minutes)

- **"Is it a real robot?"** No. It's a kinematic simulation of the SO-101, the arm I used to train ACT and SmolVLA policies with LeRobot. The kinematics come from the official MuJoCo model. Next step: record teleop sessions as LeRobot datasets.
- **"What did you build this weekend?"** Everything in the repository was written during the event. Earlier projects contributed ideas only. One early commit that copied an earlier project was discarded once we read the rules; PROVENANCE.md discloses it.
- **"What if Gemini is wrong?"** It can't move the arm directly, and it can't even start the arm: only I can start the cycle. Every sample and move goes through code checks, and hand signals override it.
- **"Latency?"** Hand tracking runs at about 30 Hz on the device. A CAPCOM step takes 2–3 s, a design 4–8 s and a Robotics-ER check 3–6 s, and none of them sits in the safety loop.
- **"What does Gemini see?"** Only a fixed 768 × 768 bay-camera image of a light deck with a 1 cm grid; the stars and Mars are drawn where that camera can't see them. Webcam frames never leave the laptop.
- **"Does the voice really work?"** Yes: Gemini Live listens on hold-to-talk and calls the same checked tools. It answers in English, says "Say again?" when it hears nothing clear, and acknowledges long steps ("Pointing now.").

## Recording checklist

- Chrome, at 1280×720 or 1440×900. Allow camera and microphone. Use `?present=1` for the projector layout.
- Record the screen plus system audio, so ElevenLabs is audible.
- Have a backup take using the simulated hand pad (no webcam needed).
- The YouTube shot list, voice-over and description are in [VIDEO-SCRIPT.md](VIDEO-SCRIPT.md).
