import { GoogleGenAI, Modality } from '@google/genai';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const t0 = performance.now(); const ms = () => Math.round(performance.now() - t0);
let audioBytes = 0, transcript = '', toolCalls = 0, turns = 0, session;
const tm = setTimeout(() => { console.log('timeout 30s'); report(); }, 30000);
function report() { clearTimeout(tm); try { session?.close(); } catch {}
  console.log(`\naudioBytes=${audioBytes} toolCalls=${toolCalls} turns=${turns}\ntranscript: ${transcript.trim().slice(0,200)}`);
  console.log(`SMOKE live audio ${audioBytes>0?'PASS':'FAIL'}; SMOKE live toolcall ${toolCalls>0?'PASS':'FAIL'}`); process.exit(0); }
session = await ai.live.connect({ model: 'gemini-3.8-live', config: {
  responseModalities: [Modality.AUDIO], outputAudioTranscription: {},
  systemInstruction: 'You are the voice of a robot work cell. One short sentence per turn.',
  tools: [{ functionDeclarations: [
    { name: 'cell_status', description: 'Return the safety state of the cell.' },
    { name: 'run_task', behavior: 'NON_BLOCKING', description: 'Hand a task to the cell planner; returns started immediately.',
      parameters: { type: 'OBJECT', properties: { task: { type: 'STRING' } }, required: ['task'] } } ] }],
}, callbacks: {
  onopen: () => console.log(`onopen ${ms()}ms`),
  onmessage: (m) => {
    const parts = m.serverContent?.modelTurn?.parts || [];
    for (const p of parts) if (p.inlineData?.data) audioBytes += p.inlineData.data.length;
    if (m.serverContent?.outputTranscription?.text) transcript += m.serverContent.outputTranscription.text;
    if (m.toolCall) { for (const fc of m.toolCall.functionCalls) { toolCalls++; console.log(`toolCall ${fc.name} id=${fc.id} args=${JSON.stringify(fc.args)} ${ms()}ms`);
      const response = fc.name === 'cell_status' ? { state: 'IDLE', accepts_tasks: true } : { ok: true, status: 'started', scheduling: 'SILENT' };
      session.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response }] });
      if (fc.name === 'run_task') setTimeout(() => { console.log(`push [CELL EVENT] ${ms()}ms`);
        session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: '[CELL EVENT] task finished: the red block is in the tray' }] }], turnComplete: true }); }, 1500); } }
    if (m.serverContent?.turnComplete) { turns++; console.log(`turnComplete #${turns} ${ms()}ms audioBytes=${audioBytes} transcript="${transcript.trim().slice(-80)}"`);
      if (turns === 1) session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: 'Run the task: put the red block in the tray.' }] }], turnComplete: true });
      if (turns >= 3) report(); }
  },
  onerror: (e) => console.log('onerror', e?.message || e),
  onclose: (e) => { console.log('onclose', e?.code, e?.reason); report(); },
}});
session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: 'What is the cell status?' }] }], turnComplete: true });
