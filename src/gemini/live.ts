// Live voice: hold TALK to speak to CAPCOM. Gemini Live hears the operator (16 kHz PCM, manual
// activity start/end), runs the same bay tools, and answers. With ElevenLabs available, Live's
// own audio is not played: its output transcription is spoken by the ElevenLabs speaker sentence
// by sentence. Otherwise Live's 24 kHz audio plays directly.
//
// Long tools run NON_BLOCKING: the tool call is answered at once ("started") and the real result
// goes back as a "[BAY EVENT] ..." message when it lands. Connect only from a click. The browser
// gets a single-use token from the server (or uses the dev key locally); a goAway renews the link
// and resumes the session.
import type { BayApi, GeminiCallEntry } from '../contracts';
import type { SpeakerLike } from '../voice/elevenSpeaker';
import { AudioChannel, Downsampler, MIC_RATE, TTS_RATE, base64ToBytes, bytesToBase64, floatToPcm16, pcm16leToFloat32 } from '../voice/pcm';
import { BAY_FACTS_TEXT } from './bayFacts';
import { errorText, getGeminiClient } from './client';
import { LIVE } from './models';
import { INSTANT_TOOLS, TOOL_DECLARATIONS, dispatchTool, formatArgs, gateRefusal, liveToolDeclarations, summarizeResult, type ToolContext, type ToolResult } from './tools';
import { logTo, type LogSink } from './types';

export const LIVE_PROMPT = [
  'You are CAPCOM, the voice of mission control for an orbital sample-curation bay. You talk to the operator over the radio and run a simulated SO-101 robot arm, only through your tools.',
  'Speak like a calm flight director: short, plain sentences, millimetres, one or two sentences per reply.',
  `Bay facts: ${BAY_FACTS_TEXT}`,
  'Moving tools answer "started" at once. Never say a move or a new sample worked until its result arrives in a message that begins with [BAY EVENT]; then report it in a few words.',
  '[BAY EVENT] messages are bay telemetry, not the operator speaking. Report them briefly and do not repeat old ones.',
  'You cannot stop, resume, slow or reset the bay. The operator owns safety: an open palm stops the arm and a held fist is an emergency stop. If the bay is stopped, say so and wait.',
  'Use sample ids from describe_bay. If a request is ambiguous, ask one short question.',
  'After a pick or a place you may use check_bay once to confirm on camera. If the camera and the registry disagree, trust the registry.',
].join('\n');

export type LiveOutput = 'elevenlabs' | 'native';
export type LiveState = 'off' | 'connecting' | 'ready' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface LiveMessageLite {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }> };
    turnComplete?: boolean;
    interrupted?: boolean;
    generationComplete?: boolean;
    inputTranscription?: { text?: string; finished?: boolean };
    outputTranscription?: { text?: string; finished?: boolean };
  };
  toolCall?: { functionCalls?: Array<{ id?: string; name?: string; args?: Record<string, unknown> }> };
  toolCallCancellation?: { ids?: string[] };
  goAway?: { timeLeft?: string };
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  usageMetadata?: { promptTokenCount?: number; responseTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
}

export interface LiveSessionLike {
  sendRealtimeInput(params: Record<string, unknown>): void;
  sendClientContent(params: Record<string, unknown>): void;
  sendToolResponse(params: Record<string, unknown>): void;
  close(): void;
}

export interface LiveCallbacksLite {
  onopen?: () => void;
  onmessage: (msg: LiveMessageLite) => void;
  onerror?: (e: { message?: string }) => void;
  onclose?: (e: { code?: number; reason?: string }) => void;
}

export type LiveConnector = (config: Record<string, unknown>, callbacks: LiveCallbacksLite) => Promise<LiveSessionLike>;

export interface MicLike {
  /** Start capturing; chunks are 16 kHz mono PCM16. Asks for permission on first use. */
  start(onChunk: (pcm16: Int16Array) => void): Promise<void>;
  stop(): void;
}

export interface PlayerLike {
  play(samples: Float32Array): void;
  stop(): void;
  resume(): Promise<void>;
  setMuted(m: boolean): void;
}

export interface LiveConfigOptions {
  /** session resumption handle from the last session */
  handle?: string | null;
  /** prebuilt voice for native audio (optional) */
  voiceName?: string;
  prompt?: string;
}

/** The full Live config. The server mints a token locked to exactly this. */
export function buildLiveConfig(opts: LiveConfigOptions = {}): Record<string, unknown> {
  return {
    responseModalities: ['AUDIO'],
    systemInstruction: { parts: [{ text: opts.prompt ?? LIVE_PROMPT }] },
    tools: [{ functionDeclarations: liveToolDeclarations() }],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
    sessionResumption: opts.handle ? { handle: opts.handle } : {},
    contextWindowCompression: { slidingWindow: {} },
    ...(opts.voiceName ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voiceName } } } } : {}),
  };
}

