import { describe, expect, it } from 'vitest';
import type { LogLine } from '../contracts';
import { Announcer, calloutFor, fabricatorSummary } from './announcer';

const line = (kind: LogLine['kind'], text: string): LogLine => ({ t: 0, kind, text });

/** Manual clock and timers, so the 2.5 s rate limit can be stepped through exactly. */
function rig() {
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let ids = 0;
  const said: string[] = [];
  let cancels = 0;
  const a = new Announcer({
    speaker: { say: (t) => said.push(t), cancel: () => cancels++ },
    now: () => now,
    setTimer: (fn, ms) => {
      const id = ++ids;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of [...timers].sort((x, y) => x.at - y.at)) {
      if (t.at <= now) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    }
  };
  return { a, said, advance, cancels: () => cancels };
}

describe('announcer rules', () => {
  it('maps bay events to short mission-control callouts', () => {
    expect(calloutFor(line('safety', 'E-STOP: held fist'))).toMatchObject({ text: 'Emergency stop. Arm locked.', priority: 'estop' });
    expect(calloutFor(line('safety', 'Emergency stop cleared by operator'))?.text).toBe('Emergency stop cleared.');
    expect(calloutFor(line('safety', 'STOP (open palm)'))?.text).toBe('All stop. Arm holding.');
    expect(calloutFor(line('safety', 'RESUME (thumbs up)'))?.text).toBe('Resuming. Arm is live.');
    expect(calloutFor(line('safety', 'SLOW mode'))?.text).toBe('Slow mode. Half speed.');
    expect(calloutFor(line('teleop', '"Bennu fragment" secured in containment'))?.text).toBe('Bennu fragment secured in containment.');
    expect(calloutFor(line('gemini', '[coworker] place_in_containment -> ok, s1 released over containment (registry: inside)'))?.text).toBe(
      'Sample secured in containment.',
    );
    expect(calloutFor(line('gemini', '[coworker] place_in_containment -> ok, s1 released over containment (registry: NOT inside)'))).toBeNull();
    expect(calloutFor(line('reject', 'Fabricator: too heavy at 140 g; the limit is 100 g. Try a smaller one.'))?.text).toBe(
      'Negative. too heavy at 140 g; the limit is 100 g.',
    );
    expect(calloutFor(line('info', 'Task complete: 3 samples curated'))?.text).toBe('Task complete.');
    expect(calloutFor(line('info', '[CALLOUT] Welcome to Curation Bay 2.'))?.text).toBe('Welcome to Curation Bay 2.');
    expect(calloutFor(line('voice', 'Emergency stop. Arm locked.'))).toBeNull();
    expect(calloutFor(line('info', 'Camera ready'))).toBeNull();
  });

  it('summarises a fabricated sample from the measured numbers', () => {
    expect(fabricatorSummary('Fabricated "Chondrite shard": grip 32 mm, height 28 mm, 41 g (scaled 0.8)')).toBe(
      'Chondrite shard fabricated. Grip 32 millimetres. 41 grams. Scaled to fit.',
    );
    expect(calloutFor(line('fabricator', 'Fabricated CubeSat panel, grip width 40 mm'))?.text).toBe('CubeSat panel fabricated. Grip 40 millimetres.');
  });
});

describe('announcer rate limit', () => {
  it('speaks at most one callout per 2.5 s; the newest held callout wins', () => {
    const { a, said, advance } = rig();
    a.handle(line('safety', 'STOP'));
    expect(said).toEqual(['All stop. Arm holding.']);
    advance(500);
    a.handle(line('fabricator', 'Fabricated "Eros chip": grip 30 mm'));
    advance(500);
    a.handle(line('teleop', '"Eros chip" secured in containment'));
    expect(said).toHaveLength(1);
    advance(1499);
    expect(said).toHaveLength(1);
    advance(1);
    expect(said).toEqual(['All stop. Arm holding.', 'Eros chip secured in containment.']);
    advance(10_000);
    expect(said).toHaveLength(2);
  });

  it('an emergency stop cuts through at once: cancels speech, drops the held callout, then keeps quiet', () => {
    const { a, said, advance, cancels } = rig();
    a.handle(line('safety', 'RESUME'));
    advance(300);
    a.handle(line('teleop', '"Itokawa" secured in containment'));
    advance(300);
    a.handle(line('safety', 'E-STOP'));
    expect(cancels()).toBe(1);
    expect(said).toEqual(['Resuming. Arm is live.', 'Emergency stop. Arm locked.']);
    advance(5000);
    expect(said).toHaveLength(2); // the held containment callout was dropped
    a.handle(line('safety', 'E-STOP (fist still held)'));
    expect(said).toHaveLength(3); // a new E-STOP after the gap is spoken again
    advance(1000);
    a.handle(line('reject', 'Pick aborted: emergency stop.'));
    advance(5000);
    expect(said).toHaveLength(3); // normal callouts stay quiet right after an E-STOP
  });

  it('says a repeated callout once inside the dedupe window', () => {
    const { a, said, advance } = rig();
    a.handle(line('teleop', 'Sample placed in containment'));
    advance(3000);
    a.handle(line('gemini', '[live] place_in_containment -> ok, s2 released over containment'));
    advance(3000);
    expect(said).toEqual(['Sample secured in containment.']);
    advance(9000);
    a.handle(line('teleop', 'Sample placed in containment'));
    expect(said).toHaveLength(2);
  });
});
