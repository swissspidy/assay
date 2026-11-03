export { compileTask, rubricFromClauses, checkRubric, verifyCandidate, coverage } from './compile.ts';
export type {
  TaskInput,
  Reference,
  CompileOptions,
  CompileResult,
  CompileReport,
  RequirementCoverage,
} from './compile.ts';
export { parseOutcomes, type Clause } from './outcomes.ts';
