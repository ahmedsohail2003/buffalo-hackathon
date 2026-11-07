// Track B dev pages (never part of the app): ?livesmoke=1 → browser Live smoke; ?coworker=1 → CoworkerPane + EgressBadge
// against StubCell with a cell-state selector (gate.setState) so PAUSED/RESUMED/ESTOP paths can be exercised.

import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CellState } from '../contracts';
import { StubCell } from '../gemini/stubs';
import { CoworkerPane } from '../components/CoworkerPane';
import { EgressBadge } from '../components/EgressBadge';
import { getVoice } from '../gemini/live';
import { makeFlashConsole } from '../gemini/console';
import '../styles.css';

const STATES: CellState[] = ['IDLE', 'RUNNING', 'SLOW', 'STOPPED', 'ESTOPPED'];

function DevApp({ cell }: { cell: StubCell }) {
  const [state, setState] = useState<CellState>(cell.gate.state());
  const [flashConsole] = useState(() => makeFlashConsole(cell));
  React.useEffect(() => cell.gate.onChange(setState), [cell]);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 12, padding: 12, height: '100vh', boxSizing: 'border-box', background: 'var(--bg, #0b0e14)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
        <EgressBadge />
        <label style={{ color: '#8a94a8', fontSize: 12 }}>
          cell state (stub gate){' '}
          <select value={state} onChange={(e) => { const s = e.target.value as CellState; cell.gate.setState(s); if (s === 'ESTOPPED') cell.arm.abortAll('EMERGENCY STOP'); }}>
            {STATES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <div style={{ color: '#8a94a8', fontSize: 11 }}>StubCell: seed red block at (0,−230); 300 ms fake motion; static frame. Real ER calls (key from .env.local).</div>
      </div>
      <CoworkerPane cell={cell} voice={getVoice(cell)} console={flashConsole} />
    </div>
  );
}

export function mount(root: HTMLElement, q: URLSearchParams): void {
  if (q.get('livesmoke') === '1') { void import('./liveSmoke').then((m) => m.mountLiveSmoke(root)); return; }
  const cell = new StubCell(300);
  (window as unknown as { __cell: StubCell }).__cell = cell;
  createRoot(root).render(<React.StrictMode><DevApp cell={cell} /></React.StrictMode>);
}
