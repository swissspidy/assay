/**
 * Comparison-aware near misses. Given what a check compares a value against,
 * produce replacement values that violate it, and render them back in the
 * page's own format.
 */
import type { Comparison, Json, Money } from '../types.ts';
import { compare } from '../runtime/compare.ts';
import { NormalizeError, instantOf, zoneOffset, type TypedValue } from '../runtime/values.ts';
import { nearMiss, shiftDate, shiftInstant } from './edit.ts';
import { schemaViolations } from './schema.ts';

const isMoney = (x: unknown): x is Money =>
  !!x && typeof x === 'object' && typeof (x as Money).amount === 'number' && typeof (x as Money).currency === 'string';

/** Point comparisons pin one value (or a small set): any other value is a near miss. */
export function isPointComparison(cmp: Comparison): boolean {
  return 'equals' in cmp || 'oneOf' in cmp || 'approx' in cmp;
}

function bounds(cmp: Comparison): unknown[] {
  if ('equals' in cmp) return [cmp.equals];
  if ('oneOf' in cmp) return cmp.oneOf;
  if ('approx' in cmp) return [cmp.approx.value];
  return ['gt', 'gte', 'lt', 'lte'].map((k) => (cmp as Record<string, unknown>)[k]).filter((x) => x !== undefined);
}

