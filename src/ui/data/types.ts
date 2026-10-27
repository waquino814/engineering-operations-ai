import type { InvestigatorManifest } from '../../intake/evidence.ts';
import type { RuleId, RuleNumber } from '../../intake/issues.ts';
import type { InvestigationResult } from '../../investigation/result.ts';

/**
 * The data the console shows, independent of where it comes from (ADR 0011). In E4 it comes from
 * committed fixtures; in E6 from the application boundary. Results are the investigation-result
 * contract itself (ADR 0004 as amended by ADR 0010); nothing here restates their fields.
 */

/** Where a record came from: committed fixtures, or the local application (ADR 0012). */
export type Origin = 'fixture' | 'local';

/** A bundle an operator can choose, with what is known about it. */
export interface BundleOption {
  id: string;
  label: string;
  description: string;
  origin: Origin;
}

/** One validation issue, as the console shows it: rule, location and an actionable message. */
export interface BundleIssue {
  rule: RuleNumber;
  ruleId: RuleId;
  file: string | null;
  field?: string;
  line?: number;
  message: string;
}

/** What the console may show about a valid bundle: the blinded view's metadata (ADR 0003). */
export interface BundleMetadata {
  caseId: string;
  manifest: InvestigatorManifest;
}

export interface BundleValidation {
  bundleId: string;
  valid: boolean;
  /** manifest.json's schemaVersion, when it could be read. */
  schemaVersion: string | null;
  issues: BundleIssue[];
  /** Present only for a valid bundle. */
  metadata: BundleMetadata | null;
}

export interface InvestigationRecord {
  id: string;
  label: string;
  bundleId: string;
  origin: Origin;
  result: InvestigationResult;
}

/** The answer to an operation the current data source cannot perform. */
export interface Unavailable {
  status: 'unavailable';
  reason: string;
}

export type StartOutcome =
  | { status: 'started'; investigationId: string }
  /** The request failed; nothing was started. Never shown as a result. */
  | { status: 'error'; message: string }
  | (Unavailable & {
      /** Precomputed fixture investigations for the same bundle. */ fixtureInvestigationIds: string[];
    });

/** The selected provider and whether it can run now, kept apart; never a path or a secret. */
export interface ProviderStatus {
  selected: 'fake' | 'ollama' | 'fixture';
  /** True when the environment fixes the choice and Settings cannot change it. */
  pinned: boolean;
  runnable: boolean;
  /** True for the deterministic fake provider: its output is simulated, not AI-generated. */
  simulated: boolean;
  model: string | null;
  /** Installed local models, when the runtime answered. */
  models: string[];
  reason: string | null;
}

/** An evaluation suite the application can run (E7). */
export interface EvaluationSuite {
  id: string;
  version: string;
  split: 'development' | 'held-out';
  description: string;
  cases: { id: string; scenario: string }[];
}

export type EvaluationProviderChoice = 'scripted' | 'simulated' | 'ollama';

export interface EvaluationMetric {
  id: string;
  label: string;
  definition: string;
  numerator: number | null;
  denominator: number;
  value: number | null;
  status: 'scored' | 'not_applicable' | 'not_scored';
  note?: string;
}

export interface EvaluationCaseView {
  id: string;
  summary: { outcome: string; failureClass: string | null };
  failure: { class: string; message: string } | null;
  scenario: { name: string; seed: number } | null;
  score: {
    rootCause: string;
    symptomEvidence: string;
    affected: { predicted: string[]; expected: string[] };
  } | null;
  rationale: string[];
  grounding: { citations: number; verified: number } | null;
  resultValid: boolean;
  answerLeak: { leaked: boolean };
  durationMs?: number;
}

/** A stored evaluation run, as the console reads it. */
export interface EvaluationDetailView {
  id: string;
  suite: {
    id: string;
    version: string;
    split: 'development' | 'held-out';
    synthetic: boolean;
    description: string;
  };
  provider: {
    kind: 'scripted' | 'simulated' | 'real_model';
    provider: string;
    model: string;
    simulated: boolean;
  };
  measuresModelQuality: boolean;
  startedAt: string;
  durationMs: number;
  status: 'complete' | 'incomplete';
  report: { cases: EvaluationCaseView[] };
  metrics: EvaluationMetric[];
  scenarios: {
    scenario: string | null;
    seed: number | null;
    cases: string[];
    metrics: EvaluationMetric[];
  }[];
  reliability: {
    cases: number;
    completed: number;
    inconclusive: number;
    failed: number;
    budgetExceeded: number;
    notAdmitted: number;
    timeouts: number;
    harnessErrors: number;
    failuresByClass: Record<string, number>;
  };
  harnessErrors: { id: string; error: string }[];
  limitations: string[];
}

