/**
 * The `assay` command-line tool in-process: argument parsing, the exit-code contract,
 * human and JSON output, and model selection. No key and no browser needed.
 */
import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, parse, run } from '../../src/cli/main.ts';
import { colorReport, lineWriter, type Io } from '../../src/cli/io.ts';
import { Writable } from 'node:stream';
import { selectModel } from '../../src/cli/model.ts';
import { loadPlaywright, outFile, writeSnapshot } from '../../src/cli/commands/capture.ts';
import { installFiles } from '../../src/cli/commands/keygen.ts';
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
    // A tolerance so wide nothing can fail is weak (the compiled sets have no weak check to borrow).
    const total = JSON.parse(readFileSync(shop('tasks/06-cart-total.checks.json'), 'utf8'));
    const lax = join(tmp(), 'lax.checks.json');
    writeFileSync(
      lax,
      JSON.stringify({
        ...total,
        checks: [
          {
            id: 'C1',
            requirement: total.requirements[0].id,
            description: 'The cart total is about $21.50.',
            assert: {
              kind: 'value',
              source: { from: 'node', target: { role: 'status', name: 'Cart total' }, field: 'text' },
              normalize: [{ op: 'currency', locale: 'en-US', currency: 'USD' }],
              expect: { approx: { value: { amount: 21.5, currency: 'USD' }, abs: 1000 } },
            },
          },
        ],
      }),
    );
    const weak = await assay(['stress', lax, '-r', shop('references/06-cart-total'), '--json']);
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
    expect(noKey.stderr).toContain('assay compile needs a model. Set `model` in assay.config.ts');
    expect(noKey.stderr).toContain(
      'set ANTHROPIC_API_KEY (Claude through @anthropic-ai/sdk), or replay a recording with --cassette <file>',
    );
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

