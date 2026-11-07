// Mission-control callouts: listens to the mission log and speaks short lines in the mission
// voice, at most one every 2.5 s. An emergency stop cuts through everything at once. Rules are
// pattern-based on the line kind and text, so any layer can trigger one; a line that starts with
// [CALLOUT] is spoken as written. No DOM: safe to import anywhere.
import type { LogLine } from '../contracts';
import type { LogSource } from '../gemini/types';

export type CalloutPriority = 'estop' | 'high' | 'normal';

export interface Callout {
  text: string;
  priority: CalloutPriority;
  /** callouts with the same key inside the dedupe window are spoken once */
  key: string;
}

export interface AnnouncerSpeaker {
  say(text: string, voice?: 'mission' | 'coworker'): void;
  cancel(): void;
}

export interface AnnouncerOptions {
  speaker: AnnouncerSpeaker;
  minGapMs?: number;
  dedupeMs?: number;
  /** after an emergency stop, only safety callouts are spoken for this long */
  estopQuietMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onSpoken?: (c: Callout) => void;
}

const RANK: Record<CalloutPriority, number> = { normal: 0, high: 1, estop: 2 };

function quotedName(text: string): string | undefined {
  const m = text.match(/["“]([^"”]{2,40})["”]/);
  return m?.[1].trim();
}

function firstSentence(text: string, max = 90): string {
  const t = text.replace(/^[^:]{0,40}:\s*/, '').trim();
  const m = t.match(/^(.*?[.!?])(\s|$)/);
  const s = (m ? m[1] : t).trim();
  const clipped = s.length > max ? `${s.slice(0, max).replace(/\s+\S*$/, '')}.` : s;
  return /[.!?]$/.test(clipped) ? clipped : `${clipped}.`;
}

/** "Fabricated "Chondrite shard": grip 32 mm, height 28 mm, 41 g (scaled 0.8)" -> a short summary. */
export function fabricatorSummary(text: string): string {
  const name = quotedName(text) ?? text.match(/fabricated\s+([A-Za-z][\w\s-]{1,40}?)(?:[:,(]|\s+-|$)/i)?.[1]?.trim();
  const grip = text.match(/grip(?:\s+width)?\D{0,3}(\d+(?:\.\d+)?)\s*mm/i)?.[1];
  const mass = text.match(/(\d+(?:\.\d+)?)\s*g\b/)?.[1];
  const scaled = /scaled|scale\s*0\.\d/i.test(text);
  let out = `${name ?? 'New sample'} fabricated.`;
  if (grip) out += ` Grip ${grip} millimetres.`;
  if (mass) out += ` ${mass} grams.`;
  if (scaled) out += ' Scaled to fit.';
  return out;
}

/** The callout for one log line, or null. Pure; the rules live here. */
export function calloutFor(line: LogLine): Callout | null {
  const text = line.text.trim();
  if (!text || line.kind === 'voice') return null;
  const explicit = text.match(/^\[CALLOUT\]\s*(.+)$/i);
  if (explicit) return { text: explicit[1].trim(), priority: 'high', key: `callout:${explicit[1].trim()}` };
  const t = text.toLowerCase();

  if (line.kind === 'safety') {
    if (/e-?stop|emergency/.test(t)) {
      if (/clear|reset|releas|disengag|re-?arm/.test(t)) return { text: 'Emergency stop cleared.', priority: 'high', key: 'estop-clear' };
      return { text: 'Emergency stop. Arm locked.', priority: 'estop', key: 'estop' };
    }
    if (/resum/.test(t)) return { text: 'Resuming. Arm is live.', priority: 'high', key: 'resume' };
    if (/cycle start/.test(t)) return { text: 'Cycle start.', priority: 'high', key: 'cycle-start' };
    if (/\bslow/.test(t)) return { text: 'Slow mode. Half speed.', priority: 'high', key: 'slow' };
    if (/\bstop/.test(t)) return { text: 'All stop. Arm holding.', priority: 'high', key: 'stop' };
    return null;
  }

  const negative = /\bnot\b|fail|refus|reject|miss|abort|outside/.test(t);
  if (/containment/.test(t) && /secured|in containment|inside containment|into containment|placed|released|stowed/.test(t) && !negative) {
    const name = quotedName(text);
    return { text: name ? `${name} secured in containment.` : 'Sample secured in containment.', priority: 'normal', key: 'containment' };
  }
  if (line.kind === 'fabricator' && /fabricat|materiali[sz]/.test(t) && !negative) {
    return { text: fabricatorSummary(text), priority: 'normal', key: `fab:${t}` };
  }
  if (line.kind === 'reject') return { text: `Negative. ${firstSentence(text)}`, priority: 'normal', key: `reject:${t}` };
  if (/\btask (complete|completed|done|finished)\b/.test(t)) return { text: 'Task complete.', priority: 'normal', key: 'task-done' };
  if (/\btask (failed|aborted)\b/.test(t)) return { text: 'Task failed.', priority: 'normal', key: 'task-failed' };
  return null;
}

export class Announcer {
  private readonly speaker: AnnouncerSpeaker;
  private readonly minGapMs: number;
  private readonly dedupeMs: number;
  private readonly estopQuietMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onSpoken?: (c: Callout) => void;
  private lastAt = -Infinity;
  private lastEstopAt = -Infinity;
  private pending: Callout | null = null;
  private timer: unknown = null;
  private readonly recent = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;
  enabled = true;

  constructor(opts: AnnouncerOptions) {
    this.speaker = opts.speaker;
    this.minGapMs = opts.minGapMs ?? 2500;
    this.dedupeMs = opts.dedupeMs ?? 8000;
    this.estopQuietMs = opts.estopQuietMs ?? 4000;
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onSpoken = opts.onSpoken;
  }

  /** Listen to a log source (for example bus.onLog). Returns the unsubscribe function. */
  attach(source: LogSource): () => void {
    this.unsubscribe?.();
    const off = source((line) => this.handle(line));
    this.unsubscribe = off;
    return () => {
      off();
      if (this.unsubscribe === off) this.unsubscribe = null;
    };
  }

  handle(line: LogLine): void {
    const c = calloutFor(line);
    if (c) this.offer(c);
  }

  /** Speak something directly, through the same rate limit. */
  announce(text: string, priority: CalloutPriority = 'high'): void {
    this.offer({ text, priority, key: `manual:${text}` });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.pending = null;
  }

  private offer(c: Callout): void {
    if (!this.enabled) return;
    const now = this.now();
    if (c.priority === 'estop') {
      // Cuts through: drop whatever was queued or playing, speak now.
      this.pending = null;
      if (this.timer !== null) this.clearTimer(this.timer);
      this.timer = null;
      const last = this.recent.get(c.key);
      this.lastEstopAt = now;
      if (last !== undefined && now - last < this.minGapMs) return; // the same E-STOP reported twice
      this.speaker.cancel();
      this.speak(c, now);
      return;
    }
    if (c.priority === 'normal' && now - this.lastEstopAt < this.estopQuietMs) return;
    const last = this.recent.get(c.key);
    if (last !== undefined && now - last < this.dedupeMs) return;
    if (!this.pending && now - this.lastAt >= this.minGapMs) {
      this.speak(c, now);
      return;
    }
    // Rate-limited: hold one callout; a higher priority replaces it, and so does a newer equal one.
    if (!this.pending || RANK[c.priority] >= RANK[this.pending.priority]) this.pending = c;
    if (this.timer === null) {
      const wait = Math.max(0, this.lastAt + this.minGapMs - now);
      this.timer = this.setTimer(() => {
        this.timer = null;
        const next = this.pending;
        this.pending = null;
        if (next) this.speak(next, this.now());
      }, wait);
    }
  }

  private speak(c: Callout, now: number): void {
    this.lastAt = now;
    this.recent.set(c.key, now);
    if (this.recent.size > 200) for (const [k, t] of this.recent) if (now - t > this.dedupeMs) this.recent.delete(k);
    this.speaker.say(c.text, 'mission');
    try {
      this.onSpoken?.(c);
    } catch {
      // logging is best effort
    }
  }
}
