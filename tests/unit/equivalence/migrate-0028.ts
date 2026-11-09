/**
 * Moves golden.json.gz across ADR 0028, and checks the move: a scoped or record `text` value is
 * read from the accessibility tree, so its evidence now says channel "a11y", trust "semantic"
 * (it said "text", "freetext"). Nothing else in any result may change.
 *
 *   node tests/unit/equivalence/migrate-0028.ts <checkout>
 *
 * `<checkout>` holds the `src/` of the evaluator before ADR 0028 (c5d6c30). For every case it
 *
 * 1. runs that evaluator and requires its result to be the golden one (the full JSON where the
 *    golden file keeps it, its digest otherwise), so the old result is known for every case,
 *    including those the golden file keeps only a digest of;
 * 2. applies the one expected change to that result: every evidence entry with channel "text",
 *    trust "freetext" and a locator `text of …` (what a scoped or record read says; a whole-document
 *    read says `document text`) becomes channel "a11y", trust "semantic";
 * 3. requires the transformed result to equal, byte for byte, what this checkout's `verify`
 *    returns, and writes that as the new golden entry.
 *
 * Stress reports carry no evidence: their golden digests must be unchanged. The script fails,
 * writing nothing, if any step does not hold. It prints how many cases and entries changed:
 * 28 of 5,869 verify cases, 42 evidence entries, all in the tiny-shop compiled 07-express-order
 * and 08-delivery-date sets. It has been run once, on the golden file before ADR 0028 (to check
 * it again: `git show c5d6c30:tests/unit/equivalence/golden.json.gz` over the file, then run it).
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { collectCases, digest, GOLDEN, normalize, type Golden } from './cases.ts';
import { verify } from '../../../src/index.ts';
import { stressTest } from '../../../src/stress/index.ts';
import type * as Index from '../../../src/index.ts';

const [root] = process.argv.slice(2);
if (!root) throw new Error('usage: migrate-0028.ts <checkout before ADR 0028>');
const old = (await import(`${resolve(root, 'src')}/index.ts`)) as typeof Index;

/** The expected change, in place (key order is kept). Returns the number of entries changed. */
function migrate(x: unknown): number {
  if (Array.isArray(x)) return x.reduce((n: number, y) => n + migrate(y), 0);
  if (!x || typeof x !== 'object') return 0;
  const o = x as Record<string, unknown>;
  if (
    o.channel === 'text' &&
    o.trust === 'freetext' &&
    typeof o.locator === 'string' &&
    o.locator.startsWith('text of ')
  ) {
    o.channel = 'a11y';
    o.trust = 'semantic';
    return 1;
  }
  return Object.values(o).reduce((n: number, y) => n + migrate(y), 0);
}

async function run(v: typeof verify, cs: unknown, snapshot: unknown): Promise<unknown> {
  try {
    return normalize(await v(cs, snapshot as never));
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const golden = JSON.parse(gunzipSync(readFileSync(GOLDEN)).toString('utf8')) as Golden;
const cases = collectCases();
const next: Golden = { commit: golden.commit, verify: {}, stress: {} };
const problems: string[] = [];
let casesChanged = 0;
let entries = 0;
for (const c of cases.verify) {
  const want = golden.verify[c.id];
  if (!want) {
    problems.push(`${c.id}: no golden result`);
    continue;
  }
  const before = await run(old.verify, structuredClone(c.checkSet), structuredClone(c.snapshot));
  const beforeJson = JSON.stringify(before);
  if (digest(before) !== want.digest || (want.json !== undefined && beforeJson !== want.json)) {
    problems.push(`${c.id}: the checkout's evaluator does not reproduce the golden result`);
    continue;
  }
  const n = migrate(before);
  const json = JSON.stringify(before);
  const after = JSON.stringify(await run(verify, structuredClone(c.checkSet), structuredClone(c.snapshot)));
  if (after !== json) {
    problems.push(`${c.id}: the result differs from the golden one in more than the expected evidence fields`);
    continue;
  }
  if (n > 0) casesChanged++;
  entries += n;
  next.verify[c.id] = { ...(want.json !== undefined ? { json } : {}), digest: digest(before) };
}
for (const s of cases.stress) {
  const d = digest(stressTest(s.checkSet, s.refs, { skipVariants: s.skipVariants }));
  if (d !== golden.stress[s.id]) problems.push(`stress ${s.id}: the report changed`);
  next.stress[s.id] = d;
}
if (Object.keys(next.verify).length !== Object.keys(golden.verify).length)
  problems.push('the golden file has results for cases that no longer exist');
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
writeFileSync(GOLDEN, gzipSync(JSON.stringify(next), { level: 9 }));
console.warn(
  `${cases.verify.length} verify cases: ${casesChanged} changed, in ${entries} evidence entries (channel text → a11y, trust freetext → semantic); ${cases.stress.length} stress reports unchanged → ${GOLDEN.pathname}`,
);
