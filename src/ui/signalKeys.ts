// The simulated signal keypad: keys 1-5 hold one hand signal each. Commands and dwell times come
// from the safety machine (src/safety); this table only adds the keys and the operator labels.
import { GESTURE_COMMANDS, dwellFor, type GestureLabel, type SignalCommand } from '../safety';

export interface SignalKey {
  key: string;
  gesture: GestureLabel;
  command: SignalCommand;
  gestureLabel: string;
  commandLabel: string;
  dwellMs: number;
}

const KEYS: [string, GestureLabel, string, string][] = [
  ['1', 'Open_Palm', 'Open palm', 'Stop'],
  ['2', 'Closed_Fist', 'Fist, held 1.5 s', 'E-stop'],
  ['3', 'Thumb_Up', 'Thumb up', 'Resume'],
  ['4', 'Pointing_Up', 'Point up', 'Slow'],
  ['5', 'Victory', 'Victory', 'Cycle start'],
];

export const SIGNAL_KEYS: readonly SignalKey[] = KEYS.map(([key, gesture, gestureLabel, commandLabel]) => ({
  key,
  gesture,
  command: GESTURE_COMMANDS[gesture],
  gestureLabel,
  commandLabel,
  dwellMs: dwellFor(gesture),
}));

export const SIGNAL_COLORS: Record<SignalCommand, string> = {
  STOP: '#ef4444',
  ESTOP: '#ef4444',
  RESUME: '#22c55e',
  CYCLE_START: '#38bdf8',
  SLOW: '#f59e0b',
};
