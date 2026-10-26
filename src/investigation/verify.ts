import { TELEMETRY_FILES, type TelemetryFile } from '../intake/contract.ts';
import type { EvidenceView } from '../intake/evidence.ts';
import type { EvidenceReference, ModelOutput } from './result.ts';

/**
 * Evidence verification (ADR 0007). Every reference a model returns is resolved against the
 * admitted evidence: the file must be one of the admitted telemetry files, the line must hold an
 * admitted record that was in the evidence sent to the model, an optional checksum must match,
 * and the identifiers quoted must match that record. This proves the cited records exist, were
 * shown, and are quoted correctly. It does not prove that they support the finding; results say
 * so explicitly (`semanticSupport: "not_assessed"`).
 */
export type VerificationCode =
  | 'path_outside_bundle'
  | 'unknown_file'
  | 'line_out_of_range'
  | 'record_not_admitted'
  | 'record_not_shown'
  | 'checksum_mismatch'
  | 'missing_identity'
  | 'inapplicable_field'
  | 'identity_mismatch'
  | 'sample_not_found'
  | 'span_not_found'
  | 'duplicate_reference'
  | 'duplicate_finding_id'
  | 'unknown_finding_reference'
  | 'completed_without_findings'
  | 'inconclusive_without_limitations';

export interface VerificationIssue {
  code: VerificationCode;
  /** Where in the model output, e.g. `findings.0.evidence.1.line`. */
  field: string;
  message: string;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Identifier fields a reference may carry for each file. */
const IDENTITY_FIELDS: Record<TelemetryFile, readonly (keyof EvidenceReference)[]> = {
  'metrics.jsonl': ['series', 'samples'],
  'logs.jsonl': ['time', 'service'],
  'traces.jsonl': ['traceId', 'spanId'],
};
const ALL_IDENTITY_FIELDS = new Set(Object.values(IDENTITY_FIELDS).flat());

const sameLabels = (a: Record<string, string>, b: unknown) =>
  isObject(b) &&
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([k, v]) => b[k] === v);

function spans(record: unknown): Json[] {
  const out: Json[] = [];
  if (!isObject(record) || !Array.isArray(record.resourceSpans)) return out;
  for (const rs of record.resourceSpans) {
    if (!isObject(rs) || !Array.isArray(rs.scopeSpans)) continue;
    for (const ss of rs.scopeSpans) {
      if (!isObject(ss) || !Array.isArray(ss.spans)) continue;
      for (const s of ss.spans) if (isObject(s)) out.push(s);
    }
  }
  return out;
}

/** The service names of a trace record's resources. */
export function traceServices(record: unknown): string[] {
  const names = new Set<string>();
  if (!isObject(record) || !Array.isArray(record.resourceSpans)) return [];
  for (const rs of record.resourceSpans) {
    const attrs = isObject(rs) && isObject(rs.resource) ? rs.resource.attributes : undefined;
    if (!Array.isArray(attrs)) continue;
    for (const a of attrs) {
      if (
        isObject(a) &&
        a.key === 'service.name' &&
        isObject(a.value) &&
        typeof a.value.stringValue === 'string'
      )
        names.add(a.value.stringValue);
    }
  }
  return [...names].sort();
}

function checkIdentity(
  file: TelemetryFile,
  ref: EvidenceReference,
  record: unknown,
  at: string,
): VerificationIssue[] {
  const issues: VerificationIssue[] = [];
  const add = (code: VerificationCode, field: string, message: string) =>
    issues.push({ code, field: `${at}.${field}`, message });
  for (const f of ALL_IDENTITY_FIELDS) {
    if (ref[f] !== undefined && !IDENTITY_FIELDS[file].includes(f))
      add('inapplicable_field', f, `${f} does not apply to ${file}`);
  }
  const r = isObject(record) ? record : {};
  if (file === 'metrics.jsonl') {
    if (!ref.series)
      return [
        ...issues,
        {
          code: 'missing_identity',
          field: `${at}.series`,
          message: 'a metrics reference must quote the series name and labels',
        },
      ];
    if (ref.series.name !== r.name)
      add(
        'identity_mismatch',
        'series.name',
        `line ${String(ref.line)} is series ${JSON.stringify(r.name)}, not ${JSON.stringify(ref.series.name)}`,
      );
    else if (!sameLabels(ref.series.labels, r.labels))
      add('identity_mismatch', 'series.labels', `line ${String(ref.line)} has different labels`);
    const samples = Array.isArray(r.samples) ? r.samples : [];
    (ref.samples ?? []).forEach(([t, v], i) => {
      if (!samples.some((s) => Array.isArray(s) && s[0] === t && s[1] === v))
        add(
          'sample_not_found',
          `samples.${String(i)}`,
          `sample [${String(t)}, ${JSON.stringify(v)}] is not in the series at line ${String(ref.line)}`,
        );
    });
  } else if (file === 'logs.jsonl') {
    if (ref.time === undefined || ref.service === undefined)
      return [
        ...issues,
        {
          code: 'missing_identity',
          field: at,
          message: 'a logs reference must quote the record time and service',
        },
      ];
    if (ref.time !== r.time)
      add(
        'identity_mismatch',
        'time',
        `line ${String(ref.line)} has time ${JSON.stringify(r.time)}`,
      );
    if (ref.service !== r.service)
      add(
        'identity_mismatch',
        'service',
        `line ${String(ref.line)} has service ${JSON.stringify(r.service)}`,
      );
  } else {
    if (ref.traceId === undefined)
      return [
        ...issues,
        {
          code: 'missing_identity',
          field: `${at}.traceId`,
          message: 'a traces reference must quote the trace ID',
        },
      ];
    const all = spans(record);
    if (all[0]?.traceId !== ref.traceId)
      add('identity_mismatch', 'traceId', `line ${String(ref.line)} is a different trace`);
    else if (ref.spanId !== undefined && !all.some((s) => s.spanId === ref.spanId))
      add(
        'span_not_found',
        'spanId',
        `span ${ref.spanId} is not in the trace at line ${String(ref.line)}`,
      );
  }
  return issues;
}

