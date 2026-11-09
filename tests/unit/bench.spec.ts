/**
 * `assay bench` (ADR 0018): the committed fixture bench replays offline and byte for byte, a
 * model that errors leaves the others' results, Ctrl-C prints what finished, and recording
 * writes cassettes that replay. No key and no network: every model is a cassette or a local
 * adapter.
 */
import { test, expect } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../src/cli/main.ts';
import type { Io } from '../../src/cli/io.ts';
import { isModulePath, slugOf, splitRuns } from '../../src/cli/commands/bench.ts';
import { cassetteFile, stat, type BenchResult } from '../../src/cli/bench/run.ts';
import { priceBook, priceKeys, priceUsage } from '../../src/cli/bench/prices.ts';
import { duration, tokens, usd } from '../../src/cli/bench/format.ts';
import { loadConfig } from '../../src/index.ts';
import { costUsd, priceFor } from '../../src/eval/index.ts';
import type { EvidenceSnapshot } from '../../src/types.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const BENCH = join(root, 'examples/bench');
const CONFIG = join(BENCH, 'assay.config.ts');
const COPYCAT = join(BENCH, 'models/copycat.ts');
const STRATEGIES = join(root, 'examples/bench-strategies');
const STRATEGIES_CONFIG = join(STRATEGIES, 'assay.config.ts');
const tmp = () => mkdtempSync(join(tmpdir(), 'assay-bench-'));

