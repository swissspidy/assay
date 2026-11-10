import { Ajv } from 'ajv';
import { schemaAjv } from '../runtime/json.ts';
import type {
  Assertion,
  CheckSet,
  Comparison,
  Json,
  Locator,
  Normalizer,
  NumberCompare,
  RequestMatch,
  Target,
  TextMatch,
  Tolerance,
  UrlMatch,
  ValueSource,
} from '../types.ts';
import { textSourceChannel } from '../types.ts';
import { canonical } from '../text.ts';
import { canonicalJson } from '../snapshot/digest.ts';
import { instantOf } from '../runtime/values.ts';
import { compareNumber } from '../runtime/compare.ts';
import { MAX_TOLERANCE, checkSetSchema } from './schema.ts';

const ajv = new Ajv({ allErrors: true, strict: false });
const validateShape = ajv.compile(checkSetSchema);
let schemaCompiler = schemaAjv();
let compiledHere = 0;
const SCHEMA_LIMIT = 1_000;

export interface ValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export class CheckSetError extends Error {
  readonly report: ValidationReport;
  constructor(report: ValidationReport) {
    super(`Invalid check set:\n  - ${report.errors.join('\n  - ')}`);
    this.report = report;
  }
}

type VType = 'string' | 'number' | 'money' | 'date' | 'datetime' | 'boolean' | 'unknown';

export function validateCheckSet(input: unknown): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  // A check set built in code can contain itself; JSON cannot, and every walk below would overflow.
  const cycle = cycleAt(input);
  if (cycle !== undefined) return { ok: false, errors: [`${cycle} contains itself (a cycle)`], warnings };
  if (!validateShape(input)) {
    for (const e of validateShape.errors ?? [])
      errors.push(
        `${e.instancePath || '/'} ${e.message}${e.params && 'allowedValues' in e.params ? ` (${(e.params.allowedValues as unknown[]).join(', ')})` : ''}`,
      );
    return { ok: false, errors: dedupe(errors), warnings };
  }
  const cs = input as unknown as CheckSet;
  if (cs.locked && cs.rejected) errors.push('a check set cannot be both locked and rejected');

  const reqIds = new Set<string>();
  for (const r of cs.requirements) {
    if (reqIds.has(r.id)) errors.push(`duplicate requirement id ${r.id}`);
    reqIds.add(r.id);
    const sourceText = r.source.field === 'instruction' ? cs.task.instruction : cs.task.outcomes;
    if (!canonical(r.source.quote)) errors.push(`requirement ${r.id}: quote is blank`);
    else if (sourceText === undefined) errors.push(`requirement ${r.id}: source field "${r.source.field}" is empty`);
    else if (!canonical(sourceText).includes(canonical(r.source.quote)))
      errors.push(
        `requirement ${r.id}: quote ${JSON.stringify(r.source.quote)} does not appear in task.${r.source.field}`,
      );
  }
  if (!cs.requirements.some((r) => r.kind === 'hard')) errors.push('at least one requirement must be hard');

  const checkIds = new Set<string>();
  const covered = new Set<string>();
  for (const c of cs.checks) {
    const at = `check ${c.id}`;
    if (checkIds.has(c.id)) errors.push(`duplicate check id ${c.id}`);
    checkIds.add(c.id);
    if (!reqIds.has(c.requirement)) errors.push(`${at}: unknown requirement ${c.requirement}`);
    covered.add(c.requirement);
    walkAssertion(c.assert, at, errors, warnings, false);
    if (c.onMissing === 'abstain' && !readsRoute(c.assert))
      warnings.push(
        `${at}: onMissing "abstain" has no effect: it applies to request and url assertions and to values read from requests or responses, and this check has none`,
      );
  }
  for (const r of cs.requirements) {
    // Route evidence marked onMissing "abstain" is meant to abstain when the run went another way.
    const mine = cs.checks.filter((c) => c.requirement === r.id && c.onMissing !== 'abstain').map((c) => c.assert);
    const readsNetwork = mine.some(readsNetworkValue);
    const assertsExistence = cs.checks
      .filter((c) => c.requirement === r.id)
      .some((c) => assertsPresence(c.assert, c.onMissing === 'abstain'));
    if (readsNetwork && !assertsExistence)
      warnings.push(
        `requirement ${r.id}: its value checks abstain when no request matches; add a "request" check so a missing request fails`,
      );
  }
  for (const r of cs.requirements)
    if (!covered.has(r.id)) warnings.push(`requirement ${r.id} has no checks (it will abstain as "uncovered")`);
  warnings.push(...looseMatches(cs));

  return { ok: errors.length === 0, errors: dedupe(errors), warnings: dedupe(warnings) };
}

/**
 * Comparisons that accept more than they appear to: an unanchored literal regex
 * on structured evidence (/Berlin/ also matches "Europe/Berlin-Test"), a JSON
 * Schema property pinned with const or enum that is not required (a body without
 * the property passes), and one requirement comparing two collections field by
 * field (sorted separately, the fields of different records pair up).
 * `validateCheckSet` reports them as warnings; the compiler refuses them, since a
 * warning on an accepted submission is never acted on. Expects a check set that
 * passed the shape validation.
 */
export function looseMatches(cs: CheckSet): string[] {
  const out: string[] = [];
  for (const c of cs.checks) looseAssertion(c.assert, `check ${c.id}`, out);
  fieldwiseCollections(cs, out);
  return dedupe(out);
}

