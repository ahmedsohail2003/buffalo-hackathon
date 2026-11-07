import { describe, expect, it } from 'vitest';
import { ElevenSpeaker, cleanForSpeech, splitSentences } from './elevenSpeaker';
import { Downsampler, base64ToBytes, bytesToBase64, floatToPcm16, pcm16leToFloat32 } from './pcm';

type Ev = ['start', number, number] | ['tone', number, number] | ['stop'];

/** Minimal WebAudio double: records what gets scheduled, never makes a sound. */
function fakeAudio() {
  const events: Ev[] = [];
  class Node0 {
    connect<T>(n: T): T {
      return n;
    }
    disconnect(): void {}
  }
  class Src extends Node0 {
    buffer: { duration: number } | null = null;
    onended: (() => void) | null = null;
    start(at: number) {
      events.push(['start', +at.toFixed(4), +(this.buffer?.duration ?? 0).toFixed(4)]);
    }
    stop() {
      events.push(['stop']);
    }
  }
  class Osc extends Node0 {
    frequency = { value: 0 };
    onended: (() => void) | null = null;
    start(at: number) {
      events.push(['tone', this.frequency.value, +at.toFixed(4)]);
    }
    stop() {}
  }
  class Ctx {
    currentTime = 0;
    state = 'running';
    destination = new Node0();
    createGain() {
      return Object.assign(new Node0(), { gain: { value: 1 } });
    }
    createBiquadFilter() {
      return Object.assign(new Node0(), { type: '', frequency: { value: 0 } });
    }
    createWaveShaper() {
      return Object.assign(new Node0(), { curve: null as Float32Array | null });
    }
    createOscillator() {
      return new Osc();
    }
    createBufferSource() {
      return new Src();
    }
    createBuffer(_ch: number, len: number, rate: number) {
      const d = new Float32Array(len);
      return { duration: len / rate, length: len, getChannelData: () => d };
    }
    resume() {
      return Promise.resolve();
    }
  }
  return { events, createContext: () => new Ctx() as unknown as AudioContext };
}

interface Req {
  text: string;
  voice: string;
  previous_text: string;
  signal: AbortSignal;
}

/** /api/tts double: answers each sentence with `ms` of PCM in odd-sized chunks. */
function fakeTts(opts: { ms?: number; chunkDelayMs?: number; status?: number } = {}) {
  const requests: Req[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Omit<Req, 'signal'>;
    requests.push({ ...body, signal: init.signal as AbortSignal });
    if (opts.status) return new Response(JSON.stringify({ error: 'elevenlabs_unconfigured', message: 'no key' }), { status: opts.status });
    const bytes = Math.round(((opts.ms ?? 100) / 1000) * 24000) * 2;
    const sizes = [4801, 3999, 8193, 7001];
    let sent = 0;
    let k = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (init.signal?.aborted) return ctrl.error(new DOMException('aborted', 'AbortError'));
        if (sent >= bytes) return ctrl.close();
        if (opts.chunkDelayMs) await new Promise((r) => setTimeout(r, opts.chunkDelayMs));
        const n = Math.min(sizes[k++ % sizes.length], bytes - sent);
        sent += n;
        ctrl.enqueue(new Uint8Array(n).fill(16));
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'audio/pcm;rate=24000' } });
  }) as unknown as typeof fetch;
  return { requests, fetchFn };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 2));
  }
};

describe('sentence chunking', () => {
  it('cuts complete sentences, keeps decimals whole, and splits run-ons at a space', () => {
    expect(splitSentences('Copy, Flight. Moving the red block to the tray now. Stand')).toEqual({
      sentences: ['Copy, Flight.', 'Moving the red block to the tray now.'],
      rest: 'Stand',
    });
    expect(splitSentences('Grip is 32.5 mm wide')).toEqual({ sentences: [], rest: 'Grip is 32.5 mm wide' });
    const runOn = 'word '.repeat(40);
    const r = splitSentences(runOn);
    expect(r.sentences).toHaveLength(1);
    expect(r.sentences[0].length).toBeLessThanOrEqual(140);
    expect(r.sentences[0].length + 1 + r.rest.length).toBe(runOn.length);
    expect(cleanForSpeech('**Copy** that, `s1` # ok')).toBe('Copy that, s1 ok');
  });
});

