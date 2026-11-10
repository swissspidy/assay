import type { Json, Money, Normalizer } from '../types.ts';
import { canonical, stripGlobal } from '../text.ts';
import { canonicalJson } from '../snapshot/digest.ts';
import { compileSchema, jsonPointer } from './json.ts';
import { regExp } from './once.ts';

/** A typed value flowing through the normalizer pipeline. */
export type TypedValue =
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'money'; value: Money }
  | { type: 'date'; value: string } // YYYY-MM-DD
  | { type: 'datetime'; value: string } // an instant in UTC: YYYY-MM-DDTHH:MM:SS[.sss]Z
  | { type: 'json'; value: Json }; // null, objects, arrays

export class NormalizeError extends Error {
  readonly reason: 'normalize_failed' | 'type_mismatch';
  constructor(message: string, reason: 'normalize_failed' | 'type_mismatch') {
    super(message);
    this.reason = reason;
  }
}

export function fromJson(v: Json): TypedValue {
  if (typeof v === 'string') return { type: 'string', value: v };
  if (typeof v === 'number') return { type: 'number', value: v };
  if (typeof v === 'boolean') return { type: 'boolean', value: v };
  return { type: 'json', value: v };
}

export function toJson(v: TypedValue): Json {
  return v.type === 'money' ? { amount: v.value.amount, currency: v.value.currency } : v.value;
}

export function describeValue(v: TypedValue): string {
  switch (v.type) {
    case 'money':
      return `${v.value.amount} ${v.value.currency}`;
    case 'date':
    case 'datetime':
      return v.value;
    default:
      return JSON.stringify(v.value);
  }
}

function asString(v: TypedValue, op: string): string {
  if (v.type === 'string') return v.value;
  if (v.type === 'number' || v.type === 'boolean') return String(v.value);
  throw new NormalizeError(`${op} expects text, got ${v.type}`, 'type_mismatch');
}

export function normalizerName(n: Normalizer): string {
  return typeof n === 'string' ? n : n.op;
}

export function applyNormalizers(input: TypedValue, steps: Normalizer[] | undefined): TypedValue {
  return applySteps(input, resolveNormalizers(steps));
}

/** A normalizer step with its options: a bare name becomes `{ op: name }`. */
export type NormalizerStep = Exclude<Normalizer, string>;

/** A normalizer chain resolved once (ADR 0015), to run with `applySteps`. */
export function resolveNormalizers(steps: Normalizer[] | undefined): NormalizerStep[] {
  const out: NormalizerStep[] = [];
  for (const step of steps ?? []) out.push(typeof step === 'string' ? ({ op: step } as NormalizerStep) : step);
  return out;
}

export function applySteps(input: TypedValue, steps: readonly NormalizerStep[]): TypedValue {
  let v = input;
  for (const step of steps) v = applyOne(v, step);
  return v;
}

