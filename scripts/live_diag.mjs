import { GoogleGenAI, Modality } from '@google/genai';
const key = process.env.GEMINI_API_KEY;
async function tryLive(label, opts, model) {
  const ai = new GoogleGenAI({ apiKey: key, ...opts });
  console.log(`\n== ${label} model=${model}`);
  await new Promise(async (resolve) => {
    const t0 = performance.now(); const done = () => { clearTimeout(tm); resolve(); };
    const tm = setTimeout(() => { console.log('  timeout 15s'); done(); }, 15000);
    let session;
    try {
      session = await ai.live.connect({ model, config: { responseModalities: [Modality.TEXT] }, callbacks: {
        onopen: () => { console.log(`  onopen ${Math.round(performance.now()-t0)}ms`); },
        onmessage: (m) => { const keys = Object.keys(m); const txt = m.text ?? m.serverContent?.modelTurn?.parts?.map(p=>p.text).join('');
          console.log(`  msg keys=${keys.join(',')} text=${JSON.stringify(txt||'').slice(0,60)} setup=${!!m.setupComplete} turnComplete=${!!m.serverContent?.turnComplete}`);
          if (m.serverContent?.turnComplete) { session.close(); done(); } },
        onerror: (e) => { console.log('  onerror', e?.message || JSON.stringify(e).slice(0,200)); },
        onclose: (e) => { console.log('  onclose', e?.code, e?.reason); done(); },
      }});
      console.log('  connected; sending text');
      session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: 'Say OK.' }] }], turnComplete: true });
    } catch (e) { console.log('  connect threw:', (e?.message||e).toString().slice(0,300)); done(); }
  });
}
await tryLive('default apiVersion', {}, 'gemini-3.8-live');
await tryLive('v1alpha', { httpOptions: { apiVersion: 'v1alpha' } }, 'gemini-3.8-live');
await tryLive('default, 2.5 native audio (control)', {}, 'gemini-2.5-flash-native-audio-preview-12-2025');
