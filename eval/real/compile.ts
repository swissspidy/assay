/**
 * Compiles every real-app task from its instruction and ONE correct run (the scripted
 * reference), stress-tests the result, and judges the held-out runs with it.
 *
 *   node eval/real/compile.ts [app] [taskId...]
 *
 * Writes eval/real/compiled/<app>/<task>.{checks,report,cassette}.json and
 * eval/results/real/COMPILE.md. Replays the committed cassettes; a missing one is
 * recorded live when ANTHROPIC_API_KEY is set (ASSAY_MODEL_MODE as in scripts/).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { evaluate, type CheckSet } from '../../src/index.ts';
import { compileTask } from '../../src/compiler/index.ts';
import { stressTest } from '../../src/stress/index.ts';
import { costUsd, PRICING } from '../../src/eval/metrics.ts';
import { modelFromEnv } from '../../scripts/model-from-env.ts';
import { APPS } from './apps.ts';
import { compiledFile, readRun, realRuns, REAL_ROOT, TRAINING_RUN } from './dataset.ts';

const ALIAS: Record<string, string> = { forge: 'gitea', cms: 'wordpress', shop: 'prestashop' };
const [onlyApp, ...onlyTasks] = process.argv.slice(2);

interface Row {
  app: string;
  task: string;
  status: string;
  requirements?: number;
  checks?: number;
  channels?: string;
  stress?: string;
  heldOut?: string;
  wrong?: string[];
  costUsd?: number;
  note?: string;
}

const rows: Row[] = [];
let failures = 0;
for (const app of APPS) {
  if (onlyApp && app.name !== (ALIAS[onlyApp] ?? onlyApp)) continue;
  mkdirSync(new URL(`compiled/${app.name}/`, REAL_ROOT), { recursive: true });
  for (const t of app.tasks) {
    if (onlyTasks.length && !onlyTasks.some((x) => t.id === x || t.id.startsWith(`${x}-`))) continue;
    const row: Row = { app: app.name, task: t.id, status: 'not compiled' };
    rows.push(row);
    rmSync(compiledFile(app.name, t.id, 'checks'), { force: true });
    try {
      const ref = readRun(app.name, t.id, TRAINING_RUN);
      if (ref.label.expected !== 'success') throw new Error('the reference run is not labelled correct');
      const env = await modelFromEnv(compiledFile(app.name, t.id, 'cassette').pathname);
      const { checkSet, report } = await compileTask(
        {
          id: `${app.name}/${t.id}`,
          instruction: t.instruction,
          ...(t.skipVariants?.length ? { skipVariants: t.skipVariants } : {}),
        },
        [{ name: TRAINING_RUN, kind: 'success', snapshot: ref.snapshot }],
        { model: env.model, provenance: env.provenance, log: (m) => console.warn(`${t.id}: ${m}`) },
      );
      env.save();
      writeFileSync(compiledFile(app.name, t.id, 'report'), JSON.stringify(report, null, 2) + '\n');
      row.costUsd = costUsd(report.usage, PRICING[report.model.replace(/^anthropic:/, '').replace(/@.*$/, '')]);
      if (!checkSet) {
        failures++;
        row.note = report.reason ?? 'failed';
        continue;
      }
      writeFileSync(compiledFile(app.name, t.id, 'checks'), JSON.stringify(checkSet, null, 2) + '\n');
      row.status = 'compiled';
      row.requirements = checkSet.requirements.length;
      row.checks = checkSet.checks.length;
      row.channels = report.coverage.map((c) => `${c.requirement}:${c.channels.join('+')}`).join(', ');
      const s = stressTest(
        checkSet as CheckSet,
        [{ name: TRAINING_RUN, snapshot: ref.snapshot }],
        t.skipVariants?.length ? { skipVariants: t.skipVariants } : {},
      );
      const x = s.rates;
      row.stress = `${x.variantsAccepted}/${x.variantsTotal} valid, ${x.mutantsRejected}/${x.mutantsTotal} mutants${s.weak.length ? `; weak: ${s.weak.map((w) => w.check).join(', ')}` : ''}${s.untested.length ? `; untested: ${s.untested.join(', ')}` : ''}`;
      const heldOut = realRuns(app.name, t.id).filter((r) => r.name !== TRAINING_RUN);
      const wrong = heldOut.filter((r) => {
        const v = evaluate(checkSet, r.snapshot).verdict;
        return r.label.expected === 'success' ? v !== 'success' : v === 'success';
      });
      row.heldOut = `${heldOut.length - wrong.length}/${heldOut.length}`;
      row.wrong = wrong.map((w) => w.name);
      console.warn(`${t.id}: ${checkSet.checks.length} checks (${env.mode}); held-out ${row.heldOut}`);
    } catch (e) {
      failures++;
      row.note = e instanceof Error ? e.message : String(e);
      console.warn(`${t.id}: ${row.note}`);
    }
  }
}

if (!onlyApp) {
  const total = rows.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const md = [
    '# Compiled real-app check sets',
    '',
    'Each task was compiled from its instruction and one scripted correct run (`reference`); all other runs are held out. Stress: valid variants accepted and near-miss mutants rejected (ADR 0003) on the reference.',
    '',
    '| App | Task | Requirements | Checks | Evidence per requirement | Stress | Held-out runs correct | Compile cost |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((r) =>
      r.status === 'compiled'
        ? `| ${r.app} | ${r.task} | ${r.requirements} | ${r.checks} | ${r.channels} | ${r.stress} | ${r.heldOut}${r.wrong?.length ? ` (wrong: ${r.wrong.join(', ')})` : ''} | $${(r.costUsd ?? 0).toFixed(3)} |`
        : `| ${r.app} | ${r.task} | not compiled: ${(r.note ?? '').replace(/\|/g, '\\|').slice(0, 300)} | | | | | $${(r.costUsd ?? 0).toFixed(3)} |`,
    ),
    '',
    `Compiled ${rows.filter((r) => r.status === 'compiled').length}/${rows.length} tasks; model cost as recorded: $${total.toFixed(2)}.`,
    '',
  ].join('\n');
  mkdirSync(new URL('../results/real/', REAL_ROOT), { recursive: true });
  writeFileSync(new URL('../results/real/COMPILE.md', REAL_ROOT), md);
}
process.exitCode = failures ? 1 : 0;