function applyOne(v: TypedValue, step: Exclude<Normalizer, string>): TypedValue {
  switch (step.op) {
    case 'trim':
      return { type: 'string', value: asString(v, step.op).trim() };
    case 'collapseWhitespace':
      return { type: 'string', value: asString(v, step.op).replace(/\s+/gu, ' ').trim() };
    case 'lowercase':
      return { type: 'string', value: asString(v, step.op).toLowerCase() };
    case 'uppercase':
      return { type: 'string', value: asString(v, step.op).toUpperCase() };
    case 'nfkc':
      return { type: 'string', value: asString(v, step.op).normalize('NFKC') };
    case 'stripDiacritics':
      return { type: 'string', value: asString(v, step.op).normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC') };
    case 'extract': {
      const s = asString(v, step.op);
      const m = regExp(step.regex, stripGlobal(step.flags)).exec(s);
      if (!m)
        throw new NormalizeError(`extract: /${step.regex}/ does not match ${JSON.stringify(s)}`, 'normalize_failed');
      const g = step.group ?? (m.length > 1 ? 1 : 0);
      const out = typeof g === 'number' ? m[g] : m.groups?.[g];
      if (out === undefined)
        throw new NormalizeError(`extract: group ${g} did not participate in the match`, 'normalize_failed');
      return { type: 'string', value: out };
    }
    case 'replace': {
      const flags = step.flags ?? 'g';
      return { type: 'string', value: asString(v, step.op).replace(regExp(step.regex, flags), step.with) };
    }
    case 'json': {
      const s = asString(v, step.op);
      try {
        return fromJson(JSON.parse(s) as Json);
      } catch {
        throw new NormalizeError(`json: cannot parse ${JSON.stringify(s.slice(0, 80))}`, 'normalize_failed');
      }
    }
    case 'boolean': {
      if (v.type === 'boolean') return v;
      const s = canonical(asString(v, step.op)).toLowerCase();
      if (['true', 'yes', 'on', '1'].includes(s)) return { type: 'boolean', value: true };
      if (['false', 'no', 'off', '0'].includes(s)) return { type: 'boolean', value: false };
      throw new NormalizeError(`boolean: cannot interpret ${JSON.stringify(s)}`, 'normalize_failed');
    }
    case 'number':
      if (v.type === 'number') return v;
      return { type: 'number', value: parseLocaleNumber(asString(v, step.op), step.locale) };
    case 'currency':
      if (v.type === 'money') return v;
      if (v.type === 'number') {
        if (!step.currency) throw new NormalizeError('currency: bare number and no currency given', 'normalize_failed');
        return { type: 'money', value: { amount: v.value, currency: step.currency } };
      }
      return { type: 'money', value: parseCurrency(asString(v, step.op), step.locale, step.currency) };
    case 'date':
      if (v.type === 'date') return v;
      return { type: 'date', value: parseDate(asString(v, step.op), step.locale, step.timezone) };
    case 'datetime':
      if (v.type === 'datetime') return v;
      return { type: 'datetime', value: parseDateTime(asString(v, step.op), step.locale, step.timezone) };
    case 'items':
      return { type: 'json', value: items(v, step) };
  }
}

/**
 * An array as an unordered collection: the items matching `where` (a JSON Schema),
 * each mapped to the value at `pointer`, or to an object of the values at the `pick`
 * pointers (keyed by pointer, so the fields of one item stay together), sorted by
 * canonical JSON. Two collections are then equal when they hold the same items, in
 * any order, with repeats counted.
 */
function items(v: TypedValue, step: Extract<Normalizer, { op: 'items' }>): Json[] {
  if (v.type !== 'json' || !Array.isArray(v.value))
    throw new NormalizeError(
      `items expects a JSON array, got ${v.type === 'json' ? describeValue(v) : v.type}`,
      'type_mismatch',
    );
  const keep = step.where === undefined ? undefined : compileSchema(step.where);
  const field = (item: Json, pointer: string | undefined, i: number): Json => {
    const x = jsonPointer(item, pointer);
    if (x === undefined) throw new NormalizeError(`items: ${pointer} not present in item ${i}`, 'normalize_failed');
    return x;
  };
  const out: Json[] = [];
  for (const [i, item] of v.value.entries()) {
    if (keep && !keep(item)) continue;
    const x = step.pick
      ? Object.fromEntries(step.pick.map((p) => [p, field(item, p, i)]))
      : field(item, step.pointer, i);
    if (!step.flatten) {
      out.push(x);
      continue;
    }
    // flatten: the field is a collection of its own (a post's tags); its members are the items.
    if (!Array.isArray(x))
      throw new NormalizeError(
        `items: flatten needs an array at ${step.pointer ?? '/'} of item ${i}, got ${describeValue({ type: 'json', value: x })}`,
        'type_mismatch',
      );
    out.push(...x);
  }
  return out
    .map((x) => [canonicalJson(x), x] as const)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, x]) => x);
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Separators {
  group: string[];
  decimal: string;
  twoDigitGroups: boolean;
}

const sepCache = new Map<string, Separators>();

function separators(locale: string): Separators {
  const cached = sepCache.get(locale);
  if (cached) return cached;
  let parts: Intl.NumberFormatPart[];
  try {
    parts = new Intl.NumberFormat(locale, { useGrouping: true }).formatToParts(1234567.5);
  } catch {
    throw new NormalizeError(`unknown locale ${JSON.stringify(locale)}`, 'normalize_failed');
  }
  const groupSym = parts.find((p) => p.type === 'group')?.value ?? ',';
  const decimal = parts.find((p) => p.type === 'decimal')?.value ?? '.';
  const group = [groupSym];
  if (/[   ]/.test(groupSym)) group.push(' ', ' ', ' ');
  if (groupSym === '’' || groupSym === "'") group.push("'", '’');
  const intGroups = parts.filter((p) => p.type === 'integer').map((p) => p.value.length);
  const s: Separators = {
    group: [...new Set(group)],
    decimal,
    twoDigitGroups: intGroups.includes(2) && intGroups.length > 2,
  };
  sepCache.set(locale, s);
  return s;
}