async function assay(argv: string[], env: Record<string, string | undefined> = {}, extra: Partial<Io> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: Io = {
    out: (t) => stdout.push(t),
    err: (t) => {
      stderr.push(t);
      extra.err?.(t);
    },
    color: false,
    errColor: false,
    env,
    cwd: extra.cwd ?? root,
    ...(extra.signal ? { signal: extra.signal } : {}),
  };
  const code = await run(argv, io);
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

const REPLAY = { ASSAY_MODEL_MODE: 'replay' };

/**
 * A task in `dir/<sub>tasks/two-mugs.task.json` with runs in `dir/<sub>references/two-mugs/`: it
 * compiles from `both-mugs`, and its one held-out run is another task's page, which the checks
 * abstain on.
 */
function abstainingTask(dir: string, sub = '') {
  const shop = (p: string) => join(root, 'examples/tiny-shop', p);
  const task = JSON.parse(readFileSync(shop('tasks/03-cart-two-mugs.checks.json'), 'utf8'));
  mkdirSync(join(dir, sub, 'tasks'), { recursive: true });
  writeFileSync(
    join(dir, sub, 'tasks/two-mugs.task.json'),
    JSON.stringify({ ...task.task, id: 'tiny-shop/03-cart-two-mugs', references: ['both-mugs'] }),
  );
  const runs = join(dir, sub, 'references/two-mugs');
  cpSync(shop('references/03-cart-two-mugs/both-mugs.json'), join(runs, 'both-mugs.json'));
  // Another task's page: the checks find nothing to read and abstain.
  cpSync(shop('references/01-newsletter/never-subscribed.json'), join(runs, 'elsewhere.json'));
}

test.describe('the fixture bench', () => {
  test('replays offline and reproduces the committed report byte for byte', async () => {
    const out = join(tmp(), 'report.md');
    const first = await assay(['bench', '-c', CONFIG, '-o', out], REPLAY);
    expect(first.code, first.stderr).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(join(BENCH, 'REPORT.md'), 'utf8'));
    // The same bytes again, with any concurrency, from another directory.
    const again = await assay(['bench', '-c', CONFIG, '--concurrency', '1'], REPLAY, { cwd: BENCH });
    expect(again.stdout).toBe(first.stdout);
    expect(first.stdout).toMatch(/^assay bench: 2 models × 2 tasks × 1 run; checks scored on 5 held-out labelled runs/);
    // One row per model, in the configured order; the best value per column is marked without colour.
    const rows = first.stdout.split('\n').filter((l) => /^(anthropic|\.\/models)/.test(l));
    expect(rows.map((r) => r.split(/\s{2,}/)[0])).toEqual(['anthropic:claude-opus-5-5', './models/copycat.ts']);
    expect(rows[0]).toMatch(/tools\s+100%\s+100%\s+1\.000\s+0%\s+3\.5\s+49\.0k\s+662\s+\$0\.1219\s+—$/);
    expect(rows[1]).toMatch(/json\s+100%\s+100%\s+1\.000\s+0%\s+2\.0\*\s+12\.5k\*\s+255\*\s+—\s+432 ms$/);
    expect(first.stdout).toContain('* best in column.');
  });

  test('--json has every job, in a fixed order, with nothing unmeasured as a number', async () => {
    const r = await assay(['bench', '-c', CONFIG, '--json'], REPLAY);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout) as BenchResult;
    expect(json.schema).toBe('assay.bench/v1');
    expect(json.tasks.map((t) => [t.name, t.training])).toEqual([
      ['01-newsletter', ['subscribed']],
      ['02-add-blue-mug', ['added-blue-mug']],
    ]);
    const [opus, copycat] = json.models;
    expect(opus).toMatchObject({
      label: 'anthropic:claude-opus-5-5',
      slug: 'anthropic-claude-opus-5-5',
      ids: ['anthropic:claude-opus-5-5@high'],
      sources: ['replay'],
      modes: ['tools'],
    });
    expect(opus!.jobs.map((j) => [j.task, j.status, j.turns])).toEqual([
      ['01-newsletter', 'compiled', 3],
      ['02-add-blue-mug', 'compiled', 4],
    ]);
    expect(opus!.summary.wallMs.mean).toBeNull();
    expect(copycat).toMatchObject({ label: './models/copycat.ts', modes: ['json'], ids: ['fixture:copycat'] });
    expect(copycat!.summary.costUsd.mean).toBeNull();
    // The default bench adds nothing of the strategy dimension or the price list (ADR 0026).
    expect(Object.keys(json)).toEqual(['schema', 'runs', 'escalate', 'tasks', 'models']);
    expect(Object.keys(opus!)).not.toContain('discovery');
    expect(Object.keys(opus!.summary)).not.toContain('requirementsMined');
    expect(Object.keys(opus!.jobs[0]!)).not.toContain('price');
    expect(copycat!.jobs[0]!.heldOut).toEqual([
      { run: 'never-subscribed', expected: 'fail', verdict: 'fail' },
      { run: 'subscribed-and-dark-theme', expected: 'success', verdict: 'success' },
      { run: 'subscribed-then-unsubscribed', expected: 'fail', verdict: 'fail' },
    ]);
  });

  test('--task filters by name or glob', async () => {
    const r = await assay(['bench', '-c', CONFIG, '-t', '02-*', '--json'], REPLAY);
    expect((JSON.parse(r.stdout) as BenchResult).tasks.map((t) => t.name)).toEqual(['02-add-blue-mug']);
    const none = await assay(['bench', '-c', CONFIG, '-t', 'nothing'], REPLAY);
    expect(none.code).toBe(4);
    expect(none.stderr).toContain('no task matches --task nothing');
  });

  test('--task also takes the task file by absolute or working-directory path', async () => {
    const names = async (t: string, cwd = root) =>
      (
        JSON.parse((await assay(['bench', '-c', CONFIG, '-t', t, '--json'], REPLAY, { cwd })).stdout) as BenchResult
      ).tasks.map((x) => x.name);
    expect(await names(join(BENCH, 'tasks/02-add-blue-mug.task.json'))).toEqual(['02-add-blue-mug']);
    expect(await names('examples/bench/tasks/02-add-blue-mug.task.json')).toEqual(['02-add-blue-mug']);
    expect(await names('examples/bench/tasks/01-*.task.json')).toEqual(['01-newsletter']);
    expect(await names(join(BENCH, 'tasks/*.task.json'))).toEqual(['01-newsletter', '02-add-blue-mug']);
    // From the config's directory, the config-relative path (as reports show it) still matches.
    expect(await names('tasks/01-newsletter.task.json', BENCH)).toEqual(['01-newsletter']);
  });

  test('runs default to the references directory next to the tasks of a glob or file `bench.tasks`', async () => {
    const dir = tmp();
    abstainingTask(dir, 'suite');
    for (const tasks of ['suite/tasks/*.task.json', 'suite/tasks/two-mugs.task.json', 'suite/tasks']) {
      const config = join(dir, `c${Math.random().toString(36).slice(2)}.mjs`);
      writeFileSync(config, `export default { bench: { tasks: ${JSON.stringify(tasks)}, cassettes: 'c' } };`);
      const r = await assay(['bench', '-c', config, '-m', COPYCAT, '--json']);
      expect(r.code, `${tasks}: ${r.stderr}`).toBe(0);
      expect((JSON.parse(r.stdout) as BenchResult).tasks.map((t) => t.name)).toEqual(['two-mugs']);
    }
  });

  test('--escalate adds a column; checks that never abstain escalate nothing', async () => {
    const r = await assay(['bench', '-c', CONFIG, '--escalate'], REPLAY);
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n')[2]).toMatch(/Time\s+Escalated$/);
    expect(r.stdout).toMatch(/432 ms\s+0\.0$/m);
  });

  test('--escalate sends a held-out run the checks abstain on to the same model', async () => {
    const dir = tmp();
    abstainingTask(dir);
    const argv = ['bench', '--tasks', join(dir, 'tasks'), '-m', COPYCAT, '--cassettes', join(dir, 'c'), '--json'];
    const json = JSON.parse((await assay([...argv, '--escalate'])).stdout) as BenchResult;
    const job = json.models[0]!.jobs[0]!;
    expect(job.status).toBe('compiled');
    // The copycat has no answer as a verifier: the run stays undecided, and the turns are counted.
    expect(job.heldOut).toEqual([{ run: 'elsewhere', expected: 'fail', verdict: 'abstain', escalated: true }]);
    expect(job.turns).toBeGreaterThan(2);
    expect(json.models[0]!.summary.escalated.mean).toBe(1);
    const plain = JSON.parse((await assay(argv)).stdout) as BenchResult;
    expect(plain.models[0]!.jobs[0]!.heldOut[0]).toEqual({ run: 'elsewhere', expected: 'fail', verdict: 'abstain' });
  });
});

