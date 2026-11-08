import { describe, it, expect, beforeAll } from 'vitest';
import type { Placement } from '../contracts';
import { designAndFabricate, designProgram, DESIGNER_SYSTEM, parseModelJson, type GenerateJson } from './designer';
import { PROGRAM_JSON_SCHEMA } from './program';
import { fakeBay, registerNasaAssets } from './testkit';

beforeAll(registerNasaAssets);

const BENNU = { name: 'Bennu fragment', category: 'asteroid', color: '#4a4744', material: 'rubble_pile', density_g_cm3: 0.01, parts: [{ kind: 'rock', radius_mm: 22, rock: { seed: 7, roughness: 0.5, craters: 4, elongation: [1.2, 1, 0.8] } }] };
const NEEDLE = { name: 'Antenna', category: 'satellite_part', color: '#dddddd', material: 'aluminum', parts: [{ kind: 'cylinder', radius_mm: 2, height_mm: 150 }] };
const SHORT_ROD = { name: 'Antenna stub', category: 'satellite_part', color: '#dddddd', material: 'aluminum', parts: [{ kind: 'cylinder', radius_mm: 9, height_mm: 40 }] };
const LYING_ROD = { name: 'Antenna rod', category: 'satellite_part', color: '#dddddd', material: 'aluminum', parts: [{ kind: 'box', size_mm: [120, 4, 4] }] };

type Call = Parameters<GenerateJson>[0];
function fake(...answers: (unknown | Error)[]): { gen: GenerateJson; calls: Call[] } {
  const calls: Call[] = [];
  const gen: GenerateJson = async (a) => {
    calls.push(a);
    const next = answers.shift();
    if (next === undefined) throw new Error('no fake answer left');
    if (next instanceof Error) throw next;
    return { text: typeof next === 'string' ? next : '```json\n' + JSON.stringify(next) + '\n```', latencyMs: 1200 };
  };
  return { gen, calls };
}

