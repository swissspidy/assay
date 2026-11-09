/**
 * `assay status` and `status()` (ADR 0022): the committed fixture (examples/status, one task
 * stopped at each rung) reproduces its table byte for byte, every stage names its blocker, later
 * stages are not reached, `--stage` gates CI, and the JSON shape is stable. No model, no browser.
 */
import { test, expect } from '@playwright/test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { run } from '../../src/cli/main.ts';
import type { Io } from '../../src/cli/io.ts';
import {
  approveCheckSet,
  formatStatus,
  loadConfig,
  rejectCheckSet,
  status,
  STATUS_STAGES,
  type CheckSet,
  type StatusResult,
  type TaskStatus,
} from '../../src/index.ts';
import { normalizeConfig } from '../../src/config/config.ts';
import { reached } from '../../src/status/index.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = join(root, 'examples/status');
const CONFIG = join(FIXTURE, 'assay.config.ts');
const shop = (p: string) => join(root, 'examples/tiny-shop', p);
const read = (p: string): CheckSet => JSON.parse(readFileSync(p, 'utf8'));
const tmp = () => mkdtempSync(join(tmpdir(), 'assay-status-'));

async function assay(argv: string[], extra: Partial<Io> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: Io = {
    out: (t) => stdout.push(t),
    err: (t) => stderr.push(t),
    color: false,
    errColor: false,
    env: {},
    cwd: root,
    ...extra,
  };
  const code = await run(argv, io);
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

const byName = (r: StatusResult) => new Map(r.tasks.map((t) => [t.name, t] as const));
const statuses = (t: TaskStatus) => STATUS_STAGES.map((s) => t.stages[s].status);

test.describe('the fixture', () => {
  test('reproduces the committed table byte for byte, from any directory', async () => {
    const expected = readFileSync(join(FIXTURE, 'STATUS.txt'), 'utf8');
    const r = await assay(['status', '-c', CONFIG]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout + '\n').toBe(expected);
    const again = await assay(['status'], { cwd: FIXTURE });
    expect(again.stdout).toBe(r.stdout);
    expect(r.stdout.split('\n').at(-1)).toBe(
      '12 tasks: 1 ready, 1 blocked at valid, 2 at covered, 4 at locked, 2 at stress, 1 at references, 1 at recent',
    );
  });

  test('every stage names its blocker, and later stages are not reached', async () => {
    const r = byName(await status({ config: CONFIG, cwd: root }));
    const blocked = (name: string) => {
      const t = r.get(name)!;
      return [t.blockedAt, t.blocker];
    };
    expect(blocked('01-newsletter')).toEqual([
      'valid',
      'requirement R1: quote "the newsletter subscription is confirmed" does not appear in task.outcomes',
    ]);
    expect(blocked('02-add-blue-mug')).toEqual(['covered', 'R2 has no checks']);
    expect(blocked('03-cart-two-mugs')).toEqual(['covered', 'R2 is checked by free page text only (C2)']);
    expect(blocked('04-remove-red-mug')).toEqual(['locked', 'not locked']);
    expect(blocked('05-set-quantity')).toEqual(['locked', 'changed since lock: check C1 changed']);
    expect(blocked('06-cart-total')[1]).toMatch(/^untrusted key: signed with ed25519:[0-9a-f]{16}$/);
    expect(blocked('07-express-order')).toEqual([
      'stress',
      'C1 fails on variant express-gift-wrapped/extra-json-fields (+1 more)',
    ]);
    expect(blocked('08-delivery-date')).toEqual([
      'references',
      'standard-order-mislabelled: FAIL, expected success (C2 fail)',
    ]);
    expect(blocked('09-gift-wrap')).toEqual([
      'recent',
      '2/3 recent runs succeed; localhost-2026-11-09T10-00-00-000Z: FAIL (C1 fail)',
    ]);
    expect(blocked('11-unsigned')).toEqual(['locked', 'not signed (locked by bob; a trusted key is required)']);
    expect(blocked('12-no-references')).toEqual(['stress', 'no correct reference run to stress-test']);

    const ready = r.get('10-dark-german')!;
    expect(ready.ready).toBe(true);
    expect(ready.blockedAt).toBeUndefined();
    expect(statuses(ready)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
    expect(ready.stages.recent.detail).toBe('2/2 recent runs succeed');
    expect(ready.stages.locked.detail).toBe('locked by alice, signed by alice');
    expect(ready.runs).toEqual({ references: 4, recent: 2 });

    // Not reached: nothing after the failing stage is evaluated (no runs read for a set that is not locked).
    expect(statuses(r.get('01-newsletter')!)).toEqual(['fail', ...Array(5).fill('not-reached')]);
    expect(statuses(r.get('04-remove-red-mug')!)).toEqual([
      'pass',
      'pass',
      'fail',
      'not-reached',
      'not-reached',
      'not-reached',
    ]);
    expect(r.get('04-remove-red-mug')!.runs).toEqual({ references: 0, recent: 0 });
    expect(r.get('01-newsletter')!.checkSet).toBeUndefined();
    expect(r.get('02-add-blue-mug')!.checkSet).toEqual({ id: 'tiny-shop/add-blue-mug', version: '1' });
  });

  test('--json: a stable schema with every stage per task', async () => {
    const r = await assay(['status', '-c', CONFIG, '--json']);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout) as StatusResult;
    expect(Object.keys(json)).toEqual(['schema', 'stages', 'tasks', 'summary']);
    expect(json.schema).toBe('assay.status/v1');
    expect(json.stages).toEqual(['valid', 'covered', 'locked', 'stress', 'references', 'recent']);
    expect(json.summary).toEqual({
      tasks: 12,
      ready: 1,
      blocked: { valid: 1, covered: 2, locked: 4, stress: 2, references: 1, recent: 1 },
    });
    for (const t of json.tasks) {
      expect(Object.keys(t)).toEqual([
        'name',
        'file',
        ...(t.checkSet ? ['checkSet'] : []),
        'ready',
        ...(t.ready ? [] : ['blockedAt', 'blocker']),
        'stages',
        'runs',
      ]);
      expect(Object.keys(t.stages)).toEqual([...STATUS_STAGES]);
      expect(t.file).toBe(`examples/status/tasks/${t.name}.checks.json`);
      for (const s of Object.values(t.stages)) {
        expect(['pass', 'fail', 'not-reached', 'skipped']).toContain(s.status);
        expect(s.status === 'fail').toBe(s.blocker !== undefined);
      }
    }
    // The API returns the same object.
    expect(await status({ config: CONFIG, cwd: root })).toEqual(json);
  });

  test('--stage: exit 1 unless every task got through it; without it, exit 0', async () => {
    expect((await assay(['status', '-c', CONFIG, '--stage', 'valid'])).code).toBe(1);
    const ready = shop('../status/tasks/10-dark-german.checks.json');
    for (const stage of STATUS_STAGES)
      expect((await assay(['status', '-c', CONFIG, ready, '--stage', stage])).code, stage).toBe(0);
    const unsigned = join(FIXTURE, 'tasks/11-unsigned.checks.json');
    expect((await assay(['status', '-c', CONFIG, unsigned, '--stage', 'covered'])).code).toBe(0);
    expect((await assay(['status', '-c', CONFIG, unsigned, '--stage', 'locked'])).code).toBe(1);
    // Usage errors: an unknown stage, a stage that is not evaluated, no check sets.
    const bad = await assay(['status', '-c', CONFIG, '--stage', 'reviewed']);
    expect(bad.code).toBe(3);
    expect(bad.stderr).toContain('--stage must be one of valid, covered, locked, stress, references, recent');
    expect((await assay(['status', '-c', CONFIG, '--stage', 'stress', '--no-stress'])).code).toBe(3);
    expect((await assay(['status'], { cwd: tmp() })).code).toBe(3);
    // A missing file is an error (4).
    const missing = await assay(['status', join(tmp(), 'nope.checks.json')]);
    expect(missing.code).toBe(4);
    expect(missing.stderr).toContain('check set not found');
  });

  test('--no-stress leaves the stage and its column out', async () => {
    const r = await assay(['status', '-c', CONFIG, '--no-stress']);
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe('Task               Valid  Covered  Locked  References  Recent  Blocker');
    const json = JSON.parse((await assay(['status', '-c', CONFIG, '--no-stress', '--json'])).stdout) as StatusResult;
    const t = byName(json);
    expect(json.stages).not.toContain('stress');
    expect(t.get('07-express-order')!.stages.stress.status).toBe('skipped');
    // Past the stage it would have failed: its references pass, and it has no recent runs.
    expect(t.get('07-express-order')!.ready).toBe(true);
    expect(t.get('07-express-order')!.stages.recent).toEqual({ status: 'skipped', detail: 'no recent runs' });
    expect(t.get('12-no-references')!.blocker).toBe('no labelled correct reference run');
  });
});

test.describe('the table', () => {
  test('is aligned and plain without colour; colour changes nothing but escapes', async () => {
    const result = await status({ config: CONFIG, cwd: root });
    const plain = formatStatus(result);
    expect(plain).not.toContain('\u001b[');
    const rows = plain.split('\n').slice(2, 14);
    // Every stage mark sits under its column's first letter.
    const header = plain.split('\n')[0]!;
    for (const label of ['Valid', 'Covered', 'Locked', 'Stress', 'References', 'Recent']) {
      const col = header.indexOf(label);
      for (const row of rows) expect('✔✘–·').toContain(row[col]);
    }
    const colored = formatStatus(result, { color: true });
    expect(colored).toContain('\u001b[');
    expect(stripVTControlCharacters(colored)).toBe(plain);
    const cli = await assay(['status', '-c', CONFIG, '--color']);
    expect(cli.stdout).toBe(colored);
  });

  test('a skipped stage shows ·, and two tasks with one name show their files', async () => {
    const dir = tmp();
    for (const sub of ['a/tasks', 'b/tasks']) mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, 'a/tasks/x.checks.json'), readFileSync(shop('tasks/02-add-blue-mug.checks.json')));
    writeFileSync(join(dir, 'b/tasks/x.checks.json'), readFileSync(shop('tasks/02-add-blue-mug.checks.json')));
    const r = await status({ checks: [dir], cwd: dir, stages: ['valid', 'covered', 'references'] });
    const table = formatStatus(r);
    expect(table).toContain('a/tasks/x.checks.json  ✔      ✔        ✘           no labelled correct reference run');
    expect(table).toContain('b/tasks/x.checks.json');
    expect(table.split('\n').at(-1)).toBe('2 tasks: 0 ready, 2 blocked at references');
    expect(r.tasks[0]!.stages.locked).toEqual({ status: 'skipped' });
    const result: StatusResult = {
      ...r,
      tasks: [
        {
          ...r.tasks[0]!,
          name: 'y',
          ready: true,
          stages: { ...r.tasks[0]!.stages, references: { status: 'skipped' } },
        },
      ],
      summary: { tasks: 1, ready: 1, blocked: {} },
    };
    const one = formatStatus(result).split('\n');
    expect(one[2]).toBe('y     ✔      ✔        ·           ready');
    expect(one.at(-1)).toBe('1 task: 1 ready');
  });
});

