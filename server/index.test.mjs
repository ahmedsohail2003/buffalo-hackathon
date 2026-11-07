// Server routes against a fake upstream: no real keys, no network.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EL_KEY, GEMINI_KEY, startFakeUpstream } from './fake-upstream.mjs';
import { createServer, loadConfig, makeBudget, makeLimiter } from './index.mjs';

let upstream;
let dist;
const servers = [];

async function start(env = {}, deps = {}) {
  const cfg = loadConfig({ DIST_DIR: dist, LOG_REQUESTS: '0', GEMINI_BASE: upstream.base, ELEVENLABS_BASE: upstream.base, ...env });
  const server = createServer(cfg, deps);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (url, body, headers = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

beforeAll(async () => {
  upstream = await startFakeUpstream();
  dist = await mkdtemp(join(tmpdir(), 'starhand-dist-'));
  await mkdir(join(dist, 'assets'));
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>STARHAND</title>');
  await writeFile(join(dist, 'assets', 'app-abc123.js'), 'console.log("bay")');
});

afterAll(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  await upstream.close();
  await rm(dist, { recursive: true, force: true });
});

describe('server without keys', () => {
  it('health says what is configured', async () => {
    const base = await start();
    const r = await fetch(`${base}/api/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, gemini: false, elevenlabs: false, live: false, liveModel: 'gemini-3.8-live' });
  });

  it('TTS, the Gemini proxy and the Live token route answer with clean JSON errors', async () => {
    const base = await start();
    const t = await post(`${base}/api/tts`, { text: 'Radio check.' });
    expect(t.status).toBe(503);
    expect(t.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await t.json()).toMatchObject({ error: 'elevenlabs_unconfigured' });
    const g = await fetch(`${base}/api/gemini/v1beta/models`);
    expect(g.status).toBe(503);
    expect(await g.json()).toMatchObject({ error: 'gemini_unconfigured' });
    expect((await post(`${base}/api/gemini/live-token`, {})).status).toBe(503);
    expect(upstream.seen).toHaveLength(0);
  });
});

describe('static files', () => {
  it('serves the app with MIME types, cache headers and an SPA fallback; refuses traversal', async () => {
    const base = await start();
    const index = await fetch(`${base}/`);
    expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(index.headers.get('cache-control')).toBe('no-cache');
    expect(await index.text()).toContain('STARHAND');

    const js = await fetch(`${base}/assets/app-abc123.js`);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');

    expect(await (await fetch(`${base}/bay/mission`)).text()).toContain('STARHAND');
    expect((await fetch(`${base}/sfx/missing.mp3`)).status).toBe(404);
    for (const evil of ['/..%2f..%2f..%2fetc%2fpasswd', '/assets/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/etc/passwd']) {
      const r = await fetch(`${base}${evil}`);
      expect([403, 404, 200]).toContain(r.status);
      expect(await r.text()).not.toMatch(/root:|"name":/);
    }
    expect((await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).status).toBe(403);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });
});

describe('ElevenLabs proxy', () => {
  it('streams PCM with the server key and the voice mapped server-side', async () => {
    const base = await start({ ELEVENLABS_API_KEY: EL_KEY, ELEVENLABS_VOICE_MISSION: 'voice-mission', ELEVENLABS_VOICE_COWORKER: 'voice-cowork' });
    const r = await post(`${base}/api/tts`, { text: 'Radio check.', voice: 'coworker', previous_text: 'Flight, CAPCOM.' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('audio/pcm;rate=24000');
    const pcm = Buffer.from(await r.arrayBuffer());
    expect(pcm.length).toBe(24000); // 0.5 s of s16le mono at 24 kHz
    const call = upstream.seen.findLast((s) => s.path.startsWith('/v1/text-to-speech/'));
    expect(call.path).toBe('/v1/text-to-speech/voice-cowork/stream');
    expect(call.search).toBe('?output_format=pcm_24000');
    expect(call.headers['xi-api-key']).toBe(EL_KEY);
    expect(call.body).toEqual({ text: 'Radio check.', model_id: 'eleven_flash_v2_5', previous_text: 'Flight, CAPCOM.' });

    await post(`${base}/api/tts`, { text: 'Default voice.', voice: 'not-a-voice' });
    expect(upstream.seen.findLast((s) => s.path.startsWith('/v1/text-to-speech/')).path).toBe('/v1/text-to-speech/voice-mission/stream');
  });

  it('aborts the upstream request when the browser hangs up (barge-in)', async () => {
    const base = await start({ ELEVENLABS_API_KEY: EL_KEY });
    const ac = new AbortController();
    const r = await fetch(`${base}/api/tts`, { method: 'POST', signal: ac.signal, body: JSON.stringify({ text: 'a long transmission' }) });
    const reader = r.body.getReader();
    const first = await reader.read();
    expect(first.value.length).toBeGreaterThan(0);
    ac.abort();
    const result = await upstream.ttsDone[upstream.ttsDone.length - 1];
    expect(result.aborted).toBe(true);
    expect(result.sent).toBeLessThan(96000);
  });

  it('refuses empty text and oversized bodies, rate-limits per IP, and hides a bad upstream key', async () => {
    const base = await start({ ELEVENLABS_API_KEY: EL_KEY, RATE_TTS: '3' });
    expect((await post(`${base}/api/tts`, { text: '   ' })).status).toBe(400);
    expect((await post(`${base}/api/tts`, '{not json')).status).toBe(400);
    expect((await post(`${base}/api/tts`, { text: 'x'.repeat(20_000) })).status).toBe(413);
    const limited = await post(`${base}/api/tts`, { text: 'one more' });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);

    const wrongKey = await start({ ELEVENLABS_API_KEY: 'el-wrong-key-999' });
    const bad = await post(`${wrongKey}/api/tts`, { text: 'hello' });
    expect(bad.status).toBe(502);
    const body = await bad.json();
    expect(body).toMatchObject({ error: 'elevenlabs_error', status: 401 });
    expect(JSON.stringify(body)).not.toContain('el-wrong-key-999');
  });
});

describe('Gemini proxy', () => {
  it('the browser SDK works through it: the placeholder key is swapped for the real one', async () => {
    const base = await start({ GEMINI_API_KEY: GEMINI_KEY });
    const { GoogleGenAI } = await import('@google/genai/web');
    const ai = new GoogleGenAI({ apiKey: 'server-proxy', httpOptions: { baseUrl: `${base}/api/gemini` } });
    const res = await ai.models.generateContent({ model: 'gemini-3.8-flash', contents: 'Bay status?', config: { thinkingConfig: { thinkingLevel: 'LOW' } } });
    expect(res.text).toBe('echo gemini-3.8-flash');
    const call = upstream.seen.findLast((s) => s.path.includes(':generateContent'));
    expect(call.path).toBe('/v1beta/models/gemini-3.8-flash:generateContent');
    expect(call.headers['x-goog-api-key']).toBe(GEMINI_KEY);
    expect(call.body.contents[0].parts[0].text).toBe('Bay status?');
  });

  it('forwards only allowed models and routes, and passes 429 + Retry-After through', async () => {
    const base = await start({ GEMINI_API_KEY: GEMINI_KEY });
    const body = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
    expect((await post(`${base}/api/gemini/v1beta/models/gemini-9-ultra:generateContent`, body)).status).toBe(403);
    expect((await post(`${base}/api/gemini/v1beta/models/gemini-3.8-flash:embedContent`, body)).status).toBe(404);
    expect((await fetch(`${base}/api/gemini/v1beta/models`)).status).toBe(404);
    expect((await fetch(`${base}/api/gemini/v1beta/models/gemini-3.8-flash:generateContent`)).status).toBe(405);
    const er = await post(`${base}/api/gemini/v1beta/models/gemini-robotics-er-2-preview:generateContent?key=leak`, body);
    expect(er.status).toBe(200);
    expect(upstream.seen.findLast((s) => s.path.includes('robotics')).search).toBe('');
    const slow = await post(`${base}/api/gemini/v1beta/models/gemini-3.8-flash:generateContent`, { contents: [{ parts: [{ text: 'please 429' }] }] });
    expect(slow.status).toBe(429);
    expect(slow.headers.get('retry-after')).toBe('7');
  });

  it('passes server-sent events through as they stream', async () => {
    const base = await start({ GEMINI_API_KEY: GEMINI_KEY });
    const r = await post(`${base}/api/gemini/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse`, { contents: [{ parts: [{ text: 'go' }] }] });
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    const reader = r.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('Copy');
    expect(first).not.toContain('Flight'); // not buffered: later events have not arrived yet
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('Flight');
  });

  it('puts a ceiling on each request: one candidate, bounded output and thinking, no search, URL or code tools', async () => {
    expect(loadConfig({}).caps.gemini).toBe(1024 * 1024);
    const base = await start({ GEMINI_API_KEY: GEMINI_KEY });
    const url = `${base}/api/gemini/v1beta/models/gemini-3.8-flash:generateContent`;
    const fn = { functionDeclarations: [{ name: 'bay_status', description: 'Bay state.' }] };
    const r = await post(url, {
      contents: [{ parts: [{ text: 'hi' }] }],
      generationConfig: { candidateCount: 8, maxOutputTokens: 65536, thinkingConfig: { thinkingBudget: 32768 }, responseMimeType: 'application/json' },
      tools: [{ googleSearch: {} }, { urlContext: {} }, { codeExecution: {} }, fn],
    });
    expect(r.status).toBe(200);
    let call = upstream.seen.findLast((s) => s.path.includes(':generateContent'));
    expect(call.body.generationConfig).toEqual({ candidateCount: 1, maxOutputTokens: 32768, thinkingConfig: { thinkingBudget: 4096 }, responseMimeType: 'application/json' });
    expect(call.body.tools).toEqual([fn]);

    // snake_case field names reach the same fields upstream, so they are clamped too; -1 (dynamic) is bounded
    await post(url, { contents: [], generation_config: { candidate_count: 4, max_output_tokens: 99999, thinking_config: { thinking_budget: -1 } }, tools: [{ google_search: {} }] });
    call = upstream.seen.findLast((s) => s.path.includes(':generateContent'));
    expect(call.body.generation_config).toBeUndefined();
    expect(call.body.generationConfig).toEqual({ candidateCount: 1, maxOutputTokens: 32768, thinkingConfig: { thinkingBudget: 4096 } });
    expect(call.body.tools).toBeUndefined();

    // what the app sends is left alone apart from the ceilings: a thinking level gets no budget added
    await post(url, { contents: [], generationConfig: { thinkingConfig: { thinkingLevel: 'LOW' }, maxOutputTokens: 300 } });
    call = upstream.seen.findLast((s) => s.path.includes(':generateContent'));
    expect(call.body.generationConfig).toEqual({ candidateCount: 1, maxOutputTokens: 300, thinkingConfig: { thinkingLevel: 'LOW' } });

    const low = await start({ GEMINI_API_KEY: GEMINI_KEY, GEMINI_MAX_OUTPUT_TOKENS: '100', GEMINI_MAX_THINKING_BUDGET: '50' });
    await post(`${low}/api/gemini/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse`, { contents: [], generationConfig: { thinkingConfig: { thinkingBudget: 9000 } } });
    call = upstream.seen.findLast((s) => s.path.includes(':streamGenerateContent'));
    expect(call.body.generationConfig).toEqual({ candidateCount: 1, maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 50 } });
    expect((await post(url, 'not json')).status).toBe(400);
  });

  it('rate-limits per IP and caps the body', async () => {
    const base = await start({ GEMINI_API_KEY: GEMINI_KEY, RATE_GEMINI: '1', GEMINI_BODY_CAP: '2048' });
    const url = `${base}/api/gemini/v1beta/models/gemini-3.8-flash:generateContent`;
    expect((await post(url, { contents: [{ parts: [{ text: 'x'.repeat(5000) }] }] })).status).toBe(413);
    expect((await post(url, { contents: [] })).status).toBe(429);
  });

  it('mints a single-use Live token for exactly the posted config (real SDK, fake upstream)', async () => {
    const base = await start({ GEMINI_API_KEY: GEMINI_KEY });
    const config = {
      responseModalities: ['AUDIO'],
      systemInstruction: { parts: [{ text: 'You are CAPCOM.' }] },
      realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      tools: [{ functionDeclarations: [{ name: 'bay_status', description: 'Bay state.', behavior: 'BLOCKING' }] }],
    };
    const t0 = Date.now();
    const r = await post(`${base}/api/gemini/live-token`, { model: 'gemini-3.8-live', config });
    expect(r.status).toBe(200);
    const tok = await r.json();
    expect(tok).toMatchObject({ name: 'auth_tokens/fake-token-123', model: 'gemini-3.8-live', apiVersion: 'v1alpha' });
    expect(Date.parse(tok.expireTime) - t0).toBeGreaterThan(29 * 60_000);
    expect(Date.parse(tok.newSessionExpireTime) - t0).toBeLessThan(61_000);

    const call = upstream.seen.findLast((s) => s.path === '/v1alpha/auth_tokens');
    expect(call.headers['x-goog-api-key']).toBe(GEMINI_KEY);
    expect(call.body.uses).toBe(1);
    expect(call.body.fieldMask).toBeUndefined();
    const setup = JSON.stringify(call.body.bidiGenerateContentSetup);
    expect(setup).toContain('gemini-3.8-live');
    expect(setup).toContain('You are CAPCOM.');
    expect(setup).toContain('bay_status');

    expect((await post(`${base}/api/gemini/live-token`, { model: 'gemini-3.8-flash', config })).status).toBe(403);
    expect((await post(`${base}/api/gemini/live-token`, { model: 'gemini-3.8-live', config: { responseModalities: ['TEXT'] } })).status).toBe(400);
  });
});

describe('server-wide budgets (all clients together)', () => {
  it('TTS is counted in characters across IPs and answers a 429 the speaker survives', async () => {
    expect(loadConfig({}).limits.tts).toBe(30);
    const base = await start({ ELEVENLABS_API_KEY: EL_KEY, TRUST_PROXY: '1', BUDGET_TTS_CHARS_PER_MIN: '30' });
    const before = upstream.seen.filter((s) => s.path.startsWith('/v1/text-to-speech/')).length;
    const a = await post(`${base}/api/tts`, { text: 'Twenty characters ok' }, { 'x-forwarded-for': '198.51.100.1' });
    expect(a.status).toBe(200);
    await a.arrayBuffer();
    // a different IP has its own per-IP allowance, but the server's character budget is spent
    const b = await post(`${base}/api/tts`, { text: 'Another twenty chars' }, { 'x-forwarded-for': '198.51.100.2' });
    expect(b.status).toBe(429);
    expect(Number(b.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await b.json()).toMatchObject({ error: 'budget_exhausted', upstream: 'elevenlabs' });
    // a short line still fits
    const c = await post(`${base}/api/tts`, { text: 'Copy.' }, { 'x-forwarded-for': '198.51.100.3' });
    expect(c.status).toBe(200);
    await c.arrayBuffer();
    expect(upstream.seen.filter((s) => s.path.startsWith('/v1/text-to-speech/')).length - before).toBe(2);
  });

  it('Gemini requests and Live tokens share one server-wide request budget', async () => {
    const base = await start({ GEMINI_API_KEY: GEMINI_KEY, TRUST_PROXY: '1', BUDGET_GEMINI_PER_MIN: '2' });
    const url = `${base}/api/gemini/v1beta/models/gemini-3.8-flash:generateContent`;
    const body = { contents: [{ parts: [{ text: 'hi' }] }] };
    expect((await post(url, body, { 'x-forwarded-for': '203.0.113.1' })).status).toBe(200);
    expect((await post(`${base}/api/gemini/live-token`, { model: 'gemini-3.8-live', config: {} }, { 'x-forwarded-for': '203.0.113.2' })).status).toBe(200);
    const over = await post(url, body, { 'x-forwarded-for': '203.0.113.3' });
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: 'budget_exhausted', upstream: 'gemini' });
    const tok = await post(`${base}/api/gemini/live-token`, { model: 'gemini-3.8-live', config: {} }, { 'x-forwarded-for': '203.0.113.4' });
    expect(tok.status).toBe(429);
  });

  it('a budget opens again after its window; the daily window outlasts the minute one; refusals spend nothing', () => {
    let now = 0;
    const spend = makeBudget(10, 25, () => now);
    expect(spend(6)).toBe(0);
    expect(spend(5)).toBeGreaterThan(0); // 11 > 10 this minute
    expect(spend(4)).toBe(0); // the refused 5 was not counted
    now = 60_000;
    expect(spend(10)).toBe(0); // 20 today
    now = 120_000;
    const wait = spend(6); // 26 > 25 today
    expect(wait).toBeGreaterThan(60);
    now = 86_400_000;
    expect(spend(6)).toBe(0);
  });
});

describe('rate limiter', () => {
  it('opens a new window after a minute', () => {
    let now = 0;
    const limit = makeLimiter(2, () => now);
    expect([limit('a'), limit('a'), limit('a') > 0, limit('b')]).toEqual([0, 0, true, 0]);
    now = 60_000;
    expect(limit('a')).toBe(0);
  });
});
