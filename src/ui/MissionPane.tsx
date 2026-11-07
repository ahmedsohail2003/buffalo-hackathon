import type { ComponentType, ReactNode } from 'react';
import type { Sample } from '../contracts';
import { inContainment } from '../core';
import { useSamples } from './hooks';
import { useSlots, type MissionSlotName } from './slots';

function Slot({ name, title, chip, empty }: { name: MissionSlotName; title: string; chip?: ReactNode; empty: ReactNode }) {
  const slots = useSlots();
  const Component: ComponentType | undefined = slots.mission[name];
  return (
    <div className={`slot ${name}`} aria-labelledby={`slot-${name}`}>
      <div className="slot-head">
        <h3 className="pane-title" id={`slot-${name}`}>
          {title}
        </h3>
        <span style={{ flex: 1 }} />
        {Component ? chip : <span className="chip">not connected</span>}
      </div>
      <div className="slot-body">{Component ? <Component /> : <div className="empty-slot">{empty}</div>}</div>
    </div>
  );
}

function SampleRow({ s }: { s: Sample }) {
  const m = s.mesh;
  const grip = m ? m.graspWidthMm : s.dims.w * 1000;
  const height = m ? m.heightMm : s.dims.h * 1000;
  const kind = m ? (m.source === 'nasa' ? 'NASA shape model' : m.source === 'gemini' ? 'Gemini design' : 'preset') : s.kind;
  return (
    <li className="sample">
      <span className="sw" style={{ background: s.color }} aria-hidden="true" />
      <div style={{ minWidth: 0 }}>
        <div className="nm" title={s.name}>
          {s.name}
        </div>
        <div className="meta">
          <span className="num">grip {grip.toFixed(1)} mm</span>
          <span className="num">h {height.toFixed(1)} mm</span>
          {m && <span className="num">{m.massG.toFixed(0)} g</span>}
          {m && m.scale < 1 && <span className="scaled num">scaled ×{m.scale.toFixed(2)}</span>}
        </div>
      </div>
      <div className="tags">
        {s.held ? <span className="chip cyan">held</span> : inContainment(s.pos[0], s.pos[1]) ? <span className="chip amber">contained</span> : null}
        <span className="chip" title={`Created by ${s.createdBy}`}>
          {kind}
        </span>
      </div>
    </li>
  );
}

function SamplesOnDeck() {
  const samples = useSamples();
  return (
    <div className="slot samples" aria-labelledby="slot-samples">
      <div className="slot-head">
        <h3 className="pane-title" id="slot-samples">
          Samples on deck
        </h3>
        <span style={{ flex: 1 }} />
        <span className="chip num">{samples.length}</span>
      </div>
      <div className="slot-body">
        {samples.length === 0 ? (
          <div className="empty-slot">
            <b>The deck is empty.</b>
            <span>Fabricate a sample, or reset the bay to restore the seed set.</span>
          </div>
        ) : (
          <ul className="samples-list">
            {samples.map((s) => (
              <SampleRow key={s.id} s={s} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function MissionPane() {
  return (
    <section className="pane mission-pane" aria-labelledby="mission-title">
      <div className="pane-head">
        <h2 className="pane-title" id="mission-title">
          Mission
        </h2>
        <span className="spacer" />
        <span className="chip">AI proposes · code decides</span>
      </div>
      <div className="pane-body">
        <Slot
          name="coworker"
          title="Coworker"
          empty={
            <>
              <b>Gemini coworker</b>
              <span>Plans picks and checks the bay through the fixed camera. It can only call validated tools, and it can never start or reset the bay.</span>
            </>
          }
        />
        <Slot
          name="fabricator"
          title="Fabricator"
          empty={
            <>
              <b>Sample fabricator</b>
              <span>Designs a sample from a prompt or a preset. Code measures it, scales it to fit the gripper, or refuses it and says why.</span>
            </>
          }
        />
        <SamplesOnDeck />
      </div>
    </section>
  );
}
