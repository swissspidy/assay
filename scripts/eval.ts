/**
 * Milestone 5 evaluation: compare verification systems on every labelled run of
 * the 30 example tasks (correct, wrong-item, partial, over-completion, no-op,
 * undone and adversarial runs).
 *
 *   node scripts/eval.ts [--systems checks,checks+escalation,llm-judge,agentic-verifier] [--checks handwritten|compiled]
 *
 * Model-based systems replay their cassettes under eval/cassettes/ and record the
 * missing ones live when ANTHROPIC_API_KEY is set (ASSAY_MODEL_MODE=record
 * re-records all); a system without recordings is reported as not measured.
 * Writes eval/results/REPORT.md and results.json (compiled: eval/results/compiled/).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { evaluate, runVerifier, verify, type CheckSet, type EvidenceSnapshot } from '../src/index.ts';
import { costUsd, llmJudge, metrics, PRICING, type Metrics, type Prediction } from '../src/eval/index.ts';
import { kleeneAnd } from '../src/runtime/evaluate.ts';
import { APPS } from '../examples/apps.ts';
import { compileReference } from '../examples/lib/scenario.ts';
import { modelFromEnv } from './model-from-env.ts';

const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : dflt;
};
const KNOWN_SYSTEMS = ['checks', 'checks+escalation', 'llm-judge', 'agentic-verifier'];
const SYSTEMS = arg('systems', KNOWN_SYSTEMS.join(',')).split(',');
// A typo must not fall through to the (paid) verifier path and be reported under its name.
const unknownSystems = SYSTEMS.filter((s) => !KNOWN_SYSTEMS.includes(s));
if (unknownSystems.length) throw new Error(`unknown --systems: ${unknownSystems.join(', ')}`);
const CHECKS_ARG = arg('checks', 'handwritten');
if (CHECKS_ARG !== 'handwritten' && CHECKS_ARG !== 'compiled') {
  throw new Error(`--checks must be handwritten or compiled, got ${CHECKS_ARG}`);
}
const CHECKS: 'handwritten' | 'compiled' = CHECKS_ARG;
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
/** Compiled mode: the run each check set was compiled from is not scored (it is not held out). */
const trainingRuns: string[] = [];
/** Tasks with no check set in the chosen mode: not scored, and named in the report. */
const unscoredTasks: string[] = [];
const taskText = (x: CheckSet) => JSON.stringify([x.task.instruction, x.task.outcomes ?? null]);
for (const app of APPS) {
  for (const t of app.tasks) {
    const training = CHECKS === 'compiled' ? compileReference(t).name : undefined;
    const csFile =
      CHECKS === 'compiled'
        ? new URL(`compiled/${t.id}.checks.json`, app.dir)
        : new URL(`tasks/${t.id}.checks.json`, app.dir);
    if (!existsSync(csFile)) {
      unscoredTasks.push(`${app.name}/${t.id}`);
      continue;
    }
    const checks = JSON.parse(readFileSync(csFile, 'utf8')) as CheckSet;
    if (CHECKS === 'compiled') {
      // Model systems are given checks.task: it must be the task as written now.
      const written = JSON.parse(readFileSync(new URL(`tasks/${t.id}.checks.json`, app.dir), 'utf8')) as CheckSet;
      if (taskText(checks) !== taskText(written)) {
        throw new Error(
          `${app.name}/${t.id}: the compiled check set's task text is stale; re-run scripts/compile-examples.ts`,
        );
      }
    }
    const dir = new URL(`references/${t.id}/`, app.dir);
    // The held-out guarantee depends on finding the training run; fail loudly if it was renamed.
    if (training && !existsSync(new URL(`${training}.json`, dir))) {
      throw new Error(`${app.name}/${t.id}: compiled from "${training}", which is not among the references`);
    }
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith('.json'))
      .toSorted()) {
      const { label, snapshot } = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      if (f.replace(/\.json$/, '') === training) {
        trainingRuns.push(`${app.name}/${t.id}/${training}`);
        continue;
      }
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

type ModelOutcome = { row: Row; model: string } | { unavailable: string };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A replayed request that the cassette has no recording for: the inputs changed since recording. */
const isStale = (msg: string | undefined) => !!msg && msg.includes('has no recording for this request');

/** The LLM judge never sees the check set, so its recordings serve both modes; the others are kept per mode. */
const cassetteDir = (system: string) =>
  CHECKS === 'compiled' && system !== 'llm-judge' ? `cassettes/compiled/${system}/` : `cassettes/${system}/`;
/** Handwritten results stay at eval/results/ (what CI writes); compiled ones go next to them. */
const resultsDir = CHECKS === 'compiled' ? 'results/compiled/' : 'results/';

async function modelRun(system: string, r: Run): Promise<ModelOutcome> {
  const cassette = new URL(`${cassetteDir(system)}${r.app}/${r.task}/${r.scenario}.json`, root).pathname;
  let env;
  try {
    env = await modelFromEnv(cassette);
  } catch (e) {
    return {
      unavailable: process.env.ANTHROPIC_API_KEY ? `model unavailable: ${errorText(e)}` : 'no recorded cassette',
    };
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
      if (j.status === 'error') note = j.reasoning;
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
      const res = await verify(r.checks, r.snapshot, { verifier: env.model, agentReport: AGENT_REPORT });
      verdict = res.outcome.verdict;
      usage = res.verifier?.usage ?? { inputTokens: 0, outputTokens: 0 };
      const err = res.record.escalation?.error;
      if (err !== undefined) note = `model error: ${err}`;
    }
  } catch (e) {
    // A failed model call is a real outcome of that system: count it as abstain.
    note = `model error: ${errorText(e)}`;
  }
  // In replay, a request the cassette never saw is a stale recording, not a model outcome.
  if (env.mode === 'replay' && isStale(note))
    return { unavailable: 'stale cassette (re-record with ANTHROPIC_API_KEY)' };
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
      ? `| ${sys} | ${fmt(x.balancedAccuracy)} | ${fmt(x.tpr)} | ${fmt(x.tnr)} | ${fmt(x.abstainRate)} | $${fmt(x.costUsdPerRun, 4)} | ${ms(x.msPerRunMedian)} / ${ms(x.msPerRunP95)}${x.msMeasured < x.n ? ` (${x.msMeasured} of ${x.n} runs timed)` : ''} |`
      : `| ${sys} | not measured | | | | | |`,
  ),
];

