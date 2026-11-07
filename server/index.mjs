// STARHAND server. Node 22, no dependencies of its own (the app's pinned @google/genai is loaded
// only to mint Live tokens). It serves dist/, proxies ElevenLabs text-to-speech and the Gemini
// REST API with the keys it holds, and mints single-use Live tokens. Keys never reach the
// browser and are never logged.
//
//   PORT=8787 GEMINI_API_KEY=... ELEVENLABS_API_KEY=... node server/index.mjs
//
// Routes:
//   GET  /api/health                     { ok, gemini, elevenlabs, live }
//   POST /api/tts                        { text, previous_text?, voice?: 'mission'|'coworker' } -> PCM s16le 24 kHz stream
//   POST /api/gemini/{ver}/models/{model}:{generateContent|streamGenerateContent|countTokens}
//   POST /api/gemini/live-token          { model, config } -> { name, apiVersion, expireTime }
//   GET  /*                              dist/ with SPA fallback
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Models the HTTP proxy forwards. Live is not here: it uses a WebSocket with a minted token. */
export const GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-robotics-er-2-preview', 'gemini-3.1-flash-lite-image'];
export const LIVE_MODEL = 'gemini-3.8-live';
/** A premade ElevenLabs voice, used until ELEVENLABS_VOICE_MISSION holds a designed one. */
const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';

export function loadConfig(env = process.env) {
  const list = (v) =>
    String(v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const int = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
  };
  const mission = env.ELEVENLABS_VOICE_MISSION || DEFAULT_VOICE;
  return {
    port: int(env.PORT, 8787),
    host: env.HOST || '0.0.0.0',
    dist: resolve(env.DIST_DIR || join(ROOT, 'dist')),
    trustProxy: env.TRUST_PROXY === '1',
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    logRequests: env.LOG_REQUESTS !== '0',
    gemini: {
      key: env.GEMINI_API_KEY || '',
      base: (env.GEMINI_BASE || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
      models: list(env.GEMINI_MODELS).length ? list(env.GEMINI_MODELS) : GEMINI_MODELS,
      liveModel: env.GEMINI_LIVE_MODEL || LIVE_MODEL,
      tokenApiVersion: env.GEMINI_TOKEN_API_VERSION || 'v1alpha',
      liveApiVersion: env.GEMINI_LIVE_API_VERSION || 'v1alpha',
      storeFalse: env.GEMINI_STORE_FALSE === '1',
    },
    el: {
      key: env.ELEVENLABS_API_KEY || '',
      base: (env.ELEVENLABS_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, ''),
      model: env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',
      voices: { mission, coworker: env.ELEVENLABS_VOICE_COWORKER || mission },
    },
    /** requests per IP per minute */
    limits: { tts: int(env.RATE_TTS, 90), gemini: int(env.RATE_GEMINI, 40), token: int(env.RATE_LIVE_TOKEN, 10) },
    /** request body caps, bytes */
    caps: { tts: 8 * 1024, gemini: int(env.GEMINI_BODY_CAP, 8 * 1024 * 1024), token: 64 * 1024 },
  };
}

// ---- helpers --------------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, body, extra = {}) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const s = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(s),
    ...extra,
  });
  res.end(s);
}

function sendText(res, status, text) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req, cap) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > cap) throw new HttpError(413, 'body_too_large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) throw new HttpError(413, 'body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, cap) {
  const buf = await readBody(req, cap);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new HttpError(400, 'bad_json');
  }
}

