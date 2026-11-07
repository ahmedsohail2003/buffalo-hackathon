// Typed coworker over Flash: the same LIVE_TOOLS and system prompt, function calling in mode AUTO,
// candidates[0].content kept verbatim before every functionResponse. Whole voice brain in FALLBACK-VOICE.

import type { Content, FunctionCall, Part } from '@google/genai/web';
import type { CellApi } from '../contracts';
import { bus, fmtMs, fmtUsd } from '../telemetry/bus';
import { callER } from './client';
import { dispatchLiveTool, LIVE_SYSTEM, LIVE_TOOLS } from './live';
import { FLASH_MODEL } from './models';

const MAX_ROUNDS = 6;
// generateContent rejects FunctionDeclaration.behavior (Live-only): same tools minus that field.
const FLASH_TOOLS = LIVE_TOOLS.map((d) => { const c = { ...d }; delete c.behavior; return c; });

/** Returns a chat function bound to the cell; history persists for the session. */
export function makeFlashConsole(cell: CellApi): (text: string) => Promise<string> {
  const history: Content[] = [];
  return async (text: string) => {
    history.push({ role: 'user', parts: [{ text }] });
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const r = await callER({ purpose: 'flash_console', level: 'LOW', model: FLASH_MODEL, contents: history,
        config: { systemInstruction: LIVE_SYSTEM, tools: [{ functionDeclarations: FLASH_TOOLS }], toolConfig: { functionCallingConfig: { mode: 'AUTO' as never } }, temperature: 0.6 } });
      const content = r.res.candidates?.[0]?.content;
      const fcs = (r.res.functionCalls ?? []).filter((fc): fc is FunctionCall & { name: string } => !!fc.name);
      bus.emit({ kind: 'gemini', text: `FLASH console LOW ${fmtMs(r.latencyMs)}  ${fmtUsd(r.entry.costUsd)}${fcs.length ? '  → ' + fcs.map((f) => f.name).join(', ') : ''}` });
      history.push(content ?? { role: 'model', parts: r.text ? [{ text: r.text }] : [] });
      if (!fcs.length) return r.text || '(no reply)';
      const parts: Part[] = [];
      for (const fc of fcs) {
        const response = await dispatchLiveTool(cell, fc.name, (fc.args ?? {}) as Record<string, unknown>, 'FLASH');
        parts.push({ functionResponse: { id: fc.id, name: fc.name, response } });
      }
      history.push({ role: 'user', parts });
    }
    return 'I got stuck in a loop of tool calls; please rephrase.';
  };
}
