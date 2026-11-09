/**
 * `@swissspidy/assay/checks`: write check sets in TypeScript (ADR 0019).
 *
 * ```ts
 * import { checks, req, network, node, like } from '@swissspidy/assay/checks';
 *
 * export default checks('Add a blue mug to the cart', [
 *   req('R1', 'The cart has a blue mug', { quote: 'blue mug' })
 *     .check(network.post('/api/cart').responseBody(like({ items: [{ color: 'blue' }] })))
 *     .check(node({ role: 'status' }).text().contains('Added')),
 * ]);
 * ```
 *
 * The builder returns the plain `assay.checks/v1` object, so a `*.checks.ts` file works
 * wherever a `*.checks.json` does. `printCheckSet` writes builder code for an existing set.
 */
export {
  allOf,
  anchors,
  anyOf,
  AssertionBuilder,
  check,
  checks,
  contains,
  defaultDescription,
  each,
  exact,
  includes,
  like,
  matching,
  network,
  node,
  NodeRef,
  norm,
  page,
  probe,
  re,
  req,
  RequestRef,
  RequirementBuilder,
  sequence,
  SequenceRef,
  StandaloneCheck,
  storage,
  text,
  toAssertion,
  url,
  Value,
  value,
  type AssertionInput,
  type Bound,
  type CheckOptions,
  type CheckSetSpec,
  type CountInput,
  type LikeShape,
  type RequirementOptions,
  type SchemaInShape,
  type StepInput,
} from './builder.ts';
export { printCheckSet, type PrintOptions } from './print.ts';
export { loadCheckSetFile, CheckSetFileError } from './load.ts';