/** Fixed one-minute window per key. Returns seconds to wait, or 0 when allowed. */
export function makeLimiter(perMinute, now = Date.now) {
  const hits = new Map();
  return (key) => {
    const t = now();
    let h = hits.get(key);
    if (!h || t - h.start >= 60_000) {
      if (hits.size > 5000) for (const [k, v] of hits) if (t - v.start >= 60_000) hits.delete(k);
      h = { start: t, count: 0 };
      hits.set(key, h);
    }
    h.count++;
    return h.count > perMinute ? Math.max(1, Math.ceil((h.start + 60_000 - t) / 1000)) : 0;
  };
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/** Resolves when the response can take more data, or when the client has gone. */
function drained(res) {
  return new Promise((done) => {
    const finish = () => {
      res.off('drain', finish);
      res.off('close', finish);
      done();
    };
    res.on('drain', finish);
    res.on('close', finish);
  });
}

/** Pipe a fetch body to the response chunk by chunk (PCM and SSE must not be buffered). */
async function pump(body, res) {
  try {
    for await (const chunk of body) {
      if (res.destroyed) break;
      if (!res.write(chunk)) await drained(res);
    }
  } catch {
    // upstream aborted (client went away) or failed mid-stream
  }
  res.end();
}

/** Abort the upstream request if the client disconnects before the response is complete. */
function abortOnClose(res) {
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });
  return ac;
}

function redactor(cfg) {
  const secrets = [cfg.gemini.key, cfg.el.key].filter((k) => k && k.length >= 8);
  return (text) => {
    let out = String(text ?? '');
    for (const k of secrets) out = out.split(k).join('[redacted]');
    return out.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]');
  };
}

// ---- /api/tts -------------------------------------------------------------------------------

async function handleTts(req, res, cfg, ctx) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
  if (!cfg.el.key) {
    return sendJson(res, 503, { error: 'elevenlabs_unconfigured', message: 'ElevenLabs is not configured on this server (ELEVENLABS_API_KEY is empty).' });
  }
  const wait = ctx.limit.tts(ctx.ip);
  if (wait) return sendJson(res, 429, { error: 'rate_limited', retry_after_s: wait }, { 'retry-after': String(wait) });
  const body = await readJson(req, cfg.caps.tts);
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 600) : '';
  if (!text) return sendJson(res, 400, { error: 'text_required' });
  const voice = body.voice === 'coworker' ? 'coworker' : 'mission';
  const previous = typeof body.previous_text === 'string' ? body.previous_text.slice(-300) : '';

  const ac = abortOnClose(res);
  let up;
  try {
    up = await fetch(`${cfg.el.base}/v1/text-to-speech/${encodeURIComponent(cfg.el.voices[voice])}/stream?output_format=pcm_24000`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'xi-api-key': cfg.el.key, 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: cfg.el.model, ...(previous ? { previous_text: previous } : {}) }),
    });
  } catch {
    if (ac.signal.aborted) return void res.end();
    return sendJson(res, 502, { error: 'elevenlabs_unreachable' });
  }
  if (!up.ok || !up.body) {
    const detail = ctx.redact((await up.text().catch(() => '')).slice(0, 300));
    const retry = up.headers.get('retry-after');
    // A bad upstream key is our misconfiguration, not the browser's: report 502.
    const status = up.status === 401 || up.status === 403 ? 502 : up.status;
    return sendJson(res, status, { error: 'elevenlabs_error', status: up.status, detail }, retry ? { 'retry-after': retry } : {});
  }
  res.writeHead(200, {
    'content-type': 'audio/pcm;rate=24000',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
    'x-starhand-voice': voice,
  });
  res.flushHeaders();
  await pump(up.body, res);
}

// ---- /api/gemini/* --------------------------------------------------------------------------

const GEMINI_ROUTE = /^\/api\/gemini\/(v1beta|v1alpha|v1)\/models\/([A-Za-z0-9._-]+):(generateContent|streamGenerateContent|countTokens)$/;

