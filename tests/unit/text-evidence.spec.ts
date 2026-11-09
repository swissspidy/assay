/**
 * Which `from: "text"` sources read free page text (ADR 0001 §2.6): only an unscoped one outside
 * an `each` record reads the whole document's text. A scope's or a record's text is derived from
 * accessible names. The evaluator, the validator's warning, `assay status` "covered", compiler
 * coverage and the review sheet all decide it with `textSourceChannel`.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evidenceRead,
  status,
  validateCheckSet,
  type Assertion,
  type CheckSet,
  type EvidenceSnapshot,
  type ValueSource,
} from '../../src/index.ts';
import { textSourceChannel } from '../../src/types.ts';
import { evaluateAssertion } from '../../src/runtime/evaluate.ts';
import { AXIndex } from '../../src/runtime/axindex.ts';
import { parseAriaSnapshot } from '../../src/snapshot/aria.ts';
import { coverage } from '../../src/compiler/compile.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const DELIVERY = join(root, 'examples/tiny-shop/compiled/08-delivery-date.checks.json');
const FREE = 'reads free page text';

const summary = { role: 'region', name: 'Order summary' } as const;
const paragraph = { role: 'paragraph', text: { contains: 'Estimated delivery' } } as const;
const text = (extra: Partial<Extract<ValueSource, { from: 'text' }>> = {}): ValueSource => ({
  from: 'text',
  pattern: 'Estimated delivery: (.+)$',
  ...extra,
});
const value = (source: ValueSource, other?: ValueSource): Assertion =>
  other
    ? { kind: 'value', source, expect: { sameAs: { source: other } } }
    : { kind: 'value', source, expect: { exists: true } };
const inEach = (assert: Assertion): Assertion => ({
  kind: 'each',
  scope: summary,
  witness: paragraph,
  match: paragraph,
  count: { eq: 1 },
  assert,
});
const probe: ValueSource = { from: 'probe', probe: 'latestOrder', pointer: '/deliveryDate' };

const set = (assert: Assertion): CheckSet => ({
  schema: 'assay.checks/v1',
  id: 'delivery',
  version: '1',
  task: { instruction: 'Order express delivery.' },
  requirements: [
    { id: 'R1', kind: 'hard', text: 'Express delivery', source: { field: 'instruction', quote: 'express delivery' } },
  ],
  checks: [{ id: 'C1', requirement: 'R1', description: 'd', assert }],
});
const freeTextWarnings = (a: Assertion) => validateCheckSet(set(a)).warnings.filter((w) => w.includes(FREE));

const CASES: { name: string; assert: Assertion; free: boolean }[] = [
  { name: 'unscoped, top level', assert: value(text()), free: true },
  { name: 'scoped, top level', assert: value(text({ scope: summary })), free: false },
  { name: 'unscoped, inside each', assert: inEach(value(text())), free: false },
  { name: 'scoped, inside each', assert: inEach(value(text({ scope: { role: 'paragraph' } }))), free: false },
  { name: 'unscoped, in an allOf inside each', assert: inEach({ kind: 'allOf', of: [value(text())] }), free: false },
  { name: 'unscoped sameAs side, top level', assert: value(probe, text()), free: true },
  {
    name: 'unscoped sameAs side, inside each',
    assert: inEach(value(text(), text({ pattern: '(\\d+)' }))),
    free: false,
  },
];

test.describe('the validator warns about free page text only for the whole document', () => {
  for (const c of CASES)
    test(c.name, () => {
      const r = validateCheckSet(set(c.assert));
      expect(r.errors).toEqual([]);
      expect(freeTextWarnings(c.assert).length > 0).toBe(c.free);
    });

  test('the sameAs side is named, and a scope is still validated', () => {
    expect(freeTextWarnings(value(probe, text()))).toEqual([
      expect.stringMatching(/^check C1 sameAs: reads free page text/),
    ]);
    const badScope = validateCheckSet(set(value(text({ scope: { role: 'region', name: { regex: '(' } } }))));
    expect(badScope.errors.join()).toContain('invalid regex');
  });

  test('the compiled 08-delivery-date set has no free-text warning on R1 or R4', () => {
    const cs = JSON.parse(readFileSync(DELIVERY, 'utf8')) as CheckSet;
    const r = validateCheckSet(cs);
    expect(r.ok, r.errors.join('\n')).toBe(true);
    expect(r.warnings.filter((w) => w.includes(FREE))).toEqual([]);
  });
});

const YAML = `
- main:
  - region "Order summary":
    - paragraph: "Estimated delivery: Thursday, November 5, 2026"
`;
const snapshot = (): EvidenceSnapshot => ({
  schema: 'assay.snapshot/v1',
  capturedAt: '2026-11-05T00:00:00.000Z',
  page: { url: 'https://shop.test/orders/1', title: 't' },
  a11y: parseAriaSnapshot(YAML),
  text: 'Estimated delivery: Thursday, November 5, 2026',
  network: [],
  storage: { cookies: [], local: {}, session: {} },
  probes: {},
  meta: { capturer: 'test', redacted: [] },
});

test('the evaluator reads by the same rule', () => {
  const s = snapshot();
  const ctx = { snapshot: s, index: new AXIndex(s.a11y) };
  const missing = { pattern: 'Refund #(\\d+)' };
  // An unreadable pattern abstains with the evidence of the channel that was read.
  const top = evaluateAssertion(ctx, value(text(missing)));
  expect(top).toMatchObject({ status: 'abstain', evidence: [{ channel: textSourceChannel({}, false) }] });
  expect(top.evidence[0]!.channel).toBe('text');
  const scoped = evaluateAssertion(ctx, value(text({ ...missing, scope: summary })));
  expect(scoped).toMatchObject({ status: 'abstain', evidence: [{ channel: 'a11y', locator: expect.any(String) }] });
  expect(scoped.evidence[0]!.locator).toMatch(/^text of /);
  // Inside a record, the record's text is read (and found), not the document's.
  expect(evaluateAssertion(ctx, inEach(value(text()))).status).toBe('pass');
  expect(textSourceChannel({ scope: summary }, false)).toBe('a11y');
  expect(textSourceChannel({}, true)).toBe('a11y');
});

test('compiler coverage and the review sheet count scoped and record text as the accessibility tree', () => {
  const trust = (a: Assertion) => coverage(set(a))[0]!.trust;
  expect(trust(value(text()))).toBe('freetext');
  expect(trust(value(text({ scope: summary })))).toBe('semantic');
  expect(trust(inEach(value(text())))).toBe('semantic');
  // A binding counts as its weaker side: page text bound to a probe is still free text.
  expect(trust(value(probe, text()))).toBe('freetext');
  expect(trust(inEach(value(text(), text({ pattern: '(\\d+)' }))))).toBe('semantic');
  expect(coverage(set(inEach(value(text()))))[0]!.channels).toEqual(['a11y']);

  expect(evidenceRead(value(text()))).toEqual(['page text (free text, spoofable)']);
  expect(evidenceRead(value(text({ scope: summary })))).toEqual(['accessibility tree (semantic)']);
  expect(evidenceRead(inEach(value(text())))).toEqual(['accessibility tree (semantic)']);

  const cs = JSON.parse(readFileSync(DELIVERY, 'utf8')) as CheckSet;
  const r4 = coverage(cs).find((c) => c.requirement === 'R4')!;
  expect(r4.trust).toBe('semantic');
  expect(r4.channels).not.toContain('text');
});

test('assay status: the compiled 08-delivery-date passes covered (free page text alone still blocks: see status.spec)', async () => {
  const r = await status({ checks: DELIVERY, cwd: root, config: false, stages: ['valid', 'covered'] });
  expect(r.tasks[0]!.stages.covered).toMatchObject({ status: 'pass' });
  expect(r.tasks[0]!.ready).toBe(true);
});
