/**
 * The schema sent to the provider's structured-output feature is derived from the domain's
 * MODEL_OUTPUT_SCHEMA, never replacing it: the investigator still validates every reply against
 * the full schema (ADR 0007). Anthropic's structured outputs support only a subset of JSON Schema
 * (platform.claude.com/docs/en/build-with-claude/structured-outputs, checked 2026-10-27), and an
 * unsupported keyword is a 400. This removes the keywords outside that subset and reports which.
 */
const ALWAYS_DROPPED = new Set([
  '$schema',
  '$id',
  'title',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'multipleOf',
  'maxItems',
  'prefixItems',
  'uniqueItems',
  'if',
  'then',
  'else',
]);

export interface WireSchema {
  schema: object;
  /** Distinct dropped keywords, sorted, so a change in what the provider cannot enforce shows. */
  dropped: string[];
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function toWireSchema(schema: object): WireSchema {
  const dropped = new Set<string>();
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObject(node)) return node;
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (ALWAYS_DROPPED.has(key)) dropped.add(key);
      else if (key === 'minItems' && value !== 0 && value !== 1) dropped.add(key);
      else if (key === 'additionalProperties' && value !== false) dropped.add(key);
      else if (key === 'properties' && isObject(value)) {
        // Property names are data, not keywords: only their schemas are walked.
        out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
      } else out[key] = walk(value);
    }
    return out;
  };
  return { schema: walk(schema) as object, dropped: [...dropped].sort() };
}
