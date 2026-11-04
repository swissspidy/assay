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
export type {
  TaskInput,
  Reference,
  CompileOptions,
  CompileResult,
  CompileReport,
  RequirementCoverage,
} from './compile.ts';
export { parseOutcomes, parseOutcomesDetailed, type Clause, type ParsedOutcomes } from './outcomes.ts';
