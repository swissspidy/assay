/**
 * The `assay` command-line tool in-process: argument parsing, the exit-code contract,
 * human and JSON output, and model selection. No key and no browser needed.
 */
import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, parse, run } from '../../src/cli/main.ts';
import { colorReport, type Io } from '../../src/cli/io.ts';
import { selectModel } from '../../src/cli/model.ts';
import { loadPlaywright, outFile } from '../../src/cli/commands/capture.ts';
import { lockCheckSet, type CheckSet } from '../../src/index.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shop = (p: string) => join(root, 'examples/tiny-shop', p);
const BLUE_MUG = shop('tasks/02-add-blue-mug.checks.json');
const ADDED_BLUE = shop('references/02-add-blue-mug/added-blue-mug.json');
const ADDED_RED = shop('references/02-add-blue-mug/added-red-mug.json');
const TWO_MUGS = shop('tasks/03-cart-two-mugs.checks.json');
const NEWSLETTER_RUN = shop('references/01-newsletter/never-subscribed.json');

interface Captured extends Io {
  stdout: string[];
  stderr: string[];
}

function io(env: Record<string, string | undefined> = {}, color = false): Captured {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (t) => stdout.push(t),
    err: (t) => stderr.push(t),
    color,
    errColor: color,
    env,
  };
}

async function assay(argv: string[], env: Record<string, string | undefined> = {}) {
  const c = io(env);
  const code = await run(argv, c);
  return { code, stdout: c.stdout.join('\n'), stderr: c.stderr.join('\n') };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'assay-cli-'));

