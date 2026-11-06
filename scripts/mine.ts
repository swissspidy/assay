/**
 * Measures the mining-first compiler (ADR 0020) on the committed data, without a model or a
 * browser: the example apps (one correct reference per task, as scripts/compile-examples.ts)
 * and the real-app tasks (their reference runs, as eval/real/compile.ts).
 *
 *   node scripts/mine.ts [--json] [--filter <substring>]
 *
 * Per task, two compiles with `discovery: "mine-only"`:
 * - `deterministic`: `rubric: "deterministic"`, no model at all;
 * - `model rubric`: the rubric replayed from the task's committed compile cassette, then
 *   mining. A task covered this way is what `mine-first` compiles with zero discovery turns;
 *   the discovery turns and tokens of the committed compile are what it saves.
 * Every mined set is judged on the task's held-out labelled runs.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { evaluate, type CheckSet, type EvidenceSnapshot } from '../src/index.ts';
import {
  compileTask,
  rubricFromClauses,
  type CompileReport,
  type Reference,
  type TaskInput,
} from '../src/compiler/index.ts';
import { replayModel } from '../src/model/index.ts';
import { APPS } from '../examples/apps.ts';
import { compileReference } from '../examples/lib/scenario.ts';
import { APPS as REAL } from '../eval/real/apps.ts';

const args = process.argv.slice(2);
const json = args.includes('--json');
const filter = args.includes('--filter') ? args[args.indexOf('--filter') + 1] : undefined;

interface Labelled {
  name: string;
  expected: 'success' | 'fail';
  snapshot: EvidenceSnapshot;
}
interface Job {
  id: string;
  dataset: 'examples' | 'real';
  task: TaskInput;
  refs: Reference[];
  heldOut: Labelled[];
  cassette: URL;
  report: URL;
}

function exampleJobs(): Job[] {
  const jobs: Job[] = [];
  for (const app of APPS) {
    for (const def of app.tasks) {
      const hand = JSON.parse(readFileSync(new URL(`tasks/${def.id}.checks.json`, app.dir), 'utf8')) as CheckSet;
      const dir = new URL(`references/${def.id}/`, app.dir);
      const runs: Labelled[] = readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .toSorted()
        .map((f) => {
          const j = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
          return { name: f.replace(/\.json$/, ''), expected: j.label.expected, snapshot: j.snapshot };
        });
      const ref = compileReference(def).name;
      jobs.push({
        id: `${app.name}/${def.id}`,
        dataset: 'examples',
        task: {
          id: `${app.name}/${def.id}`,
          instruction: hand.task.instruction,
          ...(hand.task.outcomes !== undefined ? { outcomes: hand.task.outcomes } : {}),
          ...(def.skipVariants ? { skipVariants: def.skipVariants } : {}),
        },
        refs: runs.filter((r) => r.name === ref).map((r) => ({ name: r.name, kind: 'success', snapshot: r.snapshot })),
        heldOut: runs.filter((r) => r.name !== ref),
        cassette: new URL(`compiled/${def.id}.cassette.json`, app.dir),
        report: new URL(`compiled/${def.id}.report.json`, app.dir),
      });
    }
  }
  return jobs;
}

const training = (n: string) => n === 'reference' || n.startsWith('reference-');
const median = (xs: number[]) => {
  const s = xs.toSorted((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0;
};

function realJobs(): Job[] {
  const root = new URL('../eval/real/', import.meta.url);
  const jobs: Job[] = [];
  for (const app of REAL) {
    for (const t of app.tasks) {
      const dir = new URL(`runs/${app.name}/${t.id}/`, root);
      if (!existsSync(dir)) continue;
      const runs: Labelled[] = readdirSync(dir)
        .filter((f) => f.endsWith('.json.gz'))
        .toSorted()
        .map((f) => {
          const j = JSON.parse(gunzipSync(readFileSync(new URL(f, dir))).toString('utf8'));
          return { name: f.replace(/\.json\.gz$/, ''), expected: j.label.expected, snapshot: j.snapshot };
        });
      jobs.push({
        id: `${app.name}/${t.id}`,
        dataset: 'real',
        task: {
          id: `${app.name}/${t.id}`,
          instruction: t.instruction,
          ...(t.skipVariants?.length ? { skipVariants: t.skipVariants } : {}),
        },
        refs: runs
          .filter((r) => training(r.name))
          .toSorted((a, b) => (a.name === 'reference' ? -1 : b.name === 'reference' ? 1 : 0))
          .map((r) => ({ name: r.name, kind: 'success', snapshot: r.snapshot })),
        heldOut: runs.filter((r) => !training(r.name)),
        cassette: new URL(`compiled/${app.name}/${t.id}.cassette.json`, root),
        report: new URL(`compiled/${app.name}/${t.id}.report.json`, root),
      });
    }
  }
  return jobs;
}

interface Row {
  task: string;
  dataset: Job['dataset'];
  rubric: 'deterministic' | 'model';
  compiled: boolean;
  covered: number;
  requirements: number;
  candidates: number;
  survivors: number;
  ms: number;
  heldOut?: { total: number; asLabelled: number; falseSuccess: number; abstained: number };
  saved?: { turns: number; inputTokens: number; outputTokens: number };
  open: string[];
}

/** Discovery turns and tokens of the committed compile: the report's, minus the rubric turns in its cassette. */
function discoveryCost(job: Job): Row['saved'] {
  if (!existsSync(job.report) || !existsSync(job.cassette)) return undefined;
  const report = JSON.parse(readFileSync(job.report, 'utf8')) as CompileReport;
  const cassette = JSON.parse(readFileSync(job.cassette, 'utf8')) as {
    turns: Record<string, { toolCalls: { name: string }[]; usage: { inputTokens: number; outputTokens: number } }>;
  };
  let input = report.usage.inputTokens;
  let output = report.usage.outputTokens;
  for (const t of Object.values(cassette.turns)) {
    if (!t.toolCalls.some((c) => c.name === 'submit_rubric')) continue;
    input -= t.usage.inputTokens;
    output -= t.usage.outputTokens;
  }
  return { turns: report.turns.discovery, inputTokens: input, outputTokens: output };
}

