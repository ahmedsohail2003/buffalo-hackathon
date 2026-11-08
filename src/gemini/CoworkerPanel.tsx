// CAPCOM panel: chat with the Gemini coworker (typed), hold TALK for Live voice, choose the voice
// (ElevenLabs or Gemini native), mute, and (unless showLedger is false) a compact ledger of every Gemini call.
// Props: the bay (null until the arm core is up) and the log sink; optionally the fabricator and
// the registry's containment check. Class names start with sh-cw- for the shell's theme.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { BayApi, BayState, GeminiCallEntry, Sample } from '../contracts';
import { getSpeaker, type SpeakerLike } from '../voice/elevenSpeaker';
import { playSfx, type SfxName } from '../voice/sfx';
import { getGeminiClient, usingDevKey } from './client';
import { Coworker, type CoworkerReply } from './coworker';
import { OFFLINE, getServerHealth, type ServerHealth } from './health';
import { LiveVoice, type LiveOutput, type LiveState } from './live';
import { isPriced, modelLabel } from './models';
import type { ToolContext } from './tools';
import type { FabricateFn, LogSink } from './types';

export interface CoworkerPanelProps {
  bay: BayApi | null;
  sink: LogSink;
  fabricate?: FabricateFn | null;
  inContainment?: (s: Sample) => boolean;
  /** defaults to the shared ElevenLabs speaker */
  speaker?: SpeakerLike;
  /** the panel's own Gemini call ledger (default true; the app shows a global one) */
  showLedger?: boolean;
  className?: string;
  style?: CSSProperties;
}

interface ChatItem {
  id: number;
  who: 'operator' | 'capcom' | 'tool' | 'system';
  text: string;
  /** a Live transcript still growing */
  open?: boolean;
}

let nextId = 1;
const MAX_ITEMS = 80;
const LEDGER_ROWS = 6;

const VOICE_LABEL: Record<LiveState, string> = {
  off: 'voice off',
  connecting: 'connecting',
  ready: 'ready',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking',
  working: 'working', // shown as "working: <tool>" while a long tool runs
  error: 'voice error',
};

const c = {
  panel: 'var(--sh-panel, #0b1220)',
  text: 'var(--sh-text, #e2e8f0)',
  dim: 'var(--sh-dim, #94a3b8)',
  border: 'var(--sh-border, #1e293b)',
  accent: 'var(--sh-accent, #38bdf8)',
  good: 'var(--sh-good, #4ade80)',
  warn: 'var(--sh-warn, #f59e0b)',
  bad: 'var(--sh-bad, #f87171)',
};

// The panel fills its slot: the chat log takes the height that is left and scrolls; the header,
// the input and the voice rows keep their size, so they stay in view at the bottom.
const s: Record<string, CSSProperties> = {
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 12,
    background: c.panel,
    color: c.text,
    border: `1px solid ${c.border}`,
    borderRadius: 8,
    height: '100%',
    minHeight: 0,
    boxSizing: 'border-box',
    font: 'inherit',
  },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', flex: 'none' },
  title: { fontWeight: 600, letterSpacing: '0.04em', whiteSpace: 'nowrap' },
  chips: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  chip: { fontSize: 11, padding: '2px 8px', borderRadius: 999, border: `1px solid ${c.border}`, color: c.dim },
  log: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, lineHeight: 1.35 },
  note: { fontSize: 12, color: c.warn, border: `1px solid ${c.warn}`, borderRadius: 6, padding: '4px 8px', flex: 'none' },
  form: { display: 'flex', gap: 6, flex: 'none' },
  input: { flex: 1, minWidth: 0, padding: '6px 8px', background: 'transparent', color: c.text, border: `1px solid ${c.border}`, borderRadius: 6, font: 'inherit' },
  button: { padding: '6px 12px', background: 'transparent', color: c.text, border: `1px solid ${c.border}`, borderRadius: 6, font: 'inherit', cursor: 'pointer' },
  /** the voice-choice and mute buttons: narrow enough to share one row in the projector layout */
  small: { padding: '6px 8px', fontSize: 12 },
  row: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', flex: 'none' },
  talk: { flex: 1, minWidth: 140, padding: '10px 12px', fontWeight: 600, borderRadius: 6, font: 'inherit', cursor: 'pointer', userSelect: 'none', touchAction: 'none' },
  seg: { display: 'inline-flex', border: `1px solid ${c.border}`, borderRadius: 6, overflow: 'hidden' },
  ledger: { fontSize: 11, color: c.dim, borderTop: `1px solid ${c.border}`, paddingTop: 6, fontVariantNumeric: 'tabular-nums', flex: 'none' },
  ledgerRow: { display: 'grid', gridTemplateColumns: '1fr 1fr auto auto', gap: 8 },
};

