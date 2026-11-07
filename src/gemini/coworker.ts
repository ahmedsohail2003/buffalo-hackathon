// The typed coworker: function calling on the fast model, at most 6 rounds per request. It moves
// the arm only through the tools, never claims success without a tool result, and cannot stop
// or resume the bay (hand signals and the panel own safety). An emergency stop cancels the run.
// No DOM.
import type { BayApi } from '../contracts';
import { GeminiError, callGemini, errorText, type CallFn, type Content, type Part } from './client';
import { BAY_FACTS_TEXT } from './bayFacts';
import { FLASH, type ThinkingLevel } from './models';
import { TOOL_DECLARATIONS, describeBay, dispatchTool, summarizeResult, type ToolContext, type ToolResult } from './tools';
import { logTo, type LogSink } from './types';

export const COWORKER_PROMPT = [
  'You are CAPCOM, the AI coworker in an orbital sample-curation bay. You run a simulated SO-101 robot arm, and only through your tools.',
  'Voice: a calm flight director. Short, plain sentences. Millimetres for distances, grams for mass. No exclamation marks, no filler.',
  `Bay facts: ${BAY_FACTS_TEXT}`,
  'Each request starts with a [BAY SNAPSHOT] of the sample registry and the arm at that moment. Give positions in mm in the bay frame.',
  'Rules:',
  '1. Never say an action worked unless its tool result in this turn says ok: true. When a tool refuses, give its reason in one sentence and the next step if there is one.',
  '2. You cannot stop, resume, slow or reset the bay. The operator owns safety: an open palm stops the arm, a held fist is an emergency stop, and the panel has the same controls. If asked to stop, tell the operator to use them.',
  '3. While the bay is STOPPED or ESTOPPED, do not try to move. While it is IDLE, the arm only moves after the operator starts the cycle (Victory sign or CYCLE START): ask them to, and do not retry the move until the bay is RUNNING. Read-only tools still work.',
  '4. Use sample ids from the snapshot or describe_bay. If the target is ambiguous, ask one short question.',
  '5. After a pick or a place you may call check_bay once to confirm on camera. Gemini sees, code decides: if the camera and the registry disagree, trust the registry and say that they disagree.',
  '6. design_sample asks the fabricator for a new sample. Code measures it and may scale or refuse it. Report what code measured, not what was asked for.',
  '7. Reply in at most three sentences.',
].join('\n');

export interface CoworkerOptions {
  call?: CallFn;
  sink?: LogSink | null;
  tools?: ToolContext;
  model?: string;
  level?: ThinkingLevel;
  maxRounds?: number;
  /** request/reply pairs kept between requests */
  historyTurns?: number;
  /** prepend a registry snapshot to each request (saves a describe_bay round); default true */
  snapshot?: boolean;
}

export interface ToolTrace {
  name: string;
  args: Record<string, unknown>;
  result: ToolResult;
  summary: string;
}

export interface CoworkerReply {
  text: string;
  tools: ToolTrace[];
  rounds: number;
  stopped?: 'max_rounds' | 'aborted' | 'error' | 'busy';
  error?: string;
}

export const MAX_ROUNDS = 6;

export class Coworker {
  private history: Content[] = [];
  private current: AbortController | null = null;
  private abortReason = '';
  private unsubGate: (() => void) | null;
  busy = false;
  /** each tool call as it completes (for live chat lines) */
  onTool: ((t: ToolTrace) => void) | null = null;

  constructor(
    private readonly bay: BayApi,
    private readonly opts: CoworkerOptions = {},
  ) {
    this.unsubGate = bay.gate.onChange((s) => {
      if (s === 'ESTOPPED') this.abort('Emergency stop. Request cancelled.');
    });
  }

  /** Cancel the request in flight (the arm core aborts its own motion separately). */
  abort(reason = 'Request cancelled.'): void {
    if (!this.current) return;
    this.abortReason = reason;
    this.current.abort();
  }

  /** Forget the conversation. */
  reset(): void {
    this.history = [];
  }

  dispose(): void {
    this.abort();
    this.unsubGate?.();
    this.unsubGate = null;
  }

