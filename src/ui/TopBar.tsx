import { APP_NAME, BAY_CALLSIGN, TAGLINE } from '../brand';
import { egressSummary, formatBytes } from '../app/egress';
import { useEgress, useInputMode, useNow } from './hooks';

const START = Date.now();

function BrandMark() {
  return (
    <svg className="brand-mark" width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
      <circle cx="14" cy="14" r="12.5" fill="none" stroke="#38bdf8" strokeOpacity="0.45" />
      <circle cx="14" cy="14" r="8" fill="none" stroke="#38bdf8" strokeOpacity="0.25" strokeDasharray="2 3" />
      <path d="M14 5.5 L15.6 12.4 L22.5 14 L15.6 15.6 L14 22.5 L12.4 15.6 L5.5 14 L12.4 12.4 Z" fill="#e2e8f0" />
      <circle cx="22.2" cy="6.6" r="1.6" fill="#f59e0b" />
    </svg>
  );
}

function met(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function TopBar() {
  const egress = useEgress();
  const mode = useInputMode();
  const now = useNow();
  const egressDetail =
    egress.requests === 0
      ? 'Nothing has left this machine yet. Webcam video is processed here and never sent.'
      : `Sent so far: ${egress.requests} requests, ${formatBytes(egress.bytes)}. ` +
        Object.entries(egress.byDest)
          .map(([d, v]) => `${d}: ${v.requests} (${formatBytes(v.bytes)})`)
          .join(', ') +
        '. Webcam video is processed here and never sent.';
  return (
    <header className="topbar">
      <div className="brand">
        <BrandMark />
        <h1 className="brand-name">{APP_NAME}</h1>
        <div className="brand-sub">
          <span className="tagline">{TAGLINE}</span>
          <span className="callsign">{BAY_CALLSIGN} · deep-space station</span>
        </div>
      </div>
      <div className="spacer" />
      <div className="topbar-badges">
        <span className="chip amber" title="The arm is a kinematic simulation of the SO-101: no physics engine, not a real robot.">
          <span className="dot" />
          SIMULATED ARM · NO PHYSICS
        </span>
        <span className="chip badge-egress" title={egressDetail} aria-label={`Leaving this machine: ${egressSummary(egress)}`}>
          Leaving this machine: <b>{egressSummary(egress)}</b>
        </span>
        <span className={`chip ${mode === 'camera' ? 'cyan' : ''}`} title={mode === 'camera' ? 'Hand tracked by the webcam, on this device' : 'Hand signals come from the keypad (keys 1-5)'}>
          <span className="dot" />
          {mode === 'camera' ? 'INPUT · CAMERA, ON-DEVICE' : 'INPUT · SIMULATED KEYPAD'}
        </span>
      </div>
      <div className="met" aria-label="Mission elapsed time">
        <span className="label">MET</span>
        <span className="value num">{met(now - START)}</span>
      </div>
    </header>
  );
}
