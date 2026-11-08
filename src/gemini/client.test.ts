import { describe, expect, it } from 'vitest';
import type { GeminiCallEntry } from '../contracts';
import { GeminiError, buildConfig, createGenerateJson, createGeminiClient, parseRetryAfter, type GenAiLike, type GenerateParams, type RawResponse } from './client';
import { FLASH, ROBOTICS_ER, costUsd } from './models';

function ok(text: string, usage = { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 100 }): RawResponse {
  return { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: usage };
}

function httpError(status: number, message = 'boom', extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(JSON.stringify({ error: { code: status, message } })), { status, ...extra });
}

/** A scripted SDK: each call pops the next behaviour. */
function scripted(steps: Array<(p: GenerateParams) => Promise<RawResponse> | RawResponse>) {
  const seen: GenerateParams[] = [];
  const genai: GenAiLike = {
    models: {
      async generateContent(p) {
        seen.push(p);
        const step = steps.shift();
        if (!step) throw new Error('no more scripted steps');
        return step(p);
      },
    },
  };
  return { genai, seen };
}

function harness(steps: Parameters<typeof scripted>[0]) {
  const { genai, seen } = scripted(steps);
  const entries: GeminiCallEntry[] = [];
  const sleeps: number[] = [];
  const client = createGeminiClient({
    genai,
    sink: { log() {}, ledger: (e) => entries.push(e) },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, seen, entries, sleeps };
}

describe('Gemini client', () => {
  it('returns text and function calls and records one priced ledger entry', async () => {
    const { client, entries } = harness([
      () => ({
        candidates: [{ content: { role: 'model', parts: [{ text: 'thinking...', thought: true }, { text: 'Copy.' }, { functionCall: { id: 'c1', name: 'bay_status', args: {} }, thoughtSignature: 'sig' }] } }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 100 },
      }),
    ]);
    const r = await client.call({ purpose: 'coworker', model: FLASH, contents: 'hi' });
    expect(r.text).toBe('Copy.');
    expect(r.functionCalls).toEqual([{ id: 'c1', name: 'bay_status', args: {} }]);
    expect(r.content.parts?.[2].thoughtSignature).toBe('sig');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ model: FLASH, purpose: 'coworker', ok: true, promptTokens: 1000, outputTokens: 200, thoughtTokens: 100 });
    // 1000 in at $0.75/M + 300 out (thinking billed as output) at $3.75/M
    expect(entries[0].costUsd).toBeCloseTo(0.00075 + 0.001125, 9);
    expect(costUsd(ROBOTICS_ER, { promptTokens: 1e6, outputTokens: 1e6, thoughtTokens: 0 })).toBeCloseTo(6, 9);
  });

  it('runs requests strictly one at a time, in order', async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const slow = (label: string) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(`start ${label}`);
      await new Promise((r) => setTimeout(r, 15));
      order.push(`end ${label}`);
      active--;
      return ok(label);
    };
    const { client } = harness([slow('a'), slow('b'), slow('c')]);
    const results = await Promise.all(['a', 'b', 'c'].map((l) => client.call({ purpose: 'verify', model: ROBOTICS_ER, contents: l })));
    expect(results.map((r) => r.text)).toEqual(['a', 'b', 'c']);
    expect(maxActive).toBe(1);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('retries once on a 5xx and logs both attempts in the ledger', async () => {
    const { client, entries, sleeps } = harness([
      () => {
        throw httpError(503, 'overloaded');
      },
      () => ok('second time lucky'),
    ]);
    const r = await client.call({ purpose: 'point', model: ROBOTICS_ER, contents: 'x' });
    expect(r.text).toBe('second time lucky');
    expect(sleeps).toHaveLength(1);
    expect(entries.map((e) => e.ok)).toEqual([false, true]);
    expect(entries[0].error).toMatch(/503.*retrying/);
  });

  it('retries a network error once, but never a 400', async () => {
    const net = harness([
      () => {
        throw new TypeError('fetch failed');
      },
      () => ok('back'),
    ]);
    expect((await net.client.call({ purpose: 'verify', model: ROBOTICS_ER, contents: 'x' })).text).toBe('back');

    const bad = harness([
      () => {
        throw httpError(400, 'Invalid JSON payload');
      },
      () => ok('should not run'),
    ]);
    await expect(bad.client.call({ purpose: 'verify', model: ROBOTICS_ER, contents: 'x' })).rejects.toMatchObject({ code: 'HTTP', status: 400 });
    expect(bad.seen).toHaveLength(1);
    expect(bad.sleeps).toHaveLength(0);
  });

  it('waits for Retry-After on a 429 (error field, then the retryDelay in the body)', async () => {
    const a = harness([
      () => {
        throw httpError(429, 'quota', { retryAfterMs: 3000 });
      },
      () => ok('fine'),
    ]);
    await a.client.call({ purpose: 'coworker', model: FLASH, contents: 'x' });
    expect(a.sleeps).toEqual([3000]);

    const b = harness([
      () => {
        throw Object.assign(new Error('{"error":{"code":429,"details":[{"retryDelay":"7s"}]}}'), { status: 429 });
      },
      () => ok('fine'),
    ]);
    await b.client.call({ purpose: 'coworker', model: FLASH, contents: 'x' });
    expect(b.sleeps).toEqual([7000]);

    // longer than we are willing to wait: fail fast instead of hanging the queue
    const c = harness([
      () => {
        throw httpError(429, 'quota', { retryAfterMs: 120_000 });
      },
    ]);
    await expect(c.client.call({ purpose: 'coworker', model: FLASH, contents: 'x' })).rejects.toMatchObject({ status: 429 });
    expect(c.sleeps).toEqual([]);
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
  });

  it('times out a hung request and keeps the queue moving', async () => {
    const { client, entries } = harness([() => new Promise<RawResponse>(() => {}), () => ok('next')]);
    await expect(client.call({ purpose: 'verify', model: ROBOTICS_ER, contents: 'x', timeoutMs: 30 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(entries[0]).toMatchObject({ ok: false });
    expect((await client.call({ purpose: 'verify', model: ROBOTICS_ER, contents: 'y' })).text).toBe('next');
  });

  it('cancels a queued request without ever sending it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { client, seen } = harness([
      async () => {
        await gate;
        return ok('first');
      },
      () => ok('never'),
    ]);
    const first = client.call({ purpose: 'verify', model: ROBOTICS_ER, contents: 'first' });
    const ac = new AbortController();
    const second = client.call({ purpose: 'verify', model: ROBOTICS_ER, contents: 'second', signal: ac.signal });
    ac.abort();
    await expect(second).rejects.toBeInstanceOf(GeminiError);
    release();
    expect((await first).text).toBe('first');
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.map((p) => p.contents)).toEqual(['first']);
  });

  it('applies thinking levels only where supported and never sends temperature', () => {
    const flash = buildConfig({ model: FLASH, purpose: 'coworker', config: { temperature: 0.2 } });
    expect(flash).toEqual({ thinkingConfig: { thinkingLevel: 'LOW' } });
    const er = buildConfig({ model: ROBOTICS_ER, purpose: 'point', level: 'HIGH', config: { thinkingConfig: { thinkingLevel: 'HIGH' } } });
    expect(er).toEqual({});
    const design = buildConfig({ model: FLASH, purpose: 'design', level: 'HIGH' });
    expect(design.thinkingConfig).toEqual({ thinkingLevel: 'HIGH' });
  });

  it('generateJson sends the schema, then retries once without it on a schema 400', async () => {
    const { client, seen } = harness([
      () => {
        throw httpError(400, 'Invalid value at generation_config.response_json_schema');
      },
      () => ok('{"name":"shard"}'),
    ]);
    const gen = createGenerateJson((req) => client.call(req));
    const out = await gen({ system: 'You design samples.', prompt: 'a shard', schema: { type: 'object' } });
    expect(out.text).toBe('{"name":"shard"}');
    expect(seen[0].config).toMatchObject({ responseMimeType: 'application/json', responseJsonSchema: { type: 'object' }, thinkingConfig: { thinkingLevel: 'LOW' } });
    expect(seen[1].config?.responseJsonSchema).toBeUndefined();
    expect(seen[1].config?.systemInstruction).toEqual({ parts: [{ text: 'You design samples.' }] });
    expect(client.recent().every((e) => e.purpose === 'design')).toBe(true);
  });

  it('generateJson retries once without the schema on ANY 400, even one that names no field', async () => {
    // what the real API answers to a schema keyword it does not support
    const { client, seen } = harness([
      () => {
        throw httpError(400, 'Request contains an invalid argument.');
      },
      () => ok('{"name":"plain JSON mode"}'),
    ]);
    const gen = createGenerateJson((req) => client.call(req));
    expect((await gen({ system: 's', prompt: 'p', schema: { type: 'object' } })).text).toBe('{"name":"plain JSON mode"}');
    expect(seen).toHaveLength(2);
    expect(seen[0].config?.responseJsonSchema).toEqual({ type: 'object' });
    expect(seen[1].config?.responseJsonSchema).toBeUndefined();
    expect(seen[1].config?.responseMimeType).toBe('application/json');

    // only once: a second 400 fails the call (the designer then falls back to a preset)
    const twice = harness([
      () => {
        throw httpError(400, 'Request contains an invalid argument.');
      },
      () => {
        throw httpError(400, 'Request contains an invalid argument.');
      },
      () => ok('never'),
    ]);
    const gen2 = createGenerateJson((req) => twice.client.call(req));
    await expect(gen2({ system: 's', prompt: 'p', schema: {} })).rejects.toMatchObject({ status: 400 });
    expect(twice.seen).toHaveLength(2);

    // not a 400: no schema-less retry
    const denied = harness([
      () => {
        throw httpError(403, 'Permission denied');
      },
      () => ok('never'),
    ]);
    const gen3 = createGenerateJson((req) => denied.client.call(req));
    await expect(gen3({ system: 's', prompt: 'p', schema: {} })).rejects.toMatchObject({ status: 403 });
    expect(denied.seen).toHaveLength(1);
  });
});
