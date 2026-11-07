// Wires hand teleop into the app: it steps before the arm every tick, masks a fist only during a
// real pinch, draws the hover target in the viewer, drives the Hand-pane toggle, and adds the
// teleop panel (which carries the simulated hand pad).
import type { LogKind } from '../app/bus';
import { log } from '../app/bus';
import { getBay, registerTickHook, setSafetyLabelFilter } from '../app/runtime';
import { CONTAINMENT_OUTER_HALF, CONTAINMENT_XY, REACH, Z_HOVER, Z_LIFT } from '../core';
import { registerSceneHook } from '../scene/registry';
import { registerHandPaneExtra, registerSimStage, registerTeleopController } from '../ui/slots';
import type { HandFrame } from '../contracts';
import { createTeleop, fistMaskFilter, latestHandFrame, teleopSceneHook } from '.';
import { SimHandPad } from './SimHandPad';
import { TeleopPanel } from './TeleopPanel';

/** The safety machine's phase names -> what teleop expects while a signal is being formed. */
const FORMING: Record<string, string> = { debounce: 'debouncing', armed: 'arming' };

const teleop = createTeleop(getBay(), {
  reach: REACH,
  zHover: Z_HOVER,
  zLift: Z_LIFT,
  containment: { xy: CONTAINMENT_XY, half: CONTAINMENT_OUTER_HALF },
  log: (text, kind) => log((kind === 'reject' ? 'reject' : 'teleop') as LogKind, text),
});

// Camera frames arrive in the tick context; the simulated pad publishes to teleop's own store.
// Use whichever is newer (forwarding the app's null 'no camera hand' would wipe the pad's frames).
const newest = (a: HandFrame | null, b: HandFrame | null) => (!a ? b : !b ? a : a.t >= b.t ? a : b);
registerTickHook((nowMs, _dt, ctx) =>
  teleop.step(nowMs, newest(ctx.hand, latestHandFrame()), FORMING[ctx.safety.phase] ?? ctx.safety.phase),
);
setSafetyLabelFilter(fistMaskFilter);
registerSceneHook(teleopSceneHook());
registerTeleopController(teleop);
// The shell's switch drives teleop; the panel adds the status chip and the camera-mode hint.
// In simulated-input mode the simulated hand pad fills the camera box.
registerHandPaneExtra('teleop', function TeleopExtras({ mode }) {
  return <TeleopPanel teleop={teleop} mode={mode} toggle={false} pad={false} />;
});
registerSimStage(function SimHandStage() {
  return <SimHandPad teleop={teleop} mode="sim" />;
});
