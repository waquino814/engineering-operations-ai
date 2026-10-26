import type { InvestigationLimits } from '../investigation/config.ts';
import type {
  EvidenceReference,
  FindingVerification,
  InvestigationResult,
} from '../investigation/result.ts';
import type { BundleIssue } from './data/types.ts';

/**
 * What the console derives from a result, kept out of the components so it is tested on its own.
 * Everything here reads the contract (ADR 0004 as amended by ADR 0010); nothing adds a claim the
 * result does not make. Confidence stays qualitative, and semantic support is never shown as
 * verified, because nothing assesses it.
 */
export type OutcomeKey =
  'completed' | 'inconclusive' | 'failed' | 'budget_exceeded' | 'not_admitted';

export interface OutcomeView {
  key: OutcomeKey;
  label: string;
  /** One sentence on what the state means for the operator. */
  meaning: string;
}

export function outcomeView(result: InvestigationResult): OutcomeView {
  switch (result.outcome) {
    case 'completed':
      return {
        key: 'completed',
        label: 'Completed',
        meaning: `The investigation concluded with ${plural(result.findings.length, 'finding')}.`,
      };
    case 'inconclusive':
      return {
        key: 'inconclusive',
        label: 'Inconclusive',
        meaning:
          'The investigation ran correctly and found the evidence insufficient for a conclusion; the limitations say why.',
      };
    case 'budget_exceeded':
      return {
        key: 'budget_exceeded',
        label: 'Budget exceeded',
        meaning: 'A limit stopped the run before it concluded. Nothing was found.',
      };
    case 'failed':
      return result.caseId === null
        ? {
            key: 'not_admitted',
            label: 'Not admitted',
            meaning:
              'The bundle or the configuration was refused before any investigation started.',
          }
        : {
            key: 'failed',
            label: 'Failed',
            meaning: 'The run did not complete. Nothing was found.',
          };
  }
}

export const plural = (n: number, noun: string, nouns = `${noun}s`) =>
  `${String(n)} ${n === 1 ? noun : nouns}`;

/** The first root-cause finding's statement, if the result has one. */
export function rootCauseSummary(result: InvestigationResult): string | null {
  return result.findings.find((f) => f.kind === 'root_cause')?.statement ?? null;
}

export interface ComponentView {
  name: string;
  /** The finding kinds that name it, e.g. root_cause. */
  kinds: string[];
}

/** Every component the findings name, root-cause components first, then by name. */
export function affectedComponents(result: InvestigationResult): ComponentView[] {
  const kinds = new Map<string, Set<string>>();
  for (const f of result.findings)
    for (const c of f.components) kinds.set(c, (kinds.get(c) ?? new Set()).add(f.kind));
  return [...kinds]
    .map(([name, k]) => ({ name, kinds: [...k].sort() }))
    .sort(
      (a, b) =>
        Number(b.kinds.includes('root_cause')) - Number(a.kinds.includes('root_cause')) ||
        a.name.localeCompare(b.name),
    );
}

export const KIND_LABELS: Record<string, string> = {
  root_cause: 'Root cause',
  affected_component: 'Affected component',
  symptom: 'Symptom',
};

/** The identifiers a reference quotes, as label and value pairs. */
export function referenceIdentity(ref: EvidenceReference): [string, string][] {
  const out: [string, string][] = [];
  if (ref.series) {
    const labels = Object.entries(ref.series.labels)
      .map(([k, v]) => `${k}="${v}"`)
      .join(', ');
    out.push(['Series', `${ref.series.name}{${labels}}`]);
  }
  if (ref.samples)
    out.push(['Samples', ref.samples.map(([t, v]) => `${String(t)}: ${v}`).join('; ')]);
  if (ref.time !== undefined) out.push(['Time', ref.time]);
  if (ref.service !== undefined) out.push(['Service', ref.service]);
  if (ref.traceId !== undefined) out.push(['Trace', ref.traceId]);
  if (ref.spanId !== undefined) out.push(['Span', ref.spanId]);
  if (ref.sha256 !== undefined) out.push(['File SHA-256', shortHash(ref.sha256)]);
  return out;
}

export const shortHash = (hash: string) => `${hash.slice(0, 12)}…`;

/** Each verification statement with the console's wording; the order is the contract's. */
export const VERIFICATION_LABELS: Record<
  keyof FindingVerification,
  { label: string; detail: string }
