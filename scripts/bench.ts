/**
 * Performance benchmark: fixed workloads over the committed data (the 228 real-app runs,
 * the example apps' references and compiled check sets, and the compile cassettes).
 * Nothing is written outside `--json`, and no model or browser is started.
 *
 *   node --expose-gc scripts/bench.ts [--filter load,verify] [--iterations N] [--warmup N]
 *                                     [--json [file]] [--lib <checkout>]
 *
 * Workloads: load, verify, verify-batch, stress, compile-replay, mine, snapshot-size. Each timed
 * workload runs `--warmup` untimed and `--iterations` timed passes over the same work and
 * reports the median and p95 pass time, items per second and the cost per item. Inputs are
 * parsed afresh (untimed) before every pass, so a cache keyed on object identity cannot
 * carry over from one pass to the next.
 *
 * A calibration loop (sorted-key JSON, SHA-256 and JSON.parse over a fixed synthetic tree,
 * written here and independent of the library) runs before every workload. Its median is
 * the machine's speed in this run: `normalized` = workload median / calibration median, which
 * scripts/bench-compare.ts compares across machines (docs: CONTRIBUTING.md, "Benchmarks").
 *
 * `--lib` runs the same workloads with another checkout's library (its src/) on this checkout's
 * data, so both sides of a comparison get identical inputs (CI benches the pull request's base
 * this way). A workload must only use APIs that checkout has; one it cannot run (say the data
 * needs a DSL feature, or a prompt change the base's cassette keys do not match) is reported as
 * failed and the comparison falls back to the committed baseline for it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type * as Assay from '../src/index.ts';
import type * as Stress from '../src/stress/index.ts';
import type * as Compiler from '../src/compiler/index.ts';
import type * as Models from '../src/model/index.ts';
import type * as Metrics from '../src/eval/metrics.ts';
import type * as ExampleApps from '../examples/apps.ts';
import type * as Scenario from '../examples/lib/scenario.ts';
import type * as RealApps from '../eval/real/apps.ts';

// --- Options -----------------------------------------------------------------------

const WORKLOADS = ['load', 'verify', 'verify-batch', 'stress', 'compile-replay', 'mine', 'snapshot-size'] as const;
type WorkloadName = (typeof WORKLOADS)[number];

/** The fixed compile subset: five example tasks and five real ones (small to large cassettes). */
const COMPILE_EXAMPLES = [
  'tiny-shop/02-add-blue-mug',
  'tiny-shop/07-express-order',
  'tiny-tracker/01-create-bug',
  'tiny-tracker/07-comment',
  'tiny-calendar/04-move-dentist',
];
const COMPILE_REAL = [
  'gitea/g01-create-issue',
  'gitea/g02-close-issue',
  'wordpress/w06-new-post',
  'prestashop/s04-checkout',
  'prestashop/s10-voucher',
];

