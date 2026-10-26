import { TELEMETRY_FILES, type TelemetryFile } from '../intake/contract.ts';
import type { EvidenceRecord, EvidenceView } from '../intake/evidence.ts';

/**
 * Deterministic telemetry selection (ADR 0006). It chooses which admitted records go into the
 * model's context using generic operational signals only: log severity, metric series that
 * change or carry error-like label values, and traces with error status, error-like attributes
 * or long durations. It knows nothing of particular scenarios, their names or their timing, and
 * uses no time window. Records are never altered: a record too large for the budget is omitted,
 * not cut, and every omission is counted with its reason.
 */
export interface SelectedRecord {
  file: TelemetryFile;
  /** The record's original 1-based line number. */
  line: number;
  value: unknown;
  /** UTF-8 bytes of the record's JSON. */
  bytes: number;
  score: number;
  reasons: string[];
}

export type OmissionReason = 'record_limit' | 'context_limit' | 'record_too_large' | 'repeated';

export interface FileSelection {
  records: number;
  selected: number;
  omitted: Record<OmissionReason, number>;
}

export interface SelectionSummary {
  limits: { maxRecords: number; maxBytes: number; maxRecordBytes: number };
  files: Record<TelemetryFile, FileSelection>;
  selectedBytes: number;
  emptyFiles: TelemetryFile[];
  truncatedTraceServices: string[];
  notes: string[];
}

