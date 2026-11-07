// PCM helpers shared by the ElevenLabs speaker, Live's native audio and the microphone.
// Nothing touches window or AudioContext until a method is called.

export const TTS_RATE = 24_000;
export const MIC_RATE = 16_000;

/** s16le bytes -> float samples. An odd trailing byte is carried into the next chunk. */
export function pcm16leToFloat32(bytes: Uint8Array, carry: Uint8Array | null = null): { samples: Float32Array; carry: Uint8Array | null } {
  let b = bytes;
  if (carry?.length) {
    const joined = new Uint8Array(carry.length + bytes.length);
    joined.set(carry);
    joined.set(bytes, carry.length);
    b = joined;
  }
  let nextCarry: Uint8Array | null = null;
  if (b.length & 1) {
    nextCarry = b.slice(b.length - 1);
    b = b.subarray(0, b.length - 1);
  }
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = new Float32Array(b.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
  return { samples: out, carry: nextCarry };
}

export function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Streaming box-filter decimator, for example 48 kHz microphone audio -> 16 kHz. */
export class Downsampler {
  private buf = new Float32Array(0);
  private pos = 0;
  constructor(
    readonly inRate: number,
    readonly outRate: number = MIC_RATE,
  ) {}

  push(chunk: Float32Array): Float32Array {
    if (this.inRate === this.outRate) return chunk.slice();
    const data = new Float32Array(this.buf.length + chunk.length);
    data.set(this.buf);
    data.set(chunk, this.buf.length);
    const ratio = this.inRate / this.outRate;
    const out: number[] = [];
    let p = this.pos;
    while (p + ratio <= data.length) {
      const start = Math.floor(p);
      const end = Math.max(start + 1, Math.floor(p + ratio));
      let sum = 0;
      for (let i = start; i < end; i++) sum += data[i];
      out.push(sum / (end - start));
      p += ratio;
    }
    const keep = Math.floor(p);
    this.buf = data.slice(keep);
    this.pos = p - keep;
    return Float32Array.from(out);
  }
}

export interface ChannelOptions {
  rate?: number;
  /** band-pass and soft clip: a mission-control radio */
  radio?: boolean;
  gain?: number;
  createContext?: () => AudioContext;
}

/**
 * One gapless output channel: PCM chunks and tones are scheduled back to back on a cursor, so
 * streamed audio plays without gaps. stop() silences everything at once (barge-in, E-STOP).
 */
export class AudioChannel {
  private ctx: AudioContext | null = null;
  private input: AudioNode | null = null;
  private out: GainNode | null = null;
  private next = 0;
  private readonly sources = new Set<AudioScheduledSourceNode>();
  private readonly rate: number;
  private readonly radio: boolean;
  private readonly gain: number;
  private readonly createContext: () => AudioContext;
  private muted = false;
  onState: ((playing: boolean) => void) | null = null;

  constructor(opts: ChannelOptions = {}) {
    this.rate = opts.rate ?? TTS_RATE;
    this.radio = opts.radio ?? true;
    this.gain = opts.gain ?? 0.9;
    this.createContext = opts.createContext ?? (() => new AudioContext({ sampleRate: this.rate }));
  }

  /** The context, created on first use. Call resume() from a click (autoplay policy). */
  context(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = this.createContext();
    const out = ctx.createGain();
    out.gain.value = this.muted ? 0 : this.gain;
    out.connect(ctx.destination);
    let input: AudioNode = out;
    if (this.radio) {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 350;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 3400;
      const shaper = ctx.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / 1023) * 2 - 1;
        curve[i] = Math.tanh(2.5 * x) / Math.tanh(2.5);
      }
      shaper.curve = curve;
      hp.connect(lp).connect(shaper).connect(out);
      input = hp;
    }
    this.ctx = ctx;
    this.out = out;
    this.input = input;
    return ctx;
  }

  async resume(): Promise<void> {
    const ctx = this.context();
    if (ctx.state === 'suspended') await ctx.resume();
  }

  get playing(): boolean {
    return this.sources.size > 0;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.out) this.out.gain.value = m ? 0 : this.gain;
  }

  /** Schedule mono samples right after whatever is already queued. */
  play(samples: Float32Array): void {
    if (!samples.length) return;
    const ctx = this.context();
    const buf = ctx.createBuffer(1, samples.length, this.rate);
    buf.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.input as AudioNode);
    this.start(src, buf.duration);
  }

  /** A sine tone on the same cursor (Quindar tones), bypassing the radio filter. */
  tone(hz: number, seconds: number, level = 0.08): void {
    const ctx = this.context();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = hz;
    g.gain.value = level;
    osc.connect(g).connect(this.out as AudioNode);
    this.start(osc, seconds, true);
  }

  stop(): void {
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        // already ended
      }
    }
    const had = this.sources.size > 0;
    this.sources.clear();
    this.next = 0;
    if (had) this.onState?.(false);
  }

  private start(src: AudioScheduledSourceNode, duration: number, timed = false): void {
    const ctx = this.ctx as AudioContext;
    const at = Math.max(ctx.currentTime + 0.04, this.next);
    src.start(at);
    if (timed) src.stop(at + duration);
    this.next = at + duration;
    const wasIdle = this.sources.size === 0;
    this.sources.add(src);
    if (wasIdle) this.onState?.(true);
    src.onended = () => {
      this.sources.delete(src);
      if (!this.sources.size) this.onState?.(false);
    };
  }
}