function tolerance(cmp: Comparison, ref: number): number {
  return 'approx' in cmp ? Math.max(cmp.approx.abs ?? 0, (cmp.approx.rel ?? 0) * Math.abs(ref)) : 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Generic near misses of a value (used for point comparisons: a check accepting them is lenient). */
export function genericNearMisses(v: TypedValue): TypedValue[] {
  switch (v.type) {
    case 'number':
      return [v.value + 1, v.value * 10].map((value) => ({ type: 'number', value }));
    case 'money':
      return [round2(v.value.amount + 0.01), round2(v.value.amount + 1), round2(v.value.amount * 10)].map((amount) => ({
        type: 'money',
        value: { ...v.value, amount },
      }));
    case 'date':
      return [{ type: 'date', value: shiftDate(v.value, 1) }];
    case 'datetime':
      return [60, 24 * 60].map((m) => ({ type: 'datetime', value: shiftInstant(v.value, m) }));
    case 'boolean':
      return [{ type: 'boolean', value: !v.value }];
    case 'string': {
      const m = nearMiss(v.value);
      return typeof m === 'string' ? [{ type: 'string', value: m }] : [];
    }
    case 'json': {
      const m = nearMiss(v.value);
      return m === undefined ? [] : [{ type: 'json', value: m }];
    }
  }
}

function candidates(v: TypedValue, cmp: Comparison): TypedValue[] {
  const out: TypedValue[] = [...genericNearMisses(v)];
  const bs = bounds(cmp);
  switch (v.type) {
    case 'number': {
      for (const b of bs) {
        if (typeof b !== 'number') continue;
        const t = tolerance(cmp, b) + 1;
        out.push(...[b + t, b - t, b + 1, b - 1].map((value) => ({ type: 'number' as const, value })));
      }
      out.push({ type: 'number', value: v.value - 1 });
      break;
    }
    case 'money': {
      for (const b of bs) {
        const amount = isMoney(b) ? b.amount : typeof b === 'number' ? b : undefined;
        if (amount === undefined) continue;
        const t = tolerance(cmp, amount) + 0.01;
        for (const a of [amount + t, amount - t, amount + 1, amount - 1])
          out.push({ type: 'money', value: { ...v.value, amount: round2(a) } });
      }
      out.push({
        type: 'money',
        value: { amount: v.value.amount, currency: v.value.currency === 'EUR' ? 'USD' : 'EUR' },
      });
      break;
    }
    case 'date': {
      for (const b of bs) {
        if (typeof b !== 'string') continue;
        const t = Math.ceil(tolerance(cmp, 0)) + 1;
        out.push(...[shiftDate(b, t), shiftDate(b, -t)].map((value) => ({ type: 'date' as const, value })));
      }
      out.push({ type: 'date', value: shiftDate(v.value, -1) });
      break;
    }
    case 'datetime': {
      // Past the tolerance (in minutes) on either side of each bound.
      for (const b of bs) {
        const t = typeof b === 'string' ? instantOf(b) : undefined;
        if (t === undefined) continue;
        const iso = new Date(t).toISOString();
        const m = Math.ceil(tolerance(cmp, 0)) + 1;
        out.push(
          ...[shiftInstant(iso, m), shiftInstant(iso, -m)].map((value) => ({ type: 'datetime' as const, value })),
        );
      }
      out.push({ type: 'datetime', value: shiftInstant(v.value, -60) });
      break;
    }
    case 'string': {
      if ('contains' in cmp) {
        const m = nearMiss(cmp.contains);
        if (typeof m === 'string') out.push({ type: 'string', value: v.value.split(cmp.contains).join(m) });
        if (cmp.ignoreCase) {
          const re = new RegExp(cmp.contains.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
          out.push({ type: 'string', value: v.value.replace(re, (x) => String(nearMiss(x))) });
        }
      }
      if ('regex' in cmp) {
        const re = new RegExp(cmp.regex, (cmp.flags ?? '').replace(/[gy]/g, ''));
        const m = re.exec(v.value);
        if (m) {
          out.push({ type: 'string', value: v.value.replace(m[0], () => m[0].replace(/[\p{L}\p{N}]/gu, 'x')) });
          out.push({ type: 'string', value: '' });
        }
      }
      for (const b of bs) {
        const m = typeof b === 'string' ? nearMiss(b) : undefined;
        if (typeof m === 'string') out.push({ type: 'string', value: m });
      }
      break;
    }
    case 'json':
      if ('schema' in cmp)
        out.push(...schemaViolations(cmp.schema, v.value).map((x) => ({ type: 'json' as const, value: x.value })));
      break;
    default:
      break;
  }
  return out;
}

const key = (v: TypedValue) => JSON.stringify(v);

/** Values that violate `cmp` (verified with the real comparison), plus — for point comparisons — generic near misses. */
export function violations(v: TypedValue, cmp: Comparison): { value: TypedValue; lenientProbe: boolean }[] {
  const seen = new Set<string>([key(v)]);
  const out: { value: TypedValue; lenientProbe: boolean }[] = [];
  const point = isPointComparison(cmp);
  const generic = new Set(genericNearMisses(v).map(key));
  for (const c of candidates(v, cmp)) {
    const k = key(c);
    if (seen.has(k)) continue;
    seen.add(k);
    let violates: boolean;
    try {
      violates = !compare(c, cmp).ok;
    } catch (e) {
      if (e instanceof NormalizeError) continue;
      throw e;
    }
    // Generic near misses of point comparisons are kept even when accepted: they probe leniency.
    if (violates || (point && generic.has(k))) out.push({ value: c, lenientProbe: !violates });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering a value back in the page's format
// ---------------------------------------------------------------------------

const NUMBER_IN_TEXT = /\d(?:[\d.,'’\s  ]*\d)?/u;

function formatLike(original: string, n: number, locale: string): string {
  const parts = new Intl.NumberFormat(locale).formatToParts(1234.5);
  const dec = parts.find((p) => p.type === 'decimal')?.value ?? '.';
  const decimals = original.includes(dec) ? (original.split(dec).at(-1)?.replace(/\D/g, '').length ?? 0) : 0;
  const grouped = /\d[^\d]\d{3}(?!\d)/u.test(original.replace(new RegExp(`\\${dec}\\d+$`), ''));
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: grouped,
  }).format(Math.abs(n));
}

function dateLike(original: string, oldIso: string, newIso: string, locale: string): string {
  if (original.includes(oldIso)) return original.replace(oldIso, newIso);
  const d0 = new Date(oldIso + 'T00:00:00Z');
  const d1 = new Date(newIso + 'T00:00:00Z');
  for (const dateStyle of ['full', 'long', 'medium', 'short'] as const) {
    const f = new Intl.DateTimeFormat(locale, { dateStyle, timeZone: 'UTC' });
    if (original.includes(f.format(d0))) return original.replace(f.format(d0), f.format(d1));
  }
  const numeric = new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'UTC',
  });
  if (original.includes(numeric.format(d0))) return original.replace(numeric.format(d0), numeric.format(d1));
  return newIso;
}

// The zone is Z, ±HH:MM, or a UTC/GMT label with an optional offset, as parseDateTime reads them.
const ISO_IN_TEXT =
  /(\d{4}-\d{2}-\d{2})([T ])(\d{2}:\d{2})(:\d{2}(\.\d+)?)?(\s*)(Z|[+-]\d{2}:?\d{2}|(?:UTC|GMT)(?:\s*[+-]\d{1,2}(?::?\d{2})?)?)?(?![\p{L}\d])/iu;

/** The wall clock of instant `t` at a fixed offset (minutes), as ISO fields. */
function isoAtOffset(t: number, offset: number): { date: string; hm: string; s: string; ms: string } {
  const d = new Date(t + offset * 60_000);
  return {
    date: d.toISOString().slice(0, 10),
    hm: d.toISOString().slice(11, 16),
    s: d.toISOString().slice(17, 19),
    ms: d.toISOString().slice(20, 23),
  };
}

/** A formatted string as Intl renders it and with its narrow or no-break spaces as plain spaces. */
const spellings = (x: string) => [...new Set([x, x.replace(/[\u202f\u00a0]/g, ' ')])];

/** Render a new instant in place of the old one, in the format the span uses. */
function datetimeLike(
  span: string,
  oldIso: string,
  newIso: string,
  locale: string,
  timezone?: string,
): string | undefined {
  const t0 = Date.parse(oldIso);
  const t1 = Date.parse(newIso);
  const iso = ISO_IN_TEXT.exec(span);
  if (iso) {
    const [whole, , sep, , sec, frac, gap, zone] = iso;
    let offset: number;
    if (zone === undefined) {
      if (!timezone) return undefined;
      offset = zoneOffset(t1, timezone) / 60_000;
    } else {
      const z = /([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(zone);
      offset = z ? (z[1] === '-' ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3] ?? 0)) : 0; // Z, UTC, GMT
    }
    const f = isoAtOffset(t1, offset);
    const rendered = `${f.date}${sep}${f.hm}${sec !== undefined ? ':' + f.s : ''}${frac !== undefined ? '.' + f.ms.padEnd(frac.length - 1, '0').slice(0, frac.length - 1) : ''}${gap}${zone ?? ''}`;
    return span.replace(whole, () => rendered);
  }
  if (!timezone) return undefined;
  // Localized: replace the time of day and, if it changed, the date, each in the style found.
  const fmt = (o: Intl.DateTimeFormatOptions, t: number) =>
    new Intl.DateTimeFormat(locale, { ...o, timeZone: timezone }).format(t);
  let out = span;
  let timeDone = false;
  for (const timeStyle of ['medium', 'short'] as const) {
    const from = spellings(fmt({ timeStyle }, t0)).find((x) => out.includes(x));
    if (!from) continue;
    out = out.replace(from, () => fmt({ timeStyle }, t1));
    timeDone = true;
    break;
  }
  if (!timeDone) return undefined;
  const styles: Intl.DateTimeFormatOptions[] = [
    ...(['full', 'long', 'medium', 'short'] as const).map((dateStyle) => ({ dateStyle })),
    { year: 'numeric', month: '2-digit', day: '2-digit' },
  ];
  for (const o of styles) {
    const before = fmt(o, t0);
    const after = fmt(o, t1);
    const from = spellings(before).find((x) => out.includes(x));
    if (from) return before === after ? out : out.replace(from, () => after);
  }
  // No date found in a known style: only a change within the same day can be rendered.
  return fmt(styles.at(-1)!, t0) === fmt(styles.at(-1)!, t1) ? out : undefined;
}

/**
 * Render `next` in place of the value read from `span` (number/money keep the
 * original decimals, grouping and surrounding symbols; dates keep their style).
 * Returns undefined when it cannot be rendered faithfully.
 */
export function renderLike(
  span: string,
  prev: TypedValue,
  next: TypedValue,
  locale: string | undefined,
  timezone?: string,
): string | undefined {
  const loc = locale ?? 'en-US';
  if ((next.type === 'number' || next.type === 'money') && (prev.type === 'number' || prev.type === 'money')) {
    const amount = next.type === 'money' ? next.value.amount : next.value;
    if (next.type === 'money' && prev.type === 'money' && next.value.currency !== prev.value.currency) {
      return new Intl.NumberFormat(loc, { style: 'currency', currency: next.value.currency }).format(amount);
    }
    const m = NUMBER_IN_TEXT.exec(span);
    if (!m) return undefined;
    // Only a minus next to the number, past spaces and currency symbols ("-12", "-$12",
    // "12-"), is its sign; a hyphen elsewhere in the span ("Order A-7: 12") is not.
    let prefix = span.slice(0, m.index);
    let suffix = span.slice(m.index + m[0].length);
    const leading = /[-−](?=[\s\p{Sc}]*$)/u.exec(prefix);
    const trailing = /^[\s\p{Sc}]*[-−]/u.exec(suffix);
    let sign = '';
    if (amount < 0) sign = leading || trailing ? '' : '-';
    else if (leading) prefix = prefix.slice(0, leading.index) + prefix.slice(leading.index + 1);
    else if (trailing) suffix = suffix.slice(0, trailing[0].length - 1) + suffix.slice(trailing[0].length);
    return prefix + sign + formatLike(m[0], amount, loc) + suffix;
  }
  if (next.type === 'date' && prev.type === 'date') return dateLike(span, prev.value, next.value, loc);
  if (next.type === 'datetime' && prev.type === 'datetime')
    return datetimeLike(span, prev.value, next.value, loc, timezone);
  if (next.type === 'boolean') {
    const yes = /^(yes|no)$/i.test(span.trim())
      ? ['yes', 'no']
      : /^(on|off)$/i.test(span.trim())
        ? ['on', 'off']
        : ['true', 'false'];
    return next.value ? yes[0] : yes[1];
  }
  if (next.type === 'string') return next.value;
  if (next.type === 'json') return JSON.stringify(next.value as Json);
  return undefined;
}
