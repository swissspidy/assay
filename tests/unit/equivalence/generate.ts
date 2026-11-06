/**
 * Writes golden.json.gz: what `verify` and `stressTest` return for every equivalence case.
 *
 *   node tests/unit/equivalence/generate.ts <checkout> <commit>
 *
 * `<checkout>` is a directory holding the `src/` of the evaluator to record (the golden file
 * was written from the commit before ADR 0015); run it again only when an evaluation result
 * is meant to change, and say so in the pull request.
 */
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { collectCases, digest, GOLDEN, normalize, type Golden } from './cases.ts';
import type * as Index from '../../../src/index.ts';
import type * as Stress from '../../../src/stress/index.ts';

const [root, commit] = process.argv.slice(2);
if (!root || !commit) throw new Error('usage: generate.ts <checkout> <commit>');
const src = resolve(root, 'src');
const { verify } = (await import(`${src}/index.ts`)) as typeof Index;
const { stressTest } = (await import(`${src}/stress/index.ts`)) as typeof Stress;

const cases = collectCases();
const golden: Golden = { commit, verify: {}, stress: {} };
for (const c of cases.verify) {
  let result: unknown;
  try {
    result = normalize(await verify(c.checkSet, c.snapshot));
  } catch (e) {
    result = { error: e instanceof Error ? e.message : String(e) };
  }
  const json = JSON.stringify(result);
  golden.verify[c.id] = { ...(c.own ? { json } : {}), digest: digest(result) };
}
for (const s of cases.stress)
  golden.stress[s.id] = digest(stressTest(s.checkSet, s.refs, { skipVariants: s.skipVariants }));
writeFileSync(GOLDEN, gzipSync(JSON.stringify(golden), { level: 9 }));
console.warn(`${cases.verify.length} verify cases, ${cases.stress.length} stress cases → ${GOLDEN.pathname}`);
