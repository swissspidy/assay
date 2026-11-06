/**
 * `*.checks.ts` files on the command line (ADR 0019): every command that takes a check set
 * takes a module too, `assay checks print` converts both ways, and a module is never
 * rewritten. No browser, no model.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../src/cli/main.ts';
import type { Io } from '../../src/cli/io.ts';
import { resolveTask } from '../../src/cli/commands/compile.ts';
import { taskFiles } from '../../src/cli/commands/bench.ts';
import { configuredChecks } from '../../src/cli/commands/validate.ts';
import { loadCheckSetFile } from '../../src/checks/load.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shop = (p: string) => join(root, 'examples/tiny-shop', p);
const TS = join(root, 'tests/support/add-blue-mug.checks.ts');
const BUILDER = join(root, 'src/checks/index.ts');
const ADDED_BLUE = shop('references/02-add-blue-mug/added-blue-mug.json');
const ADDED_RED = shop('references/02-add-blue-mug/added-red-mug.json');

async function assay(argv: string[], cwd = root) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: Io = {
    out: (t) => stdout.push(t),
    err: (t) => stderr.push(t),
    color: false,
    errColor: false,
    env: {},
    cwd,
  };
  const code = await run(argv, io);
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

/** A temporary ESM project directory. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'assay-checks-cli-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  return dir;
}

test('verify, validate, review and stress take a *.checks.ts module', async () => {
  const ok = await assay(['verify', TS, ADDED_BLUE]);
  expect(ok.code, ok.stderr).toBe(0);
  expect(ok.stdout).toMatch(/^Verdict: SUCCESS {2}\(tiny-shop\/add-blue-mug-ts v1/);
  expect((await assay(['verify', TS, ADDED_RED])).code).toBe(1);
  const valid = await assay(['validate', TS]);
  expect(valid.stdout).toContain(
    'add-blue-mug.checks.ts: valid (tiny-shop/add-blue-mug-ts v1, 2 requirements, 3 checks',
  );
  expect((await assay(['review', TS])).stdout).toContain('# Review: tiny-shop/add-blue-mug-ts v1');
  const stress = await assay(['stress', TS, '-r', shop('references/02-add-blue-mug')]);
  expect(stress.code, stress.stdout).toBe(0);
  expect(stress.stdout).toContain('## tiny-shop/add-blue-mug-ts v1');
});

test('assay checks print: JSON from a module, builder TypeScript from JSON, and back', async () => {
  const json = await assay(['checks', 'print', TS]);
  expect(json.code).toBe(0);
  expect(JSON.parse(json.stdout)).toStrictEqual(await loadCheckSetFile(TS));

  const dir = project();
  const out = join(dir, 'blue.checks.ts');
  const ts = await assay([
    'checks',
    'print',
    '--ts',
    shop('compiled/02-add-blue-mug.checks.json'),
    '--import',
    BUILDER,
    '-o',
    out,
  ]);
  expect(ts.code, ts.stderr).toBe(0);
  expect(ts.stderr).toBe(`Wrote ${out}`);
  const code = readFileSync(out, 'utf8');
  // Whether the import wraps depends on the length of the checkout path, so compare it with
  // whitespace collapsed.
  expect(code.replace(/\s+/g, ' ')).toMatch(
    /^import \{ checks, matching, probe, req,? \} from '[^']*src\/checks\/index\.ts'; export default checks\(/,
  );
  expect(code).toContain("{ sku: 'MUG-BLUE', name: 'Blue Mug', qty: matching({ type: 'number', minimum: 1 }) },");
  const back = await assay(['checks', 'print', out]);
  expect(JSON.parse(back.stdout)).toStrictEqual(
    JSON.parse(readFileSync(shop('compiled/02-add-blue-mug.checks.json'), 'utf8')),
  );
  // The default import is the package's /checks entry.
  expect((await assay(['checks', 'print', '--ts', TS])).stdout).toContain("from '@swissspidy/assay/checks';");

  expect((await assay(['checks', 'frob', TS])).code).toBe(3);
  expect((await assay(['checks', 'print', TS, '--ts', '--json'])).code).toBe(3);
  expect((await assay(['checks', 'print'])).code).toBe(3);
});

test('a module that does not load, or exports no set, is reported like invalid JSON', async () => {
  const dir = project();
  writeFileSync(join(dir, 'syntax.checks.ts'), 'export default {');
  writeFileSync(join(dir, 'throws.checks.ts'), "throw new Error('no product list');\nexport default {};\n");
  writeFileSync(join(dir, 'none.checks.ts'), 'export const x = 1;\n');
  writeFileSync(
    join(dir, 'fn.checks.ts'),
    `import { checks, req, url } from ${JSON.stringify(BUILDER)};\nexport default async () => checks('Open the cart.', [req('R1', 'Open the cart').check(url('/cart'))]);\n`,
  );
  const r = await assay(
    ['validate', ...['syntax', 'throws', 'none', 'fn'].map((n) => join(dir, `${n}.checks.ts`))],
    dir,
  );
  expect(r.code).toBe(1);
  expect(r.stdout).toContain(`✘ ${join(dir, 'syntax.checks.ts')}: invalid`);
  expect(r.stdout).toMatch(/error: cannot load .*syntax\.checks\.ts: /);
  expect(r.stdout).toContain(`error: cannot load ${join(dir, 'throws.checks.ts')}: no product list`);
  expect(r.stdout).toContain(
    `error: cannot load ${join(dir, 'none.checks.ts')}: no default export (export default checks(…))`,
  );
  expect(r.stdout).toContain(`✔ ${join(dir, 'fn.checks.ts')}: valid (open-the-cart v1`);
  const missing = await assay(['verify', join(dir, 'missing.checks.ts'), ADDED_BLUE]);
  expect(missing.code).toBe(4);
  expect(missing.stderr).toContain('check set not found: ');
  // A fresh process sees the same errors.
  await expect(loadCheckSetFile(join(dir, 'throws.checks.ts'), { fresh: true })).rejects.toThrow(
    'cannot load ' + join(dir, 'throws.checks.ts') + ': Error: no product list',
  );
  expect(await loadCheckSetFile(join(dir, 'fn.checks.ts'), { fresh: true })).toMatchObject({ id: 'open-the-cart' });
});

test('approve, reject and unlock never rewrite a module: they write JSON with --out', async () => {
  const dir = project();
  const refused = await assay(['approve', TS, '--reviewer', 'alice']);
  expect(refused.code).toBe(3);
  expect(refused.stderr).toContain(
    'add-blue-mug.checks.ts is a module; approve writes the check set as JSON: add --out',
  );
  const out = join(dir, 'approved.checks.json');
  const approved = await assay(['approve', TS, '--reviewer', 'alice', '--out', out]);
  expect(approved.code, approved.stderr).toBe(0);
  expect(JSON.parse(readFileSync(out, 'utf8')).locked.by).toBe('alice');
  expect((await assay(['verify', out, ADDED_BLUE, '--require-locked'])).code).toBe(0);
});

test('config discovery, compile and bench find *.checks.ts tasks', async () => {
  const dir = project();
  mkdirSync(join(dir, 'checks/sub'), { recursive: true });
  writeFileSync(join(dir, 'checks/a.checks.json'), readFileSync(shop('tasks/02-add-blue-mug.checks.json')));
  writeFileSync(
    join(dir, 'checks/sub/b.checks.ts'),
    `import { checks, req, url } from ${JSON.stringify(BUILDER)};\nexport default checks({ instruction: 'Open the cart.', outcomes: 'Then the cart is shown' }, [req('R1', 'Open the cart').check(url('/cart'))]);\n`,
  );
  writeFileSync(join(dir, 'checks/helper.ts'), 'export const x = 1;\n');
  expect(configuredChecks(join(dir, 'checks'))).toEqual([
    join(dir, 'checks/a.checks.json'),
    join(dir, 'checks/sub/b.checks.ts'),
  ]);
  expect(taskFiles(join(dir, 'checks'))).toEqual([
    join(dir, 'checks/a.checks.json'),
    join(dir, 'checks/sub/b.checks.ts'),
  ]);
  writeFileSync(join(dir, 'assay.config.ts'), "export default { checks: 'checks' };\n");
  const v = await assay(['validate'], dir);
  expect(v.code, v.stdout).toBe(0);
  expect(v.stdout).toContain('checks/sub/b.checks.ts: valid (open-the-cart v1');
  expect(await resolveTask(join(dir, 'checks/sub/b.checks.ts'), {})).toEqual({
    id: 'open-the-cart',
    instruction: 'Open the cart.',
    outcomes: 'Then the cart is shown',
  });
});
