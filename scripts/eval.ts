/**
 * Milestone 5 evaluation: compare verification systems on every labelled run of
 * the 30 example tasks (correct, wrong-item, partial, over-completion, no-op,
 * undone and adversarial runs).
 *
 *   node scripts/eval.ts [--systems checks,checks+escalation,llm-judge,agentic-verifier] [--checks handwritten|compiled]
 *
 * Model-based systems run live with ANTHROPIC_API_KEY (recording cassettes under
 * eval/cassettes/) and replay those cassettes without a key; a system without
 * recordings is reported as not measured.
 * Writes eval/results/REPORT.md and eval/results/results.json.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  costUsd,
  evaluate,
  llmJudge,
  metrics,
  PRICING,
  runVerifier,
  verifyWithEscalation,
  kleeneAnd,
  type CheckSet,
  type EvidenceSnapshot,
  type Metrics,
  type Prediction,
} from '../src/index.ts';
import { APPS } from '../examples/apps.ts';
import { modelFromEnv } from './model-from-env.ts';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : dflt;
};
const SYSTEMS = arg('systems', 'checks,checks+escalation,llm-judge,agentic-verifier').split(',');
const CHECKS = arg('checks', 'handwritten') as 'handwritten' | 'compiled';
const root = new URL('../eval/', import.meta.url);

interface Run {
  app: string;
  task: string;
  scenario: string;
  kind: string;
  expected: 'success' | 'fail';
  snapshot: EvidenceSnapshot;
  checks: CheckSet;
}

const runs: Run[] = [];
for (const app of APPS) {
  for (const t of app.tasks) {
    const csFile =
      CHECKS === 'compiled'
        ? new URL(`compiled/${t.id}.checks.json`, app.dir)
        : new URL(`tasks/${t.id}.checks.json`, app.dir);
    if (!existsSync(csFile)) continue;
    const checks = JSON.parse(readFileSync(csFile, 'utf8')) as CheckSet;
    const dir = new URL(`references/${t.id}/`, app.dir);
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith('.json'))
      .toSorted()) {
      const { label, snapshot } = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      runs.push({
        app: app.name,
        task: t.id,
        scenario: f.replace(/\.json$/, ''),
        kind: label.kind,
        expected: label.expected,
        snapshot,
        checks,
      });
    }
  }
}

const AGENT_REPORT = 'I completed the task as requested.';
const priceOf = (modelId: string) =>
  PRICING[
    modelId
      .replace(/^anthropic:/, '')
      .replace(/@.*$/, '')
      .replace(/ \(replay\)$/, '')
  ];

type Row = Prediction & { app: string; task: string; scenario: string; kind: string; note?: string };
const results: Record<string, { rows: Row[]; measured: boolean; reason?: string; model?: string }> = {};

async function modelRun(system: string, r: Run): Promise<{ row: Row; model: string } | null> {
  const cassette = new URL(`cassettes/${system}/${r.app}/${r.task}/${r.scenario}.json`, root).pathname;
  let env;
  try {
    env = await modelFromEnv(cassette);
  } catch {
    return null; // no key and no recording
  }
  const base = { app: r.app, task: r.task, scenario: r.scenario, kind: r.kind, expected: r.expected };
  const t0 = performance.now();
  let verdict: Row['verdict'] = 'abstain';
  let usage: Parameters<typeof costUsd>[0] = { inputTokens: 0, outputTokens: 0 };
  let note: string | undefined;
  try {
    if (system === 'llm-judge') {
      const j = await llmJudge(env.model, { task: r.checks.task, snapshot: r.snapshot, agentReport: AGENT_REPORT });
      verdict = j.verdict;
      usage = j.usage;
    } else if (system === 'agentic-verifier') {
      const v = await runVerifier(env.model, {
        task: r.checks.task,
        requirements: r.checks.requirements,
        snapshot: r.snapshot,
        agentReport: AGENT_REPORT,
      });
      const status = r.checks.requirements
        .filter((q) => q.kind === 'hard')
        .map((q) => {
          const s = v.verdicts.find((x) => x.requirement === q.id)?.status ?? 'unknown';
          return s === 'unknown' ? 'abstain' : s;
        });
      const k = kleeneAnd(status);
      verdict = k === 'pass' ? 'success' : k;
      usage = v.usage;
    } else {
      const res = await verifyWithEscalation(r.checks, r.snapshot, { verifier: env.model, agentReport: AGENT_REPORT });
      verdict = res.outcome.verdict;
      usage = res.verifier?.usage ?? { inputTokens: 0, outputTokens: 0 };
    }
  } catch (e) {
    // A failed model call is a real outcome of that system: count it as abstain.
    note = `model error: ${e instanceof Error ? e.message : String(e)}`;
  }
  const ms = performance.now() - t0;
  env.save();
  return {
    row: {
      ...base,
      verdict,
      ...(note ? { note } : {}),
      ms: env.mode === 'replay' ? NaN : ms,
      costUsd: costUsd(usage, priceOf(env.model.id)),
    },
    model: env.model.id,
  };
}

for (const system of SYSTEMS) {
  const rows: Row[] = [];
  let measured = true;
  let model: string | undefined;
  for (const r of runs) {
    if (system === 'checks') {
      const t0 = performance.now();
      const o = evaluate(r.checks, r.snapshot);
      rows.push({
        app: r.app,
        task: r.task,
        scenario: r.scenario,
        kind: r.kind,
        expected: r.expected,
        verdict: o.verdict,
        ms: performance.now() - t0,
        costUsd: 0,
      });
      continue;
    }
    // Escalation only costs something when the checks abstain.
    if (system === 'checks+escalation' && evaluate(r.checks, r.snapshot).verdict !== 'abstain') {
      const t0 = performance.now();
      const o = evaluate(r.checks, r.snapshot);
      rows.push({
        app: r.app,
        task: r.task,
        scenario: r.scenario,
        kind: r.kind,
        expected: r.expected,
        verdict: o.verdict,
        ms: performance.now() - t0,
        costUsd: 0,
      });
      continue;
    }
    const out = await modelRun(system, r);
    if (!out) {
      measured = false;
      break;
    }
    model = out.model;
    rows.push(out.row);
  }
  results[system] = measured
    ? { rows, measured, ...(model ? { model } : {}) }
    : { rows: [], measured, reason: 'no ANTHROPIC_API_KEY and no recorded cassettes' };
  console.warn(`${system}: ${measured ? `${rows.length} runs` : 'not measured'}`);
}

// --- report ----------------------------------------------------------------------

const fmt = (x: number, digits = 3) => (Number.isNaN(x) ? 'n/a' : x.toFixed(digits));
const ms = (x: number) =>
  Number.isNaN(x)
    ? 'n/a (replayed)'
    : x < 1
      ? `${(x * 1000).toFixed(0)} µs`
      : x < 1000
        ? `${x.toFixed(1)} ms`
        : `${(x / 1000).toFixed(1)} s`;
const table = (m: Record<string, Metrics | null>) => [
  '| System | Balanced accuracy | TPR | TNR | Abstain rate | Cost / run | Latency (median / p95) |',
  '|---|---|---|---|---|---|---|',
  ...Object.entries(m).map(([sys, x]) =>
    x
      ? `| ${sys} | ${fmt(x.balancedAccuracy)} | ${fmt(x.tpr)} | ${fmt(x.tnr)} | ${fmt(x.abstainRate)} | $${fmt(x.costUsdPerRun, 4)} | ${ms(x.msPerRunMedian)} / ${ms(x.msPerRunP95)} |`
      : `| ${sys} | not measured | | | | | |`,
  ),
];
const all = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.measured ? metrics(v.rows) : null]));
const kinds = [...new Set(runs.map((r) => r.kind))];
const byKind = kinds.map((k) => {
  const cells = Object.entries(results).map(([, v]) => {
    if (!v.measured) return 'n/a';
    const rows = v.rows.filter((r) => r.kind === k);
    const correct = rows.filter((r) =>
      r.expected === 'success' ? r.verdict === 'success' : r.verdict !== 'success',
    ).length;
    return `${correct}/${rows.length}`;
  });
  return `| ${k} | ${runs.filter((r) => r.kind === k).length} | ${cells.join(' | ')} |`;
});
const wrong = (results.checks?.rows ?? []).filter((r) =>
  r.expected === 'success' ? r.verdict !== 'success' : r.verdict === 'success',
);
const md = [
  '# Evaluation: compiled checks vs. LLM judge vs. agentic verifier',
  '',
  `Generated ${new Date().toISOString()} · check sets: **${CHECKS}** · ${runs.length} labelled runs over ${new Set(runs.map((r) => `${r.app}/${r.task}`)).size} tasks (${runs.filter((r) => r.expected === 'success').length} correct, ${runs.filter((r) => r.expected === 'fail').length} incorrect) in ${APPS.length} apps.`,
  '',
  'Positive = the run really completed the task. TPR = correct runs judged success; TNR = incorrect runs judged not success (an abstain counts as not success). The agent always reports success, as agents usually do.',
  '',
  ...table(all),
  '',
  '## Correct verdicts by run kind',
  '',
  `| Kind | Runs | ${Object.keys(results).join(' | ')} |`,
  `|---|---|${Object.keys(results)
    .map(() => '---')
    .join('|')}|`,
  ...byKind,
  '',
  '## Notes',
  '',
  ...Object.entries(results)
    .filter(([, v]) => !v.measured)
    .map(([k, v]) => `- **${k}**: not measured (${v.reason}).`),
  ...Object.entries(results)
    .filter(([, v]) => v.model)
    .map(([k, v]) => `- **${k}** used ${v.model}.`),
  CHECKS === 'handwritten'
    ? `- **Caveat:** these are the handwritten check sets, written by the same author as the labelled runs, so the checks rows are an upper bound and partly circular. The real measure is \`--checks compiled\` (checks compiled by the model from one correct run per task; all other runs held out).`
    : `- Compiled check sets: each was compiled from one correct run per task; all other runs are held out.`,
  `- Model latency is only measured when recording; replayed runs show none.`,
  `- Checks-only latency is in-process evaluation of a captured snapshot (no model). Capture itself takes about 20-60 ms per page and is shared by every system.`,
  `- The LLM judge sees the final page as an accessibility outline plus visible text (no screenshots, no network or backend access).`,
  `- The agentic verifier explores the captured snapshot (accessibility tree, network log, storage, probe results) without live access.`,
  wrong.length
    ? `- Checks wrong on: ${wrong.map((r) => `${r.app}/${r.task}/${r.scenario} (${r.verdict})`).join(', ')}.`
    : '- Checks gave the labelled verdict on every run.',
  '',
].join('\n');
mkdirSync(new URL('results/', root), { recursive: true });
writeFileSync(new URL('results/REPORT.md', root), md);
writeFileSync(
  new URL('results/results.json', root),
  JSON.stringify({ generatedAt: new Date().toISOString(), checks: CHECKS, results }, null, 1) + '\n',
);
console.warn(md.split('\n').slice(0, 14).join('\n'));
