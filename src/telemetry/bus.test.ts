import { beforeEach, describe, expect, it } from 'vitest';
import { bus } from './bus';
import { egress } from './egress';
import { costUsd, ER_MODEL, FLASH_MODEL } from '../gemini/models';
import { parseJson, stripFences } from '../gemini/client';

describe('telemetry bus + pricing', () => {
  beforeEach(() => { bus._reset(); egress._reset(); });

  it('emits lines and ledger entries to subscribers and totals them', () => {
    const seen: string[] = [];
    bus.subscribe((ev) => { if (ev.line) seen.push(`${ev.line.kind}:${ev.line.text}`); if (ev.entry) seen.push(`entry:${ev.entry.purpose}`); });
    bus.emit({ kind: 'tool', text: 'pick(block_1) → ok' });
    bus.emit({ kind: 'gemini', text: 'ER point LOW 1.4 s' }, { t: 1, model: ER_MODEL, purpose: 'point', thinkingLevel: 'LOW', latencyMs: 1400, promptTokens: 1000, outputTokens: 50, thoughtTokens: 100, costUsd: costUsd(ER_MODEL, 1000, 50, 100), ok: true });
    bus.emit(undefined, { t: 2, model: ER_MODEL, purpose: 'plan', thinkingLevel: 'HIGH', latencyMs: 0, promptTokens: 0, outputTokens: 0, thoughtTokens: 0, costUsd: 0, ok: false, error: '429' });
    expect(seen).toEqual(['tool:pick(block_1) → ok', 'gemini:ER point LOW 1.4 s', 'entry:point', 'entry:plan']);
    const tot = bus.totals();
    expect(tot.calls).toBe(2);
    expect(tot.errors).toBe(1);
    expect(tot.promptTokens).toBe(1000);
    expect(tot.costUsd).toBeCloseTo(0.001 + 150 * 5e-6, 9);
    expect(bus.lines().map((l) => l.id)).toEqual([1, 2]);
  });

  it('prices ER-2 at $1/$5 and Flash at $0.75/$3.75 per M tokens, thoughts billed as output', () => {
    expect(costUsd(ER_MODEL, 1_000_000, 0, 0)).toBeCloseTo(1, 9);
    expect(costUsd(ER_MODEL, 0, 100_000, 100_000)).toBeCloseTo(1, 9);
    expect(costUsd(FLASH_MODEL, 1_000_000, 1_000_000, 0)).toBeCloseTo(4.5, 9);
    expect(costUsd('unknown-model', 1_000_000, 0, 0)).toBeCloseTo(0.75, 9);
  });

  it('egress counters notify subscribers and never count webcam frames unless asked', () => {
    const states: number[] = [];
    egress.subscribe((s) => states.push(s.cellFrames));
    egress.bumpCellFrames(); egress.bumpCellFrames(); egress.setMic(true); egress.setMic(true);
    expect(states).toEqual([1, 2, 2]);
    expect(egress.get()).toMatchObject({ micStreaming: true, cellFrames: 2, webcamFrames: 0 });
  });

  it('strips fences and parses lenient JSON', () => {
    expect(stripFences('```json\n[{"a":1}]\n```')).toBe('[{"a":1}]');
    expect(parseJson<{ ok: boolean }>('Sure: {"ok": true, "observation": "x"} done')).toEqual({ ok: true, observation: 'x' });
    expect(parseJson<number[]>('```\n[1,2]```')).toEqual([1, 2]);
    expect(() => parseJson('nope')).toThrow(/not JSON/);
  });
});
