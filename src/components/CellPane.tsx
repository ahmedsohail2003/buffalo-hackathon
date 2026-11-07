import type React from 'react';
import { useCallback } from 'react';
import { CobotCell, type CellState } from '../cell/cellSim';
import { CellScene } from './CellScene';
import { getArmRuntime } from '../app/refs';

const BANNERS: Record<
  CellState,
  { title: string; desc: string; color: string; flash?: boolean }
> = {
  IDLE: {
    title: 'IDLE',
    desc: 'Awaiting CYCLE START — hold the V gesture (key 5). A task auto-starts the cycle.',
    color: '#8A94A8',
  },
  RUNNING: {
    title: 'RUNNING',
    desc: 'Arm tasks accepted.',
    color: '#34D399',
  },
  SLOW: {
    title: 'SLOW MODE',
    desc: 'Arm moving at 50% speed.',
    color: '#F59E0B',
  },
  STOPPED: {
    title: 'STOPPED',
    desc: 'Arm frozen mid-move; Gemini tasks wait for thumbs-up (key 3).',
    color: '#EF4444',
  },
  ESTOPPED: {
    title: 'EMERGENCY STOP',
    desc: 'Cell locked out; task aborted. Two-step reset required at the panel below.',
    color: '#EF4444',
    flash: true,
  },
};

interface CellPaneProps {
  cellRef: React.MutableRefObject<CobotCell | null>;
  cellState: CellState;
  resetStep: 0 | 1;
  cyclesCompleted: number;
  speedPct: number;
  onEstopResetArm: () => void;
  onEstopResetConfirm: () => void;
}

export function CellPane(props: CellPaneProps) {
  const {
    cellState,
    resetStep,
    cyclesCompleted,
    speedPct,
    onEstopResetArm,
    onEstopResetConfirm,
  } = props;
  const banner = BANNERS[cellState];
  const rt = getArmRuntime();
  const { cellRef } = props;
  // Stable identity: CellScene mounts its WebGL renderers once per (data, arm, objects).
  const getCell = useCallback(() => cellRef.current, [cellRef]);

  return (
    <section className="pane" aria-label="Robot work cell simulation">
      <div className="pane-head">
        <h2>Work cell — SO-ARM100</h2>
        <span className="badge">3D kinematic model — SO-ARM100 meshes, no physics, not a real robot</span>
        <div className="spacer" />
      </div>

      <div
        className={banner.flash ? 'banner flash' : 'banner'}
        style={{ borderLeftColor: banner.color }}
        role="status"
        aria-live="polite"
      >
        <span className="state-name" style={{ color: banner.color }}>
          {banner.title}
        </span>
        <span className="state-desc">{banner.desc}</span>
      </div>

      <div className="cell-stage">
        {rt ? (
          <CellScene data={rt.data} arm={rt.arm} objects={rt.objects} getCell={getCell} />
        ) : (
          <div className="cell-loading">loading arm…</div>
        )}
        <Andon state={cellState} />
        {cellState === 'ESTOPPED' && (
          <div className="estop-panel" role="alert" aria-label="E-stop reset">
            <div className="estop-title">EMERGENCY STOP ACTIVE</div>
            <p>
              Recovery is deliberately not gesture-driven: a misread hand pose
              must never re-energize a locked-out cell, so the reset is an
              explicit two-step act at the panel. The cell returns to IDLE,
              not to RUNNING.
            </p>
            <div className="estop-actions">
              <button
                type="button"
                onClick={onEstopResetArm}
                disabled={resetStep === 1}
                className={resetStep === 1 ? 'armed-step' : ''}
              >
                {resetStep === 1 ? 'STEP 1 DONE — RESET LATCHED' : 'STEP 1 · RESET E-STOP'}
              </button>
              <button
                type="button"
                onClick={onEstopResetConfirm}
                disabled={resetStep !== 1}
              >
                STEP 2 · CONFIRM — RETURN TO IDLE
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="cell-foot">
        <span>CYCLES {cyclesCompleted}</span>
        <span>SPEED {speedPct}%</span>
        <PhaseReadout />
        <div className="spacer" />
        <span>STOP freezes the arm · SLOW halves speed · E-STOP aborts and locks out</span>
      </div>
    </section>
  );
}

/** Arm phase label, re-rendered with parent syncs (~8 Hz is enough). */
function PhaseReadout() {
  const rt = getArmRuntime();
  const snap = rt?.arm.snapshot();
  const tcp = snap ? snap.tcp.map((v) => Math.round(v * 1000)).join(',') : '—';
  return (
    <span>
      PHASE {snap ? snap.phase : 'loading'} · TCP ({tcp}) mm
      {snap?.heldId ? ` · HOLDING ${snap.heldId}` : ''}
    </span>
  );
}

function Andon({ state }: { state: CellState }) {
  const lamps = [
    {
      cls: 'red',
      label: 'STOP',
      on: state === 'STOPPED' || state === 'IDLE' || state === 'ESTOPPED',
      flashing: state === 'ESTOPPED',
    },
    { cls: 'amber', label: 'SLOW', on: state === 'SLOW', flashing: false },
    { cls: 'green', label: 'RUN', on: state === 'RUNNING', flashing: false },
  ];
  return (
    <div className="andon" role="img" aria-label={`Andon light: ${state}`}>
      {lamps.map((l) => (
        <div
          key={l.cls}
          className={`lamp ${l.cls}${l.on ? ' on' : ''}${l.flashing ? ' flashing' : ''}`}
        >
          <span className="bulb" />
          <span className="lamp-label">{l.label}</span>
        </div>
      ))}
      <span className="andon-state">{state}</span>
    </div>
  );
}