test.describe('review findings', () => {
  test('capture into a directory never overwrites a capture from the same millisecond', () => {
    const dir = tmp();
    const url = new URL('http://localhost:4173/');
    const at = new Date('2026-11-05T10:00:00.000Z');
    const a = writeSnapshot(dir, url, '{"n":1}\n', at);
    const b = writeSnapshot(dir, url, '{"n":2}\n', at);
    expect(b).not.toBe(a);
    expect(b).toBe(join(dir, 'localhost_4173-2026-11-05T10-00-00-000Z-2.json'));
    expect(readFileSync(a, 'utf8')).toBe('{"n":1}\n');
    expect(readFileSync(b, 'utf8')).toBe('{"n":2}\n');
    // A named file is the caller's choice and is replaced.
    const named = join(dir, 'snap.json');
    writeSnapshot(named, url, '1', at);
    expect(writeSnapshot(named, url, '2', at)).toBe(named);
    expect(readFileSync(named, 'utf8')).toBe('2');
  });

  test('a JSON task whose instruction is only whitespace is rejected', async () => {
    const task = join(tmp(), 'task.json');
    writeFileSync(task, JSON.stringify({ instruction: '  \n ' }));
    const r = await assay(['compile', task, '-r', ADDED_BLUE]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('the task instruction is empty');
  });

  test('--outcomes naming a missing file is an error, not outcome text', async () => {
    const r = await assay(['compile', 'Do it.', '--outcomes', 'outcomes.md', '-r', ADDED_BLUE]);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('outcomes file not found: outcomes.md');
  });

  test('stress fails when a correct reference run is not passed, even with no check to blame', async () => {
    const cs = JSON.parse(readFileSync(BLUE_MUG, 'utf8')) as CheckSet;
    cs.requirements.push({
      id: 'R2',
      kind: 'hard',
      text: 'A Blue Mug is added',
      source: { field: 'instruction', quote: 'Add a Blue Mug' },
    });
    const file = join(tmp(), 'uncovered.checks.json');
    writeFileSync(file, JSON.stringify(cs));
    const r = await assay(['stress', file, '-r', ADDED_BLUE]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('Problems: 1 reference run(s) not passed');
  });

  test('stress rejects two references with the same name', async () => {
    const r = await assay(['stress', BLUE_MUG, '-r', ADDED_BLUE, '-r', ADDED_BLUE]);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('two references are named "added-blue-mug"');
  });

  test('verify --escalate needs a model only when a requirement escalates', async () => {
    const decided = await assay(['verify', BLUE_MUG, ADDED_BLUE, '--escalate']);
    expect(decided).toMatchObject({ code: 0, stderr: '' });
    expect(decided.stdout).toContain('Nothing to escalate.');
    const abstained = await assay(['verify', TWO_MUGS, NEWSLETTER_RUN, '--escalate']);
    expect(abstained.code).toBe(4);
    expect(abstained.stderr).toContain('set ANTHROPIC_API_KEY');
  });

  test('a recording with no turns does not replace or create a cassette', async () => {
    const dir = tmp();
    const existing = join(dir, 'existing.json');
    const content = JSON.stringify({ schema: 'assay.cassette/v1', model: 'm', turns: { k: {} } });
    writeFileSync(existing, content);
    const env = { ASSAY_MODEL_MODE: 'record', ANTHROPIC_API_KEY: 'test' };
    (await selectModel({ cassette: existing }, env)).save();
    expect(readFileSync(existing, 'utf8')).toBe(content);
    const fresh = join(dir, 'fresh.json');
    (await selectModel({ cassette: fresh }, { ANTHROPIC_API_KEY: 'test' })).save();
    expect(readdirSync(dir)).toEqual(['existing.json']);
  });

  test('a closed pipe stops output quietly', async () => {
    const written: string[] = [];
    let first = true;
    const stream = new Writable({
      write(chunk, _enc, cb) {
        if (first) {
          first = false;
          written.push(String(chunk));
          cb();
        } else cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      },
    });
    const out = lineWriter(stream);
    out('one');
    out('two'); // the reader is gone: reported as EPIPE, swallowed
    await new Promise((r) => setImmediate(r));
    out('three'); // no write after the pipe closed
    expect(written).toEqual(['one\n']);
  });

  test('help and version take no further arguments; inherited names are not commands', () => {
    expect(() => parse(['--help', 'verify'])).toThrow('unexpected argument "verify" after --help');
    expect(() => parse(['-h', 'x'])).toThrow('unexpected argument');
    expect(() => parse(['help', 'verify', 'x'])).toThrow('unexpected argument "x" after help');
    expect(() => parse(['--version', 'x'])).toThrow('unexpected argument "x" after --version');
    expect(() => parse(['help', 'toString'])).toThrow('unknown command "toString"');
    expect(() => parse(['help', '__proto__'])).toThrow('unknown command');
  });

  test('--no-color applies to usage errors too', async () => {
    const c = io({}, true);
    expect(await run(['verify', '--no-color'], c)).toBe(3);
    expect(c.stderr.join('')).toContain('error: missing argument');
    expect(c.stderr.join('')).not.toContain('\u001b[');
    const colored = io({}, true);
    await run(['verify'], colored);
    expect(colored.stderr.join('')).toContain('\u001b[');
  });
});

test.describe('review workflow (ADR 0013)', () => {
  const copy = (from: string, dir: string, name = 'checks.json') => {
    const to = join(dir, name);
    writeFileSync(to, readFileSync(from, 'utf8'));
    return to;
  };

  test('keygen, signed approve, validate and verify requiring a trusted signature', async () => {
    const dir = tmp();
    const key = join(dir, 'alice.pem');
    const k = await assay(['keygen', '--out', key]);
    expect(k.code).toBe(0);
    expect(k.stdout).toMatch(/Key id: ed25519:[0-9a-f]{16}/);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'alice.pub.pem'), 'utf8')).toContain('BEGIN PUBLIC KEY');
    expect((await assay(['keygen', '--out', key])).stderr).toContain('exists (use --force');

    const checks = copy(BLUE_MUG, dir);
    const a = await assay(['approve', checks, '--reviewer', 'alice', '--key', key, '--note', 'read it']);
    expect(a.code).toBe(0);
    expect(a.stdout).toMatch(/Approved tiny-shop\/add-blue-mug v1 as alice, signed with key ed25519:/);
    const locked = JSON.parse(readFileSync(checks, 'utf8'));
    expect(locked.locked).toMatchObject({ by: 'alice', note: 'read it', signature: { alg: 'ed25519' } });
    expect(readFileSync(checks, 'utf8').endsWith('}\n')).toBe(true);

    const pub = join(dir, 'alice.pub.pem');
    const v = await assay(['validate', checks, '--require-signed', '--trusted-key', pub]);
    expect(v.code).toBe(0);
    expect(v.stdout).toContain('signed by trusted key alice');
    expect((await assay(['verify', checks, ADDED_BLUE, '--require-signed', '--trusted-key', dir])).code).toBe(0);
    // The keys may come from the environment instead.
    const env = { ASSAY_TRUSTED_KEYS: readFileSync(pub, 'utf8') };
    const j = JSON.parse((await assay(['verify', checks, ADDED_BLUE, '--require-signed', '--json'], env)).stdout);
    expect(j.exitCode).toBe(0);

    // Another key is not trusted; no key at all is an error.
    const other = join(dir, 'other');
    await assay(['keygen', '--out', `${other}.pem`]);
    const otherPub = `${other}.pub.pem`;
    const untrusted = await assay(['verify', checks, ADDED_BLUE, '--require-signed', '--trusted-key', otherPub]);
    expect(untrusted.code).toBe(4);
    expect(untrusted.stderr).toContain('which is not a trusted key');
    expect((await assay(['validate', checks, '--require-signed', '--trusted-key', otherPub])).code).toBe(1);
    const none = await assay(['verify', checks, ADDED_BLUE, '--require-signed']);
    expect(none.code).toBe(4);
    expect(none.stderr).toContain('--require-signed needs the trusted public keys');

    // An unsigned approval passes --require-locked but not --require-signed.
    const unsigned = copy(BLUE_MUG, dir, 'unsigned.json');
    expect((await assay(['approve', unsigned, '--reviewer', 'bob'])).stdout).toContain('unsigned');
    expect((await assay(['verify', unsigned, ADDED_BLUE, '--require-locked'])).code).toBe(0);
    const u = await assay(['verify', unsigned, ADDED_BLUE, '--require-signed', '--trusted-key', pub]);
    expect(u.stderr).toContain('is locked by bob but not signed');
    // The reviewer and signing key may come from the environment; a bad key is an error.
    const viaEnv = copy(BLUE_MUG, dir, 'env.json');
    const e = await assay(['approve', viaEnv, '--json'], {
      ASSAY_REVIEWER: 'carol',
      ASSAY_SIGNING_KEY: readFileSync(key, 'utf8'),
    });
    expect(JSON.parse(e.stdout)).toMatchObject({ state: 'approved', lock: { by: 'carol', signature: {} } });
    expect((await assay(['approve', viaEnv, '--reviewer', 'x', '--key', pub])).stderr).toContain(
      'not a PEM private key',
    );
    expect((await assay(['approve', viaEnv])).code).toBe(3);
  });

  test('tampering is named, the diff shows what changed, reject and unlock', async () => {
    const dir = tmp();
    const checks = copy(TWO_MUGS, dir);
    const old = join(dir, 'old.json');
    expect((await assay(['approve', checks, '--reviewer', 'alice', '--out', old])).code).toBe(0);
    const cs = JSON.parse(readFileSync(old, 'utf8')) as CheckSet;
    cs.checks[1]!.description = 'Changed.';
    writeFileSync(checks, JSON.stringify(cs));

    const v = await assay(['verify', checks, ADDED_BLUE, '--require-locked']);
    expect(v.code).toBe(4);
    expect(v.stderr).toContain('its lock is broken (changed after approval: check C2 changed)');
    expect((await assay(['validate', checks])).stdout).toContain(
      'lock BROKEN (changed after approval: check C2 changed)',
    );

    const r = await assay(['review', checks, '--diff', old]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('- **C2** (R2) changed: description');
    expect(r.stdout).toContain('**To re-review:** R2. Unchanged: requirements R1; checks C1.');
    expect(r.stdout).toContain('### Unchanged since tiny-shop/cart-two-mugs v1 (1 requirement)');
    expect((await assay(['review', checks, '--diff', old, '--format', 'github'])).stdout).toContain('<details>');
    const html = await assay(['review', checks, '--diff', old, '--format', 'html']);
    expect(html.stdout).toContain('<h1>Review: tiny-shop/cart-two-mugs v1</h1>');
    expect((await assay(['review', checks, '--format', 'pdf'])).code).toBe(3);
    const j = JSON.parse((await assay(['review', checks, '--diff', old, '--json'])).stdout);
    expect(j).toMatchObject({
      state: 'changed',
      lock: 'broken',
      lockProblems: ['changed after approval: check C2 changed'],
      diff: { toReview: ['R2'], checks: { changed: [{ id: 'C2', fields: ['description'] }] } },
    });
    expect(j.requirements[0].checks[0].reads).toEqual(['accessibility tree (semantic)']);

    expect((await assay(['reject', checks, '--reviewer', 'bob'])).code).toBe(3);
    expect((await assay(['reject', checks, '--reviewer', 'bob', '--note', 'C2 is vague'])).code).toBe(0);
    const rej = await assay(['verify', checks, ADDED_BLUE, '--require-locked']);
    expect(rej.stderr).toContain('bob rejected it (C2 is vague)');
    expect((await assay(['review', checks])).stdout).toContain('**Rejected by bob at');
    const un = await assay(['unlock', checks]);
    expect(un.stdout).toContain('Removed the rejection');
    expect(JSON.parse(readFileSync(checks, 'utf8'))).not.toHaveProperty('rejected');
    expect((await assay(['review', checks])).stdout).toContain('Not locked: a proposal awaiting review.');
  });

  test('approve binds the stress report; review shows its findings', async () => {
    const dir = tmp();
    const checks = copy(shop('compiled/04-remove-red-mug.checks.json'), dir);
    const report = join(dir, 'stress.json');
    const s = await assay(['stress', checks, '-r', shop('references/04-remove-red-mug'), '--json']);
    writeFileSync(report, s.stdout);
    expect((await assay(['approve', checks, '--reviewer', 'a', '--stress', report])).code).toBe(0);
    const sheet = (await assay(['review', checks, '--stress', report])).stdout;
    expect(sheet).toContain('## Stress test');
    expect(sheet).toContain('this is the report the approver saw');
    expect(sheet).toMatch(/ {2}- stress: no targeted mutant /);
    const wrong = await assay(['approve', copy(BLUE_MUG, dir, 'b.json'), '--reviewer', 'a', '--stress', report]);
    expect(wrong.code).toBe(4);
    expect(wrong.stderr).toContain('the stress report is for tiny-shop/04-remove-red-mug v1');
    expect((await assay(['review', checks, '--stress', BLUE_MUG])).stderr).toContain('is not a stress report');
  });
});