test.describe('errors and interruption', () => {
  test('a model that errors shows its error in its row; the others go on', async () => {
    const r = await assay(['bench', '-c', CONFIG, '-m', 'anthropic:claude-opus-5-5', '-m', 'nope:model'], REPLAY);
    expect(r.code).toBe(1);
    const row = r.stdout.split('\n').find((l) => l.startsWith('nope:model'));
    expect(row).toMatch(/^nope:model\s+error(\s+—){9}$/);
    expect(r.stdout).toMatch(/anthropic:claude-opus-5-5\s+tools\s+100%/);
    expect(r.stdout).toContain('! nope:model: error: no cassette at');
    // Live (no replay), an unknown provider is reported the same way, and nothing is recorded.
    const cassettes = tmp();
    const live = await assay(['bench', '-c', CONFIG, '-m', 'nope:model', '--cassettes', cassettes]);
    expect(live.code).toBe(1);
    expect(live.stdout).toContain('names no known provider');
    expect(readdirSync(cassettes)).toEqual([]);
  });

  test('a stale cassette is an error, not a refused compile', async () => {
    const dir = tmp();
    cpSync(join(BENCH, 'cassettes'), dir, { recursive: true });
    const file = join(dir, 'copycat/02-add-blue-mug/run-1.json');
    const c = JSON.parse(readFileSync(file, 'utf8'));
    c.turns = {};
    writeFileSync(file, JSON.stringify(c));
    const r = await assay(['bench', '-c', CONFIG, '--cassettes', dir, '--json'], REPLAY);
    expect(r.code).toBe(1);
    const job = (JSON.parse(r.stdout) as BenchResult).models[1]!.jobs[1]!;
    expect(job).toMatchObject({ task: '02-add-blue-mug', status: 'error' });
    expect(job.reason).toMatch(/^stale cassette: /);
  });

  test('an escalation the cassette has no turns for fails the job', async () => {
    const dir = tmp();
    abstainingTask(dir);
    const argv = ['bench', '--tasks', join(dir, 'tasks'), '-m', COPYCAT, '--cassettes', join(dir, 'c'), '--json'];
    // Recorded without --escalate: replaying with it needs verifier turns that were never recorded.
    expect((await assay([...argv, '--record'])).code).toBe(0);
    const r = await assay([...argv, '--escalate'], REPLAY);
    expect(r.code).toBe(1);
    const job = (JSON.parse(r.stdout) as BenchResult).models[0]!.jobs[0]!;
    expect(job).toMatchObject({ status: 'error', source: 'replay' });
    expect(job.reason).toMatch(/^stale cassette: escalating elsewhere: /);
  });

  test('a malformed timing file fails its job; the other jobs are still reported', async () => {
    const dir = tmp();
    cpSync(join(BENCH, 'cassettes'), dir, { recursive: true });
    writeFileSync(join(dir, 'copycat/01-newsletter/run-1.timing.json'), '{ "wallMs": ');
    const r = await assay(['bench', '-c', CONFIG, '--cassettes', dir, '--json'], REPLAY);
    expect(r.code).toBe(1);
    const json = JSON.parse(r.stdout) as BenchResult;
    expect(json.models[0]!.jobs.map((j) => j.status)).toEqual(['compiled', 'compiled']);
    const [bad, good] = json.models[1]!.jobs;
    expect(bad).toMatchObject({ task: '01-newsletter', status: 'error', source: 'replay' });
    expect(bad!.reason).toContain('run-1.timing.json');
    expect(good).toMatchObject({ task: '02-add-blue-mug', status: 'compiled', wallMs: 435 });
  });

  test('Ctrl-C prints what finished and exits 130', async () => {
    const ac = new AbortController();
    const r = await assay(['bench', '-c', CONFIG, '--concurrency', '1'], REPLAY, {
      signal: ac.signal,
      err: (t) => {
        if (t.startsWith('[1/4]')) ac.abort();
      },
    });
    expect(r.code).toBe(130);
    expect(r.stdout).toContain('! Interrupted: 1 of 4 compiles finished; these results are partial.');
    expect(r.stdout).toMatch(/anthropic:claude-opus-5-5\s+tools\s+100%/);
  });
});

