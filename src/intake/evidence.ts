import { MANIFEST_FILE, TELEMETRY_FILES, type TelemetryFile } from './contract.ts';
import {
  checkManifest,
  checkTelemetry,
  nodeReadFile,
  readBundleFile,
  sha256,
  type FileStat,
  type JsonObject,
  type ReadFile,
} from './checks.ts';
import { sortIssues, type ValidationIssue } from './issues.ts';

/**
 * The investigator-facing view of a bundle (ADR 0003). It reads manifest.json and the three
 * telemetry files only, and never opens the answer file, so it works whether that file exists or
 * not. It re-checks what it reads (rules 2 to 5, and 9 for the telemetry files) rather than trust
 * an earlier validation. The manifest it exposes is built from an allowlist: every field not named
 * below is left out, including fields a later 1.x producer adds, because a field's safety has to
 * be established from its meaning, not assumed from its name.
 */
export interface EvidenceRecord {
  /** 1-based line number in the source file, for evidence references (ADR 0004). */
  line: number;
  value: unknown;
}

export interface EvidenceFile extends FileStat {
  entries: EvidenceRecord[];
}

/** The only manifest content an investigator sees. ADR 0003 gives the reason for each field. */
export interface InvestigatorManifest {
  schemaVersion: string;
  /** The services that produced the telemetry, to interpret it. */
  services: { name: string; version: string; instanceId: string }[];
  /** How complete the evidence is. Counts that summarise the evidence itself are left out. */
  capture: {
    traces: {
      services: {
        name: string;
        truncated: boolean;
        truncationReasons: string[];
        saturatedSlices: number;
      }[];
    };
    metrics: { stepSeconds: number };
    logs: { services: { name: string; nonJsonLines: number }[] };
  };
  /** Checksums of the telemetry files, for evidence references. */
  files: Record<TelemetryFile, FileStat>;
}

export interface EvidenceView {
  /** Opaque: the first 16 hex characters of manifest.json's SHA-256, unique per run. */
  caseId: string;
  manifest: InvestigatorManifest;
  files: Record<TelemetryFile, EvidenceFile>;
}

export class EvidenceError extends Error {
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(`the bundle's evidence is not usable: ${String(issues.length)} issue(s)`);
    this.name = 'EvidenceError';
    this.issues = issues;
  }
}

/**
 * Manifest fields left out of the investigator's view, with the reason (ADR 0003). The view is
 * built from an allowlist, so this list documents the audit; it is not what enforces it.
 */
export const EXCLUDED_MANIFEST_FIELDS = {
  bundleId: 'names the scenario',
  scenario: 'the scenario name, version and seed: the answer key identity',
  createdAt: 'run bookkeeping, not evidence',
  window: 'captureFrom equals loadStartedAt, and the fault starts 30 s after it in every run',
  trigger: 'the actual fault window, and its requested duration from the ground-truth timeline',
  detection: "when the ground truth's own primary-symptom condition became true, and its deadline",
  producer: 'run provenance (commit, dirty), not evidence',
  infrastructure: 'image references track the run history, not the evidence',
  load: 'the seed is the scenario seed, the plan hash fingerprints it, the run prefix is bookkeeping',
  'capture.traces (except per-service completeness)':
    'slice settings and dropped admin spans: the fault-control channel; trace counts summarise the evidence',
  'capture.metrics (except stepSeconds)':
    'series counts summarise the evidence and vary by scenario',
  'capture.logs (except per-service nonJsonLines)':
    'record counts summarise the evidence; dropped admin lines: the fault-control channel',
  'files (the answer-file entry)': 'its checksum fingerprints the scenario and seed',
} as const;

const objects = (v: unknown) => v as JsonObject[];
const object = (v: unknown) => v as JsonObject;

/** Builds the investigator's manifest by picking allowlisted fields from a schema-valid manifest. */
export function investigatorManifest(manifest: JsonObject): InvestigatorManifest {
  const capture = object(manifest.capture);
  const traces = object(capture.traces);
  const logs = object(capture.logs);
  const files = object(manifest.files);
  return {
    schemaVersion: manifest.schemaVersion as string,
    services: objects(manifest.services).map((s) => ({
      name: s.name as string,
      version: s.version as string,
      instanceId: s.instanceId as string,
    })),
    capture: {
      traces: {
        services: objects(traces.services).map((s) => ({
          name: s.name as string,
          truncated: s.truncated as boolean,
          truncationReasons: [...(s.truncationReasons as string[])],
          saturatedSlices: s.saturatedSlices as number,
        })),
      },
      metrics: { stepSeconds: object(capture.metrics).stepSeconds as number },
      logs: {
        services: objects(logs.services).map((s) => ({
          name: s.name as string,
          nonJsonLines: s.nonJsonLines as number,
        })),
      },
    },
    files: Object.fromEntries(
      TELEMETRY_FILES.map((f) => {
        const e = object(files[f]);
        return [
          f,
          { sha256: e.sha256 as string, bytes: e.bytes as number, records: e.records as number },
        ];
      }),
    ) as Record<TelemetryFile, FileStat>,
  };
}

/**
 * Opens the evidence for an investigation. The caller (intake, not the investigator) passes the
 * directory and hands the investigator only the returned view: the path names the scenario.
 */
export async function openEvidence(
  bundleDir: string,
  options: { readFile?: ReadFile } = {},
): Promise<EvidenceView> {
  const read = options.readFile ?? nodeReadFile;
  const issues: ValidationIssue[] = [];
  const manifestBytes = await readBundleFile(read, bundleDir, MANIFEST_FILE, issues);
  const { manifest, validators } = manifestBytes
    ? await checkManifest(manifestBytes, issues)
    : { manifest: null, validators: null };

  const files: Partial<Record<TelemetryFile, EvidenceFile>> = {};
  for (const file of TELEMETRY_FILES) {
    const bytes = await readBundleFile(read, bundleDir, file, issues);
    if (!bytes) continue;
    const { records, stat } = checkTelemetry(file, bytes, validators, manifest, issues);
    files[file] = { ...stat, entries: records };
  }
  if (issues.length > 0 || !manifestBytes || !manifest) {
    throw new EvidenceError(sortIssues(issues));
  }
  return {
    caseId: sha256(manifestBytes).slice(0, 16),
    manifest: investigatorManifest(manifest),
    files: files as Record<TelemetryFile, EvidenceFile>,
  };
}
