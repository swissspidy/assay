/** The evidence store and compiled check plans (ADR 0015): layout invariants, caching and read-sets. */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { snapshotDigest, checkSetDigest, type CheckSet, type EvidenceSnapshot } from '../../src/index.ts';
import { buildStore } from '../../src/store/store.ts';
import { compileChecks } from '../../src/plan/plan.ts';
import { AXIndex } from '../../src/runtime/axindex.ts';
import { canonicalJson, sha256 } from '../../src/snapshot/digest.ts';

const shop = (f: string) => new URL(`../../examples/tiny-shop/${f}`, import.meta.url);
const run = (f: string) => JSON.parse(readFileSync(shop(f), 'utf8')) as { snapshot: EvidenceSnapshot };
const checks = (f: string) => JSON.parse(readFileSync(shop(f), 'utf8')) as CheckSet;

test('the tree is stored in pre-order: parents before children, subtrees as id ranges, roles indexed', () => {
  const { snapshot } = run('references/07-express-order/express-order.json');
  const index = new AXIndex(snapshot.a11y);
  const t = index.table;
  expect(t.size).toBe(index.all.length);
  for (let i = 0; i < t.size; i++) {
    const n = index.all[i]!;
    expect(n.id).toBe(i);
    expect(t.parent[i]).toBe(n.parent ? n.parent.id : -1);
    expect(t.depth[i]).toBe(n.parent ? t.depth[n.parent.id]! + 1 : 0);
    // The subtree range, against descendants found by walking parent links (not the ranges themselves).
    const below = index.all.filter((d) => {
      for (let a = d.parent; a; a = a.parent) if (a === n) return true;
      return false;
    });
    expect(index.all.slice(i + 1, t.end[i]).map((d) => d.id)).toEqual(below.map((d) => d.id));
  }
  for (const role of new Set(index.all.map((n) => n.node.role)))
    expect([...t.withRole(role)]).toEqual(index.all.filter((n) => n.node.role === role).map((n) => n.id));
  for (const n of index.all.filter((x) => x.node.name !== undefined)) {
    const same = index.all.filter(
      (x) => x.node.role === n.node.role && index.canonicalName(x) === index.canonicalName(n),
    );
    expect([...t.withRoleAndName(n.node.role, index.canonicalName(n)!)!]).toEqual(same.map((x) => x.id));
  }
  expect(t.withRole('no-such-role').length).toBe(0);
  expect(AXIndex.of(snapshot.a11y)).toBe(AXIndex.of(snapshot.a11y));
});

test('a store is built once per snapshot object and its digests are the snapshot digests', () => {
  const { snapshot } = run('references/07-express-order/express-order.json');
  const store = buildStore(snapshot);
  expect(buildStore(snapshot)).toBe(store);
  expect(buildStore(structuredClone(snapshot))).not.toBe(store);
  expect(store.digest).toBe(snapshotDigest(snapshot));
  expect(store.sectionDigests.a11y).toBe(sha256(canonicalJson(snapshot.a11y)));
  expect(store.sectionDigests.network).toBe(sha256(canonicalJson(snapshot.network)));
  expect(Object.keys(store.sectionDigests)).not.toContain('capturedAt');
  expect(store.network?.size).toBe(snapshot.network?.length);
});

test('a plan is compiled once per check set object, with its digest and read-sets', () => {
  const cs = checks('tasks/07-express-order.checks.json');
  const plan = compileChecks(cs);
  expect(compileChecks(cs)).toBe(plan);
  expect(plan.digest).toBe(checkSetDigest(cs));
  expect(plan.assertValid()).toBe(cs);
  expect(plan.checks.map((c) => c.check.id)).toEqual(cs.checks.map((c) => c.id));
  const rs = plan.readSet;
  expect(rs.requests.length + rs.probes.length).toBeGreaterThan(0);
  for (const c of plan.checks) {
    for (const r of c.readSet.roles) expect(rs.roles).toContain(r);
    if (c.readSet.a11y) expect(rs.a11y).toBe(true);
  }
  const invalid = compileChecks({ ...cs, checks: 'nope' });
  expect(() => invalid.assertValid()).toThrow(/check set/i);
});

test('read-sets name what each kind of check reads', () => {
  const cs: CheckSet = {
    schema: 'assay.checks/v1',
    id: 'reads',
    version: '1',
    task: { instruction: 'x' },
    requirements: [{ id: 'R1', kind: 'hard', text: 'x', source: { field: 'instruction', quote: 'x' } }],
    checks: [
      {
        id: 'C1',
        requirement: 'R1',
        description: 'x',
        assert: {
          kind: 'value',
          source: { from: 'storage', area: 'local', key: 'cart' },
          expect: { sameAs: { source: { from: 'probe', probe: 'cart', at: 'before' } } },
        },
      },
      {
        id: 'C2',
        requirement: 'R1',
        description: 'x',
        assert: {
          kind: 'each',
          match: { role: 'row', within: { role: 'table', name: 'Cart' } },
          assert: { kind: 'value', source: { from: 'text', pattern: '\\d+' }, expect: { exists: true } },
        },
      },
      {
        id: 'C3',
        requirement: 'R1',
        description: 'x',
        assert: { kind: 'page', match: { title: 'Receipt' }, assert: { kind: 'url', match: { path: '/r' } } },
      },
    ],
  };
  const [c1, c2, c3] = compileChecks(cs).checks.map((c) => c.readSet);
  expect(c1).toMatchObject({
    a11y: false,
    url: true, // local storage at the page's origin
    storage: [{ area: 'local', key: 'cart', at: 'after' }],
    probes: [{ probe: 'cart', at: 'before' }],
  });
  expect(c2).toMatchObject({ a11y: true, text: false, roles: ['row', 'table'] }); // text inside a record is the record's
  expect(c3).toMatchObject({ pages: true, url: true, a11y: false });
});

test('a check set that contains itself is reported invalid, not a stack overflow', () => {
  const schema: Record<string, unknown> = { type: 'object' };
  schema.properties = { self: schema };
  const cs = structuredClone(checks('tasks/07-express-order.checks.json'));
  cs.checks[0]!.assert = { kind: 'request', match: { responseBody: schema as never } };
  const report = compileChecks(cs).report;
  expect(report.ok).toBe(false);
  expect(report.errors).toEqual(['/checks/0/assert/match/responseBody/properties/self contains itself (a cycle)']);
});