export interface Verification {
  issues: VerificationIssue[];
  /** Limitations implied by the cited evidence, such as truncated trace capture. */
  limitations: string[];
}

/** The records sent to the model, as `file:line` keys (see `shownKey`). */
export type ShownRecords = ReadonlySet<string>;
export const shownKey = (file: TelemetryFile, line: number) => `${file}:${String(line)}`;

/**
 * Verifies every reference and the output's internal consistency against the admitted evidence.
 * `shown` is the exact set of records the model was given; a reference to any other record fails,
 * even if the record exists.
 */
export function verifyEvidence(
  output: ModelOutput,
  view: EvidenceView,
  shown: ShownRecords,
): Verification {
  const issues: VerificationIssue[] = [];
  const limitations = new Set<string>();
  const truncated = new Set(
    view.manifest.capture.traces.services.filter((s) => s.truncated).map((s) => s.name),
  );
  const index = new Map<string, Map<number, unknown>>(
    TELEMETRY_FILES.map((f) => [f, new Map(view.files[f].entries.map((e) => [e.line, e.value]))]),
  );

  const ids = new Set<string>();
  output.findings.forEach((finding, fi) => {
    const at = `findings.${String(fi)}`;
    if (ids.has(finding.id))
      issues.push({
        code: 'duplicate_finding_id',
        field: `${at}.id`,
        message: `finding id ${finding.id} is used twice`,
      });
    ids.add(finding.id);
    const seen = new Set<string>();
    finding.evidence.forEach((ref, ri) => {
      const rat = `${at}.evidence.${String(ri)}`;
      if (/[/\\]|\.\./.test(ref.file)) {
        issues.push({
          code: 'path_outside_bundle',
          field: `${rat}.file`,
          message: `${JSON.stringify(ref.file)} is a path, not an admitted telemetry file`,
        });
        return;
      }
      if (!(TELEMETRY_FILES as readonly string[]).includes(ref.file)) {
        issues.push({
          code: 'unknown_file',
          field: `${rat}.file`,
          message: `${JSON.stringify(ref.file)} is not an admitted telemetry file; allowed: ${TELEMETRY_FILES.join(', ')}`,
        });
        return;
      }
      const file = ref.file as TelemetryFile;
      const key = shownKey(file, ref.line);
      if (seen.has(key)) {
        issues.push({
          code: 'duplicate_reference',
          field: rat,
          message: `${file} line ${String(ref.line)} is cited twice in finding ${finding.id}`,
        });
        return;
      }
      seen.add(key);
      const stat = view.files[file];
      if (ref.sha256 !== undefined && ref.sha256 !== stat.sha256) {
        issues.push({
          code: 'checksum_mismatch',
          field: `${rat}.sha256`,
          message: `${file} has SHA-256 ${stat.sha256}`,
        });
      }
      if (ref.line > stat.records) {
        issues.push({
          code: 'line_out_of_range',
          field: `${rat}.line`,
          message: `${file} has ${String(stat.records)} records; line ${String(ref.line)} does not exist`,
        });
        return;
      }
      const record = index.get(file)?.get(ref.line);
      if (record === undefined) {
        issues.push({
          code: 'record_not_admitted',
          field: `${rat}.line`,
          message: `${file} line ${String(ref.line)} is not an admitted record`,
        });
        return;
      }
      if (!shown.has(shownKey(file, ref.line))) {
        issues.push({
          code: 'record_not_shown',
          field: `${rat}.line`,
          message: `${file} line ${String(ref.line)} was not in the evidence given; cite only records from the input`,
        });
        return;
      }
      issues.push(...checkIdentity(file, ref, record, rat));
      if (file === 'traces.jsonl') {
        for (const s of traceServices(record)) {
          if (truncated.has(s))
            limitations.add(
              `Trace capture for ${s} was truncated; other relevant traces may be missing.`,
            );
        }
      }
    });
  });

  output.remediation.forEach((r, i) => {
    r.addresses.forEach((id, j) => {
      if (!ids.has(id))
        issues.push({
          code: 'unknown_finding_reference',
          field: `remediation.${String(i)}.addresses.${String(j)}`,
          message: `no finding has id ${id}`,
        });
    });
  });
  if (output.outcome === 'completed' && output.findings.length === 0) {
    issues.push({
      code: 'completed_without_findings',
      field: 'findings',
      message: 'a completed investigation must report at least one finding',
    });
  }
  if (output.outcome === 'inconclusive' && output.limitations.length === 0) {
    issues.push({
      code: 'inconclusive_without_limitations',
      field: 'limitations',
      message: 'an inconclusive investigation must state why',
    });
  }
  return { issues, limitations: [...limitations].sort() };
}
