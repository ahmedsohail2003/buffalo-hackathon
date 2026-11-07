import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import type { GestureRecognizer as GestureRecognizerType } from '@mediapipe/tasks-vision';
import type { GestureLabel, Snapshot } from '../gesture/stateMachine';
import { COMMAND_COLORS, GESTURES } from '../gesture/gestures';
import { GestureIcon } from './GestureIcon';
import {
  drawDwellRing,
  fitCanvas,
  statusLine,
  type LastFired,
} from './ring';
import type { DemoUi, InputMode } from '../App';

const KNOWN_LABELS = new Set<string>([
  'Open_Palm',
  'Closed_Fist',
  'Thumb_Up',
  'Pointing_Up',
  'Victory',
]);

interface HandPaneProps {
  mode: InputMode;
  snapRef: React.MutableRefObject<Snapshot>;
  heldRef: React.MutableRefObject<GestureLabel | null>;
  lastFiredRef: React.MutableRefObject<LastFired | null>;
  simConfidence: number;
  onSimConfidence: (v: number) => void;
  dwellMs: number;
  onDwellMs: (v: number) => void;
  minConfidence: number;
  cameraNote: string | null;
  onEnableCamera: () => void;
  onUseSim: (note?: string) => void;
  pushSample: (label: GestureLabel | null, conf: number, t: number) => void;
  /** Gesture currently debouncing/arming (synced ~8 Hz) for keypad highlight. */
  activeGesture: GestureLabel | null;
  holdGesture: (g: GestureLabel) => void;
  releaseGesture: (g: GestureLabel) => void;
  demo: DemoUi | null;
  onStopDemo: () => void;
}

