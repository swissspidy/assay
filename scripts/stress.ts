/**
 * Milestone 3: stress-test the example apps' check sets (handwritten, or compiled
 * ones if present) against variants and mutants of every correct reference run.
 *
 *   node scripts/stress.ts [handwritten|compiled]
 *
 * Writes examples/<app>/stress/<set>/REPORT.md and report.json, and a combined summary.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { CheckSet } from '../src/index.ts';
import { formatStressReport, stressTest, type StressReport } from '../src/stress/index.ts';
import { APPS } from '../examples/apps.ts';

const which = process.argv[2] ?? 'handwritten';
const summary: string[] = [];
const sum = (rs: StressReport[], k: keyof StressReport['rates']) => rs.reduce((a, r) => a + r.rates[k], 0);

for (const app of APPS) {
  const setDir = new URL(which === 'compiled' ? 'compiled/' : 'tasks/', app.dir);
  const out = new URL(`stress/${which}/`, app.dir);
  const reports: StressReport[] = [];
  for (const def of app.tasks) {
    const f = new URL(`${def.id}.checks.json`, setDir);
    if (!existsSync(f)) continue;
    const cs = JSON.parse(readFileSync(f, 'utf8')) as CheckSet;
    const refDir = new URL(`references/${def.id}/`, app.dir);
    const refs = readdirSync(refDir)
      .toSorted()
      .map((name) => ({
        name: name.replace(/\.json$/, ''),
        ...JSON.parse(readFileSync(new URL(name, refDir), 'utf8')),
      }))
      .filter((r) => r.label.expected === 'success')
      .map((r) => ({ name: r.name as string, snapshot: r.snapshot }));
    reports.push(stressTest(cs, refs, { skipVariants: def.skipVariants ?? [] }));
  }
  if (!reports.length) continue;
  const rows = reports.map(
    (r) =>
      `| ${r.checkSet.id} | ${r.rates.variantsAccepted}/${r.rates.variantsTotal} | ${r.rates.mutantsRejected}/${r.rates.mutantsTotal} (${r.rates.mutantsRejectedByFail} / ${r.rates.mutantsRejectedByAbstain}) | ${r.overConstrained.map((o) => o.check).join(', ') || '–'} | ${r.weak.map((o) => o.check).join(', ') || '–'} | ${r.missed.length} |`,
  );
  const total = `| **${app.name}** | **${sum(reports, 'variantsAccepted')}/${sum(reports, 'variantsTotal')}** | **${sum(reports, 'mutantsRejected')}/${sum(reports, 'mutantsTotal')}** (${sum(reports, 'mutantsRejectedByFail')} / ${sum(reports, 'mutantsRejectedByAbstain')}) | | | ${reports.reduce((a, r) => a + r.missed.length, 0)} |`;
  const head = [
    '| Task | Variants accepted | Mutants rejected (fail / abstain) | Over-constrained | Weak | Missed |',
    '|---|---|---|---|---|---|',
  ];
  mkdirSync(out, { recursive: true });
  writeFileSync(
    new URL('REPORT.md', out),
    [
      `# Stress test: ${which} ${app.name} checks`,
      '',
      ...head,
      ...rows,
      total,
      '',
      ...reports.map(formatStressReport),
      '',
    ].join('\n'),
  );
  writeFileSync(new URL('report.json', out), JSON.stringify(reports, null, 1) + '\n');
  summary.push(total);
}
console.warn(
  [
    '| App | Variants accepted | Mutants rejected (fail / abstain) | | | Missed |',
    '|---|---|---|---|---|---|',
    ...summary,
  ].join('\n'),
);
