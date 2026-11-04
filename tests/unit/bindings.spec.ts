/** sameAs bindings and datetime values: evaluation, validation, review text and stress generators. */
import { test, expect } from '@playwright/test';
import {
  applyNormalizers,
  assertionTrust,
  coverage,
  describeAssertion,
  evaluateAssertion,
  generateMutants,
  generateVariants,
  NormalizeError,
  parseDateTime,
  stressTest,
  validateCheckSet,
  type Assertion,
  type AXNode,
  type CheckSet,
  type Comparison,
  type EvidenceSnapshot,
} from '../../src/index.ts';
import { AXIndex } from '../../src/runtime/axindex.ts';
import { renderLike } from '../../src/stress/violate.ts';

const snap = (children: AXNode[], extra: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot => ({
  schema: 'assay.snapshot/v1',
  capturedAt: '',
  page: { url: 'https://shop.test/orders/A1001', title: '' },
  a11y: { role: 'document', children: [{ role: 'main', children }] },
  text: '',
  network: [],
  storage: { cookies: [], local: {}, session: {} },
  probes: {},
  meta: { capturer: 't', redacted: [] },
  ...extra,
});

const one = (assert: Assertion): CheckSet => ({
  schema: 'assay.checks/v1',
  id: 't',
  version: '1',
  task: { instruction: 'Do the thing.' },
  requirements: [{ id: 'R1', kind: 'hard', text: 't', source: { field: 'instruction', quote: 'Do the thing' } }],
  checks: [{ id: 'C1', requirement: 'R1', description: 'd', assert }],
});

const run = (a: Assertion, s: EvidenceSnapshot) => evaluateAssertion({ snapshot: s, index: new AXIndex(s.a11y) }, a);

const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof NormalizeError) return e.reason;
    throw e;
  }
  return 'ok';
};

// The motivating case: the confirmation page's order number is the order the backend has.
const confirmation = (number: string, latest: unknown = { id: 'A1001', status: 'placed' }) =>
  snap([{ role: 'paragraph', children: [{ role: 'text', name: `Order number: ${number}` }] }], {
    probes: { latestOrder: { ok: true, value: latest as never } },
  });
const orderNumber: Assertion = {
  kind: 'value',
  source: { from: 'node', target: { role: 'paragraph', text: { contains: 'Order number' } }, field: 'text' },
  normalize: [{ op: 'extract', regex: 'Order number:\\s*(\\S+)' }],
  expect: { sameAs: { source: { from: 'probe', probe: 'latestOrder', pointer: '/id' } } },
};

