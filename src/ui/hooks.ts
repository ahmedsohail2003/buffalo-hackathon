// React bindings for the module-level stores (runtime, bus, egress, registry).
import { useSyncExternalStore } from 'react';
import type { BayState, GeminiCallEntry, LogLine, Sample } from '../contracts';
import { getLedger, getLog, onLedger, onLog } from '../app/bus';
import { egressSnapshot, onEgress, type EgressSnapshot } from '../app/egress';
import { getRuntime, type InputMode, type Telemetry } from '../app/runtime';

export function useBayState(): BayState {
  const gate = getRuntime().core.gate;
  return useSyncExternalStore(
    (cb) => gate.onChange(() => cb()),
    () => gate.state(),
  );
}

export function useTelemetry(): Telemetry {
  const rt = getRuntime();
  return useSyncExternalStore(
    (cb) => rt.onTelemetry(cb),
    () => rt.getTelemetry(),
  );
}

export function useInputMode(): InputMode {
  const rt = getRuntime();
  return useSyncExternalStore(
    (cb) => rt.onInputMode(cb),
    () => rt.getInputMode(),
  );
}

export function useLastCapture(): { dataUrl: string; t: number } | null {
  const rt = getRuntime();
  return useSyncExternalStore(
    (cb) => rt.onCapture(cb),
    () => rt.getLastCapture(),
  );
}

export function useLog(): readonly LogLine[] {
  return useSyncExternalStore((cb) => onLog(() => cb()), getLog);
}

export function useLedger(): readonly GeminiCallEntry[] {
  return useSyncExternalStore((cb) => onLedger(() => cb()), getLedger);
}

export function useEgress(): EgressSnapshot {
  return useSyncExternalStore((cb) => onEgress(() => cb()), egressSnapshot);
}

// The registry can change every frame while a sample is carried: re-read it at most 10 times a second.
let samplesSnap: Sample[] | null = null;
let samplesTimer: ReturnType<typeof setTimeout> | null = null;
const samplesSubs = new Set<() => void>();
let samplesOff: (() => void) | null = null;

function subscribeSamples(cb: () => void): () => void {
  samplesSubs.add(cb);
  if (!samplesOff) {
    samplesOff = getRuntime().core.samples.onChange(() => {
      if (samplesTimer) return;
      samplesTimer = setTimeout(() => {
        samplesTimer = null;
        samplesSnap = getRuntime().core.samples.list();
        samplesSubs.forEach((fn) => fn());
      }, 100);
    });
  }
  return () => {
    samplesSubs.delete(cb);
  };
}

function readSamples(): Sample[] {
  if (!samplesSnap) samplesSnap = getRuntime().core.samples.list();
  return samplesSnap;
}

export function useSamples(): Sample[] {
  return useSyncExternalStore(subscribeSamples, readSamples);
}

/** Clock that re-renders once a second (for elapsed-time labels). */
let nowSnap = Date.now();
const nowSubs = new Set<() => void>();
let nowTimer: ReturnType<typeof setInterval> | null = null;

export function useNow(): number {
  return useSyncExternalStore(
    (cb) => {
      nowSubs.add(cb);
      if (!nowTimer)
        nowTimer = setInterval(() => {
          nowSnap = Date.now();
          nowSubs.forEach((fn) => fn());
        }, 1000);
      return () => {
        nowSubs.delete(cb);
        if (nowSubs.size === 0 && nowTimer) {
          clearInterval(nowTimer);
          nowTimer = null;
        }
      };
    },
    () => nowSnap,
  );
}