test.describe('review workflow: file safety and ordering (PR #24 review)', () => {
  test('approve rewrites the file atomically, leaving no temporary files', async () => {
    const dir = tmp();
    const checks = join(dir, 'checks.json');
    writeFileSync(checks, readFileSync(BLUE_MUG, 'utf8'));
    expect((await assay(['approve', checks, '--reviewer', 'a'])).code).toBe(0);
    expect(readdirSync(dir)).toEqual(['checks.json']);
    expect(JSON.parse(readFileSync(checks, 'utf8')).locked.by).toBe('a');
  });

  test('keygen: --force replaces both files with a private key of mode 600; otherwise nothing is half-written', async () => {
    const dir = tmp();
    const key = join(dir, 'k.pem');
    const pub = join(dir, 'k.pub.pem');
    writeFileSync(key, 'old', { mode: 0o644 });
    writeFileSync(pub, 'old');
    expect((await assay(['keygen', '--out', key])).code).toBe(4);
    expect(readFileSync(key, 'utf8')).toBe('old');
    expect((await assay(['keygen', '--out', key, '--force'])).code).toBe(0);
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(readFileSync(key, 'utf8')).toContain('BEGIN PRIVATE KEY');
    expect(readFileSync(pub, 'utf8')).toContain('BEGIN PUBLIC KEY');
    expect(readdirSync(dir).toSorted()).toEqual(['k.pem', 'k.pub.pem']);
    // Only the public key exists: the private key is not created either.
    const lone = join(dir, 'lone.pem');
    writeFileSync(join(dir, 'lone.pub.pem'), 'old');
    expect((await assay(['keygen', '--out', lone])).stderr).toContain('lone.pub.pem exists');
    expect(readdirSync(dir)).not.toContain('lone.pem');
  });

  test('keygen restores the old files when installing the new ones fails', () => {
    const dir = tmp();
    const dest = join(dir, 'a.pem');
    writeFileSync(dest, 'old');
    const staged = join(dir, 'staged');
    writeFileSync(staged, 'new');
    // The second staged file does not exist, so linking it fails after the first is installed.
    expect(() =>
      installFiles(
        [
          { staged, dest },
          { staged: join(dir, 'missing'), dest: join(dir, 'b.pem') },
        ],
        true,
      ),
    ).toThrow();
    expect(readFileSync(dest, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['a.pem']);
  });

  test('an empty --key file is an error, not an unsigned approval', async () => {
    const dir = tmp();
    const checks = join(dir, 'checks.json');
    writeFileSync(checks, readFileSync(BLUE_MUG, 'utf8'));
    writeFileSync(join(dir, 'empty.pem'), '');
    const r = await assay(['approve', checks, '--reviewer', 'a', '--key', join(dir, 'empty.pem')]);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('is empty');
    expect(JSON.parse(readFileSync(checks, 'utf8')).locked).toBeUndefined();
  });

  test('review --stress --json includes the stress results and whether the approver saw them', async () => {
    const dir = tmp();
    const checks = join(dir, 'checks.json');
    writeFileSync(checks, readFileSync(BLUE_MUG, 'utf8'));
    const report = join(dir, 'stress.json');
    writeFileSync(report, (await assay(['stress', checks, '-r', shop('references/02-add-blue-mug'), '--json'])).stdout);
    await assay(['approve', checks, '--reviewer', 'a', '--stress', report]);
    const j = JSON.parse((await assay(['review', checks, '--stress', report, '--json'])).stdout);
    expect(j.stress).toMatchObject({ checkSet: { id: 'tiny-shop/add-blue-mug' }, approved: true, weak: [] });
    expect(j.stress.rates.variantsTotal).toBeGreaterThan(0);
  });

  test('verify --require-signed refuses the lock before it looks for a model key', async () => {
    const dir = tmp();
    const checks = join(dir, 'checks.json');
    writeFileSync(checks, readFileSync(TWO_MUGS, 'utf8'));
    await assay(['approve', checks, '--reviewer', 'bob']);
    await assay(['keygen', '--out', join(dir, 'k.pem')]);
    // This run abstains, so --escalate would need a model (and its key) first.
    const r = await assay(
      ['verify', checks, NEWSLETTER_RUN, '--escalate', '--require-signed', '--trusted-key', join(dir, 'k.pub.pem')],
      {},
    );
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('is locked by bob but not signed');
  });
});
