/**
 * A typed builder for `assay.checks/v1` (ADR 0019): small functions that return exactly the
 * JSON the DSL defines, so a check set can be written in TypeScript with autocomplete and
 * type checking. `checks(...)` returns a plain `CheckSet` object; nothing downstream knows
 * how it was written.
 *
 * ```ts
 * export default checks('Add a Blue Mug to my cart.', [
 *   req('R1', 'The cart contains a Blue Mug', { quote: 'Add a Blue Mug to my cart' })
 *     .check(probe('cart', '/items').like([{ name: 'Blue Mug' }]))
 *     .check(network.post('/api/cart').status(200)),
 * ]);
 * ```
 */
import {
  CHECKS_SCHEMA,
  type Assertion,
  type Check,
  type CheckSet,
  type Comparison,
  type Json,
  type JsonSchema,
  type Locator,
  type Lock,
  type Moment,
  type Money,
  type Normalizer,
  type NumberCompare,
  type Operand,
  type PageMatch,
  type Provenance,
  type Rejection,
  type Requirement,
  type RequestMatch,
  type SequenceStep,
  type StateExpect,
  type Target,
  type TextMatch,
  type Tolerance,
  type UrlMatch,
  type ValueSource,
} from '../types.ts';
import { canonical } from '../text.ts';
import { describeAssertion } from '../verifier/lock.ts';

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/** Something `.check()` takes: a builder, or a plain assertion object. */
export type AssertionInput = Assertion | AssertionBuilder;

/** An assertion made by the builder. `toJSON()` is the plain `assay.checks/v1` assertion. */
export class AssertionBuilder<A extends Assertion = Assertion> {
  readonly #assertion: A;
  constructor(assertion: A) {
    this.#assertion = assertion;
  }
  toJSON(): A {
    return this.#assertion;
  }
}

/** The plain assertion of a builder or an assertion object. */
export function toAssertion(a: AssertionInput): Assertion {
  return a instanceof AssertionBuilder || typeof (a as { toJSON?: unknown }).toJSON === 'function'
    ? (a as AssertionBuilder).toJSON()
    : (a as Assertion);
}

/** How many: a number is `{ eq: n }`. */
export type CountInput = number | NumberCompare;
const countOf = (c: CountInput): NumberCompare => (typeof c === 'number' ? { eq: c } : c);

/** A bound of an ordering comparison: a number, a date (`YYYY-MM-DD`), a date-time with offset, or money. */
export type Bound = number | string | Money;

/** A regular expression as the DSL stores it. */
function regexOf(r: RegExp | string, flags?: string): { regex: string; flags?: string } {
  // Explicit flags win over a RegExp's own (`''` too); otherwise the RegExp's flags are kept.
  if (r instanceof RegExp) {
    const f = flags ?? r.flags;
    return { regex: r.source, ...(flags !== undefined || f ? { flags: f } : {}) };
  }
  return { regex: r, ...(flags !== undefined ? { flags } : {}) };
}

/** A text match by regex: `re(/total: \d+/i)` is `{ regex: 'total: \\d+', flags: 'i' }`. */
export const re = (r: RegExp | string, flags?: string): TextMatch => regexOf(r, flags);
/** A text match that must equal `s` (canonical whitespace), optionally in any case. */
export const exact = (s: string, opts: { ignoreCase?: boolean } = {}): TextMatch => ({
  equals: s,
  ...(opts.ignoreCase !== undefined ? { ignoreCase: opts.ignoreCase } : {}),
});
/** A text match that must contain `s`, optionally in any case. */
export const includes = (s: string, opts: { ignoreCase?: boolean } = {}): TextMatch => ({
  contains: s,
  ...(opts.ignoreCase !== undefined ? { ignoreCase: opts.ignoreCase } : {}),
});

/** A target found by several anchors that must agree (ADR 0001). */
export const anchors = (...locators: Locator[]): Target => ({ anchors: locators });