/** A pattern with no regex syntax other than escaped punctuation: it matches one literal string, anywhere. */
export function isLiteralPattern(pattern: string): boolean {
  return pattern !== '' && !/[\\^$.*+?()[\]{}|]/.test(pattern.replace(/\\[^A-Za-z0-9]/g, ''));
}

const literalRegexAdvice = (pattern: string, at: string, exact = 'equals or an anchored regex (^…$)') =>
  `${at}: regex /${pattern}/ has no anchors, so it also matches any value that merely contains it; compare an exact value (an identifier, a setting, a status) with ${exact}, or use contains when extra text is allowed`;

function looseTextMatch(m: TextMatch | null | undefined, at: string, out: string[]): void {
  if (m && typeof m === 'object' && 'regex' in m && isLiteralPattern(m.regex))
    out.push(literalRegexAdvice(m.regex, at));
}

/** A URL match's href regex and its query matchers (url assertions and request matches). */
function looseUrlMatch(m: UrlMatch | undefined, at: string, out: string[]): void {
  if (!m) return;
  if (m.regex !== undefined && isLiteralPattern(m.regex))
    out.push(literalRegexAdvice(m.regex, `${at} url`, 'a path pattern, or a regex anchored to the part it means'));
  for (const [name, v] of Object.entries(m.query ?? {})) looseTextMatch(v, `${at} query ${name}`, out);
}

function looseRequestMatch(m: RequestMatch, at: string, out: string[]): void {
  looseUrlMatch(m.url, at, out);
  if (m.requestBody !== undefined) looseSchema(m.requestBody, `${at} requestBody`, out);
  if (m.responseBody !== undefined) looseSchema(m.responseBody, `${at} responseBody`, out);
}

function looseOperand(src: ValueSource, normalize: Normalizer[] | undefined, at: string, out: string[]): void {
  if (src.from === 'request' || src.from === 'response') looseRequestMatch(src.match, at, out);
  for (const n of normalize ?? [])
    if (typeof n === 'object' && n.op === 'items' && n.where !== undefined)
      looseSchema(n.where, `${at} items where`, out);
}

/** Some `items` step in the pipeline projects with `pick`. */
export const usesPick = (steps: Normalizer[] | undefined): boolean =>
  (steps ?? []).some((s) => typeof s === 'object' && s.op === 'items' && s.pick !== undefined);

/** The same probe value or storage key, read at two moments: its items always have the same shape. */
export function sameCollection(x: ValueSource, y: ValueSource): boolean {
  if (x.from === 'probe' && y.from === 'probe')
    return x.probe === y.probe && (x.pointer ?? '') === (y.pointer ?? '') && (x.at ?? 'after') !== (y.at ?? 'after');
  if (x.from === 'storage' && y.from === 'storage')
    return x.area === y.area && x.key === y.key && x.origin === y.origin && (x.at ?? 'after') !== (y.at ?? 'after');
  return false;
}

/**
 * `pick` drops fields; it is for two collections whose items have different shapes. On
 * items of one shape, a change to a field it leaves out (a price, a gift note) passes.
 */
export const pickOnSameShape = (at: string, what: string) =>
  `${at}: items pick compares only some fields of ${what}, whose items have the same fields, so a change to any other field passes; compare whole items (items without pick), and use pick only when the two sides' items have different fields`;

/** A locator for a definition (a `dd`), directly or through `within`. */
const locatesDefinition = (l: Locator | undefined): boolean =>
  !!l && (l.role === 'definition' || locatesDefinition(l.within));

const targetDefinition = (t: Target | undefined): boolean =>
  !!t && ('anchors' in t ? t.anchors.some(locatesDefinition) : locatesDefinition(t));

const sourceDefinition = (src: ValueSource): boolean =>
  (src.from === 'node' && targetDefinition(src.target)) || (src.from === 'text' && targetDefinition(src.scope));

/** A count that zero matches satisfy: the check asserts absence (or nothing). */
const allowsNone = (count: NumberCompare | undefined): boolean => !!count && compareNumber(0, count);

const unboundDefinition = (at: string) =>
  `${at}: reads a definition (a dd) found by its own content, so a value shown under another term (another field of the record) also matches; select the term's record with each (match {role: "term", text: …}) and read the definition inside it`;

/**
 * `inTerm`: inside an `each` whose records are terms, where a definition is bound to its
 * term. Outside one, a definition read for its value (not an absence check) is loose.
 */
