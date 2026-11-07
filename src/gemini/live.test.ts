import { describe, expect, it } from 'vitest';
import type { GeminiCallEntry } from '../contracts';
import type { SpeakerLike } from '../voice/elevenSpeaker';
import { makeFakeBay, makeSample } from './__fixtures__/fakeBay';
import { LiveVoice, buildLiveConfig, fetchLiveToken, type LiveCallbacksLite, type LiveConnector, type LiveSessionLike, type MicLike, type PlayerLike } from './live';
import type { ToolContext } from './tools';

const tick = () => new Promise((r) => setTimeout(r, 0));

function rig(opts: { state?: 'RUNNING' | 'STOPPED' } = {}) {
  const bay = makeFakeBay({ samples: [makeSample({ id: 's1', name: 'Bennu fragment', pos: [0, -0.165, 0.012] })], state: opts.state });
  const sessions: Array<LiveSessionLike & { sent: Array<[string, Record<string, unknown>]>; closed: boolean }> = [];
  const configs: Array<Record<string, unknown>> = [];
  const callbacks: LiveCallbacksLite[] = [];
  const connector: LiveConnector = async (config, cb) => {
    configs.push(config);
    callbacks.push(cb);
    const sent: Array<[string, Record<string, unknown>]> = [];
    const s = {
      sent,
      closed: false,
      sendRealtimeInput: (p: Record<string, unknown>) => void sent.push(['realtime', p]),
      sendClientContent: (p: Record<string, unknown>) => void sent.push(['client', p]),
      sendToolResponse: (p: Record<string, unknown>) => void sent.push(['tool', p]),
      close() {
        s.closed = true;
      },
    };
    sessions.push(s);
    return s;
  };
  let micCb: ((p: Int16Array) => void) | null = null;
  const mic: MicLike = {
    start: async (cb) => {
      micCb = cb;
    },
    stop: () => {},
  };
  const played: number[] = [];
  let playerStops = 0;
  const player: PlayerLike = { play: (s) => void played.push(s.length), stop: () => void playerStops++, resume: async () => {}, setMuted: () => {} };
  const spoken: string[] = [];
  const speaker: SpeakerLike = {
    push: (d, v) => void spoken.push(`push:${v}:${d}`),
    end: () => void spoken.push('end'),
    say: (t) => void spoken.push(`say:${t}`),
    cancel: () => void spoken.push('cancel'),
    setMuted: () => {},
    resume: async () => {},
    muted: false,
    speaking: false,
    broken: false,
  };
  const entries: GeminiCallEntry[] = [];
  const live = new LiveVoice({ bay, speaker, connector, mic, player, tailMs: 0, recordEntry: (e) => void entries.push(e) });
  const server = (i = callbacks.length - 1) => callbacks[i];
  const lastSent = () => sessions[sessions.length - 1].sent;
  return { bay, live, sessions, configs, server, lastSent, mic: (p: Int16Array) => micCb?.(p), played, playerStops: () => playerStops, spoken, entries };
}

describe('Live config', () => {
  it('is audio-only with manual activity, both transcriptions, the bay tools and no thinking level', () => {
    const cfg = buildLiveConfig({ handle: 'h-1' });
    expect(cfg.responseModalities).toEqual(['AUDIO']);
    expect(cfg.realtimeInputConfig).toEqual({ automaticActivityDetection: { disabled: true } });
    expect(cfg.inputAudioTranscription).toEqual({});
    expect(cfg.outputAudioTranscription).toEqual({});
    expect(cfg.sessionResumption).toEqual({ handle: 'h-1' });
    expect(cfg.thinkingConfig).toBeUndefined();
    expect(cfg.temperature).toBeUndefined();
    const decls = (cfg.tools as Array<{ functionDeclarations: Array<{ name: string; behavior: string }> }>)[0].functionDeclarations;
    expect(decls).toHaveLength(9);
    expect(decls.find((d) => d.name === 'design_sample')?.behavior).toBe('NON_BLOCKING');
    expect(JSON.stringify(cfg.systemInstruction)).toContain('[BAY EVENT]');
  });

  it('asks the server for a token locked to the config', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ name: 'auth_tokens/t1', apiVersion: 'v1alpha' }), { status: 200 });
    }) as unknown as typeof fetch;
    const cfg = buildLiveConfig();
    expect(await fetchLiveToken(cfg, fetchFn)).toEqual({ name: 'auth_tokens/t1', apiVersion: 'v1alpha' });
    expect(seen[0]).toEqual({ url: '/api/gemini/live-token', body: { model: 'gemini-3.8-live', config: cfg } });
    const failing = (async () => new Response(JSON.stringify({ error: 'gemini_unconfigured', message: 'Gemini is not configured.' }), { status: 503 })) as unknown as typeof fetch;
    await expect(fetchLiveToken(cfg, failing)).rejects.toThrow('Gemini is not configured.');
  });
});

