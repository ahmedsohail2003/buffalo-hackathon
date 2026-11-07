// React wrapper for the bay scene. The BayView is created once per page and survives re-mounts
// (StrictMode, layout changes): this component only hosts its canvas and keeps it sized.
import { useEffect, useRef } from 'react';
import { getRuntime } from '../app/runtime';
import { BayView } from './bayView';

let view: BayView | null = null;
let detach: (() => void) | null = null;

/** The page's bay view (created on first call; needs a browser with WebGL). */
export function getBayView(): BayView {
  if (!view) {
    const rt = getRuntime();
    view = new BayView(rt.core, rt.bayCamera);
    detach = rt.attachScene(view);
  }
  return view;
}

/** Tear the view down (tests and hot reload only). */
export function disposeBayView(): void {
  detach?.();
  view?.dispose();
  view = null;
  detach = null;
}

export function BayScene({ className }: { className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let v: BayView;
    try {
      v = getBayView();
    } catch (err) {
      console.error('[scene] WebGL is not available', err);
      el.dataset.failed = 'true';
      return;
    }
    el.appendChild(v.canvas);
    const resize = () => v.setSize(el.clientWidth, el.clientHeight);
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (v.canvas.parentElement === el) el.removeChild(v.canvas);
    };
  }, []);
  return <div ref={host} className={className} />;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => disposeBayView());
}
