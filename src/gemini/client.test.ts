import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callER, GeminiError, setGenerateForTests } from './client';
import { bus } from '../telemetry/bus';

const ok = { text: 'OK', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 0 } } as never;

describe('client.ts retry policy and ledger', () => {
  beforeEach(() => { bus._reset(); vi.useFakeTimers(); });
  afterEach(() => { setGenerateForTests(null); vi.useRealTimers(); });

  it('retries once after 2 s on a 5xx and records one ok entry', async () => {
    let n = 0;
    setGenerateForTests(async () => { n++; if (n === 1) throw Object.assign(new Error('503 Service Unavailable'), { status: 503 }); return ok; });
    const p = callER({ purpose: 'act', level: 'LOW', contents: 'x' });
    await vi.advanceTimersByTimeAsync(2100);
    const r = await p;
    expect(n).toBe(2);
    expect(r.text).toBe('OK');
    expect(bus.entries()).toHaveLength(1);
    expect(bus.lines()[0].text).toMatch(/^ER act 503 — retrying in 2\.0 s/);
  });

  it('waits Retry-After on a 429 once, then fails as a red ledger row without switching model', async () => {
    let n = 0;
    setGenerateForTests(async () => { n++; throw Object.assign(new Error('429 Too Many Requests, retry after 3s'), { status: 429 }); });
    const p = callER({ purpose: 'plan', level: 'HIGH', contents: 'x' }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(3100);
    const e = await p;
    expect(e).toBeInstanceOf(GeminiError);
    expect((e as GeminiError).status).toBe(429);
    expect(n).toBe(2);
    const entry = bus.entries()[0];
    expect(entry.ok).toBe(false);
    expect(entry.model).toBe('gemini-robotics-er-2-preview');
    expect(entry.error).toMatch(/^429/);
    expect(bus.lines().some((l) => l.text.startsWith('ER plan HIGH FAILED 429'))).toBe(true);
  });

  it('times out per level and does not retry a 400', async () => {
    setGenerateForTests(({ config }) => new Promise((_, rej) => config.abortSignal?.addEventListener('abort', () => rej(new Error('aborted')))));
    const p = callER({ purpose: 'verify', level: 'LOW', contents: 'x' }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(15_100);
    expect(String((await p).message)).toMatch(/timeout 15000 ms/);
    let n = 0;
    setGenerateForTests(async () => { n++; throw Object.assign(new Error('400 bad schema'), { status: 400 }); });
    const e = await callER({ purpose: 'point', level: 'LOW', contents: 'x' }).catch((x) => x);
    expect((e as GeminiError).status).toBe(400);
    expect(n).toBe(1);
  });

  it('runs calls one at a time (concurrency-1 queue)', async () => {
    let active = 0, maxActive = 0;
    setGenerateForTests(async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 50)); active--; return ok; });
    const ps = [1, 2, 3].map(() => callER({ purpose: 'act', level: 'LOW', contents: 'x' }));
    await vi.advanceTimersByTimeAsync(200);
    await Promise.all(ps);
    expect(maxActive).toBe(1);
    expect(bus.totals().calls).toBe(3);
  });
});
