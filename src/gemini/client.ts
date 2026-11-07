// Gemini client: one request at a time, a timeout on every attempt, one retry on 5xx or a
// network error, Retry-After on 429, and a ledger entry (latency, tokens, cost) for every attempt.
//
// Local dev: VITE_GEMINI_API_KEY talks to Gemini directly. Otherwise every request goes through
// the server proxy (/api/gemini), which holds the key. Tests inject a fake with createGeminiClient.
// Nothing here touches window or document at import time.
import type { GeminiCallEntry } from '../contracts';
import { DEFAULT_LEVEL, FLASH, MAX_RETRY_AFTER_MS, MODEL_INFO, TIMEOUT_MS, costUsd, type Purpose, type ThinkingLevel } from './models';
import type { LogSink } from './types';

export interface FunctionCallPart {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

export interface Part {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: FunctionCallPart;
  functionResponse?: { id?: string; name?: string; response?: Record<string, unknown>; [k: string]: unknown };
  inlineData?: { mimeType?: string; data?: string };
  [key: string]: unknown;
}

export interface Content {
  role?: string;
  parts?: Part[];
}

export interface UsageLite {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  toolUsePromptTokenCount?: number;
  totalTokenCount?: number;
}

export interface RawResponse {
  candidates?: Array<{ content?: Content; finishReason?: string }>;
  usageMetadata?: UsageLite;
  promptFeedback?: { blockReason?: string };
}

export interface GenerateParams {
  model: string;
  contents: unknown;
  config?: Record<string, unknown>;
}

/** The slice of the SDK this client uses. A fake only needs `models.generateContent`. */
export interface GenAiLike {
  models: { generateContent(params: GenerateParams): Promise<RawResponse> };
}

export interface CallRequest {
  purpose: Purpose;
  model: string;
  /** thinking level; ignored for models that do not take one */
  level?: ThinkingLevel;
  contents: unknown;
  config?: Record<string, unknown>;
  signal?: AbortSignal;
  /** per-attempt timeout; defaults to TIMEOUT_MS[purpose] */
  timeoutMs?: number;
}

export interface CallResult {
  /** text parts of the first candidate, thoughts excluded */
  text: string;
  functionCalls: FunctionCallPart[];
  /** the model turn exactly as returned (keeps thought signatures for the next round) */
  content: Content;
  finishReason?: string;
  entry: GeminiCallEntry;
  raw: RawResponse;
}

export type CallFn = (req: CallRequest) => Promise<CallResult>;

export type GeminiErrorCode = 'TIMEOUT' | 'ABORTED' | 'HTTP' | 'NETWORK' | 'BLOCKED' | 'UNAVAILABLE';

export class GeminiError extends Error {
  readonly code: GeminiErrorCode;
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(code: GeminiErrorCode, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'GeminiError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ClientOptions {
  /** the SDK instance or a factory for it (called once, lazily) */
  genai?: GenAiLike | (() => GenAiLike | Promise<GenAiLike>);
  sink?: LogSink | null;
  /** monotonic ms clock for latency */
  now?: () => number;
  /** wall clock for entry.t */
  wallClock?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxRetryAfterMs?: number;
  /** wait before the single 5xx / network retry */
  retryDelayMs?: number;
}

const RECENT_MAX = 100;

export class GeminiClient {
  private tail: Promise<void> = Promise.resolve();
  private genaiPromise: Promise<GenAiLike> | null = null;
  private readonly listeners = new Set<(e: GeminiCallEntry) => void>();
  private readonly recentEntries: GeminiCallEntry[] = [];
  private sink: LogSink | null;
  private genaiSource: ClientOptions['genai'];
  private readonly now: () => number;
  private readonly wallClock: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly maxRetryAfterMs: number;
  private readonly retryDelayMs: number;
  /** Retry-After seen on the last HTTP response (set by the default SDK's fetch wrapper). */
  lastRetryAfterMs: number | null = null;
  /** requests waiting or running */
  pending = 0;

  constructor(opts: ClientOptions = {}) {
    this.genaiSource = opts.genai;
    this.sink = opts.sink ?? null;
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.wallClock = opts.wallClock ?? Date.now;
    this.sleep = opts.sleep ?? sleepMs;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS;
    this.retryDelayMs = opts.retryDelayMs ?? 800;
  }

  setSink(sink: LogSink | null): void {
    this.sink = sink;
  }

  /** Replace the SDK (tests, or switching between the dev key and the proxy). */
  setGenAi(genai: ClientOptions['genai']): void {
    this.genaiSource = genai;
    this.genaiPromise = null;
  }

