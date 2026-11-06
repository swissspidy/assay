/**
 * `assay watch` (ADR 0019): the first table, then live rounds on real file changes (fs.watch):
 * an edited TypeScript set, an edited helper module it imports, a new run, a broken set, and a
 * clean stop. No browser, no model.
 */
import { test, expect } from '@playwright/test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../src/cli/main.ts';
import type { Io } from '../../src/cli/io.ts';
import { RunCache, isScratch, renderTable } from '../../src/cli/commands/watch.ts';
import { checkSetName } from '../../src/checks/load.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shop = (p: string) => join(root, 'examples/tiny-shop', p);
const BUILDER = join(root, 'src/checks/index.ts');

function io(extra: Partial<Io> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const c: Io & { stdout: string[]; stderr: string[] } = {
    stdout,
    stderr,
    out: (t) => stdout.push(t),
    err: (t) => stderr.push(t),
    color: false,
    errColor: false,
    env: {},
    ...extra,
  };
  return c;
}

test('--once: one table of every set and run, exit 0 when every labelled run is as expected', async () => {
  const c = io({ cwd: root });
  const code = await run(
    ['watch', shop('tasks/02-add-blue-mug.checks.json'), join(root, 'tests/support/add-blue-mug.checks.ts'), '--once'],
    c,
  );
  const out = c.stdout.join('\n');
  expect(code, c.stderr.join('\n')).toBe(0);
  expect(out).toMatch(/^assay watch · 2 check sets · 3 runs · \d\d:\d\d:\d\d · \d+ ms/);
  expect(out).toContain(
    '✔ examples/tiny-shop/tasks/02-add-blue-mug.checks.json  tiny-shop/add-blue-mug v1 · 1 requirement, 1 check',
  );
  expect(out).toMatch(/✔ added-blue-mug +SUCCESS +expected success/);
  expect(out).toMatch(/✔ added-red-mug +FAIL +expected fail/);
  // The TypeScript set has no runs of its own (references/add-blue-mug): the table says where to put them.
  expect(out).toContain(
    '✔ tests/support/add-blue-mug.checks.ts  tiny-shop/add-blue-mug-ts v1 · 2 requirements, 3 checks',
  );
  expect(out).toContain('no runs (put snapshots in tests/references/add-blue-mug)');
  expect(out).toContain('3/3 labelled runs as expected');

  // --reference names the run directories; --stress adds a stress line per set.
  const s = io({ cwd: root });
  expect(
    await run(
      [
        'watch',
        join(root, 'tests/support/add-blue-mug.checks.ts'),
        '--once',
        '--stress',
        '-r',
        join(root, 'tests/support/refs'),
      ],
      s,
    ),
  ).toBe(4);
  expect(s.stderr.join('\n')).toContain('run directory not found');
});

test('a wrong set fails --once: an unexpected verdict and an invalid set are both problems', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assay-watch-'));
  mkdirSync(join(dir, 'tasks'));
  mkdirSync(join(dir, 'references/blue'), { recursive: true });
  for (const r of ['added-blue-mug', 'added-red-mug'])
    copyFileSync(shop(`references/02-add-blue-mug/${r}.json`), join(dir, `references/blue/${r}.json`));
  const set = JSON.parse(readFileSync(shop('tasks/02-add-blue-mug.checks.json'), 'utf8'));
  // Expects a Red Mug: the correct run fails and the wrong one passes.
  writeFileSync(join(dir, 'tasks/blue.checks.json'), JSON.stringify(set).replaceAll('Blue Mug', 'Red Mug'));
  writeFileSync(join(dir, 'tasks/broken.checks.json'), '{ "schema": ');
  const c = io({ cwd: dir });
  expect(await run(['watch', 'tasks', '--once', '--stress'], c)).toBe(1);
  const out = c.stdout.join('\n');
  expect(out).toMatch(/✘ added-blue-mug +FAIL +expected success/);
  expect(out).toMatch(/✘ added-red-mug +SUCCESS +expected fail/);
  expect(out).toContain('✘ tasks/broken.checks.json  does not load');
  expect(out).toContain('error: check set ');
  expect(out).toMatch(/stress: ✘ .*reference run\(s\) not passed/);
  expect(out).toContain('0/2 labelled runs as expected · 2 not · 1 invalid set');
});

