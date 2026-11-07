// Gemini client: lazy singleton, concurrency-1 queue for ER/Flash calls, timeouts, retry policy,
// ledger entries on the telemetry bus. Never touches window/document at import time (vitest runs in node).

import { GoogleGenAI, ThinkingLevel } from '@google/genai/web';
import type { Content, GenerateContentConfig, GenerateContentResponse } from '@google/genai/web';
import type { GeminiCallEntry } from '../contracts';
import { bus } from '../telemetry/bus';
import { costUsd, ER_MODEL, TIMEOUT_MS, type Level } from './models';

let ai: GoogleGenAI | null = null;

/** Lazy: the SDK is constructed on first use, from VITE_GEMINI_API_KEY (inlined by Vite; never deploy dist/). */
export function getAI(): GoogleGenAI {
  if (!ai) {
    const key = import.meta.env.VITE_GEMINI_API_KEY as string | undefined;
    if (!key) throw new Error('VITE_GEMINI_API_KEY is missing (copy .env.example to .env.local)');
    ai = new GoogleGenAI({ apiKey: key });
  }
  return ai;
}

export interface CallOpts {
  purpose: GeminiCallEntry['purpose'];
  level: Level;
  contents: Content[] | string;
  /** Ask for thought summaries (parts with thought: true) so the planner can narrate its plan. */
  includeThoughts?: boolean;
  config?: Omit<GenerateContentConfig, 'thinkingConfig' | 'abortSignal'>;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CallResult {
  res: GenerateContentResponse;
  entry: GeminiCallEntry;
  text: string;
  latencyMs: number;
}

export class GeminiError extends Error {
  constructor(message: string, public status: number | undefined, public entry: GeminiCallEntry) { super(message); }
}

const LEVEL: Record<Level, ThinkingLevel> = { LOW: ThinkingLevel.LOW, MEDIUM: ThinkingLevel.MEDIUM, HIGH: ThinkingLevel.HIGH };

type Generate = (params: { model: string; contents: Content[] | string; config: GenerateContentConfig }) => Promise<GenerateContentResponse>;
let generateImpl: Generate | null = null;
/** Tests inject a fake generateContent here; production uses the SDK. */
export function setGenerateForTests(fn: Generate | null): void { generateImpl = fn; }

const generate: Generate = (params) => (generateImpl ?? ((p) => getAI().models.generateContent(p)))(params);

// Concurrency-1 queue: ER calls never overlap (RPM and ordering).
let tail: Promise<unknown> = Promise.resolve();
export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}

function statusOf(e: unknown): number | undefined {
  const anyE = e as { status?: unknown; code?: unknown; message?: unknown };
  if (typeof anyE?.status === 'number') return anyE.status;
  if (typeof anyE?.code === 'number') return anyE.code;
  const m = /\b(4\d\d|5\d\d)\b/.exec(String(anyE?.message ?? ''));
  return m ? Number(m[1]) : undefined;
}

function retryAfterMs(e: unknown): number {
  const m = /retry[- ]?after[^0-9]*(\d+(?:\.\d+)?)\s*(ms|s)?/i.exec(String((e as Error)?.message ?? ''));
  if (!m) return 4000;
  const v = Number(m[1]);
  return m[2] === 'ms' ? v : Math.min(v * 1000, 20_000);
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
});

/**
 * One Gemini generateContent call through the queue. Retry: one retry after 2 s on network/5xx;
 * on 429 wait Retry-After (or 4 s) once. Never switches model. Emits a ledger entry (red on failure).
 */
export function callER(opts: CallOpts): Promise<CallResult> {
  return enqueue(() => callNow(opts));
}

async function callNow(opts: CallOpts): Promise<CallResult> {
  const model = opts.model ?? ER_MODEL;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS[opts.level];
  let attempt = 0;
  for (;;) {
    attempt++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`timeout ${timeoutMs} ms`)), timeoutMs);
    const onAbort = () => ctrl.abort(opts.signal?.reason ?? new Error('aborted'));
    if (opts.signal?.aborted) onAbort(); else opts.signal?.addEventListener('abort', onAbort, { once: true });
    const t0 = performance.now();
    try {
      const res = await generate({ model, contents: opts.contents, config: { ...(opts.config ?? {}), thinkingConfig: { thinkingLevel: LEVEL[opts.level], ...(opts.includeThoughts ? { includeThoughts: true } : {}) }, abortSignal: ctrl.signal } });
      const latencyMs = Math.round(performance.now() - t0);
      const u = res.usageMetadata;
      const promptTokens = u?.promptTokenCount ?? 0, outputTokens = u?.candidatesTokenCount ?? 0, thoughtTokens = u?.thoughtsTokenCount ?? 0;
      const entry: GeminiCallEntry = { t: Date.now(), model, purpose: opts.purpose, thinkingLevel: opts.level, latencyMs, promptTokens, outputTokens, thoughtTokens,
        costUsd: costUsd(model, promptTokens, outputTokens, thoughtTokens), ok: true };
      bus.emit(undefined, entry);
      let text = '';
      try { text = res.text ?? ''; } catch { text = ''; }
      return { res, entry, text, latencyMs };
    } catch (e) {
      const latencyMs = Math.round(performance.now() - t0);
      const status = statusOf(e);
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      const aborted = opts.signal?.aborted === true;
      const timedOut = !aborted && ctrl.signal.aborted;
      const retriable = !aborted && !timedOut && attempt === 1 && (status === undefined || status === 429 || status >= 500);
      if (retriable) {
        const wait = status === 429 ? retryAfterMs(e) : 2000;
        bus.emit({ kind: 'reject', text: `ER ${opts.purpose} ${status ?? 'network'} — retrying in ${(wait / 1000).toFixed(1)} s` });
        try { await sleep(wait, opts.signal); } catch { /* aborted while waiting */ }
        if (!opts.signal?.aborted) continue;
      }
      const entry: GeminiCallEntry = { t: Date.now(), model, purpose: opts.purpose, thinkingLevel: opts.level, latencyMs, promptTokens: 0, outputTokens: 0, thoughtTokens: 0, costUsd: 0, ok: false,
        error: timedOut ? `timeout ${timeoutMs} ms` : aborted ? 'aborted' : `${status ?? ''} ${msg}`.trim() };
      bus.emit({ kind: 'reject', text: `ER ${opts.purpose} ${opts.level} FAILED ${entry.error}` }, entry);
      throw new GeminiError(entry.error!, status, entry);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}

/** Strip ``` fences (with or without a language tag) around a JSON payload. */
export function stripFences(s: string): string {
  return s.trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
}

/** Parse JSON leniently: fence-strip, then fall back to the first {...} or [...] span. */
export function parseJson<T>(s: string): T {
  const body = stripFences(s);
  try { return JSON.parse(body) as T; } catch { /* fall through */ }
  const start = Math.min(...['{', '['].map((c) => body.indexOf(c)).filter((i) => i >= 0));
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (Number.isFinite(start) && end > start) return JSON.parse(body.slice(start, end + 1)) as T;
  throw new Error(`not JSON: ${body.slice(0, 80)}`);
}
