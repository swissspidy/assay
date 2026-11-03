import { Ajv } from 'ajv';
import type {
  Assertion,
  CheckSet,
  Comparison,
  Locator,
  Normalizer,
  RequestMatch,
  Target,
  TextMatch,
  ValueSource,
} from '../types.ts';
import { canonical } from '../text.ts';
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

type VType = 'string' | 'number' | 'money' | 'date' | 'boolean' | 'unknown';

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
    const readsNetwork = mine.some(
      (a) => a.kind === 'value' && (a.source.from === 'request' || a.source.from === 'response'),
    );
    const assertsExistence = mine.some((a) => a.kind !== 'value');
    if (readsNetwork && !assertsExistence)
      warnings.push(
        `requirement ${r.id}: its value checks abstain when no request matches; add a "request" check so a missing request fails`,
      );
  }
  for (const r of cs.requirements)
    if (!covered.has(r.id)) warnings.push(`requirement ${r.id} has no checks (it will abstain as "uncovered")`);

  return { ok: errors.length === 0, errors: dedupe(errors), warnings: dedupe(warnings) };
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
    if (typeof step === 'object' && (step.op === 'number' || step.op === 'currency' || step.op === 'date')) {
      try {
        Intl.NumberFormat(step.locale);
      } catch {
        errors.push(`${at}: unknown locale ${JSON.stringify(step.locale)}`);
      }
      if (step.op === 'date' && step.timezone) {
        try {
          Intl.DateTimeFormat('en', { timeZone: step.timezone });
        } catch {
          errors.push(`${at}: unknown timezone ${JSON.stringify(step.timezone)}`);
        }
      }
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
    ].includes(op);
    if (
      stringOp &&
      t !== 'string' &&
      t !== 'unknown' &&
      !(op === 'boolean' && t === 'boolean') &&
      !(op === 'date' && t === 'date')
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
            : op === 'boolean'
              ? 'boolean'
              : op === 'json'
                ? 'unknown'
                : 'string';
  }
  return t;
}

const boundType = (b: unknown): VType => (typeof b === 'number' ? 'number' : typeof b === 'string' ? 'date' : 'money');

function checkComparison(t: VType, cmp: Comparison, at: string, errors: string[], warnings: string[]): void {
  if ('regex' in cmp) checkRegex(cmp.regex, cmp.flags, at, errors);
  if (('regex' in cmp || 'contains' in cmp) && t !== 'string' && t !== 'unknown')
    errors.push(`${at}: ${'regex' in cmp ? 'regex' : 'contains'} needs a string, but the value is ${t}`);
  if ('schema' in cmp) checkSchema(cmp.schema, at, errors);
  if ('equals' in cmp) {
    const e = cmp.equals;
    if (t === 'number' && typeof e !== 'number')
      errors.push(`${at}: equals ${JSON.stringify(e)} cannot match a number`);
    if (t === 'date' && (typeof e !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e)))
      errors.push(`${at}: a date normalizes to YYYY-MM-DD; equals ${JSON.stringify(e)} cannot match`);
    if (t === 'money' && (typeof e !== 'object' || e === null || !('amount' in e)))
      errors.push(`${at}: equals needs {amount, currency} for a money value`);
    if (t === 'string' && typeof e !== 'string')
      errors.push(`${at}: equals ${JSON.stringify(e)} compares a string to a ${typeof e}; add a normalizer`);
    if (t === 'money' || t === 'number')
      warnings.push(`${at}: exact equality on a ${t}; consider approx with a tolerance`);
  }
  const bounds: unknown[] =
    'approx' in cmp
      ? [cmp.approx.value]
      : ['gt', 'gte', 'lt', 'lte'].filter((k) => k in cmp).map((k) => (cmp as Record<string, unknown>)[k]);
  if (bounds.length) {
    if (t === 'string' || t === 'boolean')
      errors.push(`${at}: ordering/approx comparison on a ${t}; add a number, currency or date normalizer`);
    for (const b of bounds) {
      const bt = boundType(b);
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
      const src = a.source;
      if (src.from === 'node') checkTarget(src.target, at, errors);
      if (src.from === 'text') {
        if (src.scope) checkTarget(src.scope, at, errors);
        checkRegex(src.pattern, src.flags, at, errors);
        warnings.push(
          `${at}: reads free page text, which is the easiest evidence to spoof; prefer a11y, network or probe evidence`,
        );
      }
      if (src.from === 'request' || src.from === 'response') {
        checkRequestMatch(src.match, at, errors);
      }
      const t = flowType(sourceType(src), a.normalize, at, errors);
      checkComparison(t, a.expect, at, errors, warnings);
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

function checkRequestMatch(m: RequestMatch, at: string, errors: string[]): void {
  if (m.url?.regex) checkRegex(m.url.regex, undefined, at, errors);
  if (m.requestBody !== undefined) checkSchema(m.requestBody, `${at} requestBody`, errors);
  if (m.responseBody !== undefined) checkSchema(m.responseBody, `${at} responseBody`, errors);
}
