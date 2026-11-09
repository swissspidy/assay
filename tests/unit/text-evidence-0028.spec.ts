/**
 * ADR 0028: run outcomes and check descriptions follow `textSourceChannel` too. A scoped or
 * record `text` value is recorded as accessibility-tree evidence (channel "a11y", trust
 * "semantic") and described as accessibility-tree text; only the whole document's text is free
 * text. A builder set whose lock or rejection was made on the earlier default wording keeps it.
 */
import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeAssertion,
  isLocked,
  lockCheckSet,
  rejectCheckSet,
  reviewState,
  verify,
  verifyLock,
  type Assertion,
  type CheckSet,
  type EvidenceSnapshot,
  type ValueSource,
} from '../../src/index.ts';
import { checks, defaultDescription, each, printCheckSet, probe, req, text } from '../../src/checks/index.ts';
import { loadCheckSetFile } from '../../src/checks/load.ts';
import { describeAssertionAs } from '../../src/verifier/lock.ts';
import { evaluateAssertion } from '../../src/runtime/evaluate.ts';
import { AXIndex } from '../../src/runtime/axindex.ts';
import { parseAriaSnapshot } from '../../src/snapshot/aria.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const BUILDER = join(root, 'src/checks/index.ts');

const summary = { role: 'region', name: 'Order summary' } as const;
const paragraph = { role: 'paragraph', text: { contains: 'Estimated delivery' } } as const;
const PATTERN = 'Estimated delivery: (.+)$';
const src = (extra: Partial<Extract<ValueSource, { from: 'text' }>> = {}): ValueSource => ({
  from: 'text',
  pattern: PATTERN,
  ...extra,
});
const value = (source: ValueSource, want: unknown = { exists: true }, normalize?: string[]): Assertion =>
  ({ kind: 'value', source, expect: want, ...(normalize ? { normalize } : {}) }) as Assertion;
const inEach = (assert: Assertion): Assertion => ({
  kind: 'each',
  scope: summary,
  witness: paragraph,
  match: paragraph,
  count: { eq: 1 },
  assert,
});

const snapshot = (): EvidenceSnapshot => ({
  schema: 'assay.snapshot/v1',
  capturedAt: '2026-11-05T00:00:00.000Z',
  page: { url: 'https://shop.test/orders/1', title: 't' },
  a11y: parseAriaSnapshot(`
- main:
  - region "Order summary":
    - paragraph: "Estimated delivery: Thursday, November 5, 2026"
`),
  text: 'Estimated delivery: Thursday, November 5, 2026',
  network: [],
  storage: { cookies: [], local: {}, session: {} },
  probes: {},
  meta: { capturer: 'test', redacted: [] },
});