function looseAssertion(a: Assertion, at: string, out: string[], inTerm = false): void {
  switch (a.kind) {
    case 'state':
      if (!inTerm && targetDefinition(a.target)) out.push(unboundDefinition(at));
      return;
    case 'contains':
      if (!inTerm && !allowsNone(a.count) && (locatesDefinition(a.match) || targetDefinition(a.scope)))
        out.push(unboundDefinition(at));
      return;
    case 'each':
      if (!inTerm && (locatesDefinition(a.match) || targetDefinition(a.scope))) out.push(unboundDefinition(at));
      looseAssertion(a.assert, `${at}.assert`, out, inTerm || a.match.role === 'term');
      return;
    case 'value': {
      if (!inTerm && [a.source, ...('sameAs' in a.expect ? [a.expect.sameAs.source] : [])].some(sourceDefinition))
        out.push(unboundDefinition(at));
      looseOperand(a.source, a.normalize, at, out);
      if ('sameAs' in a.expect) looseOperand(a.expect.sameAs.source, a.expect.sameAs.normalize, `${at} sameAs`, out);
      if (
        'sameAs' in a.expect &&
        (usesPick(a.normalize) || usesPick(a.expect.sameAs.normalize)) &&
        sameCollection(a.source, a.expect.sameAs.source)
      )
        out.push(pickOnSameShape(at, 'one collection before and after the task'));
      const structured = a.source.from !== 'node' && a.source.from !== 'text';
      if (structured && 'regex' in a.expect && isLiteralPattern(a.expect.regex))
        out.push(literalRegexAdvice(a.expect.regex, at));
      if ('schema' in a.expect) looseSchema(a.expect.schema, `${at} schema`, out);
      return;
    }
    case 'url':
      looseUrlMatch(a.match, at, out);
      return;
    case 'request':
      looseRequestMatch(a.match, at, out);
      return;
    case 'sequence':
      a.steps.forEach((st, i) =>
        'request' in st
          ? looseRequestMatch(st.request, `${at} step ${i + 1}`, out)
          : looseUrlMatch(st.url, `${at} step ${i + 1}`, out),
      );
      return;
    case 'page':
      if (a.match.url) looseUrlMatch(a.match.url, `${at} page`, out);
      looseAssertion(a.assert, `${at}.assert`, out, inTerm);
      return;
    case 'allOf':
    case 'anyOf':
      a.of.forEach((s, i) => looseAssertion(s, `${at}.${a.kind}[${i}]`, out, inTerm));
      return;
  }
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** A local `$ref` ("#", "#/definitions/x") resolved against the root schema; undefined for anything else. */
function resolveRef(root: unknown, ref: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let cur: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (isObject(cur)) cur = cur[key];
    else if (Array.isArray(cur)) cur = cur[Number(key)];
    else return undefined;
  }
  return cur;
}

interface SchemaWalk {
  root: unknown;
  at: string;
  out: string[];
  /** $refs being expanded on the current path (cycle guard). */
  refs: Set<string>;
}

/**
 * Names a schema requires of its own instance: its `required`, and those of its
 * allOf branches and its $ref target (one conjunction describing the same value).
 */
function requiredOf(s: unknown, w: SchemaWalk, seen: Set<string> = new Set()): string[] {
  if (!isObject(s)) return [];
  const names = Array.isArray(s.required) ? s.required.map(String) : [];
  if (Array.isArray(s.allOf)) for (const b of s.allOf) names.push(...requiredOf(b, w, seen));
  if (typeof s.$ref === 'string' && !seen.has(s.$ref)) {
    seen.add(s.$ref);
    names.push(...requiredOf(resolveRef(w.root, s.$ref), w, seen));
  }
  return names;
}

/** Whether a property schema pins its value: const or enum, directly, in a combinator branch or through $ref. */
function pinOf(p: unknown, w: SchemaWalk, seen: Set<string> = new Set()): 'const' | 'enum' | undefined {
  if (!isObject(p)) return undefined;
  if ('const' in p) return 'const';
  if ('enum' in p) return 'enum';
  for (const k of ['allOf', 'anyOf', 'oneOf'])
    if (Array.isArray(p[k]))
      for (const b of p[k] as unknown[]) {
        const pin = pinOf(b, w, seen);
        if (pin) return pin;
      }
  if (typeof p.$ref === 'string' && !seen.has(p.$ref)) {
    seen.add(p.$ref);
    return pinOf(resolveRef(w.root, p.$ref), w, seen);
  }
  return undefined;
}

function looseSchema(schema: unknown, at: string, out: string[]): void {
  walkSchema(schema, '', [], false, { root: schema, at, out, refs: new Set() });
}

/**
 * Walks a JSON Schema through properties, items, contains, anyOf/allOf/oneOf,
 * not and local $refs. `inherited` holds the names the enclosing schemas require
 * of the same instance; `negated` is true under an odd number of `not`s.
 */
function walkSchema(s: unknown, path: string, inherited: string[], negated: boolean, w: SchemaWalk): void {
  if (!isObject(s)) return;
  const required = [...inherited, ...requiredOf(s, w)];
  if (isObject(s.properties)) {
    for (const [name, p] of Object.entries(s.properties)) {
      const here = `${path}/properties/${name}`;
      const pin = pinOf(p, w);
      if (pin && !required.includes(name))
        w.out.push(
          negated
            ? `${w.at}: JSON Schema property ${here} (inside "not") pins its value with ${pin} but is not in "required", so the inner schema also matches a value without ${JSON.stringify(name)} and "not" excludes it; add it to "required"`
            : `${w.at}: JSON Schema property ${here} pins its value with ${pin} but is not in "required", so a value without ${JSON.stringify(name)} passes; add it to "required"`,
        );
      walkSchema(p, here, [], negated, w);
    }
  }
  if (Array.isArray(s.items)) s.items.forEach((x, i) => walkSchema(x, `${path}/items/${i}`, [], negated, w));
  else walkSchema(s.items, `${path}/items`, [], negated, w);
  walkSchema(s.contains, `${path}/contains`, [], negated, w);
  for (const k of ['anyOf', 'allOf', 'oneOf'])
    if (Array.isArray(s[k]))
      (s[k] as unknown[]).forEach((x, i) => walkSchema(x, `${path}/${k}/${i}`, required, negated, w));
  // The inner schema of a not applies to the same instance, so what the outside requires still holds.
  walkSchema(s.not, `${path}/not`, required, !negated, w);
  if (typeof s.$ref === 'string' && !w.refs.has(s.$ref)) {
    w.refs.add(s.$ref);
    walkSchema(resolveRef(w.root, s.$ref), s.$ref.slice(1), required, negated, w);
    w.refs.delete(s.$ref);
  }
}

