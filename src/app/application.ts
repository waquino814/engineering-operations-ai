import { FakeProvider, type FakeStep } from '../investigation/fake-provider.ts';
import type { ModelProvider } from '../investigation/provider.ts';
import type { InvestigationResult } from '../investigation/result.ts';
import { SimulatedProvider } from '../investigation/simulated-provider.ts';
import { createOllamaHttp, globalFetch, type FetchLike } from '../providers/ollama/client.ts';
import { OllamaProvider } from '../providers/ollama/provider.ts';
import { verifyLocalModel } from '../providers/ollama/verify.ts';
import { EvidenceError, openEvidence, type InvestigatorManifest } from '../intake/evidence.ts';
import type { RuleId, RuleNumber } from '../intake/issues.ts';
import { validateBundle, type ValidationReport } from '../intake/validate-bundle.ts';
import { runInvestigation } from '../pipeline/run-investigation.ts';
import { listBundleIds, resolveBundle } from './bundles.ts';
import { loadConfig, type AppConfig } from './config.ts';
import type { AppEnv, ProviderName } from './provider-gate.ts';
import {
  parseSettingsInput,
  readSettings,
  SettingsError,
  writeSettings,
  type Settings,
} from './settings.ts';
import { checkCitations, type EvidenceReport } from './evidence.ts';
import {
  getRun,
  listRuns,
  readRunMeta,
  saveRun,
  type RunEntry,
  type RunLookup,
} from './run-store.ts';

/**
 * The application layer (ADR 0012): the composition root that owns configuration, the provider
 * gate, bundle access, the run store and orchestration. The investigator stays provider-neutral
 * and never sees a path, a configuration or a validation report.
 */
export interface AppDeps {
  /** Scripted replies for the fake provider; tests only. Without them it simulates (labelled). */
  fakeSteps?: FakeStep[];
  /** A fake provider shared by every run, so a test can inspect its requests; tests only. */
  fakeProvider?: FakeProvider;
  /** The fetch used for the local Ollama runtime; injected by tests. */
  ollamaFetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

export type StartOutcome =
  /** The selected provider cannot run now; `message` says why and is safe to show. Nothing ran. */
  | { status: 'refused'; reason: 'provider_blocked'; message: string }
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

/** The selected provider and whether it can run now, kept apart (ADR 0013). */
export interface ProviderStatus {
  selected: ProviderName;
  /** True when EOAI_MODEL_PROVIDER fixes the choice. */
  pinned: boolean;
  runnable: boolean;
  /** True for the deterministic fake provider: its output is simulated, not AI-generated. */
  simulated: boolean;
  /** The model that would run (or the simulation's name). */
  model: string | null;
  /** Installed Ollama models, when Ollama was checked and answered. */
  models: string[];
  /** Why it cannot run, in words fit for the console. */
  reason: string | null;
}

export type SettingsUpdate =
  { status: 'saved'; settings: Settings } | { status: 'invalid' } | { status: 'pinned' };

/**
 * Limits for a local model (ADR 0013, section 9). The context window requested from Ollama is
 * `LOCAL_NUM_CTX`; the request is kept well inside it, because a prompt longer than the window
 * would be cut silently. 48,000 bytes is at most about 24,000 tokens even at two bytes per
 * token; nothing here is measured, and a local model's quality is not claimed.
 */
export const LOCAL_NUM_CTX = 32_768;
export const LOCAL_LIMITS = {
  maxContextBytes: 48_000,
  // The selection budget reserves 160 bytes per possible record, so this must stay small for a
  // 48,000-byte context (the default 200 would reserve 32,000 bytes and select nothing).
  maxEvidenceRecords: 40,
  maxInputTokensPerCall: 28_000,
  maxOutputTokens: 3_000,
  maxModelCalls: 3,
  maxRetries: 1,
  perCallTimeoutMs: 400_000,
  deadlineMs: 1_200_000,
  maxTotalTokens: 100_000,
} as const;

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
  getSettings(): Promise<Settings & { pinned: boolean }>;
  /** Validates strictly and persists; never contacts a provider. */
  updateSettings(input: unknown): Promise<SettingsUpdate>;
  /** Checks the selected provider now (for Ollama, a read-only metadata check). */
  getProviderStatus(): Promise<ProviderStatus>;
  startInvestigation(bundleId: string, options?: { signal?: AbortSignal }): Promise<StartOutcome>;
  listRuns(): Promise<RunEntry[]>;
  /** Re-checks a saved run's citations against the original bundle and returns the cited text. */
  getEvidence(
    runId: string,
  ): Promise<
    | { status: 'ok'; report: EvidenceReport }
    | { status: 'error'; reason: 'invalid_run_id' | 'run_not_found' | 'unreadable' }
  >;
  getRun(runId: string): Promise<RunLookup>;
}

