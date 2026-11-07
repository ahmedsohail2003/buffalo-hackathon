// Hand-pane slot for teleop: the on/off toggle, a one-line status chip, the camera-mode hint and,
// in simulated mode, the simulated hand pad. Reads the controller's status at ~8 Hz.

import { useEffect, useState } from 'react';
import type { TeleopStatus } from '../contracts';
import { SimHandPad, type TeleopUiProps } from './SimHandPad';
import './teleop.css';

export function TeleopPanel({ teleop, mode }: TeleopUiProps) {
  const [st, setSt] = useState<TeleopStatus | null>(() => teleop?.status() ?? null);
  useEffect(() => {
    if (!teleop) return;
    setSt(teleop.status());
    const id = window.setInterval(() => setSt(teleop.status()), 125);
    return () => window.clearInterval(id);
  }, [teleop]);

  const on = st?.enabled === true;
  const toggle = () => {
    if (!teleop) return;
    if (teleop.status().enabled) teleop.disable('operator');
    else teleop.enable();
    setSt(teleop.status());
  };

  return (
    <div className="teleop-panel">
      <div className="teleop-row">
        <button
          type="button"
          className={on ? 'teleop-toggle on' : 'teleop-toggle'}
          aria-pressed={on}
          disabled={!teleop}
          title="Steer the gripper with your hand; pinch to pick, pinch again to place"
          onClick={toggle}
        >
          Hand teleop: {on ? 'ON' : 'OFF'}
        </button>
        {st && (on || st.note) && (
          <div className={`teleop-chip mode-${st.mode}`} role="status" aria-live="polite">
            <span className="teleop-mode">{st.mode}</span>
            <span className="teleop-note" title={st.note}>
              {st.note || 'teleop off'}
            </span>
          </div>
        )}
      </div>
      {on && mode === 'camera' && (
        <div className="teleop-hint">
          Steer with a loosely cupped hand (a flat open palm still means STOP); pinch thumb to index, other fingers out,
          to pick or place.
        </div>
      )}
      {on && mode === 'sim' && <SimHandPad teleop={teleop} mode={mode} />}
    </div>
  );
}
