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
    expect(calloutFor(line('info', 'released Bennu fragment on the containment'))?.text).toBe('Bennu fragment secured in containment.');
    expect(calloutFor(line('info', 'released sample cube on the containment'))?.text).toBe('Sample cube secured in containment.');
    expect(calloutFor(line('info', 'released Bennu (NASA shape model) on the containment'))?.text).toBe('Bennu secured in containment.');
    expect(calloutFor(line('gemini', '[coworker] place_in_containment -> ok, s1 released over containment (registry: inside)'))).toBeNull();
    expect(calloutFor(line('gemini', '[coworker] place_in_containment -> ok, s1 released over containment (registry: NOT inside)'))).toBeNull();
    expect(calloutFor(line('reject', 'Fabricator: too heavy at 140 g; the limit is 100 g. Try a smaller one.'))?.text).toBe('Negative. Too heavy at 140 g.');
    expect(calloutFor(line('info', 'Task complete: 3 samples curated'))?.text).toBe('Task complete.');
    expect(calloutFor(line('info', '[CALLOUT] Welcome to Curation Bay 2.'))?.text).toBe('Welcome to Curation Bay 2.');
    expect(calloutFor(line('voice', 'Emergency stop. Arm locked.'))).toBeNull();
    expect(calloutFor(line('info', 'Camera ready'))).toBeNull();
  });

  it('never announces containment from Gemini text or free text, only from the arm release line', () => {
    expect(calloutFor(line('gemini', '[coworker] check_bay(question: "Is the Bennu fragment in containment?")'))).toBeNull();
    expect(
      calloutFor(line('gemini', '[coworker] check_bay -> yes (registry decides: no) - camera disagrees: The Bennu fragment is placed in containment.')),
    ).toBeNull();
    expect(calloutFor(line('info', 'released Containment canister on the deck'))).toBeNull();
    expect(calloutFor(line('info', 'released Bennu fragment on the sample below'))).toBeNull();
    expect(calloutFor(line('teleop', 'Sample placed in containment'))).toBeNull();
    expect(calloutFor(line('info', 'released Containment canister on the containment'))?.text).toBe('Containment canister secured in containment.');
  });

  it('summarises a fabricated sample from the measured numbers', () => {
    expect(fabricatorSummary('Fabricated "Chondrite shard": grip 32 mm, height 28 mm, 41 g (scaled 0.8)')).toBe(
      'Chondrite shard fabricated. Grip 32 millimetres. 41 grams. Scaled to fit.',
    );
    expect(calloutFor(line('fabricator', 'Fabricated CubeSat panel, grip width 40 mm'))?.text).toBe('CubeSat panel fabricated. Grip 40 millimetres.');
  });

  it("names a fabricated sample by its name and source, never by the operator's prompt", () => {
    const say = (text: string) => calloutFor(line('fabricator', text))?.text;
    expect(say('FABRICATOR "Iron meteorite" (Gemini design) → sample_4: scaled to 66% so the arm can lift it: 90 g, 32 mm across')).toBe(
      'Iron meteorite, Gemini design, fabricated. 90 grams. Scaled to fit.',
    );
    expect(say('FABRICATOR "Eros (NASA shape model)" (NASA shape model) → sample_5: scaled to 57% to fit the sample bin: 55 mm wide, 30 mm across the jaw, 40 g')).toBe(
      'Eros, NASA shape model, fabricated. 40 grams. Scaled to fit.',
    );
    expect(say('FABRICATOR "Bennu fragment" (preset fallback) → sample_6: fits as designed: 33 mm across the jaw, 22 mm tall, 24 g')).toBe(
      'Bennu fragment, preset fallback, fabricated. 24 grams.',
    );
    // a name that contains a "negative" word is still announced, and its digits are not taken for the mass
    expect(say('FABRICATOR "Mission patch 5g" (Gemini design) → sample_7: fits as designed: 30 mm across the jaw, 12 mm tall, 2 g')).toBe(
      'Mission patch 5g, Gemini design, fabricated. 2 grams.',
    );
  });

  it('a reject callout is the reason up to its first clause boundary, capitalised, never cut mid-phrase', () => {
    const say = (text: string) => calloutFor(line('reject', text))?.text;
    // the probes' cut-off callouts, now whole
    expect(say('placeAt refused: that spot overlaps sample cube by 11 mm; put it right on top or at least 38 mm away from its centre.')).toBe(
      'Negative. That spot overlaps sample cube by 11 mm.',
    );
    expect(say('FABRICATOR design → BAY_FULL: none of the default spots is free for a part this size')).toBe('Negative. None of the default spots is free for a part this size.');
    expect(say('FABRICATOR "Ryugu pebble" (Gemini design) → BAY_STOPPED: the bay is stopped, so the sample was not placed')).toBe(
      'Negative. The bay is stopped, so the sample was not placed.',
    );
    expect(say('containment place refused: the containment bin is full; there is no room for Iron meteorite.')).toBe('Negative. The containment bin is full.');
    // the guardrail's refusal: its first clause
    expect(say('FABRICATOR "Antenna boom" (preset) → TOO_THIN: it is too tall and thin for the jaw; short enough to carry (45 mm) it would be only 1 mm across, and the jaw needs at least 15 mm')).toBe(
      'Negative. It is too tall and thin for the jaw.',
    );
    // a decimal point is not a sentence end; a code without a colon (teleop) still marks the reason
    expect(say('FABRICATOR "Pebble" (Gemini design) → GUARD_CHECK: after scaling it is only 12.5 mm across, under the 15 mm the jaw needs')).toBe(
      'Negative. After scaling it is only 12.5 mm across, under the 15 mm the jaw needs.',
    );
    expect(say('pick → UNREACHABLE that spot is out of reach')).toBe('Negative. That spot is out of reach.');
    // a long clause with no boundary is spoken whole rather than cut
    const long = `FABRICATOR design → BUILD_FAILED: the shape could not be built because ${'the outline crosses itself '.repeat(5).trim()}`;
    expect(say(long)).toBe(`Negative. The shape could not be built because ${'the outline crosses itself '.repeat(5).trim()}.`);
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
    a.handle(line('info', 'released Eros chip on the containment'));
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
    a.handle(line('info', 'released Itokawa on the containment'));
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
    a.handle(line('info', 'released Sample on the containment'));
    advance(3000);
    a.handle(line('gemini', '[live] place_in_containment -> ok, s2 released over containment'));
    advance(3000);
    expect(said).toEqual(['Sample secured in containment.']);
    advance(9000);
    a.handle(line('info', 'released Sample on the containment'));
    expect(said).toHaveLength(2);
  });
});

