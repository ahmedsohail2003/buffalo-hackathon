import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Content } from '@google/genai/web';
import { setGenerateForTests } from './client';
import { cancelTask, cellEvents, ER_SYSTEM, ER_TOOLS, erToolsForDemo, runTask, taskStore } from './erLoop';
import { DEMO } from './models';
import { StubCell } from './stubs';
import { bus } from '../telemetry/bus';
import { egress } from '../telemetry/egress';

type Fake = { fc?: { name: string; args?: Record<string, unknown> }; json?: unknown };
const seen: { purpose: string; contents: Content[] }[] = [];
let queue: Fake[] = [];
let callCount = 0;
let idN = 0;
const usage = { promptTokenCount: 1200, candidatesTokenCount: 40, thoughtsTokenCount: 120 };

function fake(...q: Fake[]) {
  queue = q;
  setGenerateForTests(async ({ contents, config }) => {
    callCount++;
    const c = contents as Content[];
    const lastText = c[c.length - 1]?.parts?.map((p) => p.text ?? '').join('') ?? '';
    seen.push({ purpose: lastText.startsWith('Point to') ? 'point' : lastText.startsWith('This rendered') ? 'verify' : 'plan', contents: c });
    const r = queue.shift();
    if (!r) throw new Error(`no fake response for: ${lastText.slice(0, 40)}`);
    if (r.fc) {
      const call = { id: `call_${++idN}`, name: r.fc.name, args: r.fc.args ?? {} };
      void config;
      return { candidates: [{ content: { role: 'model', parts: [{ text: '', thoughtSignature: `sig${idN}` }, { functionCall: call }] } }], functionCalls: [call], text: '', usageMetadata: usage } as never;
    }
    return { text: JSON.stringify(r.json), usageMetadata: usage } as never;
  });
}
const point = (cell: StubCell): Fake => ({ json: [{ point: cell.projectMujoco([0, -0.23, 0.024]), label: 'red block' }] });
const verify = (ok: boolean, observation: string): Fake => ({ json: { ok, observation } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('erLoop.ts (StubCell + mocked callER)', () => {
  let cell: StubCell;
  let events: string[];
  let offEvents: () => void = () => {};
  beforeEach(() => { cell = new StubCell(5); seen.length = 0; callCount = 0; bus._reset(); egress._reset(); taskStore._reset(); DEMO.fcShape = 'A'; DEMO.consensusN = 1; events = []; offEvents = cellEvents.subscribe((t) => events.push(t)); });
  afterEach(() => { setGenerateForTests(null); cancelTask(); offEvents(); });

  it('DEMO_MODE exposes only high-level tools to ER and the prompt says so', () => {
    DEMO.highLevelOnly = true;
    expect(erToolsForDemo().map((t) => t.name)).toEqual(['pick', 'place_in_tray', 'place_at', 'home', 'done']);
    DEMO.highLevelOnly = false;
    expect(erToolsForDemo()).toBe(ER_TOOLS);
    DEMO.highLevelOnly = true;
    expect(ER_SYSTEM).toContain('To grasp a part use pick(object_id); do not descend with move_to.');
  });

  it('2-step happy path: point → plan(pick) → verify → act(place_in_tray) → verify → done; shape A turns', async () => {
    fake(point(cell), { fc: { name: 'pick', args: { object_id: 'block_1' } } }, verify(true, 'the red block is between the jaws'),
      { fc: { name: 'place_in_tray' } }, verify(true, 'the block rests inside the tray'), { fc: { name: 'done', args: { success: true, summary: 'moved the red block into the tray' } } });
    const rep = await runTask(cell, 'put the red block in the tray');
    expect(rep.ok).toBe(true);
    expect(rep.summary).toBe('moved the red block into the tray');
    expect(rep.steps.map((s) => [s.tool, s.ok, s.verify?.ok])).toEqual([['pick', true, true], ['place_in_tray', true, true]]);
    expect(rep.calls).toBe(6);
    expect(rep.costUsd).toBeGreaterThan(0);
    const b = cell.objects.get('block_1')!;
    expect(b.held).toBe(false);
    expect(Math.abs(b.pos[0] + 0.18)).toBeLessThan(0.01);
    expect(Math.abs(b.pos[1] + 0.13)).toBeLessThan(0.01);
    // turn shape: the act call sees [user(image+scene), model(verbatim, thoughtSignature), user(functionResponse with parts image)]
    const act = seen[3].contents;
    expect(act[0].role).toBe('user');
    expect(act[0].parts![0].inlineData?.mimeType).toBe('image/jpeg');
    expect(act[0].parts![1].text).toContain('Objects (ids, sizes and positions are authoritative)');
    expect(act[0].parts![1].text).toContain('Your pointing localized: red block at');
    expect(act[1].role).toBe('model');
    expect(act[1].parts![0].thoughtSignature).toBe('sig1');
    const fr = act[2].parts![0].functionResponse!;
    expect(act[2].role).toBe('user');
    expect(fr.name).toBe('pick');
    expect(fr.id).toBe('call_1');
    expect(fr.response).toMatchObject({ ok: true, held: 'block_1', verify: { ok: true } });
    expect((fr as { parts?: unknown[] }).parts).toHaveLength(1);
    expect(events).toEqual(['task finished: moved the red block into the tray']);
    const texts = bus.lines().map((l) => l.text);
    expect(texts.some((t) => t.startsWith('TASK START — auto CYCLE START'))).toBe(true);
    expect(texts.some((t) => /^ER plan HIGH /.test(t))).toBe(true);
    expect(texts.some((t) => /^TOOL pick\(object_id=block_1\) → ok held block_1/.test(t))).toBe(true);
    expect(texts.some((t) => /^ER done ✓ "moved the red block into the tray"  6 calls/.test(t))).toBe(true);
    expect(egress.get().cellFrames).toBe(6); // point, plan, 2 × (verify + functionResponse image): every frame that leaves is counted
    expect(taskStore.get().active).toBe(false);
    expect(taskStore.get().frame?.points[0].err).toBeLessThan(2);
  });

  it('verify false then true: ER disagreement is traced and fed back, loop continues', async () => {
    fake(point(cell), { fc: { name: 'pick', args: { object_id: 'block_1' } } }, verify(false, 'the block is still on the table'),
      { fc: { name: 'home' } }, verify(true, 'the arm is upright'), { fc: { name: 'done', args: { success: false, summary: 'could not lift the block' } } });
    const rep = await runTask(cell, 'lift the block');
    expect(rep.ok).toBe(false);
    expect(rep.steps[0].verify).toEqual({ ok: false, observation: 'the block is still on the table' });
    expect(rep.steps[1].verify?.ok).toBe(true);
    expect(bus.lines().some((l) => l.text.startsWith('DISAGREE code=true ER=false'))).toBe(true);
    const fr = seen[3].contents[2].parts![0].functionResponse!;
    expect(fr.response).toMatchObject({ ok: true, verify: { ok: false } });
    expect(events).toEqual(['task failed: could not lift the block']);
  });

  it('STOPPED cell: the loop waits with no ER call, then resumes after RUNNING', async () => {
    cell.gate.setState('STOPPED');
    fake(point(cell), { fc: { name: 'pick', args: { object_id: 'block_1' } } }, verify(true, 'lifted'), { fc: { name: 'done', args: { success: true, summary: 'lifted' } } });
    const p = runTask(cell, 'lift the block');
    await sleep(40);
    expect(callCount).toBe(0);
    expect(taskStore.get().phase).toBe('paused');
    expect(bus.lines().some((l) => l.text.startsWith('PAUSED: cell STOPPED — waiting for thumbs-up'))).toBe(true);
    expect(events).toEqual(['cell stopped mid-task; waiting for the operator']);
    cell.gate.setState('RUNNING');
    const rep = await p;
    expect(rep.ok).toBe(true);
    expect(callCount).toBe(4);
    expect(bus.lines().some((l) => l.text === 'RESUMED')).toBe(true);
    // second run: STOP between the primitive and its verification also waits
    cell.objects.reset(); cell.arm.heldId = null; cell.arm.jawOpen = true;
    fake(point(cell), { fc: { name: 'pick', args: { object_id: 'block_1' } } }, verify(true, 'lifted'), { fc: { name: 'done', args: { success: true, summary: 'lifted again' } } });
    const p2 = runTask(cell, 'lift the block again');
    await sleep(2); cell.gate.setState('STOPPED');
    await sleep(60);
    const callsWhileStopped = callCount;
    await sleep(30);
    expect(callCount).toBe(callsWhileStopped);
    cell.gate.setState('RUNNING');
    expect((await p2).ok).toBe(true);
    // a STOP that lands mid-step is traced exactly once, and the resume too
    expect(bus.lines().filter((l) => l.text.startsWith('PAUSED: cell STOPPED'))).toHaveLength(2);
    expect(bus.lines().filter((l) => l.text === 'RESUMED')).toHaveLength(2);
    expect(events.filter((e) => e.startsWith('cell stopped'))).toHaveLength(2);
  });

  it('ESTOP mid-task aborts: ABORTED report, no further ER calls, arm promises rejected', async () => {
    cell.arm.delayMs = 40;
    fake(point(cell), { fc: { name: 'pick', args: { object_id: 'block_1' } } }, verify(true, 'lifted'), { fc: { name: 'place_in_tray' } });
    const p = runTask(cell, 'put the red block in the tray');
    await sleep(30); // inside the first pick motion
    cell.gate.setState('ESTOPPED'); cell.arm.abortAll('EMERGENCY STOP');
    const rep = await p;
    expect(rep.ok).toBe(false);
    expect(rep.aborted).toBe(true);
    expect(rep.code).toBe('REJECTED_STATE');
    const calls = callCount;
    await sleep(80);
    expect(callCount).toBe(calls);
    expect(bus.lines().some((l) => l.text.startsWith('ABORTED: EMERGENCY STOP'))).toBe(true);
    expect(events[0]).toBe('emergency stop; the task was aborted');
    expect(events[1]).toMatch(/^task failed: /);
    expect(taskStore.get().active).toBe(false);
  });

  it('mutex: a second runTask is rejected while one runs; cancel_task aborts the first', async () => {
    cell.arm.delayMs = 30;
    fake(point(cell), { fc: { name: 'pick', args: { object_id: 'block_1' } } }, verify(true, 'lifted'), { fc: { name: 'done', args: { success: true, summary: 'ok' } } });
    const p = runTask(cell, 'first task');
    await sleep(5);
    const second = await runTask(cell, 'second task');
    expect(second.ok).toBe(false);
    expect(second.code).toBe('BUSY');
    expect(second.summary).toContain('a task is already running: "first task"');
    expect(cancelTask()).toEqual({ ok: true, aborted: true });
    const rep = await p;
    expect(rep.aborted).toBe(true);
    expect(rep.summary).toBe('cancelled by the operator');
    // after the task ends the mutex is clear
    fake(point(cell), { fc: { name: 'done', args: { success: true, summary: 'nothing to do' } } });
    cell.arm.heldId = null; cell.objects.reset();
    expect((await runTask(cell, 'third task')).ok).toBe(true);
  });
});