test.describe('recording', () => {
  test('--record writes a cassette per model, task and run, which then replays', async () => {
    const dir = tmp();
    const recorded = await assay(['bench', '-c', CONFIG, '-m', COPYCAT, '--cassettes', dir, '--runs', '2', '--record']);
    expect(recorded.code, recorded.stdout).toBe(0);
    expect(readdirSync(join(dir, 'copycat/01-newsletter')).toSorted()).toEqual([
      'run-1.json',
      'run-1.timing.json',
      'run-2.json',
      'run-2.timing.json',
    ]);
    // Two runs: a mean and a spread.
    expect(recorded.stdout).toMatch(/100% ±0%/);
    const replayed = await assay(['bench', '-c', CONFIG, '-m', COPYCAT, '--cassettes', dir, '--runs', '2'], REPLAY);
    expect(replayed.code).toBe(0);
    expect(replayed.stdout).toContain('! Replayed from cassettes:');
    // Everything but the note on where the turns came from is the same as when recorded.
    const body = (s: string) => s.split('\n').filter((l) => !l.startsWith('! Replayed'));
    expect(body(replayed.stdout)).toEqual(body(recorded.stdout));
    expect((await assay(['bench', '-c', CONFIG, '--record'], { ASSAY_MODEL_MODE: 'replay' })).stderr).toContain(
      '--record and ASSAY_MODEL_MODE=replay contradict',
    );
  });

  test('a time measured in only some runs says so', async () => {
    const dir = tmp();
    const argv = ['bench', '-c', CONFIG, '-m', COPYCAT, '--cassettes', dir, '--runs', '2'];
    expect((await assay([...argv, '--record'])).code).toBe(0);
    rmSync(join(dir, 'copycat/01-newsletter/run-2.timing.json'));
    const r = await assay(argv, REPLAY);
    expect(r.code).toBe(0);
    const row = r.stdout.split('\n').find((l) => l.startsWith(COPYCAT))!;
    expect(row).toMatch(/\d+ ms \(1\/2 runs\)$/);
    expect(r.stdout).toContain(`! Time: measured in 1 of 2 runs for ${COPYCAT}; no timing for 01-newsletter · run 2.`);
    const json = JSON.parse((await assay([...argv, '--json'], REPLAY)).stdout) as BenchResult;
    expect(json.models[0]!.summary).toMatchObject({ repeats: 2, wallMs: { n: 1 }, turns: { n: 2 } });
  });

  test('without --record a live run leaves no cassette', async () => {
    const dir = tmp();
    const r = await assay(['bench', '-c', CONFIG, '-m', COPYCAT, '--cassettes', dir, '-t', '02-*']);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, 'copycat'))).toBe(false);
  });
});

test.describe('pieces', () => {
  const snap = {} as EvidenceSnapshot;
  const runOf = (name: string, expected?: 'success' | 'fail') => ({
    name,
    ...(expected ? { expected } : {}),
    snapshot: snap,
  });

  test('which runs a task compiles from', () => {
    const runs = [runOf('a-wrong', 'fail'), runOf('b-ok', 'success'), runOf('c-ok', 'success'), runOf('plain')];
    // Default: the first correct run; unlabelled runs cannot be scored.
    expect(splitRuns(runs, undefined, 'x')).toMatchObject({
      training: [{ name: 'b-ok' }],
      heldOut: [{ name: 'a-wrong' }, { name: 'c-ok' }],
    });
    expect(splitRuns(runs, ['c-ok'], 'x').training.map((r) => r.name)).toEqual(['c-ok']);
    expect(() => splitRuns(runs, ['missing'], 'x')).toThrow('x: no run named "missing"');
    const refs = [runOf('reference'), runOf('reference-editor'), runOf('agent-1', 'success')];
    expect(splitRuns(refs, undefined, 'x').training.map((r) => r.name)).toEqual(['reference', 'reference-editor']);
  });

  test('model names, cassette directories and prices', () => {
    expect(slugOf('anthropic:claude-opus-5-5')).toBe('anthropic-claude-opus-5-5');
    expect(slugOf('./models/my-adapter.ts')).toBe('my-adapter');
    expect(slugOf('ollama:llama3.1:8b')).toBe('ollama-llama3.1-8b');
    expect(isModulePath('../x.mjs')).toBe(true);
    expect(isModulePath('openai:gpt-5')).toBe(false);
    expect(priceFor('anthropic:claude-opus-5-5@high (replay)')).toEqual(priceFor('claude-opus-5-5'));
    expect(priceFor('openai:gpt-5')).toBeUndefined();
    expect(stat([1, 3, NaN])).toEqual({ mean: 2, sd: Math.SQRT2, n: 2 });
    expect(stat([NaN]).n).toBe(0);
    expect([tokens(950), tokens(49_012), usd(0.12189), usd(3.5), duration(432), duration(48_100)]).toEqual([
      '950',
      '49.0k',
      '$0.1219',
      '$3.50',
      '432 ms',
      '48.1 s',
    ]);
  });

  test('the bench config is validated', async () => {
    const dir = tmp();
    const write = (body: string) => {
      const f = join(dir, `c${Math.random().toString(36).slice(2)}.mjs`);
      writeFileSync(f, `export default ${body};`);
      return f;
    };
    await expect(loadConfig({ path: write('{ bench: { modle: [] } }') })).rejects.toThrow(
      'unknown option `bench.modle`',
    );
    await expect(loadConfig({ path: write('{ bench: { runs: 0 } }') })).rejects.toThrow(
      '`bench.runs` must be a positive integer',
    );
    await expect(loadConfig({ path: write('{ bench: { models: [] } }') })).rejects.toThrow('`bench.models` must be');
    // A named model's options are checked like `modelOptions`.
    const named = (options: string) =>
      write(`{ bench: { models: [{ name: 'x', model: 'openai:gpt-5', options: ${options} }] } }`);
    await expect(loadConfig({ path: named('{ maxOutputToken: 5 }') })).rejects.toThrow(
      'unknown option `bench.models[0].options.maxOutputToken`',
    );
    await expect(loadConfig({ path: named("{ mode: 'xml' }") })).rejects.toThrow(
      '`bench.models[0].options.mode` must be "auto", "tools" or "json"',
    );
    await expect(loadConfig({ path: named("'json'") })).rejects.toThrow('`bench.models[0].options` must be an object');
    await expect(loadConfig({ path: named("{ mode: 'json', maxOutputTokens: 5 }") })).resolves.toBeTruthy();
    const { config } = await loadConfig({ path: write("{ bench: { tasks: 'tasks', cassettes: 'c' } }") });
    expect(config.bench).toEqual({ tasks: join(dir, 'tasks'), cassettes: join(dir, 'c') });
  });

  test('help, and a bench with no models or tasks is a usage error', async () => {
    const help = await assay(['bench', '--help']);
    expect(help.stdout).toContain('Usage: assay bench [--model <model>...] [options]');
    expect((await assay(['--help'])).stdout).toContain('bench');
    const dir = tmp();
    const empty = join(dir, 'assay.config.mjs');
    writeFileSync(empty, "export default { checks: 'checks' };");
    const noModel = await assay(['bench', '-c', empty]);
    expect(noModel.code).toBe(3);
    expect(noModel.stderr).toContain('assay bench needs models to compare');
    const bare = join(dir, 'bare.mjs');
    writeFileSync(bare, 'export default {};');
    const noTasks = await assay(['bench', '-m', 'openai:gpt-5', '-c', bare]);
    expect(noTasks.code).toBe(3);
    expect(noTasks.stderr).toContain('no tasks: pass --tasks <dir|glob>');
    expect((await assay(['bench', '-c', CONFIG, '--runs', 'x'])).code).toBe(3);
  });
});

