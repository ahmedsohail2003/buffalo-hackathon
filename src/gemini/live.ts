// Live voice: hold TALK to speak to CAPCOM. Gemini Live hears the operator (16 kHz PCM, manual
// activity start/end), runs the same bay tools, and answers. With ElevenLabs available, Live's
// own audio is not played: its output transcription is spoken by the ElevenLabs speaker sentence
// by sentence. Otherwise Live's 24 kHz audio plays directly.
//
// Long tools run NON_BLOCKING: the tool call is answered at once ("started") and the real result
// goes back as a "[BAY EVENT] ..." message when it lands. Connect only from a click. The browser
// gets a single-use token from the server (or uses the dev key locally); a goAway renews the link
// and resumes the session. Each connect attempt holds a token: a Disconnect (or a newer attempt)
// wins every race, the loser releases what it started and changes no state, and events from an
// old socket are dropped. A socket the server closes before setup fails at once, with its reason.
//
// The operator's turn opens (activityStart) only when the microphone first hears speech, with a
// short pre-roll in front, so TALK held through silence sends the model nothing. Pressing TALK
// again inside the release tail continues the same turn.
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
  'You cannot start the bay either. While it is IDLE, moving tools are refused: ask the operator to start the cycle (Victory sign or CYCLE START) and wait for a [BAY EVENT] saying the bay is RUNNING. Never retry a move because the bay changed state.',
  'Use sample ids from describe_bay. If a request is ambiguous, ask one short question.',
  'After a pick or a place you may use check_bay once to confirm on camera. If the camera and the registry disagree, trust the registry.',
].join('\n');

export type LiveOutput = 'elevenlabs' | 'native';
/** 'working': a long tool call is still running (the state detail names the tool). */
export type LiveState = 'off' | 'connecting' | 'ready' | 'listening' | 'thinking' | 'speaking' | 'working' | 'error';

/** Shown when TALK was held but nothing reached the speech threshold. */
export const NOTHING_HEARD = 'Nothing heard. Hold TALK and speak.';

/** RMS level of a PCM16 chunk in dBFS (-Infinity for digital silence). */
export function levelDbfs(pcm: Int16Array): number {
  if (!pcm.length) return -Infinity;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  const rms = Math.sqrt(sum / pcm.length) / 32768;
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

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

/** Opens one socket and resolves after setup. `signal` aborts when the attempt is abandoned. */
export type LiveConnector = (config: Record<string, unknown>, callbacks: LiveCallbacksLite, signal?: AbortSignal) => Promise<LiveSessionLike>;

/** A voice-link failure whose message is already a plain sentence for the operator. */
export class LiveLinkError extends Error {
  readonly code: string;
  readonly retryAfterS: number | undefined;
  constructor(message: string, code: string, retryAfterS?: number) {
    super(message);
    this.name = 'LiveLinkError';
    this.code = code;
    this.retryAfterS = retryAfterS;
  }
}

/** The panel text for a failure: plain sentences as they are, anything else after a prefix. */
function failureText(err: unknown, prefix: string): string {
  return err instanceof LiveLinkError ? err.message : `${prefix}: ${errorText(err)}`;
}

/** "Quota exceeded for this model." -> "quota exceeded for this model" (acronyms keep their case). */
function clause(text: string): string {
  const t = text.trim().replace(/[.!\s]+$/, '');
  return /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
}

/** The sentence for a socket the server closed before setup finished. */
export function refusalText(e: { code?: number; reason?: string } | undefined): string {
  const why = e?.reason ? clause(e.reason) : '';
  const code = typeof e?.code === 'number' ? ` (${e.code})` : '';
  return `Voice link refused: ${why || 'the server closed the link'}${code}.`;
}

function closeQuietly(session: LiveSessionLike | null | undefined): void {
  try {
    session?.close();
  } catch {
    // already closed
  }
}

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
export async function fetchLiveToken(
  config: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
  url = '/api/gemini/live-token',
  signal?: AbortSignal,
): Promise<LiveToken> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: LIVE, config }),
    ...(signal ? { signal } : {}),
  });
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

