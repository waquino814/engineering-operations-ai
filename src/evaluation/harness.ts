import { openEvidence } from '../intake/evidence.ts';
import type { ModelProvider, ModelReply, ModelRequest } from '../investigation/provider.ts';
import { INSTRUCTIONS } from '../investigation/request.ts';
import { MODEL_OUTPUT_SCHEMA } from '../investigation/schemas.ts';
import { readInvestigationResult, type InvestigationResult } from '../investigation/result.ts';
import { summarize, type InvestigationSummary } from '../investigation/summary.ts';
import { runInvestigation } from '../pipeline/run-investigation.ts';
import { readAnswerKey } from './ground-truth.ts';
import { findLeaks, legitimateText, protectedValues, type LeakFinding } from './leakage.ts';
import { scoreResult, type Score } from './score.ts';

/**
 * The evaluation harness (ADR 0009). For each case it runs the normal pipeline, then, separately,
 * reads the answer key, scores the result, checks the result against its contract, and checks
 * that no protected value (answer text, excluded manifest metadata, the bundle's location) reached
 * any model request or the result's metadata (src/evaluation/leakage.ts). Its report holds no
 * timestamps, durations or protected values, so a deterministic provider gives a byte-identical
 * report.
 */
export interface EvaluationCase {
  id: string;
  /** "synthetic" fixtures and scripted replies, or a "real" bundle and model. */
  kind: 'synthetic' | 'real';
  bundleDir: string;
  provider: ModelProvider;
  limits?: Partial<Record<string, unknown>>;
}

export interface CaseReport {
  id: string;
  kind: EvaluationCase['kind'];
  summary: Omit<InvestigationSummary, 'durationMs'>;
  score: Score | null;
  /** Whether the result passed `readInvestigationResult`. */
  resultValid: boolean;
  answerLeak: {
    checkedRequests: number;
    checkedValues: number;
    legitimatelyPresent: number;
    leaked: boolean;
    findings: LeakFinding[];
  };
}

export interface EvaluationReport {
  schemaVersion: '0.1.0';
  cases: CaseReport[];
  totals: {
    cases: number;
    byOutcome: Record<string, number>;
    rootCauseCorrect: number;
    /** Cases whose result names more than one root-cause component. */
    rootCauseAmbiguous: number;
    /** Cases where a finding cites the series of the primary symptom (scoring v0.1). */
    symptomEvidenceCovered: number;
    /** Cases the pipeline rejected because a citation did not hold. */
    rejectedForEvidence: number;
    answerLeaks: number;
  };
}

/** Wraps a provider to keep a copy of every request, for the leak check. */
class Recording implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  readonly provider: string;
  readonly model: string;
  private readonly inner: ModelProvider;
  constructor(inner: ModelProvider) {
    this.inner = inner;
    this.provider = inner.provider;
    this.model = inner.model;
  }
  complete(request: ModelRequest, options: { signal: AbortSignal }): Promise<ModelReply> {
    this.requests.push(request);
    return this.inner.complete(request, options);
  }
}

/**
 * A request as text, for the leak check: instructions, input and output schema. The model's own
 * previous reply, echoed back in a repair request, is left out: it is the model's text, and an
 * answer the model inferred is not a leak.
 */
function requestText(r: ModelRequest): string {
  let input = r.input;
  try {
    const parsed = JSON.parse(input) as { repair?: { previousReply?: unknown } };
    if (parsed.repair) delete parsed.repair.previousReply;
    input = JSON.stringify(parsed);
  } catch {
    // Not JSON: check it whole.
  }
  return `${r.instructions}\n${input}\n${JSON.stringify(r.outputSchema)}`;
}

/** The result's fields the pipeline writes, as opposed to the model's findings. */
const resultMetadata = (r: InvestigationResult) =>
  JSON.stringify({
    caseId: r.caseId,
    bundle: r.bundle,
    failure: r.failure,
    selection: r.selection,
    run: r.run,
  });

export async function runEvaluation(cases: EvaluationCase[]): Promise<EvaluationReport> {
  const reports: CaseReport[] = [];
  for (const c of cases) {
    const provider = new Recording(c.provider);
    // A fixed clock: timing is not part of the report.
    const { result } = await runInvestigation(c.bundleDir, {
      provider,
      now: () => 0,
      sleep: () => Promise.resolve(),
      ...(c.limits ? { limits: c.limits } : {}),
    });
    // Scoring starts only after the investigation has finished.
    const key = await readAnswerKey(c.bundleDir);
    const view = await openEvidence(c.bundleDir).catch(() => null);
    const leaks = findLeaks(
      [
        ...provider.requests.map((r) => ({ channel: 'request', text: requestText(r) })),
        { channel: 'result_metadata', text: resultMetadata(result) },
      ],
      await protectedValues(c.bundleDir),
      legitimateText(view, [INSTRUCTIONS, JSON.stringify(MODEL_OUTPUT_SCHEMA)]),
    );
    const summary: Omit<InvestigationSummary, 'durationMs'> & { durationMs?: number } =
      summarize(result);
    delete summary.durationMs;
    reports.push({
      id: c.id,
      kind: c.kind,
      summary,
      score: result.caseId === null ? null : scoreResult(result, key),
      resultValid: readInvestigationResult(result).ok,
      answerLeak: {
        checkedRequests: provider.requests.length,
        checkedValues: leaks.checkedValues,
        legitimatelyPresent: leaks.legitimatelyPresent,
        leaked: leaks.findings.length > 0,
        // One entry per channel and source, in a stable order.
        findings: [...new Map(leaks.findings.map((f) => [`${f.channel}|${f.source}`, f])).values()],
      },
    });
  }
  const byOutcome: Record<string, number> = {};
  for (const r of reports) byOutcome[r.summary.outcome] = (byOutcome[r.summary.outcome] ?? 0) + 1;
  return {
    schemaVersion: '0.1.0',
    cases: reports,
    totals: {
      cases: reports.length,
      byOutcome,
      rootCauseCorrect: reports.filter((r) => r.score?.rootCause === 'correct').length,
      rootCauseAmbiguous: reports.filter((r) => r.score?.rootCause === 'ambiguous').length,
      symptomEvidenceCovered: reports.filter((r) => r.score?.symptomEvidence === 'covered').length,
      rejectedForEvidence: reports.filter(
        (r) => r.summary.failureClass === 'evidence_verification_failed',
      ).length,
      answerLeaks: reports.filter((r) => r.answerLeak.leaked).length,
    },
  };
}