/** Strictly parse a localized number; the whole string must be the number. */
export function parseLocaleNumber(raw: string, locale: string): number {
  let s = canonical(raw.normalize('NFKC')).replace(/−/g, '-');
  const fail = () => new NormalizeError(`number(${locale}): cannot parse ${JSON.stringify(raw)}`, 'normalize_failed');
  let negative = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) {
    negative = true;
    s = paren[1]!.trim();
  }
  if (s.startsWith('-') || s.startsWith('+')) {
    negative = negative !== (s[0] === '-');
    s = s.slice(1).trim();
  }
  if (s.endsWith('-') && !negative) {
    negative = true;
    s = s.slice(0, -1).trim();
  }
  const { group, decimal, twoDigitGroups } = separators(locale);
  const G = `(?:${group.map(escapeRe).join('|')})`;
  const D = escapeRe(decimal);
  const grouped = twoDigitGroups ? `\\d{1,2}(?:${G}\\d{2})*${G}\\d{3}` : `\\d{1,3}(?:${G}\\d{3})+`;
  const re = regExp(`^(?:(${grouped})|(\\d+))?(?:${D}(\\d+))?$`, 'u');
  const m = re.exec(s);
  if (!m || (!m[1] && !m[2] && !m[3])) throw fail();
  const intPart = (m[1] ?? m[2] ?? '0').replace(regExp(G, 'gu'), '');
  const n = Number(`${intPart}.${m[3] ?? '0'}`);
  if (!Number.isFinite(n)) throw fail();
  return negative ? -n : n;
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

const SYMBOLS: Record<string, string[]> = {
  US$: ['USD'],
  CA$: ['CAD'],
  C$: ['CAD'],
  AU$: ['AUD'],
  A$: ['AUD'],
  NZ$: ['NZD'],
  HK$: ['HKD'],
  S$: ['SGD'],
  R$: ['BRL'],
  MX$: ['MXN'],
  $: ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'MXN'],
  '€': ['EUR'],
  '£': ['GBP'],
  '¥': ['JPY', 'CNY'],
  '￥': ['JPY', 'CNY'],
  '₹': ['INR'],
  '₩': ['KRW'],
  '₽': ['RUB'],
  '₺': ['TRY'],
  '₪': ['ILS'],
  '฿': ['THB'],
  '₫': ['VND'],
  '₱': ['PHP'],
  zł: ['PLN'],
  'Fr.': ['CHF'],
  'kr.': ['DKK'],
  kr: ['SEK', 'NOK', 'DKK', 'ISK'],
};
const SYMBOL_KEYS = Object.keys(SYMBOLS).toSorted((a, b) => b.length - a.length);

export function parseCurrency(raw: string, locale: string, declared?: string): Money {
  let s = canonical(raw.normalize('NFC')).replace(/−/g, '-');
  const fail = (why: string) =>
    new NormalizeError(`currency(${locale}): ${why} in ${JSON.stringify(raw)}`, 'normalize_failed');
  let sign = '';
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) {
    sign = '-';
    s = paren[1]!.trim();
  }
  if (/^[-+]/.test(s)) {
    if (s[0] === '-') sign = sign ? '' : '-';
    s = s.slice(1).trim();
  }
  let candidates: string[] | null = null;
  let symbol = '';
  const code = /^([A-Z]{3})(?![A-Za-z])\s*|\s*(?<![A-Za-z])([A-Z]{3})$/.exec(s);
  if (code) {
    symbol = (code[1] ?? code[2])!;
    candidates = [symbol];
    s = (s.slice(0, code.index) + s.slice(code.index + code[0].length)).trim();
  } else {
    for (const sym of SYMBOL_KEYS) {
      if (s.startsWith(sym)) {
        symbol = sym;
        s = s.slice(sym.length).trim();
      } else if (s.endsWith(sym)) {
        symbol = sym;
        s = s.slice(0, -sym.length).trim();
      } else continue;
      candidates = SYMBOLS[sym]!;
      break;
    }
  }
  if (/^[-+]/.test(s)) {
    if (s[0] === '-') sign = sign ? '' : '-';
    s = s.slice(1).trim();
  }
  const amount = parseLocaleNumber(sign + s, locale);
  let currency: string;
  if (!candidates) {
    if (!declared) throw fail('no currency marker and no currency declared');
    currency = declared;
  } else if (declared && candidates.includes(declared)) currency = declared;
  else if (candidates.length === 1) currency = candidates[0]!;
  else if (declared) currency = symbol; // contradicts declared; comparison will fail
  else throw fail(`ambiguous currency symbol ${JSON.stringify(symbol)} (declare a currency)`);
  return { amount, currency };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const FILLER = new Set(['of', 'de', 'del', 'the', 'den', 'am', 'le']);