/**
 * One side of a sameAs through `items`: the collection without the items projection, and
 * the fields that projection keeps (`[]` for whole items).
 */
function itemsSide(src: ValueSource, n: Normalizer[] | undefined) {
  const steps = n ?? [];
  const step = steps.find((x) => typeof x === 'object' && x.op === 'items') as
    | Extract<Normalizer, { op: 'items' }>
    | undefined;
  if (!step) return undefined;
  const rest = steps.map((x) => {
    if (typeof x === 'string') return { op: x };
    // A flattened field is a collection of its own (a post's tags, not its categories): keep it.
    if (x.op !== 'items' || x.flatten) return x;
    const { pointer: _, pick: __, ...keep } = x;
    return keep;
  });
  const fields = step.flatten ? [] : step.pick ? step.pick.toSorted() : step.pointer ? [step.pointer] : [];
  return { key: canonicalJson({ src, n: rest } as unknown as Json), fields };
}

/**
 * Within one requirement, two or more sameAs comparisons of the same pair of
 * collections through `items` with different projections: each sorts its fields on
 * their own, so 1×A + 2×B passes for 2×A + 1×B. Fine when one comparison keeps every
 * field the others compare together (whole items, or a `pick` of all of them).
 */
function fieldwiseCollections(cs: CheckSet, out: string[]): void {
  for (const r of cs.requirements) {
    // pair of collections → projection pair → checks
    const pairs = new Map<string, Map<string, Set<string>>>();
    const visit = (a: Assertion, check: string): void => {
      if (a.kind === 'allOf' || a.kind === 'anyOf') {
        for (const b of a.of) visit(b, check);
        return;
      }
      if (a.kind === 'each' || a.kind === 'page') return visit(a.assert, check);
      if (a.kind !== 'value' || !('sameAs' in a.expect)) return;
      const x = itemsSide(a.source, a.normalize);
      const y = itemsSide(a.expect.sameAs.source, a.expect.sameAs.normalize);
      if (!x || !y) return;
      const [p, q] = x.key <= y.key ? [x, y] : [y, x];
      const pair = `${p.key}\u0000${q.key}`;
      const byProjection = pairs.get(pair) ?? new Map<string, Set<string>>();
      pairs.set(pair, byProjection);
      const proj = JSON.stringify([p.fields, q.fields]);
      byProjection.set(proj, (byProjection.get(proj) ?? new Set<string>()).add(check));
    };
    for (const c of cs.checks) if (c.requirement === r.id) visit(c.assert, c.id);
    for (const byProjection of pairs.values()) {
      if (byProjection.size < 2) continue;
      const projections = [...byProjection.keys()].map((k) => JSON.parse(k) as [string[], string[]]);
      const fields = [...new Set(projections.flat(2))].toSorted();
      // Whole items ([]) keep every field; a pick keeps the fields it names.
      const keeps = (side: string[]) => side.length === 0 || fields.every((f) => side.includes(f));
      if (projections.some(([p, q]) => keeps(p) && keeps(q))) continue;
      const checks = [...new Set([...byProjection.values()].flatMap((s) => [...s]))];
      out.push(
        `requirement ${r.id}: checks ${checks.join(', ')} compare the same two collections one field at a time (items fields ${fields.join(', ')}); each projection is sorted on its own, so the fields of different records pair up (1×A + 2×B matches 2×A + 1×B); compare whole items (items without a pointer), or keep the fields together with an items pick, in one check`,
      );
    }
  }
}

/** Some value read inside `a` (nested ones and sameAs operands included) comes from a request or response. */
function readsNetworkValue(a: Assertion): boolean {
  if (a.kind === 'allOf' || a.kind === 'anyOf') return a.of.some(readsNetworkValue);
  if (a.kind === 'each' || a.kind === 'page') return readsNetworkValue(a.assert);
  if (a.kind !== 'value') return false;
  return [a.source, ...('sameAs' in a.expect ? [a.expect.sameAs.source] : [])].some(
    (src) => src.from === 'request' || src.from === 'response',
  );
}

/**
 * A leaf that reads route evidence: a request, url or sequence assertion (the order of requests
 * and navigations is how the run went, ADR 0024), or a value read from a request or response.
 */
function routeLeaf(a: Assertion): boolean {
  if (a.kind === 'request' || a.kind === 'url' || a.kind === 'sequence') return true;
  return a.kind === 'value' && readsNetworkValue(a);
}

const leaves = (a: Assertion): Assertion[] =>
  a.kind === 'allOf' || a.kind === 'anyOf'
    ? a.of.flatMap(leaves)
    : a.kind === 'each' || a.kind === 'page'
      ? leaves(a.assert)
      : [a];

/** Some part of `a` reads route evidence (what `onMissing` applies to). */
export function readsRoute(a: Assertion): boolean {
  return leaves(a).some(routeLeaf);
}

/**
 * Every part of `a` reads route evidence: requests, responses or the page URL, which
 * show how one run did the task rather than the state it left (ADR 0011).
 */
export function routeOnly(a: Assertion): boolean {
  return leaves(a).every(routeLeaf);
}

/**
 * `a` fails, rather than abstains, when the thing it is about is absent: a non-value
 * assertion, an allOf with such a part, or an anyOf whose every branch is one.
 */
function assertsPresence(a: Assertion, routeAbstains = false): boolean {
  if (a.kind === 'allOf') return a.of.some((b) => assertsPresence(b, routeAbstains));
  if (a.kind === 'anyOf') return a.of.every((b) => assertsPresence(b, routeAbstains));
  // A page that is not open abstains (ADR 0012): the wrapper never shows something missing.
  if (a.kind === 'page') return false;
  // With onMissing "abstain", a missing request or a URL elsewhere abstains too.
  if (routeAbstains && routeLeaf(a)) return false;
  return a.kind !== 'value';
}

