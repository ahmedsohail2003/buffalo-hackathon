// Counts what leaves this machine (bay-camera frames, prompt text, speech text), so the top bar
// can say it plainly. Webcam video is processed on the device and never counted here because it
// never leaves. Callers: the Gemini client and the voice layer, once per request.

export type EgressKind = 'image' | 'text' | 'audio';

export interface EgressRecord {
  /** Date.now() ms */
  t: number;
  /** service the bytes went to, for example 'gemini' or 'elevenlabs' */
  dest: string;
  kind: EgressKind;
  bytes: number;
  note?: string;
}

export interface EgressSnapshot {
  requests: number;
  bytes: number;
  images: number;
  imageBytes: number;
  textBytes: number;
  audioBytes: number;
  byDest: Record<string, { requests: number; bytes: number }>;
  last: EgressRecord | null;
}

function empty(): EgressSnapshot {
  return { requests: 0, bytes: 0, images: 0, imageBytes: 0, textBytes: 0, audioBytes: 0, byDest: {}, last: null };
}

let snap: EgressSnapshot = empty();
const listeners = new Set<(s: EgressSnapshot) => void>();

/** Record one outbound payload. */
export function recordEgress(input: Omit<EgressRecord, 't'> & { t?: number }): void {
  const rec: EgressRecord = { ...input, t: input.t ?? Date.now(), bytes: Math.max(0, Math.round(input.bytes || 0)) };
  const byDest = { ...snap.byDest };
  const d = byDest[rec.dest] ?? { requests: 0, bytes: 0 };
  byDest[rec.dest] = { requests: d.requests + 1, bytes: d.bytes + rec.bytes };
  snap = {
    requests: snap.requests + 1,
    bytes: snap.bytes + rec.bytes,
    images: snap.images + (rec.kind === 'image' ? 1 : 0),
    imageBytes: snap.imageBytes + (rec.kind === 'image' ? rec.bytes : 0),
    textBytes: snap.textBytes + (rec.kind === 'text' ? rec.bytes : 0),
    audioBytes: snap.audioBytes + (rec.kind === 'audio' ? rec.bytes : 0),
    byDest,
    last: rec,
  };
  for (const cb of [...listeners]) {
    try {
      cb(snap);
    } catch (err) {
      console.error('[egress] listener failed', err);
    }
  }
}

/** The running totals. The object is replaced (never mutated) on each record. */
export function egressSnapshot(): EgressSnapshot {
  return snap;
}

export function onEgress(cb: (s: EgressSnapshot) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Tests only. */
export function resetEgress(): void {
  snap = empty();
  listeners.clear();
}

/** UTF-8 size of a string, for text payloads. */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Decoded size of a base64 payload (for example a bay-camera JPEG). */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} kB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

/** One short line for the top-bar badge, for example "2 bay frames · 3.1 kB text". */
export function egressSummary(s: EgressSnapshot): string {
  if (s.requests === 0) return 'nothing yet';
  const parts: string[] = [];
  if (s.images > 0) parts.push(`${s.images} bay frame${s.images === 1 ? '' : 's'} (${formatBytes(s.imageBytes)})`);
  if (s.textBytes > 0) parts.push(`${formatBytes(s.textBytes)} text`);
  if (s.audioBytes > 0) parts.push(`${formatBytes(s.audioBytes)} audio`);
  return parts.join(' · ') || `${s.requests} request${s.requests === 1 ? '' : 's'}`;
}