interface DateLocale {
  months: Map<string, number>;
  weekdays: Set<string>;
  order: ('day' | 'month' | 'year')[];
}
const dateLocaleCache = new Map<string, DateLocale>();

const foldName = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\.$/, '');

function dateLocale(locale: string): DateLocale {
  const cached = dateLocaleCache.get(locale);
  if (cached) return cached;
  let numeric: Intl.DateTimeFormat;
  try {
    numeric = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' });
  } catch {
    throw new NormalizeError(`unknown locale ${JSON.stringify(locale)}`, 'normalize_failed');
  }
  const months = new Map<string, number>();
  const weekdays = new Set<string>();
  for (const loc of new Set([locale, 'en'])) {
    for (let m = 0; m < 12; m++) {
      const d = new Date(Date.UTC(2024, m, 15));
      for (const style of ['long', 'short'] as const) {
        months.set(foldName(new Intl.DateTimeFormat(loc, { month: style, timeZone: 'UTC' }).format(d)), m + 1);
        // Genitive forms (e.g. Slavic languages) appear when formatted with a day.
        const parts = new Intl.DateTimeFormat(loc, { month: style, day: 'numeric', timeZone: 'UTC' }).formatToParts(d);
        const mp = parts.find((p) => p.type === 'month');
        if (mp) months.set(foldName(mp.value), m + 1);
      }
    }
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.UTC(2024, 0, 7 + i));
      for (const style of ['long', 'short'] as const)
        weekdays.add(foldName(new Intl.DateTimeFormat(loc, { weekday: style, timeZone: 'UTC' }).format(d)));
    }
  }
  months.set('sept', 9);
  const order = numeric
    .formatToParts(new Date(Date.UTC(2024, 10, 22)))
    .filter((p) => p.type === 'day' || p.type === 'month' || p.type === 'year')
    .map((p) => p.type as 'day' | 'month' | 'year');
  const dl = { months, weekdays, order };
  dateLocaleCache.set(locale, dl);
  return dl;
}

/**
 * Date.UTC with the year taken literally: Date.UTC maps years 0-99 to 1900-1999.
 * Month is 0-based; out-of-range fields roll over as in Date.UTC.
 */
