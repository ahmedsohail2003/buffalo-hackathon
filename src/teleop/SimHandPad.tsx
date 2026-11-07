// Simulated hand: with no camera, the pointer over this pad IS the hand. Pointer position -> the
// canonical open-hand template placed under it -> a HandFrame published every animation frame
// (and null once when the pointer leaves). Space or the mouse button pinches.

import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { HAND_BONES, simHandFrame } from './handTemplate';
import { palmPoint } from './mapping';
import { publishHandFrame } from './state';
import type { Teleop } from './teleop';
import './teleop.css';

/** A tap shorter than this still pinches for this long, so the 2-frame click rule sees it. */
const MIN_PINCH_MS = 120;

/** Space in a text field types a space; it never pinches. */
function inTextField(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t.matches('input, textarea, select'));
}

export interface TeleopUiProps {
  teleop: Teleop | null;
  mode: 'sim' | 'camera';
}

export function SimHandPad({ teleop, mode }: TeleopUiProps) {
  const padRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointer = useRef<{ u: number; v: number } | null>(null);
  const button = useRef(false);
  const space = useRef(false);
  const pinchUntil = useRef(0);
  const teleopRef = useRef(teleop);
  teleopRef.current = teleop;

  useEffect(() => {
    if (mode !== 'sim') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || inTextField(e.target) || !pointer.current) return;
      // Space is the pinch while the pointer is over the pad: keep it from pressing a focused button.
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) pinchUntil.current = performance.now() + MIN_PINCH_MS;
      space.current = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !space.current) return;
      space.current = false;
      e.preventDefault();
      e.stopPropagation();
    };
    const onBlur = () => {
      space.current = false;
      button.current = false;
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    let raf = 0;
    let publishing = false;
    const frame = (now: number) => {
      const p = pointer.current;
      const pinch = button.current || space.current || now < pinchUntil.current;
      const hand = p ? simHandFrame(p.u, p.v, pinch, performance.now()) : null;
      if (hand || publishing) publishHandFrame(hand);
      publishing = hand !== null;
      if (canvasRef.current) drawPad(canvasRef.current, hand?.landmarks ?? null, pinch, teleopRef.current?.status().mode === 'blocked');
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
      if (publishing) publishHandFrame(null);
    };
  }, [mode]);

  if (mode !== 'sim') return null;

  const track = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = padRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return;
    pointer.current = {
      u: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      v: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };

  return (
    <div
      ref={padRef}
      className="teleop-pad"
      role="application"
      aria-label="Simulated hand pad: move the pointer to steer the gripper, press Space or click to pinch"
      onPointerEnter={track}
      onPointerMove={track}
      onPointerDown={(e) => {
        track(e);
        button.current = true;
        pinchUntil.current = performance.now() + MIN_PINCH_MS;
      }}
      onPointerUp={() => (button.current = false)}
      onPointerCancel={() => (button.current = false)}
      onPointerLeave={() => {
        pointer.current = null;
        button.current = false;
      }}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      <span className="teleop-pad-label">Simulated hand — move the pointer, press Space or click to pinch</span>
    </div>
  );
}

/** Draw the synthetic hand as the operator would see it in a mirrored preview. */
function drawPad(canvas: HTMLCanvasElement, lm: { x: number; y: number; z: number }[] | null, pinch: boolean, blocked: boolean) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w <= 0 || h <= 0) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // the mapped working area (central 70 %)
  ctx.strokeStyle = 'rgba(125, 211, 252, 0.18)';
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(w * 0.15, h * 0.15, w * 0.7, h * 0.7);
  ctx.setLineDash([]);
  if (!lm) return;
  const X = (p: { x: number }) => (1 - p.x) * w;
  const Y = (p: { y: number }) => p.y * h;
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#5b6b8c';
  ctx.beginPath();
  for (const [a, b] of HAND_BONES) {
    ctx.moveTo(X(lm[a]), Y(lm[a]));
    ctx.lineTo(X(lm[b]), Y(lm[b]));
  }
  ctx.stroke();
  ctx.fillStyle = '#7dd3fc';
  for (const p of lm) {
    ctx.beginPath();
    ctx.arc(X(p), Y(p), 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(X(lm[8]), Y(lm[8]), pinch ? 6 : 4, 0, Math.PI * 2);
  ctx.strokeStyle = pinch ? '#22d3ee' : 'rgba(125, 211, 252, 0.5)';
  ctx.lineWidth = pinch ? 3 : 1.5;
  ctx.stroke();
  const pp = palmPoint(lm);
  const cx = pp.u * w;
  const cy = pp.v * h;
  ctx.strokeStyle = blocked ? '#ef4444' : '#22d3ee';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(cx - 8, cy);
  ctx.lineTo(cx + 8, cy);
  ctx.moveTo(cx, cy - 8);
  ctx.lineTo(cx, cy + 8);
  ctx.stroke();
}
