import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { TeleopStatus } from '../contracts';
import { getHandFrame } from '../app/hand';
import { PARAMS } from '../app/params';
import { getRuntime } from '../app/runtime';
import { useInputMode } from './hooks';
import { HAND_LINKS, getHandTracker } from './handTracker';
import { SIGNAL_COLORS, SIGNAL_KEYS } from './signalKeys';
import { useSlots } from './slots';


/** True when a key press is meant for a text field, not for the gesture keypad. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

function useTracker() {
  const t = getHandTracker();
  const status = useSyncExternalStore(
    (cb) => t.onChange(cb),
    () => t.status,
  );
  const error = useSyncExternalStore(
    (cb) => t.onChange(cb),
    () => t.error,
  );
  const fps = useSyncExternalStore(
    (cb) => t.onChange(cb),
    () => t.fps,
  );
  return { tracker: t, status, error, fps };
}

// ---- camera view with landmark overlay and dwell ring ----------------------------------------

function CameraView() {
  const SimStage = useSlots().simStage;
  const { tracker, status, error, fps } = useTracker();
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const hud = useRef<HTMLSpanElement>(null);
  const live = status === 'running' || status === 'loading' || status === 'starting';

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    el.prepend(tracker.video);
    return () => {
      if (tracker.video.parentElement === el) el.removeChild(tracker.video);
    };
  }, [tracker]);

  // overlay: draw the latest hand (camera or simulated) and the dwell ring at the palm
  useEffect(() => {
    let raf = 0;
    const rt = getRuntime();
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvas.current;
      if (!c) return;
      const w = c.clientWidth;
      const h = c.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const f = getHandFrame();
      const fresh = f && performance.now() - f.t < 400 && f.landmarks.length >= 21;
      const box = host.current;
      if (box && box.dataset.hand !== String(!!fresh)) box.dataset.hand = String(!!fresh);
      const label = hud.current;
      if (label) label.textContent = fresh && f.gesture ? `${f.gesture.replace('_', ' ')} ${(f.gestureScore * 100).toFixed(0)}%` : fresh ? 'hand · no signal' : 'no hand';
      if (!fresh) return;
      // the video is drawn with object-fit: cover; map normalized points the same way
      const vw = tracker.video.videoWidth || 640;
      const vh = tracker.video.videoHeight || 480;
      const s = Math.max(w / vw, h / vh);
      const ox = (w - vw * s) / 2;
      const oy = (h - vh * s) / 2;
      const P = (i: number) => {
        const p = f.landmarks[i]!;
        return [ox + p.x * vw * s, oy + p.y * vh * s] as const;
      };
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(56,189,248,0.85)';
      ctx.beginPath();
      for (const [a, b] of HAND_LINKS) {
        const [ax, ay] = P(a);
        const [bx, by] = P(b);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      ctx.stroke();
      ctx.fillStyle = '#e2e8f0';
      for (let i = 0; i < 21; i++) {
        const [x, y] = P(i);
        ctx.beginPath();
        ctx.arc(x, y, i % 4 === 0 && i > 0 ? 3.2 : 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      const snap = rt.safetySnapshot();
      if (snap.command && snap.phase !== 'idle') {
        const [px, py] = [0, 5, 9, 13, 17].map(P).reduce((acc, [x, y]) => [acc[0] + x / 5, acc[1] + y / 5], [0, 0]);
        const r = Math.max(18, Math.min(w, h) * 0.12);
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = SIGNAL_COLORS[snap.command];
        ctx.beginPath();
        ctx.arc(px, py, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * snap.progress);
        ctx.stroke();
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [tracker]);

  const enable = async () => {
    const ok = await tracker.start();
    if (ok) getRuntime().setInputMode('camera');
  };
  const disable = () => {
    tracker.stop();
    getRuntime().setInputMode('sim');
  };

  return (
    <div className="cam" ref={host} data-status={status}>
      <canvas className="overlay" ref={canvas} aria-hidden="true" />
      <div className="cam-hud">
        <span className="chip">
          <span className="dot" style={{ color: live ? '#22c55e' : '#5d7091' }} />
          <span ref={hud}>no hand</span>
        </span>
        {status === 'running' && <span className="chip num">{fps} fps</span>}
      </div>
      {!live && PARAMS.sim && SimStage && (
        <div className="cam-stage">
          <SimStage />
        </div>
      )}
      {!live && !(PARAMS.sim && SimStage) && (
        <div className="cam-empty">
          {PARAMS.sim ? (
            <>
              <p>
                <b>Simulated hand input.</b> The camera stays off in this mode (<span className="mono">?sim=1</span>). Hold keys 1–5 to signal.
              </p>
            </>
          ) : (
            <>
              <p>{error ?? 'Track your hand with the webcam. It runs on this device; the video never leaves it.'}</p>
              <button className="btn primary" onClick={enable} type="button">
                {status === 'error' ? 'Try the camera again' : 'Enable camera'}
              </button>
            </>
          )}
        </div>
      )}
      {(status === 'starting' || status === 'loading') && (
        <div className="cam-empty" role="status">
          <p>{status === 'starting' ? 'Waiting for camera permission…' : 'Loading the hand model…'}</p>
        </div>
      )}
      {status === 'running' && (
        <div className="cam-foot">
          <button className="btn small ghost" onClick={disable} type="button">
            Camera off
          </button>
        </div>
      )}
    </div>
  );
}

// ---- dwell readout ---------------------------------------------------------------------------

function SignalReadout() {
  const arc = useRef<SVGCircleElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const sub = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const rt = getRuntime();
    let raf = 0;
    let lastKey = '';
    const C = 2 * Math.PI * 15;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const s = rt.safetySnapshot();
      const cmd = s.gesture ? SIGNAL_KEYS.find((g) => g.gesture === s.gesture) : undefined;
      const color = s.command ? SIGNAL_COLORS[s.command] : '#5d7091';
      if (arc.current) {
        arc.current.style.stroke = color;
        arc.current.style.strokeDashoffset = String(C * (1 - (s.phase === 'idle' ? 0 : s.progress)));
      }
      const key = `${s.phase}|${s.gesture}`;
      if (key === lastKey) return;
      lastKey = key;
      if (text.current && sub.current) {
        if (!cmd || s.phase === 'idle') {
          text.current.textContent = 'No signal';
          text.current.style.color = '';
          sub.current.textContent = 'Hold a gesture to command the bay';
        } else {
          text.current.textContent = `${cmd.commandLabel}${s.phase === 'fired' ? ' · sent' : ''}`;
          text.current.style.color = color;
          sub.current.textContent = s.phase === 'fired' ? `${cmd.gestureLabel}: release to send again` : `${cmd.gestureLabel}: keep holding…`;
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const C = 2 * Math.PI * 15;
  return (
    <div className="signal" aria-live="polite">
      <svg width="38" height="38" viewBox="0 0 38 38" aria-hidden="true">
        <circle cx="19" cy="19" r="15" fill="none" stroke="#1b2a44" strokeWidth="4" />
        <circle ref={arc} cx="19" cy="19" r="15" fill="none" strokeWidth="4" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C} transform="rotate(-90 19 19)" />
      </svg>
      <div className="what">
        <span className="k">Hand signal</span>
        <span className="v" ref={text}>
          No signal
        </span>
        <small ref={sub} style={{ color: 'var(--faint)', fontSize: 11 }}>
          Hold a gesture to command the bay
        </small>
      </div>
    </div>
  );
}

// ---- simulated signal keypad -----------------------------------------------------------------

function Keypad() {
  const [held, setHeld] = useState<string | null>(null);
  const heldRef = useRef<string | null>(null);
  const hold = (gesture: string | null) => {
    heldRef.current = gesture;
    setHeld(gesture);
    getRuntime().setSimGesture(gesture);
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const cmd = SIGNAL_KEYS.find((c) => c.key === e.key);
      if (!cmd) return;
      e.preventDefault();
      hold(cmd.gesture);
    };
    const up = (e: KeyboardEvent) => {
      const cmd = SIGNAL_KEYS.find((c) => c.key === e.key);
      if (cmd && heldRef.current === cmd.gesture) hold(null);
    };
    const blur = () => heldRef.current && hold(null);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  return (
    <div>
      <div className="keypad-title">
        <span>Simulated signals · hold to send</span>
        <span className="mono">keys 1–5</span>
      </div>
      <div className="keypad" role="group" aria-label="Simulated hand signals">
        {SIGNAL_KEYS.map((c) => (
          <button
            key={c.gesture}
            type="button"
            className="key"
            data-active={held === c.gesture}
            style={{ ['--k' as string]: SIGNAL_COLORS[c.command] }}
            aria-label={`Hold ${c.gestureLabel} to send ${c.commandLabel} (key ${c.key})`}
            aria-pressed={held === c.gesture}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              hold(c.gesture);
            }}
            onPointerUp={() => hold(null)}
            onPointerCancel={() => hold(null)}
            onLostPointerCapture={() => heldRef.current === c.gesture && hold(null)}
            onKeyDown={(e) => {
              if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                e.preventDefault();
                hold(c.gesture);
              }
            }}
            onKeyUp={(e) => {
              if (e.key === ' ' || e.key === 'Enter') hold(null);
            }}
          >
            <span className="cap">{c.key}</span>
            <span className="gest">{c.gestureLabel}</span>
            <span className="cmd">{c.commandLabel}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- hand teleop toggle and extras -----------------------------------------------------------

function TeleopToggle() {
  const { teleop } = useSlots();
  const [status, setStatus] = useState<TeleopStatus | null>(() => teleop?.status() ?? null);
  useEffect(() => {
    if (!teleop) {
      setStatus(null);
      return;
    }
    setStatus(teleop.status());
    const id = setInterval(() => setStatus(teleop.status()), 250);
    return () => clearInterval(id);
  }, [teleop]);
  const on = !!status?.enabled;
  return (
    <div className="teleop-row">
      <div className="t">
        <span id="teleop-label" style={{ fontWeight: 600 }}>
          Hand teleop
        </span>
        <small>{teleop ? (status?.note ?? (on ? 'The arm follows your hand' : 'Off: the arm ignores hand position')) : 'Teleop module not loaded'}</small>
      </div>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={on}
        aria-labelledby="teleop-label"
        disabled={!teleop}
        onClick={() => {
          if (!teleop) return;
          if (on) teleop.disable('operator turned teleop off');
          else teleop.enable();
          setStatus(teleop.status());
        }}
      />
    </div>
  );
}

export function HandPane() {
  const mode = useInputMode();
  const { handExtras, teleop } = useSlots();
  // A registered controller drives this toggle; a hand-pane extra (the teleop panel) brings its own.
  const showToggle = !!teleop || handExtras.length === 0;
  return (
    <section className="pane hand-pane" aria-labelledby="hand-title">
      <div className="pane-head">
        <h2 className="pane-title" id="hand-title">
          Operator hand
        </h2>
        <span className="spacer" />
        <span className="chip">{mode === 'camera' ? 'camera' : 'keypad'}</span>
      </div>
      <div className="pane-body">
        <CameraView />
        <SignalReadout />
        <Keypad />
        {showToggle && <TeleopToggle />}
        {handExtras.length > 0 && (
          <div className="hand-extras">
            {handExtras.map(({ id, Component }) => (
              <Component key={id} mode={mode} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
