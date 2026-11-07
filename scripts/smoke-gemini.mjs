// Real-key smoke test for the Gemini side of STARHAND. Run one of:
//   GEMINI_API_KEY=... node scripts/smoke-gemini.mjs                 straight to Gemini
//   node scripts/smoke-gemini.mjs --server https://your.host          through the STARHAND server
// Add --no-live to skip the Live checks.
//
// Checks: fast-model text with a thinking level; a function-call round trip (thought signatures
// go back); a JSON schema; embodied-reasoning pointing on a generated test image; a Live token and a Live
// answer on v1alpha and on v1beta, sending text as client content and as realtime input. The
// summary says which Live API version and which text path work, for src/gemini/live.ts.
import { deflateSync } from 'node:zlib';
import { GoogleGenAI } from '@google/genai';

const FLASH = 'gemini-3.8-flash';
const ER = 'gemini-robotics-er-2-preview';
const LIVE = 'gemini-3.8-live';

const args = process.argv.slice(2);
const at = args.indexOf('--server');
const SERVER = at >= 0 ? String(args[at + 1] ?? '').replace(/\/+$/, '') : '';
const KEY = process.env.GEMINI_API_KEY ?? '';
const NO_LIVE = args.includes('--no-live');
if (!SERVER && !KEY) {
  console.error('Set GEMINI_API_KEY, or pass --server https://your.host');
  process.exit(1);
}

const ai = SERVER
  ? new GoogleGenAI({ apiKey: 'server-proxy', httpOptions: { baseUrl: `${SERVER}/api/gemini` } })
  : new GoogleGenAI({ apiKey: KEY });