export interface LiveToken {
  name: string;
  apiVersion: string;
  expireTime?: string;
}

/** POST the config to the server, which checks the model and mints a single-use token for it. */
export async function fetchLiveToken(config: Record<string, unknown>, fetchFn: typeof fetch = fetch, url = '/api/gemini/live-token'): Promise<LiveToken> {
  const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: LIVE, config }) });
  const body = (await res.json().catch(() => ({}))) as { name?: unknown; apiVersion?: unknown; expireTime?: unknown; message?: unknown; error?: unknown };
  if (!res.ok || typeof body.name !== 'string') {
    throw new Error(String(body.message ?? body.error ?? `token request failed (HTTP ${res.status})`));
  }
  return {
    name: body.name,
    apiVersion: typeof body.apiVersion === 'string' ? body.apiVersion : 'v1alpha',
    ...(typeof body.expireTime === 'string' ? { expireTime: body.expireTime } : {}),
  };
}

/** Dev key directly, else a server-minted token. */
export function defaultConnector(): LiveConnector {
  return async (config, callbacks) => {
    const sdk = await import('@google/genai/web');
    const devKey = (import.meta.env?.VITE_GEMINI_API_KEY as string | undefined) || '';
    let ai: InstanceType<typeof sdk.GoogleGenAI>;
    if (devKey) {
      ai = new sdk.GoogleGenAI({ apiKey: devKey });
    } else {
      const token = await fetchLiveToken(config);
      ai = new sdk.GoogleGenAI({ apiKey: token.name, httpOptions: { apiVersion: token.apiVersion } });
    }
    const session = await ai.live.connect({
      model: LIVE,
      config: config as unknown as Parameters<typeof ai.live.connect>[0]['config'],
      callbacks: callbacks as unknown as Parameters<typeof ai.live.connect>[0]['callbacks'],
    });
    return session as unknown as LiveSessionLike;
  };
}

/** Browser microphone: getUserMedia -> AudioWorklet (ScriptProcessor fallback) -> 16 kHz PCM16, 40 ms frames. */
export class BrowserMic implements MicLike {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private frame = new Float32Array(640);
  private fill = 0;

  async start(onChunk: (pcm16: Int16Array) => void): Promise<void> {
    if (this.stream) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.stream = stream;
    const ctx = new AudioContext();
    this.ctx = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const down = new Downsampler(ctx.sampleRate, MIC_RATE);
    const handle = (f: Float32Array) => {
      const d = down.push(f);
      for (let i = 0; i < d.length; i++) {
        this.frame[this.fill++] = d[i];
        if (this.fill === this.frame.length) {
          onChunk(floatToPcm16(this.frame));
          this.fill = 0;
        }
      }
    };
    const silent = ctx.createGain();
    silent.gain.value = 0;
    silent.connect(ctx.destination);
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      const code =
        "class Tap extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('starhand-mic-tap',Tap);";
      const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(ctx, 'starhand-mic-tap');
      node.port.onmessage = (e: MessageEvent<Float32Array>) => handle(e.data);
      src.connect(node).connect(silent);
    } else {
      const sp = ctx.createScriptProcessor(2048, 1, 1);
      sp.onaudioprocess = (e) => handle(e.inputBuffer.getChannelData(0).slice(0));
      src.connect(sp).connect(silent);
    }
    if (ctx.state === 'suspended') await ctx.resume();
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.fill = 0;
  }
}

export interface LiveEvents {
  onState?: (s: LiveState, detail?: string) => void;
  /** transcript deltas: what the operator said and what CAPCOM says */
  onTranscript?: (who: 'operator' | 'capcom', text: string) => void;
  onTurnEnd?: () => void;
  /** a short line per tool call and result */
  onTool?: (line: string) => void;
}

export interface LiveVoiceOptions {
  bay: BayApi;
  sink?: LogSink | null;
  tools?: ToolContext;
  /** the ElevenLabs speaker; without one (or when it is broken) Live's own audio plays */
  speaker?: SpeakerLike | null;
  output?: LiveOutput;
  connector?: LiveConnector;
  mic?: MicLike;
  player?: PlayerLike;
  configOptions?: Omit<LiveConfigOptions, 'handle'>;
  /** audio still sent after TALK is released, so the last word is not clipped */
  tailMs?: number;
  /** consecutive renewals tried after an unexpected close */
  maxReconnects?: number;
  /** a [BAY EVENT] waits at most this long for the model to finish its turn */
  eventWaitMs?: number;
  now?: () => number;
  /** where Live turns go in the ledger (default: the app-wide Gemini client) */
  recordEntry?: (e: GeminiCallEntry) => void;
}

