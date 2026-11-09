/**
 * `assay bench` (ADR 0018): compile the project's tasks with several models and compare them on
 * what matters for choosing one: how often it compiles, whether the checks it writes survive the
 * stress test and judge the held-out labelled runs correctly, and what that costs in turns,
 * tokens, dollars and time.
 *
 * Every (model, strategy, task, repeat) is one job with its own cassette, so a bench recorded once
 * replays offline, byte for byte. The discovery strategy (ADR 0020) is a dimension of its own
 * (ADR 0026): each model gets a row per strategy, and `mine-only` one row with no model. Results are kept in a fixed order (models as given, tasks by name,
 * repeats ascending) whatever order the jobs finish in.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileTask, type DiscoveryStrategy, type Reference, type TaskInput } from '../../compiler/index.ts';
import { metrics, type Prediction } from '../../eval/metrics.ts';
import { recordingModel, replayModel, NO_RECORDING } from '../../model/replay.ts';
import type { ModelClient, ModelMode } from '../../model/types.ts';
import { evaluate } from '../../runtime/evaluate.ts';
import { stressTest, type StressOptions } from '../../stress/index.ts';
import type { EvidenceSnapshot, Outcome } from '../../types.ts';
import { verify } from '../../verifier/escalate.ts';
import { problems } from '../commands/stress.ts';
import { priceBook, priceUsage, type PriceBook, type PriceSource } from './prices.ts';

/** A labelled run of a task: a snapshot and, when labelled, whether it really did the task. */
export interface BenchRun {
  name: string;
  expected?: 'success' | 'fail';
  kind?: string;
  snapshot: EvidenceSnapshot;
}

export interface BenchTask {
  /** The task file's name without `.checks.json` / `.task.json`: the cassette and report key. */
  name: string;
  /** The task file, as shown in reports. */
  file: string;
  task: TaskInput;
  /** The runs the checks are compiled from. */
  training: BenchRun[];
  /** Labelled runs the compiled checks are scored on (never compiled from). */
  heldOut: (BenchRun & { expected: 'success' | 'fail' })[];
}

export interface BenchModel {
  /** As the user wrote it: the row label. */
  label: string;
  /** The cassette directory name. */
  slug: string;
  /** The live model; only called when a job is not replayed. */
  resolve(): Promise<ModelClient>;
}

/** `auto`: replay a job's cassette when it exists, else run live without recording. */
export type CassetteMode = 'auto' | 'replay' | 'record';

export interface BenchOptions {
  tasks: BenchTask[];
  models: BenchModel[];
  runs: number;
  concurrency: number;
  /** The cassette directory (one subdirectory per model slug). */
  cassettes: string;
  mode: CassetteMode;
  /** Send held-out runs the compiled checks abstain on to the same model, as the agentic verifier. */
  escalate?: boolean;
  /** Stress defaults (a task's own `skipVariants` win). */
  stress?: StressOptions;
  /** Stop starting jobs; `runBench` then returns what finished. */
  signal?: AbortSignal;
  onJob?(job: JobResult, finished: number, total: number): void;
  /**
   * The discovery strategies to compare (default `['model']`: the bench as before, with the same
   * cassettes, rows and output). `mine-only` runs with the deterministic rubric and no model.
   */
  discovery?: DiscoveryStrategy[];
  /** Model prices (default: the built-in list). */
  prices?: PriceBook;
}

/** `none`: a `mine-only` job, which runs no model and has no cassette. */
export type JobSource = 'live' | 'replay' | 'record' | 'none';

/** What a job's compiled checks cover, with the strategy dimension (ADR 0026). */
export interface JobRequirements {
  /** Requirements of the rubric (0 when the rubric step failed). */
  total: number;
  /** Covered by mined checks in the accepted set (0 when nothing was accepted). */
  mined: number;
  /** Covered in the accepted set by checks the discovery agent wrote. */
  discovered: number;
}

