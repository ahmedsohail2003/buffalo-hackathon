// What leaves this machine. Counters shown in the topbar egress badge and written to the export JSON.
// micStreaming is true only while TALK is held; cellFrames counts rendered cell-camera frames sent to ER;
// webcamFrames stays 0 in this build (webcam frames never leave the machine).

export interface EgressState {
  micStreaming: boolean;
  cellFrames: number;
  webcamFrames: number;
  liveConnected: boolean;
  lastAt: number;
}

type Listener = (s: EgressState) => void;

const state: EgressState = { micStreaming: false, cellFrames: 0, webcamFrames: 0, liveConnected: false, lastAt: 0 };
const listeners = new Set<Listener>();

function notify(): void {
  state.lastAt = Date.now();
  for (const cb of listeners) {
    try { cb({ ...state }); } catch (e) { console.error('egress listener', e); }
  }
}

export const egress = {
  get(): EgressState { return { ...state }; },
  setMic(streaming: boolean): void { if (state.micStreaming !== streaming) { state.micStreaming = streaming; notify(); } },
  setLive(connected: boolean): void { if (state.liveConnected !== connected) { state.liveConnected = connected; notify(); } },
  bumpCellFrames(n = 1): void { state.cellFrames += n; notify(); },
  bumpWebcamFrames(n = 1): void { state.webcamFrames += n; notify(); },
  subscribe(cb: Listener): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; },
  _reset(): void { state.micStreaming = false; state.cellFrames = 0; state.webcamFrames = 0; state.liveConnected = false; state.lastAt = 0; listeners.clear(); },
};
