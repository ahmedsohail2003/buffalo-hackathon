import { useEffect, useRef, useState } from 'react';
import type { BayState } from '../contracts';
import { getRuntime } from '../app/runtime';
import { BayScene, getBayView } from '../scene/BayScene';
import { useBayState, useLastCaptureAt, useNow, useTelemetry } from './hooks';

const STATE_TEXT: Record<BayState, string> = {
  IDLE: 'Ready. The arm holds until a cycle start or a task.',
  RUNNING: 'Cycle running at full speed.',
  SLOW: 'Reduced speed: every move runs at half speed.',
  STOPPED: 'Stopped. The arm holds position; thumb up to resume.',
  ESTOPPED: 'Emergency stop: the arm is halted and teleop is off.',
};

function Andon({ state }: { state: BayState }) {
  const red = state === 'STOPPED' || state === 'ESTOPPED';
  return (
    <div className="andon" role="img" aria-label={`Stack light: ${red ? 'red' : state === 'SLOW' ? 'amber' : state === 'RUNNING' ? 'green' : 'off'}`}>
      <i className="r" data-on={red} />
      <i className="a" data-on={state === 'SLOW'} />
      <i className="g" data-on={state === 'RUNNING'} />
    </div>
  );
}

function Banner({ state }: { state: BayState }) {
  return (
    <div className="banner" data-state={state} role="status" aria-live="assertive" aria-atomic="true">
      <div className="state">
        <span className="k">Bay state</span>
        <span className="v" data-testid="bay-state">
          {state}
        </span>
      </div>
      <div className="why">{STATE_TEXT[state]}</div>
      <Andon state={state} />
      <button type="button" className="estop" onClick={() => getRuntime().applySignal('ESTOP', 'panel')} aria-label="Emergency stop the arm">
        <span className="ring" aria-hidden="true" />
        E-STOP
      </button>
    </div>
  );
}

const ARM_WINDOW_MS = 10_000;

function ResetPanel() {
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  const now = useNow();
  useEffect(() => {
    first.current?.focus();
  }, []);
  const armed = armedAt !== null && now - armedAt < ARM_WINDOW_MS;
  const left = armedAt === null ? 0 : Math.max(0, Math.ceil((ARM_WINDOW_MS - (now - armedAt)) / 1000));
  return (
    <div className="reset-panel" role="region" aria-label="Emergency stop reset">
      <h2>EMERGENCY STOP</h2>
      <p>The arm is halted and hand teleop is off. Resetting takes two steps.</p>
      <div className="reset-steps">
        <div className="reset-step" data-done={armed}>
          <span className="n">1</span>
          <span className="lbl">
            Check the bay is clear
            <small>Nothing is in the arm's path</small>
          </span>
          <button
            ref={first}
            type="button"
            className="btn small"
            onClick={() => {
              const r = getRuntime().resetEstop('arm');
              if (r.ok) {
                setArmedAt(Date.now());
                setError(null);
              } else {
                setArmedAt(null);
                setError(r.reason ?? 'Reset refused');
              }
            }}
          >
            {armed ? 'Confirmed' : 'Bay is clear'}
          </button>
        </div>
        <div className="reset-step">
          <span className="n">2</span>
          <span className="lbl">
            Reset to IDLE
            <small>{armed ? `Available for ${left} s` : 'Confirm step 1 first'}</small>
          </span>
          <button
            type="button"
            className="btn small danger"
            disabled={!armed}
            onClick={() => {
              const r = getRuntime().resetEstop('confirm');
              if (!r.ok) setError(r.reason ?? 'Reset refused');
              setArmedAt(null);
            }}
          >
            Reset
          </button>
        </div>
      </div>
      <div className="reset-note" role="alert">
        {error ?? 'Hand signals override this panel: a held fist keeps the bay stopped.'}
      </div>
    </div>
  );
}

function BayCamCard() {
  const host = useRef<HTMLDivElement>(null);
  const lastAt = useLastCaptureAt();
  const now = useNow();
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let canvas: HTMLCanvasElement;
    try {
      canvas = getBayView().bayCanvas;
    } catch {
      return;
    }
    el.appendChild(canvas);
    return () => {
      if (canvas.parentElement === el) el.removeChild(canvas);
    };
  }, []);
  const ago = lastAt === null ? null : Math.max(0, Math.round((now - lastAt) / 1000));
  return (
    <div className="baycam glass">
      <div className="row">
        <b>BAY CAMERA</b>
        <span className="chip green" style={{ height: 17, fontSize: 9.5, padding: '0 6px' }}>
          <span className="dot" />
          LIVE
        </span>
      </div>
      <div className="img" ref={host} />
      <div className="row">
        <span>Gemini's view</span>
        <span className="num">{ago === null ? '768²' : ago < 2 ? 'sent now' : `sent ${ago}s ago`}</span>
      </div>
    </div>
  );
}

function fmtMm(v: number): string {
  return `${v < 0 ? '−' : ''}${Math.abs(v)}`;
}

function Telemetry() {
  const t = useTelemetry();
  return (
    <div className="telemetry" aria-label="Arm telemetry">
      <div className="cell">
        <span className="k">Phase</span>
        <span className="v">{t.phase}</span>
      </div>
      <div className="cell">
        <span className="k">Tool centre, mm</span>
        <span className="v num">
          x {fmtMm(t.tcp_mm[0])} · y {fmtMm(t.tcp_mm[1])} · z {fmtMm(t.tcp_mm[2])}
        </span>
      </div>
      <div className="cell">
        <span className="k">Holding</span>
        <span className={`v ${t.heldName ? '' : 'dim'}`}>{t.heldName ?? 'nothing'}</span>
      </div>
      <div className="cell">
        <span className="k">Speed</span>
        <span className="v num">×{t.speed.toFixed(1)}</span>
      </div>
      <div className="cell">
        <span className="k">Jaw</span>
        <span className="v num">{Math.round(t.jawOpen * 100)}%</span>
      </div>
      <div className="cell">
        <span className="k">View</span>
        <span className="v num dim">{t.fps} fps</span>
      </div>
    </div>
  );
}

export function BayPane() {
  const state = useBayState();
  const [hintHidden, setHintHidden] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setHintHidden(true), 9000);
    return () => clearTimeout(id);
  }, []);
  return (
    <section className="pane bay-pane" aria-label="Bay">
      <Banner state={state} />
      <div className="viewport" onPointerDown={() => setHintHidden(true)}>
        <BayScene className="scene" />
        <div className="overlay-tl">
          <BayCamCard />
        </div>
        <div className="overlay-tr">
          <span className="hint glass" data-hidden={hintHidden}>
            Drag to orbit · scroll to zoom · double-click to reset
          </span>
        </div>
        <div className="overlay-bl">
          <span className="hint glass">Deck grid 1 cm · majors 5 cm</span>
        </div>
        {state === 'ESTOPPED' && <ResetPanel />}
      </div>
      <Telemetry />
    </section>
  );
}