export interface JobResult {
  model: string;
  task: string;
  run: number;
  status: 'compiled' | 'refused' | 'error';
  /** Why a compile was refused, or the error. */
  reason?: string;
  source?: JobSource;
  /** The model id that ran (the recorded one for a replay). */
  modelId?: string;
  modes: ModelMode[];
  turns: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  /** Null when the model has no listed price. */
  costUsd: number | null;
  /** Model time (compile and escalation); for a replay the recorded time, null if none was recorded. */
  wallMs: number | null;
  stress?: {
    clean: boolean;
    problems: string[];
    weak: number;
    variantsAccepted: number;
    variantsTotal: number;
    mutantsRejected: number;
    mutantsTotal: number;
  };
  heldOut: {
    run: string;
    kind?: string;
    expected: 'success' | 'fail';
    verdict: Outcome['verdict'];
    escalated?: true;
  }[];
  warnings?: string[];
  /** With the strategy dimension: the strategy, discovery-agent turns and coverage. */
  discovery?: DiscoveryStrategy;
  discoveryTurns?: number;
  requirements?: JobRequirements;
  /** When the report lists prices: where the job's price came from; null when no table lists it. */
  price?: { key: string; source: PriceSource } | null;
}

/** Mean and sample standard deviation over repeats; NaN mean when nothing was measured. */
export interface Stat {
  mean: number;
  sd: number;
  n: number;
}

export interface ModelSummary {
  /** Repeats with a finished job; a stat with a smaller `n` was measured in only some of them. */
  repeats: number;
  /** Share of tasks compiled. */
  compiled: Stat;
  /** Share of compiled check sets with no stress problems. */
  stressClean: Stat;
  /** Over held-out runs of the compiled tasks. */
  balancedAccuracy: Stat;
  /** Incorrect held-out runs judged success. */
  falseSuccess: Stat;
  /** Per task: */
  turns: Stat;
  inputTokens: Stat;
  outputTokens: Stat;
  costUsd: Stat;
  wallMs: Stat;
  /** Held-out runs escalated per task (with `escalate`). */
  escalated: Stat;
  /** With the strategy dimension: share of the rubrics' requirements covered by mined checks. */
  requirementsMined?: Stat;
  /** With the strategy dimension: share covered by checks the discovery agent wrote. */
  requirementsDiscovered?: Stat;
  /** With the strategy dimension: share of tasks compiled with no discovery-agent turn. */
  noDiscovery?: Stat;
}

export interface ModelResult {
  /** The model as given; `none` for the `mine-only` row. */
  label: string;
  /** Its cassette directory; empty for the `mine-only` row, which has none. */
  slug: string;
  /** With the strategy dimension: this row's strategy. */
  discovery?: DiscoveryStrategy;
  /** Model ids that ran, sorted. */
  ids: string[];
  sources: JobSource[];
  modes: ModelMode[];
  /** Set when every finished job errored: the model produced no result at all. */
  error?: string;
  summary: ModelSummary;
  jobs: JobResult[];
}

