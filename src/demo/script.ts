// Guided-demo script: a ~45 second scripted tour that drives the SIMULATED
// input path through a story (cycle start -> slow -> stop -> resume -> e-stop
// -> two-step reset) with narration captions.
//
// The demo injects held gestures exactly the way the keyboard/keypad does —
// through the same state machine, cell, and logging — so everything it shows
// is real prototype behavior, just with scripted timing. Step timings are
// unit-tested against the state-machine configuration so the demo cannot
// silently break when dwell/debounce/refractory parameters change.

import type { GestureLabel } from '../gesture/stateMachine';

export interface DemoStep {
  /** Narration caption shown for the whole step. */
  caption: string;
  /** Step duration; the next step begins when it elapses. */
  durMs: number;
  /** Gesture held from the start of the step... */
  hold?: GestureLabel;
  /** ...for this long, then released. */
  holdMs?: number;
  /** On-screen panel action performed at the start of the step. */
  action?: 'resetArm' | 'resetConfirm';
}

export const DEMO_DWELL_MS = 600; // the demo pins the dwell slider here
export const DEMO_CONFIDENCE = 0.95; // synthetic confidence while scripted

export const DEMO_STEPS: DemoStep[] = [
  {
    caption:
      'Guided demo. Simulated input drives the exact same pipeline as the camera — watch the ring, the andon, and the state banner.',
    durMs: 4000,
  },
  {
    caption:
      'CYCLE START — hold the V sign (key 5) until the ring fills. A command is a deliberate hold, never a passing pose.',
    durMs: 4000,
    hold: 'Victory',
    holdMs: 1300,
  },
  {
    caption:
      'The cell is RUNNING: the 3D SO-ARM100 accepts arm tasks from Gemini. Andon shows green RUN.',
    durMs: 3500,
  },
  {
    caption:
      'A person approaches the cell. Index up (key 4) — SLOW MODE drops motion to 50% speed.',
    durMs: 4000,
    hold: 'Pointing_Up',
    holdMs: 1300,
  },
  {
    caption:
      'Open palm (key 1) — STOP. The literal ASME B30.5 crane signal. The arm freezes mid-move; Gemini tasks wait while the cell is stopped.',
    durMs: 4000,
    hold: 'Open_Palm',
    holdMs: 1300,
  },
  {
    caption:
      'Thumb up (key 3) — RESUME. The cell returns to the state it was stopped in: SLOW, not full speed.',
    durMs: 4000,
    hold: 'Thumb_Up',
    holdMs: 1300,
  },
  {
    caption:
      'Thumb up again from SLOW MODE restores full speed. Same gesture, state-dependent meaning — always shown in the banner.',
    durMs: 4500,
    hold: 'Thumb_Up',
    holdMs: 1300,
  },
  {
    caption:
      'EMERGENCY STOP — closed fist (key 2) held a full 1.5 s. A false e-stop halts production, so it must cost more intent.',
    durMs: 5000,
    hold: 'Closed_Fist',
    holdMs: 2300,
  },
  {
    caption:
      'Locked out: flashing andon, reset interlock on screen. No gesture can make this cell live again.',
    durMs: 3500,
  },
  {
    caption:
      'Recovery is deliberately manual, at the panel. Step 1 — RESET E-STOP latches.',
    durMs: 3000,
    action: 'resetArm',
  },
  {
    caption:
      'Step 2 — CONFIRM. The cell returns only to IDLE, never straight to RUNNING.',
    durMs: 3000,
    action: 'resetConfirm',
  },
  {
    caption:
      'End of demo — the cell awaits a fresh CYCLE START. Try it yourself: keys 1–5, or press and hold the keypad below.',
    durMs: 3000,
  },
];

export const DEMO_TOTAL_MS = DEMO_STEPS.reduce((s, st) => s + st.durMs, 0);
