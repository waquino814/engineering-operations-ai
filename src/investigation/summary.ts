import type { InvestigationResult } from './result.ts';

/**
 * A sanitised, bounded summary of a result for logs and reports (ADR 0006): counts and classes
 * only. It never contains finding statements, rationales, remediation text or telemetry.
 */
export interface InvestigationSummary {
  caseId: string | null;
  outcome: InvestigationResult['outcome'];
  failureClass: string | null;
  findings: number;
  findingsByKind: Record<string, number>;
  references: number;
  remediationSteps: number;
  limitations: number;
  usage: InvestigationResult['run']['usage'];
  durationMs: number;
  selectedRecords: number | null;
}

export function summarize(result: InvestigationResult): InvestigationSummary {
  const byKind: Record<string, number> = {};
  for (const f of result.findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  const selection = result.selection as { files?: Record<string, { selected: number }> } | null;
  return {
    caseId: result.caseId,
    outcome: result.outcome,
    failureClass: result.failure?.class ?? null,
    findings: result.findings.length,
    findingsByKind: byKind,
    references: result.findings.reduce((n, f) => n + f.evidence.length, 0),
    remediationSteps: result.remediation.length,
    limitations: result.limitations.length,
    usage: { ...result.run.usage },
    durationMs: result.run.durationMs,
    selectedRecords: selection?.files
      ? Object.values(selection.files).reduce((n, f) => n + f.selected, 0)
      : null,
  };
}
