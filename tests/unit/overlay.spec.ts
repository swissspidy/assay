/**
 * Overlay stress and capture-time digests (ADR 0016): overlay runs give what full runs give,
 * targeted and shared tree edits give what whole-tree edits gave, and a digest taken at
 * capture time is used only for the captured, unchanged object.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { snapshotDigest, verify, type CheckSet, type EvidenceSnapshot } from '../../src/index.ts';
import { buildStore, changedKeys } from '../../src/store/store.ts';
import { compileChecks, PlanRun, runPlan } from '../../src/plan/plan.ts';
import { readKeys, readsChanged, readSetOf } from '../../src/plan/readset.ts';
import { AXIndex } from '../../src/runtime/axindex.ts';
import { regularTree } from '../../src/store/ax.ts';
import { capturedDigest, sealDigest } from '../../src/snapshot/digest.ts';
import { generateMutants, generateVariants, withSuccessClaim } from '../../src/stress/index.ts';
import { clone, editById, sameJson, setPointer, withPointer } from '../../src/stress/edit.ts';
import type { AXNode, Json } from '../../src/types.ts';
import { collectCases, normalize } from './equivalence/cases.ts';

const shop = (f: string) => new URL(`../../examples/tiny-shop/${f}`, import.meta.url);
const run = (f: string) => JSON.parse(readFileSync(shop(f), 'utf8')) as { snapshot: EvidenceSnapshot };
const checks = (f: string) => JSON.parse(readFileSync(shop(f), 'utf8')) as CheckSet;

test('an overlay run gives, check by check, what a full run of the same snapshot gives', () => {
  test.setTimeout(120_000);
  // Every fourth committed stress case: each variant, mutant and success claim run as an
  // overlay on its reference (or its mutant), against a full run on a copy (no shared parts).
  const cases = collectCases().stress.filter((_, i) => i % 4 === 0);
  let overlays = 0;
  for (const c of cases) {
    const plan = compileChecks(c.checkSet);
    for (const r of c.refs) {
      const ref = new PlanRun(plan, buildStore(r.snapshot));
      expect(ref.outcome()).toEqual(runPlan(plan, buildStore(structuredClone(r.snapshot))));
      const same = (s: EvidenceSnapshot, over: PlanRun) => {
        const o = new PlanRun(plan, buildStore(s), over);
        const full = runPlan(plan, buildStore(structuredClone(s)), { digests: false });
        expect(JSON.stringify(o.outcome({ digests: false }))).toBe(JSON.stringify(full));
        overlays++;
        return o;
      };
      for (const v of generateVariants(c.checkSet, r.snapshot)) same(v.snapshot, ref);
      for (const m of generateMutants(c.checkSet, r.snapshot)) {
        const o = same(m.snapshot, ref);
        same(withSuccessClaim(m).snapshot, o);
      }
    }
  }
  expect(overlays).toBeGreaterThan(500);
});

test('read keys name the parts of a snapshot a check reads, and changed keys what an overlay replaced', () => {
  const cs = checks('tasks/07-express-order.checks.json');
  for (const c of compileChecks(cs).checks) expect(c.reads).toEqual(readKeys(c.readSet));
  const keys = readKeys(
    readSetOf({
      kind: 'allOf',
      of: [
        { kind: 'value', source: { from: 'probe', probe: 'cart', at: 'before' }, expect: { exists: true } },
        { kind: 'value', source: { from: 'probe', probe: 'orders' }, expect: { exists: true } },
        { kind: 'value', source: { from: 'storage', area: 'local', key: 'k' }, expect: { exists: true } },
        { kind: 'state', target: { anchors: [] }, expect: { checked: true } },
      ],
    }),
  )!;
  expect([...keys].toSorted()).toEqual(['a11y', 'baseline.probes:cart', 'page', 'probes:orders', 'storage']);
  // An unknown kind may read anything.
  expect(readKeys(readSetOf({ kind: 'nope' } as never))).toBeNull();

  const { snapshot } = run('references/07-express-order/express-order.json');
  const s: EvidenceSnapshot = {
    ...snapshot,
    baseline: { capturedAt: 'x', url: 'u', storage: null, probes: { cart: { ok: true, value: 1 } }, redacted: [] },
  };
  expect(changedKeys(s, { ...s })).toEqual(new Set());
  const probes = { ...s.probes, orders: { ok: true as const, value: [] } };
  expect(changedKeys(s, { ...s, probes })).toEqual(new Set(['probes:orders']));
  expect(changedKeys(s, { ...s, a11y: { role: 'document' }, text: '' })).toEqual(new Set(['a11y', 'text']));
  const baseline = { ...s.baseline!, probes: { cart: { ok: true as const, value: 2 } } };
  expect(changedKeys(s, { ...s, baseline })).toEqual(new Set(['baseline.probes:cart']));
  const { baseline: _gone, ...without } = s;
  expect(changedKeys(s, without as EvidenceSnapshot)).toEqual(new Set(['baseline']));
  expect(readsChanged(keys, new Set(['baseline']))).toBe(true); // above baseline.probes:cart
  expect(readsChanged(keys, new Set(['probes:cart', 'network', 'text']))).toBe(false);
  expect(readsChanged(keys, new Set(['probes:orders']))).toBe(true);
});

test('an edit shares what it leaves alone, and an edit by ids gives what the whole walk gives', () => {
  const { snapshot } = run('references/07-express-order/express-order.json');
  const index = AXIndex.of(snapshot.a11y);
  expect(regularTree(snapshot.a11y)).toBe(true);
  const ids = [3, 7, index.all.length - 1];
  const edit = (n: AXNode, id: number) =>
    id === 3 ? null : id === 7 ? [n, { role: 'text', name: 'x' }] : ids.includes(id) ? { ...n, name: 'y' } : undefined;
  const whole = editById(snapshot, edit);
  const targeted = editById(snapshot, edit, ids);
  expect(JSON.stringify(targeted)).toBe(JSON.stringify(whole));
  // Subtrees off the edited paths are the original objects.
  const original = new Set(index.all.map((n) => n.node));
  const nodes = (t: AXNode): AXNode[] => [t, ...(t.children ?? []).flatMap(nodes)];
  const shared = nodes(targeted.a11y).filter((n) => original.has(n)).length;
  expect(shared).toBeGreaterThan(0);
  expect(nodes(whole.a11y).filter((n) => original.has(n)).length).toBe(shared);
  // No edit: the same tree.
  expect(editById(snapshot, () => undefined).a11y).toBe(snapshot.a11y);
  expect(editById(snapshot, () => undefined, []).a11y).toBe(snapshot.a11y);
  // An empty `children` list is dropped, as the whole walk always dropped it.
  const irregular = { ...snapshot, a11y: { role: 'document', children: [{ role: 'list', children: [] }] } };
  expect(regularTree(irregular.a11y)).toBe(false);
  expect(editById(irregular, () => undefined, []).a11y).toEqual({ role: 'document', children: [{ role: 'list' }] });
});

test('sameJson and withPointer agree with JSON.stringify and setPointer on a copy', () => {
  const docs: Json[] = [{ a: [1, 2, { b: null }], c: 'x' }, [{ x: 1 }, { x: 2 }], { a: { b: { c: [true, false] } } }];
  const variants = (d: Json): unknown[] => [
    d,
    clone(d),
    JSON.parse(JSON.stringify(d)),
    { ...(d as object), extra: undefined },
    Array.isArray(d) ? [...d].toReversed() : { z: 1, ...(d as object) },
  ];
  for (const d of docs)
    for (const x of variants(d))
      for (const y of variants(d)) expect(sameJson(x, y)).toBe(JSON.stringify(x) === JSON.stringify(y));
  expect(sameJson([undefined], [null])).toBe(true);
  expect(sameJson({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false); // key order, as JSON.stringify sees it
  for (const [doc, pointer, value] of [
    [{ a: [1, 2, 3] }, '/a/1', 9],
    [{ a: [1, 2, 3] }, '/a/1', undefined],
    [{ a: { 'b/c': 1 } }, '/a/b~1c', 2],
    [{ a: 1 }, '/x/y', 2],
    [{ a: 1 }, 'a', 2],
    [[{ k: 1 }], '/0/k', undefined],
  ] as [Json, string, Json | undefined][]) {
    const copy = clone(doc);
    const ok = setPointer(copy, pointer, value);
    const before = JSON.stringify(doc);
    const out = withPointer(doc, pointer, value);
    expect(out === undefined).toBe(!ok);
    if (out) expect(out.doc).toEqual(copy);
    expect(JSON.stringify(doc)).toBe(before); // the original is never edited
  }
});

test('a digest taken at capture time is used for the captured object only, while it is unchanged', async () => {
  const cs = checks('tasks/07-express-order.checks.json');
  const { snapshot } = run('references/07-express-order/express-order.json');
  const captured = structuredClone(snapshot);
  const digest = sealDigest(captured);
  expect(digest).toBe(snapshotDigest(snapshot));
  expect(capturedDigest(captured)).toBe(digest);
  expect(capturedDigest(structuredClone(captured))).toBeUndefined(); // a copy (or a parsed file)
  expect(capturedDigest(JSON.parse(JSON.stringify(captured)))).toBeUndefined();
  // The record is the one verify gives for the same snapshot read from its file.
  const fromFile = JSON.parse(JSON.stringify(snapshot)) as EvidenceSnapshot;
  expect(normalize(await verify(cs, captured))).toEqual(normalize(await verify(cs, fromFile)));
  expect(JSON.stringify(captured)).toBe(JSON.stringify(snapshot)); // nothing was added to the snapshot

  // A sealed snapshot is frozen: no field, at any depth, can be replaced. A copy can be edited
  // and computes its own digest.
  const edits: ((s: EvidenceSnapshot) => void)[] = [
    (s) => (s.text = `${s.text}!`),
    (s) => (s.page.url = `${s.page.url}?x`),
    (s) => (s.meta.redacted = ['x']),
    (s) => (s.network = []),
    (s) => delete (s as Partial<EvidenceSnapshot>).network,
    (s) => ((s as EvidenceSnapshot & { extra: number }).extra = 1),
    (s) => (s.capturedAt = 'later'),
  ];
  for (const e of edits) {
    const s = structuredClone(snapshot);
    sealDigest(s);
    expect(() => e(s)).toThrow(TypeError);
    expect(capturedDigest(s)).toBe(digest);
    const copy = structuredClone(s);
    e(copy);
    expect(capturedDigest(copy)).toBeUndefined();
    expect(buildStore(copy).digest).toBe(snapshotDigest(copy));
  }
  // Anything but JSON data is neither frozen nor sealed.
  const odd = { ...structuredClone(snapshot), when: new Date(0) };
  sealDigest(odd);
  expect(Object.isFrozen(odd)).toBe(false);
  expect(capturedDigest(odd)).toBeUndefined();
});

test('review: an in-place edit inside a section of a captured snapshot never leaves its record a stale digest', () => {
  const { snapshot } = run('references/07-express-order/express-order.json');
  const edits: ((s: EvidenceSnapshot) => void)[] = [
    (s) => (s.network![0]!.status = 599),
    (s) => (s.a11y.children![0]!.name = 'edited'),
    (s) => s.network!.pop(),
    (s) => ((s.probes as Record<string, unknown>).extra = { ok: true, value: 1 }),
  ];
  for (const e of edits) {
    const s = structuredClone(snapshot);
    sealDigest(s);
    try {
      e(s); // a sealed snapshot is frozen: the edit throws (strict mode) and changes nothing
    } catch {
      /* expected */
    }
    expect(buildStore(s).digest).toBe(snapshotDigest(s));
  }
});