/** Dev key directly, else a server-minted token. An abandoned attempt mints or keeps nothing. */
export function defaultConnector(): LiveConnector {
  return async (config, callbacks, signal) => {
    const sdk = await import('@google/genai/web');
    const devKey = (import.meta.env?.VITE_GEMINI_API_KEY as string | undefined) || '';
    let ai: InstanceType<typeof sdk.GoogleGenAI>;
    if (devKey) {
      ai = new sdk.GoogleGenAI({ apiKey: devKey });
    } else {
      const token = await fetchLiveToken(config, fetch, undefined, signal);
      ai = new sdk.GoogleGenAI({ apiKey: token.name, httpOptions: { apiVersion: token.apiVersion } });
    }
    if (signal?.aborted) throw new Error('voice link abandoned');
    const session = (await ai.live.connect({
      model: LIVE,
      config: config as unknown as Parameters<typeof ai.live.connect>[0]['config'],
      callbacks: callbacks as unknown as Parameters<typeof ai.live.connect>[0]['callbacks'],
    })) as unknown as LiveSessionLike;
    if (signal?.aborted) {
      closeQuietly(session);
      throw new Error('voice link abandoned');
    }
    return session;
  };
}

/** Browser microphone: getUserMedia -> AudioWorklet (ScriptProcessor fallback) -> 16 kHz PCM16, 40 ms frames. */
export class BrowserMic implements MicLike {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private frame = new Float32Array(640);
  private fill = 0;
  /** bumped by stop(): a start() still waiting on the browser then gives its stream back */
  private run = 0;

