/** Baselines (state before the task) and the items normalizer: evaluation, validation, digests, views, stress. */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  applyNormalizers,
  compileTask,
  describeAssertion,
  evaluate,
  evaluateAssertion,
  generateMutants,
  generateVariants,
  NormalizeError,
  snapshotDigest,
  stressTest,
  validateCheckSet,
  type Assertion,
  type Baseline,
  type CheckSet,
  type EvidenceSnapshot,
  type Json,
  type StorageRecord,
} from '../../src/index.ts';
import { AXIndex } from '../../src/runtime/axindex.ts';
import { probesView, storageView, summary } from '../../src/compiler/explore.ts';
import { scripted } from '../support/scripted.ts';

const item = (name: string, qty = 1) => ({ sku: name.toUpperCase().replace(/ /g, '-'), name, qty });
const cart = (...items: Json[]) => ({ ok: true as const, value: { items } });

const baseline = (probes: Baseline['probes'], storage: Baseline['storage'] = null): Baseline => ({
  capturedAt: '2026-11-04T10:00:00.000Z',
  url: 'https://shop.test/cart',
  storage,
  probes,
  redacted: [],
});

const snap = (extra: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot => ({
  schema: 'assay.snapshot/v1',
  capturedAt: '',
  page: { url: 'https://shop.test/cart', title: '' },
  a11y: { role: 'document', children: [{ role: 'main' }] },
  text: '',
  network: [],
  storage: { cookies: [], local: {}, session: {} },
  probes: {},
  meta: { capturer: 't', redacted: [] },
  ...extra,
});

const run = (a: Assertion, s: EvidenceSnapshot) => evaluateAssertion({ snapshot: s, index: new AXIndex(s.a11y) }, a);

const one = (assert: Assertion): CheckSet => ({
  schema: 'assay.checks/v1',
  id: 't',
  version: '1',
  task: { instruction: 'Remove the Red Mug, keep everything else.' },
  requirements: [
    { id: 'R1', kind: 'hard', text: 't', source: { field: 'instruction', quote: 'keep everything else' } },
  ],
  checks: [{ id: 'C1', requirement: 'R1', description: 'd', assert }],
});

const notRedMug = { not: { type: 'object', properties: { name: { const: 'Red Mug' } }, required: ['name'] } };
/** "The cart after is the cart before, minus the Red Mug." */
const keepTheRest: Assertion = {
  kind: 'value',
  source: { from: 'probe', probe: 'cart', pointer: '/items' },
  normalize: [{ op: 'items' }],
  expect: {
    sameAs: {
      source: { from: 'probe', probe: 'cart', pointer: '/items', at: 'before' },
      normalize: [{ op: 'items', where: notRedMug }],
    },
  },
};

const before = baseline({ cart: cart(item('Green Teapot'), item('Blue Mug'), item('Red Mug')) });
const after = (...items: Json[]) => snap({ probes: { cart: cart(...items) }, baseline: before });

test.describe('reading the baseline', () => {
  test('"everything else stays": the cart after equals the cart before minus the removed item', () => {
    expect(run(keepTheRest, after(item('Green Teapot'), item('Blue Mug'))).status).toBe('pass');
    // Order does not matter.
    expect(run(keepTheRest, after(item('Blue Mug'), item('Green Teapot'))).status).toBe('pass');
    // Another item the cart held before is gone, or changed, or one was added.
    expect(run(keepTheRest, after(item('Blue Mug'))).status).toBe('fail');
    expect(run(keepTheRest, after(item('Green Teapot'), item('Blue Mug', 2))).status).toBe('fail');
    expect(run(keepTheRest, after(item('Green Teapot'), item('Blue Mug'), item('Tea Towel'))).status).toBe('fail');
    const r = run(keepTheRest, after(item('Blue Mug')));
    expect(r.evidence.map((e) => e.locator)).toEqual([
      expect.stringContaining('probe cart at /items'),
      expect.stringContaining('probe cart (before) at /items'),
    ]);
  });

  test('a snapshot without a baseline, or a probe not run before the task, abstains', () => {
    const none = snap({ probes: { cart: cart(item('Blue Mug')) } });
    expect(run(keepTheRest, none)).toMatchObject({ status: 'abstain', reason: 'evidence_unavailable' });
    expect(run(keepTheRest, none).message).toContain('no baseline was captured before the task');
    const other = snap({ probes: { cart: cart(item('Blue Mug')) }, baseline: baseline({}) });
    expect(run(keepTheRest, other)).toMatchObject({ status: 'abstain', reason: 'evidence_unavailable' });
    expect(run(keepTheRest, other).message).toContain('probe cart was not run before the task');
    const failed = snap({
      probes: { cart: cart(item('Blue Mug')) },
      baseline: baseline({ cart: { ok: false, error: '503' } }),
    });
    expect(run(keepTheRest, failed)).toMatchObject({ status: 'abstain', reason: 'probe_error' });
    // The whole check set abstains, not fails.
    expect(evaluate(one(keepTheRest), none).verdict).toBe('abstain');
  });

  test('storage before the task: read from the baseline; an unset key is an observed absence', () => {
    const theme: Assertion = {
      kind: 'value',
      source: { from: 'storage', area: 'local', key: 'theme' },
      expect: { sameAs: { source: { from: 'storage', area: 'local', key: 'theme', at: 'before' } } },
    };
    const local = (v?: string): StorageRecord => ({
      cookies: [],
      local: { 'https://shop.test': v === undefined ? {} : { theme: v } },
      session: {},
    });
    const s = (now: string, was?: string) => snap({ storage: local(now), baseline: baseline({}, local(was)) });
    expect(run(theme, s('dark', 'dark')).status).toBe('pass');
    expect(run(theme, s('dark', 'light')).status).toBe('fail');
    expect(run(theme, s('dark')).status).toBe('fail'); // not set before: nothing to be equal to
    expect(run(theme, snap({ storage: local('dark'), baseline: baseline({}, null) }))).toMatchObject({
      status: 'abstain',
      reason: 'evidence_unavailable',
    });
  });
});

test.describe('items normalizer', () => {
  const json = (value: Json) => ({ type: 'json' as const, value });
  test('filters by JSON Schema, projects by pointer and sorts, so equal collections compare equal', () => {
    const arr = [item('Red Mug'), item('Blue Mug'), item('Green Teapot')];
    expect(applyNormalizers(json(arr), [{ op: 'items', where: notRedMug, pointer: '/name' }])).toEqual(
      json(['Blue Mug', 'Green Teapot']),
    );
    expect(applyNormalizers(json(arr), [{ op: 'items', pointer: '/qty' }])).toEqual(json([1, 1, 1]));
    expect(applyNormalizers(json([]), [{ op: 'items' }])).toEqual(json([]));
  });

  test('needs an array whose items all have the pointer', () => {
    const reason = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        if (e instanceof NormalizeError) return e.reason;
        throw e;
      }
      return 'ok';
    };
    expect(reason(() => applyNormalizers(json({ a: 1 }), [{ op: 'items' }]))).toBe('type_mismatch');
    expect(reason(() => applyNormalizers({ type: 'string', value: '[]' }, [{ op: 'items' }]))).toBe('type_mismatch');
    expect(reason(() => applyNormalizers({ type: 'string', value: '[1]' }, ['json', { op: 'items' }]))).toBe('ok');
    expect(reason(() => applyNormalizers(json([{ a: 1 }, { b: 2 }]), [{ op: 'items', pointer: '/a' }]))).toBe(
      'normalize_failed',
    );
  });
});