export interface Selection {
  records: SelectedRecord[];
  summary: SelectionSummary;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Generic error vocabulary for label and attribute values. Not tied to any scenario. */
const ERRORISH =
  /^(error|errors|failed|failure|fail|timeout|timed_out|unavailable|refused|rejected|denied|exception|5\d\d)$/i;
const SEVERITY: Record<string, number> = { fatal: 5, critical: 5, error: 4, warn: 3, warning: 3 };

interface Candidate {
  file: TelemetryFile;
  line: number;
  value: unknown;
  json: string;
  bytes: number;
  score: number;
  reasons: string[];
  /** Records sharing a group are collapsed to their first and last occurrence. */
  group: string;
}

const json = (v: unknown) => JSON.stringify(v);

function logCandidate(e: EvidenceRecord): Omit<Candidate, 'file' | 'json' | 'bytes'> {
  const r = isObject(e.value) ? e.value : {};
  const level = typeof r.level === 'string' ? r.level.toLowerCase() : '';
  const severity = SEVERITY[level] ?? 0;
  const service = typeof r.service === 'string' ? r.service : '';
  const message = typeof r.message === 'string' ? r.message : '';
  return {
    line: e.line,
    value: e.value,
    score: severity > 0 ? severity : 1,
    reasons: severity > 0 ? [`log level ${level}`] : ['log message'],
    group: `log|${service}|${level}|${message}`,
  };
}

function numbers(samples: unknown): number[] {
  if (!Array.isArray(samples)) return [];
  return samples
    .map((s) => (Array.isArray(s) && typeof s[1] === 'string' ? Number(s[1]) : NaN))
    .filter((n) => Number.isFinite(n));
}

function metricCandidate(e: EvidenceRecord): Omit<Candidate, 'file' | 'json' | 'bytes'> {
  const r = isObject(e.value) ? e.value : {};
  const name = typeof r.name === 'string' ? r.name : '';
  const labels = isObject(r.labels) ? Object.values(r.labels) : [];
  const values = numbers(r.samples);
  const changed = values.length > 1 && Math.max(...values) !== Math.min(...values);
  const errorish = labels.some((v) => typeof v === 'string' && ERRORISH.test(v));
  const bucket = name.endsWith('_bucket');
  const reasons: string[] = [];
  let score = 0;
  if (errorish) {
    score += 2;
    reasons.push('error-like label value');
  }
  if (changed) {
    score += bucket ? 1 : 2;
    reasons.push('series changes');
  }
  if (reasons.length === 0)
    reasons.push(values.length === 0 ? 'no numeric samples' : 'constant series');
  return { line: e.line, value: e.value, score, reasons, group: `metric|${String(e.line)}` };
}

function traceFacts(value: unknown): { error: boolean; root: string; durationNs: bigint } {
  let error = false;
  let root = '';
  let start: bigint | null = null;
  let end: bigint | null = null;
  const rs = isObject(value) && Array.isArray(value.resourceSpans) ? value.resourceSpans : [];
  for (const r of rs) {
    const scopes = isObject(r) && Array.isArray(r.scopeSpans) ? r.scopeSpans : [];
    for (const sc of scopes) {
      const spans = isObject(sc) && Array.isArray(sc.spans) ? sc.spans : [];
      for (const s of spans) {
        if (!isObject(s)) continue;
        if (isObject(s.status) && (s.status.code === 2 || s.status.code === 'STATUS_CODE_ERROR'))
          error = true;
        for (const a of Array.isArray(s.attributes) ? s.attributes : []) {
          const v = isObject(a) && isObject(a.value) ? a.value : {};
          if (typeof v.stringValue === 'string' && ERRORISH.test(v.stringValue)) error = true;
          if (typeof v.intValue === 'string' && /^5\d\d$/.test(v.intValue)) error = true;
        }
        if ((s.parentSpanId === undefined || s.parentSpanId === '') && typeof s.name === 'string')
          root = s.name;
        const st =
          typeof s.startTimeUnixNano === 'string' && /^\d+$/.test(s.startTimeUnixNano)
            ? BigInt(s.startTimeUnixNano)
            : null;
        const en =
          typeof s.endTimeUnixNano === 'string' && /^\d+$/.test(s.endTimeUnixNano)
            ? BigInt(s.endTimeUnixNano)
            : null;
        if (st !== null && (start === null || st < start)) start = st;
        if (en !== null && (end === null || en > end)) end = en;
      }
    }
  }
  return {
    error,
    root,
    durationNs: start !== null && end !== null && end > start ? end - start : 0n,
  };
}

function traceCandidates(entries: EvidenceRecord[]): Omit<Candidate, 'file' | 'json' | 'bytes'>[] {
  const facts = entries.map((e) => ({ e, ...traceFacts(e.value) }));
  // The slowest tenth of traces (at least one) count as slow; a relative, not absolute, threshold.
  const durations = facts.map((f) => f.durationNs).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const cut = durations[Math.max(0, Math.ceil(durations.length / 10) - 1)] ?? 0n;
  return facts.map(({ e, error, root, durationNs }) => {
    const slow = durationNs > 0n && durationNs >= cut;
    const reasons = [
      ...(error ? ['error status or error-like attribute'] : []),
      ...(slow ? ['among the slowest traces'] : []),
    ];
    return {
      line: e.line,
      value: e.value,
      score: (error ? 4 : 0) + (slow ? 1 : 0),
      reasons: reasons.length ? reasons : ['trace'],
      group: `trace|${root}|${String(error)}|${String(slow)}`,
    };
  });
}

/**
 * Selects records within the limits. Ranking: score (descending), then file order (logs,
 * metrics, traces), then line. The chosen records are returned in file order, then line order.
 */
export function selectEvidence(
  view: EvidenceView,
  limits: { maxRecords: number; maxBytes: number; maxRecordBytes: number },
): Selection {
  const order: TelemetryFile[] = ['logs.jsonl', 'metrics.jsonl', 'traces.jsonl'];
  const files = Object.fromEntries(
    TELEMETRY_FILES.map((f) => [
      f,
      {
        records: view.files[f].entries.length,
        selected: 0,
        omitted: { record_limit: 0, context_limit: 0, record_too_large: 0, repeated: 0 },
      },
    ]),
  ) as Record<TelemetryFile, FileSelection>;

  const candidates: Candidate[] = [];
  for (const file of order) {
    const entries = view.files[file].entries;
    const raw =
      file === 'logs.jsonl'
        ? entries.map(logCandidate)
        : file === 'metrics.jsonl'
          ? entries.map(metricCandidate)
          : traceCandidates(entries);
    // Collapse repeated groups to their first and last occurrence.
    const byGroup = new Map<string, number[]>();
    raw.forEach((c, i) => byGroup.set(c.group, [...(byGroup.get(c.group) ?? []), i]));
    raw.forEach((c, i) => {
      const members = byGroup.get(c.group) ?? [i];
      if (members.length > 2 && i !== members[0] && i !== members.at(-1)) {
        files[file].omitted.repeated += 1;
        return;
      }
      const text = json(c.value);
      const reasons =
        members.length > 2
          ? [...c.reasons, `${String(members.length)} similar records`]
          : c.reasons;
      candidates.push({ ...c, file, json: text, bytes: Buffer.byteLength(text, 'utf8'), reasons });
    });
  }

  const rank = (c: Candidate) => order.indexOf(c.file);
  candidates.sort((a, b) => b.score - a.score || rank(a) - rank(b) || a.line - b.line);

  const chosen: Candidate[] = [];
  let used = 0;
  for (const c of candidates) {
    if (c.bytes > limits.maxRecordBytes) files[c.file].omitted.record_too_large += 1;
    else if (chosen.length >= limits.maxRecords) files[c.file].omitted.record_limit += 1;
    else if (used + c.bytes > limits.maxBytes) files[c.file].omitted.context_limit += 1;
    else {
      chosen.push(c);
      used += c.bytes;
      files[c.file].selected += 1;
    }
  }
  chosen.sort((a, b) => rank(a) - rank(b) || a.line - b.line);

  const truncated = view.manifest.capture.traces.services
    .filter((s) => s.truncated)
    .map((s) => s.name);
  const emptyFiles = TELEMETRY_FILES.filter((f) => view.files[f].entries.length === 0);
  const notes = [
    ...emptyFiles.map((f) => `${f} has no records.`),
    ...truncated.map(
      (s) =>
        `Trace capture for ${s} was truncated (${view.manifest.capture.traces.services.find((x) => x.name === s)?.truncationReasons.join(', ') ?? ''}).`,
    ),
  ];
  return {
    records: chosen.map(({ file, line, value, bytes, score, reasons }) => ({
      file,
      line,
      value,
      bytes,
      score,
      reasons,
    })),
    summary: {
      limits,
      files,
      selectedBytes: used,
      emptyFiles,
      truncatedTraceServices: truncated,
      notes,
    },
  };
}