/** A value read from the evidence, normalized step by step, then compared. */
export class Value {
  readonly source: ValueSource;
  readonly steps: Normalizer[] | undefined;
  constructor(source: ValueSource, steps?: Normalizer[]) {
    this.source = source;
    this.steps = steps;
  }
  /** Add normalizer steps: `'trim'`, `norm.number('en-US')`, … */
  normalize(...steps: Normalizer[]): Value {
    return new Value(this.source, [...(this.steps ?? []), ...steps]);
  }
  /** This value as the other side of a `sameAs` binding. */
  toOperand(): Operand {
    return { source: this.source, ...(this.steps ? { normalize: this.steps } : {}) };
  }
  /** Compare with any comparison of the DSL. */
  compare(expect: Comparison): AssertionBuilder<Extract<Assertion, { kind: 'value' }>> {
    return new AssertionBuilder({
      kind: 'value',
      source: this.source,
      ...(this.steps ? { normalize: this.steps } : {}),
      expect,
    });
  }
  equals(value: Json) {
    return this.compare({ equals: value });
  }
  oneOf(values: Json[]) {
    return this.compare({ oneOf: values });
  }
  contains(substring: string, opts: { ignoreCase?: boolean } = {}) {
    return this.compare({
      contains: substring,
      ...(opts.ignoreCase !== undefined ? { ignoreCase: opts.ignoreCase } : {}),
    });
  }
  /** A regex match: `.matches(/^#\d+$/)`. */
  matches(pattern: RegExp | string, flags?: string) {
    return this.compare(regexOf(pattern, flags));
  }
  approx(value: Bound, tolerance: { abs?: number; rel?: number }) {
    return this.compare({ approx: { value, ...tolerance } });
  }
  gt(bound: Bound) {
    return this.compare({ gt: bound });
  }
  gte(bound: Bound) {
    return this.compare({ gte: bound });
  }
  lt(bound: Bound) {
    return this.compare({ lt: bound });
  }
  lte(bound: Bound) {
    return this.compare({ lte: bound });
  }
  /** Several bounds at once: `.range({ gte: 1, lt: 10 })`. */
  range(bounds: { gt?: Bound; gte?: Bound; lt?: Bound; lte?: Bound }) {
    return this.compare(bounds);
  }
  /** The value must match this JSON Schema. */
  schema(schema: JsonSchema) {
    return this.compare({ schema });
  }
  /** The value must have this shape (see `like`): `.like([{ name: 'Blue Mug' }])`. */
  like(shape: LikeShape) {
    return this.compare({ schema: like(shape) });
  }
  /** The value must be there (any value). */
  exists() {
    return this.compare({ exists: true });
  }
  /** Equal to another value read from the evidence, within an explicit tolerance if given (ADR 0014). */
  sameAs(other: Value, opts: { tolerance?: Tolerance } = {}) {
    return this.compare({ sameAs: { ...other.toOperand(), ...(opts.tolerance ? { tolerance: opts.tolerance } : {}) } });
  }
}

/** A value from any source of the DSL. */
export const value = (source: ValueSource): Value => new Value(source);

type StateAssertion = AssertionBuilder<Extract<Assertion, { kind: 'state' }>>;

/** One node of the accessibility tree (or the node several anchors agree on). */
export class NodeRef {
  readonly target: Target;
  constructor(target: Target) {
    this.target = target;
  }
  /** Its text content. */
  text(): Value {
    return new Value({ from: 'node', target: this.target, field: 'text' });
  }
  /** Its accessible name. */
  name(): Value {
    return new Value({ from: 'node', target: this.target, field: 'name' });
  }
  /** Its value (a form field's). */
  value(): Value {
    return new Value({ from: 'node', target: this.target, field: 'value' });
  }
  /** A link's target. */
  url(): Value {
    return new Value({ from: 'node', target: this.target, field: 'url' });
  }
  /** Its states and properties: `.state({ checked: true, name: 'Newsletter' })`. */
  state(expect: StateExpect): StateAssertion {
    return new AssertionBuilder({ kind: 'state', target: this.target, expect });
  }
  checked(v: boolean | 'mixed' = true) {
    return this.state({ checked: v });
  }
  pressed(v: boolean | 'mixed' = true) {
    return this.state({ pressed: v });
  }
  selected(v = true) {
    return this.state({ selected: v });
  }
  expanded(v = true) {
    return this.state({ expanded: v });
  }
  disabled(v = true) {
    return this.state({ disabled: v });
  }
  hasText(m: TextMatch) {
    return this.state({ text: m });
  }
  hasName(m: TextMatch) {
    return this.state({ name: m });
  }
  hasValue(m: TextMatch) {
    return this.state({ value: m });
  }
  hasLevel(level: number) {
    return this.state({ level });
  }
  /** Inside this node: nodes matching `match` (at least one, or `count`). */
  contains(match: Locator, opts: { witness?: Locator; count?: CountInput } = {}) {
    return contains(match, { ...opts, scope: this.target });
  }
  /** Inside this node: every node matching `match` is a record, and `assert` holds inside each (ADR 0008). */
  each(match: Locator, assert: AssertionInput, opts: { witness?: Locator; count?: CountInput } = {}) {
    return each(match, assert, { ...opts, scope: this.target });
  }
}