  /** Subscribe to ledger entries. Returns the unsubscribe function. */
  onEntry(cb: (e: GeminiCallEntry) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** The last entries, oldest first. */
  recent(): readonly GeminiCallEntry[] {
    return this.recentEntries.slice();
  }

  /** Record an entry produced elsewhere (the Live session reports its turns here). */
  record(entry: GeminiCallEntry): void {
    this.recentEntries.push(entry);
    if (this.recentEntries.length > RECENT_MAX) this.recentEntries.splice(0, this.recentEntries.length - RECENT_MAX);
    try {
      this.sink?.ledger(entry);
    } catch {
      // the ledger is best effort
    }
    for (const cb of [...this.listeners]) {
      try {
        cb(entry);
      } catch {
        // a broken listener must not break the call
      }
    }
  }

  /** Queue one request. Requests run strictly one at a time, in order. */
  call(req: CallRequest): Promise<CallResult> {
    this.pending++;
    return new Promise<CallResult>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        this.pending--;
        fn();
      };
      const onAbort = () => finish(() => reject(new GeminiError('ABORTED', 'Gemini request cancelled')));
      if (req.signal?.aborted) {
        onAbort();
        return;
      }
      req.signal?.addEventListener('abort', onAbort, { once: true });
      const run = async (): Promise<void> => {
        req.signal?.removeEventListener('abort', onAbort);
        if (settled) return; // cancelled while queued: never reaches the model
        try {
          const result = await this.execute(req);
          finish(() => resolve(result));
        } catch (err) {
          finish(() => reject(err));
        }
      };
      this.tail = this.tail.then(run, run);
    });
  }

  private async getGenAi(): Promise<GenAiLike> {
    if (!this.genaiPromise) {
      const src = this.genaiSource;
      this.genaiPromise = Promise.resolve(typeof src === 'function' ? src() : src ?? createDefaultGenAi(this)).catch((err: unknown) => {
        this.genaiPromise = null;
        throw new GeminiError('UNAVAILABLE', `Gemini client could not start: ${errorText(err)}`);
      });
    }
    return this.genaiPromise;
  }

  private async execute(req: CallRequest): Promise<CallResult> {
    const genai = await this.getGenAi();
    const timeoutMs = req.timeoutMs ?? TIMEOUT_MS[req.purpose] ?? 30_000;
    const config = buildConfig(req);
    this.noteEgress(req);
    for (let attempt = 0; ; attempt++) {
      const t0 = this.now();
      this.lastRetryAfterMs = null;
      try {
        const raw = await this.attempt(genai, req, config, timeoutMs);
        return this.finishOk(req, raw, t0);
      } catch (caught) {
        const err = toGeminiError(caught, this.lastRetryAfterMs);
        const retry = attempt === 0 ? this.retryPlan(err) : null;
        this.record(this.failEntry(req, t0, retry === null ? err.message : `${err.message} (retrying)`));
        if (retry === null) {
          this.logFailure(req, err);
          throw err;
        }
        await this.sleep(retry, req.signal).catch(() => {
          throw new GeminiError('ABORTED', 'Gemini request cancelled');
        });
      }
    }
  }

  /** ms to wait before the single retry, or null for no retry. */
  private retryPlan(err: GeminiError): number | null {
    if (err.code === 'NETWORK') return this.retryDelayMs;
    if (err.code !== 'HTTP' || err.status === undefined) return null;
    if (err.status === 429) {
      const wait = err.retryAfterMs ?? 2_000;
      return wait <= this.maxRetryAfterMs ? Math.max(wait, 250) : null;
    }
    if (err.status >= 500) return this.retryDelayMs;
    return null;
  }

  private async attempt(genai: GenAiLike, req: CallRequest, config: Record<string, unknown>, timeoutMs: number): Promise<RawResponse> {
    if (req.signal?.aborted) throw new GeminiError('ABORTED', 'Gemini request cancelled');
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
    const onAbort = () => ac.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const stopped = new Promise<never>((_, reject) => {
        ac.signal.addEventListener(
          'abort',
          () =>
            reject(
              timedOut
                ? new GeminiError('TIMEOUT', `Gemini did not answer within ${Math.round(timeoutMs / 1000)} s`)
                : new GeminiError('ABORTED', 'Gemini request cancelled'),
            ),
          { once: true },
        );
      });
      const request = genai.models.generateContent({ model: req.model, contents: req.contents, config: { ...config, abortSignal: ac.signal } });
      request.catch(() => undefined); // a late rejection after a timeout is expected
      return await Promise.race([request, stopped]);
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  }

