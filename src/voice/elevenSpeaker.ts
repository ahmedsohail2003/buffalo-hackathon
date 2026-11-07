// ElevenLabs voice: Gemini decides what to say, this speaks it. Text arrives as deltas (Live's
// output transcription) or whole replies; each finished sentence becomes one POST /api/tts, whose
// raw s16le 24 kHz stream plays gaplessly through a mission-control radio chain between Quindar
// tones. cancel() is barge-in: it aborts the request in flight and silences playback at once.
// The server maps 'mission' and 'coworker' to voice ids; the browser never sees a key.
import { AudioChannel, TTS_RATE, pcm16leToFloat32 } from './pcm';

export type VoiceName = 'mission' | 'coworker';

/** What the Live session, the coworker panel and the announcer need from a speaker. */
export interface SpeakerLike {
  push(delta: string, voice?: VoiceName): void;
  end(): void;
  say(text: string, voice?: VoiceName): void;
  cancel(): void;
  setMuted(m: boolean): void;
  resume(): Promise<void>;
  readonly muted: boolean;
  readonly speaking: boolean;
  /** true after a configuration error (no key, bad key): callers fall back to Gemini audio */
  readonly broken: boolean;
}

export interface SpeakerOptions {
  url?: string;
  fetch?: typeof fetch;
  createContext?: () => AudioContext;
  radio?: boolean;
  quindar?: boolean;
  /** a pause this long in the delta stream flushes the partial sentence */
  idleFlushMs?: number;
  /** wait after end() for trailing transcription */
  endFlushMs?: number;
  onError?: (message: string) => void;
  /** characters sent to ElevenLabs, for the egress counter */
  onEgress?: (chars: number) => void;
}

export interface SentenceSplit {
  sentences: string[];
  rest: string;
}

/** Complete sentences out of a growing buffer. A run-on is cut at a space so audio starts early. */
export function splitSentences(buffer: string): SentenceSplit {
  const sentences: string[] = [];
  let rest = buffer;
  let m: RegExpMatchArray | null;
  while ((m = rest.match(/^(.*?[.!?])\s+/s))) {
    const s = m[1].trim();
    if (s) sentences.push(s);
    rest = rest.slice(m[0].length);
  }
  if (rest.length > 160) {
    const cut = rest.lastIndexOf(' ', 140);
    if (cut > 40) {
      sentences.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut + 1);
    }
  }
  return { sentences, rest };
}

