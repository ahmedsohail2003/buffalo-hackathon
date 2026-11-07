# STARHAND speaker notes (about 2:50)

These lines follow the beats in [docs/DEMO-SCRIPT.md](../docs/DEMO-SCRIPT.md). Judging gives 3 minutes for pitch and demo, then 2 minutes of questions. Most of the 3 minutes is the live app; the deck opens and closes it.

`build_deck.py` copies each `### Slide N` section below into that slide's presenter notes. Edit the lines here, then rebuild the deck.

## Run of show

| Time | On screen | Beat |
| --- | --- | --- |
| 0:00–0:15 | Slides 1 and 2 | Hook |
| 0:15–0:20 | Slide 3, then slide 4 and switch to the app | Sense, understand, act |
| 0:20–0:50 | App: hand pane and bay | Sense → Act: hand teleop |
| 0:50–1:05 | App | Safety signals |
| 1:05–1:40 | App: Fabricator | Understand: Gemini proposes, code decides |
| 1:40–2:05 | App: bay camera | Gemini Robotics-ER sees the bay |
| 2:05–2:15 | App: Eros preset | Real NASA data |
| 2:15–2:22 | Slides 5 and 6 | The two rules |
| 2:22–2:33 | Slide 7 | Stack |
| 2:33–2:40 | Slide 8 | Honest scope |
| 2:40–2:50 | Slides 9 and 10 | Next, and close |
| Questions | Slides 11 and 12 (screenshots), 5, 6, 8 | Backup |

Changes from DEMO-SCRIPT.md, using the numbers measured in the app:

- **Fabricator:** the Iron meteorite preset is designed at 38 mm and 204 g. Code scales it ×0.76 to 28.9 mm and 90 g, the arm's payload.
- **Eros:** at full length it is shrunk ×0.57 to fit the 60 mm footprint, not refused. The refusal example is now an antenna boom.
- **Timing:** the Eros beat moves into the live segment (2:05–2:15), so the deck has 2:15–2:50 for the rules, the stack and the close.

## Lines

### Slide 1 · Title — 0:00–0:03

"Hi, I'm Ahmed. This is STARHAND."

### Slide 2 · The problem — 0:03–0:15

"NASA brought back 121.6 grams of asteroid Bennu, and nothing may touch it: curators work through sealed gloveboxes. Put that bay near the Moon, and every command arrives 1.3 seconds late."

### Slide 3 · Sense → Understand → Act — 0:15–0:20

"STARHAND lets you reach in with your bare hand: sense, understand, act. Let me show you."

Go to slide 4, then switch to the browser.

### Slide 4 · Live demo — 0:20–2:15

**Teleop, 0:20–0:50.** Move your hand and the arm follows. Pinch over Bennu, carry it to containment, pinch again.

"MediaPipe tracks my hand right here on my laptop, and the SO-101 follows it. I only say where and when. Pinch: the arm's checked code does the precise descent and grip. Over containment, pinch again."

Mission control (ElevenLabs): "Sample secured in containment."

**Safety, 0:50–1:05.** Open your palm in the middle of a carry, then give a thumbs-up.

"Open palm: the arm freezes. Thumbs up: it resumes. A held fist is an emergency stop. Hand signals always beat the AI."

**Fabricator, 1:05–1:40.** Load the Iron meteorite preset, or ask for one. Read the numbers off the result card. For the preset they are 38 mm and 204 g, scaled ×0.76 to 28.9 mm and 90 g.

"Fabricate an iron meteorite."

"Gemini designs the sample as a 3D shape program. Code builds it and measures it against the real SO-101 gripper. 204 grams is too heavy for the arm's 90-gram payload, so code scales it by 0.76: 28.9 millimetres across the jaws, 90 grams. Gemini proposes; code decides."

**Gemini sees, 1:40–2:05.**

"Put the meteorite in containment."

"Gemini Robotics-ER looks through the fixed bay camera, finds the sample to within millimetres, and checks the result after the move."

**Real data, 2:05–2:15.** Load the Eros preset.

"These asteroids are real NASA shape models. Eros at full length is too long for the bay, so code shrinks it ×0.57 to fit the 60-millimetre footprint."

If there is time, ask for an antenna boom: code refuses it and says how to fix it.

