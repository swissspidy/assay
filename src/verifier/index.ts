export {
  runVerifier,
  citedEvidence,
  sameOrigin,
  type VerifierInput,
  type VerifierResult,
  type RequirementVerdict,
  type VerifierStatus,
  type Observation,
} from './verifier.ts';
export { verifyWithEscalation, type EscalationPolicy, type VerifyOptions, type VerifyResult } from './escalate.ts';
export {
  writeOutcomeRecord,
  newRecordId,
  RECORD_SCHEMA,
  type OutcomeRecord,
  type RecordedRequirement,
  type RecordedObservation,
  type WrittenRecord,
} from './record.ts';
export {
  lockCheckSet,
  isLocked,
  lockState,
  describeAssertion,
  reviewSheet,
  type Lock,
  type LockedCheckSet,
} from './lock.ts';
