// Model ids, pricing and demo-mode knobs. Decided by the B0 smoke (PROGRESS.md "Smoke (B0)").
// No window/document access: this file is imported by vitest in node.

export const LIVE_MODEL = 'gemini-3.8-live';
export const FLASH_MODEL = 'gemini-3.8-flash';
/** Eyes + planner. Fallback (never ER-1.6, which is gone/404) is FLASH_MODEL with identical prompts. */
export const ER_MODEL = 'gemini-robotics-er-2-preview';

export type Level = 'LOW' | 'MEDIUM' | 'HIGH';

/** USD per million tokens, through 2026-12-31. Thought tokens are billed as output. */
export const PRICE: Record<string, { input: number; output: number }> = {
  [ER_MODEL]: { input: 1, output: 5 },
  [FLASH_MODEL]: { input: 0.75, output: 3.75 },
  [LIVE_MODEL]: { input: 0.75, output: 4.5 }, // text side only; audio is per minute
};

export function costUsd(model: string, promptTokens: number, outputTokens: number, thoughtTokens: number): number {
  const p = PRICE[model] ?? PRICE[FLASH_MODEL];
  return (promptTokens * p.input + (outputTokens + thoughtTokens) * p.output) / 1e6;
}

/** Timeouts per thinking level (ms), abort via AbortSignal. */
export const TIMEOUT_MS: Record<Level, number> = { LOW: 15_000, MEDIUM: 25_000, HIGH: 45_000 };

/** Demo knobs, toggled from the Coworker pane; values recorded in PROGRESS.md and README. */
export const DEMO = {
  /** pointing consensus samples (median). 1 unless RPM >= 30. */
  consensusN: 1 as 1 | 3,
  /** plan thinking level. B0: HIGH measured 1420 ms (<= 12 s) → HIGH. */
  planLevel: 'HIGH' as Level,
  /** identical (name+args) failing calls before the loop aborts. */
  maxIdenticalFailures: 3,
  /** function-response shape validated by the B0 smoke: A = image inside functionResponse.parts. */
  fcShape: 'A' as 'A' | 'B',
  /** responseJsonSchema on pointing (B0: PASS). false = SCHEMA-OFF fallback (mime type + fence-strip only). */
  pointSchema: true,
  /** G3 fix 2: expose only pick / place_in_tray / place_at / home / done to ER (no raw move_to/open/close). Default true. */
  highLevelOnly: true,
  /** hard caps per task */
  maxIterations: 12,
  maxCalls: 20,
  maxCostUsd: 1,
};