export function HandPane(props: HandPaneProps) {
  const {
    mode,
    simConfidence,
    onSimConfidence,
    dwellMs,
    onDwellMs,
    minConfidence,
    cameraNote,
    onEnableCamera,
    onUseSim,
    activeGesture,
    holdGesture,
    releaseGesture,
    demo,
    onStopDemo,
  } = props;

  return (
    <section className="pane" aria-label="Gesture input">
      <div className="pane-head">
        <h2>Gesture input</h2>
        <span className={mode === 'sim' ? 'badge sim' : 'badge live'}>
          {mode === 'sim' ? 'Simulated input' : 'Camera'}
        </span>
        <div className="spacer" />
        {mode === 'sim' ? (
          <button type="button" onClick={onEnableCamera}>
            Enable camera
          </button>
        ) : (
          <button type="button" onClick={() => onUseSim('Simulated input active.')}>
            Use simulated input
          </button>
        )}
      </div>

      <div className="stage">
        {mode === 'sim' ? (
          <SimCanvas
            snapRef={props.snapRef}
            heldRef={props.heldRef}
            lastFiredRef={props.lastFiredRef}
          />
        ) : (
          <CameraView
            pushSample={props.pushSample}
            snapRef={props.snapRef}
            lastFiredRef={props.lastFiredRef}
            onFail={(msg) => onUseSim(msg)}
          />
        )}
        {demo && (
          <div className="demo-bar" role="status" aria-live="polite">
            <div className="demo-head">
              <span className="demo-tag">Guided demo</span>
              <span className="demo-step mono">
                step {demo.idx} / {demo.total}
              </span>
              <div className="spacer" />
              <button type="button" onClick={onStopDemo}>
                Stop (Esc)
              </button>
            </div>
            <div className="demo-progress" aria-hidden="true">
              <div
                className="bar"
                style={{ animationDuration: `${demo.totalMs}ms` }}
              />
            </div>
            <p className="demo-caption">{demo.caption}</p>
          </div>
        )}
      </div>

      <div className="controls">
        <div className="slider-row">
          <label htmlFor="dwell">Dwell to fire (arming hold)</label>
          <input
            id="dwell"
            type="range"
            min={300}
            max={1200}
            step={50}
            value={dwellMs}
            onChange={(e) => onDwellMs(Number(e.target.value))}
          />
          <span className="value">{dwellMs} ms</span>
        </div>
        {mode === 'sim' && (
          <div className="slider-row">
            <label htmlFor="conf">Synthetic confidence</label>
            <input
              id="conf"
              type="range"
              min={0.3}
              max={1}
              step={0.01}
              value={simConfidence}
              onChange={(e) => onSimConfidence(Number(e.target.value))}
            />
            <span className="value">{simConfidence.toFixed(2)}</span>
          </div>
        )}
        <div className="cam-note mono">
          E-STOP dwell fixed at 1.5 s · confidence gate ≥ {minConfidence.toFixed(2)}
          {cameraNote ? ` · ${cameraNote}` : ''}
        </div>
        <SignalKeypad
          interactive={mode === 'sim'}
          activeGesture={activeGesture}
          holdGesture={holdGesture}
          releaseGesture={releaseGesture}
        />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Signal keypad: on-screen legend of keys 1–5 with gesture icons.     */
/* Cards are press-and-hold inputs in simulated mode (mouse, touch,    */
/* or Space/Enter on a focused card) and a reference in camera mode.   */
/* ------------------------------------------------------------------ */

function SignalKeypad({
  interactive,
  activeGesture,
  holdGesture,
  releaseGesture,
}: {
  interactive: boolean;
  activeGesture: GestureLabel | null;
  holdGesture: (g: GestureLabel) => void;
  releaseGesture: (g: GestureLabel) => void;
}) {
  return (
    <div className="keypad-wrap">
      <div className="keypad-head">
        <span>Signal keypad — press &amp; hold, or keys 1–5</span>
        <div className="spacer" />
        <span className="hint">
          {interactive
            ? 'hold until the ring fills · release early to abort'
            : 'reference only — camera input active'}
        </span>
      </div>
      <div className="keypad" role="group" aria-label="Gesture signal keypad">
        {GESTURES.map((g) => {
          const active = activeGesture === g.label;
          const color = COMMAND_COLORS[g.command];
          return (
            <button
              key={g.label}
              type="button"
              className={`keycard${active ? ' active' : ''}`}
              style={
                active
                  ? { borderColor: color, boxShadow: `inset 0 0 0 1px ${color}` }
                  : undefined
              }
              title={g.craneNote}
              aria-pressed={active}
              aria-label={`Hold to signal ${g.commandLabel} — ${g.display}, key ${g.key}`}
              disabled={!interactive}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture?.(e.pointerId);
                holdGesture(g.label);
              }}
              onPointerUp={() => releaseGesture(g.label)}
              onPointerCancel={() => releaseGesture(g.label)}
              onKeyDown={(e) => {
                if (!e.repeat && (e.key === ' ' || e.key === 'Enter')) {
                  e.preventDefault();
                  holdGesture(g.label);
                }
              }}
              onKeyUp={(e) => {
                if (e.key === ' ' || e.key === 'Enter') releaseGesture(g.label);
              }}
              onBlur={() => releaseGesture(g.label)}
            >
              <span className="keycap mono">{g.key}</span>
              <span className="kicon" style={active ? { color } : undefined}>
                <GestureIcon label={g.label} />
              </span>
              <span className="kname">{g.cardName}</span>
              <span className="kcmd mono" style={{ color }}>
                {g.commandLabel}
              </span>
              <span className="korigin">{g.cardOrigin}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Simulated input: schematic hand + dwell ring, driven by keys 1–5.   */
/* ------------------------------------------------------------------ */

function SimCanvas({
  snapRef,
  heldRef,
  lastFiredRef,
}: {
  snapRef: React.MutableRefObject<Snapshot>;
  heldRef: React.MutableRefObject<GestureLabel | null>;
  lastFiredRef: React.MutableRefObject<LastFired | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let raf = 0;
    const step = (now: number) => {
      const canvas = canvasRef.current;
      if (canvas) {
        drawSimFrame(canvas, now, snapRef.current, heldRef.current, lastFiredRef.current);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [snapRef, heldRef, lastFiredRef]);

  return (
    <>
      <canvas ref={canvasRef} aria-label="Simulated gesture visualization" />
      <div className="overlay-note">
        <span className="badge sim">Simulated input — keys 1–5</span>
      </div>
    </>
  );
}

function drawSimFrame(
  canvas: HTMLCanvasElement,
  now: number,
  snap: Snapshot,
  held: GestureLabel | null,
  lastFired: LastFired | null,
) {
  const fit = fitCanvas(canvas);
  if (!fit) return;
  const { ctx, w, h } = fit;

  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2 - 10;

  // Which hand to draw: the machine's candidate wins, else the held key,
  // else a faint neutral palm as a placeholder.
  const label = snap.gesture ?? held;
  const ringR = Math.min(w, h) * 0.32;

  if (label) {
    drawHand(ctx, cx, cy, ringR * 0.62, label, 1);
  } else {
    ctx.globalAlpha = 0.22;
    drawHand(ctx, cx, cy, ringR * 0.62, 'Open_Palm', 1);
    ctx.globalAlpha = 1;
  }

  drawDwellRing(ctx, cx, cy, ringR, snap, lastFired, now);

  const st = statusLine(snap, lastFired, now, 'HOLD KEYS 1–5 OR THE KEYPAD BELOW');
  ctx.font = '600 13px "JetBrains Mono", ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = st.color;
  ctx.fillText(st.text, cx, cy + ringR + 28);

  if (snap.phase === 'arming' && snap.command) {
    ctx.font = '11px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillStyle = '#8A94A8';
    ctx.fillText(
      `${Math.round(snap.dwellProgress * snap.requiredDwellMs)} / ${snap.requiredDwellMs} ms`,
      cx,
      cy + ringR + 46,
    );
  }
}

/**
 * Schematic hand glyphs for the five vocabulary gestures. These are honest
 * stand-ins for a camera feed: simple stroked capsules, not real imagery.
 */
function drawHand(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  label: GestureLabel,
  alpha: number,
) {
  const s = size / 60; // palm design unit
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(cx, cy + 14 * s);
  ctx.lineCap = 'round';

  const palmW = 52 * s;
  const palmH = 56 * s;
  const finger = (
    x0: number,
    y0: number,
    angleDeg: number,
    len: number,
    width: number,
  ) => {
    const a = ((angleDeg - 90) * Math.PI) / 180;
    ctx.beginPath();
    ctx.moveTo(x0 * s, y0 * s);
    ctx.lineTo(x0 * s + Math.cos(a) * len * s, y0 * s + Math.sin(a) * len * s);
    ctx.lineWidth = width * s;
    ctx.strokeStyle = '#5B6B8C';
    ctx.stroke();
  };

  // Fingers first (behind the palm fill).
  switch (label) {
    case 'Open_Palm':
      finger(-20, -22, -24, 48, 13);
      finger(-7, -26, -8, 58, 13);
      finger(6, -26, 6, 60, 13);
      finger(18, -23, 20, 52, 13);
      finger(-27, -2, -62, 40, 13); // thumb
      break;
    case 'Closed_Fist':
      // knuckle bumps only
      finger(-18, -24, 0, 6, 14);
      finger(-6, -27, 0, 6, 14);
      finger(6, -27, 0, 6, 14);
      finger(17, -24, 0, 6, 14);
      break;
    case 'Thumb_Up':
      finger(-18, -24, 0, 6, 14);
      finger(-6, -27, 0, 6, 14);
      finger(6, -27, 0, 6, 14);
      finger(17, -24, 0, 6, 14);
      finger(-26, -10, -30, 46, 14); // thumb up
      break;
    case 'Pointing_Up':
      finger(-16, -24, 0, 6, 14);
      finger(8, -26, 0, 6, 14);
      finger(18, -22, 0, 6, 14);
      finger(-4, -26, 0, 58, 13); // index
      break;
    case 'Victory':
      finger(10, -25, 0, 6, 14);
      finger(19, -21, 0, 6, 14);
      finger(-12, -26, -14, 58, 13);
      finger(2, -27, 12, 58, 13);
      break;
  }

  // Palm.
  ctx.beginPath();
  roundRect(ctx, -palmW / 2, -palmH / 2, palmW, palmH, 16 * s);
  ctx.fillStyle = '#1C2333';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#5B6B8C';
  ctx.stroke();

  // Thumb across the fist for fist-family gestures.
  if (label === 'Closed_Fist' || label === 'Pointing_Up' || label === 'Victory') {
    ctx.beginPath();
    ctx.moveTo(-22 * s, 6 * s);
    ctx.lineTo(14 * s, 12 * s);
    ctx.lineWidth = 12 * s;
    ctx.strokeStyle = '#4A5876';
    ctx.stroke();
  }

  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ------------------------------------------------------------------ */
/* Live camera input via MediaPipe GestureRecognizer (lazy-loaded).    */
/* ------------------------------------------------------------------ */

function CameraView({
  pushSample,
  snapRef,
  lastFiredRef,
  onFail,
}: {
  pushSample: (label: GestureLabel | null, conf: number, t: number) => void;
  snapRef: React.MutableRefObject<Snapshot>;
  lastFiredRef: React.MutableRefObject<LastFired | null>;
  onFail: (msg: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<string>(
    'Loading gesture model from CDN…',
  );
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    let recognizer: GestureRecognizerType | null = null;

    (async () => {
      try {
        // Lazy import keeps MediaPipe (and its WASM) out of the page until
        // the user actually opts into the camera.
        const vision = await import('@mediapipe/tasks-vision');
        const { FilesetResolver, GestureRecognizer, DrawingUtils } = vision;
        const fileset = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
        );
        if (cancelled) return;
        setStatus('Model runtime ready — loading recognizer…');
        recognizer = await GestureRecognizer.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numHands: 1,
        });
        if (cancelled) {
          // Unmounted mid-load: cleanup already ran, so close it here.
          recognizer.close();
          return;
        }
        setStatus('Requesting camera…');
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 960, height: 540 },
        });
        if (cancelled) {
          // Unmounted mid-request: stop the tracks or the webcam stays on.
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        if (cancelled) return;
        setRunning(true);

        let lastVideoTime = -1;
        const loop = () => {
          if (cancelled) return;
          const t = performance.now();
          if (
            video.readyState >= 2 &&
            recognizer &&
            video.currentTime !== lastVideoTime
          ) {
            lastVideoTime = video.currentTime;
            const res = recognizer.recognizeForVideo(video, t);
            const cat = res.gestures?.[0]?.[0];
            const label =
              cat && KNOWN_LABELS.has(cat.categoryName)
                ? (cat.categoryName as GestureLabel)
                : null;
            pushSample(label, cat?.score ?? 0, t);

            const overlay = overlayRef.current;
            if (overlay) {
              const fit = fitCanvas(overlay);
              if (fit) {
                const { ctx, w, h } = fit;
                ctx.clearRect(0, 0, w, h);
                ctx.save();
                // Mirror to match the mirrored video.
                ctx.translate(w, 0);
                ctx.scale(-1, 1);
                const landmarks = res.landmarks?.[0];
                if (landmarks) {
                  ctx.save();
                  ctx.scale(w, h);
                  const du = new DrawingUtils(ctx);
                  du.drawConnectors(
                    landmarks,
                    GestureRecognizer.HAND_CONNECTIONS,
                    { color: '#2A3347', lineWidth: 0.008 },
                  );
                  du.drawLandmarks(landmarks, {
                    color: '#7DD3FC',
                    radius: 0.008,
                  });
                  ctx.restore();
                  const c = landmarks.reduce(
                    (acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }),
                    { x: 0, y: 0 },
                  );
                  const hx = (c.x / landmarks.length) * w;
                  const hy = (c.y / landmarks.length) * h;
                  drawDwellRing(
                    ctx,
                    hx,
                    hy,
                    Math.min(w, h) * 0.22,
                    snapRef.current,
                    lastFiredRef.current,
                    t,
                  );
                }
                ctx.restore();
                const st = statusLine(
                  snapRef.current,
                  lastFiredRef.current,
                  t,
                  'SHOW A SIGNAL TO THE CAMERA',
                );
                ctx.font = '600 13px "JetBrains Mono", ui-monospace, monospace';
                ctx.textAlign = 'center';
                ctx.fillStyle = st.color;
                ctx.fillText(st.text, w / 2, h - 16);
              }
            }
          }
          raf = requestAnimationFrame(loop);
        };
        loop();
      } catch {
        if (!cancelled) {
          onFail(
            'Camera or gesture model unavailable in this environment — switched to simulated input.',
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((tr) => tr.stop());
      recognizer?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <video ref={videoRef} muted playsInline />
      <canvas ref={overlayRef} aria-label="Hand landmark overlay" />
      {!running && (
        <div className="cam-status" role="status">
          <span>{status}</span>
          <span>
            Model and WASM load from the official MediaPipe CDN on demand.
          </span>
        </div>
      )}
      {running && (
        <div className="overlay-note">
          <span className="badge live">Camera live — MediaPipe</span>
        </div>
      )}
    </>
  );
}
