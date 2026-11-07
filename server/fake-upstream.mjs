// Fake ElevenLabs + Gemini upstream for the server tests. No real keys, no network.
import http from 'node:http';

export const EL_KEY = 'el-test-key-123';
export const GEMINI_KEY = 'AIzaFAKE-gemini-test-key-0000000000';

/** 1.0 s of a 440 Hz tone as s16le 24 kHz. */
export function tone(seconds = 1) {
  const n = Math.round(24000 * seconds);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 12000), i * 2);
  return pcm;
}

export async function startFakeUpstream() {
  const seen = [];
  const ttsDone = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const url = new URL(req.url, 'http://x');
    seen.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body });

    const tts = url.pathname.match(/^\/v1\/text-to-speech\/([^/]+)\/stream$/);
    if (tts) {
      if (req.headers['xi-api-key'] !== EL_KEY) return void res.writeHead(401, { 'content-type': 'application/json' }).end('{"detail":"invalid api key"}');
      if (url.searchParams.get('output_format') !== 'pcm_24000' || body?.model_id !== 'eleven_flash_v2_5' || !body?.text) {
        return void res.writeHead(422).end('bad request');
      }
      const pcm = tone(body.text.includes('long') ? 2 : 0.5);
      res.writeHead(200, { 'content-type': 'audio/pcm' });
      const result = { voice: tts[1], aborted: false, sent: 0 };
      ttsDone.push(
        new Promise((done) => {
          res.on('close', () => {
            if (!res.writableFinished) result.aborted = true;
            done(result);
          });
        }),
      );
      const sizes = [4801, 3999, 8193, 7001];
      for (let k = 0; result.sent < pcm.length && !result.aborted && !res.destroyed; k++) {
        const size = Math.min(sizes[k % sizes.length], pcm.length - result.sent);
        res.write(pcm.subarray(result.sent, result.sent + size));
        result.sent += size;
        await new Promise((r) => setTimeout(r, 25));
      }
      return void res.end();
    }

    if (req.headers['x-goog-api-key'] !== GEMINI_KEY) {
      return void res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":{"code":403,"message":"bad key"}}');
    }
    const gen = url.pathname.match(/^\/(v1beta|v1alpha)\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/);
    if (gen && gen[3] === 'generateContent') {
      if (body?.contents?.[0]?.parts?.[0]?.text === 'please 429') {
        return void res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' }).end('{"error":{"code":429,"message":"slow down"}}');
      }
      return void res
        .writeHead(200, { 'content-type': 'application/json; charset=UTF-8' })
        .end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: `echo ${gen[2]}` }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }));
    }
    if (gen && gen[3] === 'streamGenerateContent') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const word of ['Copy', 'that', 'Flight']) {
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: word }] } }] })}\r\n\r\n`);
        await new Promise((r) => setTimeout(r, 30));
      }
      return void res.end();
    }
    if (url.pathname === '/v1alpha/auth_tokens' && req.method === 'POST') {
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: 'auth_tokens/fake-token-123' }));
    }
    res.writeHead(404).end(`fake upstream: no route ${req.method} ${url.pathname}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    ttsDone,
    close: () => new Promise((r) => server.close(r)),
  };
}
