/** Stress generators for arrays nested inside JSON values (ADR 0014). */
import { test, expect } from '@playwright/test';
import type { Assertion, CheckSet, EvidenceSnapshot, Json } from '../../src/index.ts';
import { generateMutants, generateVariants, stressTest } from '../../src/stress/index.ts';

const one = (assert: Assertion): CheckSet => ({
  schema: 'assay.checks/v1',
  id: 't',
  version: '1',
  task: { instruction: 'Order what is in my cart.' },
  requirements: [{ id: 'R1', kind: 'hard', text: 't', source: { field: 'instruction', quote: 'Order' } }],
  checks: [{ id: 'C1', requirement: 'R1', description: 'd', assert }],
});

const lines: Json = [
  { sku: 'MUG-BLUE', qty: 1, options: ['gift-wrap', 'engraving'] },
  { sku: 'MUG-RED', qty: 2, options: ['engraving'] },
];

const snap = (order: Json, cart: Json = lines, local: Record<string, string> = {}): EvidenceSnapshot => ({
  schema: 'assay.snapshot/v1',
  capturedAt: '',
  page: { url: 'https://shop.test/orders/A1', title: '' },
  a11y: { role: 'document', children: [{ role: 'main', children: [] }] },
  text: '',
  network: [],
  storage: { cookies: [], local: { 'https://shop.test': local }, session: {} },
  probes: { order: { ok: true, value: { id: 'A1', lines: order } } },
  baseline: { capturedAt: '', url: '', storage: null, probes: { cart: { ok: true, value: { items: cart } } } },
  meta: { capturer: 't', redacted: [] },
});

// The order's lines are the cart's items before the task, whole items in any order.
const ordered: Assertion = {
  kind: 'value',
  source: { from: 'probe', probe: 'order', pointer: '/lines' },
  normalize: [{ op: 'items' }],
  expect: {
    sameAs: { source: { from: 'probe', probe: 'cart', pointer: '/items', at: 'before' }, normalize: [{ op: 'items' }] },
  },
};

test.describe('nested JSON arrays', () => {
  test('mutants: nested items removed, duplicated, changed and paired fields swapped, each a real violation', () => {
    const mutants = generateMutants(one(ordered), snap(lines)).filter((m) => m.check === 'C1');
    const nested = mutants.map((m) => m.description).filter((d) => d.includes('/options'));
    expect(nested).toEqual(
      expect.arrayContaining([
        expect.stringContaining('at /0/options: item 0 removed'),
        expect.stringContaining('at /1/options: item 0 removed'),
        expect.stringContaining('at /0/options: item 0 duplicated'),
        expect.stringContaining('at /0/options: item 0 changed'),
      ]),
    );
    // The cap keeps at most 8 nested edits per value (each side of the binding).
    expect(
      mutants.filter((m) => !m.id.includes('sameAs') && m.description.includes('(at /')).length,
    ).toBeLessThanOrEqual(8);
    const r = stressTest(one(ordered), [{ name: 'ref', snapshot: snap(lines) }]);
    expect(r.rates.mutantsRejected).toBe(r.rates.mutantsTotal);
    expect(r.weak).toEqual([]);
  });

  test('mutants: only edits the check reads as a violation are kept', () => {
    // A check that only needs some line with gift wrap: dropping engraving is no near miss.
    const giftWrap: Assertion = {
      kind: 'value',
      source: { from: 'probe', probe: 'order', pointer: '/lines' },
      expect: {
        schema: {
          type: 'array',
          contains: {
            type: 'object',
            required: ['options'],
            properties: { options: { type: 'array', contains: { const: 'gift-wrap' } } },
          },
        },
      },
    };
    const nested = generateMutants(one(giftWrap), snap(lines))
      .map((m) => m.description)
      .filter((d) => d.includes('(at /'));
    expect(nested.some((d) => d.includes('at /0/options: item 0 removed'))).toBe(true);
    expect(nested.some((d) => d.includes('at /1/options'))).toBe(false);
    expect(nested.some((d) => d.includes('duplicated'))).toBe(false);
  });

  test('mutants: JSON text in storage is edited and written back as text', () => {
    const cart = JSON.stringify({ items: lines });
    const fromStorage: Assertion = {
      kind: 'value',
      source: { from: 'storage', area: 'local', key: 'cart' },
      normalize: ['json'],
      expect: { equals: { items: lines } },
    };
    const m = generateMutants(one(fromStorage), snap(lines, lines, { cart })).find((x) =>
      x.description.includes('at /items/0/options: item 0 removed'),
    );
    expect(m).toBeDefined();
    const stored = m!.snapshot.storage!.local['https://shop.test']!.cart as string;
    expect(JSON.parse(stored).items[0].options).toEqual(['engraving']);
  });

  test('variant: nested arrays reversed, outer order kept, before and after the task and in storage', () => {
    const cart = JSON.stringify({ items: lines });
    const v = generateVariants(one(ordered), snap(lines, lines, { cart })).find((x) => x.id === 'nested-array-order')!;
    const order = (v.snapshot.probes.order as { value: { lines: { sku: string; options: string[] }[] } }).value;
    expect(order.lines.map((l) => l.sku)).toEqual(['MUG-BLUE', 'MUG-RED']);
    expect(order.lines[0]!.options).toEqual(['engraving', 'gift-wrap']);
    const before = v.snapshot.baseline!.probes.cart as { value: { items: { options: string[] }[] } };
    expect(before.value.items[0]!.options).toEqual(['engraving', 'gift-wrap']);
    expect(JSON.parse(v.snapshot.storage!.local['https://shop.test']!.cart as string).items[0].options).toEqual([
      'engraving',
      'gift-wrap',
    ]);
    // Whole items compare the same either way; a check pinned to a nested position is over-constrained.
    expect(stressTest(one(ordered), [{ name: 'ref', snapshot: snap(lines) }]).overConstrained).toEqual([]);
    const first: Assertion = {
      kind: 'value',
      source: { from: 'probe', probe: 'order', pointer: '/lines/0/options/0' },
      expect: { equals: 'gift-wrap' },
    };
    const r = stressTest(one(first), [{ name: 'ref', snapshot: snap(lines) }], { skipVariants: ['json-array-order'] });
    expect(r.overConstrained.map((o) => o.variants.map((x) => x.id))).toEqual([['nested-array-order']]);
  });
});
