import type { Comparison, Json, Money } from '../types.ts';
import { compileSchema, schemaErrors } from './json.ts';
import { canonical, stripGlobal } from '../text.ts';
import { canonicalJson } from '../snapshot/digest.ts';
import {
  NormalizeError,
  daysBetween,
  describeValue,
  instantOf,
  minutesBetween,
  toJson,
  type TypedValue,
} from './values.ts';

export interface CompareOutcome {
  ok: boolean;
  message: string;
}

const isMoney = (x: unknown): x is Money =>
  !!x && typeof x === 'object' && typeof (x as Money).amount === 'number' && typeof (x as Money).currency === 'string';

const mismatch = (op: string, v: TypedValue) =>
  new NormalizeError(
    `'${op}' cannot compare a ${v.type} value (${describeValue(v)}); add a normalizer`,
    'type_mismatch',
  );

function deepEqual(actual: TypedValue, expected: Json): boolean {
  switch (actual.type) {
    case 'string':
      return typeof expected === 'string' && canonical(actual.value) === canonical(expected);
    case 'money':
      return (
        isMoney(expected) && expected.amount === actual.value.amount && expected.currency === actual.value.currency
      );
    case 'date':
      return typeof expected === 'string' && expected === actual.value;
    case 'datetime':
      return typeof expected === 'string' && instantOf(expected) === Date.parse(actual.value);
    default:
      return canonicalJson(actual.value) === canonicalJson(expected);
  }
}

/** Numeric projection for ordering comparisons; checks currency agreement for money. */
function scalar(v: TypedValue, bound: unknown, op: string): [number, number] {
  if (v.type === 'number' && typeof bound === 'number') return [v.value, bound];
  if (v.type === 'money' && isMoney(bound)) {
    if (bound.currency !== v.value.currency) throw new CurrencyMismatch(v.value.currency, bound.currency);
    return [v.value.amount, bound.amount];
  }
  if (v.type === 'money' && typeof bound === 'number') return [v.value.amount, bound];
  if (v.type === 'date' && typeof bound === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(bound)) {
    return [Date.parse(v.value + 'T00:00:00Z'), Date.parse(bound + 'T00:00:00Z')];
  }
  if (v.type === 'datetime' && typeof bound === 'string') {
    const b = instantOf(bound);
    if (b !== undefined) return [Date.parse(v.value), b];
  }
  throw mismatch(op, v);
}

class CurrencyMismatch extends Error {
  readonly actual: string;
  readonly expected: string;
  constructor(actual: string, expected: string) {
    super(`currency ${actual} ≠ ${expected}`);
    this.actual = actual;
    this.expected = expected;
  }
}

/**
 * Equality of two normalized values read from different sources (a `sameAs`
 * binding). Both must have the same type; otherwise NormalizeError('type_mismatch').
 */
export function compareValues(a: TypedValue, b: TypedValue): CompareOutcome {
  if (a.type !== b.type)
    throw new NormalizeError(
      `sameAs cannot compare a ${a.type} value (${describeValue(a)}) with a ${b.type} value (${describeValue(b)}); normalize both sides to the same type`,
      'type_mismatch',
    );
  // deepEqual takes the other side as JSON: money as {amount, currency}, a datetime as its ISO string.
  const ok = deepEqual(a, toJson(b));
  return { ok, message: `${describeValue(a)} ${ok ? '=' : '≠'} ${describeValue(b)}` };
}

/**
 * Compare a normalized value. Throws NormalizeError('type_mismatch') when the
 * operator cannot apply to the value's type (=> abstain).
 */