test.describe('outcomes: a scoped or record text value is accessibility-tree evidence', () => {
  const s = snapshot();
  const ctx = { snapshot: s, index: new AXIndex(s.a11y) };
  const read = (a: Assertion) => evaluateAssertion(ctx, a);
  const leaf = (r: ReturnType<typeof read>) => r.evidence.at(-1)!;

  test('pass, fail and an unparseable value all carry the channel the value was read from', () => {
    const cases: { a: (s: ValueSource) => Assertion; status: string }[] = [
      { a: (x) => value(x), status: 'pass' },
      { a: (x) => value(x, { equals: 'Friday' }), status: 'fail' },
      { a: (x) => value(x, { exists: true }, ['number']), status: 'abstain' },
    ];
    for (const c of cases) {
      const whole = read(c.a(src()));
      expect(whole.status).toBe(c.status);
      expect(leaf(whole)).toMatchObject({ channel: 'text', trust: 'freetext', locator: 'document text' });

      const scoped = read(c.a(src({ scope: summary })));
      expect(scoped.status).toBe(c.status);
      expect(leaf(scoped)).toMatchObject({ channel: 'a11y', trust: 'semantic' });
      expect(leaf(scoped).locator).toMatch(/^text of main › region "Order summary"/);

      const record = read(inEach(c.a(src())));
      expect(record.status).toBe(c.status);
      expect(leaf(record)).toMatchObject({ channel: 'a11y', trust: 'semantic' });
      expect(leaf(record).locator).toMatch(/^text of /);
    }
  });

  test('only channel and trust moved: value, locator, message and drift are what they were', () => {
    const r = read(value(src({ scope: summary }), { equals: 'Thursday, November 5, 2026' }));
    expect(r).toEqual({
      status: 'pass',
      message: expect.any(String),
      evidence: [
        {
          channel: 'a11y',
          trust: 'semantic',
          origin: 'observed',
          locator: 'text of main › region "Order summary"',
          value: 'Thursday, November 5, 2026',
        },
      ],
      drift: [],
    });
  });

  test('the compiled 08-delivery-date: same verdict on every reference, R4 evidence is semantic', async () => {
    const cs = JSON.parse(
      readFileSync(join(root, 'examples/tiny-shop/compiled/08-delivery-date.checks.json'), 'utf8'),
    ) as CheckSet;
    const ref = (name: string) =>
      (
        JSON.parse(readFileSync(join(root, `examples/tiny-shop/references/08-delivery-date/${name}.json`), 'utf8')) as {
          snapshot: EvidenceSnapshot;
        }
      ).snapshot;
    const r = await verify(cs, ref('express-order'));
    expect(r.outcome.verdict).toBe('success');
    const r4 = r.record.requirements.find((x) => x.id === 'R4')!;
    expect(r4.status).toBe('pass');
    const texts = r4.evidence.filter((e) => 'locator' in e && e.locator?.startsWith('text of '));
    expect(texts.length).toBeGreaterThan(0);
    for (const e of texts) expect(e).toMatchObject({ channel: 'a11y', trust: 'semantic' });
    // Escalation and verdicts never read trust: the spoofed confirmation still fails.
    expect((await verify(cs, ref('spoofed-confirmation'))).outcome.verdict).toBe('fail');
  });
});

test.describe('descriptions: scoped and record text reads as accessibility-tree text', () => {
  test('wording per source', () => {
    expect(describeAssertion(value(src()))).toBe(
      `page text matching /${PATTERN}/ (free text, spoofable), {"exists":true}`,
    );
    expect(describeAssertion(value(src({ scope: summary })))).toBe(
      `the text matching /${PATTERN}/ inside region named "Order summary" (accessibility-tree text), {"exists":true}`,
    );
    expect(describeAssertion(inEach(value(src())))).toMatch(
      new RegExp(`inside each: the record text matching /.*/ \\(accessibility-tree text\\), \\{"exists":true\\}$`),
    );
    // A binding names each side by what it reads.
    const bound = describeAssertion(value(src({ scope: summary }), { sameAs: { source: src() } }) as Assertion);
    expect(bound).toContain('(accessibility-tree text), equals page text matching');
    expect(bound).toMatch(/\(free text, spoofable\)$/);
  });

  test('the pre-0028 wording is frozen: it is what locks made before ADR 0028 hold', () => {
    expect(describeAssertionAs(value(src({ scope: summary })), 'pre-0028')).toBe(
      `page text matching /${PATTERN}/ inside region named "Order summary" (free text, spoofable), {"exists":true}`,
    );
    expect(describeAssertionAs(inEach(value(src())), 'pre-0028')).toMatch(
      /inside each: the record text matching \/.*\/ \(free text, spoofable\), \{"exists":true\}$/,
    );
    // Whole-document text, and everything else, is worded the same either way.
    for (const a of [value(src()), value({ from: 'probe', probe: 'latestOrder', pointer: '/id' })])
      expect(describeAssertionAs(a, 'pre-0028')).toBe(describeAssertion(a));
  });

  test('the builder default is the new wording', () => {
    const cs = checks('Order express delivery.', [
      req('R1', 'express delivery').check(text(PATTERN, { scope: summary }).exists()),
    ]);
    expect(cs.checks[0]!.description).toContain('(accessibility-tree text)');
    expect(cs.checks[0]!.description).toBe(defaultDescription(text(PATTERN, { scope: summary }).exists()));
  });
});

