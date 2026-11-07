# STARHAND

Reach into an orbital sample-curation bay with your bare hand.

STARHAND is a browser simulation of a sample-curation bay on a deep-space station:

- **Your hand:** the webcam tracks it with MediaPipe on your own device, and a simulated SO-101 robot arm follows it. Pinch once to pick up the asteroid sample under the gripper; pinch again to put it down.
- **Gemini:** designs new samples, such as meteorites, canisters and CubeSat parts. Gemini Robotics-ER checks the bay through a fixed camera.
- **Code:** measures every sample against what the real gripper can hold, scales it to fit or refuses it, and says why.
- **ElevenLabs:** is mission control's voice.
- **Safety:** open palm stops the arm and a held fist is an emergency stop. Hand signals always override AI.

Built at UB Hacking 2026 (November 7–8). Every line of code was written during the event; see [PROVENANCE.md](PROVENANCE.md) for disclosures and credits. Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

> **Status:** under construction during the hackathon. The arm is a kinematic simulation, not a real robot.

## Private files

This repository is public, including its commit history. Git ignores the locations below, so files in them are never committed or pushed:

| Location | Examples |
| --- | --- |
| Any folder named `private`, at any depth | `private/notes.md`, `src/private/data.csv` |
| Any file with `.private.` in its name | `pitch.private.md` |
| `.env` and `.env.*`, except `.env.example` | `.env`, `.env.local` |

Everything else can be committed and published.

This repo does not back up or share private files. The top-level `private/` folder is backed up separately to a private repo. Other private files exist only on the computer that holds them.

To check a file before you commit it, run this command. If it prints a matching rule, the file is private. If it prints nothing, the file can be published.

```bash
git check-ignore -v path/to/file
```
