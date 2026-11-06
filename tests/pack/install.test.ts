/**
 * The npm package as a user gets it: packed (which builds dist/), installed into an empty project,
 * and used from there through every entry point, in JavaScript and in TypeScript. Installing needs
 * network access to the npm registry. Run with `npm run test:pack` (not part of `npm test`).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const { name, version, exports, bin } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  exports: Record<string, string>;
  bin: Record<string, string>;
};
/** The AI SDK version the repository tests against (from the lockfile), for the `/ai-sdk` entry. */
const aiVersion = (
  JSON.parse(await readFile(join(root, 'node_modules/ai/package.json'), 'utf8')) as { version: string }
).version;
let dir: string;
let tarball: string;
let files: string[];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'assay-pack-'));
  const { stdout } = await run('npm', ['pack', '--json', '--pack-destination', dir], {
    cwd: root,
    maxBuffer: 64 << 20,
  });
  const [pack] = JSON.parse(stdout.slice(stdout.indexOf('['))) as { filename: string; files: { path: string }[] }[];
  files = pack!.files.map((f) => f.path);
  tarball = join(dir, pack!.filename);
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
  for (const file of Object.values(bin)) assert.ok(files.includes(file), file);
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
import * as rootEntry from '${name}';
import { evaluate, validateCheckSet, verify } from '${name}';
import { assayMatchers, captureBaseline, captureSnapshot, expect, expectOutcome, test, verifyPage } from '${name}/playwright';
import { checks as checkSet, like, network, node, probe, req } from '${name}/checks';
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
const built = checkSet('Add a Blue Mug to my cart.', [
  req('R1', 'The cart has a Blue Mug', { quote: 'Add a Blue Mug' })
    .check(probe('cart', '/items').like([{ name: 'Blue Mug' }]))
    .check(network.post('/api/cart/items').requestBody(like({ sku: 'MUG-BLUE' })), { onMissing: 'abstain' })
    .check(node('main').contains({ role: 'status' })),
]);
console.log(JSON.stringify({
  valid: report.ok,
  correct: await verdict(${JSON.stringify(correct)}),
  wrong: await verdict(${JSON.stringify(wrong)}),
  evaluate: evaluate(checks, load(${JSON.stringify(correct)}).snapshot).verdict,
  playwright: [captureBaseline, captureSnapshot, expectOutcome, test, verifyPage, expect, assayMatchers.toHaveCompleted].every((f) => typeof f === 'function'),
  builder: [validateCheckSet(built).ok, (await verify(built, load(${JSON.stringify(correct)}).snapshot)).outcome.verdict, ['checks', 'req', 'node', 'text', 'value', 'page', 'like', 'printCheckSet', 'loadCheckSetFile'].filter((k) => k in rootEntry)],
  entries: [compileTask, stressTest, anthropicModel, replayModel, runAgent, metrics].every((f) => typeof f === 'function'),
  aiSdk: [model.id, turn.stop, turn.text],
  rootLeaks: ['captureBaseline', 'captureSnapshot', 'EvidenceRecorder'].filter((k) => k in rootEntry),
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
    builder: [true, 'success', []],
    entries: true,
    aiSdk: ['mock:m', 'end_turn', 'hi'],
    rootLeaks: [],
  });
});

test('without the optional peers, every entry point but /ai-sdk loads', async () => {
  // A second consumer with only the package: no `ai` and no @anthropic-ai/sdk. Not inside `dir`,
  // whose node_modules (with `ai`) module resolution would find by walking up.
  const bare = await mkdtemp(join(tmpdir(), 'assay-pack-bare-'));
  after(() => rm(bare, { recursive: true, force: true }));
  await writeFile(join(bare, 'package.json'), JSON.stringify({ name: 'bare', private: true, type: 'module' }));
  await run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', tarball], {
    cwd: bare,
    maxBuffer: 64 << 20,
  });
  await assert.rejects(access(join(bare, 'node_modules/ai')));
  await assert.rejects(access(join(bare, 'node_modules/@anthropic-ai/sdk')));
  const entries = Object.keys(exports).map((e) => (e === '.' ? name : `${name}/${e.slice(2)}`));
  const script = join(bare, 'load.js');
  await writeFile(
    script,
    `const out = {};
for (const e of ${JSON.stringify(entries)}) {
  try { out[e] = Object.keys(await import(e)).length > 0; } catch (err) { out[e] = err.code ?? String(err); }
}
console.log(JSON.stringify(out));
`,
  );
  const { stdout } = await run(process.execPath, [script], { cwd: bare });
  const loaded = JSON.parse(stdout) as Record<string, boolean | string>;
  for (const e of entries) {
    if (e === `${name}/ai-sdk`) assert.equal(loaded[e], 'ERR_MODULE_NOT_FOUND', e);
    else assert.equal(loaded[e], true, e);
  }
});

