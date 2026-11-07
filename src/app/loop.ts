// requestAnimationFrame loop with a timer watchdog: embedded/hidden browser panes
// can stop delivering RAF callbacks entirely; the watchdog keeps the cell clock,
// arm motion and scene sync alive at ~30 Hz until RAF resumes.

export function startLoop(fn: (now: number) => void, watchdogMs = 200): () => void {
  let raf = 0;
  let stopped = false;
  let lastTick = performance.now();
  const tick = (now: number) => {
    if (stopped) return;
    lastTick = now;
    fn(now);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  const iv = window.setInterval(() => {
    if (stopped) return;
    const now = performance.now();
    if (now - lastTick > watchdogMs) {
      lastTick = now;
      fn(now);
    }
  }, 33);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    window.clearInterval(iv);
  };
}