  private finishOk(req: CallRequest, raw: RawResponse, t0: number): CallResult {
    const latencyMs = Math.round(this.now() - t0);
    const usage = readUsage(raw);
    const cand = raw.candidates?.[0];
    const content: Content = cand?.content ? { ...cand.content, role: cand.content.role ?? 'model' } : { role: 'model', parts: [] };
    const parts = content.parts ?? [];
    const images = parts.filter((p) => typeof p.inlineData?.mimeType === 'string' && p.inlineData.mimeType.startsWith('image/')).length;
    const blocked = !cand && raw.promptFeedback?.blockReason;
    const entry: GeminiCallEntry = {
      t: this.wallClock(),
      model: req.model,
      purpose: req.purpose,
      latencyMs,
      promptTokens: usage.promptTokens,
      outputTokens: usage.outputTokens,
      thoughtTokens: usage.thoughtTokens,
      costUsd: costUsd(req.model, { ...usage, images }),
      ok: !blocked,
      ...(blocked ? { error: `blocked: ${raw.promptFeedback?.blockReason}` } : {}),
    };
    this.record(entry);
    if (blocked) throw new GeminiError('BLOCKED', `Gemini blocked the request (${raw.promptFeedback?.blockReason})`);
    return {
      text: parts
        .filter((p) => typeof p.text === 'string' && !p.thought)
        .map((p) => p.text)
        .join(''),
      functionCalls: parts.filter((p) => p.functionCall).map((p) => p.functionCall as FunctionCallPart),
      content,
      finishReason: cand?.finishReason,
      entry,
      raw,
    };
  }

  private failEntry(req: CallRequest, t0: number, error: string): GeminiCallEntry {
    return {
      t: this.wallClock(),
      model: req.model,
      purpose: req.purpose,
      latencyMs: Math.round(this.now() - t0),
      promptTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
      costUsd: 0,
      ok: false,
      error: error.slice(0, 240),
    };
  }

  private noteEgress(req: CallRequest): void {
    if (!this.sink?.egress) return;
    try {
      let imageBytes = 0;
      let images = 0;
      const text = JSON.stringify(req.contents, (key, value: unknown) => {
        if (key === 'inlineData' && value && typeof value === 'object') {
          const data = (value as { data?: unknown }).data;
          if (typeof data === 'string') {
            images++;
            imageBytes += Math.floor((data.length * 3) / 4);
          }
          return '[inline]';
        }
        return value;
      });
      this.sink.egress({
        dest: 'gemini',
        kind: images ? 'image' : 'text',
        bytes: imageBytes + (text?.length ?? 0),
        note: `${req.purpose}${images ? `, ${images} frame${images > 1 ? 's' : ''}` : ''}`,
      });
    } catch {
      // the counter is best effort
    }
  }

  private logFailure(req: CallRequest, err: GeminiError): void {
    if (err.code === 'ABORTED' || !this.sink) return;
    try {
      this.sink.log({ t: this.wallClock(), kind: 'gemini', text: `Gemini ${req.purpose} call failed: ${err.message.slice(0, 160)}` });
    } catch {
      // ignore
    }
  }
}

export function buildConfig(req: Pick<CallRequest, 'model' | 'level' | 'purpose' | 'config'>): Record<string, unknown> {
  const config: Record<string, unknown> = { ...(req.config ?? {}) };
  // Gemini 3.6 and later ignore temperature (and will reject it): never send it.
  delete config.temperature;
  delete config.abortSignal;
  const info = MODEL_INFO[req.model];
  const level = req.level ?? DEFAULT_LEVEL[req.purpose];
  if (info?.thinkingLevels && level) {
    const current = (config.thinkingConfig ?? {}) as Record<string, unknown>;
    config.thinkingConfig = { ...current, thinkingLevel: level };
  } else if (!info?.thinkingLevels && config.thinkingConfig) {
    const tc = { ...(config.thinkingConfig as Record<string, unknown>) };
    delete tc.thinkingLevel;
    if (Object.keys(tc).length) config.thinkingConfig = tc;
    else delete config.thinkingConfig;
  }
  return config;
}

function readUsage(raw: RawResponse): { promptTokens: number; outputTokens: number; thoughtTokens: number } {
  const u = raw.usageMetadata ?? {};
  return {
    promptTokens: (u.promptTokenCount ?? 0) + (u.toolUsePromptTokenCount ?? 0),
    outputTokens: u.candidatesTokenCount ?? 0,
    thoughtTokens: u.thoughtsTokenCount ?? 0,
  };
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** HTTP status of an SDK or proxy error, if it has one. */
export function statusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === 'number') return s;
  }
  return undefined;
}

