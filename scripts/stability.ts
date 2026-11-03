/**
 * Milestone 5 stability run: replays every scripted scenario live against each
 * simulated release of each example app (examples/<app>/releases.json) and judges
 * it with check sets written for version 1. Releases build on each other:
 *
 *   v1  the app as recorded
 *   v2  copy: renamed labels, headings and buttons
 *   v3  layout: wrappers, look-alike content outside the main region, other date format
 *   v4  api: every API record gains fields
 *   v5  regression: a real bug, so the correct runs of one task per app now fail
 *
 * plus "regression only": the v5 bug on top of v1, so whether the checks catch it
 * does not depend on an unrelated UI change breaking an anchor first.
 *
 * Each run is correct (the expected verdict for that version), abstain (escalates:
 * safe), broken (a wrong decided verdict: the failure that must not happen), or
 * agent-error (the scripted agent could not finish on that UI: nothing was judged).
 * Exits with 1 if any run is broken.
 *
 *   node scripts/stability.ts [--checks handwritten|compiled] [--variants v1,v2,v3,v4,v5,regression] [--out stability/results]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluate, type CheckSet } from '../src/index.ts';
import { APPS, expectedIn, latestVersion, regressions, upTo, type AppDef } from '../examples/apps.ts';
import { startApp } from './app-runner.ts';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : dflt;
};
const CHECKS = arg('checks', 'handwritten');
const latest = Math.max(...APPS.map(latestVersion));
/** A UI variant: a label and the releases it applies to each app. */
interface Variant {
  label: string;
  title: string;
  releases(app: AppDef): number[];
}
const ALL: Variant[] = [
  ...Array.from({ length: latest }, (_, i): Variant => {
    const v = i + 1;
    return {
      label: `v${v}`,
      title:
        v === 1
          ? 'as recorded'
          : [...new Set(APPS.flatMap((a) => a.releases.filter((r) => r.version === v).map((r) => r.name)))].join(', '),
      releases: (app) => upTo(app, v),
    };
  }),
  { label: 'regression', title: 'regression only (on v1)', releases: regressions },
];
const wanted = arg('variants', ALL.map((v) => v.label).join(',')).split(',');
const VARIANTS = ALL.filter((v) => wanted.includes(v.label));
const out = pathToFileURL(resolve(process.cwd(), arg('out', 'stability/results')) + '/');

type Outcome = 'correct' | 'abstain' | 'broken' | 'agent-error';
const OUTCOMES: Outcome[] = ['correct', 'abstain', 'broken', 'agent-error'];
interface Row {
  variant: string;
  app: string;
  task: string;
  scenario: string;
  expected: 'success' | 'fail';
  verdict: string;
  outcome: Outcome;
  drift: number;
  /** True when a regression in this version flipped the expected verdict. */
  regressed: boolean;
}
const rows: Row[] = [];
// A scripted agent step that fails must be recorded, not crash the run.
process.on('unhandledRejection', (e) =>
  console.warn(`unhandled: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`),
);
const firstLine = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0]! : String(e));

/** Tasks whose check set is missing in the chosen mode (they were not run). */
const missing = new Set<string>();
for (const [slot, variant] of VARIANTS.entries()) {
  for (const app of APPS) {
    const releases = variant.releases(app);
    const runner = await startApp(app, { releases, slot });
    try {
      for (const t of app.tasks) {
        const file = new URL(
          CHECKS === 'compiled' ? `compiled/${t.id}.checks.json` : `tasks/${t.id}.checks.json`,
          app.dir,
        );
        if (!existsSync(file)) {
          missing.add(`${app.name}/${t.id}`);
          continue;
        }
        const cs = JSON.parse(readFileSync(file, 'utf8')) as CheckSet;
        for (const s of t.scenarios) {
          const expected = expectedIn(app, releases, t.id, s.expected);
          let verdict: string;
          let drift = 0;
          let outcome: Outcome;
          try {
            const o = evaluate(cs, await runner.capture(s));
            verdict = o.verdict;
            drift = o.drift.length;
            outcome =
              verdict === 'abstain'
                ? 'abstain'
                : (verdict === 'success') === (expected === 'success')
                  ? 'correct'
                  : 'broken';
          } catch (e) {
            verdict = `agent-error: ${firstLine(e)}`;
            outcome = 'agent-error';
          }
          rows.push({
            variant: variant.label,
            app: app.name,
            task: t.id,
            scenario: s.name,
            expected,
            verdict,
            outcome,
            drift,
            regressed: expected !== s.expected,
          });
        }
      }
    } finally {
      await runner.close();
    }
    console.warn(`${variant.label}/${app.name} done`);
  }
}