/**
 * A node: `node({ role: 'status' })`, `node('button', 'Save')` (role and name), or
 * `node(anchors(a, b))`.
 */
export function node(target: Target): NodeRef;
export function node(role: string, name?: TextMatch): NodeRef;
export function node(target: Target | string, name?: TextMatch): NodeRef {
  return new NodeRef(typeof target === 'string' ? { role: target, ...(name !== undefined ? { name } : {}) } : target);
}

/** Nodes matching `match`, in `scope` (default: the page or the record), at least one or `count`. */
export function contains(
  match: Locator,
  opts: { scope?: Target; witness?: Locator; count?: CountInput } = {},
): AssertionBuilder<Extract<Assertion, { kind: 'contains' }>> {
  return new AssertionBuilder({
    kind: 'contains',
    ...(opts.scope ? { scope: opts.scope } : {}),
    ...(opts.witness ? { witness: opts.witness } : {}),
    match,
    ...(opts.count !== undefined ? { count: countOf(opts.count) } : {}),
  });
}

/** Per record: every node matching `match` in `scope` is a record, and `assert` holds inside each (ADR 0008). */
export function each(
  match: Locator,
  assert: AssertionInput,
  opts: { scope?: Target; witness?: Locator; count?: CountInput } = {},
): AssertionBuilder<Extract<Assertion, { kind: 'each' }>> {
  return new AssertionBuilder({
    kind: 'each',
    ...(opts.scope ? { scope: opts.scope } : {}),
    ...(opts.witness ? { witness: opts.witness } : {}),
    match,
    ...(opts.count !== undefined ? { count: countOf(opts.count) } : {}),
    assert: toAssertion(assert),
  });
}

/** `assert` on the one open page (tab, popup) that `match` selects (ADR 0012). */
export function page(match: PageMatch, assert: AssertionInput): AssertionBuilder<Extract<Assertion, { kind: 'page' }>> {
  return new AssertionBuilder({ kind: 'page', match, assert: toAssertion(assert) });
}

/** Every assertion holds. */
export function allOf(...of: AssertionInput[]): AssertionBuilder<Extract<Assertion, { kind: 'allOf' }>> {
  return new AssertionBuilder({ kind: 'allOf', of: of.map(toAssertion) });
}

/** At least one assertion holds (e.g. one per way of doing the task). */
export function anyOf(...of: AssertionInput[]): AssertionBuilder<Extract<Assertion, { kind: 'anyOf' }>> {
  return new AssertionBuilder({ kind: 'anyOf', of: of.map(toAssertion) });
}

/** A regex over the page text (or the text in `scope`): `text(/Order #(\d+)/, { group: 1 })`. */
export function text(
  pattern: RegExp | string,
  opts: { scope?: Target; flags?: string; group?: number | string } = {},
): Value {
  const { regex, flags } = regexOf(pattern, opts.flags);
  return new Value({
    from: 'text',
    ...(opts.scope ? { scope: opts.scope } : {}),
    pattern: regex,
    ...(flags !== undefined ? { flags } : {}),
    ...(opts.group !== undefined ? { group: opts.group } : {}),
  });
}

type UrlPart = 'href' | 'origin' | 'pathname' | 'search' | 'hash';