test.describe('validation and review', () => {
  test('accepts at and items; rejects bad values and items on text; warns about a baseline-only check', () => {
    expect(validateCheckSet(one(keepTheRest))).toMatchObject({ ok: true, warnings: [] });
    const bad = (a: unknown) => validateCheckSet(one(a as Assertion));
    expect(bad({ ...keepTheRest, source: { ...(keepTheRest as { source: object }).source, at: 'yesterday' } }).ok).toBe(
      false,
    );
    expect(
      bad({
        kind: 'value',
        source: { from: 'url', part: 'pathname' },
        normalize: [{ op: 'items' }],
        expect: { exists: true },
      }).errors,
    ).toEqual([expect.stringContaining('normalizer items needs a JSON array, but the value is string')]);
    expect(
      bad({
        kind: 'value',
        source: { from: 'probe', probe: 'cart', normalize: [] },
        expect: { exists: true },
      }).ok,
    ).toBe(false);
    expect(
      bad({ ...keepTheRest, normalize: [{ op: 'items', where: { type: 'nonsense' } }] }).errors.join(' '),
    ).toContain('invalid JSON Schema');
    const onlyBefore = validateCheckSet(
      one({ kind: 'value', source: { from: 'probe', probe: 'cart', at: 'before' }, expect: { exists: true } }),
    );
    expect(onlyBefore.warnings).toEqual([expect.stringContaining('reads only the state before the task')]);
  });

  test('the review text says which side is read before the task', () => {
    expect(describeAssertion(keepTheRest)).toContain('equals backend probe cart at /items before the task');
  });
});

test.describe('snapshot digest', () => {
  test('no baseline key leaves digests unchanged; the baseline is covered except its capture time', () => {
    const s = snap();
    expect(snapshotDigest(s)).toBe(snapshotDigest({ ...s, baseline: undefined }));
    const a = after(item('Blue Mug'));
    expect(snapshotDigest(a)).not.toBe(snapshotDigest(snap({ probes: a.probes })));
    expect(snapshotDigest(a)).toBe(snapshotDigest({ ...a, baseline: { ...before, capturedAt: 'later' } }));
    expect(snapshotDigest(a)).not.toBe(snapshotDigest({ ...a, baseline: baseline({ cart: cart() }) }));
  });
});

