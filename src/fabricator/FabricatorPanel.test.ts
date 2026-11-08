import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { ASTEROID_3M } from './__fixtures__/designs';
import { designAndFabricate, type GenerateJson } from './designer';
import { ResultCard, type Card } from './FabricatorPanel';
import { fakeBay, registerNasaAssets } from './testkit';

beforeAll(registerNasaAssets);

/** A fake designer call that answers with one program. */
const answer = (program: unknown): GenerateJson => async () => ({ text: JSON.stringify(program), latencyMs: 900 });

const cardHtml = (card: Card) => renderToStaticMarkup(createElement(ResultCard, { card, busy: false, onPick: () => undefined, pickNote: null }));

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