test.describe('status()', () => {
  test('options win over the config: trusted keys, stages, the recent-runs window', async () => {
    const { config } = await loadConfig({ path: CONFIG });
    // Without trusted keys any valid lock passes: the untrusted and the unsigned sets get further.
    const { trustedKeys: _k, ...noKeys } = config;
    const open = byName(await status({ config: noKeys, cwd: root }));
    expect(open.get('06-cart-total')!.stages.locked).toEqual({
      status: 'pass',
      detail: 'locked by mallory (signature not checked)',
    });
    expect(open.get('11-unsigned')!.stages.locked).toEqual({ status: 'pass', detail: 'locked by bob' });
    expect(open.get('06-cart-total')!.ready).toBe(true);

    const half = byName(await status({ config: CONFIG, cwd: root, recentRuns: { minPassRate: 0.5 } }));
    expect(half.get('09-gift-wrap')!.stages.recent).toEqual({ status: 'pass', detail: '2/3 recent runs succeed' });
    const latest = byName(await status({ config: CONFIG, cwd: root, recentRuns: { last: 2, minPassRate: 0.9 } }));
    expect(latest.get('09-gift-wrap')!.blocker).toBe(
      '1/2 recent runs succeed, needs 90%; localhost-2026-11-09T10-00-00-000Z: FAIL (C1 fail)',
    );
    // No recent-runs root: the stage is not part of the ladder.
    const none = await status({ config: CONFIG, cwd: root, recent: false, stages: ['valid', 'locked'] });
    expect(none.stages).toEqual(['valid', 'locked']);
    expect(byName(none).get('02-add-blue-mug')!.stages.covered.status).toBe('skipped');
    expect(byName(none).get('07-express-order')!.ready).toBe(true);
  });

  test('a rejected set, an edited lock and a set that does not load name why', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'tasks'));
    const blue = read(shop('tasks/02-add-blue-mug.checks.json'));
    const at = '2026-11-09T00:00:00.000Z';
    writeFileSync(
      join(dir, 'tasks/rejected.checks.json'),
      JSON.stringify(rejectCheckSet(blue, { by: 'bob', note: 'C1 reads\nthe wrong probe', at })),
    );
    const locked = approveCheckSet(blue, { by: 'alice', at });
    writeFileSync(
      join(dir, 'tasks/forged.checks.json'),
      JSON.stringify({ ...locked, locked: { ...locked.locked, by: 'mallory' } }),
    );
    writeFileSync(join(dir, 'tasks/broken.checks.json'), '{ "schema": ');
    writeFileSync(join(dir, 'tasks/module.checks.ts'), 'throw new Error("boom");\n');
    const r = byName(await status({ checks: join(dir, 'tasks'), cwd: dir }));
    expect(r.get('rejected')!.blocker).toBe('rejected by bob: C1 reads the wrong probe');
    expect(r.get('forged')!.blocker).toBe(
      "lock broken: the lock's own fields (reviewer, time, note or digests) were edited",
    );
    expect(r.get('broken')!.blockedAt).toBe('valid');
    expect(r.get('broken')!.blocker).toMatch(/^not valid JSON/);
    expect(r.get('module')!.blocker).toMatch(/^cannot load .*module\.checks\.ts: boom$/);
  });

  test('reference runs: a correct run that fails names its check, an incorrect run that succeeds is named', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'tasks'));
    const runs = join(dir, 'references/02-add-blue-mug');
    mkdirSync(runs, { recursive: true });
    writeFileSync(
      join(dir, 'tasks/02-add-blue-mug.checks.json'),
      readFileSync(shop('tasks/02-add-blue-mug.checks.json')),
    );
    cpSync(shop('references/02-add-blue-mug/added-blue-mug.json'), join(runs, 'added-blue-mug.json'));
    const red = JSON.parse(readFileSync(shop('references/02-add-blue-mug/added-red-mug.json'), 'utf8'));
    writeFileSync(join(runs, 'red-says-success.json'), JSON.stringify({ ...red, label: { expected: 'success' } }));
    const blue = JSON.parse(readFileSync(shop('references/02-add-blue-mug/added-blue-mug.json'), 'utf8'));
    writeFileSync(join(runs, 'blue-says-fail.json'), JSON.stringify({ ...blue, label: { expected: 'fail' } }));
    const r = await status({ checks: [join(dir, 'tasks')], cwd: dir, stages: ['valid', 'references'] });
    expect(r.tasks[0]!.blocker).toBe('blue-says-fail: SUCCESS, expected fail (+1 more)');
    writeFileSync(join(runs, 'blue-says-fail.json'), JSON.stringify({ ...blue, label: { expected: 'success' } }));
    const again = await status({ checks: [join(dir, 'tasks')], cwd: dir, stages: ['valid', 'references'] });
    expect(again.tasks[0]!.blocker).toBe('red-says-success: FAIL, expected success (C1 fail)');
    // An unreadable run is the stage's blocker.
    writeFileSync(join(runs, 'zz-broken.json'), '[');
    const broken = await status({ checks: [join(dir, 'tasks')], cwd: dir, stages: ['valid', 'references'] });
    expect(broken.tasks[0]!.blocker).toMatch(/^zz-broken: snapshot .* is not valid JSON/);
  });

  test('reached(): every stage through the one named passed or was skipped', async () => {
    const r = byName(await status({ config: CONFIG, cwd: root }));
    expect(reached(r.get('05-set-quantity')!, 'covered')).toBe(true);
    expect(reached(r.get('05-set-quantity')!, 'locked')).toBe(false);
    expect(reached(r.get('10-dark-german')!, 'recent')).toBe(true);
  });

  test('the config key is checked', () => {
    expect(
      normalizeConfig({ status: { stages: ['valid', 'locked'], recentRuns: { last: 3, minPassRate: 0.8 } } }, root),
    ).toMatchObject({ status: { stages: ['valid', 'locked'] } });
    expect(() => normalizeConfig({ status: { stages: ['reviewed'] } }, root)).toThrow(/`status.stages` must be/);
    expect(() => normalizeConfig({ status: { recentRuns: { last: 0 } } }, root)).toThrow(/positive integer/);
    expect(() => normalizeConfig({ status: { recentRuns: { minPassRate: 2 } } }, root)).toThrow(/from 0 to 1/);
    expect(() => normalizeConfig({ status: { gate: 'locked' } }, root)).toThrow(/unknown option `status.gate`/);
  });

  test('assay help lists the command', async () => {
    expect((await assay(['--help'])).stdout).toMatch(/^ {2}status +Show how far each task is on the readiness ladder/m);
    expect((await assay(['status', '--help'])).stdout).toContain('Usage: assay status [checks...] [options]');
  });
});
