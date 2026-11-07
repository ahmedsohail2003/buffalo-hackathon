import { useCallback, useEffect, useRef, useState } from 'react';
import type { CellApi, GeminiCallEntry } from '../contracts';
import { bus, fmtMs, fmtUsd, fmtTok, type TraceLine } from '../telemetry/bus';
import { cancelTask, runTask, taskStore, type TaskState } from '../gemini/erLoop';
import { DEMO, ER_MODEL, FLASH_MODEL, LIVE_MODEL, type Level } from '../gemini/models';
import './CoworkerPane.css';

/** Voice session controls (implemented by src/gemini/live.ts in B5). */
export interface VoiceApi {
  connect(): Promise<void>;
  disconnect(): void;
  setTalk(held: boolean): void;
  /** Typed text into the connected voice session (no-mic fallback). */
  sendText(text: string): void;
  hasMic(): boolean;
  status(): VoiceStatus;
  subscribe(cb: (s: VoiceStatus) => void): () => void;
}
export type VoiceStatus = 'off' | 'connecting' | 'ready' | 'listening' | 'speaking' | 'ending' | 'error';

/** Typed coworker over Flash (implemented in B6); null = ER-direct only. */
export type ConsoleApi = ((text: string) => Promise<string>) | null;

interface Props { cell: CellApi | null; voice?: VoiceApi | null; console?: ConsoleApi }

const shortModel = (m: string) => (m === ER_MODEL ? 'ER-2' : m === FLASH_MODEL ? 'Flash' : m === LIVE_MODEL ? 'Live' : m.replace(/^gemini-/, ''));

