import { useEffect, useRef } from 'react';
import type { LogLine, UiSync } from '../App';
import { COMMAND_COLORS, COMMAND_LABELS } from '../gesture/gestures';

interface TelemetryStripProps {
  ui: UiSync;
  uiLog: LogLine[];
  dwellMs: number;
  estopDwellMs: number;
  onExport: () => void;
  /** Dev only: save docs/gates evidence (G{n}-cell.jpg, G{n}-export.json, G{n}-log.txt). */
  onEvidence?: (gate: number) => void;
}

function fmtTs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  const mmm = String(Math.floor(ms % 1000)).padStart(3, '0');
  return `${mm}:${ss}.${mmm}`;
}

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const fmtUsd = (usd: number) => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}`;

export function TelemetryStrip({
  ui,
  uiLog,
  dwellMs,
  estopDwellMs,
  onExport,
  onEvidence,
}: TelemetryStripProps) {
  const { snapshot, lastRaw, lastFired, gemini, arm } = ui;
  const c = snapshot.counters;
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [uiLog]);

  return (
    <footer className="telemetry" aria-label="Session telemetry">
      <div className="tcell">
        <h3>Last recognized gesture</h3>
        <div className="big">
          {lastRaw ? lastRaw.label.replace('_', ' ') : '—'}
        </div>
        <div className="sub">
          {lastRaw
            ? `confidence ${lastRaw.confidence.toFixed(2)}`
            : 'no detections yet'}
        </div>
        <div className="sub">raw detections {c.raw}</div>
      </div>

      <div className="tcell">
        <h3>Dwell arming</h3>
        <div
          className="meter"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(snapshot.dwellProgress * 100)}
          aria-label="Dwell progress"
        >
          <div
            className="fill"
            style={{
              width: `${Math.round(snapshot.dwellProgress * 100)}%`,
              background: snapshot.command
                ? COMMAND_COLORS[snapshot.command]
                : '#7DD3FC',
            }}
          />
        </div>
        <div className="sub">
          {snapshot.phase === 'arming' && snapshot.command
            ? `${COMMAND_LABELS[snapshot.command]} — ${Math.round(
                snapshot.dwellProgress * snapshot.requiredDwellMs,
              )} / ${snapshot.requiredDwellMs} ms`
            : `phase ${snapshot.phase.toUpperCase()}`}
        </div>
        <div className="sub">
          dwell {dwellMs} ms · e-stop {estopDwellMs} ms · refractory 1200 ms
        </div>
      </div>

      <div className="tcell">
        <h3>Session counters</h3>
        <div className="stat-row">
          <div className="stat">
            <span className="v">{c.fired}</span>
            <span className="k">fired</span>
          </div>
          <div className="stat">
            <span className="v">{c.falseStarts}</span>
            <span className="k">false starts</span>
          </div>
          <div className="stat">
            <span className="v">
              {c.avgLatencyMs === null ? '—' : Math.round(c.avgLatencyMs)}
            </span>
            <span className="k">avg ms to fire</span>
          </div>
        </div>
        <div className="sub">
          last command{' '}
          {lastFired ? COMMAND_LABELS[lastFired.command] : '—'}
        </div>
      </div>

      <div className="tcell gemini-cell" aria-label="Gemini in the loop">
        <h3>Gemini in the loop</h3>
        <div className="big">{gemini.phase}</div>
        <div className="sub">{gemini.stepText || (arm ? `arm ${arm.phase}` : 'arm loading')}</div>
        <div className="stat-row">
          <div className="stat">
            <span className="v">{gemini.calls}</span>
            <span className="k">calls{gemini.errors ? ` · ${gemini.errors} err` : ''}</span>
          </div>
          <div className="stat">
            <span className="v">{gemini.lastLatencyMs === null ? '—' : fmtMs(gemini.lastLatencyMs)}</span>
            <span className="k">
              {gemini.lastModel
                ? `${gemini.lastPurpose ?? ''} ${gemini.lastModel.replace('gemini-', '').replace('-preview', '')}${gemini.lastLevel ? ` · ${gemini.lastLevel}` : ''}`
                : 'last call'}
            </span>
          </div>
          <div className="stat">
            <span className="v">{fmtUsd(gemini.costUsd)}</span>
            <span className="k">running cost</span>
          </div>
        </div>
      </div>

      <div className="tcell">
        <h3>
          Command log
          <div className="spacer" />
          {onEvidence && (
            <span className="evidence" title="dev only: save docs/gates evidence files">
              {[2, 3, 4].map((g) => (
                <button key={g} type="button" className="export" onClick={() => onEvidence(g)}>
                  G{g}
                </button>
              ))}
            </span>
          )}
          <button type="button" className="export" onClick={onExport}>
            Export JSON
          </button>
        </h3>
        <div className="log" ref={logRef} aria-live="polite">
          {uiLog.length === 0 && (
            <span className="empty">
              — gestures, cell events, Gemini calls and arm tool calls appear here with
              timestamps —
            </span>
          )}
          {uiLog.map((l) => (
            <div key={l.id} className={`line kind-${l.kind}`}>
              <span className="ts">{fmtTs(l.t)}</span> {l.text}
            </div>
          ))}
        </div>
      </div>
    </footer>
  );
}