/**
 * Startup: validates the configuration and constructs the permitted provider. It reads no bundle,
 * touches no filesystem and contacts nothing, and throws before any of that if the provider is
 * not permitted or the configuration is invalid.
 */
export function createApplication(env: AppEnv, deps: AppDeps = {}): Application {
  const config = loadConfig(env);
  const now = deps.now ?? (() => Date.now());
  // One scripted provider for the life of the application, so its steps are consumed across runs.
  const scripted =
    deps.fakeProvider ?? (deps.fakeSteps ? new FakeProvider(deps.fakeSteps, 'scripted') : null);
  const http = createOllamaHttp(config.ollamaUrl, deps.ollamaFetch ?? globalFetch);

  const selection = async (): Promise<Settings & { pinned: boolean }> => {
    const stored = await readSettings(config.settingsFile);
    return config.pinned === null
      ? { ...stored, pinned: false }
      : { ...stored, provider: config.pinned, pinned: true };
  };
  const status = async (
    signal?: AbortSignal,
  ): Promise<{ status: ProviderStatus; build: (() => ModelProvider) | null }> => {
    const chosen = await selection();
    const base = { selected: chosen.provider, pinned: chosen.pinned, models: [] as string[] };
    if (chosen.provider === 'fake') {
      const provider: ModelProvider = scripted ?? new SimulatedProvider();
      return {
        status: { ...base, runnable: true, simulated: true, model: provider.model, reason: null },
        build: () => provider,
      };
    }
    const check = await verifyLocalModel(http, chosen.ollamaModel, signal);
    if (!check.ok)
      return {
        status: {
          ...base,
          models: check.installed,
          runnable: false,
          simulated: false,
          model: chosen.ollamaModel,
          reason: check.message,
        },
        build: null,
      };
    return {
      status: {
        ...base,
        models: check.installed,
        runnable: true,
        simulated: false,
        model: check.model.name,
        reason: null,
      },
      build: () => new OllamaProvider(http, check.model, { numCtx: LOCAL_NUM_CTX }),
    };
  };

  return {
    config,
    getSettings: selection,
    async updateSettings(input) {
      const parsed = parseSettingsInput(input);
      if (!parsed) return { status: 'invalid' };
      if (config.pinned !== null) return { status: 'pinned' };
      await writeSettings(config.settingsFile, parsed);
      return { status: 'saved', settings: parsed };
    },
    getProviderStatus: async () => (await status()).status,
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
    async startInvestigation(bundleId, options = {}) {
      // The provider is chosen, and for Ollama verified as local, before any bundle is read.
      let ready;
      try {
        ready = await status(options.signal);
      } catch (e) {
        if (!(e instanceof SettingsError)) throw e;
        return {
          status: 'refused',
          reason: 'provider_blocked',
          message: `${e.message}. Fix or remove it, then retry. Nothing was run.`,
        };
      }
      if (ready.build === null)
        return {
          status: 'refused',
          reason: 'provider_blocked',
          message: ready.status.reason ?? 'The provider cannot run. Nothing was run.',
        };
      const found = await resolveBundle(config.bundlesDir, bundleId);
      if (!found.ok) return { status: 'error', reason: found.reason };
      const signals = [deps.signal, options.signal].flatMap((x) => (x ? [x] : []));
      const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
      // runInvestigation validates the bundle before the provider can be called.
      const { result } = await runInvestigation(found.dir, {
        provider: ready.build(),
        now,
        ...(ready.status.selected === 'ollama' ? { limits: LOCAL_LIMITS } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        ...(signal ? { signal } : {}),
      });
      const runId = await saveRun(config.runsDir, result, now(), { bundleId });
      return { status: 'done', runId, result };
    },
    listRuns: () => listRuns(config.runsDir),
    async getEvidence(runId) {
      const run = await getRun(config.runsDir, runId);
      if (!run.ok) return { status: 'error', reason: run.reason };
      if (run.result.bundle === null)
        return { status: 'ok', report: { status: 'unavailable', reason: 'not_admitted' } };
      const meta = await readRunMeta(config.runsDir, runId);
      if (meta === null)
        return { status: 'ok', report: { status: 'unavailable', reason: 'no_bundle_recorded' } };
      const found = await resolveBundle(config.bundlesDir, meta.bundleId);
      if (!found.ok)
        return { status: 'ok', report: { status: 'unavailable', reason: 'bundle_not_found' } };
      return { status: 'ok', report: await checkCitations(found.dir, run.result) };
    },
    getRun: (runId) => getRun(config.runsDir, runId),
  };
}