export function assertValidCheckSet(input: unknown): CheckSet {
  const report = validateCheckSet(input);
  if (!report.ok) throw new CheckSetError(report);
  return input as CheckSet;
}

/** The JSON Pointer of the first value that contains itself, or undefined when there is none. */
function cycleAt(v: unknown, at = '', path = new Set<object>()): string | undefined {
  if (!v || typeof v !== 'object') return undefined;
  if (path.has(v)) return at || '/';
  path.add(v);
  for (const [k, x] of Object.entries(v)) {
    const c = cycleAt(x, `${at}/${k}`, path);
    if (c !== undefined) return c;
  }
  path.delete(v);
  return undefined;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

function checkRegex(src: string, flags: string | undefined, at: string, errors: string[]): void {
  try {
    RegExp(src, flags);
  } catch (e) {
    errors.push(`${at}: invalid regex /${src}/: ${(e as Error).message}`);
  }
}

function checkTextMatch(m: TextMatch | undefined, at: string, errors: string[]): void {
  if (m && typeof m === 'object' && 'regex' in m) checkRegex(m.regex, m.flags, at, errors);
}

function checkLocator(l: Locator, at: string, errors: string[]): void {
  checkTextMatch(l.name, `${at} name`, errors);
  checkTextMatch(l.text, `${at} text`, errors);
  checkTextMatch(l.landmark?.name, `${at} landmark name`, errors);
  if (l.column !== undefined) {
    checkTextMatch(l.column, `${at} column`, errors);
    if (!['cell', 'gridcell', 'rowheader', 'columnheader'].includes(l.role))
      errors.push(
        `${at}: column binds a cell to its column header; role ${l.role} has no column (use cell, gridcell, rowheader or columnheader)`,
      );
  }
  if (l.within) checkLocator(l.within, `${at} within`, errors);
}

function checkTarget(t: Target, at: string, errors: string[]): void {
  for (const l of 'anchors' in t ? t.anchors : [t]) checkLocator(l, at, errors);
}

/**
 * Schemas (as JSON) that compiled. Ajv caches by schema object, so a fresh copy of a check set
 * (parsed again from its file) recompiled every schema; a schema that compiled once compiles
 * again. Not for schemas that register a name (`$id`, anchors): compiling those twice fails.
 */
const compiledSchemas = new Set<string>();

function checkSchema(s: unknown, at: string, errors: string[]): void {
  const key = plainJson(s) ? JSON.stringify(s) : undefined;
  if (key !== undefined && compiledSchemas.has(key)) return;
  try {
    // Ajv keeps every schema it compiles; only whether this one compiles matters here, so start
    // a fresh Ajv every SCHEMA_LIMIT attempts, failed ones included.
    if (++compiledHere > SCHEMA_LIMIT) {
      schemaCompiler = schemaAjv();
      compiledHere = 1;
    }
    schemaCompiler.compile(s as object);
    if (key !== undefined && !/"\$(?:id|anchor|dynamicAnchor|recursiveAnchor)"/.test(key)) {
      if (compiledSchemas.size >= 10_000) compiledSchemas.clear();
      compiledSchemas.add(key);
    }
  } catch (e) {
    errors.push(`${at}: invalid JSON Schema: ${(e as Error).message}`);
  }
}

/** Plain JSON data: what JSON.stringify writes in full (no undefined, functions or class instances). */
function plainJson(v: unknown): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) if (!(i in v) || !plainJson(v[i])) return false;
    return true;
  }
  if (typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) return false;
  return Object.values(v).every(plainJson);
}

function sourceType(src: ValueSource): VType {
  return src.from === 'request' || src.from === 'response' || src.from === 'probe' ? 'unknown' : 'string';
}

function flowType(t: VType, steps: Normalizer[] | undefined, at: string, errors: string[]): VType {
  for (const step of steps ?? []) {
    const op = typeof step === 'string' ? step : step.op;
    if (typeof step === 'object' && (step.op === 'extract' || step.op === 'replace'))
      checkRegex(step.regex, step.op === 'replace' ? (step.flags ?? 'g') : step.flags, `${at} ${op}`, errors);
    if (
      typeof step === 'object' &&
      (step.op === 'number' || step.op === 'currency' || step.op === 'date' || step.op === 'datetime')
    ) {
      try {
        Intl.NumberFormat(step.locale);
      } catch {
        errors.push(`${at}: unknown locale ${JSON.stringify(step.locale)}`);
      }
      if ((step.op === 'date' || step.op === 'datetime') && step.timezone) {
        try {
          Intl.DateTimeFormat('en', { timeZone: step.timezone });
        } catch {
          errors.push(`${at}: unknown timezone ${JSON.stringify(step.timezone)}`);
        }
      }
    }
    if (typeof step === 'object' && step.op === 'items') {
      if (step.where !== undefined) checkSchema(step.where, `${at} items where`, errors);
      if (step.pick !== undefined && step.pointer !== undefined)
        errors.push(`${at}: items takes either pointer (one field) or pick (several fields), not both`);
      if (step.flatten && step.pick !== undefined)
        errors.push(`${at}: items flatten takes the array at pointer; pick makes objects, which cannot be flattened`);
      if (step.flatten && !step.pointer)
        errors.push(`${at}: items flatten needs a pointer to the array field of each item (e.g. "/tags")`);
      if (t !== 'unknown') errors.push(`${at}: normalizer items needs a JSON array, but the value is ${t}`);
      t = 'unknown';
      continue;
    }
    const stringOp = [
      'trim',
      'collapseWhitespace',
      'lowercase',
      'uppercase',
      'nfkc',
      'stripDiacritics',
      'extract',
      'replace',
      'json',
      'boolean',
      'date',
      'datetime',
    ].includes(op);
    if (
      stringOp &&
      t !== 'string' &&
      t !== 'unknown' &&
      !(op === 'boolean' && t === 'boolean') &&
      !(op === 'date' && t === 'date') &&
      !(op === 'datetime' && t === 'datetime')
    )
      errors.push(`${at}: normalizer ${op} cannot take a ${t} value`);
    if (op === 'number' && !['string', 'number', 'unknown'].includes(t))
      errors.push(`${at}: normalizer number cannot take a ${t} value`);
    if (op === 'currency' && !['string', 'number', 'money', 'unknown'].includes(t))
      errors.push(`${at}: normalizer currency cannot take a ${t} value`);
    t =
      op === 'number'
        ? 'number'
        : op === 'currency'
          ? 'money'
          : op === 'date'
            ? 'date'
            : op === 'datetime'
              ? 'datetime'
              : op === 'boolean'
                ? 'boolean'
                : op === 'json'
                  ? 'unknown'
                  : 'string';
  }
  return t;
}