test.describe('argument parsing', () => {
  test('commands, options and positionals', () => {
    expect(parse(['verify', 'a.json', 'b.json', '--json', '--record', 'out'])).toEqual({
      kind: 'run',
      command: 'verify',
      values: { json: true, record: 'out' },
      positionals: ['a.json', 'b.json'],
    });
    expect(parse(['compile', 'Do it', '-r', 'a.json', '--reference', 'dir', '--no-color'])).toMatchObject({
      values: { reference: ['a.json', 'dir'], color: false },
    });
    expect(parse(['validate', 'a.json', 'b.json', 'c.json']).kind).toBe('run');
  });

  test('help and version', () => {
    expect(parse(['--help'])).toEqual({ kind: 'help' });
    expect(parse(['help', 'stress'])).toEqual({ kind: 'help', command: 'stress' });
    expect(parse(['verify', '-h'])).toEqual({ kind: 'help', command: 'verify' });
    expect(parse(['-v'])).toEqual({ kind: 'version' });
  });

  test('usage errors', () => {
    expect(() => parse([])).toThrow('missing command');
    expect(() => parse(['frob'])).toThrow('unknown command "frob"');
    expect(() => parse(['toString'])).toThrow('unknown command');
    expect(() => parse(['--frob'])).toThrow('unknown option "--frob"');
    expect(() => parse(['verify', 'a.json'])).toThrow('missing argument');
    expect(() => parse(['verify', 'a', 'b', 'c'])).toThrow('unexpected argument "c"');
    expect(() => parse(['verify', 'a', 'b', '--bogus'])).toThrow("Unknown option '--bogus'");
    expect(() => parse(['verify', 'a', 'b', '--record'])).toThrow('argument missing');
  });

  test('usage errors exit 3 with a hint on stderr; help and version exit 0', async () => {
    const bad = await assay(['verify', BLUE_MUG]);
    expect(bad.code).toBe(EXIT.usage);
    expect(bad.code).toBe(3);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toContain('Run "assay verify --help" for usage.');
    expect((await assay([])).code).toBe(3);
    const help = await assay(['--help']);
    expect(help.code).toBe(0);
    for (const c of ['compile', 'verify', 'stress', 'validate', 'review', 'capture']) expect(help.stdout).toContain(c);
    expect((await assay(['verify', '--help'])).stdout).toContain('0 success, 1 fail, 2 abstain');
    const v = await assay(['--version']);
    expect(v.stdout).toBe(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
  });
});

test.describe('verify', () => {
  test('exit codes: 0 success, 1 fail, 2 abstain, 4 unreadable input', async () => {
    const ok = await assay(['verify', BLUE_MUG, ADDED_BLUE]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('Verdict: SUCCESS');
    expect(ok.stdout).toContain('evidence [observed, probe/structured]');
    const fail = await assay(['verify', BLUE_MUG, ADDED_RED]);
    expect(fail.code).toBe(1);
    expect(fail.stdout).toContain('Verdict: FAIL');
    const abstain = await assay(['verify', TWO_MUGS, NEWSLETTER_RUN]);
    expect(abstain.code).toBe(2);
    expect(abstain.stdout).toContain('abstain (anchor_missing)');
    const missing = await assay(['verify', BLUE_MUG, 'nope.json']);
    expect(missing.code).toBe(4);
    expect(missing.stderr).toBe('error: snapshot not found: nope.json');
  });

  test('an invalid check set or snapshot is an error (4), not a verdict', async () => {
    const dir = tmp();
    const bad = join(dir, 'bad.checks.json');
    writeFileSync(bad, JSON.stringify({ schema: 'assay.checks/v1', id: 'x' }));
    const r = await assay(['verify', bad, ADDED_BLUE]);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('Invalid check set');
    const notJson = join(dir, 'snap.json');
    writeFileSync(notJson, '{');
    expect((await assay(['verify', BLUE_MUG, notJson])).stderr).toContain('is not valid JSON');
    writeFileSync(notJson, '{"schema":"other"}');
    expect((await assay(['verify', BLUE_MUG, notJson])).stderr).toContain('is not an evidence snapshot');
  });

  test('--require-locked refuses an unlocked set and accepts a locked one', async () => {
    const r = await assay(['verify', BLUE_MUG, ADDED_BLUE, '--require-locked']);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('is not locked');
    const locked = join(tmp(), 'locked.json');
    const cs = JSON.parse(readFileSync(BLUE_MUG, 'utf8')) as CheckSet;
    writeFileSync(locked, JSON.stringify(lockCheckSet(cs, 'reviewer@example.com')));
    expect((await assay(['verify', locked, ADDED_BLUE, '--require-locked'])).code).toBe(0);
  });

  test('--json and --record', async () => {
    const dir = tmp();
    const r = await assay(['verify', BLUE_MUG, ADDED_RED, '--json', '--record', dir]);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({ verdict: 'fail', exitCode: 1, outcome: { verdict: 'fail' } });
    expect(j.written.recordFile).toContain(join(dir, 'records'));
    const record = JSON.parse(readFileSync(j.written.recordFile, 'utf8'));
    expect(record).toMatchObject({ schema: 'assay.record/v1', verdict: 'fail' });
    expect(readdirSync(join(dir, 'snapshots'))).toHaveLength(1);
    const human = await assay(['verify', BLUE_MUG, ADDED_BLUE, '--record', dir]);
    expect(human.stdout).toMatch(/Record: .*records/);
  });

  test('--escalate replays the verifier from a cassette; nothing to escalate on a decided run', async () => {
    const dir = tmp();
    const cassette = join(dir, 'verifier.json');
    writeFileSync(cassette, JSON.stringify({ schema: 'assay.cassette/v1', model: 'scripted:test', turns: {} }));
    const r = await assay(['verify', BLUE_MUG, ADDED_BLUE, '--escalate', '--cassette', cassette], {
      ASSAY_MODEL_MODE: 'replay',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Nothing to escalate.');
    // An abstained requirement goes to the verifier, whose request the empty cassette lacks.
    const a = await assay(['verify', TWO_MUGS, NEWSLETTER_RUN, '--escalate', '--cassette', cassette, '--json'], {
      ASSAY_MODEL_MODE: 'replay',
    });
    expect(a.code).toBe(2);
    expect(JSON.parse(a.stdout).escalation).toMatchObject({ requirements: ['R1', 'R2'], status: 'error' });
  });
});

test.describe('validate, review, stress', () => {
  test('validate: 0 valid, 1 invalid, --strict fails on warnings, lock state reported', async () => {
    expect((await assay(['validate', BLUE_MUG])).stdout).toMatch(
      /✔ .*valid \(tiny-shop\/add-blue-mug v1, 1 requirement, 1 check, not locked\)/,
    );
    const warned = shop('tasks/05-set-quantity.checks.json');
    const w = await assay(['validate', warned]);
    expect(w.code).toBe(0);
    expect(w.stdout).toContain('warning: check C1: exact equality on a number');
    expect((await assay(['validate', warned, '--strict'])).code).toBe(1);

    const dir = tmp();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ schema: 'assay.checks/v1' }));
    const b = await assay(['validate', BLUE_MUG, bad]);
    expect(b.code).toBe(1);
    expect(b.stdout).toContain(`✘ ${bad}: invalid`);
    expect(b.stdout).toContain("error: / must have required property 'id'");
    const broken = join(dir, 'broken.json');
    const locked = lockCheckSet(JSON.parse(readFileSync(BLUE_MUG, 'utf8')) as CheckSet, 'me');
    writeFileSync(broken, JSON.stringify({ ...locked, version: '2' }));
    expect((await assay(['validate', broken])).stdout).toContain('lock BROKEN');
    const j = JSON.parse((await assay(['validate', BLUE_MUG, broken, '--json'])).stdout);
    expect(j.map((r: { lock: unknown }) => r.lock)).toEqual(['none', 'broken']);
    expect((await assay(['validate', join(dir, 'missing.json')])).code).toBe(4);
  });

  test('review prints the review sheet; --json describes every check', async () => {
    const r = await assay(['review', BLUE_MUG]);
    expect(r.stdout).toContain('# Review: tiny-shop/add-blue-mug v1');
    expect(r.stdout).toContain('  - tests: backend probe cart at /items');
    const j = JSON.parse((await assay(['review', BLUE_MUG, '--json'])).stdout);
    expect(j.requirements[0]).toMatchObject({
      id: 'R1',
      quote: 'the cart contains a Blue Mug',
      checks: [{ id: 'C1', tests: expect.stringContaining('backend probe cart') }],
    });
    expect(j.lock).toBeNull();
  });

  test('stress: 0 without problems, 1 with; labelled incorrect runs are skipped', async () => {
    const ok = await assay(['stress', BLUE_MUG, '-r', shop('references/02-add-blue-mug')]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('No problems found.');
    const weak = await assay([
      'stress',
      shop('compiled/04-remove-red-mug.checks.json'),
      '-r',
      shop('references/04-remove-red-mug'),
      '--json',
    ]);
    expect(weak.code).toBe(1);
    expect(JSON.parse(weak.stdout).weak.length).toBeGreaterThan(0);
    const none = await assay(['stress', BLUE_MUG, '-r', ADDED_RED]);
    expect(none.code).toBe(4);
    expect(none.stderr).toContain('no correct reference run');
    expect((await assay(['stress', BLUE_MUG])).code).toBe(3);
  });
});

test.describe('compile', () => {
  const cassette = shop('compiled/02-add-blue-mug.cassette.json');

  test('replays a recorded compile and reproduces the committed check set', async () => {
    const out = join(tmp(), 'checks.json');
    const r = await assay(
      ['compile', BLUE_MUG, '--id', 'tiny-shop/02-add-blue-mug', '-r', ADDED_BLUE, '--cassette', cassette, '-o', out],
      { ASSAY_MODEL_MODE: 'replay' },
    );
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('✔ Compiled tiny-shop/02-add-blue-mug');
    expect(r.stdout).toContain(`Wrote ${out}`);
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(shop('compiled/02-add-blue-mug.checks.json'), 'utf8'));
    // Without --out the check set is printed and the summary goes to stderr.
    const piped = await assay(
      ['compile', BLUE_MUG, '--id', 'tiny-shop/02-add-blue-mug', '-r', ADDED_BLUE, '--cassette', cassette],
      { ASSAY_MODEL_MODE: 'replay' },
    );
    expect(JSON.parse(piped.stdout).id).toBe('tiny-shop/02-add-blue-mug');
    expect(piped.stderr).toContain('References: added-blue-mug (success): success');
  });

  test('a refused compile prints the reason and warnings and exits 1', async () => {
    const empty = join(tmp(), 'empty.json');
    writeFileSync(empty, JSON.stringify({ schema: 'assay.cassette/v1', model: 'm', turns: {} }));
    const r = await assay(
      ['compile', 'Do it.', '--outcomes', 'Given a cart\nWhen I pay', '-r', ADDED_BLUE, '--cassette', empty],
      { ASSAY_MODEL_MODE: 'replay' },
    );
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('✘ Refused to compile task: ');
    expect(r.stderr).toContain('no outcome clause');
    expect(r.stderr).toContain('warning:');
    const j = await assay(
      ['compile', 'Do it.', '--outcomes', 'When I pay', '-r', ADDED_BLUE, '--cassette', empty, '--json'],
      { ASSAY_MODEL_MODE: 'replay' },
    );
    expect(j.code).toBe(1);
    expect(JSON.parse(j.stdout).report.status).toBe('failed');
  });

  test('task sources, references and model errors', async () => {
    expect((await assay(['compile', 'missing.json', '-r', ADDED_BLUE])).stderr).toContain('task file not found');
    expect((await assay(['compile', 'Do it.'])).code).toBe(3);
    expect((await assay(['compile', 'Do it.', '-r', ADDED_BLUE, '--rubric', 'x'])).code).toBe(3);
    const noKey = await assay(['compile', 'Do it.', '-r', ADDED_BLUE]);
    expect(noKey.code).toBe(4);
    expect(noKey.stderr).toContain('set ANTHROPIC_API_KEY, or pass --cassette');
  });

  test('model selection follows ASSAY_MODEL_MODE and the provider', async () => {
    const dir = tmp();
    const file = join(dir, 'c.json');
    await expect(selectModel({}, { ASSAY_MODEL_MODE: 'replay' })).rejects.toThrow('needs --cassette');
    await expect(selectModel({ cassette: file }, { ASSAY_MODEL_MODE: 'replay' })).rejects.toThrow('no cassette at');
    await expect(selectModel({ cassette: file }, { ASSAY_MODEL_MODE: 'live' })).rejects.toThrow(
      'must be "replay" or "record"',
    );
    await expect(selectModel({ cassette: file }, { ASSAY_MODEL_MODE: 'record' })).rejects.toThrow('ANTHROPIC_API_KEY');
    await expect(selectModel({ provider: 'openai' }, {})).rejects.toThrow('--provider must be');
    await expect(selectModel({ provider: 'ai-sdk' }, {})).rejects.toThrow('needs a model id');
    const ai = await selectModel({ provider: 'ai-sdk', model: 'anthropic/claude-opus-5-5' }, {});
    expect(ai).toMatchObject({ mode: 'live', model: { id: 'anthropic/claude-opus-5-5' } });
    const live = await selectModel({}, { ANTHROPIC_API_KEY: 'test', ASSAY_MODEL: 'claude-x' });
    expect(live.model.id).toBe('anthropic:claude-x@high');
    writeFileSync(file, JSON.stringify({ schema: 'assay.cassette/v1', model: 'm', recordedAt: 't', turns: {} }));
    expect(await selectModel({ cassette: file }, {})).toMatchObject({
      mode: 'replay',
      provenance: { model: 'm', at: 't' },
    });
    const rec = await selectModel({ cassette: file }, { ASSAY_MODEL_MODE: 'record', ANTHROPIC_API_KEY: 'test' });
    expect(rec.mode).toBe('record');
  });
});

test.describe('capture and output', () => {
  test('a missing Playwright is a clear error', async () => {
    const notFound = Object.assign(new Error("Cannot find package '@playwright/test'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    await expect(loadPlaywright(() => Promise.reject(notFound))).rejects.toThrow(
      'assay capture needs Playwright: npm install -D @playwright/test',
    );
    expect((await assay(['capture', 'not a url'])).code).toBe(3);
    expect((await assay(['capture', 'http://x', '--wait-until', 'idle'])).code).toBe(3);
  });

  test('--out is a .json file or a directory', () => {
    const at = new Date('2026-11-05T10:00:00.000Z');
    expect(outFile('a/b.json', new URL('http://localhost:4173/'), at)).toBe('a/b.json');
    expect(outFile('snaps', new URL('http://localhost:4173/cart'), at)).toBe(
      join('snaps', 'localhost_4173-2026-11-05T10-00-00-000Z.json'),
    );
  });

  test('colour only when enabled', async () => {
    const report = 'Verdict: FAIL  (x)\n✘ [hard] R1: x\n    ✔ C1: y\n    ? C2: z';
    expect(colorReport(false, report)).toBe(report);
    expect(colorReport(true, report)).toContain('\u001b[31m✘');
    const c = io({}, true);
    await run(['verify', BLUE_MUG, ADDED_RED], c);
    expect(c.stdout.join('')).toContain('\u001b[');
    const off = io({}, true);
    await run(['verify', BLUE_MUG, ADDED_RED, '--no-color'], off);
    expect(off.stdout.join('')).not.toContain('\u001b[');
  });
});
