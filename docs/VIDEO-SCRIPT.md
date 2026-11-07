# YouTube video script (draft)

The video must be **under 3 minutes**, because judges watch only the first 3. Aim for about 2:45. It follows the same beats as the live demo in [DEMO-SCRIPT.md](DEMO-SCRIPT.md), with tighter voice-over and on-screen captions.

## Recording setup

- **Screen:** Chrome at 1920×1080, with the app at `?present=1`, which makes the text larger. Allow the camera and microphone.
- **Audio:** record the system audio, so that ElevenLabs and the Quindar tones are heard, and your microphone on a separate track. Keep the voice-over 6 dB under mission control when they overlap.
- **Takes:** record each shot on its own, so that you can retake one without redoing the rest.
- **Backup:** if the webcam take fails, use the simulated hand pad (`?sim=1`). Caption that shot "Simulated hand input".
- **Honesty caption:** keep "Kinematic simulation of the SO-101 arm. My hand and voice are real." in the corner for the whole video.

## Shots

| # | Time | On screen | Voice-over | Caption |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:12 | The bay, with Mars outside the window, the arm and the Bennu and Itokawa samples on the deck. Push in slowly. | "In 2023, NASA brought back 121 grams of asteroid Bennu. Nobody is allowed to touch it. Curators work through sealed gloveboxes." | — |
| 2 | 0:12–0:20 | The title card: STARHAND. | "So we built a way to reach in with your bare hand, and let AI make sure nothing goes wrong." | STARHAND: reach into deep space, safely |
| 3 | 0:20–0:55 | **Sense → Act.** The webcam pane beside the bay. Show the Victory sign (cycle start) and turn on **Hand teleop**. Then move your hand: the arm follows. Pinch over Bennu, carry it to containment, and pinch again. | "MediaPipe tracks my hand on my own laptop. I only say where and when. The pinch is a click, and checked code does the precise descent and grip." Mission control: "Sample secured in containment." | Hand tracking runs on the device. Webcam frames never leave it. |
| 4 | 0:55–1:10 | **Safety.** Pick up Itokawa, then open your palm in the middle of the carry: the arm freezes. Thumbs up: it resumes. | "An open palm stops the arm. A fist is an emergency stop. Hand signals always beat the AI." Mission control: "All stop. Arm holding." Then: "Resuming. Arm is live." | Hand signals > panel > code > AI |
| 5 | 1:10–1:50 | **Understand: the Fabricator.** Say or type "Fabricate an iron meteorite, about five centimetres." Hold on the result card: designed 204 g, too heavy, scaled to 90 g. The sample appears on the deck. Then ask for an "antenna boom": it is refused, with a reason. | "Gemini designs the sample as a 3D program. Code measures it against the real SO-101 gripper: the width between the jaws, the height and the mass. If it's too heavy, code shrinks it. If it can't be gripped, code refuses it. Gemini proposes; code decides." | Every AI-made sample fits the real gripper |
| 6 | 1:50–2:20 | **Gemini sees.** Hold TALK and say "Put the meteorite in containment." Robotics-ER marks the sample, with the error in millimetres. The arm moves, and the check result shows. | "Gemini Robotics-ER looks through a fixed bay camera, finds the sample to within millimetres, and checks the result. And it can't start the arm on its own: I gave the cycle start." | Gemini Robotics-ER: point, then verify |
| 7 | 2:20–2:40 | **Real data and the stack.** Load the NASA Eros model: it is shrunk ×0.57 to fit. Cut to the architecture slide. | "These are real NASA shape models of Bennu, Itokawa, Eros and Kleopatra. It runs on a Vultr server that keeps every API key off the browser, and ElevenLabs gives mission control its voice." | NASA 3D Resources · Gemini · ElevenLabs · Vultr |
| 8 | 2:40–2:50 | The title card, with the URL and the GitHub link. | "STARHAND. Reach into deep space, safely." | `<domain>` · github.com/ahmedsohail2003/buffalo-hackathon |

Check the numbers on screen against the live app before recording. The 204 g → 90 g and ×0.57 figures come from the last end-to-end run.

## YouTube details

**Title:** STARHAND: reach into a deep-space sample bay with your bare hand (UB Hacking 2026)

**Description:**

> STARHAND is a sample-curation bay on a deep-space station, running in your browser. Your webcam tracks your hand on your own device, and a simulated SO-101 robot arm follows it: pinch to pick up an asteroid sample, pinch again to set it down. Gemini designs new samples, and code checks each one against the real gripper before it exists. Gemini Robotics-ER watches the bay and checks every placement, and ElevenLabs is the voice of mission control.
>
> What is simulated: the arm is a kinematic simulation of the SO-101 (MuJoCo Menagerie model), with no physics. My hand and voice are real.
>
> Built at UB Hacking 2026. Code: https://github.com/ahmedsohail2003/buffalo-hackathon
>
> Credits: MuJoCo Menagerie SO-101 (Apache-2.0); NASA 3D Resources asteroid shape models (Itokawa: NASA/JAXA) and a Mars texture; three.js, React, MediaPipe and @google/genai. AI tools: Claude Code wrote most of the code under my direction; Gemini and ElevenLabs run in the app.

**Chapters:**

```
0:00 Bennu and the glovebox
0:20 Hand teleop
0:55 Hand signals
1:10 The Fabricator
1:50 Gemini Robotics-ER
2:20 NASA data and the stack
```

**Visibility:** Public or Unlisted. Devpost needs a link that judges can open.
