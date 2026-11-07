import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_CONFIG,
  GestureStateMachine,
  type GestureLabel,
  type MachineEvent,
  type Snapshot,
} from './gesture/stateMachine';
import { COMMAND_LABELS, KEY_TO_GESTURE } from './gesture/gestures';
import { CobotCell, type CellState } from './cell/cellSim';
import { loadArmData } from './arm/armData';
import { buildArmModel } from './arm/armModel';
import { reachProbe } from './arm/ik';
import { ArmController } from './arm/controller';
import { CellGate } from './arm/gate';
import { ObjectRegistry } from './cell/objects';
import {
  setArmRuntime,
  setCellApi,
  getCellApi,
  setCellGetter,
  onSceneApi,
  type ArmRuntime,
} from './app/refs';
import { startLoop } from './app/loop';
import type { CellApi } from './contracts';
import { CoworkerPane } from './components/CoworkerPane';
import { makeFlashConsole } from './gemini/console';
import { EgressBadge } from './components/EgressBadge';
import { getVoice } from './gemini/live';
import { bus } from './telemetry/bus';
import { taskStore } from './gemini/erLoop';
import { DEMO, ER_MODEL, FLASH_MODEL, LIVE_MODEL } from './gemini/models';
import {
  DEMO_CONFIDENCE,
  DEMO_DWELL_MS,
  DEMO_STEPS,
  DEMO_TOTAL_MS,
} from './demo/script';
import { HandPane } from './components/HandPane';
import { CellPane } from './components/CellPane';
import { TelemetryStrip } from './components/TelemetryStrip';
import { AboutPanel } from './components/AboutPanel';
import type { LastFired } from './components/ring';

export type InputMode = 'sim' | 'camera';

export interface LogLine {
  id: number;
  t: number; // ms since session start
  kind: 'armed' | 'fired' | 'false_start' | 'info' | 'gemini' | 'tool' | 'reject' | 'live';
  text: string;
}

/** Narration state for the guided demo overlay. */
export interface DemoUi {
  idx: number;
  total: number;
  caption: string;
  totalMs: number;
}

/** "Gemini in the loop" summary for the 5th telemetry cell (fed from the telemetry bus). */
export interface GeminiUi {
  calls: number;
  errors: number;
  lastLatencyMs: number | null;
  lastModel: string | null;
  lastLevel: string | null;
  lastPurpose: string | null;
  costUsd: number;
  phase: string;
  stepText: string;
}

export interface UiSync {
  snapshot: Snapshot;
  cellState: CellState;
  resetStep: 0 | 1;
  cyclesCompleted: number;
  speedPct: number;
  lastFired: LastFired | null;
  lastRaw: { label: GestureLabel; confidence: number } | null;
  arm: { phase: string; heldId: string | null; tcpMm: [number, number, number] } | null;
  gemini: GeminiUi;
}

const GEMINI_UI_EMPTY: GeminiUi = {
  calls: 0,
  errors: 0,
  lastLatencyMs: null,
  lastModel: null,
  lastLevel: null,
  lastPurpose: null,
  costUsd: 0,
  phase: 'idle',
  stepText: '',
};

const shortModel = (m: string) =>
  m === ER_MODEL ? 'ER-2' : m === FLASH_MODEL ? 'Flash' : m === LIVE_MODEL ? 'Live' : m.replace(/^gemini-/, '');

/** Snapshot for the "Gemini in the loop" cell, from the telemetry bus and the ER task store (~8 Hz). */
function computeGeminiUi(): GeminiUi {
  const t = bus.totals();
  const entries = bus.entries();
  const last = entries.length ? entries[entries.length - 1] : null;
  const task = taskStore.get();
  const stepText = task.active
    ? `${task.phase}${task.step ? ` step ${task.step}${task.of ? `/${task.of}` : ''}` : ''}${task.text ? ` — "${task.text}"` : ''}`
    : task.report
      ? `${task.report.ok ? '✓' : '✗'} ${task.report.summary}`
      : '';
  return {
    calls: t.calls,
    errors: t.errors,
    costUsd: t.costUsd,
    lastLatencyMs: last ? last.latencyMs : null,
    lastModel: last ? shortModel(last.model) : null,
    lastLevel: last?.thinkingLevel ?? null,
    lastPurpose: last?.purpose ?? null,
    phase: task.active ? task.phase : task.report ? 'done' : 'idle',
    stepText,
  };
}

