// Gesture vocabulary metadata: display names, keyboard bindings for the
// simulated-input mode, command colors, and the honest provenance note for
// each mapping (literal crane signal vs. adaptation).

import type { CommandId, GestureLabel } from './stateMachine';

export interface GestureInfo {
  label: GestureLabel;
  key: string;
  display: string;
  /** Short name that fits on a keypad card. */
  cardName: string;
  /** One-line provenance tag that fits on a keypad card. */
  cardOrigin: string;
  command: CommandId;
  commandLabel: string;
  /** Provenance relative to the ASME B30.5 crane signalperson vocabulary. */
  craneNote: string;
  adapted: boolean;
}

export const GESTURES: GestureInfo[] = [
  {
    label: 'Open_Palm',
    key: '1',
    display: 'Open palm',
    cardName: 'Open palm',
    cardOrigin: 'B30.5 STOP — literal',
    command: 'STOP',
    commandLabel: 'STOP',
    craneNote: 'Matches the crane STOP signal (open hand, palm out)',
    adapted: false,
  },
  {
    label: 'Closed_Fist',
    key: '2',
    display: 'Closed fist, hold 1.5 s',
    cardName: 'Closed fist',
    cardOrigin: 'hold 1.5 s — adapted',
    command: 'EMERGENCY_STOP',
    commandLabel: 'EMERGENCY STOP',
    craneNote: 'Adapted from "dog everything" (clasped hands = halt all)',
    adapted: true,
  },
  {
    label: 'Thumb_Up',
    key: '3',
    display: 'Thumb up',
    cardName: 'Thumb up',
    cardOrigin: 'adapted — confirm',
    command: 'RESUME',
    commandLabel: 'RESUME',
    craneNote: 'Adapted; not a B30.5 signal — universal confirm gesture',
    adapted: true,
  },
  {
    label: 'Pointing_Up',
    key: '4',
    display: 'Index finger up',
    cardName: 'Index up',
    cardOrigin: "'move slowly' · adapted",
    command: 'SLOW',
    commandLabel: 'SLOW MODE',
    craneNote: 'Adapted from the "move slowly" hand-over-signal modifier',
    adapted: true,
  },
  {
    label: 'Victory',
    key: '5',
    display: 'Two fingers (V)',
    cardName: 'V sign',
    cardOrigin: 'adapted — distinct pose',
    command: 'CYCLE_START',
    commandLabel: 'CYCLE START',
    craneNote: 'Adapted; no crane equivalent — chosen as a distinct pose',
    adapted: true,
  },
];

export const KEY_TO_GESTURE: Record<string, GestureLabel> = {
  '1': 'Open_Palm',
  '2': 'Closed_Fist',
  '3': 'Thumb_Up',
  '4': 'Pointing_Up',
  '5': 'Victory',
};

export const COMMAND_LABELS: Record<CommandId, string> = {
  STOP: 'STOP',
  EMERGENCY_STOP: 'EMERGENCY STOP',
  RESUME: 'RESUME',
  SLOW: 'SLOW MODE',
  CYCLE_START: 'CYCLE START',
};

export const COMMAND_COLORS: Record<CommandId, string> = {
  STOP: '#F59E0B',
  EMERGENCY_STOP: '#EF4444',
  RESUME: '#34D399',
  SLOW: '#60A5FA',
  CYCLE_START: '#7DD3FC',
};