test.describe('discovery strategies (ADR 0026)', () => {
  test('the strategy fixture replays offline and reproduces its committed report byte for byte', async () => {
    const out = join(tmp(), 'report.md');
    const first = await assay(['bench', '-c', STRATEGIES_CONFIG, '-o', out], REPLAY);
    expect(first.code, first.stderr).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(join(STRATEGIES, 'REPORT.md'), 'utf8'));
    const again = await assay(['bench', '-c', STRATEGIES_CONFIG, '--concurrency', '1'], REPLAY, { cwd: STRATEGIES });
    expect(again.stdout).toBe(first.stdout);
    expect(first.stdout).toMatch(
      /^assay bench: 1 model × 3 discovery strategies \(model, mine-first, mine-only\) × 3 tasks × 1 run;/,
    );
    const rows = first.stdout.split('\n').filter((l) => /^(anthropic|none)/.test(l));
    expect(rows.map((r) => r.split(/\s{2,}/).slice(0, 3))).toEqual([
      ['anthropic:claude-opus-5-5', 'model', 'tools'],
      ['anthropic:claude-opus-5-5', 'mine-first', 'tools'],
      ['none', 'mine-only', '—'],
    ]);
    // Coverage columns: mined and discovered requirements, tasks with no discovery turn.
    expect(rows[0]).toMatch(/model\s+tools\s+100%\*\s+0%\s+100%\s+0%\s/);
    expect(rows[1]).toMatch(/mine-first\s+tools\s+100%\*\s+50%\s+50%\s+33%\s/);
    // No model: zero turns, tokens and cost, and no time.
    expect(rows[2]).toMatch(/mine-only\s+—\s+33%\s+17%\s+0%\s+33%\s.*\s0\.0\*\s+0\*\s+0\*\s+\$0\.0000\*\s+—$/);
    expect(first.stdout).toContain('Compiled is the accept rate');
    expect(first.stdout).toContain(
      '! Price of anthropic:claude-opus-5-5@high: $4 in, $20 out, $0.2 cache read, $5 cache write per million tokens (default: claude-opus-5-5).',
    );
  });

  test('--json has a row per model and strategy, and one mine-only row with no model', async () => {
    const r = await assay(['bench', '-c', STRATEGIES_CONFIG, '--json'], REPLAY);
    expect(r.code, r.stderr).toBe(0);
    const json = JSON.parse(r.stdout) as BenchResult;
    expect(json.discovery).toEqual(['model', 'mine-first', 'mine-only']);
    expect(json.models.map((m) => [m.label, m.slug, m.discovery, m.sources])).toEqual([
      ['anthropic:claude-opus-5-5', 'anthropic-claude-opus-5-5', 'model', ['replay']],
      ['anthropic:claude-opus-5-5', 'anthropic-claude-opus-5-5', 'mine-first', ['replay']],
      ['none', '', 'mine-only', ['none']],
    ]);
    const [model, mineFirst, mineOnly] = json.models;
    expect(model!.jobs.map((j) => j.requirements)).toEqual([
      { total: 2, mined: 0, discovered: 2 },
      { total: 1, mined: 0, discovered: 1 },
      { total: 5, mined: 0, discovered: 5 },
    ]);
    // Mining settles the blue mug outright (only the rubric turn), and part of the express order.
    expect(mineFirst!.jobs.map((j) => [j.task, j.discoveryTurns, j.requirements])).toEqual([
      ['01-newsletter', 2, { total: 2, mined: 0, discovered: 2 }],
      ['02-add-blue-mug', 0, { total: 1, mined: 1, discovered: 0 }],
      ['07-express-order', 4, { total: 5, mined: 3, discovered: 2 }],
    ]);
    expect(mineFirst!.summary.noDiscovery!.mean).toBeCloseTo(1 / 3);
    expect(mineOnly!.ids).toEqual([]);
    expect(mineOnly!.jobs.map((j) => [j.status, j.turns, j.costUsd, j.wallMs, 'modelId' in j, 'price' in j])).toEqual([
      ['refused', 0, 0, null, false, false],
      ['compiled', 0, 0, null, false, false],
      ['refused', 0, 0, null, false, false],
    ]);
    expect(mineOnly!.summary.costUsd.mean).toBe(0);
    expect(json.prices).toEqual([
      {
        model: 'anthropic:claude-opus-5-5@high',
        source: 'default',
        key: 'claude-opus-5-5',
        input: 4,
        output: 20,
        cacheRead: 0.2,
        cacheWrite: 5,
      },
    ]);
  });

  test('mine-only alone needs no model, no key and no cassette', async () => {
    const dir = tmp();
    const config = join(dir, 'assay.config.mjs');
    writeFileSync(
      config,
      `export default { bench: { tasks: ${JSON.stringify(join(BENCH, 'tasks'))}, references: ${JSON.stringify(join(root, 'examples/tiny-shop/references'))}, cassettes: 'c', discovery: ['mine-only'] } };`,
    );
    const r = await assay(['bench', '-c', config, '--json'], REPLAY);
    expect(r.code, r.stderr).toBe(0);
    const json = JSON.parse(r.stdout) as BenchResult;
    expect(json.models.map((m) => [m.label, m.discovery])).toEqual([['none', 'mine-only']]);
    expect(json.models[0]!.jobs.map((j) => [j.task, j.status])).toEqual([
      ['01-newsletter', 'refused'],
      ['02-add-blue-mug', 'compiled'],
    ]);
    expect(json.prices).toEqual([]);
    expect(existsSync(join(dir, 'c'))).toBe(false);
    // The open requirements are on one line in the notes.
    const text = await assay(['bench', '-c', config], REPLAY);
    expect(text.stdout).toMatch(
      /^! mine-only · 01-newsletter: not compiled: Mining did not cover every requirement: R1 .*; R2 /m,
    );
    expect(text.stdout).toMatch(/^none\s+mine-only\s+—\s+50%/m);
  });

  test('cassettes are keyed by strategy; the default strategy keeps its paths', async () => {
    expect(cassetteFile('c', 'm', 't', 1)).toBe(join('c', 'm', 't', 'run-1.json'));
    expect(cassetteFile('c', 'm', 't', 1, 'model')).toBe(join('c', 'm', 't', 'run-1.json'));
    expect(cassetteFile('c', 'm', 't', 2, 'mine-first')).toBe(join('c', 'm', 't', 'mine-first', 'run-2.json'));
    const dir = tmp();
    const argv = ['bench', '-c', CONFIG, '-m', COPYCAT, '--cassettes', dir, '-t', '02-*'];
    const recorded = await assay([...argv, '--discovery', 'model,mine-first', '--json', '--record']);
    expect(recorded.code, recorded.stderr).toBe(0);
    expect(readdirSync(join(dir, 'copycat/02-add-blue-mug')).toSorted()).toEqual([
      'mine-first',
      'run-1.json',
      'run-1.timing.json',
    ]);
    expect(readdirSync(join(dir, 'copycat/02-add-blue-mug/mine-first')).toSorted()).toEqual([
      'run-1.json',
      'run-1.timing.json',
    ]);
    // The default strategy's cassette is the one the fixture committed, turn for turn.
    const turns = (f: string) => Object.keys(JSON.parse(readFileSync(f, 'utf8')).turns);
    expect(turns(join(dir, 'copycat/02-add-blue-mug/run-1.json'))).toEqual(
      turns(join(BENCH, 'cassettes/copycat/02-add-blue-mug/run-1.json')),
    );
    // Mining settles the task: the mine-first cassette holds the rubric turn only.
    expect(turns(join(dir, 'copycat/02-add-blue-mug/mine-first/run-1.json'))).toHaveLength(1);
    const json = JSON.parse(recorded.stdout) as BenchResult;
    expect(json.models.map((m) => [m.discovery, m.jobs[0]!.turns, m.jobs[0]!.requirements])).toEqual([
      ['model', 2, { total: 1, mined: 0, discovered: 1 }],
      ['mine-first', 1, { total: 1, mined: 1, discovered: 0 }],
    ]);
    // Both replay, each from its own cassette, in the order asked.
    const replayed = await assay([...argv, '--discovery', 'mine-first,model', '--json'], REPLAY);
    expect(replayed.code, replayed.stderr).toBe(0);
    const again = JSON.parse(replayed.stdout) as BenchResult;
    expect(again.models.map((m) => [m.discovery, m.sources, m.jobs[0]!.turns])).toEqual([
      ['mine-first', ['replay'], 1],
      ['model', ['replay'], 2],
    ]);
  });

  test('a strategy list is validated, on the command line and in the config', async () => {
    const bad = await assay(['bench', '-c', CONFIG, '--discovery', 'model,mine-last'], REPLAY);
    expect(bad.code).toBe(3);
    expect(bad.stderr).toContain(
      '--discovery must be a non-empty array of "model", "mine-first", "mine-only", got "mine-last"',
    );
    const twice = await assay(['bench', '-c', CONFIG, '--discovery', 'model', '--discovery', 'model'], REPLAY);
    expect(twice.code).toBe(3);
    expect(twice.stderr).toContain('--discovery names "model" twice');
    const dir = tmp();
    const write = (body: string) => {
      const f = join(dir, `c${Math.random().toString(36).slice(2)}.mjs`);
      writeFileSync(f, `export default ${body};`);
      return f;
    };
    await expect(loadConfig({ path: write('{ bench: { discovery: [] } }') })).rejects.toThrow(
      '`bench.discovery` must be a non-empty array',
    );
    await expect(loadConfig({ path: write("{ bench: { discovery: 'mine-first' } }") })).rejects.toThrow(
      '`bench.discovery` must be a non-empty array',
    );
    await expect(loadConfig({ path: write("{ bench: { discovery: ['mine-first'] } }") })).resolves.toBeTruthy();
  });
});

