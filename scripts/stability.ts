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
 * Each run is correct (the expected verdict for that version), abstain (escalates:
 * safe), broken (a wrong decided verdict: the failure that must not happen), or
 * agent-error (the scripted agent could not finish on that UI: nothing was judged).
 * Exits with 1 if any run is broken.
 *
 *   node scripts/stability.ts [--checks handwritten|compiled] [--versions 1,2,3,4,5] [--out stability/results]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { evaluate, type CheckSet } from '../src/index.ts';
import { APPS, expectedIn, latestVersion } from '../examples/apps.ts';
import { startApp } from './app-runner.ts';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : dflt;
};
const CHECKS = arg('checks', 'handwritten');
const latest = Math.max(...APPS.map(latestVersion));
const VERSIONS = arg('versions', Array.from({ length: latest }, (_, i) => i + 1).join(','))
  .split(',')
  .map(Number);
const out = new URL(`../${arg('out', 'stability/results')}/`, import.meta.url);

type Outcome = 'correct' | 'abstain' | 'broken' | 'agent-error';
const OUTCOMES: Outcome[] = ['correct', 'abstain', 'broken', 'agent-error'];
interface Row {
  version: number;
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

for (const version of VERSIONS) {
  for (const app of APPS) {
    if (version > latestVersion(app)) continue;
    const runner = await startApp(app, { version });
    try {
      for (const t of app.tasks) {
        const file = new URL(
          CHECKS === 'compiled' ? `compiled/${t.id}.checks.json` : `tasks/${t.id}.checks.json`,
          app.dir,
        );
        if (!existsSync(file)) continue;
        const cs = JSON.parse(readFileSync(file, 'utf8')) as CheckSet;
        for (const s of t.scenarios) {
          const expected = expectedIn(app, version, t.id, s.expected);
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
            version,
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
    console.warn(`v${version}/${app.name} done`);
  }
}

// --- report ----------------------------------------------------------------------

const of = (pred: (r: Row) => boolean) => rows.filter(pred);
const n = (pred: (r: Row) => boolean) => of(pred).length;
const releaseNames = (v: number) =>
  v === 1
    ? 'as recorded'
    : [...new Set(APPS.flatMap((a) => a.releases.filter((r) => r.version === v).map((r) => r.name)))].join(', ');
const tasks = [...new Set(rows.map((r) => `${r.app}/${r.task}`))];
const cell = (v: number, k: string) => {
  const rs = of((r) => r.version === v && `${r.app}/${r.task}` === k);
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
  `Generated ${new Date().toISOString()} · check sets: **${CHECKS}** (written for v1) · ${n((r) => r.version === VERSIONS[0])} scenarios per version.`,
  '',
  'Correct = the expected verdict for that version. Abstain = the checks could not decide and would escalate (safe). Broken = a wrong decided verdict. Agent error = the scripted agent could not finish on that UI, so nothing was judged.',
  '',
  '| Version | Release | Correct | Abstain | Broken | Agent error | Runs with anchor drift | Regression runs caught |',
  '|---|---|---|---|---|---|---|---|',
  ...VERSIONS.map((v) => {
    const at = (r: Row) => r.version === v;
    const reg = of((r) => at(r) && r.regressed);
    return `| v${v} | ${releaseNames(v)} | ${n((r) => at(r) && r.outcome === 'correct')}/${n(at)} | ${n((r) => at(r) && r.outcome === 'abstain')} | ${n((r) => at(r) && r.outcome === 'broken')} | ${n((r) => at(r) && r.outcome === 'agent-error')} | ${n((r) => at(r) && r.drift > 0)} | ${reg.length ? `${reg.filter((r) => r.outcome === 'correct').length}/${reg.length}` : '–'} |`;
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
  `| Task | ${VERSIONS.map((v) => `v${v}`).join(' | ')} |`,
  `|---|${VERSIONS.map(() => '---').join('|')}|`,
  ...tasks.map((k) => `| ${k} | ${VERSIONS.map((v) => cell(v, k)).join(' | ')} |`),
  '',
  ...(rows.some((r) => r.outcome !== 'correct')
    ? [
        '## Not correct',
        '',
        ...of((r) => r.outcome !== 'correct').map(
          (r) =>
            `- v${r.version} ${r.app}/${r.task}/${r.scenario}: expected ${r.expected}${r.regressed ? ' (regression)' : ''}, got ${r.verdict}`,
        ),
      ]
    : []),
  '',
];
mkdirSync(out, { recursive: true });
writeFileSync(new URL('REPORT.md', out), lines.join('\n'));
writeFileSync(
  new URL('results.json', out),
  JSON.stringify({ generatedAt: new Date().toISOString(), checks: CHECKS, versions: VERSIONS, rows }, null, 1) + '\n',
);
console.warn(lines.slice(0, 15).join('\n'));
if (rows.length === 0) {
  console.error(`No scenarios with ${CHECKS} check sets: nothing was run.`);
  process.exitCode = 1;
} else if (rows.some((r) => r.outcome === 'broken')) {
  console.error('Some runs got a wrong decided verdict (broken).');
  process.exitCode = 1;
}