async function handleGemini(req, res, cfg, ctx, url) {
  if (!cfg.gemini.key) {
    return sendJson(res, 503, { error: 'gemini_unconfigured', message: 'Gemini is not configured on this server (GEMINI_API_KEY is empty).' });
  }
  if (url.pathname === '/api/gemini/live-token') return handleLiveToken(req, res, cfg, ctx);
  const m = url.pathname.match(GEMINI_ROUTE);
  if (!m) {
    return sendJson(res, 404, {
      error: 'route_not_allowed',
      message: 'Only generateContent, streamGenerateContent and countTokens on the allowed models are proxied.',
    });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
  const [, version, model, method] = m;
  if (!cfg.gemini.models.includes(model)) return sendJson(res, 403, { error: 'model_not_allowed', model, allowed: cfg.gemini.models });
  const wait = ctx.limit.gemini(ctx.ip);
  if (wait) return sendJson(res, 429, { error: 'rate_limited', retry_after_s: wait }, { 'retry-after': String(wait) });

  let body = await readBody(req, cfg.caps.gemini);
  if (cfg.gemini.storeFalse && method !== 'countTokens') {
    try {
      body = Buffer.from(JSON.stringify({ ...JSON.parse(body.toString('utf8') || '{}'), store: false }));
    } catch {
      throw new HttpError(400, 'bad_json');
    }
  }
  const alt = url.searchParams.get('alt');
  const query = method === 'streamGenerateContent' && alt === 'sse' ? '?alt=sse' : '';
  const ac = abortOnClose(res);
  let up;
  try {
    up = await fetch(`${cfg.gemini.base}/${version}/models/${model}:${method}${query}`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.gemini.key },
      body,
    });
  } catch {
    if (ac.signal.aborted) return void res.end();
    return sendJson(res, 502, { error: 'gemini_unreachable' });
  }
  const headers = { 'content-type': up.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' };
  const retry = up.headers.get('retry-after');
  if (retry) headers['retry-after'] = retry;
  if (!up.ok) {
    const text = ctx.redact(await up.text().catch(() => ''));
    res.writeHead(up.status, headers);
    return void res.end(text);
  }
  if (query) headers['x-accel-buffering'] = 'no';
  res.writeHead(up.status, headers);
  res.flushHeaders();
  if (!up.body) return void res.end();
  await pump(up.body, res);
}

// ---- /api/gemini/live-token -----------------------------------------------------------------

async function handleLiveToken(req, res, cfg, ctx) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
  const wait = ctx.limit.token(ctx.ip);
  if (wait) return sendJson(res, 429, { error: 'rate_limited', retry_after_s: wait }, { 'retry-after': String(wait) });
  const body = await readJson(req, cfg.caps.token);
  const model = typeof body.model === 'string' && body.model ? body.model.replace(/^models\//, '') : cfg.gemini.liveModel;
  if (model !== cfg.gemini.liveModel) return sendJson(res, 403, { error: 'model_not_allowed', model, allowed: [cfg.gemini.liveModel] });
  const config = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? { ...body.config } : {};
  delete config.httpOptions;
  delete config.abortSignal;
  const modalities = Array.isArray(config.responseModalities) ? config.responseModalities.map(String) : ['AUDIO'];
  if (modalities.some((m) => m.toUpperCase() !== 'AUDIO')) {
    return sendJson(res, 400, { error: 'audio_only', message: 'The Live model answers in audio only.' });
  }
  config.responseModalities = ['AUDIO'];

  const now = Date.now();
  const expireTime = new Date(now + 30 * 60_000).toISOString();
  const newSessionExpireTime = new Date(now + 60_000).toISOString();
  try {
    const name = await ctx.mintToken({ model, config, expireTime, newSessionExpireTime });
    sendJson(res, 200, { name, model, apiVersion: cfg.gemini.liveApiVersion, expireTime, newSessionExpireTime });
  } catch (err) {
    sendJson(res, 502, { error: 'token_mint_failed', detail: ctx.redact(err instanceof Error ? err.message : String(err)).slice(0, 300) });
  }
}

/** One use, 30 minutes, a new session within 60 s, locked to exactly this model and config. */
async function mintWithSdk(cfg, { model, config, expireTime, newSessionExpireTime }) {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: cfg.gemini.key, httpOptions: { apiVersion: cfg.gemini.tokenApiVersion, baseUrl: cfg.gemini.base } });
  // No lockAdditionalFields: with the constraints set, every field of this config is locked.
  const token = await ai.authTokens.create({
    config: { uses: 1, expireTime, newSessionExpireTime, liveConnectConstraints: { model, config } },
  });
  if (!token || typeof token.name !== 'string' || !token.name) throw new Error('the token response had no name');
  return token.name;
}