describe('safety callouts follow the gate transition, not keywords in the note', () => {
  const at = (text: string) => calloutFor({ t: 0, kind: 'safety', text })?.text ?? null;
  it('a STOP whose note says "resume to continue" is announced as a stop', () => {
    expect(at('STOP (gesture): RUNNING -> STOPPED. Arm frozen; resume to continue.')).toBe('All stop. Arm holding.');
  });
  it('resume, slow, cycle start, e-stop and its reset', () => {
    expect(at('RESUME (gesture): STOPPED -> RUNNING. Resumed.')).toBe('Resuming. Arm is live.');
    expect(at('SLOW (gesture): RUNNING -> SLOW. Half speed.')).toBe('Slow mode. Half speed.');
    expect(at('CYCLE_START (auto): IDLE -> RUNNING. Cycle started.')).toBe('Cycle start.');
    expect(at('ESTOP (gesture): RUNNING -> ESTOPPED. Every move aborted.')).toBe('Emergency stop. Arm locked.');
    expect(at('RESET_CONFIRM (panel): ESTOPPED -> IDLE. Bay reset.')).toBe('Emergency stop cleared.');
  });
  it('a command that leaves the state unchanged is not announced', () => {
    expect(at('STOP (gesture): STOPPED -> STOPPED. Already stopped.')).toBeNull();
  });
});
