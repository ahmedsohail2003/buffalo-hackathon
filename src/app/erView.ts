// How the camera results read and where they draw: the point_at caption (who pointed, at which
// sample, the miss in mm), the check_bay badge ("Bennu in bin: YES (registry) · camera: yes") and
// the mapping from bay-camera image points to the inset. Shared by the Bay pane and the deck
// marker. Pure.
import type { ErCheckEvent, ErPointEvent } from '../contracts';

/** How long a camera result stays on screen, ms; it fades out over the last ER_FADE_MS. */
export const ER_OVERLAY_MS = 6000;
export const ER_FADE_MS = 1500;

/** A sample name without its parenthetical: "Bennu (NASA shape model)" -> "Bennu". */
export function shortName(name: string): string {
  const s = name
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s || name.trim();
}

/** "1.5 mm off" (one decimal below 10 mm), "23 mm off". */
export function offText(errorMm: number): string {
  const v = Math.abs(errorMm);
  return `${v < 9.95 ? v.toFixed(1) : Math.round(v)} mm off`;
}

/** At most max characters, cut at a word where one is near the end. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export interface PointCaption {
  who: 'Robotics-ER';
  /** the matched sample's short name, else what was asked for */
  what: string;
  /** "1.5 mm off", "no registry match" or "off the deck" */
  off: string;
  /** the whole caption on one line */
  text: string;
}

export function pointCaption(ev: ErPointEvent): PointCaption {
  const asked = ev.label.replace(/^\s*(the|a|an)\s+/i, '').trim();
  const what = clip(ev.sample_name ? shortName(ev.sample_name) : asked || 'the point', 24);
  const off = !ev.found_mm ? 'off the deck' : ev.error_mm === null ? 'no registry match' : offText(ev.error_mm);
  return { who: 'Robotics-ER', what, off, text: `Robotics-ER · ${what} · ${off}` };
}

/** The short label that floats over the deck marker: who pointed and the miss in mm. */
export function markerText(ev: ErPointEvent): string {
  const c = pointCaption(ev);
  return ev.error_mm === null ? `Robotics-ER · ${c.what}` : `Robotics-ER · ${c.off}`;
}

/**
 * A bay-camera image point ([y, x], 0-1000, origin top-left) in the inset's SVG frame
 * (viewBox 0 0 1000 1000, the same square as the camera image): x across, y down, clamped to the
 * frame. inside is false when the model's point lies off the image.
 */
export function insetPoint(yx: readonly [number, number]): { x: number; y: number; inside: boolean } {
  const [y, x] = yx;
  const c = (v: number) => Math.min(1000, Math.max(0, v));
  return { x: c(x), y: c(y), inside: x >= 0 && x <= 1000 && y >= 0 && y <= 1000 };
}

export interface CheckBadge {
  /** "Bennu in bin", or the question in short ("Deck clear of debris") */
  subject: string;
  verdict: 'YES' | 'NO' | 'UNSURE';
  /** who decided */
  by: 'registry' | 'camera';
  /** who decided, as the badge's second line starts: "by registry" or "decided by the camera" */
  byText: string;
  /** "camera: yes" when the registry decided (what the camera said), else null */
  camera: string | null;
  /** the camera answered and disagrees with the registry */
  disagree: boolean;
  /** the badge on one line */
  text: string;
}

const AUX = /^(is|are|does|do|did|can|could|has|have|was|were|will|would|should)\s+/i;

/** "Is the deck clear of debris?" -> "Deck clear of debris" */
export function questionSubject(question: string): string {
  const s = question
    .trim()
    .replace(/[?.!\s]+$/, '')
    .replace(AUX, '')
    .replace(/^(the|a|an)\s+/i, '')
    .trim();
  return clip(s ? s[0].toUpperCase() + s.slice(1) : 'Camera check', 28);
}

export function checkBadge(ev: ErCheckEvent): CheckBadge {
  const byRegistry = ev.decided_by === 'registry';
  const verdict: CheckBadge['verdict'] = byRegistry ? (ev.decision ? 'YES' : 'NO') : ev.camera === 'yes' ? 'YES' : ev.camera === 'no' ? 'NO' : 'UNSURE';
  // the registry only decides the plain "is <one sample> in the bin?" question
  const subject = byRegistry && ev.sample_name ? `${clip(shortName(ev.sample_name), 18)} in bin` : questionSubject(ev.question);
  const camera = byRegistry ? `camera: ${ev.camera}` : null;
  const disagree = byRegistry && ev.agree === false;
  return {
    subject,
    verdict,
    by: byRegistry ? 'registry' : 'camera',
    byText: byRegistry ? 'by registry' : 'decided by the camera',
    camera,
    disagree,
    text: `${subject}: ${verdict} (${byRegistry ? 'registry' : 'camera'})${camera ? ` · ${camera}` : ''}`,
  };
}
