// The app runtime: owns the bay core, runs the loop, feeds the safety machine and exposes the
// public BayApi. One instance per page, created by bootRuntime() before the UI renders.
//
// Each tick, in order:
//   1. safety: the keypad or the latest hand frame -> label filter -> dwell machine -> gate
//   2. tick hooks (teleop steps here, before the arm moves)
//   3. arm step at the gate's speed factor
//   4. scene sync and viewer render (when a scene is attached)
// A requestAnimationFrame loop drives it; a ~30 Hz interval takes over when RAF stalls.
import type { BayApi, BayState, FrameCapture, HandFrame, Vec3 } from '../contracts';
import {
  BAY_CAMERA,
  CONTAINMENT_FLOOR_Z,
  CONTAINMENT_INNER,
  CONTAINMENT_WALL_H,
  CONTAINMENT_WALL_T,
  CONTAINMENT_XY,
  createBay,
  loadArmData,
  type So101Data,
} from '../core';
import { BayCameraModel } from '../scene/bayCamera';
import { stationArmMeshFactory } from '../scene/armLook';
import type { BayCore, BayLayout, ResetResult, SafetySignal, SignalSource } from './bayTypes';
import { log, type LogKind } from './bus';
import { getHandFrame, normalizeHandFrame, setHandFrame } from './hand';
import { PARAMS } from './params';
import { DwellMachine, type SafetySnapshot } from './safetyAdapter';

export type InputMode = 'sim' | 'camera';

export interface TickContext {
  /** latest hand frame (camera or simulated), or null when no hand is in view */
  hand: HandFrame | null;
  /** the hand-signal machine after this tick's sample (phase: idle, debouncing, arming, fired) */
  safety: SafetySnapshot;
  bayState: BayState;
}

/** Runs every tick before the arm steps. nowMs is performance.now(); dt is in seconds. */
export type TickHook = (nowMs: number, dt: number, ctx: TickContext) => void;

/** Decides which gesture label reaches the safety machine (teleop plugs its fist suppression in here). */
export type SafetyLabelFilter = (label: string | null, frame: HandFrame | null, nowMs: number) => string | null;

/** What the scene provides once mounted. */
export interface SceneLink {
  frame(dt: number, nowMs: number): void;
  capture(): FrameCapture;
}

export interface Telemetry {
  state: BayState;
  speed: number;
  phase: string;
  tcp_mm: Vec3;
  jawOpen: number;
  heldId: string | null;
  heldName: string | null;
  busy: boolean;
  fps: number;
}

/** The bay geometry the scene draws, from the core's constants. */
export const BAY_LAYOUT: BayLayout = {
  deckSize: 1.2,
  deckCenter: [0, -0.05],
  containment: {
    x: CONTAINMENT_XY[0],
    y: CONTAINMENT_XY[1],
    innerW: CONTAINMENT_INNER,
    innerD: CONTAINMENT_INNER,
    wallH: CONTAINMENT_WALL_H,
    wallT: CONTAINMENT_WALL_T,
    floorZ: CONTAINMENT_FLOOR_Z,
  },
  bayCamera: { pos: BAY_CAMERA.pos, target: BAY_CAMERA.target, fovDeg: BAY_CAMERA.fovDeg },
};

const HAND_STALE_MS = 300;
const TELEMETRY_MS = 100;
const WATCHDOG_MS = 33;

class Runtime {
  readonly core: BayCore;
  readonly bayCamera: BayCameraModel;
  readonly bay: BayApi;
  private machine = new DwellMachine();
  private hooks: TickHook[] = [];
  private failedHooks = new WeakSet<TickHook>();
  private labelFilter: SafetyLabelFilter = (label) => label;
  private simGesture: string | null = null;
  private scene: SceneLink | null = null;
  private running = false;
  private raf = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private lastTelemetry = 0;
  private fpsFrames = 0;
  private fpsSince = 0;
  private fps = 0;
  private telemetry: Telemetry;
  private telemetrySubs = new Set<() => void>();
  private inputMode: InputMode = 'sim';
  private inputSubs = new Set<() => void>();
  private lastCaptureAt: number | null = null;
  private captureSubs = new Set<() => void>();

  constructor(data: So101Data) {
    const bay = createBay(data, {
      log: (text, kind) => log(kind as LogKind, text),
      meshFactory: typeof document === 'undefined' ? undefined : stationArmMeshFactory,
    });
    this.core = { arm: bay.arm, samples: bay.samples, gate: bay.gate, model: bay.model, layout: BAY_LAYOUT };
    this.bayCamera = new BayCameraModel(BAY_LAYOUT.bayCamera);
    this.bay = {
      arm: bay.arm,
      samples: bay.samples,
      gate: bay.gate,
      capture: () => this.capture(),
      project: (p) => this.bayCamera.project(p),
      unproject: (yx, z) => this.bayCamera.unproject(yx, z),
    };
    this.telemetry = this.readTelemetry();
    bay.gate.onChange(() => this.publishTelemetry(true));
  }