test.describe('locks: a builder set decided on the pre-0028 wording keeps it', () => {
  const items = () => [
    req('R1', 'express delivery')
      .check(text(PATTERN, { scope: summary }).exists())
      .check(each(paragraph, text(PATTERN).exists(), { scope: summary }))
      .check('Explicit descriptions are never touched.', text(PATTERN, { scope: summary }).exists())
      .check(probe('latestOrder', '/deliveryDate').exists()),
  ];
  const TASK = 'Order express delivery.';
  /** The set as the builder wrote it before ADR 0028: every default description in the old wording. */
  const asBefore = (cs: CheckSet): CheckSet => ({
    ...cs,
    checks: cs.checks.map((c, i) => (i === 2 ? c : { ...c, description: describeAssertionAs(c.assert, 'pre-0028') })),
  });
  const AT = '2026-11-01T00:00:00.000Z';

  test('a lock made on the old wording still verifies, and the descriptions are the approved ones', () => {
    const old = lockCheckSet(asBefore(checks(TASK, items())), 'reviewer', AT);
    const rebuilt = checks(TASK, items(), { locked: old.locked });
    expect(isLocked(rebuilt)).toBe(true);
    expect(rebuilt).toStrictEqual(old);
    expect(rebuilt.checks[0]!.description).toContain('(free text, spoofable)');
    expect(rebuilt.checks[1]!.description).toContain('the record text matching');
    expect(rebuilt.checks[2]!.description).toBe('Explicit descriptions are never touched.');
    expect(reviewState(rebuilt).state).toBe('approved');
  });

  test('a lock made on the new wording keeps the new wording', () => {
    const now = lockCheckSet(checks(TASK, items()), 'reviewer', AT);
    const rebuilt = checks(TASK, items(), { locked: now.locked });
    expect(isLocked(rebuilt)).toBe(true);
    expect(rebuilt.checks[0]!.description).toContain('(accessibility-tree text)');
  });

  test('the old wording never hides a real change: a set changed after approval is still broken', () => {
    const old = lockCheckSet(asBefore(checks(TASK, items())), 'reviewer', AT);
    const changed = checks(
      TASK,
      [req('R1', 'express delivery').check(text('Estimated delivery: (.+)', { scope: summary }).exists())],
      { locked: old.locked },
    );
    expect(verifyLock(changed).state).toBe('broken');
    // A broken set is shown in the current wording.
    expect(changed.checks[0]!.description).toContain('(accessibility-tree text)');
  });

  test('a rejection made on the old wording still reads as rejected', () => {
    const rejected = rejectCheckSet(asBefore(checks(TASK, items())), { by: 'reviewer', note: 'no', at: AT });
    const rebuilt = checks(TASK, items(), { rejected: rejected.rejected });
    expect(reviewState(rebuilt).state).toBe('rejected');
    expect(rebuilt).toStrictEqual(rejected);
  });

  test('an unlocked set always gets the new wording', () => {
    const cs = checks(TASK, items());
    expect(cs.checks.filter((c) => c.description.includes('spoofable'))).toEqual([]);
  });

  test('printed as TypeScript and loaded back, an old-wording locked set is the same set, still locked', async () => {
    const old = lockCheckSet(asBefore(checks(TASK, items())), 'reviewer', AT);
    const dir = mkdtempSync(join(tmpdir(), 'assay-0028-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    const file = join(dir, 'locked.checks.ts');
    writeFileSync(file, printCheckSet(old, { importFrom: BUILDER }));
    const back = (await loadCheckSetFile(file)) as CheckSet;
    expect(back).toStrictEqual(old);
    expect(isLocked(back)).toBe(true);
  });
});
