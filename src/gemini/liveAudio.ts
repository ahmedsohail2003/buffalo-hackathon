// Microphone capture (16 kHz PCM16 LE base64 chunks, only while held) and 24 kHz PCM16 playback.
// Both AudioContexts are created in the Connect click handler (autoplay policy). No AudioWorklet (ScriptProcessorNode).

export function f32ToPcm16B64(f32: Float32Array): string {
  const out = new Uint8Array(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    let v = Math.max(-1, Math.min(1, f32[i]));
    v = v < 0 ? v * 0x8000 : v * 0x7fff;
    const s = Math.round(v) & 0xffff;
    out[2 * i] = s & 0xff; out[2 * i + 1] = (s >> 8) & 0xff;
  }
  let bin = '';
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(out.subarray(i, i + 0x8000)));
  return btoa(bin);
}

export function pcm16B64ToF32(b64: string): Float32Array<ArrayBuffer> {
  const bin = atob(b64); const n = bin.length >> 1; const f32 = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 0x8000) v -= 0x10000; f32[i] = v / 32768; }
  return f32;
}

export class MicCapture {
  private held = false;
  private constructor(private ctx: AudioContext, private stream: MediaStream, private processor: ScriptProcessorNode, private src: MediaStreamAudioSourceNode, private sink: GainNode) {}

  static async create(onChunk: (b64: string) => void): Promise<MicCapture> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const ctx = new AudioContext({ sampleRate: 16000 });
    await ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const sink = ctx.createGain(); sink.gain.value = 0; // ScriptProcessor needs a destination; keep it silent
    const mic = new MicCapture(ctx, stream, processor, src, sink);
    processor.onaudioprocess = (e) => { if (!mic.held) return; onChunk(f32ToPcm16B64(e.inputBuffer.getChannelData(0))); };
    src.connect(processor); processor.connect(sink); sink.connect(ctx.destination);
    return mic;
  }
  get sampleRate(): number { return this.ctx.sampleRate; }
  setHeld(held: boolean): void { this.held = held; }
  isHeld(): boolean { return this.held; }
  close(): void {
    this.held = false;
    try { this.processor.disconnect(); this.src.disconnect(); this.sink.disconnect(); } catch { /* already */ }
    for (const t of this.stream.getTracks()) t.stop();
    void this.ctx.close();
  }
}

export class Playback {
  private ctx: AudioContext;
  private nextStart = 0;
  private sources = new Set<AudioBufferSourceNode>();
  onIdle: (() => void) | null = null;
  constructor() { this.ctx = new AudioContext({ sampleRate: 24000 }); }
  async resume(): Promise<void> { await this.ctx.resume(); }
  /** Schedule a 24 kHz PCM16 chunk right after the previous one. */
  play(b64: string): void {
    const f32 = pcm16B64ToF32(b64);
    if (!f32.length) return;
    const buf = this.ctx.createBuffer(1, f32.length, 24000);
    buf.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.connect(this.ctx.destination);
    const at = Math.max(this.ctx.currentTime + 0.02, this.nextStart);
    src.start(at); this.nextStart = at + buf.duration;
    this.sources.add(src);
    src.onended = () => { this.sources.delete(src); if (!this.sources.size) this.onIdle?.(); };
  }
  /** Barge-in / interrupted: stop everything and reset the schedule. */
  stop(): void {
    for (const s of this.sources) { try { s.onended = null; s.stop(); } catch { /* ended */ } }
    this.sources.clear(); this.nextStart = 0;
  }
  get speaking(): boolean { return this.sources.size > 0; }
  /** Loopback test helper: play raw 16 kHz capture back (resampled by the graph). */
  playRaw16k(b64: string): void {
    const f32 = pcm16B64ToF32(b64);
    const buf = this.ctx.createBuffer(1, f32.length, 16000); buf.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.connect(this.ctx.destination); src.start();
  }
  close(): void { this.stop(); void this.ctx.close(); }
}
