/** The public interface of the intake module (ADR 0005). */
export {
  BUNDLE_FILES,
  ContractError,
  SUPPORTED_MAJOR_VERSIONS,
  TELEMETRY_FILES,
  type BundleFile,
  type TelemetryFile,
} from './intake/contract.ts';
export {
  EvidenceError,
  EXCLUDED_MANIFEST_FIELDS,
  investigatorManifest,
  openEvidence,
  type EvidenceFile,
  type EvidenceRecord,
  type EvidenceView,
  type InvestigatorManifest,
} from './intake/evidence.ts';
export { RULES, type RuleId, type RuleNumber, type ValidationIssue } from './intake/issues.ts';
export { validateRecord, type RecordKind } from './intake/records.ts';
export { validateBundle, type ValidationReport } from './intake/validate-bundle.ts';
