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

// E2: the investigation core (ADRs 0006 and 0007). Evaluation is exported separately, from
// `engineering-operations-ai/evaluation`, so investigation consumers never import scoring code.
export {
  DEFAULT_LIMITS,
  InvestigationConfigError,
  resolveLimits,
  type InvestigationLimits,
} from './investigation/config.ts';
export { FakeProvider, type FakeStep } from './investigation/fake-provider.ts';
export {
  FAILURE_CLASSES,
  sanitizeMessage,
  type Failure,
  type FailureClass,
} from './investigation/failures.ts';
export {
  createInvestigator,
  type Investigator,
  type InvestigatorOptions,
} from './investigation/investigate.ts';
export {
  ProviderError,
  TRANSIENT_KINDS,
  type ModelProvider,
  type ModelReply,
  type ModelRequest,
  type ProviderErrorKind,
  type UsageReport,
} from './investigation/provider.ts';
export { buildRequest, INSTRUCTIONS } from './investigation/request.ts';
export {
  FINDING_VERIFICATION,
  parseModelOutput,
  readInvestigationResult,
  resultSchemaProblems,
  type EvidenceReference,
  type FindingVerification,
  type InvestigationResult,
  type ModelOutput,
  type OutputProblem,
  type ResultProblem,
  type VerifiedFinding,
} from './investigation/result.ts';
export {
  ADMISSION_FAILURE_CLASSES,
  INVESTIGATION_RESULT_SCHEMA,
  MODEL_OUTPUT_SCHEMA,
  MODEL_OUTPUT_VERSION,
  RESULT_SCHEMA_VERSION,
} from './investigation/schemas.ts';
export {
  selectEvidence,
  type Selection,
  type SelectionSummary,
} from './investigation/selection.ts';
export { summarize, type InvestigationSummary } from './investigation/summary.ts';
export {
  EMPTY_TOKEN_USAGE,
  TokenLedger,
  type TokenUsageSnapshot,
  type UsageReportStatus,
} from './investigation/usage.ts';
export {
  shownKey,
  verifyEvidence,
  type ShownRecords,
  type VerificationCode,
  type VerificationIssue,
} from './investigation/verify.ts';
export { runInvestigation, type PipelineRun } from './pipeline/run-investigation.ts';
