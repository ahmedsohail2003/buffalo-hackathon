import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { calloutFor } from '../voice/announcer';
import { fabricatePreset } from './fabricate';
import { fabLogLine } from './FabricatorPanel';
import { PRESETS } from './presets';
import { fakeBay, registerNasaAssets } from './testkit';

beforeAll(registerNasaAssets);

const doc = (name: string) => readFileSync(new URL(`../../docs/${name}`, import.meta.url), 'utf8');

/**
 * The scripts' refusal beat must be deterministic: a typed "antenna boom" goes to Gemini, gets a repair turn
 * and may come back repaired. The Antenna boom chip is a fixed program the guardrail refuses every time.
 */
describe('demo and video scripts: the scripted refusal is the Antenna boom chip', () => {
  for (const name of ['DEMO-SCRIPT.md', 'VIDEO-SCRIPT.md']) {
    it(`${name} uses the chip for the refusal and keeps the typed repair optional`, () => {
      const text = doc(name);
      expect(text).toMatch(/[Cc]lick the \*\*Antenna boom\*\* chip: it is refused/);
      expect(text).not.toMatch(/Ask for an "antenna boom": it is refused/i);
      expect(text).not.toMatch(/ask for an "antenna boom"/i);
      expect(text).toMatch(/Optional extra[^\n]*type "an antenna boom, 30 cm long"/);
      expect(text).toContain('Mission control: "Negative. It is too tall and thin for the jaw."');
      expect(text).not.toContain('204 g'); // the preset numbers a typed design no longer shows
    });
  }

  it('the chip the scripts name exists, is refused, and mission control says what they quote', async () => {
    const chip = PRESETS.find((p) => p.label === 'Antenna boom');
    expect(chip).toBeDefined();
    const r = await fabricatePreset(fakeBay(), chip!.id);
    expect(r.ok === false && r.code).toBe('TOO_THIN');
    expect(r.ok === false && r.reason).toMatch(/^it is too tall and thin for the jaw;/);
    const line = fabLogLine(r, 'preset', chip!.program.name);
    expect(calloutFor({ t: 0, kind: line.kind, text: line.text })?.text).toBe('Negative. It is too tall and thin for the jaw.');
  });
});