export function utcTime(y: number, month0: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number {
  const t = new Date(Date.UTC(2000, 0, 1, h, mi, s, ms));
  t.setUTCFullYear(y, month0, d);
  return t.getTime();
}

function isoDate(y: number, m: number, d: number, raw: string): string {
  // Made only when thrown: an error captures a stack trace, which costs more than the parse.
  const fail = () => new NormalizeError(`date: invalid calendar date in ${JSON.stringify(raw)}`, 'normalize_failed');
  if (m < 1 || m > 12 || d < 1) throw fail();
  const dim = new Date(utcTime(y, m, 0)).getUTCDate();
  if (d > dim) throw fail();
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Parse a date to YYYY-MM-DD. Never consults the clock or the host locale/timezone. */
export function parseDate(raw: string, locale: string, timezone?: string): string {
  const s = canonical(raw.normalize('NFKC'));
  const fail = (why: string) =>
    new NormalizeError(`date(${locale}): ${why}: ${JSON.stringify(raw)}`, 'normalize_failed');

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(
    s,
  );
  if (iso) {
    const [, y, mo, d, hh, , , zone] = iso;
    if (hh !== undefined && zone !== undefined) {
      if (!timezone) throw fail('datetime with offset requires a timezone');
      const t = Date.parse(s.replace(' ', 'T'));
      if (Number.isNaN(t)) throw fail('invalid datetime');
      let parts: Intl.DateTimeFormatPart[];
      try {
        parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).formatToParts(new Date(t));
      } catch {
        throw fail(`unknown timezone ${JSON.stringify(timezone)}`);
      }
      const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
      return isoDate(get('year'), get('month'), get('day'), raw);
    }
    return isoDate(Number(y), Number(mo), Number(d), raw);
  }

  return parseLocalDate(s, raw, locale, FILLER, fail);
}

/** A localized (non-ISO) date: numeric in the locale's field order, or with a month name. */
function parseLocalDate(
  s: string,
  raw: string,
  locale: string,
  filler: Set<string>,
  fail: (why: string) => NormalizeError,
): string {
  const dl = dateLocale(locale);
  const tokens = foldName(s)
    .replace(/(\d+)(st|nd|rd|th)\b/g, '$1')
    .split(/[\s,/.-]+/u)
    .filter(Boolean)
    .filter((t) => !dl.weekdays.has(t) && !filler.has(t));

  let month: number | undefined;
  const nums: string[] = [];
  for (const t of tokens) {
    if (/^\d+$/.test(t)) nums.push(t);
    else if (dl.months.has(t)) {
      if (month !== undefined) throw fail('more than one month name');
      month = dl.months.get(t)!;
    } else throw fail(`unrecognized token ${JSON.stringify(t)}`);
  }

  if (month !== undefined) {
    if (nums.length !== 2) throw fail('expected a day and a four-digit year');
    const year = nums.find((n) => n.length === 4);
    const day = nums.find((n) => n.length <= 2);
    if (!year || !day) throw fail('expected a day and a four-digit year');
    return isoDate(Number(year), month, Number(day), raw);
  }
  if (nums.length !== 3) throw fail('not a recognized date');
  if (nums[0]!.length === 4) return isoDate(Number(nums[0]), Number(nums[1]), Number(nums[2]), raw);
  const f: Record<string, string> = {};
  dl.order.forEach((k, i) => (f[k] = nums[i]!));
  if (f.year!.length !== 4) throw fail('two-digit or misplaced year is ambiguous');
  return isoDate(Number(f.year), Number(f.month), Number(f.day), raw);
}

export function daysBetween(a: string, b: string): number {
  return Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86_400_000;
}

// ---------------------------------------------------------------------------
// Date-times
// ---------------------------------------------------------------------------

/** Words that join a date and a time ("at", "um", "à", "a las", "alle ore", "om", "kl."), after folding. */
const TIME_FILLER = new Set([...FILLER, 'at', 'um', 'a', 'as', 'las', 'alle', 'ore', 'om', 'kl', 'klo', 'o']);

const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const TIME_OF_DAY = /(?<![\d:.+-])(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?\s?m\.?(?![\p{L}]))?(?![\d:])/giu;
const ZONE = /(?<![\p{L}\d])(?:(?:UTC|GMT)(?:\s*([+-])(\d{1,2})(?::?(\d{2}))?)?|([+-])(\d{2}):(\d{2}))(?![\p{L}\d])/giu;

/** An ISO 8601 date-time with an explicit offset ("Z" or ±HH:MM), as used for literals in comparisons. */
export const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Milliseconds since the epoch of an ISO instant literal, or undefined if it is not one. */
export function instantOf(s: string): number | undefined {
  // Date.parse only checks the shape: it rolls "2026-02-30" into March and accepts "24:00".
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(s);
  if (!m) return undefined;
  const [, y, mo, d, hh, mm, ss, frac, sign, oh, om] = m;
  const day = Number(d);
  if (Number(mo) < 1 || Number(mo) > 12 || day < 1) return undefined;
  if (day > new Date(utcTime(Number(y), Number(mo), 0)).getUTCDate()) return undefined;
  if (Number(hh) > 23 || Number(mm) > 59 || Number(ss ?? 0) > 59) return undefined;
  const offset = sign ? offsetMinutes(sign, oh!, om) : 0;
  if (Number.isNaN(offset)) return undefined;
  const local = utcTime(Number(y), Number(mo) - 1, day, Number(hh), Number(mm), Number(ss ?? 0));
  return local + (frac ? Math.round(Number(frac) * 1000) : 0) - offset * 60_000;
}

/** A UTC offset in minutes; NaN when out of range (hours above 23 or minutes above 59). */
const offsetMinutes = (sign: string, hh: string, mm = '0') =>
  Number(hh) > 23 || Number(mm) > 59 ? NaN : (sign === '-' ? -1 : 1) * (Number(hh) * 60 + Number(mm));

/** Canonical form of an instant: UTC, milliseconds only when present. */
export function formatInstant(t: number): string {
  return new Date(t).toISOString().replace('.000Z', 'Z');
}

const zoneFormatCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormat(timezone: string): Intl.DateTimeFormat {
  let f = zoneFormatCache.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    zoneFormatCache.set(timezone, f);
  }
  return f;
}

