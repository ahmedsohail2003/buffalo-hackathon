// Gemini API smoke test (B0). Usage: node scripts/smoke.mjs [--only=flash,point,fc,latency,er16,live]
// Reads GEMINI_API_KEY from the environment, else VITE_GEMINI_API_KEY from .env.local. Never prints the key.
import { GoogleGenAI, Modality } from '@google/genai';
import fs from 'node:fs';

let key = process.env.GEMINI_API_KEY;
if (!key) {
  try { const env = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
    key = env.match(/^\s*(?:VITE_)?GEMINI_API_KEY\s*=\s*"?([^"\r\n]+)"?/m)?.[1]?.trim(); } catch {}
}
if (!key) { console.error('GEMINI_API_KEY not set and .env.local missing'); process.exit(1); }
const ai = new GoogleGenAI({ apiKey: key });
const only = (process.argv.find(a => a.startsWith('--only=')) || '--only=flash,point,fc,latency,er16,live').slice(7).split(',');
const want = (n) => only.includes(n);
const t = () => performance.now();
const ER = 'gemini-robotics-er-2-preview';
const img = fs.readFileSync(new URL('../../repos/ahmedsohail2003.github.io/workcell/media/partC_rgbd_rgb.png', import.meta.url)).toString('base64');
const IMG = { inlineData: { mimeType: 'image/png', data: img } };
const strip = (s) => String(s ?? '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
const short = (s, n = 300) => String(s ?? '').slice(0, n).replace(/\n/g, ' ');

async function step(name, fn) {
  const t0 = t();
  try { const r = await fn(); console.log(`PASS ${name} (${Math.round(t() - t0)} ms)`); if (r) console.log('   ', short(r)); return true; }
  catch (e) { console.log(`FAIL ${name} (${Math.round(t() - t0)} ms):`, short(e?.message || e, 500)); return false; }
}

if (want('flash')) await step('flash text', async () => {
  const r = await ai.models.generateContent({ model: 'gemini-3.8-flash', contents: 'Reply with the single word OK.' });
  return r.text;
});

// ---- er2 point: exact production config (schema on), fallback schema off ----
const POINT_SCHEMA = { type: 'ARRAY', items: { type: 'OBJECT', properties: {
  point: { type: 'ARRAY', items: { type: 'INTEGER' }, minItems: 2, maxItems: 2 }, label: { type: 'STRING' } }, required: ['point', 'label'] } };
const POINT_PROMPT = (labels) => `Point to the following items in the image: ${labels}. Point at the centre of each item's top face. The label returned should be the exact requested name. The answer should follow the json format: [{"point": <point>, "label": <label>}, ...]. The points are in [y, x] format normalized to 0-1000. Omit items you cannot see.`;
async function point(withSchema) {
  const config = { responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'low' }, temperature: 0 };
  if (withSchema) config.responseJsonSchema = POINT_SCHEMA;
  const r = await ai.models.generateContent({ model: ER, contents: [{ role: 'user', parts: [IMG, { text: POINT_PROMPT('red block, tray, gripper') }] }], config });
  const pts = JSON.parse(strip(r.text));
  if (!Array.isArray(pts) || !pts.every(p => Array.isArray(p.point) && p.point.length === 2 && p.point.every(v => v >= 0 && v <= 1000))) throw new Error('bad points: ' + short(r.text));
  return `${withSchema ? 'SCHEMA-ON' : 'SCHEMA-OFF'} fenced=${/^```/.test(r.text.trim())} thoughts=${r.usageMetadata?.thoughtsTokenCount ?? 0} ${JSON.stringify(pts)}`;
}
if (want('point')) {
  const on = await step('er2 point schema ON (responseJsonSchema)', () => point(true));
  if (!on) console.log('   → SCHEMA-OFF fallback');
  await step('er2 point schema OFF (responseMimeType only)', () => point(false));
}

// ---- er2 function calling: shape A (functionResponse.parts image) / shape B ----
const FC_TOOLS = [{ functionDeclarations: [
  { name: 'move_to', description: 'Move the gripper to a point above the table.', parameters: { type: 'OBJECT', properties: {
    x_mm: { type: 'NUMBER' }, y_mm: { type: 'NUMBER' }, z_mm: { type: 'NUMBER' } }, required: ['x_mm', 'y_mm', 'z_mm'] } },
  { name: 'done', description: 'Finish the task.', parameters: { type: 'OBJECT', properties: { success: { type: 'BOOLEAN' }, summary: { type: 'STRING' } }, required: ['success', 'summary'] } },
] }];
const FC_SYS = 'You control an arm through tools. Image right is +x, nearer the camera is more negative y, z up, mm. Act one tool call at a time; after each tool you get its result and a new frame.';
const FC_TASK = 'Objects: red block at (0,-230) 24 mm cube. Task: Move above the red block, then call done. Choose the first tool call.';
async function fcTurn(contents, level, mode) {
  const t0 = t();
  const r = await ai.models.generateContent({ model: ER, contents, config: { systemInstruction: FC_SYS, tools: FC_TOOLS,
    toolConfig: { functionCallingConfig: { mode } }, thinkingConfig: { thinkingLevel: level }, temperature: 0 } });
  const fcs = r.functionCalls ?? [];
  const content = r.candidates?.[0]?.content;
  return { r, fcs, content, ms: Math.round(t() - t0), thoughts: r.usageMetadata?.thoughtsTokenCount ?? 0, sig: !!content?.parts?.some(p => p.thoughtSignature) };
}
let fcShape = 'FAIL';
if (want('fc')) {
  const turn1 = [{ role: 'user', parts: [IMG, { text: FC_TASK }] }];
  let first;
  const ok1 = await step('er2 fc turn1 (mode ANY, low)', async () => {
    first = await fcTurn(turn1, 'low', 'ANY');
    if (!first.fcs.length) throw new Error('no functionCall; text=' + short(first.r.text));
    return `${first.ms} ms thoughts=${first.thoughts} thoughtSignature=${first.sig} fc=${JSON.stringify(first.fcs.map(f => ({ id: f.id, name: f.name, args: f.args })))}`;
  });
  if (ok1) {
    const fc = first.fcs[0];
    const respA = { functionResponse: { id: fc.id, name: fc.name, response: { ok: true, tcp_mm: [0, -230, 75] },
      parts: [{ inlineData: { mimeType: 'image/png', data: img } }] } };
    const okA = await step('er2 fc shapeA (functionResponse.parts image)', async () => {
      const s = await fcTurn([...turn1, first.content, { role: 'user', parts: [respA] }], 'low', 'AUTO');
      if (!s.fcs.length) throw new Error('no functionCall/done; text=' + short(s.r.text));
      return `${s.ms} ms fc=${JSON.stringify(s.fcs.map(f => ({ name: f.name, args: f.args })))}`;
    });
    if (okA) fcShape = 'A';
    else {
      const respB = { functionResponse: { id: fc.id, name: fc.name, response: { ok: true, tcp_mm: [0, -230, 75] } } };
      const okB = await step('er2 fc shapeB (functionResponse turn + image user turn)', async () => {
        const s = await fcTurn([...turn1, first.content, { role: 'user', parts: [respB] }, { role: 'user', parts: [IMG, { text: 'Frame after executing the above.' }] }], 'low', 'AUTO');
        if (!s.fcs.length) throw new Error('no functionCall/done; text=' + short(s.r.text));
        return `${s.ms} ms fc=${JSON.stringify(s.fcs.map(f => ({ name: f.name, args: f.args })))}`;
      });
      if (okB) fcShape = 'B';
    }
  }
  console.log(`SMOKE er2 fc shape=${fcShape}`);
}

// ---- er2 latency: plan-like prompt at high vs medium ----
if (want('latency')) {
  const out = {};
  for (const level of ['high', 'medium']) {
    await step(`er2 latency ${level}`, async () => {
      const s = await fcTurn([{ role: 'user', parts: [IMG, { text: FC_TASK }] }], level, 'ANY');
      out[level] = s;
      return `${s.ms} ms thoughts=${s.thoughts} prompt=${s.r.usageMetadata?.promptTokenCount} out=${s.r.usageMetadata?.candidatesTokenCount} fc=${s.fcs.map(f => f.name).join(',')}`;
    });
  }
  console.log(`SMOKE er2 latency HIGH ${out.high?.ms ?? 'FAIL'} ms MEDIUM ${out.medium?.ms ?? 'FAIL'} ms thoughts ${out.high?.thoughts ?? '?'}/${out.medium?.thoughts ?? '?'}`);
}

if (want('er16')) await step('INFO er1.6 point (deprecated, never used)', async () => {
  const r = await ai.models.generateContent({ model: 'gemini-robotics-er-1.6-preview', contents: [{ role: 'user', parts: [IMG, { text: POINT_PROMPT('red block') }] }], config: { thinkingConfig: { thinkingLevel: 'low' } } });
  return r.text;
});

// ---- live: audio + toolcall + ack + event + cancellation probe ----
if (want('live')) await step('live audio+toolcall+ack+event', () => new Promise(async (resolve, reject) => {
  const t0 = t(); const ms = () => Math.round(t() - t0);
  let audioBytes = 0, transcript = '', turns = 0, cancel = false, statusOk = false, runOk = false, eventTurn = false, session;
  const tm = setTimeout(() => finish('timeout 40s'), 40000);
  function finish(err) { clearTimeout(tm); try { session?.close(); } catch {}
    const lines = [`SMOKE live audio ${audioBytes > 0 || transcript ? 'PASS' : 'FAIL'} (${audioBytes} b64 bytes, "${transcript.trim().slice(0, 120)}")`,
      `SMOKE live toolcall ${statusOk ? 'PASS' : 'FAIL'}`, `SMOKE live ack+event ${runOk && eventTurn ? 'PASS' : 'FAIL'}`, `INFO live toolCallCancellation after barge-in: ${cancel}`];
    console.log(lines.join('\n')); if (err) reject(new Error(err)); else resolve('done'); }
  session = await ai.live.connect({ model: 'gemini-3.8-live', config: {
    responseModalities: [Modality.AUDIO], outputAudioTranscription: {},
    systemInstruction: 'You are the voice of a robot work cell. One short sentence per turn.',
    tools: [{ functionDeclarations: [
      { name: 'cell_status', description: 'Return the safety state of the cell.' },
      { name: 'run_task', behavior: 'NON_BLOCKING', description: 'Hand a task to the cell planner; returns started immediately.',
        parameters: { type: 'OBJECT', properties: { task: { type: 'STRING' } }, required: ['task'] } } ] }],
  }, callbacks: {
    onmessage: (m) => {
      for (const p of m.serverContent?.modelTurn?.parts || []) if (p.inlineData?.data) audioBytes += p.inlineData.data.length;
      if (m.serverContent?.outputTranscription?.text) transcript += m.serverContent.outputTranscription.text;
      if (m.toolCallCancellation) { cancel = true; console.log(`   toolCallCancellation ids=${JSON.stringify(m.toolCallCancellation.ids)} ${ms()}ms`); }
      if (m.toolCall) for (const fc of m.toolCall.functionCalls) {
        console.log(`   toolCall ${fc.name} id=${fc.id} ${ms()}ms`);
        if (fc.name === 'cell_status') { statusOk = true; session.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response: { state: 'IDLE' } }] }); }
        if (fc.name === 'run_task') { runOk = true; session.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response: { result: 'started', scheduling: 'SILENT' } }] });
          setTimeout(() => { console.log(`   push [CELL EVENT] ${ms()}ms`); const before = turns;
            session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: '[CELL EVENT] task finished: block in tray' }] }], turnComplete: true });
            setTimeout(() => { console.log(`   barge-in text "okay" ${ms()}ms`); session.sendRealtimeInput({ text: 'okay' }); }, 600);
            eventTurnCheck = () => turns > before; }, 3000); }
      }
      if (m.serverContent?.turnComplete) { turns++; console.log(`   turnComplete #${turns} ${ms()}ms audio=${audioBytes} transcript="${transcript.trim().slice(-80)}"`);
        if (turns === 1) session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: 'Run the task: put the block in the tray.' }] }], turnComplete: true });
        if (eventTurnCheck && eventTurnCheck() && (audioBytes > 0 || transcript)) { eventTurn = true; setTimeout(() => finish(), 1500); } }
    },
    onerror: (e) => finish('live error: ' + (e?.message || e)),
    onclose: (e) => { if (e?.code && e.code !== 1000) finish(`close ${e.code} ${e.reason}`); },
  } });
  let eventTurnCheck = null;
  session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: 'What is the cell status?' }] }], turnComplete: true });
}));
