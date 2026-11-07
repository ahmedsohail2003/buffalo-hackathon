// Shared canvas helpers: the dwell-progress ring and the status line.
// Used by both the simulated-input canvas and the live camera overlay so the
// two input paths look and behave identically downstream.

import type { CommandId, Snapshot } from '../gesture/stateMachine';
import { COMMAND_COLORS, COMMAND_LABELS } from '../gesture/gestures';

export interface LastFired {
  command: CommandId;
  t: number;
}

export const FIRED_FLASH_MS = 900;

export function drawDwellRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  snap: Snapshot,
  lastFired: LastFired | null,
  now: number,
): void {
  // Track.
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = '#2A3347';
  ctx.lineWidth = 6;
  ctx.stroke();

  const fresh = lastFired !== null && now - lastFired.t < FIRED_FLASH_MS;

  if (fresh && lastFired) {
    // Full ring flash in the fired command's color.
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = COMMAND_COLORS[lastFired.command];
    ctx.lineWidth = 8;
    ctx.globalAlpha = 0.4 + 0.6 * (1 - (now - lastFired.t) / FIRED_FLASH_MS);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }

  if (snap.phase === 'arming' && snap.command) {
    ctx.beginPath();
    ctx.arc(
      x,
      y,
      r,
      -Math.PI / 2,
      -Math.PI / 2 + Math.PI * 2 * snap.dwellProgress,
    );
    ctx.strokeStyle = COMMAND_COLORS[snap.command];
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.stroke();
  } else if (snap.phase === 'debouncing' && snap.command) {
    ctx.beginPath();
    ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * 0.06);
    ctx.strokeStyle = COMMAND_COLORS[snap.command];
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

export interface StatusLine {
  text: string;
  color: string;
}

export function statusLine(
  snap: Snapshot,
  lastFired: LastFired | null,
  now: number,
  idleHint: string,
): StatusLine {
  if (lastFired && now - lastFired.t < FIRED_FLASH_MS) {
    return {
      text: `FIRED ${COMMAND_LABELS[lastFired.command]}`,
      color: COMMAND_COLORS[lastFired.command],
    };
  }
  if (snap.phase === 'arming' && snap.command) {
    return {
      text: `ARMING ${COMMAND_LABELS[snap.command]} ${Math.round(
        snap.dwellProgress * 100,
      )}%`,
      color: COMMAND_COLORS[snap.command],
    };
  }
  if (snap.phase === 'debouncing' && snap.command) {
    return { text: 'DEBOUNCING…', color: '#8A94A8' };
  }
  if (snap.phase === 'refractory') {
    return {
      text: `REFRACTORY ${Math.ceil(snap.refractoryRemainingMs)} MS`,
      color: '#8A94A8',
    };
  }
  return { text: idleHint, color: '#8A94A8' };
}

/** Resize a canvas to its CSS size at device-pixel-ratio resolution. */
export function fitCanvas(canvas: HTMLCanvasElement): {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
} | null {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}