function parseArgs(argv: string[]) {
  const opts = {
    filter: new Set<WorkloadName>(WORKLOADS),
    iterations: 7,
    warmup: 1,
    json: undefined as string | undefined,
    lib: fileURLToPath(new URL('..', import.meta.url)),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--filter') {
      const names = value().split(',');
      for (const n of names) {
        if (!(WORKLOADS as readonly string[]).includes(n))
          throw new Error(`unknown workload ${n}; one of ${WORKLOADS.join(', ')}`);
      }
      opts.filter = new Set(names as WorkloadName[]);
    } else if (a === '--iterations') opts.iterations = count(a, value(), 1);
    else if (a === '--warmup') opts.warmup = count(a, value(), 0);
    else if (a === '--lib') opts.lib = resolve(value());
    else if (a === '--json') opts.json = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? value() : '-';
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

/** A whole number of passes, at least `min` (rejects NaN, Infinity and fractions). */
function count(name: string, v: string, min: number): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}, got ${v}`);
  return n;
}

const opts = parseArgs(process.argv.slice(2));
if (!Number.isSafeInteger(opts.warmup + opts.iterations))
  throw new Error(`--warmup plus --iterations must be a safe integer, got ${opts.warmup} + ${opts.iterations}`);
/** Data (runs, check sets, cassettes, task definitions) always comes from this checkout. */
const ROOT = new URL('..', import.meta.url);
const at = (path: string) => new URL(path, ROOT);
const load = async <T>(path: string) => (await import(at(path).href)) as T;
/** The library under test: this checkout's src/, or `--lib`'s. */
const LIB = pathToFileURL(opts.lib + '/');
const loadLib = async <T>(path: string) => (await import(new URL(path, LIB).href)) as T;

const assay = await loadLib<typeof Assay>('src/index.ts');
const stress = await loadLib<typeof Stress>('src/stress/index.ts');

// --- Statistics and timing -----------------------------------------------------------

const sorted = (xs: number[]) => xs.toSorted((a, b) => a - b);
/** Median (mean of the two middle values for an even count). */
function median(xs: number[]): number {
  const s = sorted(xs);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
/** Nearest-rank percentile. */
const percentile = (xs: number[], p: number) => sorted(xs)[Math.max(0, Math.ceil((p / 100) * xs.length) - 1)]!;
const gc = (globalThis as { gc?: () => void }).gc;
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

/** Fixed, library-independent CPU work: the machine-speed yardstick. */
const CALIBRATION_TREE = (() => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const node = (depth: number): unknown => {
    if (depth === 0) return rnd() < 0.5 ? `text-${Math.floor(rnd() * 1e6)}` : Math.floor(rnd() * 1e6);
    const o: Record<string, unknown> = {};
    const n = 2 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) o[`k${Math.floor(rnd() * 1000)}`] = node(depth - 1);
    o.children = [node(depth - 1), node(depth - 1)];
    return o;
  };
  return node(6);
})();
function sortKeysCal(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysCal);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).toSorted()) out[k] = sortKeysCal((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}
const calibrationSamples: number[] = [];
function calibrate(samples = 5) {
  for (let s = 0; s < samples; s++) {
    gc?.();
    const t0 = performance.now();
    for (let i = 0; i < 2; i++) {
      const json = JSON.stringify(sortKeysCal(CALIBRATION_TREE));
      createHash('sha256').update(json).digest('hex');
      JSON.parse(json);
    }
    calibrationSamples.push(performance.now() - t0);
  }
}

interface Timed {
  name: WorkloadName;
  kind: 'time';
  description: string;
  items: number;
  item: string;
  iterations: number;
  warmup: number;
  samplesMs: number[];
  medianMs: number;
  p95Ms: number;
  minMs: number;
  /** Items per second at the median. */
  opsPerSec: number;
  /** Median cost of one item, in microseconds. */
  perItemUs: number;
  /** medianMs / calibration median: comparable across machines (roughly). */
  normalized?: number;
  extra?: Record<string, unknown>;
}

interface Sized {
  name: WorkloadName;
  kind: 'size';
  description: string;
  items: number;
  item: string;
  sections: Record<string, { present: number; medianBytes: number; p95Bytes: number; maxBytes: number }>;
}

/**
 * Runs `prepare` (untimed) then the pass it returns (timed), warmup + iterations times.
 * `prepare` builds fresh inputs, so no pass reuses another's objects.
 */
async function timed(
  name: WorkloadName,
  description: string,
  item: string,
  prepare: () => Promise<{ items: number; run: () => Promise<Record<string, number> | void> }>,
  extra: (phases: Record<string, number[]>) => Record<string, unknown> = () => ({}),
): Promise<Timed> {
  calibrate();
  const samples: number[] = [];
  const phases: Record<string, number[]> = {};
  let items = 0;
  for (let i = 0; i < opts.warmup + opts.iterations; i++) {
    const pass = await prepare();
    items = pass.items;
    gc?.();
    const t0 = performance.now();
    const ph = await pass.run();
    const ms = performance.now() - t0;
    if (i < opts.warmup) continue;
    samples.push(ms);
    for (const [k, v] of Object.entries(ph ?? {})) (phases[k] ??= []).push(v);
  }
  const med = median(samples);
  const phaseMedians = Object.fromEntries(Object.entries(phases).map(([k, v]) => [`${k}MedianMs`, round(median(v))]));
  const result: Timed = {
    name,
    kind: 'time',
    description,
    items,
    item,
    iterations: opts.iterations,
    warmup: opts.warmup,
    samplesMs: samples.map((x) => round(x)),
    medianMs: round(med),
    p95Ms: round(percentile(samples, 95)),
    minMs: round(Math.min(...samples)),
    opsPerSec: round((items / med) * 1000, 1),
    perItemUs: round((med / items) * 1000, 1),
    ...(Object.keys(phaseMedians).length || Object.keys(extra(phases)).length
      ? { extra: { ...phaseMedians, ...extra(phases) } }
      : {}),
  };
  console.warn(
    `${name}: median ${result.medianMs.toFixed(1)} ms, p95 ${result.p95Ms.toFixed(1)} ms, ${result.perItemUs.toFixed(0)} µs/${item} (${items} ${item}s)`,
  );
  return result;
}

// --- Data ----------------------------------------------------------------------------

const list = (dir: URL) => (existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith('.')) : []).toSorted();

interface RawRun {
  /** "real:gitea/g01-create-issue" or "examples:tiny-shop/01-newsletter". */
  set: string;
  name: string;
  file: URL;
  gz: boolean;
}

/** Every stored run: the real-app runs, then the example references. */
function runFiles(): RawRun[] {
  const out: RawRun[] = [];
  for (const app of list(at('eval/real/runs/'))) {
    for (const task of list(at(`eval/real/runs/${app}/`))) {
      for (const f of list(at(`eval/real/runs/${app}/${task}/`)).filter((x) => x.endsWith('.json.gz'))) {
        out.push({
          set: `real:${app}/${task}`,
          name: f.replace(/\.json\.gz$/, ''),
          file: at(`eval/real/runs/${app}/${task}/${f}`),
          gz: true,
        });
      }
    }
  }
  for (const app of exampleAppDirs()) {
    for (const task of list(at(`examples/${app}/references/`))) {
      for (const f of list(at(`examples/${app}/references/${task}/`)).filter((x) => x.endsWith('.json'))) {
        out.push({
          set: `examples:${app}/${task}`,
          name: f.replace(/\.json$/, ''),
          file: at(`examples/${app}/references/${task}/${f}`),
          gz: false,
        });
      }
    }
  }
  return out;
}

function exampleAppDirs(): string[] {
  return list(at('examples/')).filter((d) => existsSync(at(`examples/${d}/references/`)));
}

const checksFile = (set: string) => {
  const [kind, path] = set.split(':') as [string, string];
  const [app, task] = path.split('/') as [string, string];
  return kind === 'real'
    ? at(`eval/real/compiled/${app}/${task}.checks.json`)
    : at(`examples/${app}/compiled/${task}.checks.json`);
};

/** Decompressed run text, read once: passes parse from it so every pass gets fresh objects. */
interface RunText {
  set: string;
  name: string;
  text: string;
}
let runTexts: RunText[] | undefined;
const allRunTexts = () =>
  (runTexts ??= runFiles().map((r) => {
    const buf = readFileSync(r.file);
    return { set: r.set, name: r.name, text: (r.gz ? gunzipSync(buf) : buf).toString('utf8') };
  }));

/** Check set text per set, for the sets that have a compiled file. */
let checksTexts: Map<string, string> | undefined;
const allChecksTexts = () => {
  if (checksTexts) return checksTexts;
  checksTexts = new Map();
  for (const r of allRunTexts()) {
    if (checksTexts.has(r.set)) continue;
    const f = checksFile(r.set);
    if (existsSync(f)) checksTexts.set(r.set, readFileSync(f, 'utf8'));
  }
  return checksTexts;
};

/** Runs grouped by check set (only sets with a compiled file). */
function pairsBySet(): Map<string, RunText[]> {
  const sets = allChecksTexts();
  const by = new Map<string, RunText[]>();
  for (const r of allRunTexts()) if (sets.has(r.set)) (by.get(r.set) ?? by.set(r.set, []).get(r.set)!).push(r);
  return by;
}

interface RunJson {
  label: { expected: 'success' | 'fail' };
  snapshot: Assay.EvidenceSnapshot;
}

/** skipVariants per set, as the stress and compile scripts pass them. */
async function skipVariants(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const a of (await load<typeof ExampleApps>('examples/apps.ts')).APPS)
    for (const t of a.tasks) out.set(`examples:${a.name}/${t.id}`, t.skipVariants ?? []);
  for (const a of (await load<typeof RealApps>('eval/real/apps.ts')).APPS)
    for (const t of a.tasks) out.set(`real:${a.name}/${t.id}`, t.skipVariants ?? []);
  return out;
}

const isReference = (name: string) => name === 'reference' || name.startsWith('reference-');

// --- Workloads -----------------------------------------------------------------------

async function benchLoad(): Promise<Timed> {
  const files = runFiles();
  let bytesIn = 0;
  let bytesOut = 0;
  return timed(
    'load',
    'read, gunzip and JSON.parse every stored run (real-app runs and example references)',
    'run',
    async () => ({
      items: files.length,
      run: async () => {
        let read = 0;
        let gunzip = 0;
        let parse = 0;
        bytesIn = 0;
        bytesOut = 0;
        for (const f of files) {
          let t = performance.now();
          const buf = readFileSync(f.file);
          const t1 = performance.now();
          read += t1 - t;
          t = t1;
          const raw = f.gz ? gunzipSync(buf) : buf;
          const t2 = performance.now();
          gunzip += t2 - t;
          JSON.parse(raw.toString('utf8'));
          parse += performance.now() - t2;
          bytesIn += buf.length;
          bytesOut += raw.length;
        }
        return { read, gunzip, parse };
      },
    }),
    () => ({ bytesOnDisk: bytesIn, bytesDecompressed: bytesOut }),
  );
}

async function benchVerify(): Promise<Timed> {
  const groups = pairsBySet();
  const sets = allChecksTexts();
  const pairs = [...groups.entries()].flatMap(([set, runs]) => runs.map((r) => ({ set, text: r.text })));
  const real = pairs.filter((p) => p.set.startsWith('real:')).length;
  return timed(
    'verify',
    'verify() for every (compiled check set, run) pair; each call gets its own parsed check set',
    'pair',
    async () => {
      const jobs = pairs.map((p) => ({
        checkSet: JSON.parse(sets.get(p.set)!) as unknown,
        snapshot: (JSON.parse(p.text) as RunJson).snapshot,
      }));
      return {
        items: jobs.length,
        run: async () => {
          for (const j of jobs) await assay.verify(j.checkSet, j.snapshot);
        },
      };
    },
    () => ({ realPairs: real, examplePairs: pairs.length - real, checkSets: groups.size }),
  );
}

async function benchVerifyBatch(): Promise<Timed> {
  const groups = pairsBySet();
  const sets = allChecksTexts();
  return timed(
    'verify-batch',
    'the verify workload grouped per check set: one parsed check set judges all its runs',
    'pair',
    async () => {
      const batches = [...groups.entries()].map(([set, runs]) => ({
        checkSet: JSON.parse(sets.get(set)!) as unknown,
        snapshots: runs.map((r) => (JSON.parse(r.text) as RunJson).snapshot),
      }));
      return {
        items: batches.reduce((a, b) => a + b.snapshots.length, 0),
        // verifyMany where the library has it; feature-detected so --lib still benches older checkouts.
        run: async () => {
          const many = (assay as { verifyMany?: (cs: unknown, s: unknown[]) => Promise<unknown> }).verifyMany;
          for (const b of batches)
            if (many) await many(b.checkSet, b.snapshots);
            else for (const s of b.snapshots) await assay.verify(b.checkSet, s);
        },
      };
    },
    () => ({ checkSets: groups.size }),
  );
}

async function benchStress(): Promise<Timed> {
  const groups = pairsBySet();
  const sets = allChecksTexts();
  const skip = await skipVariants();
  // Real sets: the reference runs (the compiler's correct runs). Examples: every correct reference, as scripts/stress.ts.
  const inputs = [...groups.entries()].map(([set, runs]) => ({
    set,
    runs: runs.filter((r) =>
      set.startsWith('real:') ? isReference(r.name) : (JSON.parse(r.text) as RunJson).label.expected === 'success',
    ),
  }));
  const real = inputs.filter((i) => i.set.startsWith('real:')).length;
  let variants = 0;
  let mutants = 0;
  return timed(
    'stress',
    'stressTest() on every compiled check set over its correct reference runs',
    'check set',
    async () => {
      const jobs = inputs.map((i) => ({
        set: i.set,
        checkSet: JSON.parse(sets.get(i.set)!) as Assay.CheckSet,
        refs: i.runs.map((r) => ({ name: r.name, snapshot: (JSON.parse(r.text) as RunJson).snapshot })),
      }));
      return {
        items: jobs.length,
        run: async () => {
          variants = 0;
          mutants = 0;
          for (const j of jobs) {
            const r = stress.stressTest(j.checkSet, j.refs, { skipVariants: skip.get(j.set) ?? [] });
            variants += r.rates.variantsTotal;
            mutants += r.rates.mutantsTotal;
          }
        },
      };
    },
    () => ({ realSets: real, exampleSets: inputs.length - real, variants, mutants }),
  );
}

interface CompileJob {
  id: string;
  task: Compiler.TaskInput;
  refs: { name: string; kind: 'success'; note?: string; file: URL; gz: boolean }[];
  cassette: string;
  checks: URL;
}

async function compileJobs(): Promise<CompileJob[]> {
  const examples = (await load<typeof ExampleApps>('examples/apps.ts')).APPS;
  const { compileReference } = await load<typeof Scenario>('examples/lib/scenario.ts');
  const realApps = (await load<typeof RealApps>('eval/real/apps.ts')).APPS;
  const jobs: CompileJob[] = [];
  // As scripts/compile-examples.ts: the instruction and outcomes of the handwritten set, one correct reference.
  for (const id of COMPILE_EXAMPLES) {
    const [appName, taskId] = id.split('/') as [string, string];
    const app = examples.find((a) => a.name === appName);
    const def = app?.tasks.find((t) => t.id === taskId);
    if (!app || !def) throw new Error(`compile-replay: unknown example task ${id}`);
    const hand = JSON.parse(readFileSync(new URL(`tasks/${taskId}.checks.json`, app.dir), 'utf8')) as Assay.CheckSet;
    const ref = compileReference(def).name;
    jobs.push({
      id,
      task: {
        id,
        instruction: hand.task.instruction,
        ...(hand.task.outcomes !== undefined ? { outcomes: hand.task.outcomes } : {}),
        ...(def.skipVariants ? { skipVariants: def.skipVariants } : {}),
      },
      refs: [{ name: ref, kind: 'success', file: new URL(`references/${taskId}/${ref}.json`, app.dir), gz: false }],
      cassette: fileURLToPath(new URL(`compiled/${taskId}.cassette.json`, app.dir)),
      checks: new URL(`compiled/${taskId}.checks.json`, app.dir),
    });
  }
  // As eval/real/compile.ts: the reference first, then the other routes in name order, with route notes.
  for (const id of COMPILE_REAL) {
    const [appName, taskId] = id.split('/') as [string, string];
    const t = realApps.find((a) => a.name === appName)?.tasks.find((x) => x.id === taskId);
    if (!t) throw new Error(`compile-replay: unknown real task ${id}`);
    const dir = at(`eval/real/runs/${appName}/${taskId}/`);
    const names = list(dir)
      .filter((f) => f.endsWith('.json.gz'))
      .map((f) => f.replace(/\.json\.gz$/, ''))
      .filter(isReference)
      .toSorted((a, b) => (a === 'reference' ? -1 : b === 'reference' ? 1 : 0));
    const routes = names.length > 1;
    jobs.push({
      id,
      task: { id, instruction: t.instruction, ...(t.skipVariants?.length ? { skipVariants: t.skipVariants } : {}) },
      refs: names.map((name) => {
        const file = new URL(`${name}.json.gz`, dir);
        const note = !routes
          ? undefined
          : name === 'reference'
            ? t.route
            : (() => {
                const src = (
                  JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as {
                    source: { type: string; route?: string };
                  }
                ).source;
                return src.type === 'reference' ? src.route : undefined;
              })();
        return { name, kind: 'success' as const, file, gz: true, ...(note ? { note } : {}) };
      }),
      cassette: fileURLToPath(at(`eval/real/compiled/${appName}/${taskId}.cassette.json`)),
      checks: at(`eval/real/compiled/${appName}/${taskId}.checks.json`),
    });
  }
  return jobs;
}

async function benchCompileReplay(): Promise<Timed> {
  const compiler = await loadLib<typeof Compiler>('src/compiler/index.ts');
  const models = await loadLib<typeof Models>('src/model/index.ts');
  const { costUsd, PRICING } = await loadLib<typeof Metrics>('src/eval/metrics.ts');
  const jobs = await compileJobs();
  let reports: { id: string; report: Compiler.CompileReport; reproduced: boolean }[] = [];
  return timed(
    'compile-replay',
    `compileTask() replayed from cassettes (no API key) for ${jobs.length} fixed tasks`,
    'compile',
    async () => {
      const prepared = jobs.map((j) => ({
        ...j,
        refs: j.refs.map(({ file, gz, ...r }) => {
          const buf = readFileSync(file);
          return { ...r, snapshot: (JSON.parse((gz ? gunzipSync(buf) : buf).toString('utf8')) as RunJson).snapshot };
        }),
      }));
      return {
        items: prepared.length,
        run: async () => {
          const out: typeof reports = [];
          for (const j of prepared) {
            const model = models.replayModel(j.cassette);
            const { checkSet, report } = await compiler.compileTask(j.task, j.refs, {
              model,
              provenance: model.recorded,
            });
            // A compile that stops early would time as fast: fail the workload instead.
            if (!checkSet || report.status !== 'compiled')
              throw new Error(`${j.id} did not compile: ${report.reason ?? report.status}`);
            out.push({
              id: j.id,
              report,
              reproduced: !!checkSet && JSON.stringify(checkSet, null, 2) + '\n' === readFileSync(j.checks, 'utf8'),
            });
          }
          reports = out;
        },
      };
    },
    () => {
      const tasks = reports.map(({ id, report, reproduced }) => {
        const turns = report.turns.rubric + report.turns.discovery;
        const price =
          PRICING[
            report.model
              .replace(/^anthropic:/, '')
              .replace(/@.*$/, '')
              .replace(/ \(replay\)$/, '')
          ];
        return {
          task: id,
          status: report.status,
          reproduced,
          turns,
          inputTokens: report.usage.inputTokens,
          outputTokens: report.usage.outputTokens,
          cacheReadTokens: report.usage.cacheReadTokens ?? 0,
          cacheWriteTokens: report.usage.cacheWriteTokens ?? 0,
          costUsd: round(costUsd(report.usage, price), 4),
        };
      });
      const n = tasks.length || 1;
      const sum = (k: 'turns' | 'inputTokens' | 'outputTokens' | 'costUsd') => tasks.reduce((a, t) => a + t[k], 0);
      return {
        reproduced: tasks.filter((t) => t.reproduced).length,
        turnsPerCompile: round(sum('turns') / n, 2),
        inputTokensPerCompile: Math.round(sum('inputTokens') / n),
        outputTokensPerCompile: Math.round(sum('outputTokens') / n),
        costUsdPerCompile: round(sum('costUsd') / n, 4),
        tasks,
      };
    },
  );
}

/**
 * Mining (ADR 0020) for every example and real-app task: `compileTask` with
 * `discovery: "mine-only"` and the deterministic rubric, so no model runs. Generation, batch
 * evaluation over the references and their stress variants, ranking and the acceptance gate.
 */
async function benchMine(): Promise<Timed> {
  const compiler = await loadLib<typeof Compiler>('src/compiler/index.ts');
  if (!('mineCandidates' in compiler)) throw new Error('this library has no mining compiler');
  const examples = (await load<typeof ExampleApps>('examples/apps.ts')).APPS;
  const { compileReference } = await load<typeof Scenario>('examples/lib/scenario.ts');
  const realApps = (await load<typeof RealApps>('eval/real/apps.ts')).APPS;
  const jobs: { task: Compiler.TaskInput; refs: { name: string; text: string }[] }[] = [];
  const texts = new Map(allRunTexts().map((r) => [`${r.set}/${r.name}`, r.text]));
  for (const app of examples)
    for (const def of app.tasks) {
      const hand = JSON.parse(readFileSync(new URL(`tasks/${def.id}.checks.json`, app.dir), 'utf8')) as Assay.CheckSet;
      const ref = compileReference(def).name;
      const text = texts.get(`examples:${app.name}/${def.id}/${ref}`);
      if (!text) continue;
      jobs.push({
        task: {
          id: `${app.name}/${def.id}`,
          instruction: hand.task.instruction,
          ...(hand.task.outcomes !== undefined ? { outcomes: hand.task.outcomes } : {}),
          ...(def.skipVariants ? { skipVariants: def.skipVariants } : {}),
        },
        refs: [{ name: ref, text }],
      });
    }
  for (const app of realApps)
    for (const t of app.tasks) {
      const refs = [...texts.entries()]
        .filter(([k]) => k.startsWith(`real:${app.name}/${t.id}/`) && isReference(k.split('/').at(-1)!))
        .map(([k, text]) => ({ name: k.split('/').at(-1)!, text }))
        .toSorted((a, b) => (a.name === 'reference' ? -1 : b.name === 'reference' ? 1 : a.name < b.name ? -1 : 1));
      if (!refs.length) continue;
      jobs.push({
        task: {
          id: `${app.name}/${t.id}`,
          instruction: t.instruction,
          ...(t.skipVariants?.length ? { skipVariants: t.skipVariants } : {}),
        },
        refs,
      });
    }
  let compiled = 0;
  let covered = 0;
  let requirements = 0;
  let candidates = 0;
  return timed(
    'mine',
    `compileTask() with discovery "mine-only" and the deterministic rubric (no model) for ${jobs.length} tasks`,
    'task',
    async () => {
      const prepared = jobs.map((j) => ({
        task: j.task,
        refs: j.refs.map((r) => ({
          name: r.name,
          kind: 'success' as const,
          snapshot: (JSON.parse(r.text) as RunJson).snapshot,
        })),
      }));
      return {
        items: prepared.length,
        run: async () => {
          compiled = covered = requirements = candidates = 0;
          for (const j of prepared) {
            const { checkSet, report } = await compiler.compileTask(j.task, j.refs, {
              discovery: 'mine-only',
              rubric: 'deterministic',
            });
            if (checkSet) compiled++;
            const m = report.mining;
            if (!m) throw new Error(`${j.task.id}: ${report.reason}`);
            candidates += m.candidates;
            requirements += m.requirements.length;
            covered += m.requirements.filter((r) => r.status === 'covered').length;
          }
        },
      };
    },
    () => ({ tasks: jobs.length, compiled, requirements, covered, candidates }),
  );
}

function benchSnapshotSize(): Sized {
  const runs = allRunTexts().filter((r) => r.set.startsWith('real:'));
  const sizes = new Map<string, number[]>();
  for (const r of runs) {
    const snap = (JSON.parse(r.text) as RunJson).snapshot as unknown as Record<string, unknown>;
    let total = 0;
    for (const [k, v] of Object.entries(snap)) {
      const b = Buffer.byteLength(JSON.stringify(v));
      total += b;
      (sizes.get(k) ?? sizes.set(k, []).get(k)!).push(b);
    }
    (sizes.get('(total)') ?? sizes.set('(total)', []).get('(total)')!).push(total);
  }
  const sections = Object.fromEntries(
    [...sizes.entries()]
      .toSorted((a, b) => median(b[1]) - median(a[1]))
      .map(([k, v]) => [
        k,
        { present: v.length, medianBytes: median(v), p95Bytes: percentile(v, 95), maxBytes: Math.max(...v) },
      ]),
  );
  console.warn(`snapshot-size: ${runs.length} real-app snapshots, median total ${sections['(total)']?.medianBytes} B`);
  return {
    name: 'snapshot-size',
    kind: 'size',
    description: 'JSON bytes per snapshot section across the real-app runs (absent sections not counted)',
    items: runs.length,
    item: 'snapshot',
    sections,
  };
}

// --- Main ----------------------------------------------------------------------------

interface Failed {
  name: WorkloadName;
  kind: 'error';
  error: string;
}
const results: (Timed | Sized | Failed)[] = [];
const runners: Record<WorkloadName, () => Promise<Timed | Sized> | Sized> = {
  load: benchLoad,
  verify: benchVerify,
  'verify-batch': benchVerifyBatch,
  stress: benchStress,
  'compile-replay': benchCompileReplay,
  mine: benchMine,
  'snapshot-size': benchSnapshotSize,
};
if (!gc) console.warn('(run with node --expose-gc for steadier numbers: npm run bench does)');
// A workload that fails (e.g. an older --lib checkout lacks what it uses) is recorded and the others still run.
for (const name of WORKLOADS) {
  if (!opts.filter.has(name)) continue;
  try {
    results.push(await runners[name]());
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`${name}: failed: ${error}`);
    results.push({ name, kind: 'error', error });
    process.exitCode = 1;
  }
}
calibrate();
const calibrationMs = median(calibrationSamples);
for (const r of results) if (r.kind === 'time') r.normalized = round(r.medianMs / calibrationMs, 4);

const output = {
  schema: 'assay.bench/v1',
  note: 'Absolute times depend on the machine; compare `normalized` (median / calibration median) across machines.',
  recordedAt: new Date().toISOString(),
  env: {
    node: process.version,
    platform: `${platform()}-${arch()}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    cpus: cpus().length,
  },
  options: { iterations: opts.iterations, warmup: opts.warmup, gc: !!gc },
  calibration: { medianMs: round(calibrationMs), samples: calibrationSamples.length },
  results,
};

const table = [
  '| Workload | Items | Median ms | p95 ms | ops/s | µs per item | normalized |',
  '|---|---:|---:|---:|---:|---:|---:|',
  ...results
    .filter((r): r is Timed => r.kind === 'time')
    .map(
      (r) =>
        `| ${r.name} | ${r.items} ${r.item}s | ${r.medianMs.toFixed(1)} | ${r.p95Ms.toFixed(1)} | ${r.opsPerSec.toFixed(1)} | ${r.perItemUs.toFixed(0)} | ${r.normalized?.toFixed(2)} |`,
    ),
  `| calibration | | ${calibrationMs.toFixed(2)} | | | | 1.00 |`,
].join('\n');

if (opts.json === '-') {
  console.warn(table);
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(table);
  if (opts.json) {
    mkdirSync(dirname(opts.json), { recursive: true });
    writeFileSync(opts.json, JSON.stringify(output, null, 2) + '\n');
  }
}