/** Run the installed `assay` executable; resolves with its exit status and output. */
/** The environment for the executable: the caller's, without anything that selects or reaches a model or a key. */
function cliEnv(env: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ASSAY_MODEL_MODE',
    'ASSAY_PROVIDER',
    'ASSAY_MODEL',
    'ASSAY_REVIEWER',
    'ASSAY_SIGNING_KEY',
    'ASSAY_TRUSTED_KEYS',
  ])
    delete out[k];
  return { ...out, ...env };
}

function assay(cwd: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      join(cwd, 'node_modules/.bin/assay'),
      args,
      { cwd, env: cliEnv(env), maxBuffer: 64 << 20 },
      (err, stdout, stderr) => resolve({ code: err ? Number(err.code) : 0, stdout, stderr }),
    );
  });
}

test('the executable runs without the model settings of the environment it is tested from', () => {
  const saved = { ...process.env };
  Object.assign(process.env, { ASSAY_MODEL_MODE: 'record', ASSAY_PROVIDER: 'ai-sdk', ANTHROPIC_API_KEY: 'k' });
  try {
    const env = cliEnv({ ASSAY_MODEL_MODE: 'replay' });
    assert.equal(env.ASSAY_MODEL_MODE, 'replay');
    assert.equal(env.ASSAY_PROVIDER, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  } finally {
    for (const k of ['ASSAY_MODEL_MODE', 'ASSAY_PROVIDER', 'ANTHROPIC_API_KEY']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('the installed assay executable verifies, validates, reviews, stress-tests and compiles', async () => {
  const ex = (p: string) => join(root, 'examples/tiny-shop', p);
  const checks = ex('tasks/02-add-blue-mug.checks.json');
  assert.equal((await assay(dir, ['--version'])).stdout.trim(), version);
  const ok = await assay(dir, ['verify', checks, ex('references/02-add-blue-mug/added-blue-mug.json')]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /^Verdict: SUCCESS/);
  assert.equal((await assay(dir, ['verify', checks, ex('references/02-add-blue-mug/added-red-mug.json')])).code, 1);
  const abstain = [
    'verify',
    ex('tasks/03-cart-two-mugs.checks.json'),
    ex('references/01-newsletter/never-subscribed.json'),
  ];
  assert.equal((await assay(dir, abstain)).code, 2);
  assert.equal((await assay(dir, ['verify'])).code, 3);
  assert.equal((await assay(dir, ['validate', checks])).code, 0);
  assert.match((await assay(dir, ['review', checks])).stdout, /# Review: tiny-shop\/add-blue-mug v1/);
  assert.equal((await assay(dir, ['stress', checks, '-r', ex('references/02-add-blue-mug')])).code, 0);
  const out = join(dir, 'compiled.checks.json');
  const compiled = await assay(
    dir,
    [
      'compile',
      checks,
      '--id',
      'tiny-shop/02-add-blue-mug',
      '-r',
      ex('references/02-add-blue-mug/added-blue-mug.json'),
      '--cassette',
      ex('compiled/02-add-blue-mug.cassette.json'),
      '-o',
      out,
    ],
    { ASSAY_MODEL_MODE: 'replay' },
  );
  assert.equal(compiled.code, 0, compiled.stderr);
  assert.equal(await readFile(out, 'utf8'), await readFile(ex('compiled/02-add-blue-mug.checks.json'), 'utf8'));
  // The fixture bench (ADR 0018) replays from the installed executable to the committed report.
  const report = join(dir, 'bench.md');
  const bench = await assay(dir, ['bench', '-c', join(root, 'examples/bench/assay.config.ts'), '-o', report], {
    ASSAY_MODEL_MODE: 'replay',
  });
  assert.equal(bench.code, 0, bench.stderr);
  assert.equal(await readFile(report, 'utf8'), await readFile(join(root, 'examples/bench/REPORT.md'), 'utf8'));
});

test('the installed executable takes a *.checks.ts written with @swissspidy/assay/checks, and prints one', async () => {
  const ex = (p: string) => join(root, 'examples/tiny-shop', p);
  const work = await mkdtemp(join(dir, 'ts-'));
  await mkdir(join(work, 'tasks'));
  const file = join(work, 'tasks/02-add-blue-mug.checks.ts');
  await writeFile(
    file,
    `import { checks, like, network, probe, req } from '${name}/checks';

export default checks({ id: 'blue', instruction: 'Add a Blue Mug to my cart.' }, [
  req('R1', 'The cart has a Blue Mug', { quote: 'Add a Blue Mug' })
    .check('The backend cart has a Blue Mug.', probe('cart', '/items').like([{ name: 'Blue Mug' }]))
    .check(network.post('/api/cart/items').requestBody(like({ sku: 'MUG-BLUE' })), { onMissing: 'abstain' }),
]);
`,
  );
  const correct = ex('references/02-add-blue-mug/added-blue-mug.json');
  assert.equal((await assay(dir, ['validate', file])).code, 0);
  const ok = await assay(dir, ['verify', file, correct]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /^Verdict: SUCCESS {2}\(blue v1/);
  assert.equal((await assay(dir, ['verify', file, ex('references/02-add-blue-mug/added-red-mug.json')])).code, 1);
  const watched = await assay(dir, ['watch', join(work, 'tasks'), '--once', '-r', ex('references')]);
  assert.equal(watched.code, 0, watched.stdout + watched.stderr);
  assert.match(watched.stdout, /✔ added-blue-mug +SUCCESS +expected success/);

  // JSON → TypeScript (importing the installed package) → JSON gives the same set.
  const printed = join(work, 'tasks/printed.checks.ts');
  const print = await assay(dir, ['checks', 'print', '--ts', ex('compiled/09-gift-wrap.checks.json'), '-o', printed]);
  assert.equal(print.code, 0, print.stderr);
  assert.match(await readFile(printed, 'utf8'), new RegExp(`from '${name}/checks';`));
  const back = await assay(dir, ['checks', 'print', printed]);
  assert.equal(back.code, 0, back.stderr);
  assert.deepEqual(
    JSON.parse(back.stdout),
    JSON.parse(await readFile(ex('compiled/09-gift-wrap.checks.json'), 'utf8')),
  );
});

test('the installed package signs an approval and verifies it against a trusted key', async () => {
  const ex = (p: string) => join(root, 'examples/tiny-shop', p);
  const work = await mkdtemp(join(dir, 'review-'));
  const checks = join(work, 'checks.json');
  const old = join(work, 'old.json');
  const snapshot = ex('references/02-add-blue-mug/added-blue-mug.json');
  await writeFile(checks, await readFile(ex('tasks/02-add-blue-mug.checks.json')));
  await writeFile(old, await readFile(checks));
  const key = join(work, 'alice.pem');
  const pub = join(work, 'alice.pub.pem');
  assert.equal((await assay(dir, ['keygen', '--out', key])).code, 0);
  const approved = await assay(dir, ['approve', checks, '--reviewer', 'alice', '--key', key]);
  assert.equal(approved.code, 0, approved.stderr);
  const signed = ['verify', checks, snapshot, '--require-signed', '--trusted-key', pub];
  assert.equal((await assay(dir, signed)).code, 0);
  assert.equal((await assay(dir, ['validate', checks, '--require-signed', '--trusted-key', pub])).code, 0);

  // An edit after approval breaks the lock, names what changed, and shows in the diff.
  const cs = JSON.parse(await readFile(checks, 'utf8'));
  cs.checks[0].description = 'Edited after approval.';
  await writeFile(checks, JSON.stringify(cs));
  const tampered = await assay(dir, signed);
  assert.equal(tampered.code, 4);
  assert.match(tampered.stderr, /lock is broken \(changed after approval: check C1 changed\)/);
  assert.match((await assay(dir, ['review', checks, '--diff', old])).stdout, /\*\*C1\*\* \(R1\) changed: description/);

  // The library: approve with a key, verify requiring that key.
  const script = join(work, 'sign.js');
  await writeFile(
    script,
    `import { readFileSync } from 'node:fs';
import { approveCheckSet, generateSigningKey, verify } from '${name}';
const keys = generateSigningKey();
const cs = approveCheckSet(JSON.parse(readFileSync(${JSON.stringify(old)}, 'utf8')), { by: 'bob', key: keys.privateKey });
const res = await verify(cs, JSON.parse(readFileSync(${JSON.stringify(snapshot)}, 'utf8')).snapshot, {
  requireLocked: { trustedKeys: [keys.publicKey] },
});
let refused = '';
try {
  await verify(cs, res.snapshot, { requireLocked: { trustedKeys: [generateSigningKey().publicKey] } });
} catch (e) {
  refused = e.name;
}
console.log(JSON.stringify({ verdict: res.outcome.verdict, signature: res.record.checkSet.locked.signature.status, refused }));
`,
  );
  const { stdout } = await run(process.execPath, [script], { cwd: dir });
  assert.deepEqual(JSON.parse(stdout), { verdict: 'success', signature: 'trusted', refused: 'LockError' });
});

test('without the optional peers, the executable runs and names what a live model needs', async () => {
  const bare = await mkdtemp(join(tmpdir(), 'assay-pack-bin-'));
  after(() => rm(bare, { recursive: true, force: true }));
  await writeFile(join(bare, 'package.json'), JSON.stringify({ name: 'bare-bin', private: true, type: 'module' }));
  await run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', tarball], {
    cwd: bare,
    maxBuffer: 64 << 20,
  });
  const ex = (p: string) => join(root, 'examples/tiny-shop', p);
  const ref = ex('references/02-add-blue-mug/added-blue-mug.json');
  const ok = await assay(bare, ['verify', ex('tasks/02-add-blue-mug.checks.json'), ref]);
  assert.equal(ok.code, 0, ok.stderr);
  const live = await assay(bare, ['compile', 'Add a Blue Mug to my cart.', '-r', ref], { ANTHROPIC_API_KEY: 'x' });
  assert.equal(live.code, 4);
  assert.match(live.stderr, /requires the optional dependency @anthropic-ai\/sdk/);
  const ai = await assay(bare, ['compile', 'Add it.', '-r', ref, '--provider', 'ai-sdk', '--model', 'a/b']);
  assert.equal(ai.code, 4);
  assert.match(ai.stderr, /requires the optional dependency `ai`/);
  const none = await assay(bare, ['compile', 'Add it.', '-r', ref]);
  assert.equal(none.code, 4);
  assert.match(none.stderr, /assay compile needs a model\. Set `model` in assay\.config\.ts/);

  // assay init writes a TypeScript config that Node loads as it is; commands that need no model run.
  const init = await assay(bare, ['init']);
  assert.equal(init.code, 0, init.stderr);
  await mkdir(join(bare, 'checks'));
  await writeFile(join(bare, 'checks/blue.checks.json'), await readFile(ex('tasks/02-add-blue-mug.checks.json')));
  const validated = await assay(bare, ['validate']);
  assert.equal(validated.code, 0, validated.stderr);
  assert.match(validated.stdout, /blue\.checks\.json: valid/);
  assert.equal((await assay(bare, ['verify', ex('tasks/02-add-blue-mug.checks.json'), ref])).code, 0);
  // The configured "anthropic:…" model names the packages it needs.
  const configured = await assay(bare, ['compile', 'Add it.', '-r', ref]);
  assert.equal(configured.code, 4);
  assert.match(
    configured.stderr,
    /needs the Vercel AI SDK and its provider package @ai-sdk\/anthropic: npm i -D ai @ai-sdk\/anthropic/,
  );
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
    `import { approveCheckSet, defineConfig, evaluate, verify, type Baseline, type CheckSet, type EvidenceSnapshot, type ModelClient, type Outcome } from '${name}';
import type { BaselineOptions, ExpectOutcomeOptions } from '${name}/playwright';
import { expect as assayExpect, type CompletedOptions } from '${name}/playwright';
import { checks, network, node, norm, probe, req, text, type CheckSetSpec } from '${name}/checks';
import type { Page } from '@playwright/test';
export const spec: CheckSetSpec = { instruction: 'Pay.', outcomes: 'Then the order is paid' };
export const built: CheckSet = checks(spec, [
  req('R1', 'The order is paid', { quote: 'the order is paid', kind: 'hard' })
    .check(probe('order', '/status').equals('paid'))
    .check('Total shown', text(/Total: (.+)/, { group: 1 }).normalize('trim', norm.currency('en-US')).sameAs(probe('order', '/total')))
    .check(node('button', 'Pay').disabled(), { onFail: 'keep' })
    .check(network.post('/api/pay').status({ gte: 200, lt: 300 }).count(1)),
]);
const completed: CompletedOptions = { timeout: 1000, verdict: 'fail', escalate: false };
export const done = async (page: Page) => {
  await assayExpect(page).toHaveCompleted(built, completed);
  await assayExpect(page).not.toHaveCompleted('checks/pay.checks.ts');
};
import type { CompileOptions } from '${name}/compiler';
import type { StressReport } from '${name}/stress';
import type { Metrics } from '${name}/eval';
export const verdictOf = (cs: CheckSet, s: EvidenceSnapshot): Outcome['verdict'] => evaluate(cs, s).verdict;
export const escalated = async (cs: CheckSet, s: EvidenceSnapshot, verifier: ModelClient) =>
  (await verify(cs, s, { verifier })).record;
export const options: ExpectOutcomeOptions = { timeout: 0, requireLocked: true, baseline: null };
export const signedOptions: ExpectOutcomeOptions = { timeout: 0, requireLocked: { trustedKeys: ['PEM'] } };
export const signedBy = (cs: CheckSet, key: string): string | undefined =>
  approveCheckSet(cs, { by: 'me', key }).locked.signature?.keyId;
export const before = (b: Baseline, o: BaselineOptions): [string, boolean] => [b.url, o.storage ?? true];
export type Used = [CompileOptions['rubric'], StressReport['rates']['variantsAccepted'], Metrics['balancedAccuracy']];
export const configs = [
  defineConfig({ model: 'anthropic:claude-opus-5-5', checks: 'checks', requireLocked: 'signed', trustedKeys: ['keys/'] }),
  defineConfig({
    model: {
      id: 'mine',
      capabilities: { tools: false },
      async turn(request) {
        return { stop: 'end_turn', text: request.system, toolCalls: [], raw: [], usage: { inputTokens: 0, outputTokens: 0 }, model: 'mine' };
      },
    },
    modelOptions: { mode: 'json' },
    stress: { skipVariants: ['reorder'] },
  }),
];
`,
  );
  // The AI SDK's own declarations need skipLibCheck (they name @types/json-schema, which it does not install).
  await writeFile(join(dir, 'tsconfig.ai.json'), tsconfig('consumer-ai.ts', true));
  await writeFile(
    join(dir, 'consumer-ai.ts'),
    `import { defineConfig, type ModelClient } from '${name}';
import { aiSdkModel } from '${name}/ai-sdk';
import type { LanguageModel } from 'ai';
export const verifierFor = (m: LanguageModel): ModelClient => aiSdkModel(m, { id: 'mine', maxOutputTokens: 4096 });
export const configFor = (m: Exclude<LanguageModel, string>) => defineConfig({ model: m, escalate: true });
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
