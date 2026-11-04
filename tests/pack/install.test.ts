/**
 * The npm package as a user gets it: packed (which builds dist/), installed into an empty project,
 * and used from there through every entry point, in JavaScript and in TypeScript. Installing needs
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
const { name, version, exports } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  exports: Record<string, string>;
};
/** The AI SDK version the repository tests against (from the lockfile), for the `/ai-sdk` entry. */
const aiVersion = (
  JSON.parse(await readFile(join(root, 'node_modules/ai/package.json'), 'utf8')) as { version: string }
).version;
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
  // The AI SDK is an optional peer dependency: installed here so the `/ai-sdk` entry can be used.
  await run(
    'npm',
    ['install', '--no-audit', '--no-fund', '--ignore-scripts', join(dir, pack!.filename), `ai@${aiVersion}`],
    { cwd: dir, maxBuffer: 64 << 20 },
  );
});
after(() => rm(dir, { recursive: true, force: true }));

test('the package holds the build, the docs and its metadata, and nothing else', () => {
  const outside = files.filter(
    (f) => !/^(dist|docs)\//.test(f) && !['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md'].includes(f),
  );
  assert.deepEqual(outside, []);
  for (const entry of Object.values(exports)) {
    const js = entry.replace(/^\.\//, '');
    assert.ok(files.includes(js), js);
    assert.ok(files.includes(js.replace(/\.js$/, '.d.ts')), js.replace(/\.js$/, '.d.ts'));
  }
  assert.ok(files.includes('LICENSE'));
  assert.ok(!files.some((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')), 'no TypeScript sources');
});

test('the installed library verifies a check set, and every entry point loads', async () => {
  const checks = join(root, 'examples/tiny-shop/tasks/02-add-blue-mug.checks.json');
  const correct = join(root, 'examples/tiny-shop/references/02-add-blue-mug/added-blue-mug.json');
  const wrong = join(root, 'examples/tiny-shop/references/02-add-blue-mug/added-red-mug.json');
  const script = join(dir, 'use.js');
  await writeFile(
    script,
    `import { readFileSync } from 'node:fs';
import { evaluate, validateCheckSet, verify } from '${name}';
import { captureSnapshot, expectOutcome, test, verifyPage } from '${name}/playwright';
import { compileTask } from '${name}/compiler';
import { stressTest } from '${name}/stress';
import { anthropicModel, replayModel, runAgent } from '${name}/models';
import { aiSdkModel } from '${name}/ai-sdk';
import { metrics } from '${name}/eval';
import { MockLanguageModelV4 } from 'ai/test';
const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
const checks = load(${JSON.stringify(checks)});
const report = validateCheckSet(checks);
const verdict = async (p) => (await verify(checks, load(p).snapshot)).outcome.verdict;
const model = aiSdkModel(new MockLanguageModelV4({
  provider: 'mock',
  modelId: 'm',
  doGenerate: {
    content: [{ type: 'text', text: 'hi' }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: { inputTokens: { total: 3 }, outputTokens: { total: 1 } },
    warnings: [],
  },
}));
const turn = await model.turn({ system: 's', messages: [{ role: 'user', text: 'x' }], tools: [] });
console.log(JSON.stringify({
  valid: report.ok,
  correct: await verdict(${JSON.stringify(correct)}),
  wrong: await verdict(${JSON.stringify(wrong)}),
  evaluate: evaluate(checks, load(${JSON.stringify(correct)}).snapshot).verdict,
  playwright: [captureSnapshot, expectOutcome, test, verifyPage].every((f) => typeof f === 'function'),
  entries: [compileTask, stressTest, anthropicModel, replayModel, runAgent, metrics].every((f) => typeof f === 'function'),
  aiSdk: [model.id, turn.stop, turn.text],
}));
`,
  );
  const { stdout } = await run(process.execPath, [script], { cwd: dir });
  assert.deepEqual(JSON.parse(stdout), {
    valid: true,
    correct: 'success',
    wrong: 'fail',
    evaluate: 'success',
    playwright: true,
    entries: true,
    aiSdk: ['mock:m', 'end_turn', 'hi'],
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
  const tsconfig = (include: string, skipLibCheck: boolean) =>
    JSON.stringify({
      compilerOptions: {
        target: 'ES2024',
        lib: ['ESNext', 'DOM'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck,
        types: ['node'],
      },
      include: [include],
    });
  // skipLibCheck off: these entry points do not name the optional @anthropic-ai/sdk (only
  // `/models` does), so a consumer that has not installed it needs no skipLibCheck.
  await writeFile(join(dir, 'tsconfig.json'), tsconfig('consumer.ts', false));
  await writeFile(
    join(dir, 'consumer.ts'),
    `import { evaluate, verify, type CheckSet, type EvidenceSnapshot, type ModelClient, type Outcome } from '${name}';
import type { ExpectOutcomeOptions } from '${name}/playwright';
import type { CompileOptions } from '${name}/compiler';
import type { StressReport } from '${name}/stress';
import type { Metrics } from '${name}/eval';
export const verdictOf = (cs: CheckSet, s: EvidenceSnapshot): Outcome['verdict'] => evaluate(cs, s).verdict;
export const escalated = async (cs: CheckSet, s: EvidenceSnapshot, verifier: ModelClient) =>
  (await verify(cs, s, { verifier })).record;
export const options: ExpectOutcomeOptions = { timeout: 0, requireLocked: true };
export type Used = [CompileOptions['rubric'], StressReport['rates']['variantsAccepted'], Metrics['balancedAccuracy']];
`,
  );
  // The AI SDK's own declarations need skipLibCheck (they name @types/json-schema, which it does not install).
  await writeFile(join(dir, 'tsconfig.ai.json'), tsconfig('consumer-ai.ts', true));
  await writeFile(
    join(dir, 'consumer-ai.ts'),
    `import type { ModelClient } from '${name}';
import { aiSdkModel } from '${name}/ai-sdk';
import type { LanguageModel } from 'ai';
export const verifierFor = (m: LanguageModel): ModelClient => aiSdkModel(m, { id: 'mine', maxOutputTokens: 4096 });
`,
  );
  // Playwright's own declarations need Node's types, as in any Playwright project.
  await run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '-D', '@types/node@24'], {
    cwd: dir,
    maxBuffer: 64 << 20,
  });
  // The repository's own TypeScript (tsrs) checks the consumers against the installed declarations.
  const tsrs = join(root, 'node_modules/.bin/tsrs');
  await run(tsrs, ['-p', join(dir, 'tsconfig.json')], { cwd: dir });
  await run(tsrs, ['-p', join(dir, 'tsconfig.ai.json')], { cwd: dir });
});
