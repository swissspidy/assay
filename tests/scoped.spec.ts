/**
 * Scoped capture (ADR 0025), live: a snapshot captured scoped to a check set verifies to the
 * outcome a full capture of the same page gives, on every handwritten Tiny Shop task, and
 * `assay capture --scope` writes one that `assay verify` takes with its check set only.
 */
import { expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureBaseline, captureScopedSnapshot, captureSnapshot, test } from '../src/playwright/index.ts';
import { verify, type Outcome } from '../src/index.ts';
import { addToCart, loadChecks, openSettings, setNewsletter, shopProbes } from './helpers.ts';

const sansDigest = (o: Outcome) => ({ ...o, snapshot: { ...o.snapshot, digest: '' } });
const TASKS = readdirSync(new URL('../examples/tiny-shop/tasks/', import.meta.url)).map((f) =>
  f.replace(/\.checks\.json$/, ''),
);

test('a scoped capture verifies like a full capture of the same page, for every Tiny Shop task', async ({ page }) => {
  test.setTimeout(60_000);
  await addToCart(page, 'Red Mug');
  await captureBaseline(page, { probes: shopProbes(page) });
  await addToCart(page, 'Blue Mug');
  await openSettings(page);
  await setNewsletter(page, true);
  for (const task of TASKS) {
    const cs = loadChecks(task);
    const full = await captureSnapshot(page, { probes: shopProbes(page) });
    const scoped = await captureScopedSnapshot(page, cs, { probes: shopProbes(page) });
    expect(scoped.scope.source).toBeUndefined();
    const a = (await verify(cs, full)).outcome;
    const b = (await verify(cs, scoped)).outcome;
    expect(sansDigest({ ...b, snapshot: { ...b.snapshot, capturedAt: '' } }), task).toEqual(
      sansDigest({ ...a, snapshot: { ...a.snapshot, capturedAt: '' } }),
    );
  }
});

const root = fileURLToPath(new URL('../', import.meta.url));
const assay = (args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [join(root, 'src/cli/index.ts'), ...args],
      { cwd: root, env: { ...process.env, NO_COLOR: '', FORCE_COLOR: '' }, maxBuffer: 64 << 20 },
      (err, stdout, stderr) => resolve({ code: err ? Number(err.code) : 0, stdout, stderr }),
    );
  });

test('assay capture --scope writes a scoped snapshot; verify takes it with its check set only', async ({
  baseURL,
}, testInfo) => {
  const exe = testInfo.project.use.launchOptions?.executablePath;
  const checks = join(root, 'examples/tiny-shop/tasks/02-add-blue-mug.checks.json');
  const out = join(testInfo.outputPath(), 'scoped.json');
  const r = await assay([
    'capture',
    `${baseURL}/`,
    '--scope',
    checks,
    '--out',
    out,
    ...(exe ? ['--executable-path', exe] : []),
  ]);
  expect(r).toMatchObject({ code: 0, stderr: '' });
  const ok = await assay(['verify', checks, out, '--json']);
  // Verified, not refused: the checks read a probe the CLI cannot run, so the verdict is inconclusive.
  expect(ok.code).toBe(2);
  expect(JSON.parse(ok.stdout).verdict).toBe('abstain');
  const other = await assay(['verify', join(root, 'examples/tiny-shop/tasks/03-cart-two-mugs.checks.json'), out]);
  expect(other.code).toBe(4);
  expect(other.stderr).toMatch(/scoped snapshot .* cannot verify tiny-shop\/cart-two-mugs/);
  const stress = await assay(['stress', checks, '--reference', out]);
  expect(stress.code).toBe(4);
  expect(stress.stderr).toContain('scoped snapshot');
});
