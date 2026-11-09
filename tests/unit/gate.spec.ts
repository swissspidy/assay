/**
 * `assay gate` and `gate()` (ADR 0021): the committed fixture reproduces its report byte for byte;
 * classification (multi-run tolerance, abstain as not passing), exit codes, `--allow`, one-sided
 * tasks, empty run directories, check sets that differ between the sides, the JSON shape, the
 * Markdown report and the programmatic API. No browser, no model.
 */
import { test, expect } from '@playwright/test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../src/cli/main.ts';
import type { Io } from '../../src/cli/io.ts';
import {
  classifyCounts,
  formatGateMarkdown,
  gate,
  GateError,
  loadConfig,
  type CheckSet,
  type EvidenceSnapshot,
  type GateResult,
} from '../../src/index.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const GATE = join(root, 'examples/gate');
const CONFIG = join(GATE, 'assay.config.ts');
const shop = (p: string) => join(root, 'examples/tiny-shop', p);
const tmp = () => mkdtempSync(join(tmpdir(), 'assay-gate-'));
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const snap = (p: string): EvidenceSnapshot => json(shop(`references/${p}.json`)).snapshot;
const set = (task: string): CheckSet => json(shop(`tasks/${task}.checks.json`));

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

/** Runs laid out as `<dir>/<side>/<task>/<name>.json`, copied from tiny-shop references. */
function sides(dir: string, layout: Record<'baseline' | 'candidate', Record<string, string[]>>) {
  for (const [side, tasks] of Object.entries(layout)) {
    for (const [task, runs] of Object.entries(tasks)) {
      mkdirSync(join(dir, side, task), { recursive: true });
      runs.forEach((r, i) => cpSync(shop(`references/${task}/${r}.json`), join(dir, side, task, `run-${i + 1}.json`)));
    }
  }
  return { baseline: join(dir, 'baseline'), candidate: join(dir, 'candidate') };
}