const rows: Row[] = [];
/** Discovery cost of every committed compile, for scale. */
const all = { tasks: 0, turns: 0, inputTokens: 0, outputTokens: 0 };
for (const job of [...exampleJobs(), ...realJobs()]) {
  if (filter && !job.id.includes(filter)) continue;
  const cost = discoveryCost(job);
  if (cost) {
    all.tasks++;
    all.turns += cost.turns;
    all.inputTokens += cost.inputTokens;
    all.outputTokens += cost.outputTokens;
  }
  for (const rubric of ['deterministic', 'model'] as const) {
    let result: Awaited<ReturnType<typeof compileTask>>;
    if (rubric === 'deterministic') {
      result = await compileTask(job.task, job.refs, {
        discovery: 'mine-only',
        requirements: rubricFromClauses(job.task),
      });
    } else {
      if (!existsSync(job.cassette)) continue;
      const model = replayModel(job.cassette.pathname);
      result = await compileTask(job.task, job.refs, { discovery: 'mine-only', model, provenance: model.recorded });
    }
    const m = result.report.mining;
    if (!m) {
      console.warn(`${job.id} (${rubric}): ${result.report.reason}`);
      continue;
    }
    const row: Row = {
      task: job.id,
      dataset: job.dataset,
      rubric,
      compiled: !!result.checkSet,
      covered: m.requirements.filter((r) => r.status === 'covered').length,
      requirements: m.requirements.length,
      candidates: m.candidates,
      survivors: m.survivors,
      ms: m.ms,
      open: m.requirements.filter((r) => r.status === 'open').map((r) => `${r.requirement}: ${r.reason}`),
    };
    if (result.checkSet) {
      const verdicts = job.heldOut.map((r) => ({ r, v: evaluate(result.checkSet!, r.snapshot).verdict }));
      row.heldOut = {
        total: verdicts.length,
        asLabelled: verdicts.filter(({ r, v }) => v === r.expected).length,
        falseSuccess: verdicts.filter(({ r, v }) => r.expected === 'fail' && v === 'success').length,
        abstained: verdicts.filter(({ v }) => v === 'abstain').length,
      };
      if (rubric === 'model') {
        const saved = discoveryCost(job);
        if (saved) row.saved = saved;
      }
    }
    rows.push(row);
  }
}

if (json) {
  console.log(JSON.stringify({ committedDiscovery: all, rows }, null, 2));
} else {
  const sum = (xs: Row[], f: (r: Row) => number) => xs.reduce((a, r) => a + f(r), 0);
  const lines = [
    '| Dataset | Rubric | Tasks | Compiled mine-only | Requirements covered | Held-out as labelled | False successes | Abstained | Mining ms (median / max) |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const dataset of ['examples', 'real'] as const)
    for (const rubric of ['deterministic', 'model'] as const) {
      const xs = rows.filter((r) => r.dataset === dataset && r.rubric === rubric);
      if (!xs.length) continue;
      const held = xs.filter((r) => r.heldOut);
      lines.push(
        `| ${dataset} | ${rubric} | ${xs.length} | ${xs.filter((r) => r.compiled).length} | ${sum(xs, (r) => r.covered)}/${sum(xs, (r) => r.requirements)} | ${sum(held, (r) => r.heldOut!.asLabelled)}/${sum(held, (r) => r.heldOut!.total)} | ${sum(held, (r) => r.heldOut!.falseSuccess)} | ${sum(held, (r) => r.heldOut!.abstained)} | ${median(xs.map((r) => r.ms)).toFixed(1)} / ${Math.max(...xs.map((r) => r.ms)).toFixed(1)} |`,
      );
    }
  const saved = rows.filter((r) => r.saved);
  lines.push(
    '',
    `Mine-first with the recorded model rubric: ${saved.length} task(s) need no discovery turn, saving ${sum(saved, (r) => r.saved!.turns)} discovery turns, ${sum(saved, (r) => r.saved!.inputTokens)} input and ${sum(saved, (r) => r.saved!.outputTokens)} output tokens of the committed compiles${saved.length ? ` (${saved.map((r) => r.task).join(', ')})` : ''}. All ${all.tasks} committed compiles together used ${all.turns} discovery turns, ${all.inputTokens} input and ${all.outputTokens} output tokens.`,
    '',
    '| Task | Rubric | Covered | Held-out | Open requirements |',
    '|---|---|---:|---:|---|',
    ...rows.map(
      (r) =>
        `| ${r.task} | ${r.rubric} | ${r.covered}/${r.requirements} | ${r.heldOut ? `${r.heldOut.asLabelled}/${r.heldOut.total}` : ''} | ${r.open.join('; ').replace(/\|/g, '\\|')} |`,
    ),
  );
  console.log(lines.join('\n'));
}