test('live: edits to a TypeScript set, to a module it imports and to its runs re-verify it; Ctrl-C stops cleanly', async () => {
  test.setTimeout(60_000);
  const dir = mkdtempSync(join(tmpdir(), 'assay-watch-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  mkdirSync(join(dir, 'checks'));
  mkdirSync(join(dir, 'references/blue'), { recursive: true });
  for (const r of ['added-blue-mug', 'added-red-mug'])
    copyFileSync(shop(`references/02-add-blue-mug/${r}.json`), join(dir, `references/blue/${r}.json`));
  writeFileSync(join(dir, 'checks/product.ts'), `export const product = 'Blue Mug';\n`);
  const set = (quote: string) => `import { checks, probe, req } from ${JSON.stringify(BUILDER)};
import { product } from './product.ts';

export default checks({ id: 'blue', instruction: 'Add a Blue Mug to my cart.' }, [
  req('R1', 'The cart has the mug', { quote: ${JSON.stringify(quote)} }).check(probe('cart', '/items').like([{ name: product }])),
]);
`;
  writeFileSync(join(dir, 'checks/blue.checks.ts'), set('Add a Blue Mug'));
  writeFileSync(join(dir, 'assay.config.ts'), `export default { checks: 'checks', snapshots: 'references' };\n`);

  const ac = new AbortController();
  const c = io({ cwd: dir, signal: ac.signal });
  const done = run(['watch', '--debounce', '50', '--no-clear'], c);
  const screens = () =>
    c.stdout
      .join('\n')
      .split(/\n(?=assay watch · )/)
      .filter((s) => s.startsWith('assay watch'));
  const waitFor = async (n: number) => {
    await expect.poll(() => screens().length, { timeout: 15_000 }).toBeGreaterThanOrEqual(n);
    return screens()[n - 1]!;
  };

  const first = await waitFor(1);
  expect(first).toContain('✔ checks/blue.checks.ts  blue v1 · 1 requirement, 1 check');
  expect(first).toMatch(/✔ added-blue-mug +SUCCESS +expected success\n/);
  expect(first).toContain('2/2 labelled runs as expected');
  // Let the watchers settle before editing.
  await new Promise((r) => setTimeout(r, 300));

  // 1. The helper module changes: the set (a fresh process) sees it.
  writeFileSync(join(dir, 'checks/product.ts'), `export const product = 'Red Mug';\n`);
  const second = await waitFor(2);
  expect(second).toContain('changed: checks/product.ts');
  expect(second).toMatch(/✘ added-blue-mug +FAIL +expected success +was SUCCESS · C1 pass→fail/);
  expect(second).toMatch(/✘ added-red-mug +SUCCESS +expected fail +was FAIL · C1 fail→pass/);
  expect(second).toContain('0/2 labelled runs as expected · 2 not · 2 runs changed');

  // 2. The set itself becomes invalid, then valid again.
  writeFileSync(join(dir, 'checks/blue.checks.ts'), set('a quote that is not in the task'));
  const third = await waitFor(3);
  expect(third).toContain('✘ checks/blue.checks.ts  invalid (1 error)  (was valid)');
  expect(third).toContain(
    'error: requirement R1: quote "a quote that is not in the task" does not appear in task.instruction',
  );
  writeFileSync(join(dir, 'checks/product.ts'), `export const product = 'Blue Mug';\n`);
  writeFileSync(join(dir, 'checks/blue.checks.ts'), set('Add a Blue Mug'));
  const fourth = await expect
    .poll(() => screens().find((s, i) => i >= 3 && s.includes('2/2 labelled runs as expected')), { timeout: 15_000 })
    .toBeTruthy()
    .then(() => screens().at(-1)!);
  expect(fourth).toContain('(now valid)');

  // 3. A new run appears.
  copyFileSync(
    shop('references/02-add-blue-mug/added-blue-and-red-mug.json'),
    join(dir, 'references/blue/added-blue-and-red-mug.json'),
  );
  await expect
    .poll(() => screens().at(-1)!, { timeout: 15_000 })
    .toMatch(/✔ added-blue-and-red-mug +SUCCESS +expected success +new/);

  ac.abort();
  expect(await done).toBe(0);
  const count = screens().length;
  writeFileSync(join(dir, 'checks/product.ts'), `export const product = 'Teapot';\n`);
  await new Promise((r) => setTimeout(r, 300));
  expect(screens().length).toBe(count);
});

test('the table: verdict, label and what changed since the previous round', () => {
  const runOf = (
    name: string,
    verdict: 'success' | 'fail' | 'abstain',
    checks: Record<string, 'pass' | 'fail' | 'abstain'>,
    expected?: 'success' | 'fail',
  ) => ({
    name,
    file: `/p/references/t/${name}.json`,
    verdict,
    checks,
    ...(expected ? { expected } : {}),
  });
  const set = (runs: ReturnType<typeof runOf>[]) => ({
    file: '/p/tasks/t.checks.ts',
    name: 't',
    errors: [],
    warnings: [],
    checkSet: { id: 't', version: '1', requirements: 1, checks: 4 },
    runs,
    runDirs: ['/p/references/t'],
    deps: [],
  });
  const before = set([runOf('ok', 'success', { C1: 'pass', C2: 'pass', C3: 'pass', C4: 'pass' }, 'success')]);
  const after = set([
    runOf('ok', 'abstain', { C1: 'fail', C2: 'abstain', C3: 'fail', C4: 'fail' }, 'success'),
    runOf('extra', 'fail', { C1: 'fail' }),
  ]);
  const table = renderTable([after], new Map([[before.file, before]]), {
    color: false,
    cwd: '/p',
    first: false,
    changed: ['/p/tasks/t.checks.ts'],
    now: new Date(2026, 10, 6, 9, 5, 7),
  });
  expect(table.split('\n')).toEqual([
    'assay watch · 1 check set · 2 runs · 09:05:07 · changed: tasks/t.checks.ts',
    '',
    '✘ tasks/t.checks.ts  t v1 · 1 requirement, 4 checks',
    '    ✘ ok        ABSTAIN  expected success  was SUCCESS · C1 pass→fail, C2 pass→abstain, C3 pass→fail, +1',
    '    · extra     FAIL     unlabelled        new',
    '',
    '0/1 labelled runs as expected · 1 not · 1 run changed',
  ]);
});

// ---------------------------------------------------------------------------
// Review fixes (PR #31)

/** A temporary ESM project with the Blue Mug runs under references/<name>/. */
function project(name = 'blue', runs = ['added-blue-mug', 'added-red-mug']): string {
  const dir = mkdtempSync(join(tmpdir(), 'assay-watch-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  mkdirSync(join(dir, `references/${name}`), { recursive: true });
  for (const r of runs)
    copyFileSync(shop(`references/02-add-blue-mug/${r}.json`), join(dir, `references/${name}/${r}.json`));
  return dir;
}

/** A module set reading the product name from `from` (a module path relative to the set). */
const productSet = (from: string, id = 'blue') => `import { checks, probe, req } from ${JSON.stringify(BUILDER)};
import { product } from ${JSON.stringify(from)};

export default checks({ id: ${JSON.stringify(id)}, instruction: 'Add a Blue Mug to my cart.' }, [
  req('R1', 'The cart has the mug', { quote: 'Add a Blue Mug' }).check(probe('cart', '/items').like([{ name: product }])),
]);
`;

/** Start `assay watch` in `dir`: the screens it printed, a way to wait for one, and to stop it. */
function startWatch(dir: string, args: string[]) {
  const ac = new AbortController();
  const c = io({ cwd: dir, signal: ac.signal });
  const done = run(['watch', '--debounce', '50', '--no-clear', ...args], c);
  const screens = () =>
    c.stdout
      .join('\n')
      .split(/\n(?=assay watch · )/)
      .filter((s) => s.startsWith('assay watch'));
  /** Wait for a screen after the first `after` that matches; returns how many screens there are then. */
  const waitFor = async (pattern: RegExp, after = 0) => {
    await expect
      .poll(
        () =>
          screens()
            .slice(after)
            .find((s) => pattern.test(s)) ?? `${c.stdout.join('\n')}\n${c.stderr.join('\n')}`,
        { timeout: 15_000 },
      )
      .toMatch(pattern);
    return screens().length;
  };
  const settle = () => new Promise((r) => setTimeout(r, 300));
  const stop = async () => {
    ac.abort();
    return done;
  };
  return { c, screens, waitFor, settle, stop };
}

test('live: imported modules outside the set directory, and sets importing other sets, are re-verified', async () => {
  test.setTimeout(60_000);
  const dir = project();
  mkdirSync(join(dir, 'checks'));
  mkdirSync(join(dir, 'helpers'));
  writeFileSync(join(dir, 'helpers/product.ts'), `export const product = 'Blue Mug';\n`);
  writeFileSync(join(dir, 'checks/blue.checks.ts'), productSet('../helpers/product.ts'));
  // A set that imports another discovered set's module.
  mkdirSync(join(dir, 'references/variant'));
  copyFileSync(join(dir, 'references/blue/added-blue-mug.json'), join(dir, 'references/variant/added-blue-mug.json'));
  writeFileSync(join(dir, 'checks/base.checks.ts'), `export const product = 'Blue Mug';\nexport default {};\n`);
  writeFileSync(join(dir, 'checks/variant.checks.ts'), productSet('./base.checks.ts', 'variant'));
  const w = startWatch(dir, ['checks']);
  let n = await w.waitFor(/checks\/blue\.checks\.ts {2}blue v1[^\n]*\n {4}✔ added-blue-mug +SUCCESS/);
  await w.settle();

  writeFileSync(join(dir, 'helpers/product.ts'), `export const product = 'Red Mug';\n`);
  n = await w.waitFor(/changed: helpers\/product\.ts[\s\S]*✘ added-blue-mug +FAIL +expected success +was SUCCESS/, n);
  await w.settle();

  writeFileSync(join(dir, 'checks/base.checks.ts'), `export const product = 'Red Mug';\nexport default {};\n`);
  await w.waitFor(
    /checks\/variant\.checks\.ts {2}variant v1[^\n]*\n {4}✘ added-blue-mug +FAIL +expected success +was SUCCESS/,
    n,
  );
  expect(await w.stop()).toBe(0);
});

test('live: a glob root, a run directory that does not exist yet, hidden runs and an edit that keeps the mtime', async () => {
  test.setTimeout(60_000);
  const dir = project('a', []);
  mkdirSync(join(dir, 'sets/a'), { recursive: true });
  const json = readFileSync(shop('tasks/02-add-blue-mug.checks.json'), 'utf8');
  writeFileSync(join(dir, 'sets/a/a.checks.json'), json);
  // Runs live in runs/, which does not exist yet.
  writeFileSync(join(dir, 'assay.config.ts'), "export default { snapshots: 'runs' };\n");
  const w = startWatch(dir, [join(dir, 'sets/*/*.checks.json')]);
  let n = await w.waitFor(/sets\/a\/a\.checks\.json/);
  await w.settle();

  // A set in a new directory that matches the glob is found.
  mkdirSync(join(dir, 'sets/b'));
  writeFileSync(join(dir, 'sets/b/b.checks.json'), json);
  n = await w.waitFor(/sets\/b\/b\.checks\.json/, n);
  await w.settle();

  // runs/b does not exist yet: creating it with a run (a hidden one) re-verifies b.
  mkdirSync(join(dir, 'runs/b'), { recursive: true });
  copyFileSync(shop('references/02-add-blue-mug/added-blue-mug.json'), join(dir, 'runs/b/.blue.json'));
  n = await w.waitFor(/✔ \.blue +SUCCESS +expected success/, n);
  await w.settle();

  // The run changes but keeps its modification time: its content is read again.
  const file = join(dir, 'runs/b/.blue.json');
  const { mtime } = statSync(file);
  const relabelled = JSON.parse(readFileSync(file, 'utf8'));
  relabelled.label.expected = 'fail';
  writeFileSync(file, JSON.stringify(relabelled));
  utimesSync(file, mtime, mtime);
  await w.waitFor(/✘ \.blue +SUCCESS +expected fail/, n);
  expect(await w.stop()).toBe(0);
});

test('live: an edit made while the first round runs is not lost', async () => {
  test.setTimeout(60_000);
  const dir = project();
  mkdirSync(join(dir, 'checks'));
  writeFileSync(join(dir, 'checks/product.ts'), `export const product = 'Blue Mug';\n`);
  // The set takes a while to load, after it has imported product.ts.
  writeFileSync(
    join(dir, 'checks/blue.checks.ts'),
    productSet('./product.ts').replace(
      'export default',
      'await new Promise((r) => setTimeout(r, 1500));\nexport default',
    ),
  );
  const w = startWatch(dir, ['checks']);
  await new Promise((r) => setTimeout(r, 700));
  writeFileSync(join(dir, 'checks/product.ts'), `export const product = 'Red Mug';\n`);
  const n = await w.waitFor(/✔ added-blue-mug +SUCCESS/);
  await w.waitFor(/✘ added-blue-mug +FAIL +expected success +was SUCCESS/, n);
  expect(await w.stop()).toBe(0);
});

test('--json prints one JSON object per round; --once --json exits as --once does', async () => {
  const c = io({ cwd: root });
  expect(await run(['watch', shop('tasks/02-add-blue-mug.checks.json'), '--once', '--json'], c)).toBe(0);
  expect(c.stdout).toHaveLength(1);
  const round = JSON.parse(c.stdout[0]!);
  expect(round).toMatchObject({ changed: [], sets: [{ name: '02-add-blue-mug', ok: true, errors: [] }] });
  const runs = round.sets[0].runs as { name: string; verdict: string; asExpected: boolean }[];
  expect(runs.map((r) => [r.name, r.verdict, r.asExpected])).toEqual([
    ['added-blue-and-red-mug', 'success', true],
    ['added-blue-mug', 'success', true],
    ['added-red-mug', 'fail', true],
  ]);
});

test('set names drop every check set extension: a .checks.mjs set finds references/<name>', async () => {
  const dir = project('blue');
  mkdirSync(join(dir, 'tasks'));
  writeFileSync(
    join(dir, 'tasks/blue.checks.mjs'),
    productSet('./unused.mjs').replace(/^import \{ product \}.*$/m, "const product = 'Blue Mug';"),
  );
  expect(checkSetName('a/b/blue.checks.mts')).toBe('blue');
  expect(checkSetName('blue.checks.js')).toBe('blue');
  const c = io({ cwd: dir });
  expect(await run(['watch', join(dir, 'tasks/blue.checks.mjs'), '--once'], c)).toBe(0);
  expect(c.stdout.join('\n')).toMatch(/✔ added-blue-mug +SUCCESS +expected success/);
});

test('scratch files, the run cache and duplicate run names', () => {
  const scratch = [
    'a/.#x.ts',
    'a/x.ts~',
    'a/.x.ts.swp',
    'a/4913',
    '.git/index',
    'node_modules/x/y.js',
    'a/.y.json.1.tmp',
  ];
  expect(scratch.filter((p) => !isScratch(p))).toEqual([]);
  expect(['a/.data/product.ts', 'refs/b/.baseline.json', 'checks/x.checks.ts'].filter(isScratch)).toEqual([]);

  const dir = project('blue');
  const cache = new RunCache();
  const a = join(dir, 'references/blue/added-blue-mug.json');
  const b = join(dir, 'references/blue/added-red-mug.json');
  const first = cache.read(a);
  expect(cache.read(a)).toBe(first);
  cache.read(b);
  cache.prune(new Set([a]));
  expect(cache.files).toEqual([a]);

  const runOf = (file: string, name = 'reference') => ({
    name,
    file,
    verdict: 'success' as const,
    checks: {},
    expected: 'success' as const,
  });
  const table = renderTable(
    [
      {
        file: '/p/tasks/t.checks.ts',
        name: 't',
        errors: [],
        warnings: [],
        checkSet: { id: 't', version: '1', requirements: 1, checks: 1 },
        runs: [
          runOf('/p/references/t/reference.json'),
          runOf('/p/runs/t/reference.json'),
          runOf('/p/runs/t/other.json', 'other'),
        ],
        runDirs: [],
        deps: [],
      },
    ],
    new Map(),
    { color: false, cwd: '/p', first: true, changed: [], now: new Date(2026, 10, 6, 9, 5, 7) },
  );
  expect(table).toContain('    ✔ references/t/reference.json  SUCCESS  expected success');
  expect(table).toContain('    ✔ runs/t/reference.json        SUCCESS  expected success');
  expect(table).toContain('    ✔ other                        SUCCESS  expected success');
});
