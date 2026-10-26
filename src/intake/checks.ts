import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  majorOf,
  RECORD_SCHEMA,
  SUPPORTED_MAJOR_VERSIONS,
  validatorsFor,
  type BundleFile,
  type TelemetryFile,
  type Validators,
} from './contract.ts';
import {
  fieldOf,
  issue,
  MAX_LINE_ISSUES,
  show,
  type RuleNumber,
  type ValidationIssue,
} from './issues.ts';
import { decodeUtf8, parseJsonl, recordCount } from './jsonl.ts';

/**
 * Checks shared by contract validation and the investigator-facing evidence loader. Nothing here
 * reads or names the bundle's answer file (ADR 0003): callers pass in only the files they may see.
 */
export type ReadFile = (path: string) => Promise<Uint8Array>;
export const nodeReadFile: ReadFile = (path) => readFile(path);

export type JsonObject = Record<string, unknown>;
export const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface FileStat {
  sha256: string;
  bytes: number;
  records: number;
}

/** Reads one bundle file. Missing is null; any other failure is a rule 1 issue. */
export async function readBundleFile(
  read: ReadFile,
  dir: string,
  file: BundleFile,
  issues: ValidationIssue[],
): Promise<Uint8Array | null> {
  try {
    return await read(join(dir, file));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    issues.push(
      issue(
        1,
        file,
        code === 'ENOENT'
          ? `${file} is missing`
          : `${file} could not be read (${code ?? (err instanceof Error ? err.message : String(err))})`,
      ),
    );
    return null;
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Parses a JSON document file: strict UTF-8, one JSON value. */
export function parseDocument(
  bytes: Uint8Array,
  file: BundleFile,
  issues: ValidationIssue[],
): unknown {
  const text = decodeUtf8(bytes);
  if (text === null) {
    issues.push(issue(3, file, `${file} is not valid UTF-8`));
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    issues.push(issue(3, file, `${file} is not valid JSON`));
    return undefined;
  }
}

/** Appends one issue per Ajv error, with the field it concerns. */
export function schemaIssues(
  validate: Validators[keyof Validators],
  value: unknown,
  rule: RuleNumber,
  file: BundleFile,
  line?: number,
): ValidationIssue[] {
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => {
    const field = fieldOf(
      e.instancePath,
      (e.params as { missingProperty?: unknown }).missingProperty,
    );
    const where = field === '' ? 'the document' : field;
    const what = line === undefined ? '' : ' record';
    return issue(rule, file, `${file}${what}: ${where} ${e.message ?? 'is invalid'}`, {
      field: field === '' ? undefined : field,
      line,
    });
  });
}

export interface ManifestCheck {
  manifest: JsonObject | null;
  schemaVersion: string | null;
  validators: Validators | null;
}

/**
 * Rules 2 and 3 for manifest.json: parse it, select the schemas by its major version, validate it.
 * `validators` is null when no schema can be chosen, and later schema checks are then skipped.
 */
export async function checkManifest(
  bytes: Uint8Array,
  issues: ValidationIssue[],
): Promise<ManifestCheck> {
  const value = parseDocument(bytes, 'manifest.json', issues);
  if (value === undefined) return { manifest: null, schemaVersion: null, validators: null };
  if (!isObject(value)) {
    issues.push(issue(3, 'manifest.json', 'manifest.json must be a JSON object'));
    return { manifest: null, schemaVersion: null, validators: null };
  }
  const version = value.schemaVersion;
  const major = majorOf(version);
  const supported = SUPPORTED_MAJOR_VERSIONS.map(String).join(', ');
  if (major === null) {
    issues.push(
      issue(
        2,
        'manifest.json',
        `schemaVersion must be a semantic version such as "1.0.0"; found ${show(version)}`,
        { field: 'schemaVersion' },
      ),
    );
    return { manifest: value, schemaVersion: null, validators: null };
  }
  const versionText = version as string;
  if (!SUPPORTED_MAJOR_VERSIONS.includes(major)) {
    issues.push(
      issue(
        2,
        'manifest.json',
        `schemaVersion "${versionText}" has major version ${String(major)}; supported: ${supported}`,
        { field: 'schemaVersion' },
      ),
    );
    return { manifest: value, schemaVersion: versionText, validators: null };
  }
  const validators = await validatorsFor(major);
  issues.push(...schemaIssues(validators.manifest, value, 3, 'manifest.json'));
  return { manifest: value, schemaVersion: versionText, validators };
}

/** The manifest's `files.<file>` entry, if it has the three fields rule 9 compares. */
export function declaredStat(manifest: JsonObject | null, file: BundleFile): FileStat | null {
  const files = manifest?.files;
  const entry = isObject(files) ? files[file] : undefined;
  if (!isObject(entry)) return null;
  const { sha256: s, bytes, records } = entry;
  if (typeof s !== 'string' || typeof bytes !== 'number' || typeof records !== 'number')
    return null;
  return { sha256: s, bytes, records };
}

/** Rule 9: the file's SHA-256, byte count and record count against the manifest. */
export function checkIntegrity(
  file: BundleFile,
  bytes: Uint8Array,
  records: number,
  declared: FileStat | null,
): ValidationIssue[] {
  if (!declared) return [];
  const actual = { sha256: sha256(bytes), bytes: bytes.length, records };
  return (['sha256', 'bytes', 'records'] as const)
    .filter((k) => declared[k] !== actual[k])
    .map((k) =>
      issue(
        9,
        file,
        `manifest.json files.${file}.${k} is ${show(declared[k])}, but ${file} has ${show(actual[k])}`,
        { field: `files.${file}.${k}` },
      ),
    );
}

export interface TelemetryCheck {
  records: { line: number; value: unknown }[];
  stat: FileStat;
}

/** Keeps at most MAX_LINE_ISSUES per rule for one file, then says how many more there were. */
function capLineIssues(file: BundleFile, found: ValidationIssue[]): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const rule of [4, 5] as const) {
    const ofRule = found.filter((i) => i.rule === rule);
    out.push(...ofRule.slice(0, MAX_LINE_ISSUES));
    if (ofRule.length > MAX_LINE_ISSUES) {
      out.push(
        issue(
          rule,
          file,
          `${String(ofRule.length - MAX_LINE_ISSUES)} more line issues in ${file} under rule ${String(rule)} are not listed`,
        ),
      );
    }
  }
  return out;
}