console.log(SERVER ? `Through the server: ${SERVER}` : 'Straight to Gemini with GEMINI_API_KEY');

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name} (${Date.now() - t0} ms) ${detail ?? ''}`);
    return true;
  } catch (err) {
    const msg = String(err?.message ?? err).slice(0, 400);
    results.push({ name, ok: false, detail: msg });
    console.log(`FAIL  ${name} (${Date.now() - t0} ms) ${msg}`);
    return false;
  }
}

const usage = (r) => {
  const u = r.usageMetadata ?? {};
  return `[in ${u.promptTokenCount ?? 0}, out ${u.candidatesTokenCount ?? 0}, thinking ${u.thoughtsTokenCount ?? 0}]`;
};

await step('Flash text, thinking LOW', async () => {
  const r = await ai.models.generateContent({ model: FLASH, contents: 'Reply with exactly: Copy, Flight.', config: { thinkingConfig: { thinkingLevel: 'LOW' } } });
  return `"${(r.text ?? '').trim()}" ${usage(r)}`;
});

await step('Flash function call round trip', async () => {
  const tools = [{ functionDeclarations: [{ name: 'bay_status', description: 'Bay safety state and what the gripper holds. Read-only.' }] }];
  const config = { tools, thinkingConfig: { thinkingLevel: 'LOW' } };
  const contents = [{ role: 'user', parts: [{ text: 'What is the bay state? Use the tool, then answer in one sentence.' }] }];
  const r1 = await ai.models.generateContent({ model: FLASH, contents, config });
  const fc = r1.functionCalls?.[0];
  if (!fc) throw new Error(`no function call; the model said: ${r1.text}`);
  contents.push(r1.candidates[0].content);
  contents.push({ role: 'user', parts: [{ functionResponse: { name: fc.name, ...(fc.id ? { id: fc.id } : {}), response: { ok: true, bay_state: 'RUNNING', holding: null } } }] });
  const r2 = await ai.models.generateContent({ model: FLASH, contents, config });
  return `called ${fc.name}; then "${(r2.text ?? '').trim()}"`;
});

await step('Flash JSON schema', async () => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' }, grip_mm: { type: 'number', minimum: 15, maximum: 45 }, material: { type: 'string', enum: ['chondrite', 'iron', 'basalt'] } },
    required: ['name', 'grip_mm', 'material'],
  };
  const r = await ai.models.generateContent({
    model: FLASH,
    contents: 'Name one small meteorite sample for a robot gripper, with its grip width and material.',
    config: { responseMimeType: 'application/json', responseJsonSchema: schema, thinkingConfig: { thinkingLevel: 'LOW' } },
  });
  return JSON.stringify(JSON.parse(r.text ?? ''));
});

// ---- Embodied-reasoning pointing on a generated image ---------------------------------------

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 256x256 light deck with a red 48 px square centred at pixel (184, 88): [y, x] = [344, 719]. */
function testPng(w = 256, h = 256) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const red = x >= 160 && x < 208 && y >= 64 && y < 112;
      const grid = x % 32 === 0 || y % 32 === 0;
      const o = y * stride + 1 + x * 3;
      raw[o] = red ? 215 : grid ? 205 : 240;
      raw[o + 1] = red ? 35 : grid ? 210 : 242;
      raw[o + 2] = red ? 35 : grid ? 215 : 245;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const POINT_SCHEMA = {
  type: 'array',
  maxItems: 5,
  items: {
    type: 'object',
    properties: { point: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 1000 }, minItems: 2, maxItems: 2 }, label: { type: 'string' } },
    required: ['point', 'label'],
  },
};

await step('Robotics-ER pointing', async () => {
  const contents = [
    {
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/png', data: testPng().toString('base64') } },
        { text: 'Point to the red square. The answer should follow the JSON format: [{"point": [y, x], "label": "<name>"}]. The points are in [y, x] format normalized to 0-1000.' },
      ],
    },
  ];
  let r;
  let schema = 'on';
  try {
    r = await ai.models.generateContent({ model: ER, contents, config: { responseMimeType: 'application/json', responseJsonSchema: POINT_SCHEMA } });
  } catch (err) {
    if (err?.status !== 400) throw err;
    schema = `off (schema refused: ${String(err.message).slice(0, 120)})`;
    r = await ai.models.generateContent({ model: ER, contents });
  }
  const text = (r.text ?? '').replace(/```json|```/g, '').trim();
  const points = JSON.parse(text);
  const [y, x] = (Array.isArray(points) ? points[0] : points).point;
  const miss = Math.hypot(y - 344, x - 719);
  if (miss > 60) throw new Error(`pointed at [${y}, ${x}]; expected about [344, 719]`);
  return `[${y}, ${x}] vs [344, 719]: off by ${miss.toFixed(0)}/1000, schema ${schema} ${usage(r)}`;
});

// ---- Live -----------------------------------------------------------------------------------

const LIVE_CONFIG = {
  responseModalities: ['AUDIO'],
  systemInstruction: { parts: [{ text: 'You are CAPCOM at mission control. Answer in one short sentence.' }] },
  inputAudioTranscription: {},
  outputAudioTranscription: {},
};

async function mintToken() {
  if (SERVER) {
    const r = await fetch(`${SERVER}/api/gemini/live-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: LIVE, config: LIVE_CONFIG }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.name) throw new Error(`token: HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    return j.name;
  }
  const admin = new GoogleGenAI({ apiKey: KEY, httpOptions: { apiVersion: 'v1alpha' } });
  const now = Date.now();
  const t = await admin.authTokens.create({
    config: { uses: 1, expireTime: new Date(now + 30 * 60_000).toISOString(), newSessionExpireTime: new Date(now + 60_000).toISOString(), liveConnectConstraints: { model: LIVE, config: LIVE_CONFIG } },
  });
  if (!t?.name) throw new Error('no token name');
  return t.name;
}

/** One Live session with a fresh token; resolves with what came back. */
async function liveProbe(apiVersion, send) {
  const token = await mintToken();
  const client = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion } });
  let transcript = '';
  let audioBytes = 0;
  let finish;
  let fail;
  const answered = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const timer = setTimeout(() => fail(new Error('no answer within 20 s')), 20_000);
  const session = await client.live.connect({
    model: LIVE,
    config: LIVE_CONFIG,
    callbacks: {
      onmessage: (m) => {
        const sc = m.serverContent;
        if (sc?.outputTranscription?.text) transcript += sc.outputTranscription.text;
        for (const p of sc?.modelTurn?.parts ?? []) if (p.inlineData?.data) audioBytes += Math.floor((p.inlineData.data.length * 3) / 4);
        if (sc?.turnComplete) finish();
      },
      onclose: (e) => fail(new Error(`closed: ${e?.code} ${e?.reason ?? ''}`)),
      onerror: (e) => fail(new Error(`error: ${e?.message ?? e}`)),
    },
  });
  try {
    send(session, 'Radio check. Reply with: loud and clear.');
    await answered;
    return `${audioBytes} bytes of audio, transcript "${transcript.trim()}"`;
  } finally {
    clearTimeout(timer);
    try {
      session.close();
    } catch {
      // closed
    }
  }
}

const viaClientContent = (s, text) => s.sendClientContent({ turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true });
const viaRealtimeText = (s, text) => s.sendRealtimeInput({ text });

if (!NO_LIVE) {
  await step('Live token', async () => `${(await mintToken()).slice(0, 16)}...`);
  for (const version of ['v1alpha', 'v1beta']) {
    await step(`Live on ${version}, text as client content`, () => liveProbe(version, viaClientContent));
    await step(`Live on ${version}, text as realtime input`, () => liveProbe(version, viaRealtimeText));
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed.`);
if (!NO_LIVE) {
  const ok = (name) => results.find((r) => r.name === name)?.ok;
  for (const v of ['v1alpha', 'v1beta']) {
    console.log(`Live ${v}: client content ${ok(`Live on ${v}, text as client content`) ? 'works' : 'fails'}, realtime text ${ok(`Live on ${v}, text as realtime input`) ? 'works' : 'fails'}`);
  }
  console.log('Set GEMINI_LIVE_API_VERSION on the server to a version that works (default v1alpha).');
}
process.exit(failed.length ? 1 : 0);
