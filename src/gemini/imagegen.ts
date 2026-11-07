// Nano Banana (Gemini image model) prints a generated image onto a part's faces.
// Purpose: parts in real cells are identified by printed labels, logos and stripes, not by colour.
// The print lands on the three.js mesh, so the vision planner (Robotics-ER) sees it on the cell camera.
// Only the text prompt leaves the machine here; no frames.

import { Modality } from '@google/genai/web';
import type { GeminiCallEntry } from '../contracts';
import { bus } from '../telemetry/bus';
import { getAI } from './client';

/** Nano Banana 2 Lite: fastest, cheapest image model in AI Studio (Sept 2026). */
export const IMAGE_MODEL = 'gemini-3.1-flash-lite-image';
/** Approximate per-image cost; the ledger shows it with ≈ because image pricing is per image, not per token. */
export const IMAGE_COST_USD = 0.02;

export interface PartImage {
  dataUrl: string;
  latencyMs: number;
}

/** Generate a square, flat print for a part face. Throws if the model returns no image. */
export async function generatePartImage(description: string): Promise<PartImage> {
  const ai = getAI();
  const prompt =
    `A flat, square, top-down print for the face of a small industrial part: ${description}. ` +
    'Bold, high contrast, centred, simple, fills the whole square, no perspective, no shadows, no text unless the description asks for text.';
  const t0 = performance.now();
  let res;
  try {
    res = await ai.models.generateContent({ model: IMAGE_MODEL, contents: prompt, config: { responseModalities: [Modality.IMAGE] } });
  } catch {
    // Some image models insist on TEXT+IMAGE.
    res = await ai.models.generateContent({ model: IMAGE_MODEL, contents: prompt, config: { responseModalities: [Modality.TEXT, Modality.IMAGE] } });
  }
  const latencyMs = Math.round(performance.now() - t0);
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  const img = parts.find((p) => p.inlineData?.data);
  const entry: GeminiCallEntry = {
    t: Date.now(),
    model: IMAGE_MODEL,
    purpose: 'image',
    latencyMs,
    promptTokens: res.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
    thoughtTokens: 0,
    costUsd: IMAGE_COST_USD,
    ok: !!img,
    error: img ? undefined : 'no image part in the response',
  };
  bus.emit({ kind: 'gemini', text: `IMAGE nano-banana-2-lite ${(latencyMs / 1000).toFixed(1)} s ${img ? '✓ print generated' : '✗ no image'} ≈$${IMAGE_COST_USD.toFixed(2)}` }, entry);
  if (!img?.inlineData?.data) throw new Error('the image model returned no image');
  return { dataUrl: `data:${img.inlineData.mimeType ?? 'image/png'};base64,${img.inlineData.data}`, latencyMs };
}