/** The UTC offset of `timezone` at instant `t`, in milliseconds. */
export function zoneOffset(t: number, timezone: string): number {
  const parts = zoneFormat(timezone).formatToParts(new Date(t));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const local = utcTime(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return local - Math.floor(t / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `timezone` shows `local` (a UTC timestamp of the
 * local fields). Throws when that wall time is skipped or repeated by a DST change.
 */
function zonedInstant(local: number, timezone: string, fail: (why: string) => NormalizeError): number {
  let offsets: Set<number>;
  try {
    offsets = new Set([local - 36 * 3_600_000, local, local + 36 * 3_600_000].map((t) => zoneOffset(t, timezone)));
  } catch {
    throw fail(`unknown timezone ${JSON.stringify(timezone)}`);
  }
  const hits = [...new Set([...offsets].map((o) => local - o))].filter((t) => zoneOffset(t, timezone) === local - t);
  if (hits.length === 0) throw fail(`the time does not exist in ${timezone} (clocks moved forward)`);
  if (hits.length > 1) throw fail(`the time is ambiguous in ${timezone} (clocks moved back)`);
  return hits[0]!;
}

/**
 * Parse a date-time to an instant in UTC ("YYYY-MM-DDTHH:MM:SSZ"). The value's own offset
 * (ISO "Z"/"±HH:MM", or "UTC"/"GMT±H") decides; without one, `timezone` gives the wall
 * clock's zone. Without either the value is ambiguous and parsing fails.
 */
export function parseDateTime(raw: string, locale: string, timezone?: string): string {
  const s = canonical(raw.normalize('NFKC')).replace(/−/g, '-');
  const fail = (why: string) =>
    new NormalizeError(`datetime(${locale}): ${why}: ${JSON.stringify(raw)}`, 'normalize_failed');
  let date: string;
  let hour: number;
  let minute: number;
  let second = 0;
  let millis = 0;
  let offset: number | undefined;

  const iso = ISO_DATETIME.exec(s);
  if (iso) {
    const [, y, mo, d, hh, mm, ss, frac, zone] = iso;
    date = isoDate(Number(y), Number(mo), Number(d), raw);
    hour = Number(hh);
    minute = Number(mm);
    second = Number(ss ?? 0);
    millis = frac ? Math.round(Number(frac) * 1000) : 0;
    if (zone) {
      const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
      offset = z ? offsetMinutes(z[1]!, z[2]!, z[3]) : 0;
    }
  } else {
    // An ISO date and time followed by a textual zone ("2026-11-05T14:30 UTC"): read the T as a space.
    const text = s.replace(/^(\d{4}-\d{2}-\d{2})T(?=\d)/i, '$1 ');
    const times = [...text.matchAll(TIME_OF_DAY)];
    if (times.length === 0) throw fail('no time of day');
    if (times.length > 1) throw fail('more than one time of day');
    const t = times[0]!;
    hour = Number(t[1]);
    minute = Number(t[2]);
    second = Number(t[3] ?? 0);
    const half = t[4]?.toLowerCase();
    if (half) {
      if (hour < 1 || hour > 12) throw fail('invalid 12-hour time');
      hour = (hour % 12) + (half === 'p' ? 12 : 0);
    }
    let rest = text.slice(0, t.index) + ' ' + text.slice(t.index + t[0].length);
    const zones = [...rest.matchAll(ZONE)];
    if (zones.length > 1) throw fail('more than one UTC offset');
    if (zones[0]) {
      const z = zones[0];
      offset = z[1] ? offsetMinutes(z[1], z[2]!, z[3]) : z[4] ? offsetMinutes(z[4], z[5]!, z[6]) : 0;
      rest = rest.slice(0, z.index) + ' ' + rest.slice(z.index + z[0].length);
    }
    date = parseLocalDate(rest.replace(/[()]/g, ' '), raw, locale, TIME_FILLER, fail);
  }
  if (hour > 23 || minute > 59 || second > 59) throw fail('invalid time of day');
  if (offset !== undefined && Number.isNaN(offset)) throw fail('invalid UTC offset');
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const local = utcTime(y, mo - 1, d, hour, minute, second, millis);
  if (offset !== undefined) return formatInstant(local - offset * 60_000);
  if (!timezone) throw fail('no UTC offset in the value and no timezone given');
  return formatInstant(zonedInstant(local, timezone, fail));
}

export function minutesBetween(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 60_000;
}
