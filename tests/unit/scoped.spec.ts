/**
 * Scoped snapshots (ADR 0025): a snapshot scoped to a check set verifies, with that set, to the
 * outcome the full snapshot gives (every committed snapshot and check set); used with another
 * set, for stress, compiling or escalation, it is refused with a clear error; its digest is
 * defined by its content and stable.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  evaluate,
  isScoped,
  loadSnapshot,
  scopeSnapshot,
  ScopedSnapshotError,
  snapshotDigest,
  verify,
  verifyMany,
  type CheckSet,
  type EvidenceSnapshot,
  type Outcome,
  type ScopedSnapshot,
} from '../../src/index.ts';
import { stressTest } from '../../src/stress/index.ts';
import { compileTask } from '../../src/compiler/compile.ts';
import { approveCheckSet, contentDigest } from '../../src/verifier/lock.ts';
import { collectCases } from './equivalence/cases.ts';

const shop = (f: string) => new URL(`../../examples/tiny-shop/${f}`, import.meta.url);
const readJson = <T>(u: URL): T => JSON.parse(readFileSync(u, 'utf8')) as T;
const run = (f: string) => readJson<{ snapshot: EvidenceSnapshot }>(shop(f)).snapshot;
const checks = (f: string) => readJson<CheckSet>(shop(f));

/** An outcome without the snapshot digest, which is the scoped snapshot's own. */
const sansDigest = (o: Outcome) => ({ ...o, snapshot: { ...o.snapshot, digest: '' } });

test('every committed snapshot, scoped to each check set of its app, verifies to the full outcome', async () => {
  test.setTimeout(300_000);
  const cases = collectCases().verify;
  let compared = 0;
  for (const c of cases) {
    const full = await verify(c.checkSet, c.snapshot);
    const scoped = scopeSnapshot(c.snapshot, c.checkSet);
    const res = await verify(c.checkSet, scoped);
    expect(JSON.stringify(sansDigest(res.outcome)), c.id).toBe(JSON.stringify(sansDigest(full.outcome)));
    expect(res.outcome.snapshot.digest).toBe(snapshotDigest(scoped));
    expect(res.record.snapshot.digest).toBe(snapshotDigest(scoped));
    compared++;
  }
  expect(compared).toBe(cases.length);
  expect(compared).toBeGreaterThan(5000);
});

test('verifyMany takes scoped and full snapshots together', async () => {
  const cs = checks('tasks/02-add-blue-mug.checks.json');
  const snaps = ['added-blue-mug', 'added-red-mug'].map((n) => run(`references/02-add-blue-mug/${n}.json`));
  const mixed = await verifyMany(cs, [scopeSnapshot(snaps[0]!, cs), snaps[1]!]);
  const plain = await verifyMany(cs, snaps);
  expect(mixed.map((r) => sansDigest(r.outcome))).toEqual(plain.map((r) => sansDigest(r.outcome)));
  expect(mixed[1]!.outcome).toEqual(plain[1]!.outcome);
});

test('a scoped snapshot keeps only what the check set reads', () => {
  const cs = checks('tasks/07-express-order.checks.json');
  const full = run('references/07-express-order/express-order.json');
  const s = scopeSnapshot(full, cs);
  expect(s.schema).toBe('assay.snapshot.scoped/v1');
  expect(s.scope).toEqual({
    checkSet: { id: cs.id, version: cs.version, content: contentDigest(cs) },
    reads: expect.any(Array),
    source: snapshotDigest(full),
  });
  for (const k of ['a11y', 'text', 'pages', 'network', 'storage', 'probes'] as const)
    expect(k in s, k).toBe(s.scope.reads.some((r) => r === k || r.startsWith(`${k}:`)) && full[k] !== undefined);
  if (s.network) {
    expect(s.network.length).toBeLessThan(full.network!.length);
    expect(s.network.every((e) => full.network!.includes(e))).toBe(true);
  }
  expect(JSON.stringify(s).length).toBeLessThan(JSON.stringify(full).length);
});

