import { describe, expect, it } from 'vitest';
import { CobotCell } from './cellSim';

describe('cobot cell transitions', () => {
  it('starts only from IDLE and runs the cycle clock', () => {
    const cell = new CobotCell();
    expect(cell.state).toBe('IDLE');
    expect(cell.apply('CYCLE_START')).toBe(true);
    expect(cell.state).toBe('RUNNING');
    cell.tick(1);
    expect(cell.cycleT).toBeCloseTo(1);
    expect(cell.apply('CYCLE_START')).toBe(false); // ignored while running
  });

  it('STOP pauses mid-move and RESUME continues from the same point', () => {
    const cell = new CobotCell();
    cell.apply('CYCLE_START');
    cell.tick(2);
    cell.apply('STOP');
    expect(cell.state).toBe('STOPPED');
    cell.tick(3); // frozen
    expect(cell.cycleT).toBeCloseTo(2);
    cell.apply('RESUME');
    expect(cell.state).toBe('RUNNING');
  });

  it('SLOW halves speed; RESUME restores full speed', () => {
    const cell = new CobotCell();
    cell.apply('CYCLE_START');
    cell.apply('SLOW');
    expect(cell.state).toBe('SLOW');
    expect(cell.speedFactor()).toBe(0.5);
    cell.tick(2);
    expect(cell.cycleT).toBeCloseTo(1);
    cell.apply('RESUME');
    expect(cell.speedFactor()).toBe(1);
  });

  it('e-stop freezes from any state and requires the two-step reset', () => {
    const cell = new CobotCell();
    cell.apply('CYCLE_START');
    cell.apply('EMERGENCY_STOP');
    expect(cell.state).toBe('ESTOPPED');
    expect(cell.speedFactor()).toBe(0);
    // Gesture commands cannot revive an e-stopped cell.
    expect(cell.apply('RESUME')).toBe(false);
    expect(cell.apply('CYCLE_START')).toBe(false);
    // Confirm without arming does nothing.
    cell.estopResetConfirm();
    expect(cell.state).toBe('ESTOPPED');
    // Two deliberate steps return the cell to IDLE, not to RUNNING.
    cell.estopResetArm();
    expect(cell.resetStep).toBe(1);
    cell.estopResetConfirm();
    expect(cell.state).toBe('IDLE');
  });
});