const RAW_LOG_CAP = 4000;

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Gemini part of the export JSON; replaced by the telemetry bus payload once Track B lands. */
type GeminiExport = () => { gemini: unknown[]; geminiTotals: unknown; fallbacks: unknown[]; demoMode: unknown; trace?: unknown[] };

export default function App() {
  // Mutable engine state lives in refs; canvases read it every frame and
  // React state is synced at ~8 Hz for the DOM parts.
  const machineRef = useRef<GestureStateMachine | null>(null);
  if (machineRef.current === null) {
    machineRef.current = new GestureStateMachine();
  }
  const cellRef = useRef<CobotCell | null>(null);
  if (cellRef.current === null) cellRef.current = new CobotCell();

  const heldRef = useRef<GestureLabel | null>(null);
  const confRef = useRef(0.92);
  const modeRef = useRef<InputMode>('sim');
  const snapRef = useRef<Snapshot>(machineRef.current.snapshot(0));
  const lastFiredRef = useRef<LastFired | null>(null);
  const lastRawRef = useRef<{ label: GestureLabel; confidence: number } | null>(
    null,
  );
  const sessionLogRef = useRef<MachineEvent[]>([]);
  const rawLoggedRef = useRef(0);
  const t0Ref = useRef<number | null>(null);
  const logIdRef = useRef(1);

  const demoActiveRef = useRef(false);
  const demoTimersRef = useRef<number[]>([]);

  const [mode, setMode] = useState<InputMode>('sim');
  const [simConfidence, setSimConfidence] = useState(0.92);
  const [dwellMs, setDwellMsState] = useState(DEFAULT_CONFIG.dwellMs);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [cameraNote, setCameraNote] = useState<string | null>(null);
  const [demoUi, setDemoUi] = useState<DemoUi | null>(null);
  const [uiLog, setUiLog] = useState<LogLine[]>([]);
  const [ui, setUi] = useState<UiSync>(() => ({
    snapshot: machineRef.current!.snapshot(0),
    cellState: 'IDLE',
    resetStep: 0,
    cyclesCompleted: 0,
    speedPct: 0,
    lastFired: null,
    lastRaw: null,
    arm: null,
    gemini: GEMINI_UI_EMPTY,
  }));

  const sessionT = useCallback((t: number) => t - (t0Ref.current ?? t), []);

  const appendLog = useCallback(
    (lines: Omit<LogLine, 'id'>[]) => {
      if (lines.length === 0) return;
      setUiLog((prev) => [
        ...prev.slice(-200),
        ...lines.map((l) => ({ ...l, id: logIdRef.current++ })),
      ]);
    },
    [setUiLog],
  );

  // Kinematic arm runtime (3D SO-ARM100): built once arm-data.json resolves.
  const rtRef = useRef<ArmRuntime | null>(null);
  const geminiExportRef = useRef<GeminiExport>(() => ({ ...bus.exportPayload(), demoMode: { ...DEMO } }));
  const [cellApi, setCellApiState] = useState<CellApi | null>(null);
  const voice = useMemo(() => (cellApi ? getVoice(cellApi) : null), [cellApi]);
  const flashConsole = useMemo(() => (cellApi ? makeFlashConsole(cellApi) : undefined), [cellApi]);
  useEffect(() => {
    let alive = true;
    let offScene: (() => void) | null = null;
    setCellGetter(() => cellRef.current);
    loadArmData()
      .then((data) => {
        if (!alive || rtRef.current) return;
        const model = buildArmModel(data);
        const objects = new ObjectRegistry(data.block);
        objects.reachProbe = (xy, h) => reachProbe(model, xy, h);
        const gate = new CellGate(() => cellRef.current!, {
          onLine: (l) =>
            appendLog([
              { t: sessionT(performance.now()), kind: l.kind === 'reject' ? 'reject' : 'info', text: l.text },
            ]),
        });
        const arm = new ArmController(model, objects, gate);
        const rt: ArmRuntime = { data, arm, objects, gate };
        rtRef.current = rt;
        setArmRuntime(rt);
        offScene = onSceneApi((scene) => {
          const api: CellApi | null = scene
            ? {
                arm,
                objects,
                gate,
                capture: () => scene.capture(),
                projectMujoco: (p) => scene.projectMujoco(p),
                unprojectER: (yx, z) => scene.unprojectER(yx, z),
              }
            : null;
          setCellApi(api);
          setCellApiState(api);
        });
        appendLog([
          { t: sessionT(performance.now()), kind: 'info', text: 'ARM READY — SO-ARM100 kinematic model loaded (FK/IK validated against MuJoCo fixtures)' },
        ]);
      })
      .catch((e: unknown) => {
        appendLog([
          { t: sessionT(performance.now()), kind: 'reject', text: `ARM LOAD FAILED — ${e instanceof Error ? e.message : String(e)}` },
        ]);
      });
    return () => {
      alive = false;
      offScene?.();
    };
  }, [appendLog, sessionT]);

  // Every Gemini call, tool call, rejection and Live line from the telemetry bus → command log.
  useEffect(
    () =>
      bus.subscribe((ev) => {
        if (!ev.line) return;
        appendLog([{ t: sessionT(performance.now()), kind: ev.line.kind, text: ev.line.text }]);
      }),
    [appendLog, sessionT],
  );

  /**
   * Single ingestion point for classification samples. Real (camera) and
   * simulated input both land here, so everything downstream — state
   * machine, cell commands, logging — is identical for the two paths.
   */
  const pushSample = useCallback(
    (label: GestureLabel | null, confidence: number, t: number) => {
      const machine = machineRef.current!;
      const cell = cellRef.current!;
      const events = machine.sample(label, confidence, t);
      if (events.length === 0) return;
      const lines: Omit<LogLine, 'id'>[] = [];
      for (const ev of events) {
        if (ev.type === 'raw') {
          lastRawRef.current = { label: ev.label, confidence: ev.confidence };
          if (rawLoggedRef.current < RAW_LOG_CAP) {
            sessionLogRef.current.push(ev);
            rawLoggedRef.current += 1;
          }
          continue;
        }
        sessionLogRef.current.push(ev);
        const ts = sessionT(ev.t);
        if (ev.type === 'armed') {
          lines.push({
            t: ts,
            kind: 'armed',
            text: `ARMED ${COMMAND_LABELS[ev.command]} — hold ${ev.requiredDwellMs} ms`,
          });
        } else if (ev.type === 'false_start') {
          lines.push({
            t: ts,
            kind: 'false_start',
            text: `FALSE START ${COMMAND_LABELS[ev.command]} — released at ${Math.round(ev.heldMs)} ms`,
          });
        } else {
          const stateBefore = cell.state;
          const accepted = cell.apply(ev.command);
          rtRef.current?.gate.notify();
          if (ev.command === 'EMERGENCY_STOP' && accepted) {
            rtRef.current?.arm.abortAll('EMERGENCY STOP');
            lines.push({ t: ts, kind: 'reject', text: 'ABORTED: EMERGENCY STOP — arm frozen, pending motion rejected' });
          }
          lastFiredRef.current = { command: ev.command, t: ev.t };
          lines.push({
            t: ts,
            kind: 'fired',
            text: `FIRED ${COMMAND_LABELS[ev.command]} (${Math.round(ev.latencyMs)} ms hold)${
              accepted ? '' : ` — no effect, cell ${stateBefore}`
            }`,
          });
        }
      }
      appendLog(lines);
    },
    [appendLog, sessionT],
  );

  const syncUi = useCallback(() => {
    const cell = cellRef.current!;
    setUi({
      snapshot: snapRef.current,
      cellState: cell.state,
      resetStep: cell.resetStep,
      cyclesCompleted: cell.cyclesCompleted,
      speedPct: Math.round(cell.speedFactor() * 100),
      lastFired: lastFiredRef.current,
      lastRaw: lastRawRef.current,
      arm: (() => {
        const a = rtRef.current?.arm;
        if (!a) return null;
        const s = a.snapshot();
        return { phase: s.phase, heldId: s.heldId, tcpMm: a.tcpMm() as [number, number, number] };
      })(),
      gemini: computeGeminiUi(),
    });
  }, []);

  // Main loop: simulated sampling, cell clock, periodic React sync.
  useEffect(() => {
    let last = performance.now();
    let lastSync = 0;
    const step = (now: number) => {
      if (t0Ref.current === null) t0Ref.current = now;
      if (modeRef.current === 'sim') {
        const held = heldRef.current;
        // The guided demo pins the synthetic confidence so a low slider
        // setting cannot make the scripted story silently fail.
        const conf = demoActiveRef.current ? DEMO_CONFIDENCE : confRef.current;
        pushSample(held, held !== null ? conf : 0, now);
      }
      snapRef.current = machineRef.current!.snapshot(now);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      cellRef.current!.tick(dt);
      rtRef.current?.arm.step(dt, cellRef.current!.speedFactor());
      if (now - lastSync >= 125) {
        lastSync = now;
        syncUi();
      }
    };
    return startLoop(step);
  }, [pushSample, syncUi]);

  /* ------------------------------------------------------------------ */
  /* Guided demo: a scripted ~45 s story played through the simulated    */
  /* input path (same state machine, cell, and logging as live input).   */
  /* ------------------------------------------------------------------ */

  const stopDemo = useCallback(
    (reason: 'finished' | 'canceled') => {
      if (!demoActiveRef.current) return;
      demoActiveRef.current = false;
      demoTimersRef.current.forEach((id) => window.clearTimeout(id));
      demoTimersRef.current = [];
      heldRef.current = null;
      setDemoUi(null);
      appendLog([
        {
          t: sessionT(performance.now()),
          kind: 'info',
          text:
            reason === 'finished'
              ? 'GUIDED DEMO finished — cell idle, you have control'
              : 'GUIDED DEMO canceled — you have control',
        },
      ]);
    },
    [appendLog, sessionT],
  );

  const setInputMode = useCallback(
    (m: InputMode, note?: string) => {
      if (m === 'camera') stopDemo('canceled');
      heldRef.current = null;
      modeRef.current = m;
      setMode(m);
      if (note !== undefined) setCameraNote(note);
    },
    [stopDemo],
  );

  /** User-initiated hold (keyboard key or keypad press). Takes over from a
   *  running demo instead of fighting it. */
  const holdGesture = useCallback(
    (g: GestureLabel) => {
      if (demoActiveRef.current) stopDemo('canceled');
      heldRef.current = g;
    },
    [stopDemo],
  );

  const releaseGesture = useCallback((g: GestureLabel) => {
    if (heldRef.current === g) heldRef.current = null;
  }, []);

  // Keyboard: keys 1–5 hold a simulated gesture while pressed. Escape closes
  // the About panel or cancels a running demo. Any gesture key cancels the
  // demo and takes over immediately.
  useEffect(() => {
    const isTyping = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    };
    const down = (e: KeyboardEvent) => {
      if (isTyping(e)) return; // keyboard guard: typing in the coworker input never fires a gesture
      if (e.key === 'Escape') {
        setAboutOpen(false);
        stopDemo('canceled');
        return;
      }
      if (e.repeat) return;
      const g = KEY_TO_GESTURE[e.key];
      if (g && modeRef.current === 'sim') {
        holdGesture(g);
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const g = KEY_TO_GESTURE[e.key];
      if (g) releaseGesture(g);
    };
    const blur = () => {
      if (!demoActiveRef.current) heldRef.current = null;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [holdGesture, releaseGesture, stopDemo]);

  // Detect whether a camera exists; simulated input is the default either
  // way (?sim=1 forces it), and the camera is strictly opt-in.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') === '1') {
      setCameraNote('Guided demo — simulated input.');
      return;
    }
    if (params.get('sim') === '1') {
      setCameraNote('Simulated input forced via ?sim=1.');
      return;
    }
    if (!navigator.mediaDevices?.enumerateDevices) {
      setCameraNote('No camera API in this environment — simulated input active.');
      return;
    }
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        const cams = devices.filter((d) => d.kind === 'videoinput');
        setCameraNote(
          cams.length === 0
            ? 'No camera detected — simulated input active.'
            : 'Camera detected — click "Enable camera" for live gestures.',
        );
      })
      .catch(() =>
        setCameraNote('Camera check failed — simulated input active.'),
      );
  }, []);

  // ?present=1: projector mode (taller telemetry, larger mono text) for the demo.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('present') !== '1') return;
    document.body.classList.add('present');
    return () => document.body.classList.remove('present');
  }, []);

  const onDwellMs = useCallback((v: number) => {
    machineRef.current!.setDwellMs(v);
    setDwellMsState(v);
  }, []);

  const onSimConfidence = useCallback((v: number) => {
    confRef.current = v;
    setSimConfidence(v);
  }, []);

  const onEstopResetArm = useCallback(() => {
    cellRef.current!.estopResetArm();
    rtRef.current?.gate.notify();
    appendLog([
      { t: sessionT(performance.now()), kind: 'info', text: 'E-STOP RESET step 1 of 2 (panel)' },
    ]);
    syncUi();
  }, [appendLog, sessionT, syncUi]);

  const onEstopResetConfirm = useCallback(() => {
    cellRef.current!.estopResetConfirm();
    rtRef.current?.gate.notify();
    appendLog([
      { t: sessionT(performance.now()), kind: 'info', text: 'E-STOP RESET confirmed — cell IDLE' },
    ]);
    syncUi();
  }, [appendLog, sessionT, syncUi]);

  const startDemo = useCallback(() => {
    if (demoActiveRef.current) return;
    setAboutOpen(false);
    setInputMode('sim', 'Guided demo running — scripted simulated input.');
    onDwellMs(DEMO_DWELL_MS); // deterministic timing; slider shows the change
    // Fresh cell so the story starts from IDLE. Session counters and the
    // event log are kept — the demo's commands are real pipeline traffic.
    cellRef.current = new CobotCell();
    rtRef.current?.arm.abortAll('guided demo');
    rtRef.current?.objects.reset();
    rtRef.current?.gate.notify();
    lastFiredRef.current = null;
    demoActiveRef.current = true;
    appendLog([
      {
        t: sessionT(performance.now()),
        kind: 'info',
        text: 'GUIDED DEMO started — scripted simulated input; cell reset to IDLE',
      },
    ]);
    let at = 0;
    DEMO_STEPS.forEach((step, i) => {
      demoTimersRef.current.push(
        window.setTimeout(() => {
          if (!demoActiveRef.current) return;
          setDemoUi({
            idx: i + 1,
            total: DEMO_STEPS.length,
            caption: step.caption,
            totalMs: DEMO_TOTAL_MS,
          });
          if (step.action === 'resetArm') onEstopResetArm();
          if (step.action === 'resetConfirm') onEstopResetConfirm();
          if (step.hold) {
            const g = step.hold;
            heldRef.current = g;
            demoTimersRef.current.push(
              window.setTimeout(() => {
                if (demoActiveRef.current && heldRef.current === g) {
                  heldRef.current = null;
                }
              }, step.holdMs ?? 0),
            );
          }
        }, at),
      );
      at += step.durMs;
    });
    demoTimersRef.current.push(
      window.setTimeout(() => stopDemo('finished'), at),
    );
    syncUi();
  }, [
    appendLog,
    onDwellMs,
    onEstopResetArm,
    onEstopResetConfirm,
    sessionT,
    setInputMode,
    stopDemo,
    syncUi,
  ]);

  // ?demo=1 auto-plays the guided demo shortly after load.
  const startDemoRef = useRef(startDemo);
  startDemoRef.current = startDemo;
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') !== '1') return;
    const id = window.setTimeout(() => startDemoRef.current(), 600);
    return () => window.clearTimeout(id);
  }, []);

  const buildExport = useCallback(() => {
    const machine = machineRef.current!;
    const rt = rtRef.current;
    return {
      tool: 'The cell — voice-instructed SO-ARM100 work cell (HandSignal gesture safety channel + Gemini)',
      exportedAt: new Date().toISOString(),
      note:
        'Gesture events (simulated and/or live camera, raw entries capped at 4000), cell state, object registry, arm snapshot and every Gemini call with latency, tokens and cost.',
      config: machine.getConfig(),
      counters: machine.counters(),
      events: sessionLogRef.current,
      cell: {
        state: cellRef.current?.state ?? null,
        objects: rt?.objects.list() ?? [],
        arm: rt?.arm.snapshot() ?? null,
      },
      ...geminiExportRef.current(),
    };
  }, []);

  const onExport = useCallback(() => {
    download('cell-session.json', new Blob([JSON.stringify(buildExport(), null, 2)], { type: 'application/json' }));
  }, [buildExport]);

  /** Dev only: gate evidence files for docs/gates (moved there by hand from Downloads). */
  const onEvidence = useCallback(
    (gate: number) => {
      const api = getCellApi();
      if (api) {
        const b64 = api.capture().jpegB64;
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        download(`G${gate}-cell.jpg`, new Blob([bytes], { type: 'image/jpeg' }));
      }
      download(`G${gate}-export.json`, new Blob([JSON.stringify(buildExport(), null, 2)], { type: 'application/json' }));
      const tail = uiLog.slice(-50).map((l) => `${(l.t / 1000).toFixed(3)}s [${l.kind}] ${l.text}`).join('\n');
      download(`G${gate}-log.txt`, new Blob([tail + '\n'], { type: 'text/plain' }));
    },
    [buildExport, uiLog],
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          The <span>cell</span>
        </div>
        <div className="tagline">
          Voice-instructed SO-ARM100 work cell — Gemini sees, plans and
          verifies; on-device hand gestures are the safety channel
        </div>
        <EgressBadge />
        <div className="spacer" />
        <span className={mode === 'sim' ? 'badge sim' : 'badge live'}>
          {mode === 'sim' ? 'Simulated input' : 'Camera input'}
        </span>
        <button
          type="button"
          className={demoUi ? 'demo-btn running' : 'demo-btn'}
          onClick={() => (demoUi ? stopDemo('canceled') : startDemo())}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden="true"
            fill="currentColor"
          >
            {demoUi ? (
              <rect x="1.5" y="1.5" width="7" height="7" rx="1" />
            ) : (
              <path d="M2 1.2 8.8 5 2 8.8Z" />
            )}
          </svg>
          {demoUi ? 'Stop demo' : 'Guided demo · 45 s'}
        </button>
        <button type="button" onClick={() => setAboutOpen(true)}>
          About this study
        </button>
      </header>

      <main className="main">
        <HandPane
          mode={mode}
          snapRef={snapRef}
          heldRef={heldRef}
          lastFiredRef={lastFiredRef}
          simConfidence={simConfidence}
          onSimConfidence={onSimConfidence}
          dwellMs={dwellMs}
          onDwellMs={onDwellMs}
          minConfidence={DEFAULT_CONFIG.minConfidence}
          cameraNote={cameraNote}
          onEnableCamera={() => setInputMode('camera')}
          onUseSim={(note) =>
            setInputMode('sim', note ?? 'Simulated input active.')
          }
          pushSample={pushSample}
          activeGesture={
            ui.snapshot.phase === 'debouncing' || ui.snapshot.phase === 'arming'
              ? ui.snapshot.gesture
              : null
          }
          holdGesture={holdGesture}
          releaseGesture={releaseGesture}
          demo={demoUi}
          onStopDemo={() => stopDemo('canceled')}
        />
        <CellPane
          cellRef={cellRef}
          cellState={ui.cellState}
          resetStep={ui.resetStep}
          cyclesCompleted={ui.cyclesCompleted}
          speedPct={ui.speedPct}
          onEstopResetArm={onEstopResetArm}
          onEstopResetConfirm={onEstopResetConfirm}
        />
        <CoworkerPane cell={cellApi} voice={voice} console={flashConsole} />
      </main>

      <TelemetryStrip
        ui={ui}
        uiLog={uiLog}
        dwellMs={dwellMs}
        estopDwellMs={DEFAULT_CONFIG.estopDwellMs}
        onExport={onExport}
        onEvidence={import.meta.env.DEV ? onEvidence : undefined}
      />

      {aboutOpen && <AboutPanel onClose={() => setAboutOpen(false)} />}
    </div>
  );
}
