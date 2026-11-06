/** `@swissspidy/assay/compiler`: compile a task and reference runs into a check set. */
export {
  compileTask,
  rubricFromClauses,
  checkRubric,
  coversClause,
  verifyCandidate,
  coverage,
  assertionTrust,
} from './compile.ts';
export {
  generateCandidates,
  mineCandidates,
  rankCandidates,
  selectMined,
  Quote,
  type Candidate,
  type CandidateFamily,
  type CandidateResult,
  type DiscoveryStrategy,
  type MineResult,
  type MinedRequirement,
} from './mine.ts';
export type {
  MiningReport,
  TaskInput,
  Reference,
  CompileOptions,
  CompileResult,
  CompileReport,
  RequirementCoverage,
} from './compile.ts';
export { parseOutcomes, parseOutcomesDetailed, type Clause, type ParsedOutcomes } from './outcomes.ts';
