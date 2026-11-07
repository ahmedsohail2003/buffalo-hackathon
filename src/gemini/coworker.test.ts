import { describe, expect, it } from 'vitest';
import { makeFakeBay, makeSample } from './__fixtures__/fakeBay';
import type { CallFn, CallRequest, CallResult, Content, FunctionCallPart } from './client';
import { COWORKER_PROMPT, Coworker, MAX_ROUNDS } from './coworker';

const bennu = makeSample({ id: 's1', name: 'Bennu fragment', pos: [0.05, -0.22, 0.015] });

type Turn = { text?: string; calls?: FunctionCallPart[]; signature?: string };

/** A fake model: each round returns the next scripted turn and records what it was sent. */
function fakeModel(turns: Turn[]) {
  const requests: CallRequest[] = [];
  const call: CallFn = async (req) => {
    requests.push({ ...req, contents: structuredClone(req.contents) });
    const t = turns.shift() ?? { text: 'Out of script.' };
    const parts = [
      ...(t.text ? [{ text: t.text }] : []),
      ...(t.calls ?? []).map((fc, i) => ({ functionCall: fc, ...(i === 0 && t.signature ? { thoughtSignature: t.signature } : {}) })),
    ];
    return { text: t.text ?? '', functionCalls: t.calls ?? [], content: { role: 'model', parts } } as CallResult;
  };
  return { call, requests };
}

const contentsOf = (r: CallRequest) => r.contents as Content[];

describe('coworker loop', () => {
  it('runs a tool call, sends the result back with its id and thought signature, then replies', async () => {
    const bay = makeFakeBay({ samples: [bennu] });
    const { call, requests } = fakeModel([
      { calls: [{ id: 'fc-1', name: 'pick_sample', args: { id: 's1' } }], signature: 'sig-abc' },
      { text: 'Bennu fragment secured in the gripper.' },
    ]);
    const cw = new Coworker(bay, { call });
    const reply = await cw.ask('Pick up the Bennu sample.');

    expect(reply.text).toBe('Bennu fragment secured in the gripper.');
    expect(reply.rounds).toBe(2);
    expect(reply.tools.map((t) => [t.name, t.result.ok, t.summary])).toEqual([['pick_sample', true, 'ok, holding s1']]);
    expect(bay.calls.map((c) => c.fn)).toEqual(['pick']);

    const first = requests[0];
    expect(first.purpose).toBe('coworker');
    expect(first.level).toBe('LOW');
    expect(first.config?.systemInstruction).toEqual({ parts: [{ text: COWORKER_PROMPT }] });
    const userText = String(contentsOf(first)[0].parts?.[0].text);
    expect(userText).toMatch(/^\[BAY SNAPSHOT\] \{.*"id":"s1".*\}\n\nOperator: Pick up the Bennu sample\.$/s);

    const second = contentsOf(requests[1]);
    expect(second).toHaveLength(3);
    expect(second[1].parts?.[0]).toMatchObject({ thoughtSignature: 'sig-abc', functionCall: { id: 'fc-1', name: 'pick_sample' } });
    expect(second[2]).toMatchObject({ role: 'user', parts: [{ functionResponse: { id: 'fc-1', name: 'pick_sample', response: { ok: true, holding: 's1' } } }] });
  });

  it('feeds a gate refusal back to the model instead of moving', async () => {
    const bay = makeFakeBay({ samples: [bennu], state: 'STOPPED' });
    const { call, requests } = fakeModel([
      { calls: [{ name: 'pick_sample', args: { id: 's1' } }] },
      { text: 'Negative. The bay is stopped; resume is your call.' },
    ]);
    const reply = await new Coworker(bay, { call }).ask('grab s1');
    expect(bay.calls).toEqual([]);
    expect(reply.tools[0].result).toMatchObject({ ok: false, code: 'BAY_STOPPED' });
    expect(contentsOf(requests[1])[2].parts?.[0].functionResponse?.response).toMatchObject({ ok: false, code: 'BAY_STOPPED' });
    expect(reply.text).toContain('stopped');
  });

  it(`stops after ${MAX_ROUNDS} model rounds and reports the last tool result`, async () => {
    const bay = makeFakeBay({ samples: [bennu] });
    const loop = Array.from({ length: 10 }, () => ({ calls: [{ name: 'bay_status', args: {} }] }));
    const { call, requests } = fakeModel(loop);
    const reply = await new Coworker(bay, { call }).ask('status, forever');
    expect(requests).toHaveLength(MAX_ROUNDS);
    expect(reply.stopped).toBe('max_rounds');
    expect(reply.text).toBe(`Step limit reached after ${MAX_ROUNDS} rounds. Last result: bay RUNNING, arm idle, holding nothing.`);
  });

  it('keeps a short text-only history between requests', async () => {
    const bay = makeFakeBay({ samples: [bennu] });
    const { call, requests } = fakeModel([{ text: 'One sample on deck.' }, { text: 'It is s1.' }]);
    const cw = new Coworker(bay, { call });
    await cw.ask('How many samples?');
    await cw.ask('Which one?');
    const c = contentsOf(requests[1]);
    expect(c.slice(0, 2)).toEqual([
      { role: 'user', parts: [{ text: 'How many samples?' }] },
      { role: 'model', parts: [{ text: 'One sample on deck.' }] },
    ]);
    expect(String(c[2].parts?.[0].text)).toContain('Operator: Which one?');
  });

  it('an emergency stop cancels the request in flight', async () => {
    const bay = makeFakeBay({ samples: [bennu] });
    bay.holdMoves = true;
    const { call } = fakeModel([{ calls: [{ name: 'pick_sample', args: { id: 's1' } }] }, { text: 'should never be asked' }]);
    const cw = new Coworker(bay, { call });
    const pending = cw.ask('pick s1');
    await new Promise((r) => setTimeout(r, 5));
    bay.setState('ESTOPPED');
    bay.release();
    const reply = await pending;
    expect(reply.stopped).toBe('aborted');
    expect(reply.text).toBe('Emergency stop. Request cancelled.');
    expect(cw.busy).toBe(false);
  });

  it('reports a Gemini failure plainly', async () => {
    const bay = makeFakeBay({ samples: [bennu] });
    const call: CallFn = async () => {
      throw new Error('HTTP 503: overloaded');
    };
    const reply = await new Coworker(bay, { call }).ask('status');
    expect(reply).toMatchObject({ stopped: 'error', text: 'Gemini is not answering: HTTP 503: overloaded.' });
  });
});