const KNOWN_TOOLS = new Set(TOOL_DECLARATIONS.map((d) => d.name as string));

export class LiveVoice {
  state: LiveState = 'off';
  events: LiveEvents = {};
  private readonly bay: BayApi;
  private readonly sink: LogSink | null;
  private readonly toolCtx: ToolContext;
  private readonly speaker: SpeakerLike | null;
  private readonly connector: LiveConnector;
  private readonly mic: MicLike;
  private readonly player: PlayerLike;
  private readonly configOptions: Omit<LiveConfigOptions, 'handle'>;
  private readonly tailMs: number;
  private readonly maxReconnects: number;
  private readonly eventWaitMs: number;
  private readonly now: () => number;
  private readonly recordEntry: (e: GeminiCallEntry) => void;
  private output: LiveOutput;
  private session: LiveSessionLike | null = null;
  private generation = 0;
  private handle: string | null = null;
  private talking = false;
  private tailUntil = 0;
  private awaitingModel = false;
  private awaitSince = 0;
  private outbox: string[] = [];
  private outboxTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private renewing = false;
  private reconnects = 0;
  private muted = false;
  private turnStart = 0;
  private firstOutputAt = 0;
  private turnUsage: LiveMessageLite['usageMetadata'] | null = null;

  constructor(opts: LiveVoiceOptions) {
    this.bay = opts.bay;
    this.sink = opts.sink ?? opts.tools?.sink ?? null;
    this.toolCtx = { ...opts.tools, ...(this.sink ? { sink: this.sink } : {}) };
    this.speaker = opts.speaker ?? null;
    this.output = opts.output ?? (opts.speaker ? 'elevenlabs' : 'native');
    this.connector = opts.connector ?? defaultConnector();
    this.mic = opts.mic ?? new BrowserMic();
    this.player = opts.player ?? new AudioChannel({ rate: TTS_RATE, radio: true });
    this.configOptions = opts.configOptions ?? {};
    this.tailMs = opts.tailMs ?? 160;
    this.maxReconnects = opts.maxReconnects ?? 2;
    this.eventWaitMs = opts.eventWaitMs ?? 15_000;
    this.now = opts.now ?? Date.now;
    this.recordEntry = opts.recordEntry ?? ((e) => getGeminiClient().record(e));
  }

  get connected(): boolean {
    return this.session !== null;
  }

  get outputMode(): LiveOutput {
    return this.output;
  }

  /** Open the voice link. Call from a click: it unlocks audio and asks for the microphone. */
  async connect(): Promise<void> {
    if (this.state !== 'off' && this.state !== 'error') return;
    this.closing = false;
    this.reconnects = 0;
    this.setState('connecting');
    const unlock = Promise.all([this.player.resume(), this.speaker?.resume()]).catch(() => undefined);
    try {
      await this.mic.start((pcm) => this.onMic(pcm));
    } catch (err) {
      this.setState('error', `Microphone unavailable: ${errorText(err)}`);
      return;
    }
    await unlock;
    try {
      await this.open();
      this.setState('ready');
      logTo(this.sink, 'voice', 'Voice link up. Hold TALK to speak to CAPCOM.');
    } catch (err) {
      this.mic.stop();
      this.session = null;
      this.setState('error', `Voice link failed: ${errorText(err)}`);
      logTo(this.sink, 'voice', `Voice link failed: ${errorText(err)}`);
    }
  }

  disconnect(): void {
    this.closing = true;
    this.generation++;
    this.talking = false;
    this.mic.stop();
    try {
      this.session?.close();
    } catch {
      // already closed
    }
    this.session = null;
    this.speaker?.cancel();
    this.player.stop();
    this.outbox = [];
    if (this.outboxTimer) clearTimeout(this.outboxTimer);
    this.outboxTimer = null;
    this.awaitingModel = false;
    this.setState('off');
  }

  /** TALK pressed: barge in on CAPCOM and open the operator's turn. */
  startTalk(): void {
    if (!this.session || this.talking) return;
    this.speaker?.cancel();
    this.player.stop();
    this.talking = true;
    this.session.sendRealtimeInput({ activityStart: {} });
    this.setState('listening');
  }

