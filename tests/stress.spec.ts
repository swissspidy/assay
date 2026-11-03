/** Milestone 3 acceptance: variants and mutants are generated, rates reported, flawed checks flagged. */
import { test, expect } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import {
  evaluate,
  formatStressReport,
  generateMutants,
  generateVariants,
  stressTest,
  type Check,
  type CheckSet,
  type EvidenceSnapshot,
  type StressReference,
} from '../src/index.ts';
import { schemaViolations } from '../src/stress/mutants.ts';
import { TASKS } from '../examples/tiny-shop/scenarios.ts';

const root = new URL('../examples/tiny-shop/', import.meta.url);
const checks = (id: string) => JSON.parse(readFileSync(new URL(`tasks/${id}.checks.json`, root), 'utf8')) as CheckSet;
const successRefs = (id: string): StressReference[] => {
  const dir = new URL(`references/${id}/`, root);
  return readdirSync(dir)
    .map((f) => ({ f, j: JSON.parse(readFileSync(new URL(f, dir), 'utf8')) }))
    .filter(({ j }) => j.label.expected === 'success')
    .map(({ f, j }) => ({ name: f.replace(/\.json$/, ''), snapshot: j.snapshot as EvidenceSnapshot }));
};

test.describe('handwritten check sets survive stress testing', () => {
  for (const t of TASKS) {
    test(t.id, () => {
      const r = stressTest(checks(t.id), successRefs(t.id), { skipVariants: t.skipVariants ?? [] });
      expect(r.rates.variantsTotal).toBeGreaterThan(4);
      expect(r.rates.mutantsTotal).toBeGreaterThan(0);
      expect(r.overConstrained, formatStressReport(r)).toEqual([]);
      expect(r.fragile, formatStressReport(r)).toEqual([]);
      expect(r.weak, formatStressReport(r)).toEqual([]);
      expect(r.missed, formatStressReport(r)).toEqual([]);
      expect(r.untested).toEqual([]);
    });
  }
});

test('generation is deterministic', () => {
  const cs = checks('06-cart-total');
  const [ref] = successRefs('06-cart-total');
  const ids = (xs: { id: string; snapshot: unknown }[]) =>
    xs.map((x) => `${x.id}:${JSON.stringify(x.snapshot).length}`);
  expect(ids(generateVariants(cs, ref!.snapshot))).toEqual(ids(generateVariants(cs, ref!.snapshot)));
  expect(ids(generateMutants(cs, ref!.snapshot))).toEqual(ids(generateMutants(cs, ref!.snapshot)));
});

test('mutants are labelled with the check they attack and include page-claims-only', () => {
  const cs = checks('07-express-order');
  const ms = generateMutants(cs, successRefs('07-express-order')[0]!.snapshot);
  expect(new Set(ms.map((m) => m.check).filter(Boolean))).toEqual(new Set(['C1', 'C2', 'C3']));
  const claims = ms.find((m) => m.id === 'claims-only')!;
  expect(claims.advisory).toBe(true);
  expect(evaluate(cs, claims.snapshot).verdict).not.toBe('success');
});

const withChecks = (cs: CheckSet, replace: Check[]): CheckSet => ({ ...cs, checks: replace });

test('over-constrained checks are flagged: exact row count and exact price text', () => {
  const base = checks('03-cart-two-mugs');
  const flawed = withChecks(base, [
    ...base.checks,
    {
      id: 'C9',
      requirement: 'R1',
      description: 'The cart table has exactly three rows (header + two items).',
      assert: { kind: 'contains', scope: { role: 'table', name: 'Cart' }, match: { role: 'row' }, count: { eq: 3 } },
    },
  ]);
  const r = stressTest(flawed, successRefs('03-cart-two-mugs'));
  expect(r.overConstrained.map((o) => o.check)).toEqual(['C9']);
  // a generated variant and a held-out correct run (with an extra teapot) both expose it
  expect(r.overConstrained[0]!.variants).toEqual(
    expect.arrayContaining(['both-mugs/extra-row', 'both-mugs-and-teapot/reference']),
  );
  expect(r.rates.variantsAccepted).toBeLessThan(r.rates.variantsTotal);

  const total = checks('06-cart-total');
  const exact = withChecks(total, [
    {
      id: 'C1',
      requirement: 'R1',
      description: 'The cart total text is exactly "$21.50".',
      assert: {
        kind: 'value',
        source: { from: 'node', target: { role: 'status', name: 'Cart total' }, field: 'text' },
        normalize: [{ op: 'currency', locale: 'en-US', currency: 'USD' }],
        expect: { equals: { amount: 21.5, currency: 'USD' } },
      },
    },
    {
      id: 'C2',
      requirement: 'R1',
      description: 'The total reads "$21.50" character for character.',
      assert: { kind: 'state', target: { role: 'status', name: 'Cart total' }, expect: { text: '$21.50' } },
    },
  ]);
  const r2 = stressTest(exact, successRefs('06-cart-total'));
  // C1 normalizes, so formatting variants pass it; C2 compares raw text and is flagged.
  expect(r2.overConstrained.map((o) => o.check)).toEqual(['C2']);
});

test('weak checks are flagged: a tolerance so wide nothing can fail', () => {
  const total = checks('06-cart-total');
  const lax = withChecks(total, [
    {
      id: 'C1',
      requirement: 'R1',
      description: 'The cart total is about $21.50.',
      assert: {
        kind: 'value',
        source: { from: 'node', target: { role: 'status', name: 'Cart total' }, field: 'text' },
        normalize: [{ op: 'currency', locale: 'en-US', currency: 'USD' }],
        expect: { approx: { value: { amount: 21.5, currency: 'USD' }, abs: 1000 } },
      },
    },
  ]);
  const r = stressTest(lax, successRefs('06-cart-total'));
  expect(r.weak.map((w) => w.check)).toEqual(['C1']);
  expect(r.missed.length).toBeGreaterThan(0);
});

test('relying on page content alone raises an advisory', () => {
  const cs = checks('07-express-order');
  const pageOnly = withChecks(cs, [
    {
      id: 'C1',
      requirement: 'R1',
      description: 'On an order page.',
      assert: { kind: 'url', match: { path: '/orders/:id' } },
    },
    {
      id: 'C2',
      requirement: 'R2',
      description: 'Summary says Express.',
      assert: {
        kind: 'contains',
        scope: { role: 'region', name: 'Order summary' },
        match: { role: 'paragraph', text: { contains: 'Express' } },
      },
    },
    {
      id: 'C3',
      requirement: 'R3',
      description: 'Heading shown.',
      assert: { kind: 'contains', match: { role: 'heading', name: 'Order confirmed' } },
    },
  ]);
  const r = stressTest(pageOnly, successRefs('07-express-order'));
  expect(r.advisories.join('\n')).toContain('claims-only');
});

test('schema violations: pinned values, required and forbidden items', () => {
  const v = schemaViolations(
    {
      type: 'object',
      properties: {
        status: { const: 'placed' },
        items: { type: 'array', not: { contains: { properties: { name: { const: 'Red Mug' } } } } },
      },
    },
    { status: 'placed', items: [{ name: 'Blue Mug' }] },
  );
  expect(v.map((x) => x.what)).toEqual([
    'status: pinned value changed',
    'items: forbidden item {"name":"Red Mug"} present',
  ]);
  expect(
    schemaViolations({ contains: { properties: { name: { const: 'Blue Mug' } } } }, [
      { name: 'Blue Mug' },
      { name: 'Tea' },
    ]),
  ).toEqual([{ what: 'required item missing', value: [{ name: 'Tea' }] }]);
});
