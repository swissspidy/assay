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
  type AXNode,
} from '../src/index.ts';
import { schemaViolations } from '../src/stress/mutants.ts';
import { APPS, app as appByName } from '../examples/apps.ts';

const shop = appByName('tiny-shop').dir;
const checks = (id: string, root: URL = shop) =>
  JSON.parse(readFileSync(new URL(`tasks/${id}.checks.json`, root), 'utf8')) as CheckSet;
const successRefs = (id: string, root: URL = shop): StressReference[] => {
  const dir = new URL(`references/${id}/`, root);
  return readdirSync(dir)
    .map((f) => ({ f, j: JSON.parse(readFileSync(new URL(f, dir), 'utf8')) }))
    .filter(({ j }) => j.label.expected === 'success')
    .map(({ f, j }) => ({ name: f.replace(/\.json$/, ''), snapshot: j.snapshot as EvidenceSnapshot }));
};

test.describe('handwritten check sets survive stress testing', () => {
  for (const t of APPS.flatMap((a) => a.tasks.map((task) => ({ ...task, app: a })))) {
    test(`${t.app.name}/${t.id}`, () => {
      const r = stressTest(checks(t.id, t.app.dir), successRefs(t.id, t.app.dir), {
        skipVariants: t.skipVariants ?? [],
      });
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
  expect(r.overConstrained[0]!.variants.map((v) => `${v.reference}/${v.id}`)).toEqual(
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
  expect(r.advisories.map((a) => a.id)).toContain('claims-only');
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

// ---------------------------------------------------------------------------
// Review cases: generators must follow what each check compares
// ---------------------------------------------------------------------------

const snap = (children: AXNode[], extra: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot => ({
  schema: 'assay.snapshot/v1',
  capturedAt: '',
  page: { url: 'https://shop.test/orders/A1', title: '' },
  a11y: { role: 'document', children: [{ role: 'main', children }] },
  text: '',
  network: [],
  storage: { cookies: [], local: {}, session: {} },
  probes: {},
  meta: { capturer: 't', redacted: [] },
  ...extra,
});
const one = (assert: Check['assert'], kind: 'hard' | 'soft' = 'hard'): CheckSet => ({
  schema: 'assay.checks/v1',
  id: 't',
  version: '1',
  task: { instruction: 'Do the thing.' },
  requirements: [{ id: 'R1', kind, text: 't', source: { field: 'instruction', quote: 'do the thing' } }],
  checks: [{ id: 'C1', requirement: 'R1', description: 'd', assert }],
});
const run = (cs: CheckSet, s: EvidenceSnapshot) => stressTest(cs, [{ name: 'ref', snapshot: s }]);

test('ids are not re-formatted with digit grouping; record-like JSON gets no extra keys', () => {
  const ids = run(
    one({
      kind: 'value',
      source: { from: 'node', target: { role: 'paragraph' }, field: 'text' },
      normalize: [
        { op: 'extract', regex: 'Order number: (\\d+)' },
        { op: 'number', locale: 'en-US' },
      ],
      expect: { equals: 10234 },
    }),
    snap([{ role: 'paragraph', children: [{ role: 'text', name: 'Order number: 10234' }] }]),
  );
  expect(ids.overConstrained).toEqual([]);
  const map = run(
    one({
      kind: 'value',
      source: { from: 'probe', probe: 'stock' },
      expect: { schema: { type: 'object', additionalProperties: { type: 'integer' } } },
    }),
    snap([], { probes: { stock: { ok: true, value: { 'MUG-BLUE': 1, 'MUG-RED': 0 } } } }),
  );
  expect(map.overConstrained).toEqual([]);
});

test('range and contains comparisons get violating mutants, not values that still satisfy them', () => {
  const total = snap([{ role: 'status', name: 'Total', children: [{ role: 'text', name: '$12.00' }] }]);
  const range = run(
    one({
      kind: 'value',
      source: { from: 'node', target: { role: 'status', name: 'Total' }, field: 'text' },
      normalize: [{ op: 'currency', locale: 'en-US', currency: 'USD' }],
      expect: { gte: 10 },
    }),
    total,
  );
  expect(range.weak).toEqual([]);
  expect(range.rates.mutantsRejected).toBe(range.rates.mutantsTotal);
  expect(range.rates.mutantsTotal).toBeGreaterThan(0);
  const named = run(
    one({ kind: 'state', target: { role: 'heading' }, expect: { name: { contains: 'Order' } } }),
    snap([{ role: 'heading', name: 'Order confirmed', level: 1 }]),
  );
  expect(named.weak).toEqual([]);
  expect(named.untested).toEqual([]);
});

test('url fields, enums, upper bounds and forbidden requests have effective mutants', () => {
  const link = run(
    one({
      kind: 'value',
      source: { from: 'node', target: { role: 'link' }, field: 'url' },
      expect: { equals: '/cart' },
    }),
    snap([{ role: 'link', name: 'Cart', url: '/cart' }]),
  );
  expect(link.weak).toEqual([]);
  expect(link.untested).toEqual([]);
  const enumCheck = run(
    one({ kind: 'value', source: { from: 'probe', probe: 'p', pointer: '/v' }, expect: { schema: { enum: [1, 2] } } }),
    snap([], { probes: { p: { ok: true, value: { v: 1 } } } }),
  );
  expect(enumCheck.weak).toEqual([]);
  expect(enumCheck.untested).toEqual([]);
  const atMost = run(
    one({ kind: 'contains', scope: { role: 'main' }, match: { role: 'listitem' }, count: { lte: 1 } }),
    snap([{ role: 'listitem', name: 'a' }]),
  );
  expect(atMost.weak).toEqual([]);
  expect(atMost.mutants.some((m) => m.id.includes('contains:extra') && m.rejected)).toBe(true);
  const forbidden = run(
    one({ kind: 'request', match: { method: 'DELETE', url: { path: '/api/cart' } }, count: { eq: 0 } }),
    snap([]),
  );
  expect(forbidden.untested).toEqual([]);
  expect(forbidden.missed).toEqual([]);
});

test('wrong-item mutants: the state moves to another node; a sibling value replaces the expected one', () => {
  const boxes = snap([
    { role: 'checkbox', name: 'Gift wrap', states: { checked: true } },
    { role: 'checkbox', name: 'Insurance' },
  ]);
  const r = run(
    one({ kind: 'state', target: { role: 'checkbox', name: 'Gift wrap' }, expect: { checked: true } }),
    boxes,
  );
  expect(r.mutants.some((m) => m.id === 'C1:state:wrong-target' && m.rejected)).toBe(true);
  const items = run(
    one({
      kind: 'value',
      source: { from: 'probe', probe: 'cart', pointer: '/items/0/name' },
      expect: { equals: 'Blue Mug' },
    }),
    snap([], { probes: { cart: { ok: true, value: { items: [{ name: 'Blue Mug' }, { name: 'Red Mug' }] } } } }),
  );
  expect(items.mutants.some((m) => m.description.includes('"Red Mug"') && m.rejected)).toBe(true);
});

test('accounting: success-claim copies are separate; checks already failing on the reference are not flagged', () => {
  const r = stressTest(checks('07-express-order'), successRefs('07-express-order'));
  expect(r.rates.claimMutantsTotal).toBe(r.rates.mutantsRejected);
  const soft = one({ kind: 'contains', scope: { role: 'main' }, match: { role: 'heading', name: 'Nope' } }, 'soft');
  const cs: CheckSet = {
    ...soft,
    requirements: [
      ...soft.requirements,
      { id: 'R2', kind: 'hard', text: 'x', source: { field: 'instruction', quote: 'the thing' } },
    ],
    checks: [
      ...soft.checks,
      {
        id: 'C2',
        requirement: 'R2',
        description: 'd',
        assert: { kind: 'contains', scope: { role: 'main' }, match: { role: 'paragraph' } },
      },
    ],
  };
  const res = run(cs, snap([{ role: 'paragraph', name: 'p' }]));
  expect(res.overConstrained).toEqual([]);
  expect(res.fragile).toEqual([]);
});