/** The page URL matches: `url('/cart')` (a path pattern) or `url({ path: '/search', query: { q: 'mug' } })`. */
function urlAssertion(match: UrlMatch | string): AssertionBuilder<Extract<Assertion, { kind: 'url' }>> {
  return new AssertionBuilder({ kind: 'url', match: typeof match === 'string' ? { path: match } : match });
}

/** The page URL: `url('/cart')` asserts it; `url.part('pathname')` and `url.param('q')` read it. */
export const url = Object.assign(urlAssertion, {
  part: (part: UrlPart): Value => new Value({ from: 'url', part }),
  param: (param: string): Value => new Value({ from: 'url', part: { param } }),
});

/** The value of a probe the capture ran: `probe('cart', '/items')` or `probe('cart', { at: 'before' })`. */
export function probe(name: string, pointer?: string | { pointer?: string; at?: Moment }): Value {
  const o = typeof pointer === 'string' ? { pointer } : (pointer ?? {});
  return new Value({
    from: 'probe',
    probe: name,
    ...(o.pointer !== undefined ? { pointer: o.pointer } : {}),
    ...(o.at !== undefined ? { at: o.at } : {}),
  });
}

type StorageOptions = { origin?: string; at?: Moment };
const storageValue =
  (area: 'cookie' | 'local' | 'session') =>
  (key: string, opts: StorageOptions = {}): Value =>
    new Value({
      from: 'storage',
      area,
      key,
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts.at !== undefined ? { at: opts.at } : {}),
    });

/** Cookies and web storage: `storage.local('theme')`, `storage.cookie('consent', { at: 'before' })`. */
export const storage = {
  cookie: storageValue('cookie'),
  local: storageValue('local'),
  session: storageValue('session'),
};

type Pick = 'only' | 'first' | 'last';
type BodyRead = string | { pointer?: string; pick?: Pick };

