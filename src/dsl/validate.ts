import { Ajv } from 'ajv';
import type {
  Assertion,
  CheckSet,
  Comparison,
  Json,
  Locator,
  Normalizer,
  RequestMatch,
  Target,
  TextMatch,
  UrlMatch,
  ValueSource,
} from '../types.ts';
import { canonical } from '../text.ts';
import { canonicalJson } from '../snapshot/digest.ts';
import { instantOf } from '../runtime/values.ts';
import { checkSetSchema } from './schema.ts';

const ajv = new Ajv({ allErrors: true, strict: false });
const validateShape = ajv.compile(checkSetSchema);
const schemaCompiler = new Ajv({ strict: false, validateFormats: false });

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
  if (!validateShape(input)) {
    for (const e of validateShape.errors ?? [])
      errors.push(
        `${e.instancePath || '/'} ${e.message}${e.params && 'allowedValues' in e.params ? ` (${(e.params.allowedValues as unknown[]).join(', ')})` : ''}`,
      );
    return { ok: false, errors: dedupe(errors), warnings };
  }
  const cs = input as unknown as CheckSet;

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
    walkAssertion(c.assert, at, errors, warnings);
  }
  for (const r of cs.requirements) {
    const mine = cs.checks.filter((c) => c.requirement === r.id).map((c) => c.assert);
    const readsNetwork = mine.some(readsNetworkValue);
    const assertsExistence = mine.some(assertsPresence);
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

function looseAssertion(a: Assertion, at: string, out: string[]): void {
  switch (a.kind) {
    case 'value': {
      looseOperand(a.source, a.normalize, at, out);
      if ('sameAs' in a.expect) looseOperand(a.expect.sameAs.source, a.expect.sameAs.normalize, `${at} sameAs`, out);
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
    case 'allOf':
    case 'anyOf':
      a.of.forEach((s, i) => looseAssertion(s, `${at}.${a.kind}[${i}]`, out));
      return;
    default:
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

/** One side of a sameAs through `items`: the collection without the items pointer, and that pointer. */
function itemsSide(src: ValueSource, n: Normalizer[] | undefined) {
  const steps = n ?? [];
  const step = steps.find((x) => typeof x === 'object' && x.op === 'items') as
    | Extract<Normalizer, { op: 'items' }>
    | undefined;
  if (!step) return undefined;
  const rest = steps.map((x) => {
    if (typeof x === 'string') return { op: x };
    if (x.op !== 'items') return x;
    const { pointer: _, ...keep } = x;
    return keep;
  });
  return { key: canonicalJson({ src, n: rest } as unknown as Json), pointer: step.pointer ?? '' };
}

/**
 * Within one requirement, two or more sameAs comparisons of the same pair of
 * collections through `items` with different pointers: each sorts one field on
 * its own, so 1×A + 2×B passes for 2×A + 1×B. Comparing whole items avoids it.
 */
function fieldwiseCollections(cs: CheckSet, out: string[]): void {
  for (const r of cs.requirements) {
    // pair of collections → pointer pair → checks
    const pairs = new Map<string, Map<string, Set<string>>>();
    const visit = (a: Assertion, check: string): void => {
      if (a.kind === 'allOf' || a.kind === 'anyOf') {
        for (const b of a.of) visit(b, check);
        return;
      }
      if (a.kind !== 'value' || !('sameAs' in a.expect)) return;
      const x = itemsSide(a.source, a.normalize);
      const y = itemsSide(a.expect.sameAs.source, a.expect.sameAs.normalize);
      if (!x || !y) return;
      const [p, q] = x.key <= y.key ? [x, y] : [y, x];
      const pair = `${p.key}\u0000${q.key}`;
      const byPointers = pairs.get(pair) ?? new Map<string, Set<string>>();
      pairs.set(pair, byPointers);
      const ptrs = JSON.stringify([p.pointer, q.pointer]);
      byPointers.set(ptrs, (byPointers.get(ptrs) ?? new Set<string>()).add(check));
    };
    for (const c of cs.checks) if (c.requirement === r.id) visit(c.assert, c.id);
    for (const byPointers of pairs.values()) {
      if (byPointers.size < 2 || byPointers.has(JSON.stringify(['', '']))) continue;
      const checks = [...new Set([...byPointers.values()].flatMap((s) => [...s]))];
      const fields = [...new Set([...byPointers.keys()].flatMap((k) => (JSON.parse(k) as string[]).filter(Boolean)))];
      out.push(
        `requirement ${r.id}: checks ${checks.join(', ')} compare the same two collections one field at a time (items pointers ${fields.join(', ')}); each field is sorted on its own, so the fields of different records pair up (1×A + 2×B matches 2×A + 1×B); compare whole items (items without a pointer) in one check`,
      );
    }
  }
}

/** Some value read inside `a` (nested ones and sameAs operands included) comes from a request or response. */
function readsNetworkValue(a: Assertion): boolean {
  if (a.kind === 'allOf' || a.kind === 'anyOf') return a.of.some(readsNetworkValue);
  if (a.kind !== 'value') return false;
  return [a.source, ...('sameAs' in a.expect ? [a.expect.sameAs.source] : [])].some(
    (src) => src.from === 'request' || src.from === 'response',
  );
}

/**
 * `a` fails, rather than abstains, when the thing it is about is absent: a non-value
 * assertion, an allOf with such a part, or an anyOf whose every branch is one.
 */
function assertsPresence(a: Assertion): boolean {
  if (a.kind === 'allOf') return a.of.some(assertsPresence);
  if (a.kind === 'anyOf') return a.of.every(assertsPresence);
  return a.kind !== 'value';
}

export function assertValidCheckSet(input: unknown): CheckSet {
  const report = validateCheckSet(input);
  if (!report.ok) throw new CheckSetError(report);
  return input as CheckSet;
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
  if (l.within) checkLocator(l.within, `${at} within`, errors);
}

function checkTarget(t: Target, at: string, errors: string[]): void {
  for (const l of 'anchors' in t ? t.anchors : [t]) checkLocator(l, at, errors);
}

function checkSchema(s: unknown, at: string, errors: string[]): void {
  try {
    schemaCompiler.compile(s as object);
  } catch (e) {
    errors.push(`${at}: invalid JSON Schema: ${(e as Error).message}`);
  }
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

function walkAssertion(a: Assertion, at: string, errors: string[], warnings: string[]): void {
  switch (a.kind) {
    case 'state':
      checkTarget(a.target, at, errors);
      for (const k of ['name', 'value', 'text'] as const) checkTextMatch(a.expect[k], `${at} expect.${k}`, errors);
      return;
    case 'contains':
      if (a.scope) checkTarget(a.scope, at, errors);
      else
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
    case 'value': {
      const t = checkValueSource(a.source, a.normalize, at, errors, warnings);
      if ('sameAs' in a.expect) {
        const other = a.expect.sameAs;
        const ot = checkValueSource(other.source, other.normalize, `${at} sameAs`, errors, warnings);
        if (t !== 'unknown' && ot !== 'unknown' && t !== ot)
          errors.push(`${at}: sameAs compares a ${t} with a ${ot}; normalize both sides to the same type`);
        if (side(a.source, a.normalize) === side(other.source, other.normalize))
          errors.push(`${at}: sameAs compares a value with itself`);
      } else checkComparison(t, a.expect, at, errors, warnings);
      if (before(a.source) && (!('sameAs' in a.expect) || before(a.expect.sameAs.source)))
        warnings.push(
          `${at}: reads only the state before the task, which does not depend on what the agent did; compare it with the state after (sameAs)`,
        );
      return;
    }
    case 'url':
      if (a.match.regex) checkRegex(a.match.regex, undefined, at, errors);
      for (const v of Object.values(a.match.query ?? {})) if (v) checkTextMatch(v, at, errors);
      return;
    case 'request':
      checkRequestMatch(a.match, at, errors);
      return;
    case 'allOf':
    case 'anyOf':
      a.of.forEach((s, i) => walkAssertion(s, `${at}.${a.kind}[${i}]`, errors, warnings));
      return;
  }
}

/** A source that reads the baseline (the state before the task). */
const before = (src: ValueSource) => (src.from === 'probe' || src.from === 'storage') && src.at === 'before';

/** Identity of one side of a comparison: its source and normalizers. */
const side = (src: ValueSource, n: Normalizer[] | undefined) =>
  canonicalJson({ src, n: (n ?? []).map((x) => (typeof x === 'string' ? { op: x } : x)) } as unknown as Json);

/** Checks one value source and its normalizers; returns the type the pipeline produces. */
function checkValueSource(
  src: ValueSource,
  normalize: Normalizer[] | undefined,
  at: string,
  errors: string[],
  warnings: string[],
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