test('review: a node with an inherited children list is not regular, and a targeted edit matches the whole walk', () => {
  const odd = Object.assign(Object.create({ children: [{ role: 'text', name: 'inherited' }] }) as AXNode, {
    role: 'group',
  });
  const s = { ...run('references/07-express-order/express-order.json').snapshot };
  s.a11y = { role: 'document', children: [odd, { role: 'heading', name: 'h' }] };
  expect(regularTree(s.a11y)).toBe(false);
  const edit = (n: AXNode, id: number) => (id === 3 ? { ...n, name: 'x' } : undefined);
  const whole = editById(s, edit);
  expect(JSON.stringify(editById(s, edit, [3]))).toBe(JSON.stringify(whole));
  // As before sharing: the copy holds the inherited list as its own.
  expect(whole.a11y.children![0]).toEqual({ role: 'group', children: [{ role: 'text', name: 'inherited' }] });
});

test('review: sameJson agrees with JSON.stringify for values with toJSON, given their keys', () => {
  const byKey = { toJSON: (k: string) => k };
  const cases: [unknown, unknown][] = [
    [{ a: { toJSON: () => 1 } }, { a: { toJSON: () => 2 } }],
    [{ a: byKey }, { b: byKey }],
    [{ a: byKey }, { a: 'a' }],
    [[byKey], ['0']],
    [{ d: new Date(0) }, { d: new Date(0).toISOString() }],
  ];
  for (const [a, b] of cases)
    expect(sameJson(a, b), JSON.stringify([a, b])).toBe(JSON.stringify(a) === JSON.stringify(b));
});

test('review: a success claim on a tree with holes in a children list is added as the whole walk adds it', () => {
  const { snapshot } = run('references/07-express-order/express-order.json');
  const holey = [{ role: 'heading', name: 'h' }] as AXNode[];
  holey[2] = { role: 'text', name: 't' }; // index 1 is a hole
  const s = { ...snapshot, a11y: { role: 'document', children: [{ role: 'main', children: holey }] } };
  const claimed = withSuccessClaim({ id: 'm', description: 'd', snapshot: s });
  expect(claimed.snapshot.a11y).toEqual({
    role: 'document',
    children: [
      {
        role: 'main',
        children: [
          { role: 'status', children: [{ role: 'text', name: 'Success! Your request has been completed.' }] },
          { role: 'heading', name: 'h' },
          { role: 'text', name: 't' },
        ],
      },
    ],
  });
});
