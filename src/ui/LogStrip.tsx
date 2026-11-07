import { useEffect, useMemo, useRef } from 'react';
import { APP_NAME } from '../brand';
import { exportJson, ledgerSummary } from '../app/bus';
import { egressSnapshot } from '../app/egress';
import { useLedger, useLog } from './hooks';

function hhmmss(t: number): string {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function download(): void {
  const blob = new Blob([exportJson({ app: APP_NAME, egress: egressSnapshot() })], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${APP_NAME.toLowerCase()}-mission-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function LogStrip() {
  const lines = useLog();
  const ledger = useLedger();
  const sum = useMemo(() => ledgerSummary(ledger), [ledger]);
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <section className="pane log-strip" aria-label="Mission log and Gemini ledger">
      <div className="log-main">
        <div className="pane-head">
          <h2 className="pane-title">Mission log</h2>
          <span className="spacer" />
          <span className="chip num">{lines.length} lines</span>
          <button type="button" className="btn small ghost" onClick={download}>
            Export JSON
          </button>
        </div>
        {lines.length === 0 ? (
          <div className="log-empty">Quiet so far.</div>
        ) : (
          <ol
            className="log-list"
            ref={list}
            aria-live="polite"
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {lines.map((l, i) => (
              <li key={`${l.t}-${i}`}>
                <span className="t num">{hhmmss(l.t)}</span>
                <span className={`kind kind-${l.kind}`}>{l.kind}</span>
                <span className="txt">{l.text}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="ledger" aria-label="Gemini ledger">
        <div className="pane-head">
          <h2 className="pane-title">Gemini ledger</h2>
        </div>
        <div className="ledger-grid">
          <div className="cell">
            <div className="k">Calls</div>
            <div className="v num">
              {sum.calls}
              {sum.failed > 0 && <span style={{ color: 'var(--red)', fontSize: 12 }}> · {sum.failed} failed</span>}
            </div>
          </div>
          <div className="cell">
            <div className="k">Last latency</div>
            <div className="v num">{sum.lastLatencyMs === null ? '—' : `${(sum.lastLatencyMs / 1000).toFixed(2)} s`}</div>
          </div>
          <div className="cell">
            <div className="k">Running cost</div>
            <div className="v num">${sum.totalUsd.toFixed(sum.totalUsd < 1 ? 4 : 2)}</div>
          </div>
          <div className="cell">
            <div className="k">Tokens</div>
            <div className="v num">{(sum.promptTokens + sum.outputTokens + sum.thoughtTokens).toLocaleString()}</div>
          </div>
        </div>
        <div className="ledger-foot">
          <span title={sum.lastModel ?? undefined}>{sum.lastModel ? `last: ${sum.lastModel}` : 'No calls yet'}</span>
          <span>every call is logged</span>
        </div>
      </div>
    </section>
  );
}
