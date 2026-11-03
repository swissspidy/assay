/**
 * Milestone 3: stress-test Tiny Shop check sets (handwritten, plus compiled
 * ones if present) against variants and mutants of every correct reference run.
 *
 *   node scripts/stress-tiny-shop.ts [handwritten|compiled]
 *
 * Writes examples/tiny-shop/stress/<set>/REPORT.md and report.json.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { formatStressReport, stressTest, type CheckSet, type StressReport } from '../src/index.ts';
import { TASKS } from '../examples/tiny-shop/scenarios.ts';

const root = new URL('../examples/tiny-shop/', import.meta.url);
const which = process.argv[2] ?? 'handwritten';
const setDir = new URL(which === 'compiled' ? 'compiled/' : 'tasks/', root);
const out = new URL(`stress/${which}/`, root);
mkdirSync(out, { recursive: true });

const reports: StressReport[] = [];
for (const def of TASKS) {
  const f = new URL(`${def.id}.checks.json`, setDir);
  if (!existsSync(f)) continue;
  const cs = JSON.parse(readFileSync(f, 'utf8')) as CheckSet;
  const refDir = new URL(`references/${def.id}/`, root);
  const refs = readdirSync(refDir)
    .map((name) => ({ name: name.replace(/\.json$/, ''), ...JSON.parse(readFileSync(new URL(name, refDir), 'utf8')) }))
    .filter((r) => r.label.expected === 'success')
    .map((r) => ({ name: r.name as string, snapshot: r.snapshot }));
  reports.push(stressTest(cs, refs, { skipVariants: def.skipVariants ?? [] }));
}

const sum = (k: keyof StressReport['rates']) => reports.reduce((a, r) => a + r.rates[k], 0);
const md = [
  `# Stress test: ${which} Tiny Shop checks`,
  '',
  '| Task | Variants accepted | Mutants rejected (fail / abstain) | Over-constrained | Weak | Missed |',
  '|---|---|---|---|---|---|',
  ...reports.map(
    (r) =>
      `| ${r.checkSet.id} | ${r.rates.variantsAccepted}/${r.rates.variantsTotal} | ${r.rates.mutantsRejected}/${r.rates.mutantsTotal} (${r.rates.mutantsRejectedByFail} / ${r.rates.mutantsRejectedByAbstain}) | ${r.overConstrained.map((o) => o.check).join(', ') || '–'} | ${r.weak.map((o) => o.check).join(', ') || '–'} | ${r.missed.length} |`,
  ),
  `| **Total** | **${sum('variantsAccepted')}/${sum('variantsTotal')}** | **${sum('mutantsRejected')}/${sum('mutantsTotal')}** (${sum('mutantsRejectedByFail')} / ${sum('mutantsRejectedByAbstain')}) | | | |`,
  '',
  ...reports.map(formatStressReport),
  '',
].join('\n');
writeFileSync(new URL('REPORT.md', out), md);
writeFileSync(new URL('report.json', out), JSON.stringify(reports, null, 1) + '\n');
console.warn(
  md
    .split('\n')
    .slice(0, reports.length + 6)
    .join('\n'),
);