const boundType = (b: unknown): VType =>
  typeof b === 'number'
    ? 'number'
    : typeof b === 'string'
      ? /^\d{4}-\d{2}-\d{2}$/.test(b)
        ? 'date'
        : 'datetime'
      : 'money';

/** A date compares with "YYYY-MM-DD" literals, a datetime with ISO instants that name their offset. */
function checkTimeLiteral(t: VType, e: unknown, what: string, at: string, errors: string[]): void {
  if (t === 'date' && (typeof e !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e)))
    errors.push(`${at}: a date normalizes to YYYY-MM-DD; ${what} ${JSON.stringify(e)} cannot match`);
  if (t === 'datetime' && (typeof e !== 'string' || instantOf(e) === undefined))
    errors.push(
      `${at}: a datetime normalizes to an instant; ${what} ${JSON.stringify(e)} needs a valid ISO date-time with an offset (e.g. "2026-11-05T14:30:00+01:00")`,
    );
}

function checkComparison(t: VType, cmp: Comparison, at: string, errors: string[], warnings: string[]): void {
  if ('regex' in cmp) checkRegex(cmp.regex, cmp.flags, at, errors);
  if (('regex' in cmp || 'contains' in cmp) && t !== 'string' && t !== 'unknown')
    errors.push(`${at}: ${'regex' in cmp ? 'regex' : 'contains'} needs a string, but the value is ${t}`);
  if ('schema' in cmp) checkSchema(cmp.schema, at, errors);
  if ('equals' in cmp) {
    const e = cmp.equals;
    if (t === 'number' && typeof e !== 'number')
      errors.push(`${at}: equals ${JSON.stringify(e)} cannot match a number`);
    checkTimeLiteral(t, e, 'equals', at, errors);
    if (t === 'money' && (typeof e !== 'object' || e === null || !('amount' in e)))
      errors.push(`${at}: equals needs {amount, currency} for a money value`);
    if (t === 'string' && typeof e !== 'string')
      errors.push(`${at}: equals ${JSON.stringify(e)} compares a string to a ${typeof e}; add a normalizer`);
    if (t === 'money' || t === 'number')
      warnings.push(`${at}: exact equality on a ${t}; consider approx with a tolerance`);
  }
  // null in oneOf stands for an unset storage key (§2.4), not a literal of the value's type.
  if ('oneOf' in cmp) for (const e of cmp.oneOf) if (e !== null) checkTimeLiteral(t, e, 'oneOf entry', at, errors);
  const bounds: unknown[] =
    'approx' in cmp
      ? [cmp.approx.value]
      : ['gt', 'gte', 'lt', 'lte'].filter((k) => k in cmp).map((k) => (cmp as Record<string, unknown>)[k]);
  if (bounds.length) {
    if (t === 'string' || t === 'boolean')
      errors.push(`${at}: ordering/approx comparison on a ${t}; add a number, currency, date or datetime normalizer`);
    if ('approx' in cmp && (t === 'date' || t === 'datetime') && cmp.approx.rel !== undefined)
      errors.push(`${at}: rel has no meaning for a ${t}; use abs (${t === 'date' ? 'days' : 'minutes'})`);
    for (const b of bounds) {
      const bt = boundType(b);
      if (bt === 'datetime' && instantOf(b as string) === undefined)
        errors.push(`${at}: bound ${JSON.stringify(b)} is not a valid ISO date-time`);
      if (t !== 'unknown' && t !== bt && !(t === 'money' && bt === 'number'))
        errors.push(`${at}: bound ${JSON.stringify(b)} is a ${bt} but the value is ${t}`);
    }
  }
}

/**
 * A sameAs tolerance is bounded and only on values that have a distance: numbers and money
 * (abs in their unit, rel at most MAX_TOLERANCE.rel), date-times (abs in minutes) and dates
 * (abs in whole days). A value of unknown type (a raw probe field) is checked at run time.
 */
