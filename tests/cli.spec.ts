/**
 * The `assay` executable as a process: exit statuses, plain output when stdout is not a
 * terminal, and `assay capture` against the live Tiny Shop. Runs the CLI's entry point
 * from source (the packed, built `bin` is exercised by tests/pack).
 */
import { test, expect } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot } from '../src/index.ts';
import { startSites } from './support/sites.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const bin = join(root, 'src/cli/index.ts');
const shop = (p: string) => join(root, 'examples/tiny-shop', p);

function assay(args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { cwd: root, env: { ...process.env, NO_COLOR: '', FORCE_COLOR: '', ...env }, maxBuffer: 64 << 20 },
      (err, stdout, stderr) => resolve({ code: err ? Number(err.code) : 0, stdout, stderr }),
    );
  });
}

test('verify exits 0, 1 and 2 by verdict, in plain text when not on a terminal', async () => {
  const checks = shop('tasks/02-add-blue-mug.checks.json');
  const ok = await assay(['verify', checks, shop('references/02-add-blue-mug/added-blue-mug.json')]);
  expect(ok).toMatchObject({ code: 0, stderr: '' });
  expect(ok.stdout).toMatch(/^Verdict: SUCCESS/);
  expect(ok.stdout).not.toContain('\u001b[');
  expect((await assay(['verify', checks, shop('references/02-add-blue-mug/added-red-mug.json')])).code).toBe(1);
  const abstain = await assay([
    'verify',
    shop('tasks/03-cart-two-mugs.checks.json'),
    shop('references/01-newsletter/never-subscribed.json'),
    '--json',
  ]);
  expect(abstain.code).toBe(2);
  expect(JSON.parse(abstain.stdout).verdict).toBe('abstain');
  const usage = await assay(['verify']);
  expect(usage.code).toBe(3);
  expect(usage.stderr).toContain('missing argument');
});

test('compile replays a cassette without a key', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'assay-cli-e2e-')), 'checks.json');
  const r = await assay(
    [
      'compile',
      shop('tasks/02-add-blue-mug.checks.json'),
      '--id',
      'tiny-shop/02-add-blue-mug',
      '--reference',
      shop('references/02-add-blue-mug/added-blue-mug.json'),
      '--cassette',
      shop('compiled/02-add-blue-mug.cassette.json'),
      '--out',
      out,
    ],
    { ASSAY_MODEL_MODE: 'replay', ANTHROPIC_API_KEY: '' },
  );
  expect(r.code).toBe(0);
  expect(readFileSync(out, 'utf8')).toBe(readFileSync(shop('compiled/02-add-blue-mug.checks.json'), 'utf8'));
});

test('capture writes a snapshot of a live page that verify can read', async ({ baseURL }, testInfo) => {
  const dir = mkdtempSync(join(tmpdir(), 'assay-cli-capture-'));
  const exe = testInfo.project.use.launchOptions?.executablePath;
  const r = await assay(['capture', `${baseURL}/`, '--out', dir, ...(exe ? ['--executable-path', exe] : [])]);
  expect(r.stderr).toBe('');
  expect(r.code).toBe(0);
  const [file] = readdirSync(dir);
  expect(r.stdout.trim()).toBe(`Wrote ${join(dir, file!)}`);
  const snapshot = loadSnapshot(readFileSync(join(dir, file!), 'utf8'));
  expect(snapshot.page).toMatchObject({ url: `${baseURL}/`, title: 'Tiny Shop' });
  expect(snapshot.network!.some((e) => e.url.includes('/api/'))).toBe(true);
  // The checks read a probe the CLI cannot run, so the verdict is inconclusive, not a failure.
  const v = await assay(['verify', shop('tasks/02-add-blue-mug.checks.json'), join(dir, file!)]);
  expect(v.code).toBe(2);
});

test('capture --trajectory records the order of requests and navigations (ADR 0024)', async ({ baseURL }, testInfo) => {
  const exe = testInfo.project.use.launchOptions?.executablePath;
  const r = await assay(['capture', `${baseURL}/`, '--trajectory', ...(exe ? ['--executable-path', exe] : [])]);
  expect(r.code).toBe(0);
  const snapshot = loadSnapshot(r.stdout);
  const requests = snapshot.trajectory!.flatMap((e) => (e.type === 'request' ? [e.seq] : []));
  expect(requests).toEqual(snapshot.network!.map((e) => e.seq));
  expect(snapshot.trajectory).toContainEqual(
    expect.objectContaining({ type: 'navigation', url: `${baseURL}/`, page: 0 }),
  );
});

test('capture includes iframe content, same- and cross-origin (ADR 0012)', async () => {
  const { app, other } = await startSites();
  try {
    const exe = test.info().project.use.launchOptions?.executablePath;
    const r = await assay(['capture', `${app.origin}/frames`, ...(exe ? ['--executable-path', exe] : [])]);
    expect(r.code).toBe(0);
    const snapshot = loadSnapshot(r.stdout);
    const json = JSON.stringify(snapshot.a11y);
    expect(json).toContain('"name":"Editor canvas"');
    expect(json).toContain(`"url":"${other.origin}/widget"`);
    expect(json).toContain('"name":"Card number","value":"4242 4242 4242 4242"');
  } finally {
    await app.close();
    await other.close();
  }
});

test("output into a closed pipe ends quietly with the command's own status", async () => {
  // Like `assay stress … | head -0`: the reader is gone before the command writes anything.
  const child = spawn(
    process.execPath,
    [bin, 'stress', shop('tasks/07-express-order.checks.json'), '-r', shop('references/07-express-order')],
    { cwd: root, env: { ...process.env, NO_COLOR: '', FORCE_COLOR: '' } },
  );
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.destroy();
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  expect(stderr).toBe('');
  expect(code).toBe(0);
});
