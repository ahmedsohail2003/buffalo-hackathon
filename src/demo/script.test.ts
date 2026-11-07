import { describe, expect, it } from 'vitest';
import {
  DEMO_CONFIDENCE,
  DEMO_DWELL_MS,
  DEMO_STEPS,
  DEMO_TOTAL_MS,
} from './script';
import {
  DEFAULT_CONFIG,
  GestureStateMachine,
  type CommandId,
  type GestureLabel,
} from '../gesture/stateMachine';
import { CobotCell } from '../cell/cellSim';

const cfg = { ...DEFAULT_CONFIG, dwellMs: DEMO_DWELL_MS };

function requiredDwell(g: GestureLabel): number {
  return g === 'Closed_Fist' ? cfg.estopDwellMs : cfg.dwellMs;
}

function stepStart(index: number): number {
  return DEMO_STEPS.slice(0, index).reduce((s, st) => s + st.durMs, 0);
}

describe('guided demo script invariants', () => {
  it('runs about 45 seconds', () => {
    expect(DEMO_TOTAL_MS).toBeGreaterThanOrEqual(40_000);
    expect(DEMO_TOTAL_MS).toBeLessThanOrEqual(50_000);
  });

  it('uses a synthetic confidence above the gate', () => {
    expect(DEMO_CONFIDENCE).toBeGreaterThan(cfg.minConfidence);
  });

  it('holds every gesture long enough to fire, and releases within the step', () => {
    for (const step of DEMO_STEPS) {
      if (!step.hold) continue;
      const holdMs = step.holdMs ?? 0;
      // Must cover debounce + dwell with margin so the command actually fires.
      expect(holdMs).toBeGreaterThanOrEqual(
        cfg.debounceMs + requiredDwell(step.hold) + 100,
      );
      // Must release before the step ends so the next hold starts clean.
      expect(holdMs).toBeLessThan(step.durMs);
    }
  });

  it('spaces repeats of the same gesture beyond the refractory period', () => {
    for (let i = 0; i < DEMO_STEPS.length; i += 1) {
      const a = DEMO_STEPS[i];
      if (!a.hold) continue;
      for (let j = i + 1; j < DEMO_STEPS.length; j += 1) {
        const b = DEMO_STEPS[j];
        if (b.hold !== a.hold) continue;
        const fireAt = stepStart(i) + cfg.debounceMs + requiredDwell(a.hold);
        const releaseAt = stepStart(i) + (a.holdMs ?? 0);
        const nextHoldAt = stepStart(j);
        expect(nextHoldAt).toBeGreaterThan(fireAt + cfg.refractoryMs);
        expect(nextHoldAt).toBeGreaterThan(releaseAt + cfg.lossGraceMs);
        break; // only the nearest repeat matters
      }
    }
  });

  it('performs the two-step e-stop reset in order, after the e-stop fires', () => {
    const estopIdx = DEMO_STEPS.findIndex((s) => s.hold === 'Closed_Fist');
    const armIdx = DEMO_STEPS.findIndex((s) => s.action === 'resetArm');
    const confirmIdx = DEMO_STEPS.findIndex((s) => s.action === 'resetConfirm');
    expect(estopIdx).toBeGreaterThanOrEqual(0);
    expect(armIdx).toBeGreaterThan(estopIdx);
    expect(confirmIdx).toBeGreaterThan(armIdx);
  });

  it('replayed against the real pipeline, tells the intended story', () => {
    // Drive the actual state machine and cell with the script's schedule at
    // ~60 fps and check every fired command lands, in order, and is accepted.
    const machine = new GestureStateMachine({ dwellMs: DEMO_DWELL_MS });
    const cell = new CobotCell();
    const fired: { cmd: CommandId; accepted: boolean }[] = [];

    const starts = DEMO_STEPS.map((_, i) => stepStart(i));
    let prevT = -1;
    for (let t = 0; t <= DEMO_TOTAL_MS; t += 16) {
      // Step-start actions (panel presses).
      DEMO_STEPS.forEach((step, i) => {
        if (step.action && starts[i] > prevT && starts[i] <= t) {
          if (step.action === 'resetArm') cell.estopResetArm();
          else cell.estopResetConfirm();
        }
      });
      // Currently held gesture per the schedule.
      let held: GestureLabel | null = null;
      DEMO_STEPS.forEach((step, i) => {
        if (step.hold && t >= starts[i] && t < starts[i] + (step.holdMs ?? 0)) {
          held = step.hold;
        }
      });
      for (const ev of machine.sample(held, held ? DEMO_CONFIDENCE : 0, t)) {
        if (ev.type === 'fired') {
          fired.push({ cmd: ev.command, accepted: cell.apply(ev.command) });
        }
      }
      cell.tick(0.016);
      prevT = t;
    }

    expect(fired.map((f) => f.cmd)).toEqual([
      'CYCLE_START',
      'SLOW',
      'STOP',
      'RESUME',
      'RESUME',
      'EMERGENCY_STOP',
    ]);
    expect(fired.every((f) => f.accepted)).toBe(true);
    // The reset interlock ran, so the demo ends with the cell back in IDLE.
    expect(cell.state).toBe('IDLE');
  });
});