test('storage, probes and the baseline keep only the keys and probes read', () => {
  const full: EvidenceSnapshot = {
    schema: 'assay.snapshot/v1',
    capturedAt: '2026-11-09T00:00:00Z',
    page: { url: 'https://app.test/', title: 'App' },
    a11y: { role: 'document', children: [{ role: 'heading', name: 'Hello' }] },
    text: 'Hello',
    network: [],
    storage: {
      cookies: [
        { name: 'theme', value: 'dark', domain: 'app.test', path: '/', httpOnly: false, secure: false },
        { name: 'other', value: 'x', domain: 'app.test', path: '/', httpOnly: false, secure: false },
      ],
      local: { 'https://app.test': { cart: '[]', noise: '1' }, 'https://cdn.test': { noise: '2' } },
      session: { 'https://app.test': { tab: '1' } },
    },
    probes: { cart: { ok: true, value: { items: [] } }, unrelated: { ok: true, value: 1 } },
    baseline: {
      capturedAt: '2026-11-09T00:00:00Z',
      url: 'https://app.test/',
      storage: null,
      probes: { cart: { ok: true, value: { items: [1] } }, other: { ok: true, value: 2 } },
      redacted: [],
    },
    meta: { capturer: 'test', redacted: [] },
  };
  const cs: CheckSet = {
    schema: 'assay.checks/v1',
    id: 'x',
    version: '1',
    task: { instruction: 'Empty the cart in dark mode.' },
    requirements: [{ id: 'R1', kind: 'hard', text: 't', source: { field: 'instruction', quote: 'Empty the cart' } }],
    checks: [
      {
        id: 'C1',
        requirement: 'R1',
        description: 'd',
        assert: {
          kind: 'value',
          source: { from: 'probe', probe: 'cart', pointer: '/items' },
          expect: { sameAs: { source: { from: 'probe', probe: 'cart', pointer: '/items', at: 'before' } } },
        },
      },
      {
        id: 'C2',
        requirement: 'R1',
        description: 'd',
        assert: {
          kind: 'value',
          source: { from: 'storage', area: 'cookie', key: 'theme' },
          expect: { equals: 'dark' },
        },
      },
      {
        id: 'C3',
        requirement: 'R1',
        description: 'd',
        assert: { kind: 'value', source: { from: 'storage', area: 'local', key: 'cart' }, expect: { equals: '[]' } },
      },
    ],
  };
  const s = scopeSnapshot(full, cs);
  expect(s).toEqual({
    schema: 'assay.snapshot.scoped/v1',
    capturedAt: full.capturedAt,
    scope: {
      checkSet: { id: 'x', version: '1', content: contentDigest(cs) },
      reads: ['baseline.probes:cart', 'page', 'probes:cart', 'storage'],
      source: snapshotDigest(full),
    },
    page: full.page,
    storage: { cookies: [full.storage!.cookies[0]], local: { 'https://app.test': { cart: '[]' } }, session: {} },
    probes: { cart: full.probes.cart },
    baseline: {
      capturedAt: full.capturedAt,
      url: full.baseline!.url,
      probes: { cart: full.baseline!.probes.cart },
      redacted: [],
    },
    meta: full.meta,
  });
  expect(loadSnapshot(JSON.stringify(s), { scoped: true })).toEqual(s);
});

