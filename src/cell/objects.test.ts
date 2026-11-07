import { describe, it, expect } from 'vitest';
import { ObjectRegistry, validateObjectSpec, LIMITS } from './objects';
import type { ObjectSpec } from '../contracts';

const base: ObjectSpec = { color: 'blue', shape: 'cylinder', width_mm: 30, height_mm: 40 };

describe('object validator (code trust boundary)', () => {
  it('accepts a 30 mm cylinder 60 mm right of the seed block and resolves its position', () => {
    const reg = new ObjectRegistry();
    const r = reg.create({ ...base, relative_to: 'block_1', direction: 'right', distance_mm: 60 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.obj.id).toBe('cylinder_1');
    expect(r.obj.pos[0]).toBeCloseTo(0.06, 6);
    expect(r.obj.pos[1]).toBeCloseTo(-0.23, 6);
    expect(r.obj.pos[2]).toBeCloseTo(0.02, 6); // centre at h/2
    expect(r.obj.dims).toEqual({ w: 0.03, d: 0.03, h: 0.04 });
    expect(reg.list().length).toBe(2);
    // default slot when no position is given
    const d = reg.create({ ...base, color: 'green' });
    expect(d.ok && d.obj.pos[0]).toBeCloseTo(-0.06, 6);
  });

  it('rejects widths outside 15–45 mm with a spoken reason and a suggestion', () => {
    const r = validateObjectSpec({ ...base, width_mm: 70 }, []);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('TOO_WIDE');
    expect(r.reason).toBe('70 mm is wider than the 45 mm the gripper can hold');
    expect(r.suggestion).toBe('make it 40 mm?');
    const n = validateObjectSpec({ ...base, width_mm: 10 }, []);
    expect(n.ok === false && n.code).toBe('TOO_NARROW');
    // box: graspable width is the smaller side
    const box = validateObjectSpec({ ...base, shape: 'box', width_mm: 80, depth_mm: 30 }, []);
    expect(box.ok).toBe(true);
  });

  it('rejects heights outside 10–60 mm; sphere height equals its diameter', () => {
    expect(validateObjectSpec({ ...base, height_mm: 80 }, []).ok).toBe(false);
    const short = validateObjectSpec({ ...base, height_mm: 5 }, []);
    expect(short.ok === false && short.code).toBe('TOO_SHORT');
    const s = validateObjectSpec({ ...base, shape: 'sphere', width_mm: 30, height_mm: 90 }, []);
    expect(s.ok && s.dims.h).toBe(0.03);
  });

  it('rejects spots outside the reach band (rho 130–210 mm) or behind the arm', () => {
    const near = validateObjectSpec({ ...base, x_mm: 0, y_mm: -100 }, []);
    expect(near.ok === false && near.code).toBe('TOO_CLOSE');
    const far = validateObjectSpec({ ...base, x_mm: 0, y_mm: -300 }, []);
    expect(far.ok === false && far.code).toBe('TOO_FAR');
    const behind = validateObjectSpec({ ...base, x_mm: 0, y_mm: 120 }, []);
    expect(behind.ok === false && behind.code).toBe('BEHIND_ARM');
  });

  it('rejects the tray footprint', () => {
    const r = validateObjectSpec({ ...base, x_mm: -180, y_mm: -130 }, []);
    expect(r.ok === false && r.code).toBe('ON_TRAY');
    const rel = validateObjectSpec({ ...base, relative_to: 'tray', direction: 'behind', distance_mm: 20 }, []);
    expect(rel.ok === false && rel.code).toBe('ON_TRAY');
  });

  it('enforces 40 mm spacing and the 8-object cap', () => {
    const reg = new ObjectRegistry();
    const close = reg.create({ ...base, x_mm: 20, y_mm: -230 });
    expect(close.ok === false && close.code).toBe('TOO_CLOSE_TO');
    let made = 1;
    const spots: [number, number][] = [];
    for (const y of [-190, -150, -110]) for (let x = -120; x <= 120; x += 45) spots.push([x, y]);
    for (const [x, y] of spots) {
      if (reg.list().length >= LIMITS.maxObjects) break;
      const r = reg.create({ ...base, x_mm: x, y_mm: y });
      if (r.ok) made++;
    }
    expect(reg.list().length).toBe(LIMITS.maxObjects);
    const over = reg.create({ ...base, x_mm: 0, y_mm: -150 });
    expect(over.ok === false && over.code).toBe('TOO_MANY');
    expect(made).toBeGreaterThanOrEqual(2);
    expect(reg.remove('cylinder_1')).toBe(true);
    expect(reg.list().length).toBe(LIMITS.maxObjects - 1);
  });

  it('runs the injected IK reach probe and reports UNREACHABLE in mm', () => {
    const probe = (xy: [number, number]) => (xy[0] > 0.05 ? 7.5 : 0.2);
    const ok = validateObjectSpec({ ...base, x_mm: 0, y_mm: -200 }, [], probe);
    expect(ok.ok).toBe(true);
    const bad = validateObjectSpec({ ...base, x_mm: 100, y_mm: -180 }, [], probe);
    expect(bad.ok === false && bad.code).toBe('UNREACHABLE');
    expect(bad.ok === false && bad.reason).toContain('7.5 mm');
  });
});
