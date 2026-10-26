import { BUNDLE_FILES, type BundleFile } from './contract.ts';

/**
 * Validation issues, one per problem, keyed to the nine contract rules in
 * docs/contracts/incident-bundle/README.md, "Validating a bundle".
 */
export const RULES = {
  1: 'files-present',
  2: 'supported-major-version',
  3: 'document-schema',
  4: 'jsonl-records',
  5: 'one-trace-per-line',
  6: 'bundle-id',
  7: 'scenario-agreement',
  8: 'truncation-flag',
  9: 'file-integrity',
} as const;

export type RuleNumber = keyof typeof RULES;
export type RuleId = (typeof RULES)[RuleNumber];

export interface ValidationIssue {
  rule: RuleNumber;
  ruleId: RuleId;
  /** The bundle file, or null when the issue is about the directory itself. */
  file: BundleFile | null;
  /** A dotted path into the document or record, when one applies. */
  field?: string;
  /** The 1-based line of a JSONL file, when one applies. */
  line?: number;
  message: string;
}

/** Line-level issues kept per file and rule before the rest are summarised in one issue. */
export const MAX_LINE_ISSUES = 20;

export function issue(
  rule: RuleNumber,
  file: BundleFile | null,
  message: string,
  at: { field?: string | undefined; line?: number | undefined } = {},
): ValidationIssue {
  return {
    rule,
    ruleId: RULES[rule],
    file,
    ...(at.field === undefined ? {} : { field: at.field }),
    ...(at.line === undefined ? {} : { line: at.line }),
    message,
  };
}

/**
 * Sorts by rule, then file. Within one rule and file, issues keep the order the checks produced
 * them in, which is deterministic (line order, then the schema's error order), so a bundle always
 * gives the same report and a "more issues" summary stays last.
 */
export function sortIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const fileKey = (i: ValidationIssue) => (i.file === null ? -1 : BUNDLE_FILES.indexOf(i.file));
  return [...issues].sort((a, b) => a.rule - b.rule || fileKey(a) - fileKey(b));
}

/** Converts an Ajv instance path (`/capture/traces/0`) to a dotted field (`capture.traces.0`). */
export function fieldOf(instancePath: string, missingProperty?: unknown): string {
  const parts = instancePath
    .split('/')
    .slice(1)
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (typeof missingProperty === 'string') parts.push(missingProperty);
  return parts.join('.');
}

/**
 * A value as it appears in a message: JSON, or "nothing" when it is absent. Values here come from
 * parsed JSON, so `undefined` is the only one JSON.stringify cannot represent.
 */
export function show(value: unknown): string {
  return value === undefined ? 'nothing' : JSON.stringify(value);
}
