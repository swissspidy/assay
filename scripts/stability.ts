/**
 * Milestone 5 stability run: replays every scripted scenario live against each
 * app, in its normal UI and in its deliberately redesigned UI (renamed labels,
 * restructured markup, different date format), and evaluates the locked checks.
 * For each run: correct verdict, abstain (would escalate), or wrong verdict
 * ("broken"); plus anchors that drifted.
 *
 *   node scripts/stability.ts [--checks handwritten|compiled] [--out stability/results]
 *
 * Run weekly in CI (.github/workflows/stability.yml); results are uploaded as artifacts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { evaluate, type CheckSet } from '../src/index.ts';
import { APPS } from '../examples/apps.ts';
import { startApp } from './app-runner.ts';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : dflt;
};
const CHECKS = arg('checks', 'handwritten');
const out = new URL(`../${arg('out', 'stability/results')}/`, import.meta.url);

type Outcome = 'correct' | 'abstain' | 'broken';
interface Row {
  variant: 'baseline' | 'redesign';
  app: string;
  task: string;
  scenario: string;
  expected: 'success' | 'fail';
  verdict: string;
  outcome: Outcome;
  drift: number;
}
const rows: Row[] = [];
// A scripted agent step that fails must be recorded, not crash the run.
process.on('unhandledRejection', (e) =>
  console.warn(`unhandled: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`),
);

for (const variant of ['baseline', 'redesign'] as const) {
  for (const app of APPS) {
    const runner = await startApp(app, { variant });
    try {
      for (const t of app.tasks) {
        const file = new URL(
          CHECKS === 'compiled' ? `compiled/${t.id}.checks.json` : `tasks/${t.id}.checks.json`,
          app.dir,
        );
        if (!existsSync(file)) continue;
        const cs = JSON.parse(readFileSync(file, 'utf8')) as CheckSet;
        for (const s of t.scenarios) {
          let verdict: string;
          let drift = 0;
          try {
            const o = evaluate(cs, await runner.capture(s));
            verdict = o.verdict;
            drift = o.drift.length;
          } catch (e) {
            // The scripted agent itself could not complete its steps on this UI.
            verdict = `agent-error: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`;
          }
          const outcome: Outcome =
            verdict === 'abstain' || verdict.startsWith('agent-error')
              ? 'abstain'
              : (verdict === 'success') === (s.expected === 'success')
                ? 'correct'
                : 'broken';
          rows.push({
            variant,
            app: app.name,
            task: t.id,
            scenario: s.name,
            expected: s.expected,
            verdict,
            outcome,
            drift,
          });
        }
      }
    } finally {
      await runner.close();
    }
    console.warn(`${variant}/${app.name} done`);
  }
}

const count = (v: string, o: Outcome) => rows.filter((r) => r.variant === v && r.outcome === o).length;
const total = (v: string) => rows.filter((r) => r.variant === v).length;
const lines = [
  '# Stability run',
  '',
  `Generated ${new Date().toISOString()} · check sets: **${CHECKS}** · ${total('baseline')} scenarios per UI variant.`,
  '',
  '| UI variant | Correct verdict | Abstain (escalates) | Broken (wrong verdict) | Runs with anchor drift |',
  '|---|---|---|---|---|',
  ...(['baseline', 'redesign'] as const).map(
    (v) =>
      `| ${v} | ${count(v, 'correct')}/${total(v)} | ${count(v, 'abstain')} | ${count(v, 'broken')} | ${rows.filter((r) => r.variant === v && r.drift > 0).length} |`,
  ),
  '',
  '## Per task (redesign)',
  '',
  '| App | Task | Correct | Abstain | Broken | Drift |',
  '|---|---|---|---|---|---|',
  ...[...new Set(rows.map((r) => `${r.app}|${r.task}`))].map((k) => {
    const [a, t] = k.split('|');
    const rs = rows.filter((r) => r.variant === 'redesign' && r.app === a && r.task === t);
    return `| ${a} | ${t} | ${rs.filter((r) => r.outcome === 'correct').length}/${rs.length} | ${rs.filter((r) => r.outcome === 'abstain').length} | ${rs.filter((r) => r.outcome === 'broken').length} | ${rs.filter((r) => r.drift > 0).length} |`;
  }),
  '',
  ...(rows.some((r) => r.outcome !== 'correct')
    ? [
        '## Not correct',
        '',
        ...rows
          .filter((r) => r.outcome !== 'correct')
          .map((r) => `- ${r.variant} ${r.app}/${r.task}/${r.scenario}: expected ${r.expected}, got ${r.verdict}`),
      ]
    : []),
  '',
];
mkdirSync(out, { recursive: true });
writeFileSync(new URL('REPORT.md', out), lines.join('\n'));
writeFileSync(
  new URL('results.json', out),
  JSON.stringify({ generatedAt: new Date().toISOString(), checks: CHECKS, rows }, null, 1) + '\n',
);
console.warn(lines.slice(0, 10).join('\n'));