/** Seconds or an HTTP date -> ms. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

function toGeminiError(err: unknown, headerRetryAfterMs: number | null): GeminiError {
  if (err instanceof GeminiError) return err;
  const message = errorText(err);
  const status = statusOf(err);
  if (status !== undefined) {
    let retryAfterMs: number | undefined;
    const own = (err as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof own === 'number') retryAfterMs = own;
    else if (headerRetryAfterMs !== null) retryAfterMs = headerRetryAfterMs;
    else {
      const m = message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
      if (m) retryAfterMs = Math.round(Number(m[1]) * 1000);
    }
    return new GeminiError('HTTP', `HTTP ${status}: ${shortApiMessage(message)}`, status, retryAfterMs);
  }
  if (err instanceof TypeError || /network|fetch failed|failed to fetch|ECONNRESET|ECONNREFUSED|socket hang up|ETIMEDOUT/i.test(message)) {
    return new GeminiError('NETWORK', `network error: ${message}`);
  }
  if (err instanceof Error && err.name === 'AbortError') return new GeminiError('ABORTED', 'Gemini request cancelled');
  return new GeminiError('HTTP', message);
}

/** The SDK puts the whole JSON error body in the message; keep the human part. */
function shortApiMessage(message: string): string {
  try {
    const parsed = JSON.parse(message) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message.slice(0, 200);
  } catch {
    // not JSON
  }
  return message.slice(0, 200);
}

export function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GeminiError('ABORTED', 'Gemini request cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new GeminiError('ABORTED', 'Gemini request cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Dev key, or the key-holding server proxy. Loaded on the first call only. */
async function createDefaultGenAi(client: GeminiClient): Promise<GenAiLike> {
  const { GoogleGenAI } = await import('@google/genai/web');
  const devKey = (import.meta.env?.VITE_GEMINI_API_KEY as string | undefined) || '';
  const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await fetch(input, init);
    client.lastRetryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    return res;
  };
  if (devKey) {
    return new GoogleGenAI({ apiKey: devKey, httpOptions: { fetch: wrappedFetch } }) as unknown as GenAiLike;
  }
  // The proxy replaces this placeholder with the real key; the SDK only needs it to be non-empty.
  return new GoogleGenAI({
    apiKey: 'server-proxy',
    httpOptions: { baseUrl: `${globalThis.location.origin}/api/gemini`, fetch: wrappedFetch },
  }) as unknown as GenAiLike;
}

/** True when the browser talks to Gemini directly with a local dev key. */
export function usingDevKey(): boolean {
  return !!(import.meta.env?.VITE_GEMINI_API_KEY as string | undefined);
}

export function createGeminiClient(opts: ClientOptions = {}): GeminiClient {
  return new GeminiClient(opts);
}

let defaultClient: GeminiClient | null = null;

/** The app-wide client (created on first use). */
export function getGeminiClient(): GeminiClient {
  return (defaultClient ??= new GeminiClient());
}

/** Wire the app-wide client: the log/ledger sink and, for tests or demos, a fake SDK. */
export function configureGemini(opts: { sink?: LogSink | null; genai?: ClientOptions['genai'] }): GeminiClient {
  const client = getGeminiClient();
  if (opts.sink !== undefined) client.setSink(opts.sink);
  if (opts.genai !== undefined) client.setGenAi(opts.genai);
  return client;
}

/** One Gemini request through the app-wide queue. */
export const callGemini: CallFn = (req) => getGeminiClient().call(req);

// ---- JSON generation for the fabricator -----------------------------------------------------

export interface GenerateJsonArgs {
  system: string;
  prompt: string;
  schema: object;
  signal?: AbortSignal;
}

export type GenerateJsonFn = (a: GenerateJsonArgs) => Promise<{ text: string; latencyMs: number }>;

/** A 400 caused by the response schema (the API names the field in its message). */
export function isSchemaError(err: unknown): boolean {
  return statusOf(err) === 400 && /schema/i.test(errorText(err));
}

/**
 * Flash with a JSON schema, thinking LOW, purpose 'design'. On a 400 that names the schema it
 * retries once without the schema (the prompt still asks for JSON). latencyMs covers both tries.
 */
export function createGenerateJson(call: CallFn, model: string = FLASH): GenerateJsonFn {
  return async ({ system, prompt, schema, signal }) => {
    const t0 = Date.now();
    const base = {
      purpose: 'design' as const,
      model,
      level: 'LOW' as const,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      signal,
    };
    const systemInstruction = { parts: [{ text: system }] };
    try {
      const res = await call({ ...base, config: { systemInstruction, responseMimeType: 'application/json', responseJsonSchema: schema } });
      return { text: res.text, latencyMs: Date.now() - t0 };
    } catch (err) {
      if (!isSchemaError(err)) throw err;
      const res = await call({ ...base, config: { systemInstruction, responseMimeType: 'application/json' } });
      return { text: res.text, latencyMs: Date.now() - t0 };
    }
  };
}


/** The fabricator's designer call, through the app-wide queue and ledger. */
export const generateJson: GenerateJsonFn = createGenerateJson(callGemini);