/** Markdown and symbols a voice should not read out. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const QUINDAR_OPEN = 2525;
const QUINDAR_CLOSE = 2475;
const BROKEN_STATUSES = new Set([401, 402, 403, 404, 502, 503]);

export class ElevenSpeaker implements SpeakerLike {
  private readonly channel: AudioChannel;
  private readonly url: string;
  private readonly fetchFn: typeof fetch;
  private readonly quindar: boolean;
  private readonly idleFlushMs: number;
  private readonly endFlushMs: number;
  private pending = '';
  private pendingVoice: VoiceName = 'coworker';
  private queue: Array<{ text: string; voice: VoiceName }> = [];
  private pumping = false;
  private gen = 0;
  private ac: AbortController | null = null;
  private readonly prev: Record<VoiceName, string> = { mission: '', coworker: '' };
  private idle: ReturnType<typeof setTimeout> | undefined;
  private inTx = false;
  private endTx = false;
  private isMuted = false;
  private isBroken = false;
  onState: ((speaking: boolean) => void) | null = null;
  /** settable later: the shared speaker may be created before the app wires its log */
  onError: ((message: string) => void) | undefined;
  onEgress: ((chars: number) => void) | undefined;

  constructor(opts: SpeakerOptions = {}) {
    this.url = opts.url ?? '/api/tts';
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.quindar = opts.quindar ?? true;
    this.idleFlushMs = opts.idleFlushMs ?? 400;
    this.endFlushMs = opts.endFlushMs ?? 250;
    this.onError = opts.onError;
    this.onEgress = opts.onEgress;
    this.channel = new AudioChannel({ rate: TTS_RATE, radio: opts.radio ?? true, createContext: opts.createContext });
    this.channel.onState = (playing) => this.onState?.(playing);
  }

  /** Call inside a click (autoplay policy). */
  resume(): Promise<void> {
    return this.channel.resume();
  }

  get speaking(): boolean {
    return this.channel.playing || this.queue.length > 0 || this.pumping;
  }

  get muted(): boolean {
    return this.isMuted;
  }

  get broken(): boolean {
    return this.isBroken;
  }

  /** Clear the broken flag (for example after the server health check passes again). */
  repair(): void {
    this.isBroken = false;
  }

  setMuted(m: boolean): void {
    this.isMuted = m;
    if (m) this.cancel();
  }

  /** Text delta from the model. Complete sentences go out at once; a pause flushes the rest. */
  push(delta: string, voice: VoiceName = 'coworker'): void {
    if (this.isMuted || this.isBroken || !delta) return;
    if (voice !== this.pendingVoice && this.pending.trim()) this.flushPending();
    this.pendingVoice = voice;
    const { sentences, rest } = splitSentences(this.pending + delta);
    this.pending = rest;
    for (const s of sentences) this.enqueue(s, voice);
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.flush(this.endTx), this.idleFlushMs);
  }

  /** The model's turn is over. Transcription can trail the turn, so wait briefly, then close. */
  end(): void {
    this.endTx = true;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.flush(true), this.endFlushMs);
  }

  /** A whole reply at once (typed coworker, announcer callouts). */
  say(text: string, voice: VoiceName = 'mission'): void {
    if (this.isMuted || this.isBroken) return;
    this.push(`${text} `, voice);
    this.end();
  }

  /** Barge-in: drop queued text, abort the request, silence now. */
  cancel(): void {
    this.gen++;
    clearTimeout(this.idle);
    this.pending = '';
    this.queue = [];
    this.endTx = false;
    this.inTx = false;
    this.ac?.abort();
    this.ac = null;
    this.channel.stop();
  }

  private flushPending(): void {
    const t = this.pending;
    this.pending = '';
    this.enqueue(t, this.pendingVoice);
  }

  private flush(end: boolean): void {
    clearTimeout(this.idle);
    this.flushPending();
    if (end) this.endTx = true;
    void this.pump();
  }

  private enqueue(text: string, voice: VoiceName): void {
    const t = cleanForSpeech(text);
    if (!t) return;
    this.queue.push({ text: t, voice });
    void this.pump();
  }

  /** One request at a time keeps sentences in order; generation outruns playback, so no gaps. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    const g = this.gen;
    try {
      while (this.queue.length && g === this.gen) {
        const item = this.queue.shift() as { text: string; voice: VoiceName };
        await this.stream(item.text, item.voice, g);
      }
      if (g === this.gen && this.endTx && this.inTx && !this.pending && !this.queue.length) {
        if (this.quindar) this.channel.tone(QUINDAR_CLOSE, 0.25);
        this.inTx = false;
        this.endTx = false;
      }
    } finally {
      this.pumping = false;
    }
    if (this.queue.length && !this.isBroken) void this.pump(); // text that arrived after a cancel
  }

  private async stream(text: string, voice: VoiceName, g: number): Promise<void> {
    const ac = new AbortController();
    this.ac = ac;
    let res: Response;
    try {
      this.onEgress?.(text.length);
      res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice, previous_text: this.prev[voice] }),
        signal: ac.signal,
      });
    } catch {
      if (!ac.signal.aborted) this.onError?.('Voice link lost: the speech server is unreachable.');
      return;
    }
    if (!res.ok || !res.body) {
      let detail = '';
      try {
        const j = (await res.json()) as { error?: string; message?: string };
        detail = j.message ?? j.error ?? '';
      } catch {
        // not JSON
      }
      if (BROKEN_STATUSES.has(res.status)) {
        this.isBroken = true;
        this.queue = [];
        this.pending = '';
      }
      this.onError?.(`ElevenLabs speech failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
      return;
    }
    if (g !== this.gen) {
      void res.body.cancel().catch(() => undefined);
      return;
    }
    this.prev[voice] = `${this.prev[voice]} ${text}`.slice(-300);
    if (!this.inTx) {
      this.inTx = true;
      if (this.quindar) this.channel.tone(QUINDAR_OPEN, 0.25);
    }
    const reader = res.body.getReader();
    let carry: Uint8Array | null = null;
    let parts: Float32Array[] = [];
    let len = 0;
    const flushParts = () => {
      if (!len) return;
      const joined = new Float32Array(len);
      let o = 0;
      for (const p of parts) {
        joined.set(p, o);
        o += p.length;
      }
      this.channel.play(joined);
      parts = [];
      len = 0;
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || g !== this.gen) break;
        const decoded = pcm16leToFloat32(value, carry);
        carry = decoded.carry;
        parts.push(decoded.samples);
        len += decoded.samples.length;
        if (len >= 2400) flushParts(); // about 100 ms per buffer
      }
      if (g === this.gen) flushParts();
    } catch {
      // aborted mid-stream
    } finally {
      if (g !== this.gen) void reader.cancel().catch(() => undefined);
    }
  }
}

let shared: ElevenSpeaker | null = null;

/** One speaker for Live, the typed coworker and the announcer, so voices never overlap. */
export function getSpeaker(opts?: SpeakerOptions): ElevenSpeaker {
  return (shared ??= new ElevenSpeaker(opts));
}