/** The trace IDs of every span on one OTLP `TracesData` line. */
function traceIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  if (!isObject(value) || !Array.isArray(value.resourceSpans)) return ids;
  for (const rs of value.resourceSpans) {
    if (!isObject(rs) || !Array.isArray(rs.scopeSpans)) continue;
    for (const ss of rs.scopeSpans) {
      if (!isObject(ss) || !Array.isArray(ss.spans)) continue;
      for (const span of ss.spans) {
        if (isObject(span) && typeof span.traceId === 'string') ids.add(span.traceId);
      }
    }
  }
  return ids;
}

/**
 * Rules 4, 5 and 9 for one telemetry file. `validators` is null when no schema could be chosen;
 * the JSONL structure is still checked.
 */
export function checkTelemetry(
  file: TelemetryFile,
  bytes: Uint8Array,
  validators: Validators | null,
  manifest: JsonObject | null,
  issues: ValidationIssue[],
): TelemetryCheck {
  const records: TelemetryCheck['records'] = [];
  const stat: FileStat = {
    sha256: sha256(bytes),
    bytes: bytes.length,
    records: recordCount(bytes),
  };
  issues.push(...checkIntegrity(file, bytes, stat.records, declaredStat(manifest, file)));
  const text = decodeUtf8(bytes);
  if (text === null) {
    issues.push(issue(4, file, `${file} is not valid UTF-8`));
    return { records, stat };
  }
  const found: ValidationIssue[] = [];
  for (const entry of parseJsonl(text)) {
    if ('error' in entry) {
      found.push(
        issue(4, file, `${file} line ${String(entry.line)}: ${entry.error}`, { line: entry.line }),
      );
      continue;
    }
    if (validators) {
      const errs = schemaIssues(validators[RECORD_SCHEMA[file]], entry.value, 4, file, entry.line);
      if (errs.length > 0) {
        found.push(...errs);
        continue;
      }
    }
    if (file === 'traces.jsonl') {
      const ids = traceIds(entry.value);
      if (ids.size > 1) {
        found.push(
          issue(
            5,
            file,
            `traces.jsonl line ${String(entry.line)} mixes ${String(ids.size)} trace IDs; each line must hold one trace`,
            {
              line: entry.line,
            },
          ),
        );
        continue;
      }
    }
    records.push(entry);
  }
  issues.push(...capLineIssues(file, found));
  return { records, stat };
}
