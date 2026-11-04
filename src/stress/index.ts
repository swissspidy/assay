/** `@swissspidy/assay/stress`: stress-test check sets against valid variants and near-miss mutants. */
export { stressTest, formatStressReport } from './stress.ts';
export type {
  StressReport,
  StressOptions,
  StressReference,
  VariantResult,
  MutantResult,
  FindingRef,
} from './stress.ts';
export { GENERIC_VARIANTS, generateVariants, type Variant } from './variants.ts';
export { generateMutants, withSuccessClaim, type Mutant } from './mutants.ts';
export { mapA11y, editNodes, removeNodes, unwrapNodes } from '../snapshot/edit.ts';
