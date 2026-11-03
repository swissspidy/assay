import type { Json, Money, Normalizer } from '../types.js';
import { canonical, stripGlobal } from '../text.js';

/** A typed value flowing through the normalizer pipeline. */
export type TypedValue =
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'money'; value: Money }
  | { type: 'date'; value: string } // YYYY-MM-DD
  | { type: 'json'; value: Json }; // null, objects, arrays

export class NormalizeError extends Error {
  constructor(
    message: string,
    readonly reason: 'normalize_failed' | 'type_mismatch',
  ) {
    super(message);
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
  let v = input;
  for (const step of steps ?? [])
    v = applyOne(v, typeof step === 'string' ? ({ op: step } as Exclude<Normalizer, string>) : step);
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
      const m = new RegExp(step.regex, stripGlobal(step.flags)).exec(s);
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
      return { type: 'string', value: asString(v, step.op).replace(new RegExp(step.regex, flags), step.with) };
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
  }
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
  const re = new RegExp(`^(?:(${grouped})|(\\d+))?(?:${D}(\\d+))?$`, 'u');
  const m = re.exec(s);
  if (!m || (!m[1] && !m[2] && !m[3])) throw fail();
  const intPart = (m[1] ?? m[2] ?? '0').replace(new RegExp(G, 'gu'), '');
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

function isoDate(y: number, m: number, d: number, raw: string): string {
  const fail = new NormalizeError(`date: invalid calendar date in ${JSON.stringify(raw)}`, 'normalize_failed');
  if (m < 1 || m > 12 || d < 1) throw fail;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > dim) throw fail;
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

  const dl = dateLocale(locale);
  const tokens = foldName(s)
    .replace(/(\d+)(st|nd|rd|th)\b/g, '$1')
    .split(/[\s,/.-]+/u)
    .filter(Boolean)
    .filter((t) => !dl.weekdays.has(t) && !FILLER.has(t));

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