  async start(onChunk: (pcm16: Int16Array) => void): Promise<void> {
    if (this.stream) return;
    const run = ++this.run;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (run !== this.run) {
      stream.getTracks().forEach((t) => t.stop()); // stopped while the browser was asking
      return;
    }
    this.stream = stream;
    try {
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
        if (run !== this.run) return; // stopped meanwhile: stop() released the stream and the context
        const node = new AudioWorkletNode(ctx, 'starhand-mic-tap');
        node.port.onmessage = (e: MessageEvent<Float32Array>) => handle(e.data);
        src.connect(node).connect(silent);
      } else {
        const sp = ctx.createScriptProcessor(2048, 1, 1);
        sp.onaudioprocess = (e) => handle(e.inputBuffer.getChannelData(0).slice(0));
        src.connect(sp).connect(silent);
      }
      if (ctx.state === 'suspended') await ctx.resume();
    } catch (err) {
      if (run === this.run) this.stop(); // a half-built capture must not keep the microphone
      throw err;
    }
  }

  stop(): void {
    this.run++;
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
  /** a socket not set up after this long fails the attempt (ms) */
  openTimeoutMs?: number;
  /** while TALK is held, the first microphone chunk this loud (RMS dBFS) opens the operator's turn */
  speechDbfs?: number;
  /** audio from just before that chunk sent in front of it, so the first syllable is kept (ms) */
  prerollMs?: number;
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
  private readonly tools: ToolContext;
  private readonly speaker: SpeakerLike | null;
  private readonly connector: LiveConnector;
  private readonly mic: MicLike;
  private readonly player: PlayerLike;
  private readonly configOptions: Omit<LiveConfigOptions, 'handle'>;
  private readonly tailMs: number;
  private readonly maxReconnects: number;
  private readonly eventWaitMs: number;
  private readonly openTimeoutMs: number;
  private readonly speechDbfs: number;
  private readonly prerollSamples: number;
  private readonly now: () => number;
  private readonly recordEntry: (e: GeminiCallEntry) => void;
  private output: LiveOutput;
  private session: LiveSessionLike | null = null;
  /** bumped by every connect() and disconnect(): work from an older value is stale */
  private attempt = 0;
  /** bumped by every socket and by disconnect(): callbacks from an older socket are dropped */
  private generation = 0;
  /** the socket being opened; aborted when a disconnect or a newer socket supersedes it */
  private opening: AbortController | null = null;
  private handle: string | null = null;
  /** TALK is held */
  private talking = false;
  /** the operator's turn: 'pending' until speech is heard, 'open' once activityStart went out */
  private activity: 'none' | 'pending' | 'open' = 'none';
  private preroll: Int16Array[] = [];
  private prerollLen = 0;
  /** the release tail; pressing TALK again before it fires continues the same turn */
  private tailTimer: ReturnType<typeof setTimeout> | null = null;
  private tailUntil = 0;
  private awaitingModel = false;
  private awaitSince = 0;
  private outbox: string[] = [];
  private outboxTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;
  private renewing = false;
  private reconnects = 0;
  private muted = false;
  /** long (NON_BLOCKING) tool calls still running: call number -> tool name */
  private readonly running = new Map<number, string>();
  private calls = 0;
  private turnStart = 0;
  /** the first server message that answers the turn: audio, words, a tool call or the turn's end */
  private firstReplyAt = 0;
  private turnUsage: LiveMessageLite['usageMetadata'] | null = null;

  constructor(opts: LiveVoiceOptions) {
    this.bay = opts.bay;
    this.sink = opts.sink ?? opts.tools?.sink ?? null;
    this.tools = opts.tools ?? {};
    this.speaker = opts.speaker ?? null;
    this.output = opts.output ?? (opts.speaker ? 'elevenlabs' : 'native');
    this.connector = opts.connector ?? defaultConnector();
    this.mic = opts.mic ?? new BrowserMic();
    this.player = opts.player ?? new AudioChannel({ rate: TTS_RATE, radio: true });
    this.configOptions = opts.configOptions ?? {};
    this.tailMs = opts.tailMs ?? 160;
    this.maxReconnects = opts.maxReconnects ?? 2;
    this.eventWaitMs = opts.eventWaitMs ?? 15_000;
    this.openTimeoutMs = opts.openTimeoutMs ?? 12_000;
    this.speechDbfs = opts.speechDbfs ?? -45;
    this.prerollSamples = Math.round(((opts.prerollMs ?? 300) * MIC_RATE) / 1000);
    this.now = opts.now ?? Date.now;
    this.recordEntry = opts.recordEntry ?? ((e) => getGeminiClient().record(e));
  }

  get connected(): boolean {
    return this.session !== null;
  }

  get outputMode(): LiveOutput {
    return this.output;
  }

  /**
   * Open the voice link. Call from a click: it unlocks audio and asks for the microphone. While a
   * link is up or on its way, a second call does nothing, so a double click opens one link.
   */
  async connect(): Promise<void> {
    if (this.state !== 'off' && this.state !== 'error') return;
    const token = ++this.attempt;
    const stale = () => token !== this.attempt;
    this.closing = false;
    this.reconnects = 0;
    this.setState('connecting');
    const unlock = Promise.all([this.player.resume(), this.speaker?.resume()]).catch(() => undefined);
    try {
      await this.mic.start((pcm) => this.onMic(pcm));
    } catch (err) {
      if (!stale()) this.setState('error', `Microphone unavailable: ${errorText(err)}`);
      return;
    }
    if (stale()) return this.abandon();
    await unlock;
    if (stale()) return this.abandon();
    try {
      if (!(await this.open())) return this.abandon();
    } catch (err) {
      if (stale()) return this.abandon();
      this.mic.stop();
      this.session = null;
      const text = failureText(err, 'Voice link failed');
      this.setState('error', text);
      logTo(this.sink, 'voice', text);
      return;
    }
    this.setState('ready');
    logTo(this.sink, 'voice', 'Voice link up. Hold TALK to speak to CAPCOM.');
  }

  disconnect(): void {
    this.attempt++;
    this.generation++;
    this.closing = true;
    this.opening?.abort();
    this.opening = null;
    this.talking = false;
    this.endActivity();
    this.mic.stop();
    closeQuietly(this.session);
    this.session = null;
    this.speaker?.cancel();
    this.player.stop();
    this.outbox = [];
    if (this.outboxTimer) clearTimeout(this.outboxTimer);
    this.outboxTimer = null;
    this.awaitingModel = false;
    this.running.clear();
    this.turnStart = 0;
    this.firstReplyAt = 0;
    this.turnUsage = null;
    this.setState('off');
  }

  /**
   * TALK pressed: barge in on CAPCOM and start the operator's turn. activityStart waits for the
   * first chunk of speech. Pressed again inside the release tail, the same turn simply goes on.
   */
  startTalk(): void {
    if (!this.session || this.talking) return;
    this.speaker?.cancel();
    this.player.stop();
    this.talking = true;
    if (this.tailTimer) {
      clearTimeout(this.tailTimer);
      this.tailTimer = null;
      this.tailUntil = 0;
    } else {
      this.activity = 'pending';
      this.preroll = [];
      this.prerollLen = 0;
    }
    this.setState('listening');
  }

  /** TALK released: send the audio tail, then close the operator's turn (or drop it if nothing was heard). */
  endTalk(): void {
    if (!this.talking) return;
    this.talking = false;
    this.tailUntil = this.now() + this.tailMs;
    if (this.tailTimer) clearTimeout(this.tailTimer);
    this.tailTimer = null;
    if (this.tailMs > 0) this.tailTimer = setTimeout(() => this.finishTalk(), this.tailMs);
    else this.finishTalk();
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

  /** Read at each call, so wiring that arrives later (the fabricator) is used. */
  private toolCtx(): ToolContext {
    return { ...this.tools, ...(this.sink ? { sink: this.sink } : {}) };
  }

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
    this.firstReplyAt = 0;
  }

  /** The release tail is over: close the operator's turn, or drop it when nothing was heard. */
  private finishTalk(): void {
    this.tailTimer = null;
    if (this.talking) return; // pressed again: still the same turn
    const session = this.session;
    const opened = this.activity === 'open';
    this.endActivity();
    if (!session) return; // the link dropped meanwhile; a renewal settles the state
    if (opened) {
      session.sendRealtimeInput({ activityEnd: {} });
      this.expectModel();
      this.setState('thinking');
      return;
    }
    // TALK held through silence: the model gets nothing (empty audio makes it invent speech).
    this.rest(NOTHING_HEARD);
    logTo(this.sink, 'voice', NOTHING_HEARD);
    this.flushOutbox();
  }

  /** Between turns: 'working' (with the tool's name) while a long tool runs, else 'ready'. */
  private rest(detail?: string): void {
    let tool: string | undefined;
    for (const name of this.running.values()) tool = name; // the newest call still running
    if (tool) this.setState('working', tool);
    else this.setState('ready', detail);
  }

  /** Forget the operator's turn: no tail, no pre-roll. */
  private endActivity(): void {
    if (this.tailTimer) clearTimeout(this.tailTimer);
    this.tailTimer = null;
    this.tailUntil = 0;
    this.activity = 'none';
    this.preroll = [];
    this.prerollLen = 0;
  }

  /** TALK is held, or its release tail is still running. */
  private operatorTurn(): boolean {
    return this.talking || this.tailTimer !== null;
  }

  /** A connect attempt that lost a race changes no state; it lets go of the microphone only if no link wants it. */
  private abandon(): void {
    if (this.state === 'off' || this.state === 'error') this.mic.stop();
  }

  /**
   * Open one socket. Resolves true once it is set up and installed, false when a disconnect or a
   * newer socket superseded it (a socket that still arrives is closed). Rejects when the server
   * closes it or it errors before setup, or when it is not set up within openTimeoutMs.
   */
  private open(): Promise<boolean> {
    const gen = ++this.generation;
    this.opening?.abort();
    const ac = new AbortController();
    this.opening = ac;
    const config = buildLiveConfig({ ...this.configOptions, handle: this.handle });
    return new Promise<boolean>((resolve, reject) => {
      let done = false;
      let installed = false;
      const finish = (ok: boolean, err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ac.signal.removeEventListener('abort', superseded);
        if (this.opening === ac) this.opening = null;
        if (err) {
          ac.abort(); // the connector gives up on its side too
          reject(err);
        } else resolve(ok);
      };
      const superseded = () => finish(false);
      ac.signal.addEventListener('abort', superseded);
      const timer = setTimeout(
        () => finish(false, new LiveLinkError(`Voice link timed out: the voice server did not answer within ${Math.round(this.openTimeoutMs / 1000)} s.`, 'timeout')),
        this.openTimeoutMs,
      );
      const callbacks: LiveCallbacksLite = {
        onmessage: (m) => {
          // messages queued during setup arrive just before the connector resolves
          if (gen === this.generation && (installed || !done)) this.onMessage(m);
        },
        onerror: (e) => {
          if (!done) finish(false, new LiveLinkError('Voice link failed: could not reach the voice server.', 'socket_error'));
          else if (installed && gen === this.generation) logTo(this.sink, 'voice', `Voice link error: ${e?.message || 'unknown error'}`);
        },
        onclose: (e) => {
          // Closed before setup (quota, a used token, a config the server refuses): a refusal, not a renewal.
          if (!done) finish(false, new LiveLinkError(refusalText(e), 'refused'));
          else if (installed && gen === this.generation) this.onClose(e);
        },
      };
      this.connector(config, callbacks, ac.signal).then(
        (session) => {
          if (done || gen !== this.generation) {
            closeQuietly(session); // superseded, refused or timed out meanwhile
            finish(false);
            return;
          }
          installed = true;
          this.session = session;
          if (this.activity === 'open') session.sendRealtimeInput({ activityStart: {} }); // renewed mid-turn
          finish(true);
        },
        (err: unknown) => finish(false, err instanceof Error ? err : new Error(String(err))),
      );
    });
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
    this.endActivity();
    this.mic.stop();
    this.setState('error', `Voice link closed (${why}).`);
    logTo(this.sink, 'voice', `Voice link closed (${why}). Press Connect voice to retry.`);
  }

  private async renew(reason: string): Promise<void> {
    if (this.renewing || this.closing) return;
    this.renewing = true;
    this.reconnects++;
    const token = this.attempt;
    const old = this.session;
    logTo(this.sink, 'voice', `Voice link renewing: ${reason}.`);
    try {
      if (!(await this.open())) return; // superseded: whoever did it owns the state now
      if (old !== this.session) closeQuietly(old);
      logTo(this.sink, 'voice', `Voice link renewed${this.handle ? ', context resumed' : ', fresh context'}.`);
      this.awaitingModel = false;
      if (!this.operatorTurn()) this.rest();
      this.flushOutbox();
    } catch (err) {
      if (token !== this.attempt) return;
      closeQuietly(old);
      this.session = null;
      this.talking = false;
      this.endActivity();
      this.mic.stop();
      const text = failureText(err, 'Voice link lost');
      this.setState('error', text);
      logTo(this.sink, 'voice', `${text} Press Connect voice to retry.`);
    } finally {
      this.renewing = false;
    }
  }

  private onMic(pcm: Int16Array): void {
    const session = this.session;
    if (!session) return;
    if (this.activity === 'open') {
      if (this.talking || this.now() < this.tailUntil) this.sendAudio(session, pcm);
      return;
    }
    if (this.activity !== 'pending' || !this.talking) return;
    if (levelDbfs(pcm) < this.speechDbfs) {
      this.keepPreroll(pcm);
      return;
    }
    // The first speech: open the operator's turn with the pre-roll in front of it.
    this.activity = 'open';
    session.sendRealtimeInput({ activityStart: {} });
    for (const chunk of this.preroll) this.sendAudio(session, chunk);
    this.preroll = [];
    this.prerollLen = 0;
    this.sendAudio(session, pcm);
  }

  private sendAudio(session: LiveSessionLike, pcm: Int16Array): void {
    session.sendRealtimeInput({
      audio: { data: bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)), mimeType: `audio/pcm;rate=${MIC_RATE}` },
    });
  }

  /** Keep the newest prerollMs of quiet audio (whole chunks, at least that much). */
  private keepPreroll(pcm: Int16Array): void {
    this.preroll.push(pcm.slice());
    this.prerollLen += pcm.length;
    while (this.preroll.length > 1 && this.prerollLen - this.preroll[0].length >= this.prerollSamples) {
      this.prerollLen -= (this.preroll.shift() as Int16Array).length;
    }
  }

  private markOutput(): void {
    if (!this.operatorTurn() && this.state !== 'speaking') this.setState('speaking');
  }

  private onMessage(m: LiveMessageLite): void {
    const sc = m.serverContent;
    // Latency runs to the first message that answers the turn, so a tool-only turn is timed too
    // (the operator's own transcription does not count).
    if (this.turnStart && !this.firstReplyAt && (m.toolCall?.functionCalls?.length || sc?.modelTurn || sc?.outputTranscription || sc?.generationComplete || sc?.turnComplete)) {
      this.firstReplyAt = this.now();
    }
    const upd = m.sessionResumptionUpdate;
    if (upd?.resumable && upd.newHandle) this.handle = upd.newHandle;
    if (m.usageMetadata) this.turnUsage = m.usageMetadata;

    if (sc) {
      if (sc.interrupted) {
        this.speaker?.cancel();
        this.player.stop();
      }
      const heard = sc.inputTranscription?.text;
      if (heard) this.events.onTranscript?.('operator', heard);
      // CAPCOM is not heard over the operator: while TALK is held its audio is dropped.
      const said = sc.outputTranscription?.text;
      if (said) {
        this.markOutput();
        this.events.onTranscript?.('capcom', said);
        if (this.useEleven() && !this.talking) this.speaker?.push(said, 'coworker');
      }
      for (const p of sc.modelTurn?.parts ?? []) {
        const d = p.inlineData;
        if (!d?.data || !/^audio\//.test(d.mimeType ?? 'audio/pcm')) continue;
        this.markOutput();
        if (!this.useEleven() && !this.muted && !this.talking) this.player.play(pcm16leToFloat32(base64ToBytes(d.data)).samples);
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
    if (u || this.firstReplyAt) {
      this.recordEntry({
        t: Date.now(),
        model: LIVE,
        purpose: 'live',
        latencyMs: this.turnStart && this.firstReplyAt ? Math.max(0, Math.round(this.firstReplyAt - this.turnStart)) : 0,
        promptTokens: u?.promptTokenCount ?? 0,
        outputTokens: u?.responseTokenCount ?? 0,
        thoughtTokens: u?.thoughtsTokenCount ?? 0,
        costUsd: 0,
        ok: true,
      });
    }
    this.turnStart = 0;
    this.firstReplyAt = 0;
    this.events.onTurnEnd?.();
    if (!this.operatorTurn()) this.rest();
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
    const epoch = this.attempt; // a result for a link that was disconnected meanwhile is dropped
    for (const fc of calls) {
      const name = fc.name ?? '';
      const args = fc.args ?? {};
      const nonBlocking = KNOWN_TOOLS.has(name) && !INSTANT_TOOLS.has(name);
      if (!nonBlocking || gateRefusal(this.bay, name)) {
        // Instant answers (and refusals) go straight back; a refusal is spoken when CAPCOM is idle.
        const result = await dispatchTool(this.bay, name, args, 'live', this.toolCtx());
        if (epoch !== this.attempt) return;
        this.events.onTool?.(`${name} -> ${summarizeResult(name, result)}`);
        this.respond(fc.id, name, result, nonBlocking ? 'WHEN_IDLE' : undefined);
        continue;
      }
      this.respond(fc.id, name, { ok: true, status: 'started', note: 'Running now. The result follows as a [BAY EVENT] message.' }, 'SILENT');
      this.events.onTool?.(`${name}(${formatArgs(args)}) started`);
      // Until its result turn the state reads 'working', even after CAPCOM's own turn ends.
      const call = ++this.calls;
      this.running.set(call, name);
      if (this.state === 'ready') this.rest();
      // An emergency stop cancels the call in flight (a design then places nothing).
      const ac = new AbortController();
      const offGate = this.bay.gate.onChange((s) => {
        if (s === 'ESTOPPED') ac.abort();
      });
      void dispatchTool(this.bay, name, args, 'live', { ...this.toolCtx(), signal: ac.signal }).then((result) => {
        offGate();
        if (epoch !== this.attempt) return;
        this.running.delete(call);
        const line = `${name}(${formatArgs(args)}) ${result.ok ? 'succeeded' : 'failed'}: ${summarizeResult(name, result)}`;
        this.events.onTool?.(line);
        this.sendBayEvent(line); // when it goes out at once, the state turns 'thinking'
        if (this.state === 'working') this.rest(); // held back (no link yet): show what still runs
      });
    }
  }

  private flushOutbox(force = false): void {
    if (!this.session || !this.outbox.length || this.operatorTurn()) return;
    if (this.awaitingModel && !(force || this.now() - this.awaitSince >= this.eventWaitMs)) return;
    const text = this.outbox.join('\n');
    this.outbox = [];
    if (this.outboxTimer) clearTimeout(this.outboxTimer);
    this.outboxTimer = null;
    try {
      this.session.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true });
      this.expectModel();
      if (this.state === 'ready' || this.state === 'working') this.setState('thinking');
    } catch (err) {
      logTo(this.sink, 'voice', `Could not send a bay event: ${errorText(err)}`);
    }
  }
}
