import { loadTelemetry, type Loaded } from '../app/evidence.ts';
import { TELEMETRY_FILES, type TelemetryFile } from '../intake/contract.ts';
import type { InvestigationResult } from '../investigation/result.ts';

/**
 * A relation the result contract does support between a finding and its evidence: a finding names
 * `components`, and cites records. This checks, for each component a finding names, whether some
 * record **that same finding cites** carries the component's name as a field value (a log's
 * `service`, a metric label, a span's service attribute, any string field). Records are read
 * again from the bundle, and a record counts only if its file still matches the checksum the run
 * recorded.
 *
 * What it is: a deterministic, descriptive count. What it is not: evidence that the records
 * support the finding, or that the component caused anything. A root cause that the records only
 * imply (a dependency named in no field) counts as "not found", and a component can appear in a
 * record that says nothing relevant. `semanticSupport` stays `not_assessed` everywhere; judging it
 * needs a reviewer and an approved rubric (docs/proposals/finding-assessment.md, proposed).
 */
export interface ComponentEvidence {
  /** Components named by findings, counted once per finding. */
  named: number;
  /** Of those, how many appear as a field value in a record the same finding cites. */
  identified: number;
  /** The rest, by finding id and component, in a stable order. */
  unidentified: { finding: string; component: string }[];
}

const isTelemetry = (f: string): f is TelemetryFile =>
  (TELEMETRY_FILES as readonly string[]).includes(f);

/** Every string value anywhere in a parsed record (keys are not values). */
function stringValues(value: unknown, into: Set<string>): Set<string> {
  if (typeof value === 'string') into.add(value);
  else if (Array.isArray(value)) for (const v of value) stringValues(v, into);
  else if (typeof value === 'object' && value !== null)
    for (const v of Object.values(value)) stringValues(v, into);
  return into;
}

function recordValues(file: Loaded, line: number): Set<string> {
  const text = file.lines[line - 1] ?? '';
  try {
    return text.trim() === '' ? new Set() : stringValues(JSON.parse(text), new Set());
  } catch {
    return new Set();
  }
}

export async function componentEvidence(
  bundleDir: string,
  result: InvestigationResult,
): Promise<ComponentEvidence | null> {
  const bundle = result.bundle;
  if (bundle === null) return null;
  const files = new Map<TelemetryFile, Loaded | null>();
  const out: ComponentEvidence = { named: 0, identified: 0, unidentified: [] };
  for (const finding of result.findings) {
    const values = new Set<string>();
    for (const ref of finding.evidence) {
      if (!isTelemetry(ref.file)) continue;
      if (!files.has(ref.file)) files.set(ref.file, await loadTelemetry(bundleDir, ref.file));
      const file = files.get(ref.file) ?? null;
      // A changed file says nothing about what the run saw.
      if (file === null || file.sha256 !== bundle.files[ref.file].sha256) continue;
      for (const v of recordValues(file, ref.line)) values.add(v);
    }
    for (const component of [...new Set(finding.components)].sort()) {
      out.named += 1;
      if (values.has(component)) out.identified += 1;
      else out.unidentified.push({ finding: finding.id, component });
    }
  }
  return out;
}