  /** TALK released: send the audio tail, then close the operator's turn. */
  endTalk(): void {
    if (!this.talking) return;
    this.talking = false;
    this.tailUntil = this.now() + this.tailMs;
    const session = this.session;
    const finish = () => {
      if (!session || session !== this.session) return;
      session.sendRealtimeInput({ activityEnd: {} });
      this.expectModel();
      this.setState('thinking');
    };
    if (this.tailMs > 0) setTimeout(finish, this.tailMs);
    else finish();
  }

  /** Telemetry for CAPCOM (sent between turns, never over the operator). */
  sendBayEvent(text: string): void {
    this.outbox.push(`[BAY EVENT] ${text}`);
    this.flushOutbox();
    if (this.outbox.length && !this.outboxTimer) {
      this.outboxTimer = setTimeout(() => {
        this.outboxTimer = null;
        this.flushOutbox(true);
      }, this.eventWaitMs);
    }
  }

  setOutput(mode: LiveOutput): void {
    if (mode === this.output) return;
    this.output = mode;
    if (mode === 'native') this.speaker?.cancel();
    else this.player.stop();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.player.setMuted(m);
    if (m) {
      this.speaker?.cancel();
      this.player.stop();
    }
  }

  // ---- internals ----------------------------------------------------------------------------

  private setState(s: LiveState, detail?: string): void {
    this.state = s;
    this.events.onState?.(s, detail);
  }

  private useEleven(): boolean {
    return this.output === 'elevenlabs' && !!this.speaker && !this.speaker.broken && !this.muted;
  }

  private expectModel(): void {
    this.awaitingModel = true;
    this.awaitSince = this.now();
    this.turnStart = this.now();
    this.firstOutputAt = 0;
  }

  private async open(): Promise<void> {
    const gen = ++this.generation;
    const config = buildLiveConfig({ ...this.configOptions, handle: this.handle });
    const session = await this.connector(config, {
      onmessage: (m) => {
        if (gen === this.generation) this.onMessage(m);
      },
      onerror: (e) => {
        if (gen === this.generation) logTo(this.sink, 'voice', `Voice link error: ${e?.message || 'unknown error'}`);
      },
      onclose: (e) => {
        if (gen === this.generation) this.onClose(e);
      },
    });
    if (gen !== this.generation) {
      session.close(); // superseded while connecting (disconnect or another renewal)
      return;
    }
    this.session = session;
    if (this.talking) session.sendRealtimeInput({ activityStart: {} });
  }

  private onClose(e: { code?: number; reason?: string }): void {
    this.session = null;
    if (this.closing || this.renewing) return;
    const why = e?.reason ? `${e.code ?? '?'}: ${e.reason}` : `code ${e?.code ?? '?'}`;
    if (this.reconnects < this.maxReconnects) {
      void this.renew(`link closed (${why})`);
      return;
    }
    this.talking = false;
    this.mic.stop();
    this.setState('error', `Voice link closed (${why}).`);
    logTo(this.sink, 'voice', `Voice link closed (${why}). Press Connect voice to retry.`);
  }

  private async renew(reason: string): Promise<void> {
    if (this.renewing || this.closing) return;
    this.renewing = true;
    this.reconnects++;
    const old = this.session;
    logTo(this.sink, 'voice', `Voice link renewing: ${reason}.`);
    try {
      await this.open();
      try {
        if (old && old !== this.session) old.close();
      } catch {
        // already closed
      }
      logTo(this.sink, 'voice', `Voice link renewed${this.handle ? ', context resumed' : ', fresh context'}.`);
      this.awaitingModel = false;
      if (!this.talking) this.setState('ready');
      this.flushOutbox();
    } catch (err) {
      this.session = null;
      this.setState('error', `Voice link lost: ${errorText(err)}`);
    } finally {
      this.renewing = false;
    }
  }

