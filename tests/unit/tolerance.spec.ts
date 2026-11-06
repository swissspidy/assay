/** sameAs tolerance (ADR 0014): evaluation, validation, review text and stress generators. */
import { test, expect } from '@playwright/test';
import {
  describeAssertion,
  diffCheckSets,
  formatCheckSetDiff,
  reviewSheet,
  validateCheckSet,
  type Assertion,
  type AXNode,
  type Check,
  type CheckSet,
  type EvidenceSnapshot,
  type ModelRequest,
  type Tolerance,
} from '../../src/index.ts';
import { compileTask, verifyCandidate, type Reference } from '../../src/compiler/index.ts';
import { toleranceHints } from '../../src/compiler/compile.ts';
import { call, lastResults, scripted } from '../support/scripted.ts';
import { generateMutants, generateVariants, stressTest } from '../../src/stress/index.ts';
import { evaluateAssertion } from '../../src/runtime/evaluate.ts';
import { compareValues } from '../../src/runtime/compare.ts';
import { AXIndex } from '../../src/runtime/axindex.ts';

const snap = (children: AXNode[], probes: Record<string, unknown>): EvidenceSnapshot => ({
  schema: 'assay.snapshot/v1',
  capturedAt: '',
  page: { url: 'https://shop.test/orders/A1001', title: '' },
  a11y: { role: 'document', children: [{ role: 'main', children }] },
  text: '',
  network: [],
  storage: { cookies: [], local: {}, session: {} },
  probes: Object.fromEntries(Object.entries(probes).map(([k, value]) => [k, { ok: true, value: value as never }])),
  meta: { capturer: 't', redacted: [] },
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

// The page rounds the stored total (21.495) to the cent.
const total = (shown: string, stored = 21.495) =>
  snap([{ role: 'status', name: 'Order total', children: [{ role: 'text', name: shown }] }], {
    latestOrder: { id: 'A1001', total: stored },
  });
const cents: Tolerance = { abs: 0.01, because: 'the page rounds the stored total to the cent' };
const totalCheck = (tolerance?: Tolerance): Assertion => ({
  kind: 'value',
  source: { from: 'node', target: { role: 'status', name: 'Order total' }, field: 'text' },
  normalize: [{ op: 'currency', locale: 'en-US', currency: 'USD' }],
  expect: {
    sameAs: {
      source: { from: 'probe', probe: 'latestOrder', pointer: '/total' },
      normalize: [{ op: 'currency', locale: 'en-US', currency: 'USD' }],
      ...(tolerance ? { tolerance } : {}),
    },
  },
});

// The page shows the time to the minute; the backend stores it to the second.
const created = (shown: string, stored = '2026-11-05T14:30:27Z') =>
  snap([{ role: 'paragraph', name: 'Created', children: [{ role: 'text', name: shown }] }], {
    latestOrder: { createdAt: stored },
  });
const minute: Tolerance = { abs: 1, because: 'the page shows the time to the minute, the backend to the second' };
const createdCheck = (tolerance?: Tolerance): Assertion => ({
  kind: 'value',
  source: { from: 'node', target: { role: 'paragraph', name: 'Created' }, field: 'text' },
  normalize: [{ op: 'datetime', locale: 'en-GB', timezone: 'UTC' }],
  expect: {
    sameAs: {
      source: { from: 'probe', probe: 'latestOrder', pointer: '/createdAt' },
      normalize: [{ op: 'datetime', locale: 'en-GB', timezone: 'UTC' }],
      ...(tolerance ? { tolerance } : {}),
    },
  },
});

test.describe('sameAs tolerance', () => {
  test('money: equal within the tolerance passes, past it fails; without one, exact equality', () => {
    expect(run(totalCheck(cents), total('$21.50'))).toMatchObject({
      status: 'pass',
      message: '21.5 USD ≈ 21.495 USD (Δ=0.005, tolerance 0.01) (probe latestOrder at /total (raw 21.495))',
    });
    expect(run(totalCheck(cents), total('$21.51')).status).toBe('fail'); // Δ 0.015
  });

  test('money: the edge of the tolerance is inclusive; a step past it fails', () => {
    expect(run(totalCheck(cents), total('$21.50', 21.51)).status).toBe('pass');
    expect(run(totalCheck(cents), total('$21.48', 21.495)).status).toBe('fail');
    expect(run(totalCheck(), total('$21.50')).status).toBe('fail');
    expect(run(totalCheck(), total('$21.50', 21.5)).status).toBe('pass');
  });

  test('relative tolerance is a fraction of the compared value; currencies must agree', () => {
    const rel: Tolerance = { rel: 0.01, because: 'prices are converted at a daily rate' };
    const usd = (n: number) => ({ type: 'money' as const, value: { amount: n, currency: 'USD' } });
    expect(compareValues(usd(101), usd(100), rel).ok).toBe(true);
    expect(compareValues(usd(101.5), usd(100), rel).ok).toBe(false);
    expect(compareValues(usd(100), { type: 'money', value: { amount: 100, currency: 'EUR' } }, rel)).toMatchObject({
      ok: false,
    });
  });

  test('datetime: tolerance in minutes', () => {
    expect(run(createdCheck(minute), created('5 November 2026 at 14:30'))).toMatchObject({ status: 'pass' });
    expect(run(createdCheck(minute), created('5 November 2026 at 14:32')).status).toBe('fail');
    expect(run(createdCheck(), created('5 November 2026 at 14:30')).status).toBe('fail');
  });

  test('a tolerance on a value without a distance abstains at run time', () => {
    const a: Assertion = {
      kind: 'value',
      source: { from: 'node', target: { role: 'status', name: 'Order total' }, field: 'text' },
      expect: { sameAs: { source: { from: 'probe', probe: 'latestOrder', pointer: '/id' }, tolerance: cents } },
    };
    expect(run(a, total('A1001'))).toMatchObject({ status: 'abstain', reason: 'type_mismatch' });
  });

  test('validation: bounded, typed, with a reason', () => {
    expect(validateCheckSet(one(totalCheck(cents))).errors).toEqual([]);
    expect(validateCheckSet(one(createdCheck(minute))).errors).toEqual([]);
    const errors = (a: Assertion) => validateCheckSet(one(a)).errors.join('\n');
    // Schema: a reason, abs or rel, positive values, rel at most 5%.
    expect(errors(totalCheck({ abs: 0.01 } as Tolerance))).toMatch(/because/);
    expect(errors(totalCheck({ because: 'x' } as Tolerance))).toMatch(/abs|rel/);
    expect(errors(totalCheck({ abs: 0, because: 'x' }))).toMatch(/must be > 0/);
    expect(errors(totalCheck({ rel: 0.2, because: 'x' }))).toMatch(/must be <= 0.05/);
    expect(errors(totalCheck({ abs: 0.01, because: '  ' }))).toMatch(/needs a reason/);
    // Types: date-times in minutes (at most 60), dates in whole days (at most 7), never rel.
    expect(errors(createdCheck({ abs: 90, because: 'x' }))).toMatch(/at most 60 minutes/);
    expect(errors(createdCheck({ rel: 0.01, because: 'x' }))).toMatch(/rel has no meaning for a datetime/);
    const date = [{ op: 'date' as const, locale: 'en-GB', timezone: 'UTC' }];
    const dateCheck = (tolerance: Tolerance): Assertion => ({
      kind: 'value',
      source: { from: 'node', target: { role: 'paragraph', name: 'Created' }, field: 'text' },
      normalize: date,
      expect: { sameAs: { source: { from: 'probe', probe: 'o', pointer: '/at' }, normalize: date, tolerance } },
    });
    expect(errors(dateCheck({ abs: 1, because: 'x' }))).toBe('');
    expect(errors(dateCheck({ abs: 1.5, because: 'x' }))).toMatch(/whole number of days/);
    expect(errors(dateCheck({ abs: 8, because: 'x' }))).toMatch(/at most 7/);
    // Strings and collections have no distance.
    const text: Assertion = {
      kind: 'value',
      source: { from: 'node', target: { role: 'status', name: 'Order total' }, field: 'text' },
      expect: { sameAs: { source: { from: 'url', part: 'pathname' }, tolerance: cents } },
    };
    expect(errors(text)).toMatch(/not .*strings|values are strings/);
    const items: Assertion = {
      kind: 'value',
      source: { from: 'probe', probe: 'cart', pointer: '/items' },
      normalize: [{ op: 'items' }],
      expect: {
        sameAs: {
          source: { from: 'probe', probe: 'cart', pointer: '/items', at: 'before' },
          normalize: [{ op: 'items' }],
          tolerance: cents,
        },
      },
    };
    expect(errors(items)).toMatch(/not to collections/);
  });

  test('describeAssertion states the tolerance, its unit and its reason', () => {
    expect(describeAssertion(totalCheck(cents))).toMatch(
      /, within ±0\.01 \(because "the page rounds the stored total to the cent"\)$/,
    );
    expect(describeAssertion(createdCheck(minute))).toMatch(/within ±1 minutes \(because/);
    expect(describeAssertion(totalCheck({ abs: 0.01, rel: 0.01, because: 'a\nb' }))).toMatch(
      /within ±0\.01 or ±1% of that value \(because "a b"\)/,
    );
    expect(describeAssertion(totalCheck())).not.toMatch(/within|because/);
  });

  test('the review sheet shows the tolerance in what the check tests and as a setting', () => {
    const sheet = reviewSheet(one(totalCheck({ abs: 0.5, because: 'rounded on the page' })));
    expect(sheet).toContain(', within ±0.5 (because "rounded on the page")');
    expect(sheet).toContain('sameAs tolerance: within ±0.5 (because "rounded on the page")');
    expect(reviewSheet(one(totalCheck()))).not.toContain('sameAs tolerance');
  });

  test('the semantic diff reports a changed tolerance as a changed setting', () => {
    const before = one(totalCheck(cents));
    const after = one(totalCheck({ abs: 0.5, because: 'rounded on the page' }));
    const d = diffCheckSets(before, after);
    expect(d.checks.changed.map((c) => [c.id, c.fields])).toEqual([['C1', ['what it tests', 'tolerance']]]);
    expect(d.checks.changed[0]!.before.settings).toEqual([
      'sameAs tolerance: within ±0.01 (because "the page rounds the stored total to the cent")',
    ]);
    expect(d.checks.changed[0]!.after.settings).toEqual([
      'sameAs tolerance: within ±0.5 (because "rounded on the page")',
    ]);
    const text = formatCheckSetDiff(d);
    expect(text).toContain('changed: what it tests, tolerance');
    expect(text).toMatch(
      /settings:[\s\S]*before: sameAs tolerance: within ±0\.01[\s\S]*after: sameAs tolerance: within ±0\.5/,
    );
    // Added or removed, it is a change too; an unchanged tolerance is none.
    expect(diffCheckSets(one(totalCheck()), before).checks.changed[0]!.fields).toContain('tolerance');
    expect(diffCheckSets(before, one(totalCheck(cents))).identical).toBe(true);
  });

  test('stress: values just past the tolerance are mutants, values inside it are valid variants', () => {
    const cs = one(totalCheck(cents));
    const reference = total('$21.50');
    const mutants = generateMutants(cs, reference).filter((m) => m.check === 'C1');
    const past = mutants.filter((m) => m.id.includes('tolerance:'));
    // The page side moves to 21.51 / 21.48 (a cent past 21.495 ± 0.01); the probe side to 21.511 / 21.489.
    expect(past.map((m) => m.description)).toEqual([
      '21.51 USD instead of 21.5 USD: just past the tolerance of 21.495 USD',
      '21.48 USD instead of 21.5 USD: just past the tolerance of 21.495 USD',
      '21.511 USD instead of 21.495 USD: just past the tolerance of 21.5 USD',
      '21.489 USD instead of 21.495 USD: just past the tolerance of 21.5 USD',
    ]);
    // No near miss inside the tolerance is generated as a mutant.
    for (const m of mutants) expect(run(totalCheck(cents), m.snapshot).status).not.toBe('pass');
    const variants = generateVariants(cs, reference).filter((v) => v.id.startsWith('tolerance:'));
    // Shown to the cent, only $21.49 lies inside 21.495 ± 0.01 besides $21.50 itself.
    expect(variants.map((v) => v.description)).toEqual([
      "C1's value is 21.49 USD instead of 21.5 USD, within its tolerance of 21.495 USD",
      "C1's compared value is 21.51 USD instead of 21.495 USD, within its tolerance of 21.5 USD",
      "C1's compared value is 21.49 USD instead of 21.495 USD, within its tolerance of 21.5 USD",
    ]);
    const r = stressTest(cs, [{ name: 'ref', snapshot: reference }]);
    expect(r.overConstrained).toEqual([]);
    expect(r.weak).toEqual([]);
    expect(r.rates.variantsAccepted).toBe(r.rates.variantsTotal);
    expect(r.rates.mutantsRejected).toBe(r.rates.mutantsTotal);
  });

  test('stress: date-times shown to the minute get minute steps past the tolerance', () => {
    const cs = one(createdCheck(minute));
    const reference = created('5 November 2026 at 14:30');
    const past = generateMutants(cs, reference).filter((m) => m.id.includes('tolerance:'));
    expect(past.map((m) => m.description)).toEqual([
      '2026-11-05T14:32:00Z instead of 2026-11-05T14:30:00Z: just past the tolerance of 2026-11-05T14:30:27Z',
      '2026-11-05T14:29:00Z instead of 2026-11-05T14:30:00Z: just past the tolerance of 2026-11-05T14:30:27Z',
      '2026-11-05T14:31:01Z instead of 2026-11-05T14:30:27Z: just past the tolerance of 2026-11-05T14:30:00Z',
      '2026-11-05T14:28:59Z instead of 2026-11-05T14:30:27Z: just past the tolerance of 2026-11-05T14:30:00Z',
    ]);
    const r = stressTest(cs, [{ name: 'ref', snapshot: reference }]);
    expect(r.variants.filter((v) => v.id.startsWith('tolerance:')).length).toBeGreaterThan(0);
    expect(r.overConstrained).toEqual([]);
    expect(r.rates.mutantsRejected).toBe(r.rates.mutantsTotal);
  });

  test('compiler: tolerance is offered once a correct run shows a near difference, and must be needed', async () => {
    const check = (tolerance?: Tolerance): Check[] => [
      { id: 'C1', requirement: 'R1', description: 'The page shows the stored total.', assert: totalCheck(tolerance) },
    ];
    const hasTolerance = (req: ModelRequest) =>
      JSON.stringify(req.tools.find((t) => t.name === 'submit_checks')!.inputSchema).includes('"tolerance"');
    const model = scripted([
      (req) => {
        expect(hasTolerance(req)).toBe(false);
        return call('submit_checks', { checks: check(cents) });
      },
      (req) => {
        // Not offered yet: the tool schema refuses it.
        expect(lastResults(req)[0]!.content).toMatch(/^Invalid input: .*additional properties/);
        return call('submit_checks', { checks: check() });
      },
      (req) => {
        const content = lastResults(req)[0]!.content;
        expect(content).toContain('## Tolerance on sameAs (now accepted by submit_checks and try_assertion)');
        expect(content).toContain(
          'check C1: on correct run "ok" the two sides differ by 0.005 (21.5 USD vs 21.495 USD).',
        );
        expect(hasTolerance(req)).toBe(true);
        return call('submit_checks', { checks: check(cents) });
      },
    ]);
    const refs: Reference[] = [{ name: 'ok', kind: 'success', snapshot: total('$21.50') }];
    const { checkSet, report } = await compileTask({ id: 't', instruction: 'Show me the order total.' }, refs, {
      model,
      rubric: 'deterministic',
    });
    expect(report.status).toBe('compiled');
    expect(checkSet!.checks[0]!.assert).toEqual(totalCheck(cents));
    // A tolerance no correct run needs is refused; one too wide for a hint gets none.
    const exact: Reference[] = [{ name: 'ok', kind: 'success', snapshot: total('$21.50', 21.5) }];
    const cs = (t?: Tolerance): CheckSet => ({ ...one(totalCheck(t)), requirements: one(totalCheck()).requirements });
    expect(verifyCandidate(cs(cents), exact, false).errors).toEqual([
      'check C1: its tolerance is not needed: the two sides are equal on every correct run. Remove it; a tolerance is only for a difference the references show.',
    ]);
    expect(toleranceHints(cs(), refs)).toHaveLength(1);
    expect(toleranceHints(cs(), [{ name: 'far', kind: 'success', snapshot: total('$25.00') }])).toEqual([]);
  });

  test('review fixes: scale-aware slack keeps the edge inclusive without swamping a tiny tolerance', () => {
    const n = (value: number) => ({ type: 'number' as const, value });
    expect(compareValues(n(0), n(1e-9), { abs: 1e-12, because: 'x' }).ok).toBe(false);
    expect(compareValues(n(1e-12), n(0), { abs: 1e-12, because: 'x' }).ok).toBe(true);
    expect(compareValues(n(1_000_000.01), n(1_000_000), { abs: 0.01, because: 'x' }).ok).toBe(true);
    expect(compareValues(n(1_000_000.02), n(1_000_000), { abs: 0.01, because: 'x' }).ok).toBe(false);
  });

  test('review fixes: bindings inside a page assertion are read on that page', () => {
    const s = total('$21.50');
    const onPage: Assertion = { kind: 'page', match: { url: { path: '/orders/A1001' } }, assert: totalCheck() };
    expect(toleranceHints(one(onPage), [{ name: 'ok', kind: 'success', snapshot: s }])).toEqual([
      'check C1.assert: on correct run "ok" the two sides differ by 0.005 (21.5 USD vs 21.495 USD).',
    ]);
  });

  test('review fixes: a tolerance branch with mismatched types does not throw', () => {
    const text: Assertion = {
      kind: 'value',
      source: { from: 'node', target: { role: 'status', name: 'Order total' }, field: 'text' },
      expect: {
        sameAs: { source: { from: 'probe', probe: 'latestOrder', pointer: '/total' }, tolerance: cents },
      },
    };
    const cs = one({ kind: 'anyOf', of: [text, totalCheck(cents)] });
    expect(() =>
      verifyCandidate(cs, [{ name: 'ok', kind: 'success', snapshot: total('$21.50') }], false),
    ).not.toThrow();
  });

  test('review fixes: no tolerance variant edits a source another assertion pins', () => {
    const pinned: Assertion = {
      kind: 'value',
      source: { from: 'node', target: { role: 'status', name: 'Order total' }, field: 'text' },
      normalize: [{ op: 'currency', locale: 'en-US', currency: 'USD' }],
      expect: { equals: { amount: 21.5, currency: 'USD' } },
    };
    const pageSide = (cs: CheckSet) =>
      generateVariants(cs, total('$21.50')).filter((v) => v.id.startsWith('tolerance:') && !v.id.includes('sameAs'));
    expect(pageSide(one(totalCheck(cents)))).toHaveLength(1);
    // A sibling in the same check.
    expect(pageSide(one({ kind: 'allOf', of: [pinned, totalCheck(cents)] }))).toEqual([]);
    // Another check, wrapped in a page assertion.
    const wrapped = one(totalCheck(cents));
    wrapped.checks.push({
      id: 'C2',
      requirement: 'R1',
      description: 'd',
      assert: { kind: 'page', match: { url: { path: '/orders/A1001' } }, assert: pinned },
    });
    expect(pageSide(wrapped)).toEqual([]);
  });

  test('review fixes: a tiny rel keeps its precision; the diff decides on raw values', () => {
    expect(describeAssertion(totalCheck({ rel: 1e-8, because: 'x' }))).toContain('±0.000001% of that value');
    // 0.03 × 100 is 3.0000000000000004 in floating point; it reads as 3%.
    expect(describeAssertion(totalCheck({ rel: 0.03, because: 'x' }))).toContain('±3% of that value');
    // Two reasons that render the same (a line break is shown as a space) are still a change.
    const d = diffCheckSets(
      one(totalCheck({ abs: 0.01, because: 'a b' })),
      one(totalCheck({ abs: 0.01, because: 'a\nb' })),
    );
    expect(d.checks.changed[0]!.fields).toContain('tolerance');
  });

  test('stress: an over-wide tolerance shows up as weak', () => {
    const cs = one(totalCheck({ abs: 1000, because: 'too lenient' }));
    const r = stressTest(cs, [{ name: 'ref', snapshot: total('$21.50') }]);
    expect(r.weak.map((w) => w.check)).toEqual(['C1']);
  });
});
