/**
 * JSON Lines as the bundle contract defines them: UTF-8, one record per line, every line ending
 * in `\n` (the last one included), no blank lines; an empty file has zero records.
 */
export type JsonlLine =
  | { line: number; value: unknown }
  | { line: number; error: 'blank line' | 'malformed JSON' | 'missing final newline' };

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Decodes UTF-8 strictly; returns null for invalid bytes instead of substituting characters. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

/** The record count the manifest states for a JSONL file: its number of lines. */
export function recordCount(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let n = 0;
  for (const b of bytes) if (b === 0x0a) n += 1;
  return bytes[bytes.length - 1] === 0x0a ? n : n + 1;
}

/** Splits and parses a JSONL text. Line numbers start at 1. */
export function parseJsonl(text: string): JsonlLine[] {
  if (text === '') return [];
  const parts = text.split('\n');
  const terminated = parts.at(-1) === '';
  if (terminated) parts.pop();
  return parts.map((raw, i): JsonlLine => {
    const line = i + 1;
    if (raw.trim() === '') return { line, error: 'blank line' };
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { line, error: 'malformed JSON' };
    }
    if (!terminated && i === parts.length - 1) return { line, error: 'missing final newline' };
    return { line, value };
  });
}
