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
import { findTasks, taskFiles } from '../../src/cli/commands/bench.ts';
import { configuredChecks } from '../../src/cli/commands/validate.ts';
import { loadCheckSetFile, loadCheckSetFileWithDeps } from '../../src/checks/load.ts';

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

// ---------------------------------------------------------------------------
// Review fixes (PR #31)

const blueSet = (id: string) =>
  `import { checks, req, url } from ${JSON.stringify(BUILDER)};\nexport default checks({ id: '${id}', instruction: 'Open the cart.' }, [req('R1', 'Open the cart').check(url('/cart'))]);\n`;

test('an edited module set is loaded again in the same process', async () => {
  const dir = project();
  const file = join(dir, 'x.checks.ts');
  writeFileSync(file, blueSet('first'));
  expect(await loadCheckSetFile(file)).toMatchObject({ id: 'first' });
  writeFileSync(file, blueSet('second'));
  expect(await loadCheckSetFile(file)).toMatchObject({ id: 'second' });
});

test('a factory that rejects, or a value that does not serialize, is a load error', async () => {
  const dir = project();
  writeFileSync(join(dir, 'rejects.checks.ts'), "export default async () => { throw new Error('no catalogue'); };\n");
  writeFileSync(
    join(dir, 'cycle.checks.ts'),
    'const a: Record<string, unknown> = {};\na.self = a;\nexport default a;\n',
  );
  for (const [name, why] of [
    ['rejects', 'no catalogue'],
    ['cycle', 'circular'],
  ] as const) {
    const file = join(dir, `${name}.checks.ts`);
    await expect(loadCheckSetFile(file)).rejects.toMatchObject({
      code: 'ELOAD',
      message: expect.stringContaining(why),
    });
  }
  const r = await assay(['validate', join(dir, 'rejects.checks.ts'), join(dir, 'cycle.checks.ts')], dir);
  expect(r.code).toBe(1);
  expect(r.stdout).toContain('rejects.checks.ts: no catalogue');
  expect(r.stdout).toMatch(/cycle\.checks\.ts: .*circular/);
});

test('a fresh load ignores what the module prints, ends despite its timers, and stops when aborted', async () => {
  test.setTimeout(30_000);
  const dir = project();
  const noisy = join(dir, 'noisy.checks.ts');
  writeFileSync(noisy, `console.log('{ not json');\nsetInterval(() => {}, 1000);\n${blueSet('noisy')}`);
  const t0 = Date.now();
  expect(await loadCheckSetFile(noisy, { fresh: true })).toMatchObject({ id: 'noisy' });
  expect(Date.now() - t0).toBeLessThan(10_000);

  const hangs = join(dir, 'hangs.checks.ts');
  writeFileSync(hangs, 'setInterval(() => {}, 1000);\nawait new Promise(() => {});\nexport default {};\n');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  await expect(loadCheckSetFile(hangs, { fresh: true, signal: ac.signal })).rejects.toMatchObject({ code: 'EABORT' });

  // A fresh load reports the local modules it imported.
  writeFileSync(join(dir, 'helper.ts'), "export const id = 'helped';\n");
  writeFileSync(join(dir, 'uses.checks.ts'), "import { id } from './helper.ts';\nexport default { id };\n");
  const loaded = await loadCheckSetFileWithDeps(join(dir, 'uses.checks.ts'), { fresh: true });
  expect(loaded.value).toEqual({ id: 'helped' });
  expect(loaded.deps).toEqual(expect.arrayContaining([join(dir, 'uses.checks.ts'), join(dir, 'helper.ts')]));
  expect(loaded.deps.some((d) => d.includes('node_modules'))).toBe(false);
});

test('reject and unlock also refuse to rewrite a module, and write JSON with --out', async () => {
  const dir = project();
  const file = join(dir, 'blue.checks.ts');
  writeFileSync(file, readFileSync(TS, 'utf8').replace("'../../src/checks/index.ts'", JSON.stringify(BUILDER)));
  const source = readFileSync(file, 'utf8');
  for (const args of [
    ['reject', file, '--reviewer', 'bob', '--note', 'too loose'],
    ['unlock', file],
  ]) {
    const refused = await assay(args, dir);
    expect(refused.code, args[0]).toBe(3);
    expect(refused.stderr).toContain(`blue.checks.ts is a module; ${args[0]} writes the check set as JSON: add --out`);
    expect(readFileSync(file, 'utf8')).toBe(source);
    const out = join(dir, `${args[0]}.checks.json`);
    const written = await assay([...args, '--out', out], dir);
    expect(written.code, written.stderr).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ id: 'tiny-shop/add-blue-mug-ts' });
  }
  expect(JSON.parse(readFileSync(join(dir, 'reject.checks.json'), 'utf8')).rejected).toMatchObject({ by: 'bob' });
});

test('bench names a .checks.mts task like any other', async () => {
  const dir = project();
  mkdirSync(join(dir, 'tasks'));
  mkdirSync(join(dir, 'references/blue'), { recursive: true });
  writeFileSync(join(dir, 'references/blue/reference.json'), readFileSync(ADDED_BLUE));
  writeFileSync(join(dir, 'tasks/blue.checks.mts'), blueSet('blue'));
  const found = await findTasks(join(dir, 'tasks/blue.checks.mts'), join(dir, 'references'), [], dir);
  expect(found.skipped).toEqual([]);
  expect(found.tasks.map((t) => t.name)).toEqual(['blue']);
});
