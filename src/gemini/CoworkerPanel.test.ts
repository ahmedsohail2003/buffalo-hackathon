import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeFakeBay } from './__fixtures__/fakeBay';
import { getGeminiClient } from './client';
import type { ToolTrace } from './coworker';
import { CoworkerPanel, replySound, requestNote } from './CoworkerPanel';
import { nullSink } from './types';

describe('CoworkerPanel', () => {
  it('renders the chat, voice controls and the ledger without a browser', () => {
    getGeminiClient().record({ t: 1, model: 'gemini-robotics-er-2-preview', purpose: 'point', latencyMs: 812, promptTokens: 1200, outputTokens: 40, thoughtTokens: 0, costUsd: 0.0014, ok: true });
    const html = renderToStaticMarkup(createElement(CoworkerPanel, { bay: makeFakeBay(), sink: nullSink }));
    expect(html).toContain('CAPCOM');
    expect(html).toContain('TALK (hold)');
    expect(html).toContain('Connect voice');
    expect(html).toContain('ElevenLabs');
    expect(html).toContain('Gemini native');
    expect(html).toContain('Robotics-ER');
    expect(html).toContain('812 ms');
    expect(html).toContain('$0.0014');
    const waiting = renderToStaticMarkup(createElement(CoworkerPanel, { bay: null, sink: nullSink }));
    expect(waiting).toContain('waiting for the bay');
  });

  it('fills its slot: the chat log takes the height left and scrolls; showLedger={false} leaves the ledger out', () => {
    const html = renderToStaticMarkup(createElement(CoworkerPanel, { bay: makeFakeBay(), sink: nullSink, showLedger: false }));
    const panel = html.match(/<section[^>]*style="([^"]*)"/)?.[1] ?? '';
    expect(panel).toContain('height:100%');
    expect(panel).toContain('box-sizing:border-box');
    const log = html.match(/class="sh-cw-log" style="([^"]*)"/)?.[1] ?? '';
    expect(log).toContain('flex:1');
    expect(log).toContain('min-height:0');
    expect(log).not.toContain('max-height');
    expect(html).not.toContain('Gemini call ledger');
    expect(html).toContain('Message to CAPCOM');
    expect(html).toContain('TALK (hold)');
  });

  it('the app mounts it without its own ledger and gives the coworker and fabricator slots the room', () => {
    expect(readFileSync('src/gemini/install.tsx', 'utf8')).toMatch(/<CoworkerPanel[^>]*showLedger=\{false\}/);
    const css = readFileSync('src/styles.css', 'utf8');
    const flex = (slot: string) => css.match(new RegExp(`\\.slot\\.${slot}\\s*\\{[^}]*?flex:\\s*([^;]+);`))?.[1].trim();
    expect([flex('coworker'), flex('fabricator'), flex('samples')]).toEqual(['1.3 1 0', '1.3 1 0', '0.7 1 0']);
  });

  it('a reply that stopped early plays the reject sound, even after a successful pick', () => {
    const trace = (name: string, ok: boolean): ToolTrace => ({ name, args: {}, result: { ok }, summary: '' });
    const pick = trace('pick_sample', true);
    const refusedPlace = trace('place_sample', false);
    expect(replySound({ tools: [pick, refusedPlace, refusedPlace], stopped: 'max_rounds' })).toBe('reject');
    expect(replySound({ tools: [pick], stopped: 'aborted' })).toBe('reject');
    expect(replySound({ tools: [], stopped: 'error' })).toBe('reject');
    expect(replySound({ tools: [pick, trace('place_sample', true)] })).toBe('task-done');
    expect(replySound({ tools: [refusedPlace] })).toBe('reject');
    expect(replySound({ tools: [trace('describe_bay', true)] })).toBeNull();
  });

  it('a typed request in flight while the bay is STOPPED is shown as paused by the operator', () => {
    expect(requestNote(true, 'STOPPED')).toBe('Paused by the operator: thumbs up to resume.');
    for (const state of ['IDLE', 'RUNNING', 'SLOW', 'ESTOPPED', null] as const) expect(requestNote(true, state)).toBeNull();
    expect(requestNote(false, 'STOPPED')).toBeNull();
  });
});