function writeReport(): string {
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
  const measuredSystems = Object.entries(results)
    .filter(([, v]) => v.measured)
    .map(([k]) => k);
  const md = [
    `# Evaluation: ${CHECKS} checks${measuredSystems.some((x) => x !== 'checks' && x !== 'checks+escalation') ? ' vs. model baselines' : ' (model baselines not measured yet)'}`,
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
      : `- Compiled check sets: each was compiled from one correct run per task. Those ${trainingRuns.length} runs are left out for every system, so all scored runs are held out.`,
    ...(unscoredTasks.length
      ? [
          `- **Not scored** (no ${CHECKS} check set): ${unscoredTasks.join(', ')}. The comparison covers the other tasks only.`,
        ]
      : []),
    `- The LLM judge is shown the agent's report, as typical LLM judges are; Assay's checks never see it, and the agentic verifier gets it marked as context, not evidence.`,
    ...Object.entries(results)
      .map(([k, v]) => [k, v.rows.filter((r) => r.note).length] as const)
      .filter(([, c]) => c > 0)
      .map(
        ([k, c]) =>
          `- **${k}**: ${c} runs ended in a model error (counted as abstain; the API client retries transient errors twice first).`,
      ),
    `- Model latency is only measured when recording; replayed runs show none.`,
    `- Checks-only latency is in-process evaluation of a captured snapshot (no model). Capture itself takes about 20-60 ms per page and is shared by every system.`,
    `- The LLM judge sees the final page as an accessibility outline plus visible text (no screenshots, no network or backend access).`,
    `- The agentic verifier explores the captured snapshot (accessibility tree, network log, storage, probe results) without live access.`,
    wrong.length
      ? `- Checks wrong on: ${wrong.map((r) => `${r.app}/${r.task}/${r.scenario} (${r.verdict})`).join(', ')}.`
      : '- Checks gave the labelled verdict on every run.',
    '',
  ].join('\n');
  mkdirSync(new URL(resultsDir, root), { recursive: true });
  writeFileSync(new URL(`${resultsDir}REPORT.md`, root), md);
  writeFileSync(
    new URL(`${resultsDir}results.json`, root),
    JSON.stringify({ generatedAt: new Date().toISOString(), checks: CHECKS, results }, null, 1) + '\n',
  );
  return md;
}

for (const system of SYSTEMS) {
  const rows: Row[] = [];
  let measured = runs.length > 0;
  let model: string | undefined;
  const unavailable = new Map<string, number>();
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
    if (system === 'checks+escalation') {
      const t0 = performance.now();
      const o = evaluate(r.checks, r.snapshot);
      if (o.verdict !== 'abstain') {
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
    }
    const out = await modelRun(system, r);
    if ('unavailable' in out) {
      unavailable.set(out.unavailable, (unavailable.get(out.unavailable) ?? 0) + 1);
      continue;
    }
    model = out.model;
    rows.push(out.row);
  }
  // Metrics over a subset would not be comparable with the other systems: all runs or nothing.
  if (unavailable.size) measured = false;
  const reason = [...unavailable].map(([why, n]) => `${n}/${runs.length} runs: ${why}`).join('; ');
  results[system] = measured
    ? { rows, measured, ...(model ? { model } : {}) }
    : { rows: [], measured, reason: reason || 'no runs' };
  console.warn(`${system}: ${measured ? `${rows.length} runs` : 'not measured'}`);
  // Written after every system, so a long live run that is stopped keeps what it finished.
  writeReport();
}

const md = writeReport();
console.warn(md.split('\n').slice(0, 14).join('\n'));
if (runs.length === 0) {
  console.error(`No labelled runs with ${CHECKS} check sets: nothing was evaluated.`);
  process.exitCode = 1;
}
