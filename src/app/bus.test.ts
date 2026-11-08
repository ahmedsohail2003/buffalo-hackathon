import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GeminiCallEntry } from '../contracts';
import { MAX_LOG_LINES, emit, emitEr, exportJson, getLedger, getLog, ledgerSummary, log, onLog, recordGeminiCall, resetBus, subscribe } from './bus';

function call(over: Partial<GeminiCallEntry> = {}): GeminiCallEntry {
  return { t: 1, model: 'm', purpose: 'coworker', latencyMs: 800, promptTokens: 100, outputTokens: 20, thoughtTokens: 5, costUsd: 0.001, ok: true, ...over };
}

afterEach(() => resetBus());

describe('mission log', () => {
  it('appends lines in order and notifies listeners', () => {
    const seen: string[] = [];
    const off = onLog((l) => seen.push(`${l.kind}:${l.text}`));
    log('info', 'bay online', 10);
    log('safety', 'STOP', 20);
    off();
    log('info', 'not seen', 30);
    expect(getLog().map((l) => l.text)).toEqual(['bay online', 'STOP', 'not seen']);
    expect(seen).toEqual(['info:bay online', 'safety:STOP']);
  });

  it('replaces the array on each line and caps its length', () => {
    const before = getLog();
    log('info', 'a');
    expect(getLog()).not.toBe(before);
    for (let i = 0; i < MAX_LOG_LINES + 25; i++) log('info', `line ${i}`);
    expect(getLog()).toHaveLength(MAX_LOG_LINES);
    expect(getLog()[getLog().length - 1]?.text).toBe(`line ${MAX_LOG_LINES + 24}`);
  });
});

describe('events', () => {
  it('delivers custom events and survives a throwing listener', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const got: unknown[] = [];
    subscribe('custom', () => {
      throw new Error('boom');
    });
    subscribe('custom', (p) => got.push(p));
    emit('custom', { a: 1 });
    expect(got).toEqual([{ a: 1 }]);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('emitEr publishes a point_at result as er:point, once', () => {
    const got: string[] = [];
    subscribe('er:point', (ev) => got.push(`${ev.sample_id}:${ev.error_mm}`));
    emitEr({
      kind: 'point',
      t: 1,
      source: 'live',
      label: 'Bennu',
      point_yx: [600, 570],
      sample_id: 'sample_2',
      sample_name: 'Bennu (NASA shape model)',
      found_mm: [57, -156, 16],
      error_mm: 1.5,
      truth_mm: [56, -155, 16],
      truth_yx: [601, 569],
    });
    expect(got).toEqual(['sample_2:1.5']);
  });
});

describe('Gemini ledger', () => {
  it('summarises calls, failures, latency and cost', () => {
    expect(ledgerSummary().calls).toBe(0);
    expect(ledgerSummary().lastLatencyMs).toBeNull();
    recordGeminiCall(call({ costUsd: 0.002, purpose: 'design' }));
    recordGeminiCall(call({ ok: false, error: 'timeout', latencyMs: 1500, costUsd: 0 }));
    const s = ledgerSummary();
    expect(getLedger()).toHaveLength(2);
    expect(s.calls).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.lastLatencyMs).toBe(1500);
    expect(s.totalUsd).toBeCloseTo(0.002, 6);
    expect(s.promptTokens).toBe(200);
    expect(s.byPurpose).toEqual({ design: 1, coworker: 1 });
  });

  it('exports the log and ledger as JSON', () => {
    log('gemini', 'design requested', 5);
    recordGeminiCall(call());
    const parsed = JSON.parse(exportJson({ app: 'STARHAND' })) as { app: string; log: unknown[]; ledger: unknown[]; ledgerSummary: { calls: number } };
    expect(parsed.app).toBe('STARHAND');
    expect(parsed.log).toHaveLength(1);
    expect(parsed.ledger).toHaveLength(1);
    expect(parsed.ledgerSummary.calls).toBe(1);
  });
});
