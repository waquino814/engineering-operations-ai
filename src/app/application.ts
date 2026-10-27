import type { FakeStep } from '../investigation/fake-provider.ts';
import type { InvestigationResult } from '../investigation/result.ts';
import { EvidenceError, openEvidence, type InvestigatorManifest } from '../intake/evidence.ts';
import type { RuleId, RuleNumber } from '../intake/issues.ts';
import { validateBundle, type ValidationReport } from '../intake/validate-bundle.ts';
import { runInvestigation } from '../pipeline/run-investigation.ts';
import { listBundleIds, resolveBundle } from './bundles.ts';
import { loadConfig, type AppConfig } from './config.ts';
import type { AppEnv } from './provider-gate.ts';
import { getRun, listRuns, saveRun, type RunEntry, type RunLookup } from './run-store.ts';

/**
 * The application layer (ADR 0012): the composition root that owns configuration, the provider
 * gate, bundle access, the run store and orchestration. The investigator stays provider-neutral
 * and never sees a path, a configuration or a validation report.
 */
export interface AppDeps {
  /** Scripted replies for the fake provider; tests only. Without them nothing is runnable. */
  fakeSteps?: FakeStep[];
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

export type StartOutcome =
  | { status: 'refused'; reason: 'no_runnable_provider' }
  | { status: 'error'; reason: 'invalid_bundle_id' | 'bundle_not_found' }
  | { status: 'done'; runId: string; result: InvestigationResult };

/**
 * What the console may show about a bundle: no directory path (messages are scrubbed of it) and,
 * for a valid bundle, only the blinded view's metadata (ADR 0003).
 */
export interface BundleCheck {
  bundleId: string;
  valid: boolean;
  schemaVersion: string | null;
  issues: {
    rule: RuleNumber;
    ruleId: RuleId;
    file: string | null;
    field?: string;
    line?: number;
    message: string;
  }[];
  metadata: { caseId: string; manifest: InvestigatorManifest } | null;
}

export interface Application {
  readonly config: AppConfig;
  listBundles(): Promise<string[]>;
  /** For the operator only: the report names the bundle directory (ADR 0003). */
  validateBundle(
    bundleId: string,
  ): Promise<
    | { status: 'checked'; report: ValidationReport }
    | { status: 'error'; reason: 'invalid_bundle_id' | 'bundle_not_found' }
  >;
  /** Validates a bundle and returns what the console may show about it. */
  checkBundle(
    bundleId: string,
  ): Promise<
    | { status: 'checked'; check: BundleCheck }
    | { status: 'error'; reason: 'invalid_bundle_id' | 'bundle_not_found' }
  >;
  startInvestigation(bundleId: string): Promise<StartOutcome>;
  listRuns(): Promise<RunEntry[]>;
  getRun(runId: string): Promise<RunLookup>;
}

/**
 * Startup: validates the configuration and constructs the permitted provider. It reads no bundle,
 * touches no filesystem and contacts nothing, and throws before any of that if the provider is
 * not permitted or the configuration is invalid.
 */
export function createApplication(env: AppEnv, deps: AppDeps = {}): Application {
  const config = loadConfig(env, deps.fakeSteps ? { fakeSteps: deps.fakeSteps } : {});
  const now = deps.now ?? (() => Date.now());
  return {
    config,
    listBundles: () => listBundleIds(config.bundlesDir),
    async validateBundle(bundleId) {
      const found = await resolveBundle(config.bundlesDir, bundleId);
      if (!found.ok) return { status: 'error', reason: found.reason };
      return { status: 'checked', report: await validateBundle(found.dir) };
    },
    async checkBundle(bundleId) {
      const found = await resolveBundle(config.bundlesDir, bundleId);
      if (!found.ok) return { status: 'error', reason: found.reason };
      const report = await validateBundle(found.dir);
      // Longest first, so the bundle's own path is replaced before the root it sits in.
      const scrub = (text: string) =>
        [found.dir, config.bundlesDir].reduce((t, p) => t.split(p).join('<bundle>'), text);
      let metadata: BundleCheck['metadata'] = null;
      if (report.valid) {
        try {
          const view = await openEvidence(found.dir);
          metadata = { caseId: view.caseId, manifest: view.manifest };
        } catch (e) {
          if (!(e instanceof EvidenceError)) throw e;
        }
      }
      return {
        status: 'checked',
        check: {
          bundleId,
          valid: report.valid && metadata !== null,
          schemaVersion: report.schemaVersion,
          issues: report.issues.map((i) => ({
            rule: i.rule,
            ruleId: i.ruleId,
            file: i.file,
            ...(i.field === undefined ? {} : { field: i.field }),
            ...(i.line === undefined ? {} : { line: i.line }),
            message: scrub(i.message),
          })),
          metadata,
        },
      };
    },
    async startInvestigation(bundleId) {
      // Refusals come before any bundle access.
      if (!config.provider.runnable) return { status: 'refused', reason: 'no_runnable_provider' };
      const found = await resolveBundle(config.bundlesDir, bundleId);
      if (!found.ok) return { status: 'error', reason: found.reason };
      // runInvestigation validates the bundle before the provider can be called.
      const { result } = await runInvestigation(found.dir, {
        provider: config.provider.provider,
        now,
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      const runId = await saveRun(config.runsDir, result, now());
      return { status: 'done', runId, result };
    },
    listRuns: () => listRuns(config.runsDir),
    getRun: (runId) => getRun(config.runsDir, runId),
  };
}
