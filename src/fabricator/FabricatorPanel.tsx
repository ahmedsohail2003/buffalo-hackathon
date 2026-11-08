// Fabricator panel: describe a sample or click a preset; code builds it, measures it, scales it into the
// gripper's limits or refuses, then the registry places it on the deck. Presets always work offline.
// The result card sits right under the input, above the presets, and scrolls into view when it changes.

import { useCallback, useEffect, useRef, useState, type Ref } from 'react';
import type { BayApi, MeshInfo, Rejection } from '../contracts';
import { designAndFabricate, type GenerateJson } from './designer';
import { fabricatePreset, type Placed } from './fabricate';
import { figures, pct } from './guard';
import { PRESETS, matchPreset } from './presets';
import './fabricator.css';

interface Props {
  bay: BayApi | null;
  /** Builder A's Gemini JSON call; absent = offline (the designer falls back to the closest preset) */
  generateJson?: GenerateJson;
  log?: (text: string, kind?: string) => void;
}

export type Card = (Placed & { source?: MeshInfo['source']; latencyMs?: number; attempts?: number }) | (Rejection & { title?: string; note?: string });

const SOURCE_LABEL: Record<MeshInfo['source'], string> = { preset: 'preset', gemini: 'Gemini design', nasa: 'NASA shape model' };
/** Where a sample came from when a design request ended in a preset (Gemini offline or not answering). */
const FALLBACK_LABEL = 'preset fallback';

/**
 * The mission-log line for one result. It names the sample and its source ("Gemini design", "preset", "NASA
 * shape model" or "preset fallback"), never the typed prompt; mission control speaks it (voice/announcer.ts).
 * A refusal names the refused design when there is one.
 */
export function fabLogLine(r: Placed | Rejection, source: string, name?: string): { text: string; kind: 'fabricator' | 'reject' } {
  if (r.ok) return { text: `FABRICATOR "${r.sample.name}" (${source}) → ${r.sample.id}: ${r.reasons[0]}`, kind: 'fabricator' };
  return { text: `FABRICATOR ${name ? `"${name}" (${source})` : 'design'} → ${r.code}: ${r.reason}`, kind: 'reject' };
}

export function FabricatorPanel({ bay, generateJson, log }: Props) {
  // Empty, with the example as a placeholder: a presenter who clicks and types must not append to it.
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const [pickNote, setPickNote] = useState<string | null>(null);

  const report = useCallback((line: { text: string; kind: string }) => log?.(line.text, line.kind), [log]);

  const runPreset = useCallback(async (id: string) => {
    if (!bay) return;
    const p = PRESETS.find((x) => x.id === id);
    setBusy(id);
    setPickNote(null);
    try {
      const r = await fabricatePreset(bay, id);
      report(fabLogLine(r, SOURCE_LABEL[p?.source ?? 'preset'], p?.program.name));
      setCard(r.ok ? { ...r, source: p?.source ?? 'preset' } : { ...r, title: p?.program.name });
    } finally {
      setBusy(null);
    }
  }, [bay, report]);

  const design = useCallback(async () => {
    const t = text.trim();
    if (!bay || !t || busy) return;
    setBusy('design');
    setPickNote(null);
    try {
      if (!generateJson) {
        const p = matchPreset(t);
        const r = await fabricatePreset(bay, p.id);
        const note = `Gemini is not connected (it needs a key); fabricated the closest preset (${p.label}) instead.`;
        report(fabLogLine(r, FALLBACK_LABEL, p.program.name));
        setCard(r.ok ? { ...r, source: p.source, note } : { ...r, title: p.program.name, note });
        return;
      }
      const r = await designAndFabricate(bay, t, undefined, { generateJson });
      report(r.ok ? fabLogLine(r, r.source === 'gemini' ? SOURCE_LABEL.gemini : FALLBACK_LABEL) : fabLogLine(r, SOURCE_LABEL.gemini, r.program?.name));
      setCard(r.ok ? r : { ...r, title: r.program?.name ?? 'Design' });
    } catch (e) {
      setCard({ ok: false, code: 'DESIGN_FAILED', reason: `the designer failed: ${String((e as Error).message).slice(0, 100)}`, suggestion: 'try a preset?' });
    } finally {
      setBusy(null);
    }
  }, [bay, text, busy, generateJson, report]);

  const pickToBin = useCallback(async (id: string) => {
    if (!bay) return;
    setBusy('pick');
    setPickNote('picking…');
    try {
      const p = await bay.arm.pick(id);
      if (!p.ok) { setPickNote(`pick refused: ${p.reason}`); return; }
      const t = await bay.arm.placeInContainment();
      setPickNote(t.ok ? 'picked and placed in containment' : `place refused: ${t.reason}`);
    } finally {
      setBusy(null);
    }
  }, [bay]);

  const designing = busy === 'design';
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (card || designing) revealCard(cardRef.current);
  }, [card, designing]);

  return (
    <FabricatorView
      ready={!!bay}
      online={!!generateJson}
      text={text}
      onText={setText}
      onDesign={() => void design()}
      onPreset={(id) => void runPreset(id)}
      busy={busy}
      card={card}
      pickNote={pickNote}
      onPick={(id) => void pickToBin(id)}
      cardRef={cardRef}
    />
  );
}