function checkTolerance(t: VType, tol: Tolerance, at: string, errors: string[]): void {
  if (t === 'string' || t === 'boolean') {
    errors.push(
      `${at}: a tolerance applies to numbers, money, dates and date-times, but the values are ${t}s; add a number, currency, date or datetime normalizer, or drop the tolerance`,
    );
    return;
  }
  if ((t === 'date' || t === 'datetime') && tol.rel !== undefined)
    errors.push(`${at}: rel has no meaning for a ${t}; use abs (${t === 'date' ? 'days' : 'minutes'})`);
  if (t === 'datetime' && tol.abs !== undefined && tol.abs > MAX_TOLERANCE.minutes)
    errors.push(`${at}: a date-time tolerance is at most ${MAX_TOLERANCE.minutes} minutes, got ${tol.abs}`);
  if (t === 'date' && tol.abs !== undefined && (!Number.isInteger(tol.abs) || tol.abs > MAX_TOLERANCE.days))
    errors.push(`${at}: a date tolerance is a whole number of days, at most ${MAX_TOLERANCE.days}, got ${tol.abs}`);
  if (!canonical(tol.because)) errors.push(`${at}: the tolerance needs a reason ("because")`);
}

/**
 * `inRecord`: inside an `each`, where locators resolve within the record (a contains
 * without a scope searches the record) and only the record may be read. `onPage`: inside a
 * `page` assertion, where only what the selected page shows may be read.
 */
function walkAssertion(
  a: Assertion,
  at: string,
  errors: string[],
  warnings: string[],
  inRecord: boolean,
  onPage = false,
): void {
  switch (a.kind) {
    case 'state':
      checkTarget(a.target, at, errors);
      for (const k of ['name', 'value', 'text'] as const) checkTextMatch(a.expect[k], `${at} expect.${k}`, errors);
      return;
    case 'contains':
      if (a.scope) checkTarget(a.scope, at, errors);
      else if (!inRecord)
        warnings.push(
          `${at}: contains without a scope searches the whole page; an unrelated UI change can make it fail instead of abstain`,
        );
      checkLocator(a.match, at, errors);
      if (a.witness) checkLocator(a.witness, `${at} witness`, errors);
      else if (a.count && (a.count.eq === 0 || a.count.lte === 0 || a.count.lt === 1))
        warnings.push(
          `${at}: an absence check without a witness passes vacuously if the scope's content loses its structure; add a witness`,
        );
      return;
    case 'each':
      if (a.scope) checkTarget(a.scope, at, errors);
      else if (!inRecord)
        warnings.push(
          `${at}: each without a scope searches the whole page; an unrelated UI change can make it fail instead of abstain`,
        );
      checkLocator(a.match, `${at} match`, errors);
      if (a.witness) checkLocator(a.witness, `${at} witness`, errors);
      else if (allowsNone(a.count))
        warnings.push(
          `${at}: each with a count that allows no records passes vacuously if the scope's content loses its structure; add a witness`,
        );
      walkAssertion(a.assert, `${at}.assert`, errors, warnings, true, onPage);
      return;
    case 'value': {
      if (inRecord && a.source.from !== 'node' && a.source.from !== 'text')
        errors.push(
          `${at}: inside each, a value check must read the record (a node or text source); a ${a.source.from} source reads the same value for every record`,
        );
      if (onPage)
        for (const src of [a.source, ...('sameAs' in a.expect ? [a.expect.sameAs.source] : [])])
          if (src.from !== 'node' && src.from !== 'text' && src.from !== 'url')
            errors.push(notOnPage(at, `a ${src.from} source`));
      const t = checkValueSource(a.source, a.normalize, at, errors, warnings, inRecord);
      if ('sameAs' in a.expect) {
        const other = a.expect.sameAs;
        const ot = checkValueSource(other.source, other.normalize, `${at} sameAs`, errors, warnings, inRecord);
        if (t !== 'unknown' && ot !== 'unknown' && t !== ot)
          errors.push(`${at}: sameAs compares a ${t} with a ${ot}; normalize both sides to the same type`);
        if (side(a.source, a.normalize) === side(other.source, other.normalize))
          errors.push(`${at}: sameAs compares a value with itself`);
        if (other.tolerance) {
          const items = [a.normalize, other.normalize].some((n) => {
            const last = n?.at(-1);
            return typeof last === 'object' && last.op === 'items';
          });
          if (items)
            errors.push(
              `${at} sameAs: a tolerance applies to numbers, money, dates and date-times, not to collections (items); collections already compare in any order`,
            );
          else checkTolerance(t !== 'unknown' ? t : ot, other.tolerance, `${at} sameAs`, errors);
        }
      } else checkComparison(t, a.expect, at, errors, warnings);
      if (before(a.source) && (!('sameAs' in a.expect) || before(a.expect.sameAs.source)))
        warnings.push(
          `${at}: reads only the state before the task, which does not depend on what the agent did; compare it with the state after (sameAs)`,
        );
      return;
    }
    case 'url':
      if (inRecord) errors.push(notInRecord(at, 'url'));
      if (a.match.regex) checkRegex(a.match.regex, undefined, at, errors);
      for (const v of Object.values(a.match.query ?? {})) if (v) checkTextMatch(v, at, errors);
      return;
    case 'request':
      if (inRecord) errors.push(notInRecord(at, 'request'));
      if (onPage) errors.push(notOnPage(at, 'a request assertion'));
      checkRequestMatch(a.match, at, errors);
      return;
    case 'sequence':
      if (inRecord) errors.push(notInRecord(at, 'sequence'));
      if (onPage) errors.push(notOnPage(at, 'a sequence assertion'));
      checkSequence(a, at, errors, warnings);
      return;
    case 'page':
      if (inRecord)
        errors.push(`${at}: a page assertion cannot be inside each; put the each inside the page assertion`);
      if (onPage) errors.push(`${at}: a page assertion inside another page assertion; select one page`);
      checkTextMatch(a.match.title, `${at} page title`, errors);
      if (a.match.url?.regex) checkRegex(a.match.url.regex, undefined, `${at} page url`, errors);
      for (const v of Object.values(a.match.url?.query ?? {})) if (v) checkTextMatch(v, `${at} page url`, errors);
      walkAssertion(a.assert, `${at}.assert`, errors, warnings, false, true);
      return;
    case 'allOf':
    case 'anyOf':
      a.of.forEach((s, i) => walkAssertion(s, `${at}.${a.kind}[${i}]`, errors, warnings, inRecord, onPage));
      return;
  }
}