describe('designer (Gemini proposes, code decides)', () => {
  it('designProgram sends the system prompt and the schema, and sanitizes the answer (no Gemini densities)', async () => {
    const { gen, calls } = fake(BENNU);
    const r = await designProgram('a 30 mm fragment of asteroid Bennu', { generateJson: gen });
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toBe(DESIGNER_SYSTEM);
    expect(calls[0].schema).toBe(PROGRAM_JSON_SCHEMA);
    expect(calls[0].prompt).toContain('a 30 mm fragment of asteroid Bennu');
    expect(r.program.parts[0].kind).toBe('rock');
    expect(r.program.density_g_cm3).toBe(1.2); // from rubble_pile, not the 0.01 it claimed
    expect(r.latencyMs).toBe(1200);
    expect(DESIGNER_SYSTEM).toContain('45 mm');
    expect(DESIGNER_SYSTEM).not.toMatch(/gemini-|flash/i);
    // code owns the design scale too: a model that sends one is ignored
    const lie = fake({ ...BENNU, design_scale: 0.001 });
    expect((await designProgram('a Bennu fragment', { generateJson: lie.gen })).program.design_scale).toBeUndefined();
  });

  it('designAndFabricate places a good design as a gemini sample with a speakable sentence', async () => {
    const bay = fakeBay();
    const { gen } = fake(BENNU);
    const r = await designAndFabricate(bay, 'a fragment of Bennu', { x_mm: 80, y_mm: -190 }, { generateJson: gen });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(bay.created[0].by).toBe('gemini');
    expect((bay.created[0].input as Placement).x_mm).toBe(80);
    expect(r.sample.mesh!.source).toBe('gemini');
    expect(r.attempts).toBe(1);
    expect(r.say).toMatch(/^Fabricated a Bennu fragment: \d+ mm across, \d+ mm tall, \d+ grams\./);
  });

  it('a refused design gets ONE repair turn carrying the refusal sentence', async () => {
    const bay = fakeBay();
    const { gen, calls } = fake(NEEDLE, SHORT_ROD);
    const r = await designAndFabricate(bay, 'a whip antenna', undefined, { generateJson: gen });
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain('The code guardrail rejected it: it is too tall and thin');
    expect(calls[1].prompt).toContain('Suggestion: make it at least');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.attempts).toBe(2);
    expect(r.sample.name).toBe('Antenna stub');
    expect(r.say).toContain('Gemini repaired its design');
  });

  it('refused twice: the second refusal comes back (code, reason, suggestion), never a keyword preset', async () => {
    const bay = fakeBay();
    const a = fake(NEEDLE, LYING_ROD);
    const r = await designAndFabricate(bay, 'an iron meteorite antenna', undefined, { generateJson: a.gen });
    expect(a.calls).toHaveLength(2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('TOO_THIN');
    expect(r.reason).toMatch(/too long and thin/); // the second design's reason, not the first's
    expect(r.suggestion).toMatch(/thick for its \d+ mm length/);
    expect(r.program?.name).toBe('Antenna rod');
    expect(r.note).toMatch(/^Gemini redesigned it once after the guardrail said: it is too tall and thin/);
    expect(bay.created).toEqual([]); // no preset was fabricated in its place
  });

  it('no answer at all (an HTTP error, a timeout, no JSON): the closest preset is fabricated and the note says why', async () => {
    const silent = fakeBay();
    const b = fake(new Error('timeout 15000 ms'));
    const s = await designAndFabricate(silent, 'the asteroid Itokawa', undefined, { generateJson: b.gen });
    expect(s.ok && s.sample.mesh!.source).toBe('nasa');
    expect(s.ok && s.note).toMatch(/^Gemini did not answer \(timeout 15000 ms\)/);

    const chatty = fakeBay();
    const c = fake('Sorry, I can only describe it in words.');
    const t = await designAndFabricate(chatty, 'an iron meteorite', undefined, { generateJson: c.gen });
    expect(t.ok && t.sample.name).toBe('Iron meteorite');
    expect(t.ok && t.note).toMatch(/^Gemini did not answer \(the designer did not return JSON/);
    expect(chatty.created[0].by).toBe('preset');

    // the repair turn itself does not answer: Gemini cannot answer, so the preset fallback stays
    const cut = fakeBay();
    const d = fake(NEEDLE, Object.assign(new Error('HTTP 400: Request contains an invalid argument.'), { status: 400 }));
    const u = await designAndFabricate(cut, 'a whip antenna', undefined, { generateJson: d.gen });
    expect(d.calls).toHaveLength(2);
    expect(u.ok && u.note).toMatch(/the repair turn did not answer; fabricated the closest preset/);
  });

  it('a placement refusal from the registry is returned as is, with no repair turn', async () => {
    const bay = fakeBay({ reject: { ok: false, code: 'TOO_CLOSE_TO', reason: 'that is only 20 mm from Bennu fragment', suggestion: 'put it 80 mm away instead?' } });
    const { gen, calls } = fake(BENNU);
    const r = await designAndFabricate(bay, 'Bennu', { x_mm: 60, y_mm: -200 }, { generateJson: gen });
    expect(calls).toHaveLength(1);
    expect(r.ok === false && r.code).toBe('TOO_CLOSE_TO');
  });

  it('an emergency stop during the design cancels it: ABORTED, no preset fallback, nothing placed', async () => {
    for (const repair of [false, true]) {
      const bay = fakeBay();
      const ac = new AbortController();
      const answers: unknown[] = repair ? [NEEDLE] : [];
      const gen: GenerateJson = async () => {
        const next = answers.shift();
        if (next) return { text: JSON.stringify(next), latencyMs: 5 };
        ac.abort(); // the E-STOP lands while Gemini is still thinking
        throw Object.assign(new Error('Gemini request cancelled'), { code: 'ABORTED' });
      };
      const r = await designAndFabricate(bay, 'an iron meteorite', undefined, { generateJson: gen }, ac.signal);
      expect(r).toMatchObject({ ok: false, code: 'ABORTED' });
      expect(bay.created).toEqual([]);
    }
  });

  it('a design that lands while the bay is STOPPED or ESTOPPED is not placed (gemini or preset)', async () => {
    for (const state of ['STOPPED', 'ESTOPPED'] as const) {
      for (const answer of [BENNU, new Error('timeout 15000 ms')]) {
        const bay = fakeBay();
        let st = 'RUNNING';
        bay.gate = { ...bay.gate, state: () => st as typeof state };
        const gen: GenerateJson = async () => {
          st = state; // the operator stops the bay mid-design
          if (answer instanceof Error) throw answer;
          return { text: JSON.stringify(answer), latencyMs: 5 };
        };
        const r = await designAndFabricate(bay, 'a fragment of Bennu', undefined, { generateJson: gen });
        expect(r).toMatchObject({ ok: false, code: state === 'STOPPED' ? 'BAY_STOPPED' : 'BAY_ESTOPPED' });
        expect(bay.created).toEqual([]);
      }
    }
  });

  it('parseModelJson takes fenced or chatty JSON and refuses non-JSON', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('Here you go: {"a":{"b":2}} hope it helps')).toEqual({ a: { b: 2 } });
    expect(() => parseModelJson('no json here')).toThrow(/did not return JSON/);
  });
});