function whoStyle(who: ChatItem['who']): CSSProperties {
  if (who === 'operator') return { color: c.text };
  if (who === 'capcom') return { color: c.accent };
  if (who === 'tool') return { color: c.dim, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 };
  return { color: c.warn };
}

const WHO_LABEL: Record<ChatItem['who'], string> = { operator: 'YOU', capcom: 'CAPCOM', tool: 'tool', system: 'note' };

function usd(v: number): string {
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(3)}`;
}

/** The sound for a finished request: reject when it stopped early or a tool refused; done when a tool acted. */
export function replySound(reply: Pick<CoworkerReply, 'tools' | 'stopped'>): SfxName | null {
  if (reply.stopped) return 'reject';
  if (reply.tools.some((t) => t.result.ok && t.name !== 'describe_bay' && t.name !== 'bay_status')) return 'task-done';
  if (reply.tools.some((t) => !t.result.ok)) return 'reject';
  return null;
}

export const PAUSED_NOTE = 'Paused by the operator: thumbs up to resume.';

/** What the panel says about a typed request in flight: the operator's STOP pauses it (the arm waits). */
export function requestNote(busy: boolean, state: BayState | null): string | null {
  return busy && state === 'STOPPED' ? PAUSED_NOTE : null;
}

export function CoworkerPanel(props: CoworkerPanelProps) {
  const { bay, className, style, showLedger = true } = props;
  const propsRef = useRef(props);
  propsRef.current = props;
  const speaker = useMemo(() => props.speaker ?? getSpeaker(), [props.speaker]);

  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<ServerHealth>(OFFLINE);
  const [voice, setVoice] = useState<{ state: LiveState; detail: string }>({ state: 'off', detail: '' });
  const [output, setOutput] = useState<LiveOutput>('elevenlabs');
  const [muted, setMuted] = useState(false);
  const [talking, setTalking] = useState(false);
  const [gate, setGate] = useState<BayState | null>(() => bay?.gate.state() ?? null);
  const [ledger, setLedger] = useState<readonly GeminiCallEntry[]>(() => getGeminiClient().recent());

  const coworkerRef = useRef<Coworker | null>(null);
  const liveRef = useRef<LiveVoice | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Tool wiring read at call time, so a fabricator that loads later is still used.
  const tools = useMemo<ToolContext>(
    () => ({
      get sink() {
        return propsRef.current.sink;
      },
      get fabricate() {
        return propsRef.current.fabricate ?? undefined;
      },
      get inContainment() {
        return propsRef.current.inContainment;
      },
    }),
    [],
  );

  const add = useCallback((who: ChatItem['who'], text: string) => {
    setItems((prev) => [...prev, { id: nextId++, who, text }].slice(-MAX_ITEMS));
  }, []);

  const appendLive = useCallback((who: 'operator' | 'capcom', delta: string) => {
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.open && last.who === who) return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
      const closed = prev.map((i) => (i.open ? { ...i, open: false } : i));
      return [...closed, { id: nextId++, who, text: delta.trimStart(), open: true }].slice(-MAX_ITEMS);
    });
  }, []);

  const closeLive = useCallback(() => setItems((prev) => prev.map((i) => (i.open ? { ...i, open: false } : i))), []);

  useEffect(() => {
    let alive = true;
    void getServerHealth().then((h) => {
      if (!alive) return;
      setHealth(h);
      setOutput(h.elevenlabs ? 'elevenlabs' : 'native');
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const client = getGeminiClient();
    setLedger(client.recent());
    return client.onEntry(() => setLedger(client.recent()));
  }, []);

  // One coworker per bay; a new bay also drops the voice link bound to the old one.
  useEffect(() => {
    if (!bay) return;
    const cw = new Coworker(bay, { tools });
    cw.onTool = (t) => add('tool', `${t.name}: ${t.summary}`);
    coworkerRef.current = cw;
    setGate(bay.gate.state());
    const offGate = bay.gate.onChange((st) => {
      setGate(st);
      const live = liveRef.current;
      if (live?.connected) live.sendBayEvent(`Bay state is now ${st}.`);
    });
    return () => {
      offGate();
      cw.dispose();
      if (coworkerRef.current === cw) coworkerRef.current = null;
      liveRef.current?.disconnect();
      liveRef.current = null;
    };
  }, [bay, tools, add]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  const elevenOk = health.elevenlabs && !speaker.broken;
  const geminiMode = usingDevKey() ? 'dev key' : health.gemini ? 'server proxy' : 'offline';
  const voiceUp = voice.state !== 'off' && voice.state !== 'error' && voice.state !== 'connecting';

  const run = async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    const cw = coworkerRef.current;
    if (!text || busy) return;
    if (!cw) {
      add('system', 'The bay is not ready yet.');
      return;
    }
    setInput('');
    setBusy(true);
    add('operator', text);
    void speaker.resume().catch(() => undefined); // inside the click: unlock audio
    playSfx('blip');
    try {
      const reply = await cw.ask(text);
      if (reply.text) add('capcom', reply.text);
      if (reply.text && !muted && elevenOk && reply.stopped !== 'busy') speaker.say(reply.text, 'coworker');
      const sound = replySound(reply);
      if (sound) playSfx(sound);
    } finally {
      setBusy(false);
    }
  };

  const connect = () => {
    if (!bay) {
      add('system', 'The bay is not ready yet.');
      return;
    }
    let live = liveRef.current;
    if (!live) {
      live = new LiveVoice({ bay, sink: propsRef.current.sink, tools, speaker: elevenOk ? speaker : null, output: elevenOk ? output : 'native' });
      live.events = {
        onState: (st, detail) => setVoice({ state: st, detail: detail ?? '' }),
        onTranscript: (who, text) => appendLive(who, text),
        onTurnEnd: closeLive,
        onTool: (line) => add('tool', line),
      };
      live.setMuted(muted);
      liveRef.current = live;
    }
    void live.connect();
  };

  const disconnect = (e?: { detail?: number }) => {
    if ((e?.detail ?? 0) > 1) return; // the second click of a double click on "Connect voice" lands here
    liveRef.current?.disconnect();
    liveRef.current = null;
    setTalking(false);
  };

  const talkStart = () => {
    const live = liveRef.current;
    if (!live || !voiceUp || talking) return;
    live.startTalk();
    setTalking(true);
    playSfx('talk-on', 0.6);
  };

  const talkEnd = () => {
    if (!talking) return;
    liveRef.current?.endTalk();
    setTalking(false);
    playSfx('talk-off', 0.6);
  };

  const onTalkDown = (e: PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    talkStart();
  };

  const onTalkKey = (e: KeyboardEvent<HTMLButtonElement>, down: boolean) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (down && !e.repeat) talkStart();
    if (!down) talkEnd();
  };

  const chooseOutput = (mode: LiveOutput) => {
    setOutput(mode);
    liveRef.current?.setOutput(mode);
    if (mode === 'native') speaker.cancel();
  };

  const toggleMute = () => {
    const m = !muted;
    setMuted(m);
    speaker.setMuted(m);
    liveRef.current?.setMuted(m);
  };

  const recent = ledger.slice(-LEDGER_ROWS).reverse();
  const total = ledger.reduce((sum, e) => sum + (Number.isFinite(e.costUsd) ? e.costUsd : 0), 0);
  const note = requestNote(busy, gate);

  return (
    <section className={`sh-cw ${className ?? ''}`} style={{ ...s.panel, ...style }} aria-label="CAPCOM, the Gemini coworker">
      <header style={s.head}>
        <span style={s.title} title="CAPCOM, the Gemini coworker">
          CAPCOM
        </span>
        <span style={s.chips}>
          <span className="sh-cw-chip" style={{ ...s.chip, color: geminiMode === 'offline' ? c.bad : c.dim }} title="How this browser reaches Gemini">
            Gemini: {geminiMode}
          </span>
          <span
            className="sh-cw-chip"
            style={{ ...s.chip, color: voice.state === 'error' ? c.bad : voiceUp ? c.good : c.dim }}
            title={voice.detail || undefined}
          >
            {voice.state === 'working' && voice.detail ? `${VOICE_LABEL.working}: ${voice.detail}` : VOICE_LABEL[voice.state]}
          </span>
        </span>
      </header>

      <div ref={logRef} className="sh-cw-log" style={s.log} role="log" aria-live="polite">
        {items.length === 0 && (
          <div style={{ color: c.dim }}>Ask CAPCOM to pick, place, check or fabricate a sample. Moves need the bay running; stop and resume stay with your hand signals.</div>
        )}
        {items.map((it) => (
          <div key={it.id} className={`sh-cw-item sh-cw-${it.who}`} style={whoStyle(it.who)}>
            <span style={{ color: c.dim, marginRight: 6, fontSize: 11 }}>{WHO_LABEL[it.who]}</span>
            {it.text}
          </div>
        ))}
        {voice.state === 'error' && voice.detail && <div style={{ color: c.bad }}>{voice.detail}</div>}
      </div>

      {note && (
        <div className="sh-cw-note" style={s.note} role="status">
          {note}
        </div>
      )}

      <form style={s.form} onSubmit={run}>
        <input
          className="sh-cw-input"
          style={s.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={bay ? 'e.g. put the Bennu sample in containment' : 'waiting for the bay...'}
          aria-label="Message to CAPCOM"
          disabled={!bay}
        />
        <button className="sh-cw-run" style={s.button} type="submit" disabled={!bay || busy || !input.trim()}>
          {busy ? 'Working...' : 'Run'}
        </button>
      </form>

      <div style={s.row}>
        {voice.state === 'off' || voice.state === 'error' ? (
          <button className="sh-cw-connect" style={s.button} type="button" onClick={connect} disabled={!bay || (!health.live && !usingDevKey())}>
            Connect voice
          </button>
        ) : (
          <button className="sh-cw-connect" style={s.button} type="button" onClick={disconnect}>
            Disconnect
          </button>
        )}
        <button
          className="sh-cw-talk"
          type="button"
          style={{
            ...s.talk,
            color: talking ? '#0b1220' : c.text,
            background: talking ? c.accent : 'transparent',
            border: `1px solid ${talking ? c.accent : c.border}`,
            opacity: voiceUp ? 1 : 0.5,
          }}
          disabled={!voiceUp}
          aria-pressed={talking}
          onPointerDown={onTalkDown}
          onPointerUp={talkEnd}
          onPointerCancel={talkEnd}
          onLostPointerCapture={talkEnd}
          onKeyDown={(e) => onTalkKey(e, true)}
          onKeyUp={(e) => onTalkKey(e, false)}
          onContextMenu={(e) => e.preventDefault()}
        >
          {talking ? 'Listening... release to send' : 'TALK (hold)'}
        </button>
      </div>

      <div style={s.row}>
        <span style={{ fontSize: 12, color: c.dim }}>Voice</span>
        <span style={s.seg} role="group" aria-label="CAPCOM voice">
          {(['elevenlabs', 'native'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              style={{ ...s.button, ...s.small, border: 'none', borderRadius: 0, background: output === mode ? c.border : 'transparent' }}
              aria-pressed={output === mode}
              disabled={mode === 'elevenlabs' && !elevenOk}
              title={mode === 'elevenlabs' && !elevenOk ? 'ElevenLabs is not configured on the server' : undefined}
              onClick={() => chooseOutput(mode)}
            >
              {mode === 'elevenlabs' ? 'ElevenLabs' : 'Gemini native'}
            </button>
          ))}
        </span>
        <button type="button" style={{ ...s.button, ...s.small }} aria-pressed={muted} onClick={toggleMute}>
          {muted ? 'Unmute' : 'Mute'}
        </button>
      </div>

      {showLedger && (
        <div className="sh-cw-ledger" style={s.ledger} aria-label="Gemini call ledger">
          <div style={{ ...s.ledgerRow, color: c.text, marginBottom: 2 }}>
            <span>Gemini calls: {ledger.length}</span>
            <span />
            <span />
            <span>{usd(total)}</span>
          </div>
          {recent.map((e, i) => (
            <div key={ledger.length - i} style={{ ...s.ledgerRow, color: e.ok ? c.dim : c.bad }} title={e.error}>
              <span>{modelLabel(e.model)}</span>
              <span>{e.purpose}</span>
              <span>{e.latencyMs} ms</span>
              <span>{isPriced(e.model) ? usd(e.costUsd) : 'n/a'}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