test.describe('prices (ADR 0026)', () => {
  const write = (dir: string, name: string, body: string) => {
    const f = join(dir, name);
    writeFileSync(f, body);
    return f;
  };
  /** The fixture bench's config, with a `bench.prices` of its own. */
  const withPrices = (dir: string, prices: string) =>
    write(
      dir,
      `c${Math.random().toString(36).slice(2)}.mjs`,
      `export default { bench: { models: ['anthropic:claude-opus-5-5', ${JSON.stringify(COPYCAT)}], tasks: ${JSON.stringify(join(BENCH, 'tasks'))}, references: ${JSON.stringify(join(root, 'examples/tiny-shop/references'))}, cassettes: ${JSON.stringify(join(BENCH, 'cassettes'))}, prices: ${prices} } };`,
    );

  test('precedence: --prices file, then bench.prices, then the built-in list; the report says which', async () => {
    const dir = tmp();
    const config = withPrices(
      dir,
      "{ 'fixture:copycat': { input: 1, output: 2 }, 'claude-opus-5-5': { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 } }",
    );
    const json = async (argv: string[] = []) => {
      const r = await assay(['bench', '-c', config, '--json', ...argv], REPLAY);
      expect(r.code, r.stderr).toBe(0);
      return JSON.parse(r.stdout) as BenchResult;
    };
    const fromConfig = await json();
    expect(fromConfig.prices!.map((p) => [p.model, p.source, p.key, p.input])).toEqual([
      ['anthropic:claude-opus-5-5@high', 'config', 'claude-opus-5-5', 8],
      ['fixture:copycat', 'config', 'fixture:copycat', 1],
    ]);
    const [opus, copycat] = fromConfig.models;
    // Twice the built-in price: twice the fixture's cost ($0.1196 and $0.1242).
    expect(opus!.jobs.map((j) => j.costUsd!.toFixed(4))).toEqual(['0.2392', '0.2484']);
    expect(opus!.jobs[0]!.price).toEqual({ key: 'claude-opus-5-5', source: 'config' });
    const u = copycat!.jobs[0]!.usage;
    expect(copycat!.jobs[0]!.costUsd).toBeCloseTo((u.inputTokens * 1 + u.outputTokens * 2) / 1e6, 12);

    // A file wins over the config; a provider-qualified key wins over a bare one in the same table.
    const file = write(
      dir,
      'prices.json',
      JSON.stringify({ copycat: { input: 3, output: 4 }, 'fixture:copycat': { input: 5, output: 6 } }),
    );
    const fromFile = await json(['--prices', file]);
    expect(fromFile.prices!.map((p) => [p.model, p.source, p.key, p.input])).toEqual([
      ['anthropic:claude-opus-5-5@high', 'config', 'claude-opus-5-5', 8],
      ['fixture:copycat', 'file', 'fixture:copycat', 5],
    ]);

    const md = join(dir, 'report.md');
    const text = await assay(['bench', '-c', config, '--prices', file, '-o', md], REPLAY);
    expect(text.stdout).toContain(
      '! Price of fixture:copycat: $5 in, $6 out per million tokens (file: fixture:copycat).',
    );
    expect(text.stdout).not.toContain('price unknown');
    const report = readFileSync(md, 'utf8');
    expect(report).toContain('## Prices');
    expect(report).toContain('| anthropic:claude-opus-5-5@high | config | claude-opus-5-5 | $8 | $40 | $0.4 | $10 |');
    expect(report).toContain('| fixture:copycat | file | fixture:copycat | $5 | $6 | — | — |');
  });

  test('an unknown price says "price unknown", never $0', async () => {
    const dir = tmp();
    // Only a price for a model not in the bench: copycat stays unlisted.
    const config = withPrices(dir, "{ 'openai:gpt-5': { input: 1.25, output: 10 } }");
    const md = join(dir, 'report.md');
    const r = await assay(['bench', '-c', config, '-o', md], REPLAY);
    expect(r.code, r.stderr).toBe(0);
    const row = r.stdout.split('\n').find((l) => l.startsWith(COPYCAT))!;
    expect(row).toMatch(/price unknown\s+432 ms$/);
    expect(r.stdout).toContain(`! Cost: price unknown for ${COPYCAT}.`);
    expect(r.stdout).toContain('! Price of fixture:copycat: price unknown');
    const report = readFileSync(md, 'utf8');
    expect(report).toContain('| fixture:copycat | price unknown | — | — | — | — | — |');
    expect(report).toMatch(/\| 01-newsletter \| compiled \|.*\| price unknown \| 429 ms \|/);
    expect(report).not.toMatch(/copycat.*\$0\.0000/);
    const json = JSON.parse((await assay(['bench', '-c', config, '--json'], REPLAY)).stdout) as BenchResult;
    expect(json.models[1]!.jobs[0]).toMatchObject({ costUsd: null, price: null });
    expect(json.models[1]!.summary.costUsd.mean).toBeNull();
  });

  test('a price without a cache rate leaves a job that used the cache with an unknown cost', async () => {
    const dir = tmp();
    const config = withPrices(dir, "{ 'claude-opus-5-5': { input: 4, output: 20 } }");
    const r = await assay(['bench', '-c', config, '--json'], REPLAY);
    const opus = (JSON.parse(r.stdout) as BenchResult).models[0]!;
    expect(opus.jobs.map((j) => j.costUsd)).toEqual([null, null]);
    expect(opus.jobs[0]!.warnings![0]).toMatch(
      /^price unknown: claude-opus-5-5 \(config\) has no cache(Read|Write) price, and the job used \d+ cache(Read|Write) tokens$/,
    );
    const text = await assay(['bench', '-c', config], REPLAY);
    expect(text.stdout).toMatch(/^anthropic:claude-opus-5-5 .*price unknown\s+—$/m);
  });

  test('prices are validated: known keys, non-negative finite numbers, clear errors', async () => {
    const dir = tmp();
    const load = (prices: string) =>
      loadConfig({
        path: write(
          dir,
          `c${Math.random().toString(36).slice(2)}.mjs`,
          `export default { bench: { prices: ${prices} } };`,
        ),
      });
    await expect(load("{ 'x:y': { input: -1, output: 2 } }")).rejects.toThrow(
      '`bench.prices`["x:y"].input must be a non-negative finite number (USD per million tokens), got -1',
    );
    await expect(load("{ 'x:y': { input: 1, output: Infinity } }")).rejects.toThrow(
      '["x:y"].output must be a non-negative finite number',
    );
    await expect(load("{ 'x:y': { input: NaN, output: 1 } }")).rejects.toThrow(
      '["x:y"].input must be a non-negative finite number',
    );
    await expect(load("{ 'x:y': { input: '1', output: 1 } }")).rejects.toThrow(
      '["x:y"].input must be a non-negative finite number',
    );
    await expect(load("{ 'x:y': { input: 1, output: 2, cacheRaed: 0.1 } }")).rejects.toThrow(
      '`bench.prices`["x:y"]: unknown key `cacheRaed` (input, output, cacheRead, cacheWrite)',
    );
    await expect(load("{ 'x:y': { input: 1 } }")).rejects.toThrow('["x:y"].output is missing');
    await expect(load("{ 'x:y': 3 }")).rejects.toThrow('["x:y"] must be { input, output, cacheRead?, cacheWrite? }');
    await expect(load('[]')).rejects.toThrow('`bench.prices` must be an object');
    await expect(load("{ 'x:y': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }")).resolves.toBeTruthy();

    // A --prices file: the same rules, and unreadable JSON, as command errors (exit 4).
    const badJson = write(dir, 'bad.json', '{ "x": ');
    const r1 = await assay(['bench', '-c', CONFIG, '--prices', badJson], REPLAY);
    expect(r1.code).toBe(4);
    expect(r1.stderr).toContain(`--prices ${badJson}: `);
    const badKey = write(dir, 'key.json', JSON.stringify({ 'x:y': { input: 1, output: 2, extra: 1 } }));
    const r2 = await assay(['bench', '-c', CONFIG, '--prices', badKey], REPLAY);
    expect(r2.code).toBe(4);
    expect(r2.stderr).toContain(`--prices ${badKey}["x:y"]: unknown key \`extra\``);
  });

  test('price lookup: provider-qualified, then bare; effort and replay marker ignored', () => {
    expect(priceKeys('anthropic:claude-opus-5-5@high (replay)')).toEqual([
      'anthropic:claude-opus-5-5',
      'claude-opus-5-5',
    ]);
    expect(priceKeys('fixture:copycat')).toEqual(['fixture:copycat', 'copycat']);
    expect(priceKeys('local-model')).toEqual(['local-model']);
    const book = priceBook({
      file: { 'claude-opus-5-5': { input: 1, output: 1 } },
      config: { 'anthropic:claude-opus-5-5': { input: 2, output: 2 }, 'openai:gpt-5': { input: 3, output: 3 } },
    });
    expect(book.custom).toBe(true);
    // The file's bare key wins over the config's qualified one: the layer decides first.
    expect(book.find('anthropic:claude-opus-5-5@high')).toMatchObject({ source: 'file', key: 'claude-opus-5-5' });
    expect(book.find('openai:gpt-5')).toMatchObject({ source: 'config', key: 'openai:gpt-5' });
    expect(book.find('anthropic:claude-haiku-5-5')).toMatchObject({ source: 'default', key: 'claude-haiku-5-5' });
    expect(book.find('ollama:llama3.1:8b')).toBeUndefined();
    expect(priceBook({}).custom).toBe(false);
    // The built-in prices cost exactly what priceFor and costUsd did.
    const usage = { inputTokens: 39_512, outputTokens: 631, cacheReadTokens: 18_850, cacheWriteTokens: 19_997 };
    expect(priceUsage(usage, priceBook({}).find('claude-opus-5-5')!)).toEqual({
      usd: costUsd(usage, priceFor('claude-opus-5-5')),
    });
  });
});