If the demo breaks: stay on this slide and tell the same beats. For pictures, type 11 and press Enter for the teleop screenshot, then 12 for the Fabricator. Type 5 and press Enter to come back. If the webcam fails, open the app with `?sim=1` and use the simulated hand pad.

### Slide 5 · Gemini proposes, code decides — 2:15–2:19

"Everything you saw follows two rules. One: Gemini proposes, code decides."

If asked "What if Gemini is wrong?": "It can't move the arm directly. Every sample goes through code checks: grip 15 to 45 millimetres, height up to 45, the arm's 90-gram payload, a 60-millimetre footprint. One uniform scale makes it fit, or code refuses and says how to fix it, like this antenna boom: too tall and thin."

### Slide 6 · Safety precedence — 2:19–2:22

"Two: hand signals beat everything, including the AI."

If asked: "Gemini can never start, stop, resume or reset the bay. Open palm stops, a held fist is an emergency stop, thumbs-up resumes, and with no hand in view the arm holds."

### Slide 7 · Architecture — 2:22–2:33

"It runs on a Vultr server that holds every API key, so the browser never sees one, and hand tracking stays on your device."

If asked about latency: "Hand tracking runs at about 30 Hz on the device. Gemini checks take about 1 to 3 seconds each and never sit in the safety loop."

### Slide 8 · Real vs simulated — 2:33–2:40

"To be clear: the arm is a kinematic simulation of the real SO-101. My hand, my voice and the AI calls are real."

If asked "Is it a real robot?": "No. It's a kinematic simulation of the SO-101, the arm I used to train ACT and SmolVLA policies with LeRobot. The kinematics come from the official MuJoCo Menagerie model, and they match MuJoCo to within 4 × 10⁻⁸ m."

If asked "What did you build this weekend?": "Everything in the repository; the commit history starts today. Earlier projects contributed ideas only. Claude Code wrote most of the code under my direction."

### Slide 9 · What's next — 2:40–2:46

"Next: record these sessions as LeRobot datasets, train ACT, and run it on a real SO-101."

### Slide 10 · Thank you — 2:46–2:50

"STARHAND: reach into deep space, safely. Thank you."

### Slide 11 · Backup: teleop screenshot

Use this slide if teleop fails during the live demo, or for a question about hand control. Say the teleop lines from slide 4 over it: "My hand sets where, a pinch says when, and with no hand in view the arm holds."

### Slide 12 · Backup: Fabricator screenshot

Use this slide if the Fabricator fails during the live demo, or for "What if Gemini is wrong?". Say the Fabricator lines from slide 4 over it, then: "If no single scale fits, code refuses and says how to fix it."

## Questions (2 minutes)

| Question | Answer | Slide |
| --- | --- | --- |
| Is it a real robot? | No. A kinematic simulation of the SO-101, built from the official MuJoCo Menagerie model. It's the arm I trained ACT and SmolVLA policies on with LeRobot. | 8 |
| How accurate is the simulated arm? | Its kinematics match MuJoCo to within 4 × 10⁻⁸ m. Reach is 130–200 mm; the gripper hovers at 60 mm and carries at 70 mm. | 3, 8 |
| What did you build this weekend? | Everything in the repository; the commit history starts today. Earlier projects contributed ideas only. | 8 |
| What if Gemini is wrong? | It can't move the arm. Code checks every sample and move, and hand signals override it. A design that can't fit is refused with a fix, like the antenna boom. | 5, 6, 12 |
| Latency? | Hand tracking runs at about 30 Hz on the device. Gemini checks take about 1–3 s and never sit in the safety loop. | 7 |
| Why not copy my hand motion exactly? | The reach band is narrow and the gripper must point down, so raw hand motion jitters out of the workspace. Your hand sets the hover point; a pinch calls the checked pick or place. | 3, 11 |
| Where do the limits come from? | Arm-limits research: the jaw pads are parallel at 41–45 mm, and the STS3215 servos at 5 V leave about 90 g of payload at full reach. | 5 |
| Where do the masses come from? | Code sets a density for each material. The masses are assumed, and the app says so. | 8 |
| What leaves my machine? | Microphone audio while TALK is held (Gemini Live), bay-camera frames when Gemini checks the bay, and the text mission control speaks. Webcam frames never leave. | 7 |