test.describe('the fixture gate', () => {
  test('reproduces the committed report byte for byte, from any directory, and exits 1', async () => {
    const out = join(tmp(), 'report.md');
    const first = await assay(['gate', '-c', CONFIG, '--markdown', out]);
    expect(first.code, first.stderr).toBe(1);
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(join(GATE, 'REPORT.md'), 'utf8'));
    const again = await assay(['gate', '-c', CONFIG], GATE);
    expect(again.stdout).toBe(first.stdout);

    // Changed tasks first: regressed, improved, new; unchanged last.
    const rows = first.stdout.split('\n').filter((l) => /^[✘✔+·!] /.test(l) && /\d\/\d|—/.test(l));
    expect(rows.map((r) => r.split(/\s{2,}/).slice(0, 4))).toEqual([
      ['✘', '02-add-blue-mug', 'regressed', '2/2 → 1/2'],
      ['✔', '07-express-order', 'improved', '1/2 → 2/2'],
      ['+', '09-gift-wrap', 'new', '— → 1/1'],
      ['·', '01-newsletter', 'unchanged', '2/2 → 2/2'],
    ]);
    expect(rows[0]).toMatch(/R1 2\/2 → 1\/2$/);
    expect(rows[1]).toMatch(/R2 1\/2 → 2\/2$/);
    expect(first.stdout).toContain(
      '✘ 02-add-blue-mug R1: C1 fail: schema mismatch: data must contain at least 1 valid item(s)  (candidate/02-add-blue-mug/run-2.json)',
    );
    expect(first.stdout.split('\n').at(-1)).toBe(
      'Gate failed (blocking: 02-add-blue-mug). 1 regressed, 1 improved, 1 new, 1 unchanged.',
    );
  });

  test('the report says why: the failing check, what it expected, what it found, and the run', () => {
    const report = readFileSync(join(GATE, 'REPORT.md'), 'utf8');
    expect(report).toContain('### 02-add-blue-mug: R1 The cart contains a Blue Mug (hard)');
    expect(report).toContain('Baseline: 2 of 2 passed. Candidate: 1 of 2 passed, 1 failed.');
    expect(report).toContain('In `candidate/02-add-blue-mug/run-2.json` (FAIL):');
    expect(report).toContain("- **C1** The backend cart (probe 'cart') has a line item named Blue Mug.");
    expect(report).toMatch(/ {2}- Expected: `backend probe cart at \/items, .*"Blue Mug".*`/);
    expect(report).toContain('  - Found: `probe cart at /items = [{"sku":"MUG-RED","name":"Red Mug"');
    expect(report).toContain('  - Result: fail: schema mismatch');
    expect(report).toContain('  - Baseline found: `probe cart at /items = [{"sku":"MUG-BLUE"');
    expect(report).toContain('abstain counts as not passing');
    expect(report).toContain('- `09-gift-wrap`: new, 1 of 1 candidate run succeeded.');
  });

  test('--json is the full result, assay.gate/v1, in a fixed order', async () => {
    const r = await assay(['gate', '-c', CONFIG, '--json']);
    expect(r.code).toBe(1);
    const res = JSON.parse(r.stdout) as GateResult;
    expect(Object.keys(res)).toEqual([
      'schema',
      'ok',
      'tolerance',
      'minRuns',
      'allow',
      'baseline',
      'candidate',
      'summary',
      'tasks',
      'skipped',
    ]);
    expect(res).toMatchObject({
      schema: 'assay.gate/v1',
      ok: false,
      tolerance: 0,
      minRuns: 1,
      allow: [],
      baseline: { sources: ['baseline'], runs: 6 },
      candidate: { sources: ['candidate'], runs: 7 },
      summary: { tasks: 4, regressed: 1, improved: 1, unchanged: 1, new: 1, missing: 0, blocking: 1, allowed: 0 },
      skipped: [],
    });
    const [blue, express, gift, newsletter] = res.tasks;
    expect(Object.keys(blue!)).toEqual([
      'task',
      'checkSet',
      'status',
      'blocking',
      'allowed',
      'outcome',
      'requirements',
      'findings',
      'runs',
    ]);
    expect(blue).toMatchObject({
      task: '02-add-blue-mug',
      checkSet: { id: 'tiny-shop/add-blue-mug', version: '1', file: '../tiny-shop/tasks/02-add-blue-mug.checks.json' },
      status: 'regressed',
      blocking: true,
      outcome: {
        status: 'regressed',
        baseline: { runs: 2, pass: 2, fail: 0, abstain: 0 },
        candidate: { runs: 2, pass: 1, fail: 1, abstain: 0 },
      },
      requirements: [{ id: 'R1', kind: 'hard', status: 'regressed', blocking: true, allowed: false }],
      findings: [
        {
          requirement: 'R1',
          run: 'candidate/02-add-blue-mug/run-2.json',
          verdict: 'fail',
          runs: ['candidate/02-add-blue-mug/run-2.json'],
          checks: [{ check: 'C1', status: 'fail', baseline: { run: 'baseline/02-add-blue-mug/run-1.json' } }],
        },
      ],
    });
    expect(blue!.checkSet.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(blue!.runs.candidate.map((x) => [x.name, x.verdict, x.requirements])).toEqual([
      ['run-1', 'success', { R1: 'pass' }],
      ['run-2', 'fail', { R1: 'fail' }],
    ]);
    expect(express).toMatchObject({ task: '07-express-order', status: 'improved', blocking: false, findings: [] });
    expect(express!.requirements.map((q) => [q.id, q.status])).toEqual([
      ['R1', 'unchanged'],
      ['R2', 'improved'],
      ['R3', 'unchanged'],
      ['R4', 'unchanged'],
    ]);
    expect(gift).toMatchObject({ task: '09-gift-wrap', status: 'new', blocking: false, outcome: { baseline: null } });
    expect(newsletter).toMatchObject({ task: '01-newsletter', status: 'unchanged' });
  });
});

test('classification: pass counts on the candidate scale, with a tolerance in runs', () => {
  expect(classifyCounts(2, 2, 2, 2)).toBe('unchanged');
  expect(classifyCounts(2, 2, 1, 2)).toBe('regressed');
  expect(classifyCounts(1, 2, 2, 2)).toBe('improved');
  // Tolerance: a drop of one run of five is tolerated with --tolerance 1, two runs are not.
  expect(classifyCounts(5, 5, 4, 5, 1)).toBe('unchanged');
  expect(classifyCounts(5, 5, 3, 5, 1)).toBe('regressed');
  expect(classifyCounts(3, 5, 4, 5, 1)).toBe('unchanged');
  expect(classifyCounts(3, 5, 5, 5, 1)).toBe('improved');
  // Unequal run counts compare rates: 4/4 predicts 2 of 2; 1 of 2 is a drop of one run.
  expect(classifyCounts(4, 4, 1, 2)).toBe('regressed');
  expect(classifyCounts(2, 4, 1, 2)).toBe('unchanged');
  expect(classifyCounts(2, 4, 3, 4)).toBe('improved');
  // 1 of 3 predicts 2/3 of a run out of 2: one pass is above it, none below.
  expect(classifyCounts(1, 3, 1, 2)).toBe('improved');
  expect(classifyCounts(1, 3, 0, 2)).toBe('regressed');
  expect(classifyCounts(1, 3, 0, 2, 1)).toBe('unchanged');
});

