/**
 * `assay watch` (ADR 0019): the first table, then live rounds on real file changes (fs.watch):
 * an edited TypeScript set, an edited helper module it imports, a new run, a broken set, and a
 * clean stop. No browser, no model.
 */
import { test, expect } from '@playwright/test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../src/cli/main.ts';
import type { Io } from '../../src/cli/io.ts';
import { renderTable } from '../../src/cli/commands/watch.ts';

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