// ---- static files ---------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.woff2': 'font/woff2',
};

async function fileStat(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function serveStatic(req, res, cfg, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendText(res, 400, 'Bad path');
  }
  if (pathname.includes('\0')) return sendText(res, 400, 'Bad path');
  const rel = pathname.replace(/^[/\\]+/, '');
  let file = resolve(cfg.dist, rel);
  if (file !== cfg.dist && !file.startsWith(cfg.dist + sep)) return sendText(res, 403, 'Forbidden');

  let st = await fileStat(file);
  if (st?.isDirectory()) {
    file = join(file, 'index.html');
    st = await fileStat(file);
  }
  if (!st?.isFile()) {
    // SPA fallback for app routes, never for a missing asset (a missing .mp3 must 404, not return HTML).
    const wantsPage = !extname(rel) || String(req.headers.accept ?? '').includes('text/html');
    if (!wantsPage) return sendText(res, 404, 'Not found');
    file = join(cfg.dist, 'index.html');
    st = await fileStat(file);
    if (!st?.isFile()) return sendText(res, 503, 'The app is not built yet. Run: npm run build');
  }
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const immutable = file.startsWith(join(cfg.dist, 'assets') + sep);
  res.writeHead(200, {
    'content-type': type,
    'content-length': st.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}

// ---- server ---------------------------------------------------------------------------------

export function createServer(cfg = loadConfig(), deps = {}) {
  const limit = {
    tts: makeLimiter(cfg.limits.tts),
    gemini: makeLimiter(cfg.limits.gemini),
    token: makeLimiter(cfg.limits.token),
  };
  const redact = redactor(cfg);
  const mintToken = deps.mintToken ?? ((args) => mintWithSdk(cfg, args));
  const log = deps.log ?? ((line) => console.log(line));

  return http.createServer((req, res) => {
    const t0 = Date.now();
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return sendText(res, 400, 'Bad request');
    }
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    res.setHeader('permissions-policy', 'camera=(self), microphone=(self)');
    if (cfg.logRequests) {
      // path only: never query strings, headers or bodies
      res.on('finish', () => log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - t0}ms`));
    }
    const ctx = { ip: clientIp(req, cfg.trustProxy), limit, redact, mintToken };
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    if (isApi && req.method === 'POST' && cfg.allowedOrigins.length) {
      const origin = req.headers.origin;
      if (origin && !cfg.allowedOrigins.includes(origin)) return sendJson(res, 403, { error: 'origin_not_allowed' });
    }

    let work;
    if (url.pathname === '/api/health') {
      work = Promise.resolve(
        sendJson(res, 200, {
          ok: true,
          gemini: !!cfg.gemini.key,
          elevenlabs: !!cfg.el.key,
          live: !!cfg.gemini.key,
          models: cfg.gemini.models,
          liveModel: cfg.gemini.liveModel,
        }),
      );
    } else if (url.pathname === '/api/tts') work = handleTts(req, res, cfg, ctx);
    else if (url.pathname === '/api/gemini' || url.pathname.startsWith('/api/gemini/')) work = handleGemini(req, res, cfg, ctx, url);
    else if (isApi) work = Promise.resolve(sendJson(res, 404, { error: 'not_found' }));
    else work = serveStatic(req, res, cfg, url);

    work.catch((err) => {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.code }, err.status === 413 ? { connection: 'close' } : {});
      log(`error on ${req.method} ${url.pathname}: ${redact(err instanceof Error ? err.message : String(err))}`);
      sendJson(res, 500, { error: 'internal_error' });
    });
  });
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const cfg = loadConfig();
  const server = createServer(cfg);
  server.listen(cfg.port, cfg.host, () => {
    console.log(
      `STARHAND server on http://${cfg.host}:${cfg.port} | dist ${cfg.dist} | gemini ${cfg.gemini.key ? 'on' : 'off'} | elevenlabs ${cfg.el.key ? 'on' : 'off'}`,
    );
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
