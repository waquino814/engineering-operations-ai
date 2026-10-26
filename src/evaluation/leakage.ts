import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { GROUND_TRUTH_FILE, MANIFEST_FILE } from '../intake/contract.ts';
import type { EvidenceView } from '../intake/evidence.ts';

/**
 * Deterministic answer-leak detection (ADR 0009). It lists the values an investigator must never
 * receive, then looks for them in what the investigator sent and produced. It detects a value
 * that appears verbatim, with its case, separators or word boundaries changed, or in base64,
 * percent or hex encoding. It cannot detect a paraphrase, a translation, a value split across
 * fields, or an answer inferred from the evidence; those stay outside its guarantees.
 */
type Json = Record<string, unknown>;

/**
 * "always": answer text that must never appear anywhere the investigator touches, even in the
 * telemetry or the fixed instructions. "unless_in_evidence": metadata the view excludes, which may
 * legitimately also occur in the telemetry (a metric name, a component) or in the fixed request
 * text (a common word); it is checked only when that legitimate text does not contain it.
 */
export type LeakPolicy = 'always' | 'unless_in_evidence';

export interface ProtectedValue {
  /** Where the value comes from, e.g. `ground_truth.rootCause.summary`; never the value itself. */
  source: string;
  value: string;
  policy: LeakPolicy;
}

export type LeakMatch = 'exact' | 'normalized' | 'encoded';

export interface LeakFinding {
  channel: string;
  source: string;
  match: LeakMatch;
}

export interface LeakCheck {
  /** Values looked for. */
  checkedValues: number;
  /**
   * Excluded metadata not looked for, because the investigator may legitimately send it: the
   * admitted evidence or the fixed request text contains it.
   */
  legitimatelyPresent: number;
  findings: LeakFinding[];
}

/** Values shorter than this, once normalized, are too common to check without false alarms. */
export const MIN_NORMALIZED_LENGTH = 8;

/** Ground-truth fields that are answer text: they must never reach the investigator at all. */
const ANSWER_TEXT =
  /^(scenario\.name|rootCause\.summary|description|primarySymptom\.description|secondarySymptoms\.\d+\.description|expectedRemediation\.\d+|dataEffects\.\d+)$/;

/** Manifest string fields the evidence view keeps (ADR 0003); every other string is protected. */
const VIEW_FIELDS =
  /^(schemaVersion|services\.\d+\.(name|version|instanceId)|capture\.traces\.services\.\d+\.(name|truncationReasons\.\d+)|capture\.logs\.services\.\d+\.name|files\.(traces|metrics|logs)\.jsonl\.sha256)$/;

function strings(value: unknown, path = ''): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, dotted(path, String(i))));
  if (typeof value === 'object' && value !== null)
    return Object.entries(value as Json).flatMap(([k, v]) => strings(v, dotted(path, k)));
  return [];
}
const dotted = (a: string, b: string) => (a ? `${a}.${b}` : b);

/**
 * Lower-case word tokens, split at non-alphanumerics, camelCase and letter-digit boundaries.
 * Single letters are dropped, so `2026-10-26T12:23:00.324Z` and `2026-10-26 12:23:00.324`
 * normalize alike.
 */
export function tokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/(?<=[a-z])(?=[0-9])|(?<=[0-9])(?=[a-z])/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !/^[a-z]$/.test(t));
}
const normalized = (text: string) => ` ${tokens(text).join(' ')} `;

/** The protected values of a bundle: answer text, excluded manifest metadata, its location. */
export async function protectedValues(bundleDir: string): Promise<ProtectedValue[]> {
  const read = async (f: string) =>
    JSON.parse(await readFile(join(bundleDir, f), 'utf8')) as unknown;
  const out: ProtectedValue[] = [];
  for (const [path, value] of strings(await read(GROUND_TRUTH_FILE)))
    out.push({
      source: `ground_truth.${path}`,
      value,
      policy: ANSWER_TEXT.test(path) ? 'always' : 'unless_in_evidence',
    });
  for (const [path, value] of strings(await read(MANIFEST_FILE)))
    if (!VIEW_FIELDS.test(path))
      out.push({ source: `manifest.${path}`, value, policy: 'unless_in_evidence' });
  const dir = resolve(bundleDir);
  out.push({ source: 'bundle.path', value: dir, policy: 'always' });
  out.push({ source: 'bundle.directoryName', value: basename(dir), policy: 'always' });
  return out.filter((v) => tokens(v.value).join('').length >= MIN_NORMALIZED_LENGTH);
}

/**
 * What an investigator may legitimately send: the admitted evidence, and the fixed request text
 * (instructions and output schema), which is the same for every bundle.
 */
export function legitimateText(view: EvidenceView | null, fixed: string[]): string {
  return [view ? JSON.stringify(view) : '', ...fixed].join('\n');
}

function encodings(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  const base64 = bytes.toString('base64');
  const out = [
    base64,
    base64.replace(/=+$/, ''),
    bytes.toString('base64url'),
    encodeURIComponent(value),
    bytes.toString('hex'),
  ];
  return [...new Set(out)].filter((e) => e !== value && e.length >= 12);
}

/**
 * Looks for every protected value in every channel. A value with the "unless_in_evidence" policy
 * is skipped when the legitimate text contains it (see `legitimateText`). Findings name the
 * channel, the value's source and how it matched, never the value.
 */
export function findLeaks(
  channels: { channel: string; text: string }[],
  values: ProtectedValue[],
  legitimate: string,
): LeakCheck {
  const legitimateNorm = normalized(legitimate);
  const checked = values.filter(
    (v) => v.policy === 'always' || !legitimateNorm.includes(normalized(v.value)),
  );
  const findings: LeakFinding[] = [];
  for (const { channel, text } of channels) {
    const norm = normalized(text);
    const lower = text.toLowerCase();
    for (const v of checked) {
      let match: LeakMatch | null = null;
      if (text.includes(v.value)) match = 'exact';
      else if (norm.includes(normalized(v.value))) match = 'normalized';
      else if (encodings(v.value).some((e) => text.includes(e) || lower.includes(e.toLowerCase())))
        match = 'encoded';
      if (match) findings.push({ channel, source: v.source, match });
    }
  }
  return {
    checkedValues: checked.length,
    legitimatelyPresent: values.length - checked.length,
    findings,
  };
}