/** Requests matching a pattern: an assertion (at least one, or `count`) and a source of values. */
export class RequestRef extends AssertionBuilder<Extract<Assertion, { kind: 'request' }>> {
  readonly match: RequestMatch;
  readonly #count: NumberCompare | undefined;
  constructor(match: RequestMatch, count?: NumberCompare) {
    // The DSL's key order: method, url, status, requestBody, responseBody.
    const m: RequestMatch = {
      ...(match.method !== undefined ? { method: match.method } : {}),
      ...(match.url !== undefined ? { url: match.url } : {}),
      ...(match.status !== undefined ? { status: match.status } : {}),
      ...(match.requestBody !== undefined ? { requestBody: match.requestBody } : {}),
      ...(match.responseBody !== undefined ? { responseBody: match.responseBody } : {}),
    };
    super({ kind: 'request', match: m, ...(count ? { count } : {}) });
    this.match = m;
    this.#count = count;
  }
  /** The response status: `200` or `{ gte: 200, lt: 300 }`. */
  status(status: number | NumberCompare): RequestRef {
    return new RequestRef({ ...this.match, status }, this.#count);
  }
  /** The request body must match this JSON Schema (`like(...)` makes one from a shape). */
  requestBody(schema: JsonSchema): RequestRef {
    return new RequestRef({ ...this.match, requestBody: schema }, this.#count);
  }
  /** The response body must match this JSON Schema (`like(...)` makes one from a shape). */
  responseBody(schema: JsonSchema): RequestRef {
    return new RequestRef({ ...this.match, responseBody: schema }, this.#count);
  }
  /** How many requests must match (default: at least one). */
  count(count: CountInput): RequestRef {
    return new RequestRef(this.match, countOf(count));
  }
  /** A value from the matching request's body: `.request('/qty')`, `.request({ pointer, pick: 'last' })`. */
  request(read?: BodyRead): Value {
    return this.#read('request', read);
  }
  /** A value from the matching response's body. */
  response(read?: BodyRead): Value {
    return this.#read('response', read);
  }
  #read(from: 'request' | 'response', read: BodyRead | undefined): Value {
    const o = typeof read === 'string' ? { pointer: read } : (read ?? {});
    return new Value({
      from,
      match: this.match,
      ...(o.pointer !== undefined ? { pointer: o.pointer } : {}),
      ...(o.pick !== undefined ? { pick: o.pick } : {}),
    });
  }
}

const urlMatchOf = (u: string | UrlMatch): UrlMatch => (typeof u === 'string' ? { path: u } : u);
const byMethod =
  (method: string) =>
  (u: string | UrlMatch, rest: Omit<RequestMatch, 'method' | 'url'> = {}): RequestRef =>
    new RequestRef({ method, url: urlMatchOf(u), ...rest });

/** The network log: `network.post('/api/cart')`, `network.request({ method: ['PUT', 'PATCH'], url: … })`. */
export const network = {
  request: (match: RequestMatch = {}): RequestRef => new RequestRef(match),
  get: byMethod('GET'),
  post: byMethod('POST'),
  put: byMethod('PUT'),
  patch: byMethod('PATCH'),
  delete: byMethod('DELETE'),
};

/** A step of a sequence: a request (`network.post('/api/verify')`), a navigation (`url('/confirm')`), or a plain step. */
export type StepInput = RequestRef | AssertionBuilder<Extract<Assertion, { kind: 'url' }>> | SequenceStep;

function stepOf(s: StepInput): SequenceStep {
  if (!(s instanceof AssertionBuilder)) return s;
  const a = s.toJSON();
  if (a.kind === 'request') {
    if (a.count) throw new Error('a sequence step is a request, not a number of requests: drop .count()');
    return { request: a.match };
  }
  return { url: a.match };
}

/** Steps in order (ADR 0024): `sequence(network.post('/api/verify'), network.post('/api/refill'))`. */
export class SequenceRef extends AssertionBuilder<Extract<Assertion, { kind: 'sequence' }>> {
  readonly steps: SequenceStep[];
  constructor(steps: SequenceStep[], strict?: boolean) {
    super({ kind: 'sequence', steps, ...(strict !== undefined ? { strict } : {}) });
    this.steps = steps;
  }
  /** The steps also do not interleave: no event of a step after the next step began. */
  strict(strict = true): SequenceRef {
    return new SequenceRef(this.steps, strict);
  }
}

/** The steps happen in this order in the run's trajectory (ADR 0024). */
export const sequence = (...steps: StepInput[]): SequenceRef => new SequenceRef(steps.map(stepOf));

/** Normalizers that take arguments; the simple ones are strings (`'trim'`, `'lowercase'`, …). */
export const norm = {
  number: (locale: string): Normalizer => ({ op: 'number', locale }),
  currency: (locale: string, currency?: string): Normalizer => ({
    op: 'currency',
    locale,
    ...(currency !== undefined ? { currency } : {}),
  }),
  date: (locale: string, timezone?: string): Normalizer => ({
    op: 'date',
    locale,
    ...(timezone !== undefined ? { timezone } : {}),
  }),
  datetime: (locale: string, timezone?: string): Normalizer => ({
    op: 'datetime',
    locale,
    ...(timezone !== undefined ? { timezone } : {}),
  }),
  extract: (regex: RegExp | string, opts: { flags?: string; group?: number | string } = {}): Normalizer => ({
    op: 'extract',
    ...regexOf(regex, opts.flags),
    ...(opts.group !== undefined ? { group: opts.group } : {}),
  }),
  replace: (regex: RegExp | string, replacement: string, flags?: string): Normalizer => ({
    op: 'replace',
    ...regexOf(regex, flags),
    with: replacement,
  }),
  /** A JSON array as an unordered collection (ADR 0011). */
  items: (opts: { where?: JsonSchema; pointer?: string; pick?: string[]; flatten?: boolean } = {}): Normalizer => ({
    op: 'items',
    ...(opts.where !== undefined ? { where: opts.where } : {}),
    ...(opts.pointer !== undefined ? { pointer: opts.pointer } : {}),
    ...(opts.pick !== undefined ? { pick: opts.pick } : {}),
    ...(opts.flatten !== undefined ? { flatten: opts.flatten } : {}),
  }),
};

// ---------------------------------------------------------------------------
// like(): a JSON Schema from an example shape
// ---------------------------------------------------------------------------

const SCHEMA = Symbol.for('assay.like.schema');

/** A JSON Schema used as it is inside a `like` shape (see `matching`). */
export interface SchemaInShape {
  readonly [SCHEMA]: JsonSchema;
}

/** An example shape for `like`: plain JSON, with `matching(schema)` where any value of a schema will do. */
export type LikeShape = null | boolean | number | string | SchemaInShape | LikeShape[] | { [key: string]: LikeShape };

/** Inside a `like` shape: any value this JSON Schema accepts. `like({ id: matching({ type: 'string' }) })`. */
export const matching = (schema: JsonSchema): SchemaInShape => ({ [SCHEMA]: schema });

/**
 * A JSON Schema from an example shape: an object must have these keys (others are allowed), an
 * array must contain an item like each element (in any order, among others), anything else must
 * equal the value. `like({ items: [{ color: 'blue' }] })`.
 */
export function like(shape: LikeShape): JsonSchema {
  if (shape === null || typeof shape !== 'object') return { const: shape };
  if (SCHEMA in shape) return (shape as SchemaInShape)[SCHEMA];
  if (Array.isArray(shape)) {
    if (shape.length === 0) return { type: 'array' };
    if (shape.length === 1) return { type: 'array', contains: like(shape[0]!) as Json };
    return { type: 'array', allOf: shape.map((s) => ({ contains: like(s) as Json })) };
  }
  const keys = Object.keys(shape);
  if (!keys.length) return { type: 'object' };
  return {
    type: 'object',
    required: keys,
    properties: Object.fromEntries(keys.map((k) => [k, like(shape[k]!) as Json])),
  };
}

// ---------------------------------------------------------------------------
// Requirements, checks and the set
// ---------------------------------------------------------------------------

export interface CheckOptions {
  /** Default: `C<n>`, numbered across the set in order. */
  id?: string;
  /** What the check means, for reviewers. Default: a plain-language rendering of the assertion. */
  description?: string;
  onFail?: Check['onFail'];
  onMissing?: Check['onMissing'];
}

export interface RequirementOptions {
  /** Default `'hard'`. */
  kind?: Requirement['kind'];
  /** The words of the task this requirement comes from. Default: the requirement text. */
  quote?: string;
  /** Which task field `quote` is in. Default: the instruction if it holds the quote, else the outcomes. */
  field?: Requirement['source']['field'];
}

interface CheckEntry {
  requirement: string;
  assert: Assertion;
  options: CheckOptions;
}

/** A check that names its requirement, for sets whose checks are not grouped by requirement. */
export class StandaloneCheck {
  readonly entry: CheckEntry;
  constructor(entry: CheckEntry) {
    this.entry = entry;
  }
}

/** A requirement and its checks; `.check()` returns a new requirement with the check added. */
export class RequirementBuilder {
  readonly id: string;
  readonly text: string;
  readonly options: RequirementOptions;
  readonly entries: readonly CheckEntry[];
  constructor(id: string, statement: string, options: RequirementOptions = {}, entries: readonly CheckEntry[] = []) {
    this.id = id;
    this.text = statement;
    this.options = options;
    this.entries = entries;
  }
  /** Add a check: `.check(assertion)`, `.check('What it means', assertion, { onMissing: 'abstain' })`. */
  check(assertion: AssertionInput, options?: CheckOptions): RequirementBuilder;
  check(description: string, assertion: AssertionInput, options?: CheckOptions): RequirementBuilder;
  check(a: string | AssertionInput, b?: AssertionInput | CheckOptions, c?: CheckOptions): RequirementBuilder {
    const entry = checkEntry(this.id, a, b, c);
    return new RequirementBuilder(this.id, this.text, this.options, [...this.entries, entry]);
  }
}

function checkEntry(
  requirement: string,
  a: string | AssertionInput,
  b: AssertionInput | CheckOptions | undefined,
  c: CheckOptions | undefined,
): CheckEntry {
  if (typeof a === 'string') {
    return { requirement, assert: toAssertion(b as AssertionInput), options: { ...c, description: a } };
  }
  return { requirement, assert: toAssertion(a), options: { ...(b as CheckOptions | undefined) } };
}

/** A requirement: `req('R1', 'The cart has a Blue Mug', { quote: 'Add a Blue Mug' })`. */
export const req = (id: string, statement: string, options: RequirementOptions = {}): RequirementBuilder =>
  new RequirementBuilder(id, statement, options);

/** A check outside a requirement's chain: `check('R2', 'Order placed', network.post('/api/orders'))`. */
export function check(
  requirement: string | RequirementBuilder,
  assertion: AssertionInput,
  options?: CheckOptions,
): StandaloneCheck;
export function check(
  requirement: string | RequirementBuilder,
  description: string,
  assertion: AssertionInput,
  options?: CheckOptions,
): StandaloneCheck;
export function check(
  requirement: string | RequirementBuilder,
  a: string | AssertionInput,
  b?: AssertionInput | CheckOptions,
  c?: CheckOptions,
): StandaloneCheck {
  return new StandaloneCheck(checkEntry(typeof requirement === 'string' ? requirement : requirement.id, a, b, c));
}

/** The task and the set's identity (and, for a set that was compiled or reviewed, its provenance and review). */
export interface CheckSetSpec {
  /** Default: the instruction as a slug. */
  id?: string;
  /** Default `'1'`. */
  version?: string;
  instruction: string;
  outcomes?: string;
  compiled?: Provenance;
  locked?: Lock;
  rejected?: Rejection;
}

/** The task field a requirement's quote comes from, when not given: the instruction first. */
export function quoteField(task: CheckSet['task'], quote: string): Requirement['source']['field'] {
  const q = canonical(quote);
  if (canonical(task.instruction).includes(q)) return 'instruction';
  if (task.outcomes !== undefined && canonical(task.outcomes).includes(q)) return 'outcomes';
  return 'instruction';
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '') || 'task';

/** A plain deep copy: builders become their JSON, undefined properties disappear. */
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/**
 * A check set: the task (its instruction, or `{ id, version, instruction, outcomes }`) and its
 * requirements with their checks. Returns the plain `assay.checks/v1` object; check it with
 * `validateCheckSet` or `assay validate`.
 */
export function checks(
  task: string | CheckSetSpec,
  items: readonly (RequirementBuilder | StandaloneCheck)[],
  meta: Omit<CheckSetSpec, 'instruction' | 'outcomes'> = {},
): CheckSet {
  const spec: CheckSetSpec = typeof task === 'string' ? { ...meta, instruction: task } : { ...meta, ...task };
  const t: CheckSet['task'] = {
    instruction: spec.instruction,
    ...(spec.outcomes !== undefined ? { outcomes: spec.outcomes } : {}),
  };
  const requirements: Requirement[] = [];
  const entries: CheckEntry[] = [];
  for (const item of items) {
    if (item instanceof StandaloneCheck) {
      entries.push(item.entry);
      continue;
    }
    const quote = item.options.quote ?? item.text;
    requirements.push({
      id: item.id,
      kind: item.options.kind ?? 'hard',
      text: item.text,
      source: { field: item.options.field ?? quoteField(t, quote), quote },
    });
    entries.push(...item.entries);
  }
  const list: Check[] = entries.map((e, i) => ({
    id: e.options.id ?? `C${i + 1}`,
    requirement: e.requirement,
    description: e.options.description ?? describeAssertion(e.assert),
    assert: e.assert,
    ...(e.options.onFail !== undefined ? { onFail: e.options.onFail } : {}),
    ...(e.options.onMissing !== undefined ? { onMissing: e.options.onMissing } : {}),
  }));
  return plain({
    schema: CHECKS_SCHEMA,
    id: spec.id ?? slug(spec.instruction),
    version: spec.version ?? '1',
    task: t,
    requirements,
    checks: list,
    ...(spec.compiled ? { compiled: spec.compiled } : {}),
    ...(spec.locked ? { locked: spec.locked } : {}),
    ...(spec.rejected ? { rejected: spec.rejected } : {}),
  });
}

/** The default description of a check with this assertion. */
export const defaultDescription = (a: AssertionInput): string => describeAssertion(toAssertion(a));
