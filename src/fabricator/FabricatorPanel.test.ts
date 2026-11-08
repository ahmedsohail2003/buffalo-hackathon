import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { ASTEROID_3M } from './__fixtures__/designs';
import { designAndFabricate, type GenerateJson } from './designer';
import { fabricatePreset } from './fabricate';
import { FabricatorView, ResultCard, revealCard, type Card, type FabricatorViewProps } from './FabricatorPanel';
import { fakeBay, registerNasaAssets } from './testkit';

beforeAll(registerNasaAssets);

/** A fake designer call that answers with one program. */
const answer = (program: unknown): GenerateJson => async () => ({ text: JSON.stringify(program), latencyMs: 900 });

const cardHtml = (card: Card) => renderToStaticMarkup(createElement(ResultCard, { card, busy: false, onPick: () => undefined, pickNote: null }));

const noop = () => undefined;
const viewHtml = (state: Partial<FabricatorViewProps>) =>
  renderToStaticMarkup(createElement(FabricatorView, {
    ready: true, online: true, text: 'an iron meteorite, about 5 cm', onText: noop, onDesign: noop, onPreset: noop,
    busy: null, card: null, pickNote: null, onPick: noop, ...state,
  }));

describe('Fabricator panel layout (the card must be visible after a design)', () => {
  it('puts the result card right under the input, above the preset chips', async () => {
    const r = await fabricatePreset(fakeBay(), 'iron');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const html = viewHtml({ card: r });
    const input = html.indexOf('aria-label="Describe a sample"');
    const card = html.indexOf('aria-label="Fabricator result"');
    const chips = html.indexOf('aria-label="Sample presets"');
    expect(input).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(input);
    expect(card).toBeLessThan(chips);
    expect(html.indexOf('Pick → containment')).toBeLessThan(chips);
    expect(html.indexOf('Iron meteorite</span>')).toBeLessThan(chips);
    // the slot shows about 200 px of a card that can be taller: name, numbers and Pick come first
    expect(html.indexOf('Pick → containment')).toBeLessThan(html.indexOf('class="fab-reasons"'));
    expect(html.indexOf('class="fab-metrics"')).toBeLessThan(html.indexOf('Pick → containment'));
  });

  it('while a design runs, a compact "Designing…" state replaces the old card', async () => {
    const old = await fabricatePreset(fakeBay(), 'iron');
    const html = viewHtml({ card: old as Card, busy: 'design' });
    expect(html).toContain('fab-card busy');
    expect(html).not.toContain('Iron meteorite</span>'); // the previous sample's card is gone
    expect(html).not.toContain('Pick → containment');
    expect(html.indexOf('fab-card busy')).toBeLessThan(html.indexOf('aria-label="Sample presets"'));
    // a preset run or a pick keeps the card where it is
    expect(viewHtml({ card: old as Card, busy: 'pick' })).toContain('Iron meteorite</span>');
  });

  it('scrolls the card into view inside the slot, as little as possible', () => {
    const calls: unknown[] = [];
    revealCard({ scrollIntoView: (opts?: boolean | ScrollIntoViewOptions) => void calls.push(opts) });
    expect(calls).toEqual([{ block: 'nearest' }]);
    expect(() => revealCard(null)).not.toThrow();
  });
});

describe('Fabricator result card', () => {
  it('shows the overall scale and the "as designed" size against the real design (a 3 m asteroid)', async () => {
    const r = await designAndFabricate(fakeBay(), 'a 3 metre asteroid', undefined, { generateJson: answer(ASTEROID_3M) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const html = cardHtml(r);
    expect(html).toMatch(/scale <b>1\.\d%<\/b>/); // not the guardrail's own 17 %
    expect(html).toMatch(/as designed it was 2\.\d m across/);
  });
});