export type EvaluationEntryView =
  | {
      id: string;
      ok: true;
      suite: EvaluationDetailView['suite'];
      provider: EvaluationDetailView['provider'];
      measuresModelQuality: boolean;
      startedAt: string;
      status: 'complete' | 'incomplete';
      headline: { cases: number; rootCauseCorrect: string; completion: string };
    }
  | { id: string; ok: false; problems: string[] };

export interface EvaluationComparisonView {
  suite: { id: string; version: string };
  a: { id: string; provider: EvaluationDetailView['provider'] };
  b: { id: string; provider: EvaluationDetailView['provider'] };
  sameProvider: boolean;
  metrics: {
    id: string;
    label: string;
    a: number | null;
    b: number | null;
    delta: number | null;
  }[];
  cases: { id: string; change: string; a: string | null; b: string | null }[];
  regressions: number;
  improvements: number;
}

export type EvaluationStartOutcome =
  | { status: 'started'; id: string }
  /** The provider cannot run (for Ollama, the local-only check); nothing was run or stored. */
  | { status: 'refused'; message: string }
  | { status: 'error'; message: string };

/** A saved result's citation, re-checked against the original bundle (never rerunning a model). */
export interface CitationCheck {
  findingId: string;
  file: string;
  line: number;
  status: 'verified' | 'file_changed' | 'line_missing' | 'identity_mismatch' | 'unreadable';
  /** The cited record's text, present only when the bundle file is unchanged. */
  excerpt: string | null;
  truncated: boolean;
  issues: string[];
}

export type EvidenceReport =
  | { status: 'checked'; citations: CitationCheck[] }
  | {
      status: 'unavailable';
      reason: 'not_admitted' | 'no_bundle_recorded' | 'bundle_not_found' | 'fixture';
    };

export interface ProviderSettings {
  provider: 'fake' | 'ollama';
  ollamaModel: string | null;
  pinned: boolean;
}

/**
 * Everything the console needs from a backend. E6 implements it over the real application
 * boundary; until then `createFixtureSource` implements it over fixtures, and says so.
 */
export interface InvestigationDataSource {
  /** What the console tells the operator about where data comes from. */
  readonly description: { mode: Origin; notice: string };
  getProviderStatus(): Promise<ProviderStatus>;
  getSettings(): Promise<ProviderSettings>;
  listEvaluationSuites(): Promise<EvaluationSuite[]>;
  listEvaluations(): Promise<EvaluationEntryView[]>;
  getEvaluation(id: string): Promise<EvaluationDetailView | null>;
  startEvaluation(input: {
    suiteId: string;
    provider: EvaluationProviderChoice;
  }): Promise<EvaluationStartOutcome>;
  compareEvaluations(a: string, b: string): Promise<EvaluationComparisonView>;
  /** Re-checks the citations of a saved investigation and returns the cited text. */
  getEvidence(id: string): Promise<EvidenceReport>;
  /** Rejects when the application refuses the choice; never falls back to another provider. */
  saveSettings(input: {
    provider: 'fake' | 'ollama';
    ollamaModel: string | null;
  }): Promise<ProviderSettings>;
  listInvestigations(): Promise<InvestigationRecord[]>;
  getInvestigation(id: string): Promise<InvestigationRecord | null>;
  listBundles(): Promise<BundleOption[]>;
  validateBundle(bundleId: string): Promise<BundleValidation>;
  uploadBundle(
    files: readonly File[],
  ): Promise<Unavailable | { status: 'uploaded'; bundleId: string }>;
  startInvestigation(bundleId: string): Promise<StartOutcome>;
}

/** The committed fixture file's shape (src/ui/fixtures/fixtures.json). */
export interface UiFixtures {
  fixtureVersion: 1;
  notice: string;
  bundles: (BundleOption & { validation: Omit<BundleValidation, 'bundleId'> })[];
  investigations: Omit<InvestigationRecord, 'origin'>[];
}