test.describe('sameAs', () => {
  test('pass when both sides agree; fail when they differ; evidence shows both values', () => {
    const ok = run(orderNumber, confirmation('A1001'));
    expect(ok.status).toBe('pass');
    expect(ok.evidence.map((e) => [e.channel, e.value])).toEqual([
      ['a11y', 'A1001'],
      ['probe', 'A1001'],
    ]);
    const earlier = run(orderNumber, confirmation('A1000'));
    expect(earlier).toMatchObject({ status: 'fail', message: '"A1000" ≠ "A1001" (probe latestOrder at /id)' });
    expect(earlier.evidence.map((e) => e.value)).toEqual(['A1000', 'A1001']);
  });

  test('either side unreadable → abstain', () => {
    const noProbe = run(orderNumber, snap(confirmation('A1001').a11y.children![0]!.children!));
    expect(noProbe).toMatchObject({ status: 'abstain', reason: 'evidence_unavailable' });
    expect(noProbe.message).toContain('the value to compare with could not be read');
    expect(run(orderNumber, confirmation('A1001', { status: 'placed' }))).toMatchObject({
      status: 'abstain',
      reason: 'value_unavailable',
    });
    expect(run(orderNumber, snap([], { probes: confirmation('A1001').probes }))).toMatchObject({
      status: 'abstain',
      reason: 'anchor_missing',
    });
    // A value that reads but differs is a failure, not an abstention.
    expect(run(orderNumber, confirmation('—')).status).toBe('fail');
  });

  test('types must agree at run time; normalizers apply to each side', () => {
    const numeric = confirmation('1001', { id: 1001 });
    expect(run(orderNumber, numeric)).toMatchObject({ status: 'abstain', reason: 'type_mismatch' });
    const both: Assertion = {
      ...orderNumber,
      normalize: [...orderNumber.normalize!, { op: 'number', locale: 'en-US' }],
    };
    expect(run(both, numeric).status).toBe('pass');
    expect(run(both, confirmation('1002', { id: 1001 })).status).toBe('fail');
    // Money and dates compare after their own normalizers, in different formats.
    const total: Assertion = {
      kind: 'value',
      source: { from: 'node', target: { role: 'status' }, field: 'text' },
      normalize: [{ op: 'currency', locale: 'de-DE' }],
      expect: {
        sameAs: {
          source: { from: 'probe', probe: 'order', pointer: '/total' },
          normalize: [{ op: 'currency', locale: 'en-US', currency: 'EUR' }],
        },
      },
    };
    const page = (text: string, value: number) =>
      snap([{ role: 'status', children: [{ role: 'text', name: text }] }], {
        probes: { order: { ok: true, value: { total: value } } },
      });
    expect(run(total, page('21,50 €', 21.5)).status).toBe('pass');
    expect(run(total, page('21,51 €', 21.5)).status).toBe('fail');
    const delivery: Assertion = {
      kind: 'value',
      source: { from: 'node', target: { role: 'status' }, field: 'text' },
      normalize: [{ op: 'date', locale: 'en-GB' }],
      expect: {
        sameAs: { source: { from: 'probe', probe: 'order', pointer: '/d' }, normalize: [{ op: 'date', locale: 'en' }] },
      },
    };
    const day = (text: string) =>
      snap([{ role: 'status', children: [{ role: 'text', name: text }] }], {
        probes: { order: { ok: true, value: { d: '2026-11-05' } } },
      });
    expect(run(delivery, day('5 November 2026')).status).toBe('pass');
    expect(run(delivery, day('6 November 2026')).status).toBe('fail');
  });

  test('an unset storage key on either side fails: there is nothing to be equal to', () => {
    const a: Assertion = {
      kind: 'value',
      source: { from: 'storage', area: 'local', key: 'lang' },
      expect: { sameAs: { source: { from: 'url', part: { param: 'lang' } } } },
    };
    const s = snap([], { page: { url: 'https://shop.test/?lang=de', title: '' } });
    expect(run(a, s).status).toBe('fail');
    const set = { ...s, storage: { cookies: [], local: { 'https://shop.test': { lang: 'de' } }, session: {} } };
    expect(run(a, set).status).toBe('pass');
  });

  test('validation: schema, type flow, self-comparison, sources on both sides', () => {
    expect(validateCheckSet(one(orderNumber))).toMatchObject({ ok: true, errors: [] });
    const mismatch = one({
      ...orderNumber,
      normalize: [...orderNumber.normalize!, { op: 'number', locale: 'en-US' }],
      expect: { sameAs: { source: orderNumber.source, normalize: [{ op: 'date', locale: 'en-US' }] } },
    });
    expect(validateCheckSet(mismatch).errors.join()).toContain('sameAs compares a number with a date');
    const self = one({
      ...orderNumber,
      expect: { sameAs: { source: orderNumber.source, normalize: orderNumber.normalize } },
    });
    expect(validateCheckSet(self).errors.join()).toContain('compares a value with itself');
    const badRegex = one({
      ...orderNumber,
      expect: { sameAs: { source: { from: 'text', pattern: '(' } } },
    });
    const r = validateCheckSet(badRegex);
    expect(r.errors.join()).toContain('sameAs: invalid regex');
    expect(r.warnings.join()).toContain('sameAs: reads free page text');
    const extra = one({ ...orderNumber, expect: { sameAs: { source: orderNumber.source, pointer: '/x' } as never } });
    expect(validateCheckSet(extra).ok).toBe(false);
    const network = one({
      ...orderNumber,
      expect: { sameAs: { source: { from: 'response', match: { url: { path: '/api/orders' } }, pointer: '/id' } } },
    });
    expect(validateCheckSet(network).warnings.join()).toContain('add a "request" check');
  });

  test('review text names both sources; trust is the weaker side', () => {
    expect(describeAssertion(orderNumber)).toBe(
      'the text of paragraph with text containing "Order number", normalized by {"op":"extract","regex":"Order number:\\\\s*(\\\\S+)"}, equals backend probe latestOrder at /id',
    );
    expect(assertionTrust(orderNumber)).toBe(2);
    const fromText: Assertion = { ...orderNumber, source: { from: 'text', pattern: 'Order number: (\\S+)' } };
    expect(assertionTrust(fromText)).toBe(1);
    expect(coverage(one(orderNumber))[0]).toMatchObject({ channels: ['a11y', 'probe'], trust: 'semantic' });
  });

  test('stress: each side is perturbed so they differ; valid variants keep the binding', () => {
    const s = confirmation('A1001');
    const ms = generateMutants(one(orderNumber), s).filter((m) => m.check === 'C1');
    expect(ms.some((m) => m.id.startsWith('C1:value:'))).toBe(true);
    expect(ms.some((m) => m.id.startsWith('C1:sameAs:value:'))).toBe(true);
    const r = stressTest(one(orderNumber), [{ name: 'ref', snapshot: s }]);
    expect(r.untested).toEqual([]);
    expect(r.weak).toEqual([]);
    expect(r.missed).toEqual([]);
    expect(r.overConstrained).toEqual([]);
    expect(r.fragile).toEqual([]);
    // Wrong item: the page shows another order from the probe's list.
    const list: Assertion = {
      ...orderNumber,
      expect: { sameAs: { source: { from: 'probe', probe: 'orders', pointer: '/0/id' } } },
    };
    const withList = snap(s.a11y.children![0]!.children!, {
      probes: { orders: { ok: true, value: [{ id: 'A1001' }, { id: 'A1000' }] } },
    });
    const wrong = generateMutants(one(list), withList).filter((m) => m.description.includes('different item'));
    expect(wrong.length).toBeGreaterThan(0);
    expect(stressTest(one(list), [{ name: 'ref', snapshot: withList }]).missed).toEqual([]);
  });

  test('stress: formatting variants cover a node on the sameAs side', () => {
    const a: Assertion = {
      kind: 'value',
      source: { from: 'probe', probe: 'order', pointer: '/total' },
      normalize: [{ op: 'currency', locale: 'en-US', currency: 'USD' }],
      expect: {
        sameAs: {
          source: { from: 'node', target: { role: 'status', name: 'Total' }, field: 'text' },
          normalize: [{ op: 'currency', locale: 'en-US', currency: 'USD' }],
        },
      },
    };
    const s = snap([{ role: 'status', name: 'Total', children: [{ role: 'text', name: '$21.50' }] }], {
      probes: { order: { ok: true, value: { total: 21.5 } } },
    });
    expect(run(a, s).status).toBe('pass');
    const formats = generateVariants(one(a), s).filter((v) => v.id.startsWith('format:C1:sameAs:'));
    expect(formats.length).toBeGreaterThan(0);
    const r = stressTest(one(a), [{ name: 'ref', snapshot: s }]);
    expect(r.rates.variantsAccepted).toBe(r.rates.variantsTotal);
    expect(r.rates.mutantsRejected).toBe(r.rates.mutantsTotal);
    expect(r.overConstrained).toEqual([]);
    expect(r.weak).toEqual([]);
  });
});

