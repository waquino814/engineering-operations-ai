import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { GROUND_TRUTH_FILE, TELEMETRY_FILES } from './contract.ts';
import {
  checkIntegrity,
  checkManifest,
  checkTelemetry,
  declaredStat,
  isObject,
  nodeReadFile,
  parseDocument,
  readBundleFile,
  schemaIssues,
  type JsonObject,
  type ReadFile,
} from './checks.ts';
import { issue, show, sortIssues, type ValidationIssue } from './issues.ts';

/**
 * Contract validation: all nine rules of docs/contracts/incident-bundle/README.md over the five
 * bundle files (ADR 0005). This is one of the two places allowed to read the answer file, because
 * the contract requires its schema, checksum and scenario checks (ADR 0003). Its report carries
 * issues only, never ground-truth content beyond what an issue must quote.
 */
export interface ValidationReport {
  valid: boolean;
  /** The directory as given. */
  bundleDir: string;
  /** manifest.json's schemaVersion, if it could be read. */
  schemaVersion: string | null;
  issues: ValidationIssue[];
}

export interface ValidateOptions {
  /** Reads a file; injectable so tests can observe and fault reads. */
  readFile?: ReadFile;
}

const SCENARIO_KEYS = ['name', 'version', 'seed'] as const;

export async function validateBundle(
  bundleDir: string,
  options: ValidateOptions = {},
): Promise<ValidationReport> {
  const read = options.readFile ?? nodeReadFile;
  const issues: ValidationIssue[] = [];
  const done = (schemaVersion: string | null): ValidationReport => {
    const sorted = sortIssues(issues);
    return { valid: sorted.length === 0, bundleDir, schemaVersion, issues: sorted };
  };

  // Rule 1: the directory and its five files.
  const info = await stat(bundleDir).catch(() => null);
  if (!info?.isDirectory()) {
    issues.push(issue(1, null, `${bundleDir} is not a directory`));
    return done(null);
  }
  const manifestBytes = await readBundleFile(read, bundleDir, 'manifest.json', issues);
  const truthBytes = await readBundleFile(read, bundleDir, GROUND_TRUTH_FILE, issues);

  // Rules 2 and 3 for the manifest; they select the schemas for everything else.
  const { manifest, schemaVersion, validators } = manifestBytes
    ? await checkManifest(manifestBytes, issues)
    : { manifest: null, schemaVersion: null, validators: null };

  // Rule 3 for the ground truth, and rule 9 for its integrity.
  let truth: JsonObject | null = null;
  if (truthBytes) {
    issues.push(
      ...checkIntegrity(
        GROUND_TRUTH_FILE,
        truthBytes,
        1,
        declaredStat(manifest, GROUND_TRUTH_FILE),
      ),
    );
    const value = parseDocument(truthBytes, GROUND_TRUTH_FILE, issues);
    if (value !== undefined) {
      if (validators)
        issues.push(...schemaIssues(validators['ground-truth'], value, 3, GROUND_TRUTH_FILE));
      truth = isObject(value) ? value : null;
      if (!validators && !isObject(value)) {
        issues.push(issue(3, GROUND_TRUTH_FILE, `${GROUND_TRUTH_FILE} must be a JSON object`));
      }
    }
  }

  // Rules 4, 5 and 9 for the telemetry files.
  for (const file of TELEMETRY_FILES) {
    const bytes = await readBundleFile(read, bundleDir, file, issues);
    if (bytes) checkTelemetry(file, bytes, validators, manifest, issues);
  }

  if (manifest) {
    // Rule 6: the bundle ID names the directory.
    const dirName = basename(resolve(bundleDir));
    if (typeof manifest.bundleId === 'string' && manifest.bundleId !== dirName) {
      issues.push(
        issue(
          6,
          'manifest.json',
          `bundleId "${manifest.bundleId}" does not match the directory name "${dirName}"`,
          {
            field: 'bundleId',
          },
        ),
      );
    }

    // Rule 7: the manifest and the ground truth name the same scenario.
    if (truth && isObject(manifest.scenario) && isObject(truth.scenario)) {
      for (const key of SCENARIO_KEYS) {
        const ours = manifest.scenario[key];
        const theirs = truth.scenario[key];
        if (ours !== theirs) {
          issues.push(
            issue(
              7,
              'manifest.json',
              `scenario.${key} is ${show(ours)} in manifest.json but ${show(theirs)} in ${GROUND_TRUTH_FILE}`,
              { field: `scenario.${key}` },
            ),
          );
        }
      }
    }

    // Rule 8: `truncated` is true exactly when there are truncation reasons.
    const capture = manifest.capture;
    const traces = isObject(capture) ? capture.traces : undefined;
    const services = isObject(traces) ? traces.services : undefined;
    if (Array.isArray(services)) {
      services.forEach((s, i) => {
        if (!isObject(s) || typeof s.truncated !== 'boolean' || !Array.isArray(s.truncationReasons))
          return;
        if (s.truncated !== s.truncationReasons.length > 0) {
          issues.push(
            issue(
              8,
              'manifest.json',
              `capture.traces.services.${String(i)}: truncated is ${String(s.truncated)} but truncationReasons has ${String(s.truncationReasons.length)} entries; truncated must be true exactly when there are reasons`,
              { field: `capture.traces.services.${String(i)}.truncated` },
            ),
          );
        }
      });
    }
  }

  return done(schemaVersion);
}