> = {
  referenceExists: {
    label: 'Reference exists',
    detail: 'Each cited file is admitted telemetry and the line holds an admitted record.',
  },
  identityMatches: {
    label: 'Identity matches',
    detail: 'The quoted identifiers are the record’s own.',
  },
  integrity: {
    label: 'Integrity',
    detail: 'The file checksum was recomputed at admission and matches the bundle.',
  },
  includedInRequest: {
    label: 'Included in request',
    detail: 'Every cited record was in the evidence sent to the model.',
  },
  semanticSupport: {
    label: 'Semantic support',
    detail:
      'Whether the records support the statement is not checked. Treat it as the model’s claim.',
  },
};

export const verificationText = (value: string) =>
  value === 'verified' ? 'Verified' : value === 'not_assessed' ? 'Not assessed' : value;

export interface TimelineEntry {
  /** ISO 8601. */
  time: string;
  findingId: string;
  file: string;
  line: number;
  what: string;
}

/**
 * Cited evidence in time order, from the times the references themselves quote: a log record's
 * time and a metric's quoted samples. Traces quote no time in a reference, so they are not here.
 */
export function evidenceTimeline(result: InvestigationResult): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const f of result.findings) {
    for (const ref of f.evidence) {
      if (ref.time !== undefined)
        out.push({
          time: ref.time,
          findingId: f.id,
          file: ref.file,
          line: ref.line,
          what: `log record from ${ref.service ?? 'an unnamed service'}`,
        });
      for (const [t, v] of ref.samples ?? [])
        out.push({
          time: new Date(t * 1000).toISOString(),
          findingId: f.id,
          file: ref.file,
          line: ref.line,
          what: `${ref.series?.name ?? 'metric'} = ${v}`,
        });
    }
  }
  return out.sort((a, b) => a.time.localeCompare(b.time) || a.findingId.localeCompare(b.findingId));
}

export interface TokenView {
  reportedInput: number;
  reportedOutput: number;
  charged: number;
  /** maxTotalTokens, or null when the configuration was invalid and no limits were recorded. */
  budget: number | null;
  /** Charged tokens as a share of the budget, 0 to 1, or null without a budget. */
  share: number | null;
  accounting: 'reported' | 'estimated';
  unreportedCalls: number;
  inconsistentReports: number;
}

export function tokenView(result: InvestigationResult): TokenView {
  const u = result.run.usage;
  const budget = 'maxTotalTokens' in result.run.limits ? result.run.limits.maxTotalTokens : null;
  return {
    reportedInput: u.inputTokens,
    reportedOutput: u.outputTokens,
    charged: u.chargedTokens,
    budget,
    share: budget ? Math.min(1, u.chargedTokens / budget) : null,
    accounting: u.tokenAccounting,
    unreportedCalls: u.unreportedCalls,
    inconsistentReports: u.inconsistentReports,
  };
}

/** The run's limits as rows, or null when the configuration was invalid and none were recorded. */
export function limitRows(result: InvestigationResult): [string, number][] | null {
  const limits = result.run.limits;
  return 'maxModelCalls' in limits ? Object.entries(limits as InvestigationLimits) : null;
}

export const formatNumber = (n: number) => n.toLocaleString('en-US');

/** A UTC timestamp, to the second, independent of the viewer's locale and time zone. */
export const formatTime = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;

/** What an operator can do about each kind of validation issue. */
export const RULE_HINTS: Record<number, string> = {
  1: 'Provide all five bundle files in the directory, readable.',
  2: 'Use a bundle written with a supported contract major version (1.x), or upgrade this project.',
  3: 'Regenerate the bundle: a document does not match its schema.',
  4: 'Regenerate the bundle: a JSON Lines record is malformed or does not match its schema.',
  5: 'Regenerate the bundle: each trace line must hold exactly one trace.',
  6: 'Keep the directory name equal to the manifest’s bundleId; do not rename bundles.',
  7: 'The manifest and ground truth disagree on the scenario; regenerate the bundle.',
  8: 'The capture’s truncation flags are inconsistent; regenerate the bundle.',
  9: 'A file changed after the manifest was written: restore the original files or regenerate the bundle.',
};

/** Where an issue is, as one short string. */
export function issueLocation(issue: BundleIssue): string {
  const parts = [issue.file ?? 'bundle directory'];
  if (issue.line !== undefined) parts.push(`line ${String(issue.line)}`);
  if (issue.field !== undefined && issue.field !== '') parts.push(issue.field);
  return parts.join(' · ');
}
