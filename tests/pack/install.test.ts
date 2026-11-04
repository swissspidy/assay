/**
 * The npm package as a user gets it: packed (which builds dist/), installed into an empty project,
 * and used from there through both entry points, in JavaScript and in TypeScript. Installing needs
 * network access to the npm registry. Run with `npm run test:pack` (not part of `npm test`).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const { name, version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};
let dir: string;
let files: string[];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'assay-pack-'));
  const { stdout } = await run('npm', ['pack', '--json', '--pack-destination', dir], {
    cwd: root,
    maxBuffer: 64 << 20,
  });
  const [pack] = JSON.parse(stdout.slice(stdout.indexOf('['))) as { filename: string; files: { path: string }[] }[];
  files = pack!.files.map((f) => f.path);
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  // --ignore-scripts: nothing in the consumer needs a lifecycle script (no browser is launched).
  await run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', join(dir, pack!.filename)], {
    cwd: dir,
    maxBuffer: 64 << 20,
  });
});
after(() => rm(dir, { recursive: true, force: true }));

test('the package holds the build, the docs and its metadata, and nothing else', () => {
  const outside = files.filter(
    (f) => !/^(dist|docs)\//.test(f) && !['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'].includes(f),
  );
  assert.deepEqual(outside, []);
  for (const f of [
    'dist/index.js',
    'dist/index.d.ts',
    'dist/playwright/index.js',
    'dist/playwright/index.d.ts',
    'LICENSE',
  ]) {
    assert.ok(files.includes(f), f);
  }
  assert.ok(!files.some((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')), 'no TypeScript sources');
});

test('the installed library validates and evaluates a check set, and its Playwright entry loads', async () => {
  const checks = join(root, 'examples/tiny-shop/tasks/02-add-blue-mug.checks.json');
  const correct = join(root, 'examples/tiny-shop/references/02-add-blue-mug/added-blue-mug.json');
  const wrong = join(root, 'examples/tiny-shop/references/02-add-blue-mug/added-red-mug.json');
  const script = join(dir, 'use.js');
  await writeFile(
    script,
    `import { readFileSync } from 'node:fs';
import { validateCheckSet, verifySnapshot, captureSnapshot } from '${name}';
import { expectOutcome, test } from '${name}/playwright';
const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
const checks = load(${JSON.stringify(checks)});
const report = validateCheckSet(checks);
const verdict = (p) => verifySnapshot(checks, load(p).snapshot).verdict;
console.log(JSON.stringify({
  valid: report.ok,
  correct: verdict(${JSON.stringify(correct)}),
  wrong: verdict(${JSON.stringify(wrong)}),
  capture: typeof captureSnapshot === 'function',
  playwright: typeof expectOutcome === 'function' && typeof test === 'function',
}));
`,
  );
  const { stdout } = await run(process.execPath, [script], { cwd: dir });
  assert.deepEqual(JSON.parse(stdout), {
    valid: true,
    correct: 'success',
    wrong: 'fail',
    capture: true,
    playwright: true,
  });
});

test('the capturer id names the installed version', async () => {
  const { stdout } = await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { CAPTURER } from './node_modules/${name}/dist/snapshot/capture.js'; console.log(CAPTURER);`,
    ],
    { cwd: dir },
  );
  assert.equal(stdout.trim(), `assay/${version}`);
});

test('the installed type declarations typecheck a consumer', async () => {
  await writeFile(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        lib: ['ESNext', 'DOM'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        // As most projects (and tsc --init) do. The Anthropic adapter's declarations name the
        // optional @anthropic-ai/sdk, which a consumer that does not use it has not installed.
        skipLibCheck: true,
        types: ['node'],
      },
      include: ['consumer.ts'],
    }),
  );
  await writeFile(
    join(dir, 'consumer.ts'),
    `import { evaluate, type CheckSet, type EvidenceSnapshot, type Outcome } from '${name}';
import type { ExpectOutcomeOptions } from '${name}/playwright';
export const verdictOf = (cs: CheckSet, s: EvidenceSnapshot): Outcome['verdict'] => evaluate(cs, s).verdict;
export const options: ExpectOutcomeOptions = { timeout: 0 };
`,
  );
  // Playwright's own declarations need Node's types, as in any Playwright project.
  await run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '-D', '@types/node@24'], {
    cwd: dir,
    maxBuffer: 64 << 20,
  });
  // The repository's own TypeScript (tsrs) checks the consumer against the installed declarations.
  await run(join(root, 'node_modules/.bin/tsrs'), ['-p', join(dir, 'tsconfig.json')], { cwd: dir });
});