describe('Live voice session', () => {
  it('hold to talk: barge-in, activity start, 16 kHz audio while held, activity end on release', async () => {
    const r = rig();
    await r.live.connect();
    expect(r.live.state).toBe('ready');
    r.mic(new Int16Array([1, 2]));
    expect(r.lastSent()).toEqual([]); // the mic is open but nothing is sent until TALK
    r.live.startTalk();
    expect(r.spoken).toContain('cancel');
    expect(r.playerStops()).toBeGreaterThan(0);
    r.mic(new Int16Array([1, -1]));
    r.live.endTalk();
    r.mic(new Int16Array([5, 5]));
    expect(r.lastSent()).toEqual([
      ['realtime', { activityStart: {} }],
      ['realtime', { audio: { data: 'AQD//w==', mimeType: 'audio/pcm;rate=16000' } }],
      ['realtime', { activityEnd: {} }],
    ]);
    expect(r.live.state).toBe('thinking');
  });

  it('ElevenLabs mode speaks the output transcription and never plays Live audio; native mode plays it', async () => {
    const r = rig();
    await r.live.connect();
    r.live.startTalk();
    r.live.endTalk();
    const audio = { inlineData: { data: 'AAABAAIA', mimeType: 'audio/pcm;rate=24000' } };
    r.server().onmessage({ serverContent: { outputTranscription: { text: 'Copy, picking ' } } });
    r.server().onmessage({ serverContent: { modelTurn: { parts: [audio] } } });
    r.server().onmessage({ serverContent: { outputTranscription: { text: 'up s1.' } } });
    r.server().onmessage({ usageMetadata: { promptTokenCount: 900, responseTokenCount: 120 }, serverContent: { turnComplete: true } });
    expect(r.spoken.filter((s) => s !== 'cancel')).toEqual(['push:coworker:Copy, picking ', 'push:coworker:up s1.', 'end']);
    expect(r.played).toEqual([]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ model: 'gemini-3.8-live', purpose: 'live', promptTokens: 900, outputTokens: 120, ok: true });
    expect(r.live.state).toBe('ready');

    r.live.setOutput('native');
    r.server().onmessage({ serverContent: { modelTurn: { parts: [audio] }, outputTranscription: { text: 'Done.' } } });
    expect(r.played).toEqual([3]);
    expect(r.spoken).not.toContain('push:coworker:Done.');

    r.server().onmessage({ serverContent: { interrupted: true } });
    expect(r.spoken[r.spoken.length - 1]).toBe('cancel');
  });

  it('long tools answer "started" at once and report the result as a [BAY EVENT] after the turn', async () => {
    const r = rig();
    await r.live.connect();
    r.live.startTalk();
    r.live.endTalk(); // CAPCOM's turn is now open
    r.server().onmessage({ toolCall: { functionCalls: [{ id: 'call-7', name: 'pick_sample', args: { id: 's1' } }] } });
    await tick();
    await tick();
    const tool = r.lastSent().find(([k]) => k === 'tool');
    expect(tool?.[1]).toEqual({
      functionResponses: [{ id: 'call-7', name: 'pick_sample', response: { ok: true, status: 'started', note: 'Running now. The result follows as a [BAY EVENT] message.' }, scheduling: 'SILENT' }],
    });
    expect(r.bay.calls.map((c) => c.fn)).toEqual(['pick']);
    expect(r.lastSent().some(([k]) => k === 'client')).toBe(false); // waits for the turn to end
    r.server().onmessage({ serverContent: { turnComplete: true } });
    const event = r.lastSent().find(([k]) => k === 'client');
    expect(event?.[1]).toEqual({
      turns: [{ role: 'user', parts: [{ text: '[BAY EVENT] pick_sample(id: "s1") succeeded: ok, holding s1' }] }],
      turnComplete: true,
    });

    r.server().onmessage({ toolCall: { functionCalls: [{ id: 'call-8', name: 'describe_bay', args: {} }] } });
    await tick();
    const instant = r.lastSent().filter(([k]) => k === 'tool')[1][1] as { functionResponses: Array<Record<string, unknown>> };
    expect(instant.functionResponses[0]).toMatchObject({ id: 'call-8', name: 'describe_bay', response: { ok: true } });
    expect(instant.functionResponses[0].scheduling).toBeUndefined();
  });

  it('an emergency stop aborts the signal of a long tool call in flight', async () => {
    const r = rig();
    let seen: AbortSignal | undefined;
    const fabricate: NonNullable<ToolContext['fabricate']> = (_bay, _d, _p, _deps, signal) =>
      new Promise((resolve) => {
        seen = signal;
        signal?.addEventListener('abort', () => resolve({ ok: false, code: 'ABORTED', reason: 'the request was cancelled, so no sample was made' }));
      });
    const live = new LiveVoice({ bay: r.bay, connector: async (_c, cb) => { cbs.push(cb); return { sendRealtimeInput() {}, sendClientContent() {}, sendToolResponse() {}, close() {} }; }, mic: { start: async () => {}, stop() {} }, player: { play() {}, stop() {}, resume: async () => {}, setMuted() {} }, tailMs: 0, tools: { fabricate }, recordEntry: () => {} });
    const cbs: LiveCallbacksLite[] = [];
    const lines: string[] = [];
    live.events = { onTool: (l) => void lines.push(l) };
    await live.connect();
    cbs[0].onmessage({ toolCall: { functionCalls: [{ id: 'd1', name: 'design_sample', args: { description: 'a shard' } }] } });
    await tick();
    expect(seen?.aborted).toBe(false);
    r.bay.setState('ESTOPPED');
    await tick();
    await tick();
    expect(seen?.aborted).toBe(true);
    expect(lines.some((l) => /design_sample\(.*\) failed: refused \(ABORTED\)/.test(l))).toBe(true);
  });

  it('while the bay is stopped a moving tool is refused at once and the arm never moves', async () => {
    const r = rig({ state: 'STOPPED' });
    await r.live.connect();
    r.server().onmessage({ toolCall: { functionCalls: [{ id: 'c1', name: 'place_in_containment', args: {} }] } });
    await tick();
    const tool = r.lastSent().find(([k]) => k === 'tool')?.[1] as { functionResponses: Array<Record<string, unknown>> };
    expect(tool.functionResponses[0]).toMatchObject({ id: 'c1', response: { ok: false, code: 'BAY_STOPPED' }, scheduling: 'WHEN_IDLE' });
    expect(r.bay.calls).toEqual([]);
  });

  it('a goAway renews the link with the latest resumption handle and ignores the old session', async () => {
    const r = rig();
    await r.live.connect();
    const first = r.server(0);
    first.onmessage({ sessionResumptionUpdate: { newHandle: 'h-2', resumable: true } });
    first.onmessage({ goAway: { timeLeft: '10s' } });
    await tick();
    await tick();
    expect(r.configs).toHaveLength(2);
    expect(r.configs[1].sessionResumption).toEqual({ handle: 'h-2' });
    expect(r.sessions[0].closed).toBe(true);
    first.onmessage({ serverContent: { outputTranscription: { text: 'stale' } } });
    expect(r.spoken.join()).not.toContain('stale');
    expect(r.live.state).toBe('ready');
  });

  it('an unexpected close retries, then gives up with an error the panel can show', async () => {
    const r = rig();
    await r.live.connect();
    for (let i = 0; i < 3; i++) {
      r.server().onclose?.({ code: 1011, reason: 'internal' });
      await tick();
      await tick();
    }
    expect(r.configs).toHaveLength(3); // the first link plus two renewals
    expect(r.live.state).toBe('error');
    r.live.disconnect();
    expect(r.live.state).toBe('off');
  });
});
