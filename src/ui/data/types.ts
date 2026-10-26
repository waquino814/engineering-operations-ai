import type { InvestigatorManifest } from '../../intake/evidence.ts';
import type { RuleId, RuleNumber } from '../../intake/issues.ts';
import type { InvestigationResult } from '../../investigation/result.ts';

/**
 * The data the console shows, independent of where it comes from (ADR 0011). In E4 it comes from
 * committed fixtures; in E6 from the application boundary. Results are the investigation-result
 * contract itself (ADR 0004 as amended by ADR 0010); nothing here restates their fields.
 */

/** Where a record came from. Only fixtures exist until E6. */
export type Origin = 'fixture';

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
  | (Unavailable & {
      /** Precomputed fixture investigations for the same bundle. */ fixtureInvestigationIds: string[];
    });

/**
 * Everything the console needs from a backend. E6 implements it over the real application
 * boundary; until then `createFixtureSource` implements it over fixtures, and says so.
 */
export interface InvestigationDataSource {
  /** What the console tells the operator about where data comes from. */
  readonly description: { mode: Origin; notice: string };
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
