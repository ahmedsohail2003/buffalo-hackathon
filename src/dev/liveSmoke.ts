// Browser Live smoke (?livesmoke=1): the B0 step-6 protocol run in Chrome with real audio playback.
// Mounted by the 3-line guard in main.tsx. Not part of the app.

import { GoogleGenAI, Modality } from '@google/genai/web';
import type { LiveServerMessage, Session } from '@google/genai/web';
import { LIVE_MODEL } from '../gemini/models';

export function mountLiveSmoke(root: HTMLElement): void {
  root.innerHTML = `<div style="font:14px/1.5 system-ui;padding:24px;max-width:900px;color:#ddd;background:#111;min-height:100vh">
    <h2 style="margin:0 0 8px">Live browser smoke — ${LIVE_MODEL}</h2>
    <p>Click Connect once. Expect: cell_status tool call → spoken answer → run_task (NON_BLOCKING) → [CELL EVENT] → spoken ack. Audio plays through the speakers.</p>
    <button id="connect" style="font-size:16px;padding:8px 16px">Connect</button>
    <pre id="log" style="white-space:pre-wrap;background:#000;padding:12px;margin-top:12px;min-height:200px"></pre></div>`;
  const log = root.querySelector<HTMLPreElement>('#log')!;
  const btn = root.querySelector<HTMLButtonElement>('#connect')!;
  const t0 = performance.now();
  const line = (s: string) => { log.textContent += `${String(Math.round(performance.now() - t0)).padStart(6)} ms  ${s}\n`; console.log('[livesmoke]', s); };
  btn.onclick = () => { btn.disabled = true; run(line).catch((e) => line(`ERROR ${e?.message ?? e}`)); };
}

async function run(line: (s: string) => void): Promise<void> {
  const key = import.meta.env.VITE_GEMINI_API_KEY as string | undefined;
  if (!key) { line('FAIL: VITE_GEMINI_API_KEY missing in .env.local'); return; }
  const ai = new GoogleGenAI({ apiKey: key });
  const ctx = new AudioContext({ sampleRate: 24000 });
  await ctx.resume();
  let nextStart = 0, audioBytes = 0, played = 0, transcript = '', turns = 0, statusOk = false, runOk = false, eventPushedAtTurn = -1, eventTurn = false, cancel = false;
  let session: Session | null = null;
  const finish = () => {
    try { session?.close(); } catch { /* closed */ }
    line(`audioBytes=${audioBytes} playedChunks=${played} turns=${turns}`);
    line(`transcript: ${transcript.trim().slice(0, 300)}`);
    line(`BROWSER LIVE ${audioBytes > 0 && played > 0 ? 'PASS' : 'FAIL'} — toolcall ${statusOk ? 'PASS' : 'FAIL'} — ack+event ${runOk && eventTurn ? 'PASS' : 'FAIL'} — toolCallCancellation seen: ${cancel}`);
  };
  const timer = setTimeout(() => { line('timeout 45 s'); finish(); }, 45000);
  const playPcm = (b64: string) => {
    const bin = atob(b64); const n = bin.length >> 1; const f32 = new Float32Array(n);
    for (let i = 0; i < n; i++) { const lo = bin.charCodeAt(2 * i), hi = bin.charCodeAt(2 * i + 1); let v = (hi << 8) | lo; if (v >= 0x8000) v -= 0x10000; f32[i] = v / 32768; }
    const buf = ctx.createBuffer(1, n, 24000); buf.copyToChannel(f32, 0);
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.02, nextStart); src.start(at); nextStart = at + buf.duration; played++;
  };
  const onmessage = (m: LiveServerMessage) => {
    for (const p of m.serverContent?.modelTurn?.parts ?? []) if (p.inlineData?.data) { audioBytes += p.inlineData.data.length; playPcm(p.inlineData.data); }
    if (m.serverContent?.outputTranscription?.text) transcript += m.serverContent.outputTranscription.text;
    if (m.serverContent?.interrupted) line('interrupted');
    if (m.toolCallCancellation) { cancel = true; line(`toolCallCancellation ${JSON.stringify(m.toolCallCancellation.ids)}`); }
    if (m.toolCall?.functionCalls) for (const fc of m.toolCall.functionCalls) {
      line(`toolCall ${fc.name} id=${fc.id} args=${JSON.stringify(fc.args ?? {})}`);
      if (fc.name === 'cell_status') { statusOk = true; session!.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response: { state: 'IDLE', accepts_tasks: true } }] }); }
      if (fc.name === 'run_task') {
        runOk = true; session!.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response: { ok: true, status: 'started', scheduling: 'SILENT' } }] });
        setTimeout(() => { eventPushedAtTurn = turns; line('push [CELL EVENT] task finished'); session!.sendClientContent({ turns: [{ role: 'user', parts: [{ text: '[CELL EVENT] task finished: the red block is in the tray' }] }], turnComplete: true }); }, 3000);
      }
    }
    if (m.serverContent?.turnComplete) {
      turns++; line(`turnComplete #${turns} audio=${audioBytes} "${transcript.trim().slice(-90)}"`);
      if (turns === 1) session!.sendClientContent({ turns: [{ role: 'user', parts: [{ text: 'Run the task: put the red block in the tray.' }] }], turnComplete: true });
      if (eventPushedAtTurn >= 0 && turns > eventPushedAtTurn && (audioBytes > 0 || transcript)) { eventTurn = true; clearTimeout(timer); setTimeout(finish, Math.max(500, (nextStart - ctx.currentTime) * 1000 + 300)); }
    }
  };
  session = await ai.live.connect({ model: LIVE_MODEL, config: {
    responseModalities: [Modality.AUDIO], outputAudioTranscription: {},
    systemInstruction: 'You are the voice of a robot work cell. One short sentence per turn.',
    tools: [{ functionDeclarations: [
      { name: 'cell_status', description: 'Return the safety state of the cell.' },
      { name: 'run_task', behavior: 'NON_BLOCKING' as never, description: 'Hand a task to the cell planner; returns started immediately.',
        parameters: { type: 'OBJECT' as never, properties: { task: { type: 'STRING' as never } }, required: ['task'] } } ] }],
  }, callbacks: {
    onopen: () => line('onopen'),
    onmessage,
    onerror: (e) => line(`onerror ${(e as ErrorEvent)?.message ?? ''}`),
    onclose: (e) => line(`onclose ${e?.code} ${e?.reason ?? ''}`),
  } });
  line('connected; sending "What is the cell status?"');
  session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: 'What is the cell status?' }] }], turnComplete: true });
}
