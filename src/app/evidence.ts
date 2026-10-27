import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TELEMETRY_FILES, type TelemetryFile } from '../intake/contract.ts';
import type { InvestigationResult } from '../investigation/result.ts';
import { checkIdentity } from '../investigation/verify.ts';

/**
 * Re-checking a saved result's citations against the original bundle (E5/E6, ADR 0007). A result
 * quotes records by file, line and identifiers; this reads them again, so an operator can see
 * the cited text and know, without rerunning a model, that each citation still points at the
 * record it quotes. It reads only the three telemetry files the result recorded checksums for,
 * never the answer key. It checks that the cited records exist and match their quoted
 * identifiers and that the file is byte-identical to what the run saw; whether a record
 * *supports* the finding stays "not assessed", as everywhere else.
 */
export type CitationStatus =
  'verified' | 'file_changed' | 'line_missing' | 'identity_mismatch' | 'unreadable';

export interface CitationCheck {
  findingId: string;
  file: string;
  line: number;
  status: CitationStatus;
  /** The cited record's text, only when the file is unchanged; cut at EXCERPT_CHARS. */
  excerpt: string | null;
  truncated: boolean;
  issues: string[];
}

export type EvidenceReport =
  | { status: 'checked'; citations: CitationCheck[] }
  | { status: 'unavailable'; reason: 'not_admitted' | 'no_bundle_recorded' | 'bundle_not_found' };

export const EXCERPT_CHARS = 1_500;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

const isTelemetry = (f: string): f is TelemetryFile =>
  (TELEMETRY_FILES as readonly string[]).includes(f);

interface Loaded {
  sha256: string;
  lines: string[];
}

async function load(bundleDir: string, file: TelemetryFile): Promise<Loaded | null> {
  try {
    const path = join(bundleDir, file);
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    const bytes = await readFile(path);
    return {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      lines: bytes.toString('utf8').split('\n'),
    };
  } catch {
    return null;
  }
}

export async function checkCitations(
  bundleDir: string,
  result: InvestigationResult,
): Promise<EvidenceReport> {
  if (result.bundle === null) return { status: 'unavailable', reason: 'not_admitted' };
  const loaded = new Map<TelemetryFile, Loaded | null>();
  const citations: CitationCheck[] = [];
  for (const finding of result.findings) {
    for (const ref of finding.evidence) {
      const base = { findingId: finding.id, file: ref.file, line: ref.line };
      if (!isTelemetry(ref.file))
        // The schema allows only telemetry files; anything else is never opened.
        throw new Error('a citation names a file that is not telemetry');
      if (!loaded.has(ref.file)) loaded.set(ref.file, await load(bundleDir, ref.file));
      const file = loaded.get(ref.file) ?? null;
      const expected = result.bundle.files[ref.file].sha256;
      if (file === null) {
        citations.push({
          ...base,
          status: 'unreadable',
          excerpt: null,
          truncated: false,
          issues: [`${ref.file} could not be read`],
        });
      } else if (file.sha256 !== expected) {
        citations.push({
          ...base,
          status: 'file_changed',
          excerpt: null,
          truncated: false,
          issues: [`${ref.file} no longer matches the checksum the run recorded`],
        });
      } else {
        const text = file.lines[ref.line - 1] ?? '';
        let record: unknown;
        try {
          record = text.trim() === '' ? undefined : JSON.parse(text);
        } catch {
          record = undefined;
        }
        if (record === undefined) {
          citations.push({
            ...base,
            status: 'line_missing',
            excerpt: null,
            truncated: false,
            issues: [`line ${String(ref.line)} of ${ref.file} holds no record`],
          });
          continue;
        }
        const issues = checkIdentity(ref.file, ref, record, 'citation').map((i) => i.message);
        citations.push({
          ...base,
          status: issues.length === 0 ? 'verified' : 'identity_mismatch',
          excerpt: text.slice(0, EXCERPT_CHARS),
          truncated: text.length > EXCERPT_CHARS,
          issues,
        });
      }
    }
  }
  return { status: 'checked', citations };
}
