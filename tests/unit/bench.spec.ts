/**
 * `assay bench` (ADR 0018): the committed fixture bench replays offline and byte for byte, a
 * model that errors leaves the others' results, Ctrl-C prints what finished, and recording
 * writes cassettes that replay. No key and no network: every model is a cassette or a local
 * adapter.
 */
import { test, expect } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../src/cli/main.ts';
import type { Io } from '../../src/cli/io.ts';
import { isModulePath, slugOf, splitRuns } from '../../src/cli/commands/bench.ts';
import { stat, type BenchResult } from '../../src/cli/bench/run.ts';
import { duration, tokens, usd } from '../../src/cli/bench/format.ts';
import { loadConfig } from '../../src/index.ts';
import { priceFor } from '../../src/eval/index.ts';
import type { EvidenceSnapshot } from '../../src/types.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const BENCH = join(root, 'examples/bench');
const CONFIG = join(BENCH, 'assay.config.ts');
const COPYCAT = join(BENCH, 'models/copycat.ts');
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
    cwd: root,
    ...(extra.signal ? { signal: extra.signal } : {}),
  };
  const code = await run(argv, io);
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

const REPLAY = { ASSAY_MODEL_MODE: 'replay' };

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

  test('--escalate adds a column; checks that never abstain escalate nothing', async () => {
    const r = await assay(['bench', '-c', CONFIG, '--escalate'], REPLAY);
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n')[2]).toMatch(/Time\s+Escalated$/);
    expect(r.stdout).toMatch(/432 ms\s+0\.0$/m);
  });

  test('--escalate sends a held-out run the checks abstain on to the same model', async () => {
    const dir = tmp();
    const shop = (p: string) => join(root, 'examples/tiny-shop', p);
    const task = JSON.parse(readFileSync(shop('tasks/03-cart-two-mugs.checks.json'), 'utf8'));
    mkdirSync(join(dir, 'tasks'));
    writeFileSync(
      join(dir, 'tasks/two-mugs.task.json'),
      JSON.stringify({ ...task.task, id: 'tiny-shop/03-cart-two-mugs', references: ['both-mugs'] }),
    );
    const runs = join(dir, 'references/two-mugs');
    cpSync(shop('references/03-cart-two-mugs/both-mugs.json'), join(runs, 'both-mugs.json'));
    // Another task's page: the checks find nothing to read and abstain.
    cpSync(shop('references/01-newsletter/never-subscribed.json'), join(runs, 'elsewhere.json'));
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
