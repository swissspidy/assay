import { test, expect } from '@playwright/test';
import {
  applyNormalizers,
  parseCurrency,
  parseDate,
  parseLocaleNumber,
  NormalizeError,
} from '../../src/runtime/values.ts';

const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof NormalizeError) return e.reason;
    throw e;
  }
  return 'ok';
};

test.describe('number', () => {
  test('locale separators', () => {
    expect(parseLocaleNumber('1,234.5', 'en-US')).toBe(1234.5);
    expect(parseLocaleNumber('1.234,5', 'de-DE')).toBe(1234.5);
    expect(parseLocaleNumber('1 234,5', 'fr-FR')).toBe(1234.5);
    expect(parseLocaleNumber('1 234,5', 'fr-FR')).toBe(1234.5);
    expect(parseLocaleNumber("1'234.5", 'de-CH')).toBe(1234.5);
    expect(parseLocaleNumber('12,34,567', 'en-IN')).toBe(1234567);
    expect(parseLocaleNumber('3', 'en-US')).toBe(3);
    expect(parseLocaleNumber('.5', 'en-US')).toBe(0.5);
  });
  test('signs', () => {
    expect(parseLocaleNumber('-3', 'en-US')).toBe(-3);
    expect(parseLocaleNumber('−3', 'en-US')).toBe(-3);
    expect(parseLocaleNumber('(3.00)', 'en-US')).toBe(-3);
    expect(parseLocaleNumber('+3', 'en-US')).toBe(3);
  });
  test('strict: same text, different locale, different number or failure', () => {
    expect(parseLocaleNumber('1.234', 'en-US')).toBe(1.234);
    expect(parseLocaleNumber('1.234', 'de-DE')).toBe(1234);
    expect(reason(() => parseLocaleNumber('1,23,4', 'en-US'))).toBe('normalize_failed');
    expect(reason(() => parseLocaleNumber('3 items', 'en-US'))).toBe('normalize_failed');
    expect(reason(() => parseLocaleNumber('', 'en-US'))).toBe('normalize_failed');
    expect(reason(() => parseLocaleNumber('N/A', 'en-US'))).toBe('normalize_failed');
  });
});

test.describe('currency', () => {
  test('symbols and codes', () => {
    expect(parseCurrency('$1,234.50', 'en-US', 'USD')).toEqual({ amount: 1234.5, currency: 'USD' });
    expect(parseCurrency('1.234,50 €', 'de-DE')).toEqual({ amount: 1234.5, currency: 'EUR' });
    expect(parseCurrency('EUR 12.00', 'en-US')).toEqual({ amount: 12, currency: 'EUR' });
    expect(parseCurrency('12.00 USD', 'en-US')).toEqual({ amount: 12, currency: 'USD' });
    expect(parseCurrency('CHF 1’234.50', 'de-CH')).toEqual({ amount: 1234.5, currency: 'CHF' });
    expect(parseCurrency('-$5.00', 'en-US', 'USD')).toEqual({ amount: -5, currency: 'USD' });
    expect(parseCurrency('$-5.00', 'en-US', 'USD')).toEqual({ amount: -5, currency: 'USD' });
    expect(parseCurrency('($5.00)', 'en-US', 'USD')).toEqual({ amount: -5, currency: 'USD' });
    expect(parseCurrency('£3', 'en-GB')).toEqual({ amount: 3, currency: 'GBP' });
  });
  test('ambiguous symbol needs a declared currency', () => {
    expect(reason(() => parseCurrency('$5', 'en-US'))).toBe('normalize_failed');
    expect(parseCurrency('$5', 'en-CA', 'CAD')).toEqual({ amount: 5, currency: 'CAD' });
  });
  test('a contradicting symbol yields its own currency (so the comparison fails)', () => {
    expect(parseCurrency('€5', 'en-US', 'USD')).toEqual({ amount: 5, currency: 'EUR' });
  });
  test('bare number uses declared currency', () => {
    expect(parseCurrency('21.50', 'en-US', 'USD')).toEqual({ amount: 21.5, currency: 'USD' });
    expect(reason(() => parseCurrency('21.50', 'en-US'))).toBe('normalize_failed');
  });
});

test.describe('date', () => {
  test('formats', () => {
    expect(parseDate('5 November 2026', 'en-GB')).toBe('2026-11-05');
    expect(parseDate('November 5, 2026', 'en-US')).toBe('2026-11-05');
    expect(parseDate('Thu, 5 Nov 2026', 'en-GB')).toBe('2026-11-05');
    expect(parseDate('5th of November 2026', 'en-GB')).toBe('2026-11-05');
    expect(parseDate('5. November 2026', 'de-DE')).toBe('2026-11-05');
    expect(parseDate('5. März 2026', 'de-DE')).toBe('2026-03-05');
    expect(parseDate('5 de noviembre de 2026', 'es-ES')).toBe('2026-11-05');
    expect(parseDate('2026-11-05', 'en-US')).toBe('2026-11-05');
    expect(parseDate('2026/11/05', 'en-US')).toBe('2026-11-05');
  });
  test('numeric order comes from the locale', () => {
    expect(parseDate('11/05/2026', 'en-US')).toBe('2026-11-05');
    expect(parseDate('05/11/2026', 'en-GB')).toBe('2026-11-05');
    expect(parseDate('05.11.2026', 'de-DE')).toBe('2026-11-05');
  });
  test('datetimes with offsets need a timezone', () => {
    expect(reason(() => parseDate('2026-11-05T23:30:00Z', 'en-US'))).toBe('normalize_failed');
    expect(parseDate('2026-11-05T23:30:00Z', 'en-US', 'Europe/Berlin')).toBe('2026-11-06');
    expect(parseDate('2026-11-05T23:30:00Z', 'en-US', 'UTC')).toBe('2026-11-05');
  });
  test('ambiguous or relative dates abstain', () => {
    expect(reason(() => parseDate('05/11/26', 'en-GB'))).toBe('normalize_failed');
    expect(reason(() => parseDate('tomorrow', 'en-GB'))).toBe('normalize_failed');
    expect(reason(() => parseDate('31 February 2026', 'en-GB'))).toBe('normalize_failed');
    expect(reason(() => parseDate('5 November', 'en-GB'))).toBe('normalize_failed');
  });
});

test('pipeline: extract then number; type mismatch reported', () => {
  const v = applyNormalizers({ type: 'string', value: 'Qty: 1,200 units' }, [
    { op: 'extract', regex: 'Qty: ([\\d,]+)' },
    { op: 'number', locale: 'en-US' },
  ]);
  expect(v).toEqual({ type: 'number', value: 1200 });
  expect(reason(() => applyNormalizers({ type: 'json', value: { a: 1 } }, ['lowercase']))).toBe('type_mismatch');
  expect(reason(() => applyNormalizers({ type: 'string', value: 'abc' }, [{ op: 'extract', regex: '\\d+' }]))).toBe(
    'normalize_failed',
  );
  expect(applyNormalizers({ type: 'string', value: '  Yes ' }, ['boolean'])).toEqual({ type: 'boolean', value: true });
  expect(applyNormalizers({ type: 'string', value: 'Crème Brûlée' }, ['stripDiacritics', 'lowercase'])).toEqual({
    type: 'string',
    value: 'creme brulee',
  });
});
