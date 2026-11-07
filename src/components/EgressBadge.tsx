import { useEffect, useState } from 'react';
import { egress, type EgressState } from '../telemetry/egress';
import './EgressBadge.css';

/** Topbar badge: exactly what has left this machine. */
export function EgressBadge() {
  const [s, setS] = useState<EgressState>(() => egress.get());
  useEffect(() => egress.subscribe(setS), []);
  return (
    <div className={`egress-badge${s.micStreaming ? ' mic-on' : ''}`} title="Microphone audio streams to Gemini Live only while TALK is held. Rendered cell-camera frames go to Gemini Robotics-ER during tasks. Webcam frames never leave this machine.">
      <span className="egress-label">LEAVING THIS MACHINE</span>
      <span className="egress-sep">·</span>
      <span className="egress-item">mic <span className={`egress-dot${s.micStreaming ? ' on' : ''}`}>{s.micStreaming ? '●' : '○'}</span></span>
      <span className="egress-sep">·</span>
      <span className="egress-item">cell frames <b>{s.cellFrames}</b></span>
      <span className="egress-sep">·</span>
      <span className="egress-item">webcam frames <b>{s.webcamFrames}</b></span>
    </div>
  );
}