// --- report ----------------------------------------------------------------------

const of = (pred: (r: Row) => boolean) => rows.filter(pred);
const n = (pred: (r: Row) => boolean) => of(pred).length;
const tasks = [...new Set(rows.map((r) => `${r.app}/${r.task}`))];
const cell = (v: string, k: string) => {
  const rs = of((r) => r.variant === v && `${r.app}/${r.task}` === k);
  if (!rs.length) return '';
  const bad = OUTCOMES.slice(1)
    .map((o) => [o, rs.filter((r) => r.outcome === o).length] as const)
    .filter(([, c]) => c)
    .map(([o, c]) => `${c} ${o}`);
  return `${rs.filter((r) => r.outcome === 'correct').length}/${rs.length}${bad.length ? ` (${bad.join(', ')})` : ''}`;
};

const lines = [
  '# Stability run',
  '',
  `Generated ${new Date().toISOString()} · check sets: **${CHECKS}** (written for v1) · ${n((r) => r.variant === VARIANTS[0]?.label)} scenarios per variant.`,
  '',
  'Correct = the expected verdict for that version. Abstain = the checks could not decide and would escalate (safe). Broken = a wrong decided verdict. Agent error = the scripted agent could not finish on that UI, so nothing was judged.',
  '',
  '| Variant | Releases | Correct | Abstain | Broken | Agent error | Runs with anchor drift | Regression runs caught |',
  '|---|---|---|---|---|---|---|---|',
  ...VARIANTS.map(({ label: v, title }) => {
    const at = (r: Row) => r.variant === v;
    const reg = of((r) => at(r) && r.regressed);
    return `| ${v} | ${title} | ${n((r) => at(r) && r.outcome === 'correct')}/${n(at)} | ${n((r) => at(r) && r.outcome === 'abstain')} | ${n((r) => at(r) && r.outcome === 'broken')} | ${n((r) => at(r) && r.outcome === 'agent-error')} | ${n((r) => at(r) && r.drift > 0)} | ${reg.length ? `${reg.filter((r) => r.outcome === 'correct').length}/${reg.length}` : '–'} |`;
  }),
  '',
  '## Releases',
  '',
  ...APPS.flatMap((a) => [
    `- **${a.name}**: ${a.releases.map((r) => `v${r.version} ${r.name}: ${r.summary}`).join(' ')}`,
  ]),
  '',
  '## Per task',
  '',
  `| Task | ${VARIANTS.map((v) => v.label).join(' | ')} |`,
  `|---|${VARIANTS.map(() => '---').join('|')}|`,
  ...tasks.map((k) => `| ${k} | ${VARIANTS.map((v) => cell(v.label, k)).join(' | ')} |`),
  '',
  ...(rows.some((r) => r.outcome !== 'correct')
    ? [
        '## Not correct',
        '',
        ...of((r) => r.outcome !== 'correct').map(
          (r) =>
            `- ${r.variant} ${r.app}/${r.task}/${r.scenario}: expected ${r.expected}${r.regressed ? ' (regression)' : ''}, got ${r.verdict}`,
        ),
      ]
    : []),
  '',
];
mkdirSync(out, { recursive: true });
writeFileSync(new URL('REPORT.md', out), lines.join('\n'));
writeFileSync(
  new URL('results.json', out),
  JSON.stringify(
    { generatedAt: new Date().toISOString(), checks: CHECKS, variants: VARIANTS.map((v) => v.label), rows },
    null,
    1,
  ) + '\n',
);
console.warn(lines.slice(0, 15).join('\n'));
if (rows.length === 0) {
  console.error(`No scenarios with ${CHECKS} check sets: nothing was run.`);
  process.exitCode = 1;
} else if (rows.some((r) => r.outcome === 'broken')) {
  console.error('Some runs got a wrong decided verdict (broken).');
  process.exitCode = 1;
}
// Unjudged runs are unmeasured, not passing: a regression there would go unnoticed.
if (missing.size) {
  console.error(`No ${CHECKS} check set for: ${[...missing].join(', ')}. These tasks were not run.`);
  process.exitCode = 1;
}
if (rows.some((r) => r.outcome === 'agent-error')) {
  console.error('Some runs could not finish, so nothing was judged (agent-error).');
  process.exitCode = 1;
}
