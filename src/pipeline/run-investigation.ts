import { EvidenceError, openEvidence } from '../intake/evidence.ts';
import { validateBundle, type ValidationReport } from '../intake/validate-bundle.ts';
import { InvestigationConfigError, resolveLimits } from '../investigation/config.ts';
import { failure, type Failure } from '../investigation/failures.ts';
import { createInvestigator, type InvestigatorOptions } from '../investigation/investigate.ts';
import type { InvestigationResult } from '../investigation/result.ts';
import { RESULT_SCHEMA_VERSION } from '../investigation/schemas.ts';
import { EMPTY_TOKEN_USAGE } from '../investigation/usage.ts';

/**
 * Admission and investigation (ADR 0006, steps 1 and 2). This is the only layer that takes a
 * bundle path: it validates the whole bundle, opens the blinded evidence view, and passes the
 * investigator that view alone. The validation report, which names the bundle directory, is
 * returned to the operator and never reaches the investigator.
 */
export interface PipelineRun {
  result: InvestigationResult;
  /** For the operator only. Null when the configuration was invalid. */
  report: ValidationReport | null;
}

function notInvestigated(
  f: Failure,
  options: InvestigatorOptions,
  limits: InvestigationResult['run']['limits'],
): InvestigationResult {
  const at = new Date((options.now ?? Date.now)()).toISOString();
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    caseId: null,
    bundle: null,
    outcome: 'failed',
    failure: f,
    findings: [],
    remediation: [],
    limitations: [],
    selection: null,
    run: {
      provider: options.provider.provider,
      model: options.provider.model,
      limits,
      usage: { modelCalls: 0, repairAttempts: 0, retries: 0, ...EMPTY_TOKEN_USAGE },
      startedAt: at,
      finishedAt: at,
      durationMs: 0,
    },
  };
}

export async function runInvestigation(
  bundleDir: string,
  options: InvestigatorOptions & { signal?: AbortSignal },
): Promise<PipelineRun> {
  let investigator;
  try {
    investigator = createInvestigator(options);
  } catch (err) {
    if (!(err instanceof InvestigationConfigError)) throw err;
    return {
      result: notInvestigated(failure('invalid_configuration', err.message), options, {}),
      report: null,
    };
  }
  const limits = { ...resolveLimits(options.limits) };
  const report = await validateBundle(bundleDir);
  if (!report.valid) {
    const rules = [...new Set(report.issues.map((i) => i.rule))].join(', ');
    const cls = report.issues.some((i) => i.rule === 2)
      ? 'unsupported_contract_version'
      : 'invalid_bundle';
    // Counts and rule numbers only: issue messages can quote the scenario-bearing directory name.
    return {
      result: notInvestigated(
        failure(cls, `${String(report.issues.length)} contract issue(s) under rule(s) ${rules}`),
        options,
        limits,
      ),
      report,
    };
  }
  try {
    const view = await openEvidence(bundleDir);
    return {
      result: await investigator.investigate(
        view,
        options.signal ? { signal: options.signal } : {},
      ),
      report,
    };
  } catch (err) {
    if (!(err instanceof EvidenceError)) throw err;
    return {
      result: notInvestigated(
        failure(
          'invalid_bundle',
          `the evidence changed after validation: ${String(err.issues.length)} issue(s)`,
        ),
        options,
        limits,
      ),
      report,
    };
  }
}