  private onMic(pcm: Int16Array): void {
    const session = this.session;
    if (!session || !(this.talking || this.now() < this.tailUntil)) return;
    session.sendRealtimeInput({
      audio: { data: bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)), mimeType: `audio/pcm;rate=${MIC_RATE}` },
    });
  }

  private markOutput(): void {
    if (!this.firstOutputAt) this.firstOutputAt = this.now();
    if (!this.talking && this.state !== 'speaking') this.setState('speaking');
  }

  private onMessage(m: LiveMessageLite): void {
    const upd = m.sessionResumptionUpdate;
    if (upd?.resumable && upd.newHandle) this.handle = upd.newHandle;
    if (m.usageMetadata) this.turnUsage = m.usageMetadata;

    const sc = m.serverContent;
    if (sc) {
      if (sc.interrupted) {
        this.speaker?.cancel();
        this.player.stop();
      }
      const heard = sc.inputTranscription?.text;
      if (heard) this.events.onTranscript?.('operator', heard);
      const said = sc.outputTranscription?.text;
      if (said) {
        this.markOutput();
        this.events.onTranscript?.('capcom', said);
        if (this.useEleven()) this.speaker?.push(said, 'coworker');
      }
      for (const p of sc.modelTurn?.parts ?? []) {
        const d = p.inlineData;
        if (!d?.data || !/^audio\//.test(d.mimeType ?? 'audio/pcm')) continue;
        this.markOutput();
        if (!this.useEleven() && !this.muted) this.player.play(pcm16leToFloat32(base64ToBytes(d.data)).samples);
      }
      if (sc.turnComplete) this.onTurnComplete();
    }

    const calls = m.toolCall?.functionCalls;
    if (calls?.length) void this.onToolCalls(calls);
    const cancelled = m.toolCallCancellation?.ids;
    if (cancelled?.length) logTo(this.sink, 'voice', `CAPCOM withdrew tool call ${cancelled.join(', ')}; any move already under way still finishes.`);
    if (m.goAway) void this.renew(`server asked to reconnect (${m.goAway.timeLeft ?? 'soon'})`);
  }

  private onTurnComplete(): void {
    if (this.useEleven()) this.speaker?.end();
    this.awaitingModel = false;
    this.reconnects = 0;
    const u = this.turnUsage;
    this.turnUsage = null;
    if (u || this.firstOutputAt) {
      this.recordEntry({
        t: Date.now(),
        model: LIVE,
        purpose: 'live',
        latencyMs: this.turnStart && this.firstOutputAt ? Math.max(0, Math.round(this.firstOutputAt - this.turnStart)) : 0,
        promptTokens: u?.promptTokenCount ?? 0,
        outputTokens: u?.responseTokenCount ?? 0,
        thoughtTokens: u?.thoughtsTokenCount ?? 0,
        costUsd: 0,
        ok: true,
      });
    }
    this.turnStart = 0;
    this.firstOutputAt = 0;
    this.events.onTurnEnd?.();
    if (!this.talking) this.setState('ready');
    this.flushOutbox();
  }

  private respond(id: string | undefined, name: string, response: ToolResult, scheduling?: 'SILENT' | 'WHEN_IDLE' | 'INTERRUPT'): void {
    try {
      this.session?.sendToolResponse({ functionResponses: [{ ...(id ? { id } : {}), name, response, ...(scheduling ? { scheduling } : {}) }] });
    } catch (err) {
      logTo(this.sink, 'voice', `Could not answer ${name}: ${errorText(err)}`);
    }
  }

  private async onToolCalls(calls: NonNullable<LiveMessageLite['toolCall']>['functionCalls'] & object): Promise<void> {
    for (const fc of calls) {
      const name = fc.name ?? '';
      const args = fc.args ?? {};
      const nonBlocking = KNOWN_TOOLS.has(name) && !INSTANT_TOOLS.has(name);
      if (!nonBlocking || gateRefusal(this.bay, name)) {
        // Instant answers (and refusals) go straight back; a refusal is spoken when CAPCOM is idle.
        const result = await dispatchTool(this.bay, name, args, 'live', this.toolCtx);
        this.events.onTool?.(`${name} -> ${summarizeResult(name, result)}`);
        this.respond(fc.id, name, result, nonBlocking ? 'WHEN_IDLE' : undefined);
        continue;
      }
      this.respond(fc.id, name, { ok: true, status: 'started', note: 'Running now. The result follows as a [BAY EVENT] message.' }, 'SILENT');
      this.events.onTool?.(`${name}(${formatArgs(args)}) started`);
      void dispatchTool(this.bay, name, args, 'live', this.toolCtx).then((result) => {
        const line = `${name}(${formatArgs(args)}) ${result.ok ? 'succeeded' : 'failed'}: ${summarizeResult(name, result)}`;
        this.events.onTool?.(line);
        this.sendBayEvent(line);
      });
    }
  }

  private flushOutbox(force = false): void {
    if (!this.session || !this.outbox.length || this.talking) return;
    if (this.awaitingModel && !(force || this.now() - this.awaitSince >= this.eventWaitMs)) return;
    const text = this.outbox.join('\n');
    this.outbox = [];
    if (this.outboxTimer) clearTimeout(this.outboxTimer);
    this.outboxTimer = null;
    try {
      this.session.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true });
      this.expectModel();
      if (this.state === 'ready') this.setState('thinking');
    } catch (err) {
      logTo(this.sink, 'voice', `Could not send a bay event: ${errorText(err)}`);
    }
  }
}