describe('ElevenLabs speaker', () => {
  it('streams deltas sentence by sentence, in order, gaplessly, between Quindar tones', async () => {
    const audio = fakeAudio();
    const tts = fakeTts({ ms: 100 });
    const sp = new ElevenSpeaker({ fetch: tts.fetchFn, createContext: audio.createContext, idleFlushMs: 5, endFlushMs: 5 });
    sp.push('Copy, Flight. Moving the red ');
    sp.push('block to the tray now. Stand');
    sp.push('ing by');
    sp.end();
    await until(() => audio.events.filter((e) => e[0] === 'tone').length === 2);

    expect(tts.requests.map((r) => r.text)).toEqual(['Copy, Flight.', 'Moving the red block to the tray now.', 'Standing by']);
    expect(tts.requests.every((r) => r.voice === 'coworker')).toBe(true);
    expect(tts.requests[2].previous_text).toBe(' Copy, Flight. Moving the red block to the tray now.');

    const tones = audio.events.filter((e) => e[0] === 'tone').map((e) => e[1]);
    expect(tones).toEqual([2525, 2475]);
    expect(audio.events[0][0]).toBe('tone'); // the open tone comes before any speech

    // every buffer starts where the previous one ended: no gaps, no overlaps
    const timeline = audio.events.filter((e): e is ['start', number, number] | ['tone', number, number] => e[0] !== 'stop');
    let cursor = 0;
    let speech = 0;
    for (const e of timeline) {
      const at = e[0] === 'tone' ? e[2] : e[1];
      const dur = e[0] === 'tone' ? 0.25 : e[2];
      if (cursor) expect(at).toBeCloseTo(cursor, 3);
      cursor = at + dur;
      if (e[0] === 'start') speech += dur;
    }
    expect(speech).toBeCloseTo(0.3, 3); // three sentences of 100 ms
  });

  it('cancel() aborts the request in flight and schedules nothing more; the next line starts clean', async () => {
    const audio = fakeAudio();
    const tts = fakeTts({ ms: 2000, chunkDelayMs: 15 });
    const sp = new ElevenSpeaker({ fetch: tts.fetchFn, createContext: audio.createContext, idleFlushMs: 5, endFlushMs: 5 });
    sp.say('This is a long transmission that the operator will interrupt.');
    await until(() => audio.events.some((e) => e[0] === 'start'));
    sp.cancel();
    expect(tts.requests[0].signal.aborted).toBe(true);
    expect(audio.events.some((e) => e[0] === 'stop')).toBe(true);
    const mark = audio.events.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(audio.events.slice(mark).filter((e) => e[0] === 'start')).toEqual([]);

    sp.say('Bay stopped. Standing by.', 'mission');
    await until(() => tts.requests.length === 3);
    expect(tts.requests.slice(1).map((r) => [r.text, r.voice])).toEqual([
      ['Bay stopped.', 'mission'],
      ['Standing by.', 'mission'],
    ]);
    await until(() => audio.events.slice(mark).some((e) => e[0] === 'tone' && e[1] === 2525));
  });

  it('a configuration error marks the speaker broken (callers fall back) and stops further requests', async () => {
    const audio = fakeAudio();
    const tts = fakeTts({ status: 503 });
    const errors: string[] = [];
    const sp = new ElevenSpeaker({ fetch: tts.fetchFn, createContext: audio.createContext, idleFlushMs: 5, endFlushMs: 5, onError: (m) => errors.push(m) });
    sp.say('Radio check.');
    await until(() => sp.broken);
    expect(errors[0]).toBe('ElevenLabs speech failed (HTTP 503): no key');
    sp.say('Anyone there?');
    await new Promise((r) => setTimeout(r, 20));
    expect(tts.requests).toHaveLength(1);

    const quiet = new ElevenSpeaker({ fetch: tts.fetchFn, createContext: audio.createContext });
    quiet.setMuted(true);
    quiet.say('Muted line.');
    await new Promise((r) => setTimeout(r, 20));
    expect(tts.requests).toHaveLength(1);
  });
});

describe('PCM helpers', () => {
  it('decodes s16le with an odd carry byte, round-trips base64, and downsamples 48 kHz to 16 kHz', () => {
    const pcm = new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0xff]);
    const a = pcm16leToFloat32(pcm);
    expect(Array.from(a.samples)).toEqual([0.5, -0.5]);
    expect(a.carry).toEqual(new Uint8Array([0xff]));
    const b = pcm16leToFloat32(new Uint8Array([0x7f]), a.carry);
    expect(b.samples[0]).toBeCloseTo(32767 / 32768, 6);

    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(Array.from(floatToPcm16(new Float32Array([1, -1, 0])))).toEqual([32767, -32768, 0]);

    const ds = new Downsampler(48000, 16000);
    const ramp = Float32Array.from({ length: 4800 }, (_, i) => (i % 3 === 1 ? 0.3 : 0.3));
    const first = ds.push(ramp.subarray(0, 1000));
    const second = ds.push(ramp.subarray(1000));
    expect(first.length + second.length).toBe(1600);
    expect(second[10]).toBeCloseTo(0.3, 6);
  });
});