/** Scroll the card into view inside the scrolling Mission slot, moving as little as possible. */
export function revealCard(el: Pick<Element, 'scrollIntoView'> | null): void {
  el?.scrollIntoView({ block: 'nearest' });
}

export interface FabricatorViewProps {
  /** the bay is there */
  ready: boolean;
  /** Gemini is connected (else designs fall back to the closest preset) */
  online: boolean;
  text: string;
  onText: (text: string) => void;
  onDesign: () => void;
  onPreset: (id: string) => void;
  /** 'design', 'pick' or the id of the preset being made; null when idle */
  busy: string | null;
  card: Card | null;
  pickNote: string | null;
  onPick: (id: string) => void;
  cardRef?: Ref<HTMLDivElement>;
}

/** The panel for a given state: the input, then the result card (or "Designing…"), then the presets. */
export function FabricatorView({ ready, online, text, onText, onDesign, onPreset, busy, card, pickNote, onPick, cardRef }: FabricatorViewProps) {
  const designing = busy === 'design';
  return (
    <section className="fab" aria-label="Fabricator">
      <header className="fab-head">
        <h3>Fabricator</h3>
        <span className="fab-sub">Gemini designs · code measures and decides</span>
      </header>
      <form className="fab-row" onSubmit={(e) => { e.preventDefault(); onDesign(); }}>
        <input className="fab-input" value={text} onChange={(e) => onText(e.target.value)} placeholder="e.g. a 30 mm fragment of asteroid Bennu" aria-label="Describe a sample" />
        <button type="submit" className="fab-btn primary" disabled={!ready || !!busy || !text.trim()} title={online ? 'Gemini designs a shape program; code builds, measures and checks it' : 'Gemini needs a key; offline this fabricates the closest preset'}>
          {designing ? 'Designing…' : 'Design with Gemini'}
        </button>
      </form>
      {!online && <div className="fab-note">Gemini is not connected, so designs fall back to the closest preset. Presets always work.</div>}
      {(designing || card) && (
        <div className="fab-slot" ref={cardRef}>
          {designing ? <DesigningCard /> : card && <ResultCard card={card} busy={!!busy} onPick={onPick} pickNote={pickNote} />}
        </div>
      )}
      <div className="fab-chips" role="group" aria-label="Sample presets">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" className={`fab-chip${p.source === 'nasa' ? ' nasa' : ''}`} disabled={!ready || !!busy} onClick={() => onPreset(p.id)} title={p.description}>
            {busy === p.id ? '…' : p.label}
          </button>
        ))}
      </div>
    </section>
  );
}

/** Stands in for the card while Gemini designs (the old card would describe the previous sample). */
function DesigningCard() {
  return (
    <div className="fab-card busy" aria-label="Fabricator result" role="status" aria-busy="true">
      <span className="fab-name">Designing…</span>
      <span className="fab-sub">Gemini drafts a shape program; code then measures it and decides.</span>
    </div>
  );
}

export function ResultCard({ card, busy, onPick, pickNote }: { card: Card; busy: boolean; onPick: (id: string) => void; pickNote: string | null }) {
  if (!card.ok) {
    return (
      <div className="fab-card fail" aria-label="Fabricator result" role="status">
        <div className="fab-card-head"><span className="fab-name">{card.title ?? 'Sample'} refused</span><span className="fab-src">{card.code}</span></div>
        {card.note && <div className="fab-note">{card.note}</div>}
        <div className="fab-reason">✗ {card.reason}</div>
        {card.suggestion && <div className="fab-suggest">Suggestion: {card.suggestion}</div>}
      </div>
    );
  }
  const m = card.sample.mesh!;
  const overall = m.scale * (card.fab.program.design_scale ?? 1); // against the real design size
  const shown = figures(card.fab.measured); // the same rounding as the card's sentences
  // name, numbers and Pick first: the Mission slot shows only about 200 px of a card that can be taller
  return (
    <div className="fab-card ok" aria-label="Fabricator result" role="status">
      <div className="fab-card-head">
        <span className="fab-name">{card.sample.name}</span>
        <span className="fab-src">{SOURCE_LABEL[card.source ?? m.source]}{card.latencyMs ? ` · ${(card.latencyMs / 1000).toFixed(1)} s` : ''} · {card.sample.id}</span>
      </div>
      <div className="fab-metrics">
        <span><b>{shown.gw}</b> mm across the jaw</span>
        <span><b>{shown.h}</b> mm tall</span>
        <span><b>{shown.g}</b> g</span>
        <span className={overall === 1 ? '' : 'scaled'}>scale <b>{pct(overall)}</b></span>
      </div>
      <div className="fab-row">
        <button type="button" className="fab-btn" disabled={busy} onClick={() => onPick(card.sample.id)}>Pick → containment</button>
        {pickNote && <span className="fab-sub">{pickNote}</span>}
      </div>
      {card.note && <div className="fab-note">{card.note}</div>}
      <ul className="fab-reasons">
        {card.reasons.map((r, i) => <li key={i} className={i === 0 ? 'lead' : ''}>{i === 0 ? '✓ ' : ''}{r}</li>)}
      </ul>
    </div>
  );
}
