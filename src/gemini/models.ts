// Gemini model ids, prices and timeouts. Pure data: safe to import anywhere (no DOM, no SDK).
import type { GeminiCallEntry } from '../contracts';

/** Fast reasoning and function calling: the coworker and the sample designer. */
export const FLASH = 'gemini-3.8-flash';
/** Embodied reasoning on the bay camera: pointing, verification, grasp checks. */
export const ROBOTICS_ER = 'gemini-robotics-er-2-preview';
/** Real-time voice. Audio output only. */
export const LIVE = 'gemini-3.8-live';
/** Image generation (sample thumbnails, mission patches). */
export const IMAGE = 'gemini-3.1-flash-lite-image';

export type ThinkingLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type Purpose = GeminiCallEntry['purpose'];

export interface ModelInfo {
  id: string;
  /** short label for the on-screen ledger */
  label: string;
  /** USD per 1M input tokens (null = not priced here) */
  inPerM: number | null;
  /** USD per 1M output tokens, thinking included (null = not priced here) */
  outPerM: number | null;
  /** USD per generated image */
  perImage?: number;
  /** accepts config.thinkingConfig.thinkingLevel */
  thinkingLevels: boolean;
}

export const MODEL_INFO: Record<string, ModelInfo> = {
  [FLASH]: { id: FLASH, label: 'Flash', inPerM: 0.75, outPerM: 3.75, thinkingLevels: true },
  [ROBOTICS_ER]: { id: ROBOTICS_ER, label: 'Robotics-ER', inPerM: 1, outPerM: 5, thinkingLevels: false },
  [LIVE]: { id: LIVE, label: 'Live', inPerM: null, outPerM: null, thinkingLevels: false },
  [IMAGE]: { id: IMAGE, label: 'Image', inPerM: null, outPerM: null, perImage: 0.0336, thinkingLevels: false },
};

/** Models the server proxy forwards over HTTP (Live uses a WebSocket with an ephemeral token). */
export const PROXY_MODELS: readonly string[] = [FLASH, ROBOTICS_ER, IMAGE];

/** Per-attempt timeout for each kind of call, in ms. */
export const TIMEOUT_MS: Record<Purpose, number> = {
  design: 45_000,
  coworker: 30_000,
  point: 25_000,
  verify: 25_000,
  grasp_check: 25_000,
  live: 30_000,
  image: 60_000,
};

/** Default thinking level per purpose (only applied to models that take one). */
export const DEFAULT_LEVEL: Partial<Record<Purpose, ThinkingLevel>> = {
  coworker: 'LOW',
  design: 'LOW',
};

/** The longest 429 Retry-After we are willing to wait inside one call. */
export const MAX_RETRY_AFTER_MS = 20_000;

export interface Usage {
  promptTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  images?: number;
}

/** Cost of one call in USD. Thinking tokens are billed as output. Unpriced models cost 0. */
export function costUsd(model: string, u: Usage): number {
  const info = MODEL_INFO[model];
  if (!info) return 0;
  let usd = 0;
  if (info.inPerM !== null) usd += (u.promptTokens * info.inPerM) / 1e6;
  if (info.outPerM !== null) usd += ((u.outputTokens + u.thoughtTokens) * info.outPerM) / 1e6;
  if (info.perImage !== undefined) usd += (u.images ?? 0) * info.perImage;
  return usd;
}

export function isPriced(model: string): boolean {
  const info = MODEL_INFO[model];
  return !!info && (info.inPerM !== null || info.perImage !== undefined);
}

export function modelLabel(model: string): string {
  return MODEL_INFO[model]?.label ?? model;
}
