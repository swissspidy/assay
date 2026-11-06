/**
 * Equivalence of the evidence store and compiled plans with the evaluator they replaced
 * (ADR 0015): `verify` and `stressTest` on every committed snapshot and check set return
 * what the evaluator of the commit in golden.json.gz returned, byte for byte (records
 * without their id, time and timings).
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { verify, verifyMany } from '../../src/index.ts';
import { stressTest } from '../../src/stress/index.ts';
import { collectCases, digest, GOLDEN, normalize, type Golden, type VerifyCase } from './equivalence/cases.ts';

const golden = JSON.parse(gunzipSync(readFileSync(GOLDEN)).toString('utf8')) as Golden;
const cases = collectCases();

async function result(cs: unknown, snapshot: VerifyCase['snapshot']): Promise<unknown> {
  try {
    return normalize(await verify(cs, snapshot));
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Compare with the golden result: the full JSON where it was kept, the digest otherwise. */
function same(id: string, actual: unknown): void {
  const want = golden.verify[id];
  expect(want, `golden result for ${id}`).toBeDefined();
  if (want!.json !== undefined && JSON.stringify(actual) !== want!.json)
    expect(actual, id).toEqual(JSON.parse(want!.json)); // a readable diff (also fails on key order below)
  expect(digest(actual), id).toBe(want!.digest);
}

test('every committed snapshot and check set has a golden result, and no golden result is stale', () => {
  expect(cases.verify.map((c) => c.id).toSorted()).toEqual(Object.keys(golden.verify).toSorted());
  expect(cases.stress.map((c) => c.id).toSorted()).toEqual(Object.keys(golden.stress).toSorted());
});

test('verify returns the golden outcome and record for every case, cold and warm', async () => {
  test.setTimeout(120_000);
  // Cold: fresh copies of both, so neither store nor plan is cached yet.
  for (const c of cases.verify.filter((x) => x.own))
    same(c.id, await result(structuredClone(c.checkSet), structuredClone(c.snapshot)));
  // Shared objects: the first call builds the store and the plan, later calls reuse them.
  for (let pass = 0; pass < 2; pass++) for (const c of cases.verify) same(c.id, await result(c.checkSet, c.snapshot));
});

test('verifyMany returns the golden outcome and record for every case, and what verify returns', async () => {
  test.setTimeout(120_000);
  const bySet = Map.groupBy(cases.verify, (c) => c.checkSet);
  for (const [checkSet, group] of bySet) {
    const many = await verifyMany(
      checkSet,
      group.map((c) => c.snapshot),
    );
    many.forEach((r, i) => same(group[i]!.id, normalize(r)));
  }
  // With options that reach the record, on fresh copies (nothing cached yet).
  const opts = { taskId: 'batch', agentReport: 'I did it.' };
  for (const [checkSet, group] of [...bySet].slice(0, 12)) {
    const snaps = group.map((c) => structuredClone(c.snapshot));
    const one = await Promise.all(snaps.map((s) => verify(checkSet, s, opts)));
    const many = await verifyMany(structuredClone(checkSet), snaps, opts);
    expect(many.map(normalize)).toEqual(one.map(normalize));
    expect(JSON.stringify(many.map(normalize))).toBe(JSON.stringify(one.map(normalize)));
  }
  expect(await verifyMany(cases.verify[0]!.checkSet, [])).toEqual([]);
});

test('stressTest returns the golden report for every committed check set', () => {
  test.setTimeout(120_000);
  for (const s of cases.stress)
    expect(digest(stressTest(s.checkSet, s.refs, { skipVariants: s.skipVariants })), s.id).toBe(golden.stress[s.id]);
});