/**
 * A sequence's steps (ADR 0024): each request match or URL match checked as elsewhere. Two
 * adjacent steps that are the same can never be in order (their first events are one event),
 * so that is an error. A step that matches any request, or any URL, says nothing about which
 * event it stands for: an earlier unrelated request satisfies it, so the order is not tested.
 */
function checkSequence(
  a: Extract<Assertion, { kind: 'sequence' }>,
  at: string,
  errors: string[],
  warnings: string[],
): void {
  a.steps.forEach((st, i) => {
    const where = `${at} step ${i + 1}`;
    if ('request' in st) {
      checkRequestMatch(st.request, where, errors);
      if (st.request.url === undefined)
        warnings.push(
          `${where}: has no url, so an unrelated request (an earlier one too) can stand for this step and the order is not tested; give it a url`,
        );
    } else {
      if (st.url.regex) checkRegex(st.url.regex, undefined, where, errors);
      for (const v of Object.values(st.url.query ?? {})) if (v) checkTextMatch(v, where, errors);
    }
    const next = a.steps[i + 1];
    if (next && canonicalJson(st as unknown as Json) === canonicalJson(next as unknown as Json))
      errors.push(
        `${at}: steps ${i + 1} and ${i + 2} are the same, so their first events are one event and can never be in order`,
      );
  });
  if (a.strict && a.steps.some((st) => 'request' in st && isGet(st.request.method)))
    warnings.push(
      `${at}: strict order with a GET step fails whenever the page fetches that data again later (polling, a refresh); use strict only for steps that change state, or drop strict`,
    );
}

/** A request match that only accepts GET (or HEAD). */
const isGet = (m: RequestMatch['method']): boolean => {
  const ms = m === undefined ? [] : Array.isArray(m) ? m : [m];
  return ms.length > 0 && ms.every((x) => ['GET', 'HEAD'].includes(x.toUpperCase()));
};

const notOnPage = (at: string, what: string) =>
  `${at}: ${what} inside a page assertion does not read the page, so it is the same whatever page is selected; move it out of the page assertion`;

const notInRecord = (at: string, kind: string) =>
  `${at}: a ${kind} assertion inside each does not read the record, so it is the same for every record; move it out of the each`;

/** A source that reads the baseline (the state before the task). */
const before = (src: ValueSource) => (src.from === 'probe' || src.from === 'storage') && src.at === 'before';

/** Identity of one side of a comparison: its source and normalizers. */
const side = (src: ValueSource, n: Normalizer[] | undefined) =>
  canonicalJson({ src, n: (n ?? []).map((x) => (typeof x === 'string' ? { op: x } : x)) } as unknown as Json);

/**
 * Checks one value source and its normalizers; returns the type the pipeline produces.
 * `inRecord`: inside an `each`, where an unscoped text source reads the record's text.
 */
function checkValueSource(
  src: ValueSource,
  normalize: Normalizer[] | undefined,
  at: string,
  errors: string[],
  warnings: string[],
  inRecord: boolean,
): VType {
  if (src.from === 'node') {
    checkTarget(src.target, at, errors);
    if (src.field === 'name' || src.field === 'text') {
      for (const n of normalize ?? []) {
        if (typeof n !== 'object' || (n.op !== 'extract' && n.op !== 'replace')) continue;
        if (/\\n|\\r|\\t|[\t\n\r]| {2}|\\s\{2|\\u00a0/.test(n.regex) || (n.flags ?? '').includes('m'))
          warnings.push(
            `${at}: accessible ${src.field} is whitespace-normalized before normalizers run (newlines, tabs and runs of spaces become one space); /${n.regex}/ expects raw whitespace`,
          );
      }
    }
  }
  if (src.from === 'text') {
    if (src.scope) checkTarget(src.scope, at, errors);
    checkRegex(src.pattern, src.flags, at, errors);
    // Only the whole document's text is free text; a scope's or a record's text is read from
    // the accessibility tree, as the evaluator does (textSourceChannel).
    if (textSourceChannel(src, inRecord) === 'text')
      warnings.push(
        `${at}: reads free page text, which is the easiest evidence to spoof; prefer a11y, network or probe evidence`,
      );
  }
  if (src.from === 'request' || src.from === 'response') checkRequestMatch(src.match, at, errors);
  return flowType(sourceType(src), normalize, at, errors);
}

function checkRequestMatch(m: RequestMatch, at: string, errors: string[]): void {
  if (m.url?.regex) checkRegex(m.url.regex, undefined, at, errors);
  if (m.requestBody !== undefined) checkSchema(m.requestBody, `${at} requestBody`, errors);
  if (m.responseBody !== undefined) checkSchema(m.responseBody, `${at} responseBody`, errors);
}