test('a scoped snapshot is refused by another check set, stress, compiling, evaluate and loadSnapshot', async () => {
  const cs = checks('tasks/02-add-blue-mug.checks.json');
  const other = checks('tasks/03-cart-two-mugs.checks.json');
  const full = run('references/02-add-blue-mug/added-blue-mug.json');
  const s = scopeSnapshot(full, cs);
  await expect(verify(other, s)).rejects.toThrow(ScopedSnapshotError);
  await expect(verify(other, s)).rejects.toThrow(
    /scoped snapshot .* for check set tiny-shop\/add-blue-mug v1 .* cannot verify tiny-shop\/cart-two-mugs v1/,
  );
  // A changed check (same id and version) is another set too.
  const edited = structuredClone(cs);
  edited.checks[0]!.description += ' (edited)';
  await expect(verify(edited, s)).rejects.toThrow(ScopedSnapshotError);
  expect(() => stressTest(cs, [{ name: 'r', snapshot: s as unknown as EvidenceSnapshot }])).toThrow(
    /Stress testing \(reference r\) needs a full snapshot/,
  );
  await expect(
    compileTask({ id: 't', instruction: 'x' }, [
      { name: 'r', kind: 'success', snapshot: s as unknown as EvidenceSnapshot },
    ]),
  ).rejects.toThrow(/Compiling \(reference r\) needs a full snapshot/);
  expect(() => evaluate(cs, s as unknown as EvidenceSnapshot)).toThrow(/scoped snapshot/);
  expect(() => loadSnapshot(JSON.stringify(s))).toThrow(
    /scoped snapshot .* only verify with that check set accepts it/,
  );
  expect(() => scopeSnapshot(s as unknown as EvidenceSnapshot, cs)).toThrow(ScopedSnapshotError);
  expect(() => loadSnapshot({ ...s, scope: { reads: [] } }, { scoped: true })).toThrow(/no valid scope/);
});

test('approving the check set keeps its scoped snapshots valid; locking is not a change of what it reads', async () => {
  const cs = checks('tasks/02-add-blue-mug.checks.json');
  const s = scopeSnapshot(run('references/02-add-blue-mug/added-blue-mug.json'), cs);
  const locked = approveCheckSet(cs, { by: 'reviewer@example.com' });
  expect((await verify(locked, s)).outcome.verdict).toBe('success');
});

test('a scoped snapshot is never escalated: the requirement stays undecided and the record says why', async () => {
  // The two-mugs set abstains on the newsletter run: it would escalate a full snapshot.
  const cs = checks('tasks/03-cart-two-mugs.checks.json');
  const s = scopeSnapshot(run('references/01-newsletter/never-subscribed.json'), cs);
  let called = 0;
  const verifier = {
    id: 'never',
    async turn() {
      called++;
      throw new Error('must not run');
    },
  };
  const res = await verify(cs, s, { verifier });
  expect(called).toBe(0);
  expect(res.outcome.verdict).toBe('abstain');
  expect(res.record.escalation).toMatchObject({
    status: 'error',
    error: expect.stringMatching(/^Escalation needs a full snapshot/),
  });
  expect(isScoped(res.snapshot)).toBe(true);
});

test('the digest of a scoped snapshot is defined by its content and stable', () => {
  const cs = checks('tasks/07-express-order.checks.json');
  const full = run('references/07-express-order/express-order.json');
  const a = scopeSnapshot(full, cs);
  const b = scopeSnapshot(structuredClone(full), structuredClone(cs));
  expect(snapshotDigest(a)).toBe(snapshotDigest(b));
  // Through a file and back, and with another capture time.
  const c = JSON.parse(JSON.stringify(a)) as ScopedSnapshot;
  expect(snapshotDigest({ ...c, capturedAt: '2030-01-01T00:00:00Z' })).toBe(snapshotDigest(a));
  // Pinned: scoping is deterministic, so a changed digest here means the format changed.
  expect(snapshotDigest(a)).toBe('sha256:ab51835fd1d899a2800dee99e6ff815c37b10e7be5653b16342fa56513dcccb5');
  expect(snapshotDigest(a)).not.toBe(snapshotDigest(full));
  // Another check set gives another scope, and so another digest.
  const other = scopeSnapshot(full, checks('compiled/07-express-order.checks.json'));
  expect(snapshotDigest(other)).not.toBe(snapshotDigest(a));
});