  async ask(text: string, signal?: AbortSignal): Promise<CoworkerReply> {
    const request = text.trim();
    if (!request) return { text: '', tools: [], rounds: 0 };
    if (this.busy) return { text: 'Still working on the last request.', tools: [], rounds: 0, stopped: 'busy' };
    this.busy = true;
    const ac = new AbortController();
    this.current = ac;
    this.abortReason = '';
    const onOuter = () => this.abort();
    signal?.addEventListener('abort', onOuter, { once: true });

    const call = this.opts.call ?? callGemini;
    const maxRounds = this.opts.maxRounds ?? MAX_ROUNDS;
    const sink = this.opts.sink ?? this.opts.tools?.sink;
    const first = this.opts.snapshot === false ? request : `[BAY SNAPSHOT] ${this.snapshot()}\n\nOperator: ${request}`;
    const contents: Content[] = [...this.history, { role: 'user', parts: [{ text: first }] }];
    const traces: ToolTrace[] = [];
    let rounds = 0;
    let finalText = '';
    let stopped: CoworkerReply['stopped'];
    let error: string | undefined;

    try {
      for (;;) {
        if (rounds >= maxRounds) {
          stopped = 'max_rounds';
          break;
        }
        rounds++;
        const res = await call({
          purpose: 'coworker',
          model: this.opts.model ?? FLASH,
          level: this.opts.level ?? 'LOW',
          contents,
          config: {
            systemInstruction: { parts: [{ text: COWORKER_PROMPT }] },
            tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
          },
          signal: ac.signal,
        });
        // Keep the model turn exactly as returned: Gemini needs its thought signatures back.
        contents.push(res.content);
        if (!res.functionCalls.length) {
          finalText = res.text.trim();
          break;
        }
        const responses: Part[] = [];
        for (const fc of res.functionCalls) {
          if (ac.signal.aborted) break;
          const name = fc.name ?? '';
          const args = fc.args ?? {};
          const result = await dispatchTool(this.bay, name, args, 'coworker', { ...this.opts.tools, ...(sink ? { sink } : {}), signal: ac.signal });
          const trace: ToolTrace = { name, args, result, summary: summarizeResult(name, result) };
          traces.push(trace);
          try {
            this.onTool?.(trace);
          } catch {
            // UI callback errors do not stop the loop
          }
          responses.push({ functionResponse: { name, ...(fc.id ? { id: fc.id } : {}), response: result } });
        }
        if (ac.signal.aborted) {
          stopped = 'aborted';
          break;
        }
        contents.push({ role: 'user', parts: responses });
      }
    } catch (err) {
      if (ac.signal.aborted || (err instanceof GeminiError && err.code === 'ABORTED')) stopped = 'aborted';
      else {
        stopped = 'error';
        error = errorText(err);
      }
    } finally {
      signal?.removeEventListener('abort', onOuter);
      this.current = null;
      this.busy = false;
    }

    const last = traces[traces.length - 1];
    if (!finalText) {
      if (stopped === 'max_rounds') finalText = `Step limit reached after ${maxRounds} rounds.${last ? ` Last result: ${last.summary}.` : ''}`;
      else if (stopped === 'aborted') finalText = this.abortReason || 'Request cancelled.';
      else if (stopped === 'error') finalText = `Gemini is not answering: ${error}.${last ? ` Last result: ${last.summary}.` : ''}`;
      else finalText = last ? `Last result: ${last.summary}.` : 'No reply from Gemini.';
    }

    if (stopped !== 'aborted' && stopped !== 'error') {
      this.history.push({ role: 'user', parts: [{ text: request }] }, { role: 'model', parts: [{ text: finalText }] });
      const keep = (this.opts.historyTurns ?? 6) * 2;
      if (this.history.length > keep) this.history = this.history.slice(this.history.length - keep);
    }
    if (stopped === 'error') logTo(sink, 'gemini', `Coworker stopped: ${error}`);
    return { text: finalText, tools: traces, rounds, ...(stopped ? { stopped } : {}), ...(error ? { error } : {}) };
  }

  private snapshot(): string {
    const d = describeBay(this.bay, this.opts.tools?.containmentMm);
    delete d.frame;
    return JSON.stringify(d);
  }
}