export function CoworkerPane({ cell, voice = null, console: flashConsole = null }: Props) {
  const [task, setTask] = useState<TaskState>(() => taskStore.get());
  const [entries, setEntries] = useState<readonly GeminiCallEntry[]>(() => bus.entries());
  const [transcript, setTranscript] = useState<TraceLine[]>(() => bus.lines().filter((l) => l.kind === 'live' || l.kind === 'reject'));
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>(() => voice?.status() ?? 'off');
  const [text, setText] = useState('put the red block in the tray');
  const [route, setRoute] = useState<'er' | 'flash' | 'voice'>('er');
  const [demo, setDemo] = useState({ ...DEMO });
  const [busy, setBusy] = useState(false);
  const talkHeld = useRef(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => taskStore.subscribe(setTask), []);
  useEffect(() => bus.subscribe((ev) => {
    if (ev.entry) setEntries(bus.entries());
    if (ev.line && (ev.line.kind === 'live' || ev.line.kind === 'reject')) setTranscript((t) => [...t.slice(-60), ev.line!]);
  }), []);
  useEffect(() => voice?.subscribe(setVoiceStatus), [voice]);
  useEffect(() => { transcriptRef.current?.scrollTo({ top: 1e9 }); }, [transcript.length]);

  const setTalk = useCallback((held: boolean) => {
    if (!voice || talkHeld.current === held) return;
    talkHeld.current = held; voice.setTalk(held);
  }, [voice]);

  const run = useCallback(async () => {
    const t = text.trim();
    if (!t || !cell || busy) return;
    if (route === 'voice') { voice?.sendText(t); setText(''); return; }
    setBusy(true);
    try {
      if (route === 'flash' && flashConsole) { bus.emit({ kind: 'live', text: `YOU ▶ "${t}"` }); const reply = await flashConsole(t); bus.emit({ kind: 'live', text: `FLASH ◀ ${reply}` }); }
      else await runTask(cell, t);
    } finally { setBusy(false); }
  }, [text, cell, busy, route, flashConsole, voice]);

  const setDemoKey = <K extends keyof typeof DEMO>(k: K, v: (typeof DEMO)[K]) => { (DEMO as Record<string, unknown>)[k] = v; setDemo({ ...DEMO }); bus.emit({ kind: 'info', text: `DEMO_MODE ${k}=${String(v)}` }); };

  const voiceLabel: Record<VoiceStatus, string> = { off: 'voice off', connecting: 'connecting…', ready: 'ready', listening: 'listening', speaking: 'speaking', ending: 'session ending — reconnect', error: 'voice error' };
  const canTalk = voice && voice.hasMic() && (voiceStatus === 'ready' || voiceStatus === 'listening' || voiceStatus === 'speaking');

  return (
    <section className="coworker-pane" aria-label="Coworker">
      <header className="cw-head">
        <h2>Coworker</h2>
        <span className={`cw-pill v-${voiceStatus}`}>{voiceLabel[voiceStatus]}</span>
      </header>

      <div className="cw-row">
        {voiceStatus === 'off' || voiceStatus === 'error' ? (
          <button type="button" className="cw-btn" disabled={!voice} onClick={() => voice?.connect()} title={voice ? `Connect ${LIVE_MODEL}` : 'voice not wired yet'}>Connect voice</button>
        ) : (
          <button type="button" className="cw-btn" onClick={() => voice?.disconnect()}>Disconnect</button>
        )}
        <button type="button" className={`cw-btn cw-talk${talkHeld.current ? ' held' : ''}`} disabled={!canTalk}
          onMouseDown={() => setTalk(true)} onMouseUp={() => setTalk(false)} onMouseLeave={() => setTalk(false)}
          onTouchStart={(e) => { e.preventDefault(); setTalk(true); }} onTouchEnd={(e) => { e.preventDefault(); setTalk(false); }}
          onKeyDown={(e) => { if (e.key === ' ' && !e.repeat) { e.preventDefault(); setTalk(true); } }} onKeyUp={(e) => { if (e.key === ' ') { e.preventDefault(); setTalk(false); } }}
          title="Hold to talk (mouse, touch, or Space while focused)">TALK (hold)</button>
      </div>

      <form className="cw-row" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <input className="cw-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="type a task for the cell…" aria-label="task" />
        <button type="submit" className="cw-btn primary" disabled={!cell || busy || !text.trim()}>{busy ? 'running…' : 'Run'}</button>
        <button type="button" className="cw-btn" disabled={!task.active} onClick={() => cancelTask()}>Cancel</button>
      </form>
      <div className="cw-row cw-dim">
        <label>route{' '}
          <select value={route} onChange={(e) => setRoute(e.target.value as 'er' | 'flash' | 'voice')} aria-label="route">
            <option value="er">ER-direct task</option>
            <option value="flash" disabled={!flashConsole}>Flash coworker{flashConsole ? '' : ' (not wired)'}</option>
            <option value="voice" disabled={voiceStatus === 'off' || voiceStatus === 'error' || voiceStatus === 'connecting'}>voice session (typed)</option>
          </select>
        </label>
        <span>{route === 'flash' ? `${FLASH_MODEL} → tools` : route === 'voice' ? `${LIVE_MODEL} → tools, spoken reply` : `${ER_MODEL} plans and verifies`}</span>
      </div>

      <div className="cw-transcript" ref={transcriptRef} aria-label="transcript">
        {transcript.length === 0 && <div className="cw-dim">Voice transcript and rejections appear here.</div>}
        {transcript.map((l) => <div key={l.id} className={`cw-line k-${l.kind}`}>{l.text}</div>)}
      </div>

      <PlanCard task={task} />
      <FrameView task={task} />

      <div className="cw-ledger" aria-label="Gemini call ledger">
        <div className="cw-ledger-head"><span>t</span><span>model</span><span>purpose</span><span>lvl</span><span>ms</span><span>in/out/thought</span><span>$</span></div>
        {entries.slice(-12).map((e, i) => (
          <div key={`${e.t}-${i}`} className={`cw-ledger-row${e.ok ? '' : ' err'}`} title={e.error ?? ''}>
            <span>{new Date(e.t).toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' })}</span>
            <span>{shortModel(e.model)}</span><span>{e.purpose}</span><span>{e.thinkingLevel ?? '—'}</span>
            <span>{e.ok ? fmtMs(e.latencyMs) : 'ERR'}</span><span>{fmtTok(e.promptTokens)}/{fmtTok(e.outputTokens)}/{fmtTok(e.thoughtTokens)}</span><span>{fmtUsd(e.costUsd)}</span>
          </div>
        ))}
        {entries.length === 0 && <div className="cw-dim">No Gemini calls yet.</div>}
      </div>

      <div className="cw-row cw-dim cw-demo" aria-label="DEMO_MODE">
        <span>DEMO_MODE</span>
        <label>consensus <select value={demo.consensusN} onChange={(e) => setDemoKey('consensusN', Number(e.target.value) as 1 | 3)}><option value={1}>1</option><option value={3}>3</option></select></label>
        <label>plan <select value={demo.planLevel} onChange={(e) => setDemoKey('planLevel', e.target.value as Level)}>{(['LOW', 'MEDIUM', 'HIGH'] as Level[]).map((l) => <option key={l} value={l}>{l}</option>)}</select></label>
        <label>fc shape <select value={demo.fcShape} onChange={(e) => setDemoKey('fcShape', e.target.value as 'A' | 'B')}><option value="A">A</option><option value="B">B</option></select></label>
      </div>
    </section>
  );
}

function PlanCard({ task }: { task: TaskState }) {
  if (!task.text) return <div className="cw-plan cw-dim">No task yet. Type one above or say it.</div>;
  return (
    <div className={`cw-plan${task.active ? ' active' : ''}`} aria-label="plan card">
      <div className="cw-plan-head">
        <span className="cw-plan-task">“{task.text}”</span>
        <span className={`cw-pill p-${task.phase}`}>{task.phase}{task.active && task.step ? ` ${task.step}` : ''}</span>
      </div>
      {task.points.length > 0 && (
        <div className="cw-plan-points">{task.points.map((p) => <span key={p.label} className={p.error_mm !== null && p.error_mm > 25 ? 'warn' : ''}>{p.matched ?? p.label}: {p.error_mm !== null ? `err ${p.error_mm} mm` : 'unmatched'}</span>)}</div>
      )}
      <ol className="cw-plan-steps">
        {task.steps.map((s, i) => (
          <li key={i} className={s.ok ? 'ok' : 'fail'}>
            <span className="mark">{s.ok ? '✓' : '✗'}</span>
            <span className="tool">{s.tool}({Object.values(s.args).join(', ')})</span>
            {s.reason && <span className="reason"> {s.reason}</span>}
            {s.verify && <span className={`verify ${s.verify.ok ? 'ok' : 'fail'}`}>{s.verify.ok ? '✓' : '✗'} “{s.verify.observation}”</span>}
          </li>
        ))}
      </ol>
      {task.report && <div className={`cw-plan-report ${task.report.ok ? 'ok' : 'fail'}`}>{task.report.ok ? '✓' : '✗'} {task.report.summary} — {task.report.calls} calls, {fmtUsd(task.report.costUsd)}</div>}
      {task.active && <div className="cw-dim">{task.calls} calls · {fmtUsd(task.costUsd)}</div>}
    </div>
  );
}

/** "What Gemini sees": last 768² frame with ER points (yellow), ground truth (green), grasp point (orange). */
function FrameView({ task }: { task: TaskState }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const frame = task.frame;
  useEffect(() => {
    const c = ref.current; if (!c || !frame) return;
    const ctx = c.getContext('2d'); if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, 256, 256); ctx.drawImage(img, 0, 0, 256, 256);
      const k = 256 / 1000;
      for (const p of frame.points) {
        if (p.truthYx) { ctx.strokeStyle = '#34d399'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.truthYx[1] * k, p.truthYx[0] * k, 6, 0, Math.PI * 2); ctx.stroke(); }
        ctx.fillStyle = p.kind === 'grasp' ? '#fb923c' : '#facc15'; ctx.beginPath(); ctx.arc(p.yx[1] * k, p.yx[0] * k, 4, 0, Math.PI * 2); ctx.fill();
        ctx.font = '11px ui-monospace, monospace'; ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
        const label = `${p.label}${p.err !== null ? ` err ${p.err} mm` : ''}`;
        ctx.strokeText(label, p.yx[1] * k + 7, p.yx[0] * k - 6); ctx.fillText(label, p.yx[1] * k + 7, p.yx[0] * k - 6);
      }
    };
    img.src = `data:image/jpeg;base64,${frame.jpegB64}`;
  }, [frame]);
  return (
    <div className="cw-frame" aria-label="What Gemini sees">
      <div className="cw-frame-title">What Gemini sees <span className="cw-dim">(cell camera 768², ER points yellow · registry green)</span></div>
      {frame ? <canvas ref={ref} width={256} height={256} /> : <div className="cw-frame-empty">no frame sent yet</div>}
    </div>
  );
}