test.describe('exploration views', () => {
  test('probes, storage and summary show the state before the task only when there is one', () => {
    const a = after(item('Blue Mug'));
    expect(probesView(a)).toMatch(/^AFTER THE TASK:\ncart: [\s\S]*BEFORE THE TASK \(baseline captured at/);
    expect(probesView(a)).toContain('Green Teapot');
    expect(storageView(a)).toContain('BEFORE THE TASK');
    expect(summary(a)).toContain('baseline before the task: probes cart');
    const plain = snap({ probes: a.probes });
    expect(probesView(plain)).not.toContain('BEFORE');
    expect(summary(plain)).not.toContain('baseline');
  });

  test('the discovery prompt documents "at" only when a reference has a baseline', async () => {
    const system = async (s: EvidenceSnapshot) => {
      const model = scripted([]);
      await compileTask(
        { id: 't', instruction: 'Remove the Red Mug, keep everything else.' },
        [{ name: 'ref', kind: 'success', snapshot: s }],
        { model, requirements: one(keepTheRest).requirements },
      ).catch(() => undefined);
      return model.requests[0]?.system ?? '';
    };
    expect(await system(after(item('Blue Mug')))).toContain('"at": "before"');
    const plain = await system(snap());
    expect(plain).toContain('You compile deterministic outcome checks');
    expect(plain).not.toContain('"at": "before"');
  });
});

test.describe('stress testing', () => {
  const removed = after(item('Green Teapot'), item('Blue Mug'));

  test('mutants: items removed, changed or added on either side, and the run that changed nothing', () => {
    const ms = generateMutants(one(keepTheRest), removed).filter((m) => m.check === 'C1');
    const ids = ms.map((m) => m.description);
    expect(ids).toContainEqual(expect.stringMatching(/^probe cart at \/items is .* \(item 1 removed\)$/));
    expect(ids).toContainEqual(expect.stringMatching(/^probe cart at \/items is .* \(an extra item\)$/));
    expect(ids).toContainEqual(expect.stringMatching(/^probe cart before the task at \/items is /));
    expect(ms.map((m) => m.id)).toContain('C1:baseline:no-op');
    for (const m of ms) expect(run(keepTheRest, m.snapshot).status, m.description).not.toBe('pass');
    // The baseline's Red Mug is filtered out: removing it there is not a violation, so it is not a mutant.
    const unchanged = (s: EvidenceSnapshot) => JSON.stringify(s.baseline!.probes.cart);
    const redGone = JSON.stringify(cart(item('Green Teapot'), item('Blue Mug')));
    expect(ms.some((m) => unchanged(m.snapshot) === redGone)).toBe(false);
  });

  test('no no-op mutant when the correct run left the state as it was', () => {
    const same: Assertion = {
      ...keepTheRest,
      expect: { sameAs: { source: { from: 'probe', probe: 'cart', pointer: '/items', at: 'before' } } },
      normalize: undefined,
    };
    const kept = snap({ probes: before.probes, baseline: before });
    expect(generateMutants(one(same), kept).map((m) => m.id)).not.toContain('C1:baseline:no-op');
  });

  test('variants that reshape API JSON reshape the baseline too, so the binding accepts them', () => {
    const vs = generateVariants(one(keepTheRest), removed);
    const fields = vs.find((v) => v.id === 'extra-json-fields')!;
    expect(JSON.stringify(fields.snapshot.baseline!.probes)).toContain('requestId');
    const r = stressTest(one(keepTheRest), [{ name: 'removed', snapshot: removed }]);
    expect(r.overConstrained).toEqual([]);
    expect(r.weak).toEqual([]);
    expect(r.missed).toEqual([]);
  });

  test('the Tiny Shop references: compiled-era checks miss a removed Teapot, the baseline check does not', () => {
    const ref = (name: string) =>
      JSON.parse(
        readFileSync(
          new URL(`../../examples/tiny-shop/references/04-remove-red-mug/${name}.json`, import.meta.url),
          'utf8',
        ),
      ) as { label: { expected: string }; snapshot: EvidenceSnapshot };
    const tasks = JSON.parse(
      readFileSync(new URL('../../examples/tiny-shop/tasks/04-remove-red-mug.checks.json', import.meta.url), 'utf8'),
    ) as CheckSet;
    const teapotGone = ref('removed-red-mug-and-teapot');
    expect(teapotGone.snapshot.baseline).toBeDefined();
    expect(evaluate(tasks, teapotGone.snapshot).verdict).toBe('fail');
    expect(evaluate(tasks, ref('removed-red-mug-keeping-teapot').snapshot).verdict).toBe('success');
  });
});
