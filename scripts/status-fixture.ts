/**
 * Builds the `assay status` fixture (ADR 0022) in examples/status/: twelve tasks made from the
 * tiny-shop examples, each stopped at a different rung of the readiness ladder, and the
 * expected table (STATUS.txt), which tests/unit/status.spec.ts compares byte for byte.
 *
 *   node scripts/status-fixture.ts
 *
 * The signing keys are new each time (only alice's public key is kept), so a rebuild changes
 * the locks and the untrusted key id in STATUS.txt; nothing else changes.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { approveCheckSet, generateSigningKey, type CheckSet, type Requirement } from '../src/index.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const shop = (p: string) => `${root}examples/tiny-shop/${p}`;
const out = (p: string) => `${root}examples/status/${p}`;
const json = (x: unknown) => JSON.stringify(x, null, 2) + '\n';
const read = <T = CheckSet>(p: string) => JSON.parse(readFileSync(p, 'utf8')) as T;
const task = (name: string) => read(shop(`tasks/${name}.checks.json`));

for (const d of ['tasks', 'keys', 'runs', 'snapshots']) rmSync(out(d), { recursive: true, force: true });
for (const d of ['tasks', 'keys']) mkdirSync(out(d), { recursive: true });

const alice = generateSigningKey();
const mallory = generateSigningKey();
writeFileSync(out('keys/alice.pub.pem'), alice.publicKey);
const at = '2026-11-09T09:00:00.000Z';
const approve = (cs: CheckSet, key = alice.privateKey, by = 'alice') => approveCheckSet(cs, { by, at, key });
const write = (name: string, cs: unknown) => writeFileSync(out(`tasks/${name}.checks.json`), json(cs));

// valid ✘: a requirement quotes text that is not in the task.
{
  const cs = task('01-newsletter');
  cs.requirements[0]!.source.quote = 'the newsletter subscription is confirmed';
  write('01-newsletter', cs);
}

// covered ✘: a hard requirement without a check.
{
  const cs = task('02-add-blue-mug');
  const r: Requirement = {
    id: 'R2',
    kind: 'hard',
    text: 'Only a Blue Mug is added',
    source: { field: 'instruction', quote: 'Add a Blue Mug' },
  };
  cs.requirements.push(r);
  write('02-add-blue-mug', cs);
}

// covered ✘: a hard requirement checked only by free page text.
{
  const cs = task('03-cart-two-mugs');
  cs.checks[1] = {
    id: 'C2',
    requirement: 'R2',
    description: "The page text mentions a 'Red Mug'.",
    assert: { kind: 'value', source: { from: 'text', pattern: 'Red Mug' }, expect: { equals: 'Red Mug' } },
  };
  write('03-cart-two-mugs', cs);
}

// locked ✘: never approved.
write('04-remove-red-mug', task('04-remove-red-mug'));

// locked ✘: edited after alice approved it.
{
  const locked = approve(task('05-set-quantity'));
  locked.checks[0]!.description += ' (edited)';
  write('05-set-quantity', locked);
}

// locked ✘: signed with a key that is not trusted.
write('06-cart-total', approve(task('06-cart-total'), mallory.privateKey, 'mallory'));

// stress ✘: the order request may carry no field but the three it has today, so the
// extra-json-fields variant (a correct run with one more field) is rejected.
{
  const cs = task('07-express-order');
  const c1 = cs.checks[0]!.assert as unknown as { match: Record<string, unknown> };
  c1.match.requestBody = {
    type: 'object',
    additionalProperties: false,
    properties: { name: {}, shipping: {}, giftWrap: {} },
  };
  write('07-express-order', approve(cs));
}

// The labelled runs of the tasks that are or could be locked: tiny-shop's, copied into runs/<task>/
// (a references/ directory here would make examples/status look like an example app to scripts/bench.ts).
for (const name of [
  '05-set-quantity',
  '06-cart-total',
  '07-express-order',
  '08-delivery-date',
  '09-gift-wrap',
  '10-dark-german',
])
  cpSync(shop(`references/${name}`), out(`runs/${name}`), { recursive: true });

// references ✘: a run of a standard-shipping order, labelled correct by mistake.
{
  write('08-delivery-date', approve(task('08-delivery-date')));
  const run = read<{ label: Record<string, unknown> }>(shop('references/08-delivery-date/standard-order.json'));
  writeFileSync(
    out('runs/08-delivery-date/standard-order-mislabelled.json'),
    json({ ...run, label: { ...run.label, expected: 'success', kind: 'correct' } }),
  );
}

/** Recent runs: snapshots captured at the given times, unlabelled, as `assay capture` writes them. */
function recent(name: string, runs: [from: string, capturedAt: string][]) {
  mkdirSync(out(`snapshots/${name}`), { recursive: true });
  for (const [from, capturedAt] of runs) {
    const { snapshot } = read<{ snapshot: Record<string, unknown> }>(shop(`references/${name}/${from}.json`));
    const file = `localhost-${capturedAt.replace(/[:.]/g, '-')}.json`;
    writeFileSync(out(`snapshots/${name}/${file}`), json({ ...snapshot, capturedAt }));
  }
}

// recent ✘: the newest of three recent runs was not gift wrapped.
write('09-gift-wrap', approve(task('09-gift-wrap')));
recent('09-gift-wrap', [
  ['gift-wrapped', '2026-11-07T10:00:00.000Z'],
  ['gift-wrapped-express', '2026-11-08T10:00:00.000Z'],
  ['not-gift-wrapped', '2026-11-09T10:00:00.000Z'],
]);

// ready: every stage passes.
write('10-dark-german', approve(task('10-dark-german')));
recent('10-dark-german', [
  ['dark-and-german', '2026-11-08T10:00:00.000Z'],
  ['german-then-dark', '2026-11-09T10:00:00.000Z'],
]);

// locked ✘: locked by bob, but not signed, and keys are trusted.
{
  const cs = { ...task('02-add-blue-mug'), id: 'tiny-shop/unsigned' };
  write('11-unsigned', approveCheckSet(cs, { by: 'bob', at }));
}

// stress ✘: approved, but there is no run to test it on.
write('12-no-references', approve({ ...task('02-add-blue-mug'), id: 'tiny-shop/no-references' }));

const table = execFileSync(
  process.execPath,
  [`${root}src/cli/index.ts`, 'status', '--no-color', '-c', out('assay.config.ts')],
  { cwd: root, encoding: 'utf8' },
);
writeFileSync(out('STATUS.txt'), table);
process.stdout.write(table);
