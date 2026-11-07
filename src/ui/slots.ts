// UI extension points. Each layer registers its React pieces here (usually from its install
// module imported by src/plugins.ts), so wiring a layer in never touches the layout code.
import { useSyncExternalStore, type ComponentType } from 'react';
import type { TeleopStatus } from '../contracts';
import type { InputMode } from '../app/runtime';

export type MissionSlotName = 'coworker' | 'fabricator';

/** Props every Hand-pane extra receives (for example the teleop panel and the simulated hand pad). */
export interface HandPaneExtraProps {
  mode: InputMode;
}

/** What the 'Hand teleop' toggle drives (the teleop controller fits as is). */
export interface TeleopController {
  enable(): void;
  disable(reason?: string): void;
  status(): TeleopStatus;
}

interface SlotState {
  mission: Partial<Record<MissionSlotName, ComponentType>>;
  handExtras: { id: string; Component: ComponentType<HandPaneExtraProps> }[];
  teleop: TeleopController | null;
}

let state: SlotState = { mission: {}, handExtras: [], teleop: null };
const subs = new Set<() => void>();
const notify = () => subs.forEach((cb) => cb());
const subscribe = (cb: () => void) => {
  subs.add(cb);
  return () => subs.delete(cb);
};

/** Fill a Mission-pane slot ('coworker' or 'fabricator'). Returns unregister. */
export function registerMissionSlot(name: MissionSlotName, Component: ComponentType): () => void {
  state = { ...state, mission: { ...state.mission, [name]: Component } };
  notify();
  return () => {
    if (state.mission[name] !== Component) return;
    const mission = { ...state.mission };
    delete mission[name];
    state = { ...state, mission };
    notify();
  };
}

/**
 * Add a component under the signal keypad in the Hand pane, in registration order
 * (for example `({ mode }) => <TeleopPanel teleop={teleop} mode={mode} />`). Returns unregister.
 */
export function registerHandPaneExtra(id: string, Component: ComponentType<HandPaneExtraProps>): () => void {
  state = { ...state, handExtras: [...state.handExtras.filter((e) => e.id !== id), { id, Component }] };
  notify();
  return () => {
    state = { ...state, handExtras: state.handExtras.filter((e) => e.Component !== Component) };
    notify();
  };
}

/** Give the 'Hand teleop' toggle something to drive. Returns unregister. */
export function registerTeleopController(ctrl: TeleopController): () => void {
  state = { ...state, teleop: ctrl };
  notify();
  return () => {
    if (state.teleop !== ctrl) return;
    state = { ...state, teleop: null };
    notify();
  };
}

const getState = () => state;

export function useSlots(): SlotState {
  return useSyncExternalStore(subscribe, getState, getState);
}