test.describe('gate()', () => {
  test('in memory: abstain counts as not passing, and the result is an acceptance function', async () => {
    const checks = { '03-cart-two-mugs': set('03-cart-two-mugs') };
    const base = { '03-cart-two-mugs': [snap('03-cart-two-mugs/both-mugs'), snap('03-cart-two-mugs/both-mugs')] };
    // Another task's page: every check abstains (anchor_missing).
    const cand = {
      '03-cart-two-mugs': [
        { name: 'ok', snapshot: snap('03-cart-two-mugs/both-mugs') },
        { name: 'lost', snapshot: snap('01-newsletter/never-subscribed') },
      ],
    };
    const r = await gate({ baseline: base, candidate: cand, checks });
    expect(r.ok).toBe(false);
    const [t] = r.tasks;
    expect(t!.outcome).toEqual({
      status: 'regressed',
      baseline: { runs: 2, pass: 2, fail: 0, abstain: 0 },
      candidate: { runs: 2, pass: 1, fail: 0, abstain: 1 },
    });
    expect(t!.requirements.every((q) => q.status === 'regressed' && q.candidate!.abstain === 1)).toBe(true);
    expect(t!.findings[0]).toMatchObject({ run: 'candidate/03-cart-two-mugs/lost', verdict: 'abstain' });
    expect(t!.findings[0]!.checks[0]).toMatchObject({ status: 'abstain', reason: 'anchor_missing' });
    expect(formatGateMarkdown(r)).toContain('Candidate: 1 of 2 passed, 1 abstained.');

    // With a tolerance of one run, the same runs pass the gate.
    const tolerant = await gate({ baseline: base, candidate: cand, checks, tolerance: 1 });
    expect([tolerant.ok, tolerant.tasks[0]!.status]).toEqual([true, 'unchanged']);

    // An optimizer's acceptance rule: keep a change only if it improves something and regresses nothing.
    const keep = (res: GateResult) => res.ok && res.summary.improved > 0;
    const better = await gate({ baseline: cand, candidate: base, checks });
    expect([keep(r), keep(better)]).toEqual([false, true]);
  });

  test('paths: a glob of side directories pools runs, and paths show relative to relativeTo', async () => {
    const dir = tmp();
    sides(join(dir, 'shard-1'), { baseline: { '02-add-blue-mug': ['added-blue-mug'] }, candidate: {} });
    sides(join(dir, 'shard-2'), { baseline: { '02-add-blue-mug': ['added-blue-mug'] }, candidate: {} });
    sides(dir, { baseline: {}, candidate: { '02-add-blue-mug': ['added-blue-mug', 'added-blue-and-red-mug'] } });
    const r = await gate({
      baseline: 'shard-*/baseline',
      candidate: 'candidate',
      checks: shop('tasks'),
      cwd: dir,
    });
    expect(r.baseline).toEqual({ sources: ['shard-1/baseline', 'shard-2/baseline'], runs: 2 });
    expect(r.tasks[0]!.runs.baseline.map((x) => x.path)).toEqual([
      'shard-1/baseline/02-add-blue-mug/run-1.json',
      'shard-2/baseline/02-add-blue-mug/run-1.json',
    ]);
    expect([r.ok, r.tasks[0]!.status]).toEqual([true, 'unchanged']);
  });

  test('input it cannot judge is a GateError', async () => {
    const dir = tmp();
    const s = sides(dir, {
      baseline: { '02-add-blue-mug': ['added-blue-mug'] },
      candidate: { '02-add-blue-mug': ['added-blue-mug', 'added-blue-mug'] },
    });
    await expect(gate({ ...s, checks: shop('tasks'), minRuns: 2 })).rejects.toThrow(
      /too few runs \(minimum 2 per side\):\n {2}02-add-blue-mug: 1 baseline run$/,
    );
    await expect(gate({ ...s, checks: shop('tasks'), tolerance: -1 })).rejects.toThrow(GateError);
    await expect(gate({ ...s, checks: { other: set('01-newsletter') } })).rejects.toThrow(
      /no task has both runs and a check set:\n {2}02-add-blue-mug: no check set named "02-add-blue-mug"/,
    );
    await expect(gate({ baseline: join(dir, 'nope'), candidate: s.candidate })).rejects.toThrow(
      /baseline not found: .*nope/,
    );
  });
});

