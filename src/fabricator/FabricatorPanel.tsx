// Fabricator panel: describe a sample or click a preset; code builds it, measures it, scales it into the
// gripper's limits or refuses, then the registry places it on the deck. Presets always work offline.

import { useCallback, useState } from 'react';
import type { BayApi, MeshInfo, Rejection } from '../contracts';
import { designAndFabricate, type Designed, type GenerateJson } from './designer';
import { fabricatePreset, type FabRejection, type Placed } from './fabricate';
import { PRESETS, matchPreset } from './presets';
import './fabricator.css';

interface Props {
  bay: BayApi | null;
  /** Builder A's Gemini JSON call; absent = offline (the designer falls back to the closest preset) */
  generateJson?: GenerateJson;
  log?: (text: string, kind?: string) => void;
}

type Card = (Placed & { source?: MeshInfo['source']; latencyMs?: number; attempts?: number }) | (Rejection & { title?: string; note?: string });

const SOURCE_LABEL: Record<MeshInfo['source'], string> = { preset: 'preset', gemini: 'Gemini design', nasa: 'NASA shape model' };

export function FabricatorPanel({ bay, generateJson, log }: Props) {
  const [text, setText] = useState('a 30 mm fragment of asteroid Bennu');
  const [busy, setBusy] = useState<string | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const [pickNote, setPickNote] = useState<string | null>(null);

  const report = useCallback((what: string, r: Placed | Designed | Rejection | FabRejection) => {
    log?.(r.ok ? `FABRICATOR ${what} → ${r.sample.id}: ${r.reasons[0]}` : `FABRICATOR ${what} → ${r.code}: ${r.reason}`, r.ok ? 'fabricator' : 'reject');
  }, [log]);

  const runPreset = useCallback(async (id: string) => {
    if (!bay) return;
    const p = PRESETS.find((x) => x.id === id);
    setBusy(id);
    setPickNote(null);
    try {
      const r = await fabricatePreset(bay, id);
      report(`preset "${p?.label ?? id}"`, r);
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
        report(`offline match "${t.slice(0, 40)}"`, r);
        setCard(r.ok ? { ...r, source: p.source, note } : { ...r, title: p.program.name, note });
        return;
      }
      const r = await designAndFabricate(bay, t, undefined, { generateJson });
      report(`design "${t.slice(0, 40)}"`, r);
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

  return (
    <section className="fab" aria-label="Fabricator">
      <header className="fab-head">
        <h3>Fabricator</h3>
        <span className="fab-sub">Gemini designs · code measures and decides</span>
      </header>
      <form className="fab-row" onSubmit={(e) => { e.preventDefault(); void design(); }}>
        <input className="fab-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Describe a sample…" aria-label="Describe a sample" />
        <button type="submit" className="fab-btn primary" disabled={!bay || !!busy || !text.trim()} title={generateJson ? 'Gemini designs a shape program; code builds, measures and checks it' : 'Gemini needs a key; offline this fabricates the closest preset'}>
          {busy === 'design' ? 'Designing…' : 'Design with Gemini'}
        </button>
      </form>
      {!generateJson && <div className="fab-note">Gemini is not connected, so designs fall back to the closest preset. Presets always work.</div>}
      <div className="fab-chips" role="group" aria-label="Sample presets">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" className={`fab-chip${p.source === 'nasa' ? ' nasa' : ''}`} disabled={!bay || !!busy} onClick={() => void runPreset(p.id)} title={p.description}>
            {busy === p.id ? '…' : p.label}
          </button>
        ))}
      </div>
      {card && <ResultCard card={card} busy={!!busy} onPick={pickToBin} pickNote={pickNote} />}
    </section>
  );
}

function ResultCard({ card, busy, onPick, pickNote }: { card: Card; busy: boolean; onPick: (id: string) => void; pickNote: string | null }) {
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
  return (
    <div className="fab-card ok" aria-label="Fabricator result" role="status">
      <div className="fab-card-head">
        <span className="fab-name">{card.sample.name}</span>
        <span className="fab-src">{SOURCE_LABEL[card.source ?? m.source]}{card.latencyMs ? ` · ${(card.latencyMs / 1000).toFixed(1)} s` : ''} · {card.sample.id}</span>
      </div>
      {card.note && <div className="fab-note">{card.note}</div>}
      <div className="fab-metrics">
        <span><b>{m.graspWidthMm.toFixed(0)}</b> mm across the jaw</span>
        <span><b>{m.heightMm.toFixed(0)}</b> mm tall</span>
        <span><b>{m.massG.toFixed(0)}</b> g</span>
        <span className={m.scale === 1 ? '' : 'scaled'}>scale <b>{Math.round(m.scale * 100)}%</b></span>
      </div>
      <ul className="fab-reasons">
        {card.reasons.map((r, i) => <li key={i} className={i === 0 ? 'lead' : ''}>{i === 0 ? '✓ ' : ''}{r}</li>)}
      </ul>
      <div className="fab-row">
        <button type="button" className="fab-btn" disabled={busy} onClick={() => onPick(card.sample.id)}>Pick → containment</button>
        {pickNote && <span className="fab-sub">{pickNote}</span>}
      </div>
    </div>
  );
}
