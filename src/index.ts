/**
 * `@swissspidy/assay`: verify task outcomes with compiled checks.
 *
 * Other entry points: `/playwright` (live pages), `/compiler`, `/stress`,
 * `/models` (agent loop, cassettes, Anthropic adapter), `/ai-sdk` (Vercel AI SDK
 * adapter) and `/eval` (baselines and metrics).
 */
export * from './types.ts';
export { verify, type EscalationPolicy, type VerifyOptions, type VerifyResult } from './verifier/escalate.ts';
export { evaluate, type EvaluateOptions } from './runtime/evaluate.ts';
export { loadSnapshot } from './snapshot/load.ts';
export { snapshotDigest, checkSetDigest } from './snapshot/digest.ts';
export { checkSetSchema } from './dsl/schema.ts';
export { validateCheckSet, assertValidCheckSet, CheckSetError, type ValidationReport } from './dsl/validate.ts';
export { formatOutcome } from './report.ts';
export {
  lockCheckSet,
  isLocked,
  describeAssertion,
  reviewSheet,
  type Lock,
  type LockedCheckSet,
} from './verifier/lock.ts';
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