export function compare(v: TypedValue, cmp: Comparison): CompareOutcome {
  const shown = describeValue(v);
  try {
    if ('sameAs' in cmp)
      throw new NormalizeError('sameAs compares with a second source; the evaluator reads it', 'type_mismatch');
    if ('equals' in cmp) {
      const ok = deepEqual(v, cmp.equals);
      return { ok, message: `${shown} ${ok ? '=' : '≠'} ${JSON.stringify(cmp.equals)}` };
    }
    if ('oneOf' in cmp) {
      const ok = cmp.oneOf.some((e) => deepEqual(v, e));
      return { ok, message: `${shown} ${ok ? 'is' : 'is not'} one of ${JSON.stringify(cmp.oneOf)}` };
    }
    if ('contains' in cmp) {
      if (v.type !== 'string') throw mismatch('contains', v);
      const a = canonical(v.value);
      const e = canonical(cmp.contains);
      const ok = cmp.ignoreCase ? a.toLowerCase().includes(e.toLowerCase()) : a.includes(e);
      return { ok, message: `${shown} ${ok ? 'contains' : 'does not contain'} ${JSON.stringify(cmp.contains)}` };
    }
    if ('regex' in cmp) {
      if (v.type !== 'string') throw mismatch('regex', v);
      const ok = new RegExp(cmp.regex, stripGlobal(cmp.flags)).test(canonical(v.value));
      return { ok, message: `${shown} ${ok ? 'matches' : 'does not match'} /${cmp.regex}/${cmp.flags ?? ''}` };
    }
    if ('approx' in cmp) {
      const { value: target, abs = 0, rel = 0 } = cmp.approx;
      let diff: number;
      let ref: number;
      if (v.type === 'date') {
        if (typeof target !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(target)) throw mismatch('approx', v);
        diff = daysBetween(v.value, target);
        ref = 0;
      } else if (v.type === 'datetime') {
        if (typeof target !== 'string' || instantOf(target) === undefined) throw mismatch('approx', v);
        diff = minutesBetween(v.value, target);
        ref = 0;
      } else {
        const [a, b] = scalar(v, target, 'approx');
        diff = Math.abs(a - b);
        ref = Math.abs(b);
      }
      const tol = Math.max(abs, rel * ref) + 1e-9;
      const ok = diff <= tol;
      return {
        ok,
        message: `${shown} ${ok ? '≈' : '≉'} ${JSON.stringify(target)} (Δ=${+diff.toFixed(6)}, tolerance ${Math.max(abs, rel * ref)}${v.type === 'date' ? ' days' : v.type === 'datetime' ? ' minutes' : ''})`,
      };
    }
    if ('schema' in cmp) {
      const fn = compileSchema(cmp.schema);
      const ok = fn(v.type === 'money' ? { ...v.value } : v.value) as boolean;
      return { ok, message: ok ? `${shown.slice(0, 120)} matches schema` : `schema mismatch: ${schemaErrors(fn)}` };
    }
    if ('exists' in cmp) {
      const ok = !(v.type === 'string' && canonical(v.value) === '') && !(v.type === 'json' && v.value === null);
      return { ok, message: ok ? `${shown} is present` : 'value is empty' };
    }
    // Range: gt/gte/lt/lte (any combination)
    const parts: string[] = [];
    let ok = true;
    for (const op of ['gt', 'gte', 'lt', 'lte'] as const) {
      const bound = (cmp as Record<string, unknown>)[op];
      if (bound === undefined) continue;
      const [a, b] = scalar(v, bound, op);
      const r = op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
      ok &&= r;
      parts.push(`${{ gt: '>', gte: '≥', lt: '<', lte: '≤' }[op]} ${JSON.stringify(bound)}`);
    }
    if (!parts.length) throw new NormalizeError('empty comparison', 'type_mismatch');
    return { ok, message: `${shown} ${ok ? 'is' : 'is not'} ${parts.join(' and ')}` };
  } catch (e) {
    if (e instanceof CurrencyMismatch) return { ok: false, message: `${shown}: ${e.message}` };
    throw e;
  }
}

export function compareNumber(
  n: number,
  c: { eq?: number; gt?: number; gte?: number; lt?: number; lte?: number },
): boolean {
  if (c.eq !== undefined && n !== c.eq) return false;
  if (c.gt !== undefined && !(n > c.gt)) return false;
  if (c.gte !== undefined && !(n >= c.gte)) return false;
  if (c.lt !== undefined && !(n < c.lt)) return false;
  if (c.lte !== undefined && !(n <= c.lte)) return false;
  return true;
}

export function describeNumberCompare(c: {
  eq?: number;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
}): string {
  const parts: string[] = [];
  if (c.eq !== undefined) parts.push(`exactly ${c.eq}`);
  if (c.gt !== undefined) parts.push(`more than ${c.gt}`);
  if (c.gte !== undefined) parts.push(`at least ${c.gte}`);
  if (c.lt !== undefined) parts.push(`fewer than ${c.lt}`);
  if (c.lte !== undefined) parts.push(`at most ${c.lte}`);
  return parts.join(' and ') || 'any number';
}

export { compileSchema, jsonPointer, schemaErrors } from './json.ts';
