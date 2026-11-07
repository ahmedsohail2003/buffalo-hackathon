// On-device hand tracking: webcam -> MediaPipe GestureRecognizer (VIDEO mode, one hand) ->
// setHandFrame() on every processed video frame. The video never leaves this machine.
import type { GestureRecognizer } from '@mediapipe/tasks-vision';
import type { HandFrame } from '../contracts';
import { log } from '../app/bus';
import { setHandFrame } from '../app/hand';

const WASM_URL = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';

export type TrackerStatus = 'off' | 'starting' | 'loading' | 'running' | 'error';

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

function describeError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera permission was denied. Use the keypad, or allow the camera and try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found. Use the keypad instead.';
  if (name === 'NotReadableError') return 'The camera is busy in another app.';
  return `Hand tracking could not start: ${(err as Error)?.message ?? String(err)}`;
}

class HandTracker {
  readonly video: VideoWithFrameCallback;
  status: TrackerStatus = 'off';
  error: string | null = null;
  /** processed frames per second */
  fps = 0;
  delegate: 'GPU' | 'CPU' | null = null;
  private recognizer: GestureRecognizer | null = null;
  private stream: MediaStream | null = null;
  private lastTs = 0;
  private handle = 0;
  private usingVfc = false;
  private generation = 0;
  private frames = 0;
  private fpsSince = 0;
  private subs = new Set<() => void>();

  constructor() {
    const v = document.createElement('video') as VideoWithFrameCallback;
    v.muted = true;
    v.playsInline = true;
    v.autoplay = true;
    v.setAttribute('aria-label', 'Your camera, mirrored. Processed on this device only.');
    this.video = v;
  }

  onChange(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  private set(status: TrackerStatus, error: string | null = null): void {
    this.status = status;
    this.error = error;
    this.subs.forEach((cb) => cb());
  }

  async start(): Promise<boolean> {
    if (this.status === 'running' || this.status === 'starting' || this.status === 'loading') return true;
    const gen = ++this.generation;
    this.set('starting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
      if (gen !== this.generation) return false;
      this.video.srcObject = this.stream;
      await this.video.play();
      if (!this.recognizer) {
        this.set('loading');
        this.recognizer = await this.createRecognizer();
      }
      if (gen !== this.generation) return false;
      this.set('running');
      log('info', `Hand tracking on (${this.delegate}); video stays on this machine`);
      this.fpsSince = performance.now();
      this.schedule(gen);
      return true;
    } catch (err) {
      this.releaseCamera();
      const msg = describeError(err);
      this.set('error', msg);
      log('reject', msg);
      return false;
    }
  }

  private async createRecognizer(): Promise<GestureRecognizer> {
    const { FilesetResolver, GestureRecognizer } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    for (const delegate of ['GPU', 'CPU'] as const) {
      try {
        const r = await GestureRecognizer.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          runningMode: 'VIDEO',
          numHands: 1,
        });
        this.delegate = delegate;
        return r;
      } catch (err) {
        if (delegate === 'CPU') throw err;
        console.warn('[hand] GPU delegate failed, trying CPU', err);
      }
    }
    throw new Error('no delegate');
  }

  private schedule(gen: number): void {
    const v = this.video;
    const next = () => this.step(gen);
    if (v.requestVideoFrameCallback) {
      this.usingVfc = true;
      this.handle = v.requestVideoFrameCallback(next);
    } else {
      this.usingVfc = false;
      this.handle = requestAnimationFrame(next);
    }
  }

  private step(gen: number): void {
    if (gen !== this.generation || this.status !== 'running' || !this.recognizer) return;
    const v = this.video;
    if (v.readyState >= 2 && v.videoWidth > 0) {
      let ts = performance.now();
      if (ts <= this.lastTs) ts = this.lastTs + 0.01;
      this.lastTs = ts;
      try {
        const res = this.recognizer.recognizeForVideo(v, ts);
        const lm = res.landmarks[0];
        let frame: HandFrame | null = null;
        if (lm && lm.length) {
          const top = res.gestures[0]?.[0];
          const gesture = top && top.categoryName && top.categoryName !== 'None' ? top.categoryName : null;
          frame = {
            t: ts,
            landmarks: lm.map((p) => ({ x: p.x, y: p.y, z: p.z })),
            gesture,
            gestureScore: gesture ? top!.score : 0,
            source: 'camera',
          };
          const world = res.worldLandmarks[0];
          if (world) frame.world = world.map((p) => ({ x: p.x, y: p.y, z: p.z }));
        }
        setHandFrame(frame);
      } catch (err) {
        console.error('[hand] recognizer failed on a frame', err);
      }
      this.frames++;
      if (ts - this.fpsSince >= 1000) {
        this.fps = Math.round((this.frames * 1000) / (ts - this.fpsSince));
        this.frames = 0;
        this.fpsSince = ts;
        this.subs.forEach((cb) => cb());
      }
    }
    this.schedule(gen);
  }

  private releaseCamera(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  stop(): void {
    this.generation++;
    if (this.usingVfc) this.video.cancelVideoFrameCallback?.(this.handle);
    else cancelAnimationFrame(this.handle);
    this.releaseCamera();
    setHandFrame(null);
    this.fps = 0;
    if (this.status !== 'off') log('info', 'Hand tracking off');
    this.set('off');
  }
}

let tracker: HandTracker | null = null;

/** The page's hand tracker (created on first use). */
export function getHandTracker(): HandTracker {
  if (!tracker) tracker = new HandTracker();
  return tracker;
}

export type { HandTracker };

/** MediaPipe hand topology: pairs of landmark indices to connect. */
export const HAND_LINKS: readonly [number, number][] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],
];
