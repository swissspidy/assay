/**
 * Evaluation of check sets and assertions. The semantics live in the compiled plan
 * (`src/plan`, ADR 0015); this module keeps the entry points the rest of Assay uses.
 */
export {
  bindingSides,
  evaluateAssertion,
  kleeneAnd,
  kleeneOr,
  openPages,
  pageContext,
  readValue,
  type EvalCtx,
} from '../plan/assertions.ts';
export { evaluate, type EvaluateOptions } from '../plan/plan.ts';
