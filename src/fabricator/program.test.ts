import { describe, expect, it } from 'vitest';
import { PROGRAM_JSON_SCHEMA } from './program';

/**
 * Schema keywords the real API accepted in the designer's responseJsonSchema (HTTP 200 on 2026-11-08,
 * through the key server). It answered HTTP 400 "Request contains an invalid argument" to the same
 * schema with minItems/maxItems in it, so every other keyword stays out until a real call shows it works.
 */
const ACCEPTED_KEYWORDS = new Set(['type', 'description', 'properties', 'items', 'enum', 'required']);

/** Every keyword used anywhere in a schema, with the path where it appears. */
function keywords(node: unknown, path = '$'): { key: string; path: string }[] {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  const out: { key: string; path: string }[] = [];
  for (const [key, value] of Object.entries(node)) {
    out.push({ key, path });
    if (key === 'properties' && value && typeof value === 'object') {
      for (const [name, sub] of Object.entries(value)) out.push(...keywords(sub, `${path}.properties.${name}`));
    } else if (key === 'items') {
      out.push(...keywords(value, `${path}.items`));
    }
  }
  return out;
}

describe('PROGRAM_JSON_SCHEMA (sent to the real API as responseJsonSchema)', () => {
  it('uses only keywords the real API accepted', () => {
    const found = keywords(PROGRAM_JSON_SCHEMA);
    const refused = found.filter((k) => !ACCEPTED_KEYWORDS.has(k.key)).map((k) => `${k.path}: ${k.key}`);
    expect(refused).toEqual([]);
    // the walker reaches the nested arrays (pos_mm, profile_mm points), so it would see a keyword there
    expect(found.some((k) => k.path === '$.properties.parts.items.properties.profile_mm.items' && k.key === 'items')).toBe(true);
    expect(keywords({ type: 'array', minItems: 1, items: { type: 'number', maxItems: 2 } }).map((k) => k.key)).toEqual(['type', 'minItems', 'items', 'type', 'maxItems']);
  });

  it('still tells the model how many numbers each array takes', () => {
    const part = PROGRAM_JSON_SCHEMA.properties.parts.items.properties;
    expect(part.pos_mm.description).toMatch(/three numbers/i);
    expect(part.profile_mm.description).toMatch(/up to 24/);
    expect(PROGRAM_JSON_SCHEMA.properties.parts.description).toMatch(/1 to 12 parts/);
  });
});
