/**
 * Trajectory capture (ADR 0024), live: the recorder records requests and navigations in
 * order when asked to, the Tiny Pharmacy runs that differ only in order get different
 * verdicts, and a recorder not asked for it leaves snapshots as they were.
 */
import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { captureScopedSnapshot, captureSnapshot, test } from '../src/playwright/index.ts';
import { evaluate, verify, type CheckSet } from '../src/index.ts';
import { RUNS, refillProbes, runRefill, startRefillApp, type RefillApp } from '../examples/refill/app.ts';

const CHECKS = JSON.parse(
  readFileSync(new URL('../examples/refill/refill.checks.json', import.meta.url), 'utf8'),
) as CheckSet;

let app: RefillApp;
test.beforeEach(async () => {
  app = await startRefillApp();
});
test.afterEach(async () => {
  await app.close();
});

test.describe('with the trajectory recorded', () => {
  test.use({ evidenceOptions: { trajectory: true } });

  for (const run of RUNS)
    test(`${run.name} → ${run.expected}`, async ({ page }) => {
      await runRefill(page, app.origin, run.order);
      const s = await captureSnapshot(page, { probes: refillProbes(app) });
      // Every request is in the trajectory once, in the order of the log; navigations in between.
      const requests = s.trajectory!.flatMap((e) => (e.type === 'request' ? [e.seq] : []));
      expect(requests).toEqual(s.network!.map((e) => e.seq));
      expect(s.trajectory!.filter((e) => e.type === 'navigation').map((e) => e.type === 'navigation' && e.url)).toEqual(
        [`${app.origin}/`, `${app.origin}/done`],
      );
      const times = s.trajectory!.map((e) => e.t);
      expect(times).toEqual(times.toSorted((a, b) => a - b));
      const posts = s.network!.filter((e) => e.method === 'POST').map((e) => new URL(e.url).pathname);
      expect(posts).toEqual(run.order.map((x) => `/api/${x}`));
      const outcome = evaluate(CHECKS, s);
      expect(outcome.verdict).toBe(run.expected);
      expect(outcome.checks.map((c) => c.status)).toEqual([
        'pass',
        'pass',
        run.expected === 'success' ? 'pass' : 'fail',
      ]);
      // A scoped capture (ADR 0025) of the same moment keeps the trajectory and gives the same verdict.
      const scoped = await captureScopedSnapshot(page, CHECKS, { probes: refillProbes(app) });
      expect((scoped as { trajectory?: unknown }).trajectory).toEqual(s.trajectory);
      expect((await verify(CHECKS, scoped)).outcome.verdict).toBe(run.expected);
    });
});

test('without the option, snapshots have no trajectory and the sequence check abstains', async ({ page }) => {
  await runRefill(page, app.origin, RUNS[1].order);
  const s = await captureSnapshot(page, { probes: refillProbes(app) });
  expect('trajectory' in s).toBe(false);
  const outcome = evaluate(CHECKS, s);
  expect(outcome.checks[2]).toMatchObject({ status: 'abstain', reason: 'evidence_unavailable' });
  expect(outcome.verdict).toBe('abstain');
});
