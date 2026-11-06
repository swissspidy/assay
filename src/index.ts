/**
 * `@swissspidy/assay`: verify task outcomes with compiled checks.
 *
 * Configuration: `defineConfig` and `loadConfig` for assay.config.ts, and
 * `resolveModel` for the three model forms (ADR 0017).
 *
 * Other entry points: `/checks` (the check builder, ADR 0019), `/playwright` (live pages), `/compiler`, `/stress`,
 * `/models` (agent loop, cassettes, Anthropic adapter), `/ai-sdk` (Vercel AI SDK
 * adapter) and `/eval` (baselines and metrics).
 */
export * from './types.ts';
export {
  verify,
  verifyMany,
  type EscalationPolicy,
  type VerifyOptions,
  type VerifyResult,
} from './verifier/escalate.ts';
export { evaluate, type EvaluateOptions } from './runtime/evaluate.ts';
export { loadSnapshot } from './snapshot/load.ts';
export { snapshotDigest, checkSetDigest } from './snapshot/digest.ts';
export { checkSetSchema } from './dsl/schema.ts';
export { validateCheckSet, assertValidCheckSet, CheckSetError, type ValidationReport } from './dsl/validate.ts';
export { formatOutcome } from './report.ts';
export {
  lockCheckSet,
  approveCheckSet,
  rejectCheckSet,
  unlockCheckSet,
  isLocked,
  verifyLock,
  assertLocked,
  reviewState,
  contentDigest,
  stressDigest,
  describeAssertion,
  describeChange,
  LockError,
  type ApproveOptions,
  type LockedCheckSet,
  type LockChange,
  type LockCheckOptions,
  type LockRequirement,
  type LockStatus,
  type ReviewState,
  type SignatureStatus,
} from './verifier/lock.ts';
export { generateSigningKey, keyId, type KeyInput, type SigningKeyPair, type TrustedKey } from './verifier/sign.ts';
export { reviewSheet, type ReviewSheetOptions } from './verifier/review.ts';
export {
  diffCheckSets,
  formatCheckSetDiff,
  evidenceRead,
  type CheckSetDiff,
  type CheckView,
  type RequirementView,
  type Changed,
} from './verifier/diff.ts';
export {
  writeOutcomeRecord,
  RECORD_SCHEMA,
  type OutcomeRecord,
  type RecordedRequirement,
  type RecordedObservation,
  type RecordInput,
  type WrittenRecord,
} from './verifier/record.ts';
export {
  runVerifier,
  type VerifierInput,
  type VerifierResult,
  type RequirementVerdict,
  type VerifierStatus,
  type Observation,
} from './verifier/verifier.ts';
export * from './model/types.ts';
export {
  defineConfig,
  loadConfig,
  findConfig,
  ConfigError,
  CONFIG_FILES,
  type AssayConfig,
  type BenchConfig,
  type BenchModelInput,
  type LoadedConfig,
} from './config/config.ts';
export {
  resolveModel,
  PROVIDERS,
  type ModelInput,
  type ModelOptions,
  type LanguageModelLike,
} from './model/resolve.ts';