test.describe('datetime', () => {
  const ZRH = 'Europe/Zurich';
  test('an offset in the value decides; a zone-less wall time needs a timezone', () => {
    expect(parseDateTime('2026-11-05T14:30+01:00', 'en-GB')).toBe('2026-11-05T13:30:00Z');
    expect(parseDateTime('2026-11-05T13:30:00.250Z', 'en-GB')).toBe('2026-11-05T13:30:00.250Z');
    expect(parseDateTime('2026-11-05 13:30 UTC', 'en-GB')).toBe('2026-11-05T13:30:00Z');
    expect(parseDateTime('5 Nov 2026, 14:30 (GMT+1)', 'en-GB')).toBe('2026-11-05T13:30:00Z');
    expect(parseDateTime('5 November 2026 at 14:30', 'en-GB', ZRH)).toBe('2026-11-05T13:30:00Z');
    expect(parseDateTime('2026-07-05 14:30', 'en-GB', ZRH)).toBe('2026-07-05T12:30:00Z');
    expect(parseDateTime('November 5, 2026 at 2:30 PM', 'en-US', 'America/New_York')).toBe('2026-11-05T19:30:00Z');
    expect(parseDateTime('11/5/2026, 12:05 a.m.', 'en-US', 'UTC')).toBe('2026-11-05T00:05:00Z');
    expect(parseDateTime('Donnerstag, 5. November 2026 um 14:30', 'de-DE', ZRH)).toBe('2026-11-05T13:30:00Z');
    expect(parseDateTime('jeudi 5 novembre 2026 à 14:30', 'fr-FR', ZRH)).toBe('2026-11-05T13:30:00Z');
    expect(parseDateTime('05.11.2026, 14:30:15', 'de-CH', ZRH)).toBe('2026-11-05T13:30:15Z');
  });

  test('every Intl style with a four-digit year parses back', () => {
    const t = Date.parse('2026-11-05T13:30:00Z');
    for (const locale of ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'nl-NL'])
      for (const dateStyle of ['full', 'long', 'medium'] as const)
        for (const timeStyle of ['short', 'medium'] as const) {
          const shown = new Intl.DateTimeFormat(locale, { dateStyle, timeStyle, timeZone: ZRH }).format(t);
          expect(parseDateTime(shown, locale, ZRH), `${locale} ${shown}`).toBe('2026-11-05T13:30:00Z');
        }
  });

  test('ambiguous or incomplete values fail to parse (the check abstains)', () => {
    const f = (raw: string, tz?: string) => reason(() => parseDateTime(raw, 'en-GB', tz));
    expect(f('5 November 2026 14:30')).toBe('normalize_failed'); // no zone at all
    expect(f('5 November 2026 14:30 CET', ZRH)).toBe('normalize_failed'); // abbreviations are ambiguous
    expect(f('2026-03-29 02:30', ZRH)).toBe('normalize_failed'); // skipped by DST
    expect(f('2026-10-25 02:30', ZRH)).toBe('normalize_failed'); // repeated by DST
    expect(parseDateTime('2026-10-25 03:30', 'en-GB', ZRH)).toBe('2026-10-25T02:30:00Z');
    expect(f('2026-11-05', ZRH)).toBe('normalize_failed'); // no time of day
    expect(f('5/11/26 14:30', ZRH)).toBe('normalize_failed'); // two-digit year
    expect(f('5 November 2026 14:30 – 15:30', ZRH)).toBe('normalize_failed'); // two times
    expect(f('5 November 2026 25:10', ZRH)).toBe('normalize_failed');
    expect(f('5 November 2026 13:10 pm', ZRH)).toBe('normalize_failed');
    expect(f('5 November 2026 14:30', 'Mars/Olympus')).toBe('normalize_failed');
  });

  const slot = (text: string): EvidenceSnapshot =>
    snap([{ role: 'status', name: 'Pickup', children: [{ role: 'text', name: `Pickup: ${text}` }] }]);
  const pickup = (cmp: Comparison, tz = ZRH): Assertion => ({
    kind: 'value',
    source: { from: 'node', target: { role: 'status', name: 'Pickup' }, field: 'text' },
    normalize: [
      { op: 'extract', regex: 'Pickup: (.+)' },
      { op: 'datetime', locale: 'en-GB', timezone: tz },
    ],
    expect: cmp,
  });

  test('equals, bounds and approx in minutes', () => {
    const at = '2026-11-05T14:30:00+01:00';
    expect(run(pickup({ equals: at }), slot('5 November 2026 at 14:30')).status).toBe('pass');
    expect(run(pickup({ equals: '2026-11-05T13:30Z' }), slot('5 November 2026 at 14:30')).status).toBe('pass');
    expect(run(pickup({ equals: at }), slot('5 November 2026 at 14:31')).status).toBe('fail');
    const near = pickup({ approx: { value: at, abs: 15 } });
    expect(run(near, slot('5 November 2026 at 14:44')).status).toBe('pass');
    const late = run(near, slot('5 November 2026 at 14:46'));
    expect(late).toMatchObject({ status: 'fail' });
    expect(late.message).toContain('Δ=16, tolerance 15 minutes');
    expect(run(pickup({ gte: '2026-11-05T13:00:00Z', lt: at }), slot('5 November 2026 at 14:29')).status).toBe('pass');
    expect(run(pickup({ gte: '2026-11-05T13:00:00Z', lt: at }), slot('5 November 2026 at 14:30')).status).toBe('fail');
    // A date bound on a datetime (and the reverse) cannot be compared: abstain.
    expect(run(pickup({ gte: '2026-11-05' }), slot('5 November 2026 at 14:30'))).toMatchObject({
      status: 'abstain',
      reason: 'type_mismatch',
    });
    expect(run(pickup({ equals: at }), slot('5 November 2026 at 14:30 CET'))).toMatchObject({
      status: 'abstain',
      reason: 'normalize_failed',
    });
    // Dates are unchanged: approx in days.
    const v = applyNormalizers({ type: 'string', value: '5 November 2026' }, [{ op: 'date', locale: 'en-GB' }]);
    expect(v).toEqual({ type: 'date', value: '2026-11-05' });
  });

  test('validation: literals must name their offset; rel and date bounds are rejected', () => {
    expect(validateCheckSet(one(pickup({ approx: { value: '2026-11-05T14:30:00+01:00', abs: 15 } }))).ok).toBe(true);
    expect(validateCheckSet(one(pickup({ equals: '2026-11-05T14:30' }))).errors.join()).toContain(
      'needs an ISO date-time with an offset',
    );
    expect(
      validateCheckSet(one(pickup({ approx: { value: '2026-11-05T14:30:00Z', rel: 0.1 } }))).errors.join(),
    ).toContain('rel has no meaning for a datetime');
    expect(validateCheckSet(one(pickup({ gte: '2026-11-05' }))).errors.join()).toContain(
      'is a date but the value is datetime',
    );
    expect(validateCheckSet(one(pickup({ lt: '2026-11-05T14:30' }))).ok).toBe(false); // schema: no offset
    expect(validateCheckSet(one(pickup({ equals: 'x' }, 'Mars/Olympus'))).errors.join()).toContain('unknown timezone');
    const onDate = one({
      kind: 'value',
      source: { from: 'node', target: { role: 'status' }, field: 'text' },
      normalize: [
        { op: 'date', locale: 'en-GB' },
        { op: 'datetime', locale: 'en-GB' },
      ],
      expect: { exists: true },
    });
    expect(validateCheckSet(onDate).errors.join()).toContain('normalizer datetime cannot take a date value');
  });

  test('stress: shifts past the tolerance are mutants; localized formats are valid variants', () => {
    const cs = one(pickup({ approx: { value: '2026-11-05T14:30:00+01:00', abs: 15 } }));
    const s = slot('Thursday 5 November 2026 at 14:30');
    const ms = generateMutants(cs, s).filter((m) => m.check === 'C1');
    const shown = ms.map((m) => m.description);
    expect(shown.some((d) => d.includes('Thursday 5 November 2026 at 14:46'))).toBe(true);
    expect(shown.some((d) => d.includes('Thursday 5 November 2026 at 14:14'))).toBe(true);
    const vs = generateVariants(cs, s).filter((v) => v.id.startsWith('format:'));
    expect(vs.map((v) => v.description).join('\n')).toContain('2026-11-05T14:30+01:00');
    const r = stressTest(cs, [{ name: 'ref', snapshot: s }]);
    expect(r.overConstrained).toEqual([]);
    expect(r.fragile).toEqual([]);
    expect(r.missed).toEqual([]);
    expect(r.weak).toEqual([]);
    expect(r.untested).toEqual([]);
    // An over-wide tolerance shows up as weak: an hour later still passes.
    const lax = stressTest(one(pickup({ approx: { value: '2026-11-05T14:30:00+01:00', abs: 120 } })), [
      { name: 'ref', snapshot: s },
    ]);
    expect(lax.weak.map((w) => w.check)).toEqual(['C1']);
  });

  test('rendering keeps the page format', () => {
    const prev = { type: 'datetime' as const, value: '2026-11-05T13:30:00Z' };
    const next = { type: 'datetime' as const, value: '2026-11-05T13:46:00Z' };
    expect(renderLike('2026-11-05T14:30:00+01:00', prev, next, 'en-GB')).toBe('2026-11-05T14:46:00+01:00');
    expect(renderLike('2026-11-05 13:30Z', prev, next, 'en-GB')).toBe('2026-11-05 13:46Z');
    expect(renderLike('2026-11-05 14:30', prev, next, 'en-GB', ZRH)).toBe('2026-11-05 14:46');
    // ICU versions differ in the space before "PM"; the parser reads either.
    expect(renderLike('5 Nov 2026, 2:30 PM', prev, next, 'en-US', ZRH)?.replace(/\s/g, ' ')).toBe(
      '5 Nov 2026, 2:46 PM',
    );
    const nextDay = { type: 'datetime' as const, value: '2026-11-06T13:30:00Z' };
    expect(renderLike('5 November 2026 at 14:30', prev, nextDay, 'en-GB', ZRH)).toBe('6 November 2026 at 14:30');
    expect(renderLike('5 November 2026 at 14:30', prev, next, 'en-GB')).toBeUndefined(); // no zone to render in
  });

  test('sameAs on datetimes compares instants', () => {
    const a = pickup({
      sameAs: {
        source: { from: 'probe', probe: 'slot', pointer: '/at' },
        normalize: [{ op: 'datetime', locale: 'en' }],
      },
    });
    const s = {
      ...slot('5 November 2026 at 14:30'),
      probes: { slot: { ok: true as const, value: { at: '2026-11-05T13:30:00.000Z' } } },
    };
    expect(run(a, s).status).toBe('pass');
    expect(run(a, { ...s, probes: { slot: { ok: true, value: { at: '2026-11-05T14:30:00Z' } } } }).status).toBe('fail');
    expect(validateCheckSet(one(a)).ok).toBe(true);
    expect(stressTest(one(a), [{ name: 'ref', snapshot: s }]).missed).toEqual([]);
  });
});