  // ---- loop ---------------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTick = performance.now();
    this.fpsSince = this.lastTick;
    const loop = (t: number) => {
      if (!this.running) return;
      this.tick(Math.max(t, this.lastTick));
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    this.interval = setInterval(() => {
      const now = performance.now();
      if (now - this.lastTick > WATCHDOG_MS * 3) this.tick(now);
    }, WATCHDOG_MS);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /** One step of the whole app. Public for tests and for the watchdog. */
  tick(now: number): void {
    const dt = Math.min(0.25, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;

    // 1. safety
    const hand = this.feedSafety(now);

    // 2. tick hooks
    if (this.hooks.length) {
      const ctx: TickContext = { hand, safety: this.machine.snapshot(), bayState: this.core.gate.state() };
      for (const h of this.hooks) {
        try {
          h(now, dt, ctx);
        } catch (err) {
          if (!this.failedHooks.has(h)) {
            this.failedHooks.add(h);
            console.error('[runtime] tick hook failed', err);
            log('info', `A tick hook failed: ${(err as Error).message}`);
          }
        }
      }
    }

    // 3. arm
    this.core.arm.step(dt, this.core.gate.speedFactor());

    // 4. scene
    if (this.scene && !(typeof document !== 'undefined' && document.hidden)) {
      this.scene.frame(dt, now);
      this.fpsFrames++;
    }
    if (now - this.fpsSince >= 1000) {
      this.fps = Math.round((this.fpsFrames * 1000) / (now - this.fpsSince));
      this.fpsFrames = 0;
      this.fpsSince = now;
    }
    if (now - this.lastTelemetry >= TELEMETRY_MS) {
      this.lastTelemetry = now;
      this.publishTelemetry(false);
    }
  }

  // ---- safety -------------------------------------------------------------------------------

  /** One sample into the dwell machine: the keypad if held, else the latest fresh hand frame. */
  private feedSafety(now: number): HandFrame | null {
    const hand = getHandFrame();
    let label: string | null = null;
    let score = 0;
    if (this.simGesture) {
      label = this.simGesture;
      score = 1;
    } else if (hand && now - hand.t <= HAND_STALE_MS) {
      label = hand.gesture;
      score = hand.gestureScore;
    }
    const fired = this.machine.feed(this.filterSafetyLabel(label, hand, now), score, now);
    if (fired) this.applySignal(fired, this.simGesture ? 'keypad' : 'hand');
    return hand;
  }

  filterSafetyLabel(label: string | null, frame: HandFrame | null, now: number): string | null {
    try {
      return this.labelFilter(label, frame, now);
    } catch (err) {
      console.error('[runtime] safety label filter failed; passing the raw label', err);
      return label;
    }
  }

  setSafetyLabelFilter(fn: SafetyLabelFilter | null): void {
    this.labelFilter = fn ?? ((label) => label);
  }

  safetySnapshot(): SafetySnapshot {
    return this.machine.snapshot();
  }

  /**
   * Keypad / on-screen signal buttons: hold a simulated gesture (null releases it). The press and
   * the release are sampled at once, so the dwell is timed from the key events even when frames lag.
   */
  setSimGesture(label: string | null): void {
    if (label === this.simGesture) return;
    const now = performance.now();
    if (this.simGesture) this.feedSafety(now);
    this.simGesture = label;
    this.feedSafety(now);
  }

  /** A fired hand signal or a panel button. The gate logs the result; ESTOP aborts every move. */
  applySignal(signal: SafetySignal, source: SignalSource): void {
    this.core.gate.apply(signal, source);
  }

  /** True while a fist is held (camera or keypad): it keeps the bay stopped, whatever the panel says. */
  fistHeld(now: number = performance.now()): boolean {
    if (this.simGesture === 'Closed_Fist') return true;
    const f = getHandFrame();
    return !!f && now - f.t <= HAND_STALE_MS && f.gesture === 'Closed_Fist';
  }

  /** Two-step E-STOP reset from the panel: 'arm' (bay is clear), then 'confirm' (back to IDLE). */
  resetEstop(step: 'arm' | 'confirm', source: SignalSource = 'panel'): ResetResult {
    if (this.fistHeld()) {
      log('safety', 'E-STOP reset refused: a fist is still held (hand signals override the panel)');
      return { ok: false, reason: 'A fist is still held. Hand signals override the panel.' };
    }
    const r = this.core.gate.apply(step === 'arm' ? 'RESET_ARM' : 'RESET_CONFIRM', source);
    return r.ok ? { ok: true } : { ok: false, reason: r.note };
  }

  // ---- hooks and scene ----------------------------------------------------------------------

  registerTickHook(fn: TickHook): () => void {
    this.hooks.push(fn);
    return () => {
      this.hooks = this.hooks.filter((h) => h !== fn);
    };
  }

  attachScene(link: SceneLink): () => void {
    this.scene = link;
    return () => {
      if (this.scene === link) this.scene = null;
    };
  }

  capture(): FrameCapture {
    if (!this.scene) throw new Error('The bay scene is not mounted yet');
    const frame = this.scene.capture();
    this.lastCaptureAt = frame.t;
    this.captureSubs.forEach((cb) => cb());
    return frame;
  }

  /** Date.now() of the last BayApi.capture(), or null. */
  getLastCaptureAt(): number | null {
    return this.lastCaptureAt;
  }

  onCapture(cb: () => void): () => void {
    this.captureSubs.add(cb);
    return () => this.captureSubs.delete(cb);
  }

  // ---- input mode ---------------------------------------------------------------------------

  getInputMode(): InputMode {
    return this.inputMode;
  }

  setInputMode(mode: InputMode): void {
    if (mode === this.inputMode) return;
    this.inputMode = mode;
    log('info', mode === 'camera' ? 'Hand input: camera (tracked on this device)' : 'Hand input: simulated keypad');
    this.inputSubs.forEach((cb) => cb());
  }

  onInputMode(cb: () => void): () => void {
    this.inputSubs.add(cb);
    return () => this.inputSubs.delete(cb);
  }

  // ---- telemetry ----------------------------------------------------------------------------

  private readTelemetry(): Telemetry {
    const snap = this.core.arm.snapshot();
    const held = snap.heldId ? this.core.samples.get(snap.heldId) : undefined;
    return {
      state: this.core.gate.state(),
      speed: this.core.gate.speedFactor(),
      phase: snap.phase,
      tcp_mm: snap.tcp.map((v) => Math.round(v * 1000)) as Vec3,
      jawOpen: snap.jawOpen,
      heldId: snap.heldId,
      heldName: held?.name ?? null,
      busy: snap.busy,
      fps: this.fps,
    };
  }

  private publishTelemetry(force: boolean): void {
    const next = this.readTelemetry();
    const prev = this.telemetry;
    const same =
      !force &&
      prev.state === next.state &&
      prev.phase === next.phase &&
      prev.heldId === next.heldId &&
      prev.busy === next.busy &&
      prev.fps === next.fps &&
      prev.heldName === next.heldName &&
      Math.abs(prev.jawOpen - next.jawOpen) < 0.01 &&
      prev.tcp_mm.every((v, i) => v === next.tcp_mm[i]);
    if (same) return;
    this.telemetry = next;
    this.telemetrySubs.forEach((cb) => cb());
  }

  getTelemetry(): Telemetry {
    return this.telemetry;
  }

  onTelemetry(cb: () => void): () => void {
    this.telemetrySubs.add(cb);
    return () => this.telemetrySubs.delete(cb);
  }
}

export type { Runtime };

let instance: Runtime | null = null;
let booting: Promise<Runtime> | null = null;

/**
 * Create the page's runtime: load the SO-101 model, build the bay core. Call once before the UI
 * renders (main.tsx does). Pass data to skip the fetch (tests).
 */
export function bootRuntime(data?: So101Data): Promise<Runtime> {
  if (instance) return Promise.resolve(instance);
  if (!booting) {
    booting = (data ? Promise.resolve(data) : loadArmData(`${import.meta.env.BASE_URL}assets/so101.json`)).then((d) => {
      instance = new Runtime(d);
      if (PARAMS.sim) log('info', 'Simulated hand input (?sim=1): the camera stays off');
      log('info', 'Bay online: SO-101 arm core loaded');
      installDevGlobals(instance);
      return instance;
    });
    booting.catch(() => (booting = null));
  }
  return booting;
}

/** The page's runtime. Throws before bootRuntime() has finished. */
export function getRuntime(): Runtime {
  if (!instance) throw new Error('The bay runtime is not booted yet (bootRuntime() first)');
  return instance;
}

/** Tests only: drop the runtime so the next boot builds a fresh one. */
export function resetRuntimeForTests(): void {
  instance?.stop();
  instance = null;
  booting = null;
}

/** Run a function every tick before the arm steps (teleop plugs in here). Returns unregister. */
export function registerTickHook(fn: TickHook): () => void {
  return getRuntime().registerTickHook(fn);
}

/** Route every gesture label through fn before it reaches the safety machine. */
export function setSafetyLabelFilter(fn: SafetyLabelFilter | null): void {
  getRuntime().setSafetyLabelFilter(fn);
}

/** The public bay surface for the Gemini, voice, teleop and fabricator layers. */
export function getBay(): BayApi {
  return getRuntime().bay;
}

// ---- DEV-only globals -------------------------------------------------------------------------

declare global {
  interface Window {
    __bay?: BayApi;
    __hand?: { push(frame: Partial<HandFrame> | null): void; get(): HandFrame | null };
    __starhand?: { runtime: Runtime };
  }
}

function installDevGlobals(rt: Runtime): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return;
  window.__bay = rt.bay;
  window.__hand = {
    push(frame) {
      setHandFrame(frame ? normalizeHandFrame(frame, performance.now()) : null);
    },
    get: getHandFrame,
  };
  window.__starhand = { runtime: rt };
}
