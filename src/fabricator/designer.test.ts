import { describe, it, expect, beforeAll } from 'vitest';
import type { Placement } from '../contracts';
import { designAndFabricate, designProgram, DESIGNER_SYSTEM, parseModelJson, type GenerateJson } from './designer';
import { PROGRAM_JSON_SCHEMA } from './program';
import { fakeBay, registerNasaAssets } from './testkit';

beforeAll(registerNasaAssets);

const BENNU = { name: 'Bennu fragment', category: 'asteroid', color: '#4a4744', material: 'rubble_pile', density_g_cm3: 0.01, parts: [{ kind: 'rock', radius_mm: 22, rock: { seed: 7, roughness: 0.5, craters: 4, elongation: [1.2, 1, 0.8] } }] };
const NEEDLE = { name: 'Antenna', category: 'satellite_part', color: '#dddddd', material: 'aluminum', parts: [{ kind: 'cylinder', radius_mm: 2, height_mm: 150 }] };
const SHORT_ROD = { name: 'Antenna stub', category: 'satellite_part', color: '#dddddd', material: 'aluminum', parts: [{ kind: 'cylinder', radius_mm: 9, height_mm: 40 }] };

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

  it('refused twice, or no answer at all: the closest preset is fabricated and the note says why', async () => {
    const twice = fakeBay();
    const a = fake(NEEDLE, NEEDLE);
    const r = await designAndFabricate(twice, 'an iron meteorite antenna', undefined, { generateJson: a.gen });
    expect(a.calls).toHaveLength(2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sample.name).toBe('Iron meteorite');
    expect(r.note).toMatch(/refused Gemini's design twice .* closest preset \(Iron meteorite\)/);
    expect(twice.created[0].by).toBe('preset');

    const silent = fakeBay();
    const b = fake(new Error('timeout 15000 ms'));
    const s = await designAndFabricate(silent, 'the asteroid Itokawa', undefined, { generateJson: b.gen });
    expect(s.ok && s.sample.mesh!.source).toBe('nasa');
    expect(s.ok && s.note).toMatch(/^Gemini did not answer \(timeout 15000 ms\)/);
  });

  it('a placement refusal from the registry is returned as is, with no repair turn', async () => {
    const bay = fakeBay({ reject: { ok: false, code: 'TOO_CLOSE_TO', reason: 'that is only 20 mm from Bennu fragment', suggestion: 'put it 80 mm away instead?' } });
    const { gen, calls } = fake(BENNU);
    const r = await designAndFabricate(bay, 'Bennu', { x_mm: 60, y_mm: -200 }, { generateJson: gen });
    expect(calls).toHaveLength(1);
    expect(r.ok === false && r.code).toBe('TOO_CLOSE_TO');
  });

  it('parseModelJson takes fenced or chatty JSON and refuses non-JSON', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('Here you go: {"a":{"b":2}} hope it helps')).toEqual({ a: { b: 2 } });
    expect(() => parseModelJson('no json here')).toThrow(/did not return JSON/);
  });
});