test.describe('assay gate', () => {
  test('exit codes: 0 nothing regressed, 1 a regression, 3 usage, 4 input it cannot judge', async () => {
    const dir = tmp();
    const s = sides(dir, {
      baseline: { '02-add-blue-mug': ['added-blue-mug'] },
      candidate: { '02-add-blue-mug': ['added-blue-mug'] },
    });
    const checks = shop('tasks/02-add-blue-mug.checks.json');
    const ok = await assay(['gate', '--baseline', s.baseline, '--candidate', s.candidate, checks]);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stdout.split('\n').at(-1)).toBe('Gate passed: nothing regressed. 1 unchanged.');
    expect((await assay(['gate', '--candidate', s.candidate, checks])).code).toBe(3);
    const bad = await assay(['gate', '-b', s.baseline, '--candidate', s.candidate, '--tolerance', 'x', checks]);
    expect([bad.code, bad.stderr]).toEqual([3, expect.stringContaining('--tolerance must be a number of runs')]);
    expect((await assay(['gate', '-b', s.baseline, '--candidate', s.candidate, '--min-runs', '0', checks])).code).toBe(
      3,
    );
    const few = await assay(['gate', '-b', s.baseline, '--candidate', s.candidate, '--min-runs', '3', checks]);
    expect([few.code, few.stderr]).toEqual([4, expect.stringContaining('too few runs (minimum 3 per side)')]);

    // An empty side is an error, not a pass.
    mkdirSync(join(dir, 'empty/02-add-blue-mug'), { recursive: true });
    const empty = await assay(['gate', '-b', s.baseline, '--candidate', join(dir, 'empty'), checks]);
    expect(empty.code).toBe(4);
    expect(empty.stderr).toMatch(/no runs in the candidate \(.*empty\): expected one directory of \.json snapshots/);
  });

  test('--allow: a known-flaky task or requirement is reported but does not block', async () => {
    const dir = tmp();
    const s = sides(dir, {
      baseline: { '07-express-order': ['express-order', 'express-order'], '02-add-blue-mug': ['added-blue-mug'] },
      candidate: { '07-express-order': ['express-order', 'standard-order'], '02-add-blue-mug': ['added-blue-mug'] },
    });
    const args = ['gate', '-b', s.baseline, '--candidate', s.candidate, shop('tasks')];
    const blocked = await assay(args);
    expect(blocked.code).toBe(1);
    expect(blocked.stdout).toMatch(/✘ {2}07-express-order {2}regressed {2}2\/2 → 1\/2 {2}R2 2\/2 → 1\/2/);

    // The requirement that regressed is allowed: so is the outcome regression it accounts for.
    const req = await assay([...args, '--allow', '07-express-order:R2']);
    expect(req.code, req.stdout).toBe(0);
    expect(req.stdout).toMatch(
      /! {2}07-express-order {2}regressed \(allowed\) {2}2\/2 → 1\/2 {2}R2 2\/2 → 1\/2 \(allowed\)/,
    );
    expect(req.stdout).toContain('! 07-express-order R2: C2 fail: "standard" ≠ "express"');
    expect(req.stdout.split('\n').at(-1)).toBe(
      'Gate passed: no blocking regression; allowed: 07-express-order. 1 regressed, 1 unchanged.',
    );
    // Another requirement allowed does not cover R2.
    expect((await assay([...args, '--allow', '07-express-order:R3'])).code).toBe(1);
    // A task glob allows the whole task; the config's gate.allow works the same way.
    expect((await assay([...args, '--allow', '07-*'])).code).toBe(0);
    writeFileSync(join(dir, 'assay.config.ts'), `export default { gate: { allow: ['07-express-order'] } };\n`);
    const configured = await assay([...args, '-c', join(dir, 'assay.config.ts'), '--json']);
    expect(configured.code).toBe(0);
    const res = JSON.parse(configured.stdout) as GateResult;
    expect(res.allow).toEqual(['07-express-order']);
    expect(res.tasks[0]).toMatchObject({
      task: '07-express-order',
      status: 'regressed',
      blocking: false,
      allowed: true,
    });
    expect(res.tasks[0]!.findings[0]).toMatchObject({ requirement: 'R2', allowed: true });
  });

  test('tasks on one side: missing blocks unless allowed, new never does; empty task directories are noted', async () => {
    const dir = tmp();
    const s = sides(dir, {
      baseline: { '01-newsletter': ['subscribed'], '02-add-blue-mug': ['added-blue-mug'] },
      candidate: { '02-add-blue-mug': ['added-blue-mug'], '09-gift-wrap': ['not-gift-wrapped'] },
    });
    mkdirSync(join(s.candidate, '01-newsletter'));
    const args = ['gate', '-b', s.baseline, '--candidate', s.candidate, shop('tasks')];
    const r = await assay(args, dir);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/✘ {2}01-newsletter +missing +1\/1 → — +—\n/);
    expect(r.stdout).toMatch(/\+ {2}09-gift-wrap +new +— → 0\/1 +—\n/);
    expect(r.stdout).toContain('✘ 01-newsletter: no candidate runs');
    expect(r.stdout).toContain('! skipped 01-newsletter: no runs in candidate/01-newsletter');
    const md = join(dir, 'gate.md');
    const allowed = await assay([...args, '--allow', '01-newsletter', '--markdown', md], dir);
    expect(allowed.code).toBe(0);
    const report = readFileSync(md, 'utf8');
    expect(report).toContain('- `01-newsletter`: missing, no candidate runs (1 of 1 baseline run succeeded); allowed.');
    expect(report).toContain('- `09-gift-wrap`: new, 0 of 1 candidate run succeeded.');
    expect(report).toContain('## Skipped\n\n- `01-newsletter`: no runs in candidate/01-newsletter');
  });

  test('a check set that differs between the sides is an error that names both', async () => {
    const dir = tmp();
    const s = sides(dir, {
      baseline: { '02-add-blue-mug': ['added-blue-mug'] },
      candidate: { '02-add-blue-mug': ['added-blue-mug'] },
    });
    // The baseline pins the set it was judged with; the candidate is judged by an edited one.
    const cs = set('02-add-blue-mug');
    writeFileSync(join(s.baseline, '02-add-blue-mug.checks.json'), JSON.stringify(cs));
    const edited = structuredClone(cs);
    edited.checks[0]!.description = 'Edited.';
    writeFileSync(join(s.candidate, '02-add-blue-mug.checks.json'), JSON.stringify(edited));
    const r = await assay(['gate', '-b', s.baseline, '--candidate', s.candidate]);
    expect(r.code).toBe(4);
    expect(r.stderr).toMatch(
      /the check sets differ between the baseline and the candidate, so their runs cannot be compared:\n {2}02-add-blue-mug: baseline .*baseline\/02-add-blue-mug\.checks\.json \([0-9a-f]{12}\) ≠ candidate .*candidate\/02-add-blue-mug\.checks\.json \([0-9a-f]{12}\)/,
    );
    // A pinned set equal in content to the shared one (a lock aside) is the same set.
    writeFileSync(join(s.candidate, '02-add-blue-mug.checks.json'), JSON.stringify(cs, null, 4));
    expect((await assay(['gate', '-b', s.baseline, '--candidate', s.candidate, shop('tasks')])).code).toBe(0);
    // A pinned set wins over the shared one, so two pinned sets that differ still refuse.
    writeFileSync(join(s.candidate, '02-add-blue-mug.checks.json'), JSON.stringify(edited));
    expect((await assay(['gate', '-b', s.baseline, '--candidate', s.candidate, shop('tasks')])).code).toBe(4);
  });

  test('the config: gate defaults load, and unknown keys are refused', async () => {
    const loaded = await loadConfig({ path: CONFIG });
    expect(loaded.config.gate).toEqual({ baseline: [join(GATE, 'baseline')], candidate: [join(GATE, 'candidate')] });
    const dir = tmp();
    writeFileSync(join(dir, 'bad.config.ts'), `export default { gate: { tolerence: 1 } };\n`);
    const r = await assay(['gate', '-c', join(dir, 'bad.config.ts')]);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('unknown option `gate.tolerence`');
  });
});