/** A model's price as the report lists it (ADR 0026). */
export interface PriceRow {
  /** The model id (or the label of a model that never ran). */
  model: string;
  /** `unknown`: no table lists it, so its cost is unknown (never $0). */
  source: PriceSource | 'unknown';
  key?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface BenchResult {
  schema: 'assay.bench/v1';
  runs: number;
  escalate: boolean;
  /** The strategies compared, when not just `model` (ADR 0026). */
  discovery?: DiscoveryStrategy[];
  /** Every model's price and where it came from, when prices were given or strategies compared. */
  prices?: PriceRow[];
  tasks: { name: string; file: string; training: string[]; heldOut: number }[];
  /** One row per model, or per model and strategy with the strategy dimension. */
  models: ModelResult[];
  /** Set when the bench was stopped before every job finished. */
  interrupted?: { finished: number; total: number };
}

/**
 * Where the cassette of one (model, task, repeat) job lives: `<dir>/<slug>/<task>/run-<n>.json`
 * for the default strategy (as before ADR 0026), `<dir>/<slug>/<task>/<strategy>/run-<n>.json`
 * for `mine-first`, whose requests differ.
 */
export const cassetteFile = (
  dir: string,
  slug: string,
  task: string,
  run: number,
  strategy: DiscoveryStrategy = 'model',
) =>
  strategy === 'model' ? join(dir, slug, task, `run-${run}.json`) : join(dir, slug, task, strategy, `run-${run}.json`);

/** One row of the bench: a model with a strategy, or the `mine-only` row with no model. */
export interface BenchRow {
  label: string;
  slug: string;
  strategy: DiscoveryStrategy;
  model?: BenchModel;
}

/** The rows: each model with each strategy that needs one, in order, then one `mine-only` row. */
export function benchRows(models: BenchModel[], strategies: DiscoveryStrategy[]): BenchRow[] {
  const rows: BenchRow[] = [];
  for (const m of models)
    for (const strategy of strategies)
      if (strategy !== 'mine-only') rows.push({ label: m.label, slug: m.slug, strategy, model: m });
  if (strategies.includes('mine-only')) rows.push({ label: 'none', slug: '', strategy: 'mine-only' });
  return rows;
}

/** Is this more than the default bench (one strategy, `model`)? */
export const comparesStrategies = (strategies: DiscoveryStrategy[] | undefined) =>
  !!strategies && !(strategies.length === 1 && strategies[0] === 'model');
const timingFile = (cassette: string) => cassette.replace(/\.json$/, '.timing.json');

/** The recorded wall time of a cassette; null without a timing file. Throws on a malformed one. */
function readTiming(cassette: string): number | null {
  const f = timingFile(cassette);
  if (!existsSync(f)) return null;
  let j: { wallMs?: unknown };
  try {
    j = JSON.parse(readFileSync(f, 'utf8')) as { wallMs?: unknown };
  } catch (e) {
    throw new Error(`malformed timing file ${f}: ${errorText(e)}`, { cause: e });
  }
  return typeof j?.wallMs === 'number' ? j.wallMs : null;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const emptyUsage = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

/** A job that produced no result: `e` is why (a missing cassette turn reads as a stale cassette). */
function failedJob(m: BenchRow, t: BenchTask, run: number, e: unknown, source?: JobSource, dim = false): JobResult {
  const msg = errorText(e);
  return {
    model: m.label,
    task: t.name,
    run,
    status: 'error',
    reason: msg.includes(NO_RECORDING) ? `stale cassette: ${msg}` : msg,
    ...(source ? { source } : {}),
    modes: [],
    turns: 0,
    usage: emptyUsage(),
    costUsd: null,
    wallMs: null,
    heldOut: [],
    ...(dim ? { discovery: m.strategy } : {}),
  };
}

/** One model, one task, one repeat. Never throws: an error is the job's result. */
async function runJob(o: BenchOptions, m: BenchRow, t: BenchTask, run: number): Promise<JobResult> {
  const dim = comparesStrategies(o.discovery);
  const book = o.prices ?? priceBook({});
  const listPrices = dim || book.custom;
  const base = { model: m.label, task: t.name, run };
  const failed = (e: unknown, source?: JobSource) => failedJob(m, t, run, e, source, dim);
  const file = cassetteFile(o.cassettes, m.slug, t.name, run, m.strategy);
  let client: ModelClient | undefined;
  let source: JobSource;
  let recordedAs: { model: string; at: string } | undefined;
  let done: ((ms: number) => void) | undefined;
  try {
    if (!m.model) {
      // mine-only: the deterministic rubric and mining, no model and no cassette (ADR 0020).
      source = 'none';
    } else if (o.mode === 'replay' || (o.mode === 'auto' && existsSync(file))) {
      if (!existsSync(file)) throw new Error(`no cassette at ${file} (ASSAY_MODEL_MODE=replay never calls a model)`);
      const replay = replayModel(file);
      client = replay;
      recordedAs = replay.recorded;
      source = 'replay';
    } else {
      const live = await m.model.resolve();
      if (o.mode === 'record') {
        const rec = recordingModel(live, file);
        let turns = 0;
        client = {
          id: rec.id,
          async turn(req) {
            const out = await rec.turn(req);
            turns++;
            return out;
          },
        };
        source = 'record';
        // Saved only when a turn was recorded: an empty recording must not replace a cassette.
        done = (ms) => {
          if (!turns) return;
          rec.save();
          writeFileSync(timingFile(file), JSON.stringify({ wallMs: Math.round(ms) }, null, 1) + '\n');
        };
      } else {
        client = live;
        source = 'live';
      }
    }
  } catch (e) {
    return failed(e);
  }

  const usage = emptyUsage();
  const modes = new Set<ModelMode>();
  const warnings: string[] = [];
  let turns = 0;
  const t0 = performance.now();
  let result: Awaited<ReturnType<typeof compileTask>>;
  try {
    const refs: Reference[] = t.training.map((r) => ({
      name: r.name,
      kind: r.expected === 'fail' ? 'negative' : 'success',
      snapshot: r.snapshot,
    }));
    result = await compileTask(t.task, refs, {
      ...(client ? { model: client } : { rubric: 'deterministic' as const }),
      config: false,
      ...(m.strategy !== 'model' ? { discovery: m.strategy } : {}),
      ...(recordedAs ? { provenance: recordedAs } : {}),
    });
  } catch (e) {
    return failed(e, source);
  }
  const { checkSet, report } = result;
  for (const k of Object.keys(usage) as (keyof typeof usage)[]) usage[k] += report.usage[k];
  turns += report.turns.rubric + report.turns.discovery;
  if (turns) for (const mode of report.modes ?? ['tools']) modes.add(mode);

  const heldOut: JobResult['heldOut'] = [];
  if (checkSet) {
    for (const r of t.heldOut) {
      let verdict = evaluate(checkSet, r.snapshot).verdict;
      let escalated = false;
      if (verdict === 'abstain' && o.escalate && client) {
        escalated = true;
        const res = await verify(checkSet, r.snapshot, { verifier: client, config: false });
        verdict = res.outcome.verdict;
        const v = res.verifier;
        if (v) {
          for (const k of Object.keys(usage) as (keyof typeof usage)[]) usage[k] += v.usage[k];
          turns += v.turns;
          for (const mode of v.modes) modes.add(mode);
        }
        // A verifier that failed (an API error, a cassette without the turn) decided nothing: the
        // job has no trustworthy result, and must not pass as an abstention.
        const err = res.record.escalation?.error;
        if (err !== undefined) return failed(`escalating ${r.name}: ${err}`, source);
      }
      heldOut.push({
        run: r.name,
        ...(r.kind ? { kind: r.kind } : {}),
        expected: r.expected,
        verdict,
        ...(escalated ? { escalated: true as const } : {}),
      });
    }
  }
  const ms = performance.now() - t0;
  try {
    done?.(ms);
  } catch (e) {
    warnings.push(`could not save the cassette: ${errorText(e)}`);
  }

  let stress: JobResult['stress'];
  if (checkSet) {
    const correct = t.training.filter((r) => r.expected !== 'fail');
    const s = stressTest(
      checkSet,
      correct.map((r) => ({ name: r.name, snapshot: r.snapshot })),
      {
        skipVariants: t.task.skipVariants ?? o.stress?.skipVariants ?? [],
        ...(o.stress?.successClaims === false ? { successClaims: false } : {}),
      },
    );
    const found = problems(s);
    stress = {
      clean: found.length === 0,
      problems: found,
      weak: s.weak.length,
      variantsAccepted: s.rates.variantsAccepted,
      variantsTotal: s.rates.variantsTotal,
      mutantsRejected: s.rates.mutantsRejected,
      mutantsTotal: s.rates.mutantsTotal,
    };
  }

  let wallMs: number | null;
  try {
    // A mine-only job has no model time, and its mining time would make a report differ run to run.
    wallMs = source === 'none' ? null : source === 'replay' ? readTiming(file) : Math.round(ms);
  } catch (e) {
    return failed(e, source);
  }
  const modelId = client ? (recordedAs?.model ?? client.id) : undefined;
  let cost: number | null = null;
  let price: JobResult['price'];
  if (client) {
    const found =
      book.find(modelId!) ?? (report.modelsUsed[0] !== undefined ? book.find(report.modelsUsed[0]) : undefined);
    if (found) {
      const priced = priceUsage(usage, found);
      if ('usd' in priced) cost = priced.usd;
      else warnings.push(priced.unknown);
    }
    price = found ? { key: found.key, source: found.source } : null;
  } else cost = 0; // no model, no cost
  let requirements: JobRequirements | undefined;
  if (dim) {
    const mined = new Set(
      (report.mining?.requirements ?? []).filter((r) => r.status === 'covered').map((r) => r.requirement),
    );
    const covered = checkSet ? report.coverage.filter((c) => c.checks.length) : [];
    requirements = {
      total: report.coverage.length || report.mining?.requirements.length || 0,
      mined: covered.filter((c) => mined.has(c.requirement)).length,
      discovered: covered.filter((c) => !mined.has(c.requirement)).length,
    };
  }
  return {
    ...base,
    status: checkSet ? 'compiled' : 'refused',
    ...(checkSet ? {} : { reason: report.reason ?? 'refused' }),
    source,
    ...(modelId !== undefined ? { modelId } : {}),
    modes: [...modes].toSorted(),
    turns,
    usage,
    costUsd: cost,
    wallMs,
    ...(stress ? { stress } : {}),
    heldOut,
    ...(warnings.length ? { warnings } : {}),
    ...(dim ? { discovery: m.strategy, discoveryTurns: report.turns.discovery, requirements } : {}),
    ...(listPrices && client ? { price } : {}),
  };
}

/** Mean and sample standard deviation of the finite values; `n` counts them. */
export function stat(values: number[]): Stat {
  const xs = values.filter(Number.isFinite);
  if (!xs.length) return { mean: NaN, sd: NaN, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)) : 0;
  return { mean, sd, n: xs.length };
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** One repeat's values: shares over its tasks, and means per task of what the model spent. */
function repeatValues(jobs: JobResult[]) {
  const compiled = jobs.filter((j) => j.status === 'compiled');
  const ran = jobs.filter((j) => j.status !== 'error');
  const preds: Prediction[] = compiled.flatMap((j) =>
    j.heldOut.map((h) => ({ expected: h.expected, verdict: h.verdict, costUsd: 0, ms: NaN })),
  );
  const m = metrics(preds);
  const known = (xs: (number | null)[]) => (xs.some((x) => x === null) ? NaN : avg(xs as number[]));
  return {
    compiled: jobs.length ? compiled.length / jobs.length : NaN,
    stressClean: compiled.length ? compiled.filter((j) => j.stress?.clean).length / compiled.length : NaN,
    balancedAccuracy: m.balancedAccuracy,
    falseSuccess: m.negatives ? 1 - m.tnr : NaN,
    turns: avg(ran.map((j) => j.turns)),
    inputTokens: avg(ran.map((j) => j.usage.inputTokens)),
    outputTokens: avg(ran.map((j) => j.usage.outputTokens)),
    costUsd: ran.length ? known(ran.map((j) => j.costUsd)) : NaN,
    wallMs: ran.length ? known(ran.map((j) => j.wallMs)) : NaN,
    escalated: avg(ran.map((j) => j.heldOut.filter((h) => h.escalated).length)),
    ...coverageValues(jobs),
  };
}

/** With the strategy dimension: requirement shares over the repeat's rubrics, and tasks with no discovery turn. */
function coverageValues(jobs: JobResult[]): {
  requirementsMined?: number;
  requirementsDiscovered?: number;
  noDiscovery?: number;
} {
  const ran = jobs.filter((j) => j.status !== 'error' && j.requirements);
  if (!ran.length) return {};
  const total = ran.reduce((a, j) => a + j.requirements!.total, 0);
  const share = (k: 'mined' | 'discovered') => (total ? ran.reduce((a, j) => a + j.requirements![k], 0) / total : NaN);
  return {
    requirementsMined: share('mined'),
    requirementsDiscovered: share('discovered'),
    noDiscovery: jobs.filter((j) => j.status === 'compiled' && j.discoveryTurns === 0).length / jobs.length,
  };
}

/**
 * A model's summary: each value per repeat, then mean ± sd over the repeats. A value a repeat
 * could not measure (a job without timing) leaves that repeat out of its stat, so `n` below
 * `repeats` marks a partial aggregate.
 */
export function summarize(jobs: JobResult[], runs: number): ModelSummary {
  const per = Array.from({ length: runs }, (_, i) => jobs.filter((j) => j.run === i + 1))
    .filter((js) => js.length)
    .map(repeatValues);
  const of = (k: keyof ReturnType<typeof repeatValues>) => stat(per.map((p) => p[k] ?? NaN));
  const dim = jobs.some((j) => j.requirements);
  return {
    repeats: per.length,
    compiled: of('compiled'),
    stressClean: of('stressClean'),
    balancedAccuracy: of('balancedAccuracy'),
    falseSuccess: of('falseSuccess'),
    turns: of('turns'),
    inputTokens: of('inputTokens'),
    outputTokens: of('outputTokens'),
    costUsd: of('costUsd'),
    wallMs: of('wallMs'),
    escalated: of('escalated'),
    ...(dim
      ? {
          requirementsMined: of('requirementsMined'),
          requirementsDiscovered: of('requirementsDiscovered'),
          noDiscovery: of('noDiscovery'),
        }
      : {}),
  };
}

const sorted = <T extends string>(xs: Iterable<T>) => [...new Set(xs)].toSorted();

/** One model's row: its jobs, what ran them, and their summary (none when every job errored). */
export function modelResult(m: BenchModel | BenchRow, jobs: JobResult[], runs: number, dim = false): ModelResult {
  const errors = jobs.filter((j) => j.status === 'error');
  const error =
    jobs.length && errors.length === jobs.length
      ? sorted(errors.map((j) => j.reason ?? 'error')).join('; ')
      : undefined;
  return {
    label: m.label,
    slug: m.slug,
    ...(dim && 'strategy' in m ? { discovery: m.strategy } : {}),
    ids: sorted(jobs.flatMap((j) => (j.modelId ? [j.modelId] : []))),
    sources: sorted(jobs.flatMap((j) => (j.source ? [j.source] : []))),
    modes: sorted(jobs.flatMap((j) => j.modes)),
    ...(error ? { error } : {}),
    summary: summarize(error ? [] : jobs, runs),
    jobs,
  };
}

/** Run every job, at most `concurrency` at a time. Stopped by `signal`, it returns what finished. */
export async function runBench(o: BenchOptions): Promise<BenchResult> {
  if (o.cassettes && o.mode === 'record') mkdirSync(o.cassettes, { recursive: true });
  const dim = comparesStrategies(o.discovery);
  const rows = benchRows(o.models, o.discovery ?? ['model']);
  const book = o.prices ?? priceBook({});
  // Interleaved (each repeat, each task, each row), so a stopped bench has results for every model.
  const jobs: { m: number; t: number; run: number }[] = [];
  for (let run = 1; run <= o.runs; run++)
    for (let t = 0; t < o.tasks.length; t++) for (let m = 0; m < rows.length; m++) jobs.push({ m, t, run });
  const results: (JobResult | undefined)[] = Array.from({ length: jobs.length });
  let next = 0;
  let finished = 0;
  const worker = async () => {
    while (!o.signal?.aborted && next < jobs.length) {
      const i = next++;
      const j = jobs[i]!;
      const m = rows[j.m]!;
      const t = o.tasks[j.t]!;
      // runJob reports its errors as results; this only guards the other jobs against a bug.
      const r = await runJob(o, m, t, j.run).catch((e: unknown) => failedJob(m, t, j.run, e, undefined, dim));
      if (o.signal?.aborted) return; // finished after the stop: not part of what was reported
      results[i] = r;
      finished++;
      o.onJob?.(r, finished, jobs.length);
    }
  };
  const all = Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency, jobs.length)) }, worker));
  if (o.signal) {
    const stopped = new Promise<void>((resolve) => {
      if (o.signal!.aborted) resolve();
      else o.signal!.addEventListener('abort', () => resolve(), { once: true });
    });
    await Promise.race([all, stopped]);
  } else await all;
  const done = results.slice();
  const interrupted = done.some((r) => r === undefined);
  const key = (r: JobResult) => [r.task, r.run] as const;
  const models = rows.map((m, mi) => {
    const mine = jobs
      .map((j, i) => (j.m === mi ? done[i] : undefined))
      .filter((r): r is JobResult => !!r)
      .toSorted((a, b) => {
        const [ta, ra] = key(a);
        const [tb, rb] = key(b);
        return ta < tb ? -1 : ta > tb ? 1 : ra - rb;
      });
    return modelResult(m, mine, o.runs, dim);
  });
  return {
    schema: 'assay.bench/v1',
    runs: o.runs,
    escalate: !!o.escalate,
    ...(dim ? { discovery: o.discovery! } : {}),
    ...(dim || book.custom ? { prices: priceRows(models, book) } : {}),
    tasks: o.tasks.map((t) => ({
      name: t.name,
      file: t.file,
      training: t.training.map((r) => r.name),
      heldOut: t.heldOut.length,
    })),
    models,
    ...(interrupted ? { interrupted: { finished: done.filter(Boolean).length, total: jobs.length } } : {}),
  };
}

/**
 * Every model's price, once per model id in the order the rows ran them: the price and its
 * source, or `unknown`. A model that never ran (every job failed) is listed by its label.
 */
export function priceRows(models: ModelResult[], book: PriceBook): PriceRow[] {
  const seen = new Set<string>();
  const out: PriceRow[] = [];
  const ran = new Set(models.filter((m) => m.ids.length).map((m) => m.label));
  for (const m of models) {
    if (m.discovery === 'mine-only') continue;
    // A row that never ran is listed by its label, unless another row of its model ran.
    for (const id of m.ids.length ? m.ids : ran.has(m.label) ? [] : [m.label]) {
      if (seen.has(id)) continue;
      seen.add(id);
      const found = book.find(id);
      out.push(
        found ? { model: id, source: found.source, key: found.key, ...found.price } : { model: id, source: 'unknown' },
      );
    }
  }
  return out;
}
