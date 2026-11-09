/**
 * `assay bench`: compare models on this project's own tasks (ADR 0018). Finds the tasks and
 * their labelled runs, works out the models, and hands both to the runner; prints a table,
 * JSON or a Markdown report.
 */
import { existsSync, globSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ConfigError,
  escapeGlob,
  strategyListError,
  type BenchModelInput,
  type LoadedConfig,
} from '../../config/config.ts';
import type { DiscoveryStrategy } from '../../compiler/index.ts';
import { describeModel, resolveModel, type ModelInput, type ModelOptions } from '../../model/resolve.ts';
import type { ModelClient } from '../../model/types.ts';
import { benchJson, formatBench, formatBenchMarkdown } from '../bench/format.ts';
import { priceBook, readPriceFile } from '../bench/prices.ts';
import { runBench, type BenchModel, type BenchRun, type BenchTask, type CassetteMode } from '../bench/run.ts';
import { cliConfig } from '../config.ts';
import {
  CliError,
  EXIT,
  UsageError,
  readCheckSetFile,
  readJson,
  readSnapshots,
  toSnapshot,
  type Invocation,
  type Io,
  type Values,
} from '../io.ts';
import { chooseLive } from '../model.ts';
import { resolveTask } from './compile.ts';
import { CHECK_SET_GLOBS, isModuleFile } from '../../checks/load.ts';

/** Exit status of a bench stopped with Ctrl-C (128 + SIGINT), after printing what finished. */
export const EXIT_INTERRUPTED = 130;

const str = (x: unknown) => (typeof x === 'string' ? x : undefined);
const TASK_FILE = /\.(checks\.(json|ts|mts|js|mjs)|task\.json)$/i;
const taskName = (file: string) =>
  basename(file)
    .replace(TASK_FILE, '')
    .replace(/\.json$/, '');

function positiveInt(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1)
    throw new UsageError(`${flag} must be a positive integer, got ${JSON.stringify(v)}`);
  return n;
}

/** Task files: every `*.checks.json`, `*.checks.ts` and `*.task.json` under a directory, a file, or a glob. */
export function taskFiles(spec: string): string[] {
  let files: string[];
  if (existsSync(spec)) {
    files = statSync(spec).isDirectory()
      ? [...CHECK_SET_GLOBS, '**/*.task.json'].flatMap((g) => globSync(g, { cwd: spec })).map((f) => join(spec, f))
      : [spec];
  } else files = globSync(spec);
  return [...new Set(files)].toSorted();
}

/** Runs named `reference` or `reference-<route>` are what a task compiles from (as in eval/real, ADR 0009). */
const isReferenceName = (name: string) => name === 'reference' || name.startsWith('reference-');

/**
 * The runs a task compiles from: those its task file names (`"references": [...]`), else runs
 * named `reference` / `reference-*`, else its first correct run by name. Every other labelled
 * run is held out and scores the compiled checks.
 */
export function splitRuns(
  runs: BenchRun[],
  named: string[] | undefined,
  where: string,
): Pick<BenchTask, 'training' | 'heldOut'> {
  let training: BenchRun[];
  if (named) {
    const missing = named.filter((n) => !runs.some((r) => r.name === n));
    if (missing.length) throw new CliError(`${where}: no run named ${missing.map((m) => `"${m}"`).join(', ')}`);
    training = runs.filter((r) => named.includes(r.name));
  } else if (runs.some((r) => isReferenceName(r.name))) {
    training = runs.filter((r) => isReferenceName(r.name));
  } else {
    const first = runs.find((r) => r.expected !== 'fail');
    training = first ? [first] : [];
  }
  const heldOut = runs.filter(
    (r): r is BenchRun & { expected: 'success' | 'fail' } => !training.includes(r) && r.expected !== undefined,
  );
  return { training, heldOut };
}

interface Found {
  tasks: BenchTask[];
  skipped: string[];
}

/**
 * The directory a task spec's files are under: the directory itself, a file's directory, or a
 * glob's leading literal directories (a config glob escapes its own directory as `[*]` etc.).
 */
export function tasksDir(spec: string): string {
  if (existsSync(spec)) return statSync(spec).isDirectory() ? spec : dirname(spec);
  const literal = /^(?:[^*?[\]{}]|\[[*?[\]{}]\])*$/;
  const parts = spec.split(/[\\/]/);
  const fixed: string[] = [];
  for (const part of parts.slice(0, -1)) {
    if (!literal.test(part)) break;
    fixed.push(part.replace(/\[([*?[\]{}])\]/g, '$1'));
  }
  return fixed.join(sep) || (isAbsolute(spec) ? sep : '.');
}

/** Does a `--task` filter (a name, a glob, or a path absolute or relative to `cwd`) pick this task file? */
const picks = (p: string, name: string, file: string, shown: string, cwd: string) =>
  p === name ||
  matchesGlob(name, p) ||
  matchesGlob(shown, p) ||
  resolve(cwd, p) === resolve(file) ||
  matchesGlob(resolve(file), isAbsolute(p) ? p : `${escapeGlob(resolve(cwd))}/${p}`);

/**
 * `base` is what file paths in the report are relative to (the config's directory), so a report
 * reads the same from anywhere; `cwd` is what a `--task` path is relative to.
 */
export async function findTasks(
  spec: string,
  referencesDir: string,
  filters: string[],
  base: string,
  cwd: string = base,
): Promise<Found> {
  const files = taskFiles(spec);
  if (!files.length) throw new CliError(`no task files (*.checks.json, *.checks.ts, *.task.json) at ${spec}`);
  const tasks: BenchTask[] = [];
  const skipped: string[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const name = taskName(file);
    const shown = relative(base, file) || file;
    if (filters.length && !filters.some((p) => picks(p, name, file, shown, cwd))) continue;
    if (seen.has(name)) throw new CliError(`two task files are named "${name}": ${seen.get(name)} and ${shown}`);
    seen.set(name, shown);
    const dir = join(referencesDir, name);
    if (!existsSync(dir)) {
      skipped.push(`${name}: no runs at ${relative(base, dir) || dir}`);
      continue;
    }
    const json = (isModuleFile(file) ? await readCheckSetFile(file, 'task') : readJson(file, 'task')) as Record<
      string,
      unknown
    >;
    const named = Array.isArray(json?.references)
      ? (json.references as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined;
    const runs: BenchRun[] = readSnapshots(dir).map((f) => ({
      name: f.name,
      ...(f.expected ? { expected: f.expected } : {}),
      snapshot: toSnapshot(f),
    }));
    const split = splitRuns(runs, named, shown);
    if (!split.training.length) {
      skipped.push(`${name}: no correct run to compile from`);
      continue;
    }
    tasks.push({ name, file: shown, task: await resolveTask(file, {}), ...split });
  }
  tasks.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { tasks, skipped };
}

/** A model given as a module path: `./my-adapter.ts`, `../models/x.js`, `/abs/x.mjs`. */
export const isModulePath = (s: string) => /^(\.{1,2}[\\/]|\/)/.test(s) || /\.(c|m)?[jt]s$/.test(s);

/** A model's cassette directory name. */
export function slugOf(label: string): string {
  if (isModulePath(label)) return basename(label, extname(label));
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'model'
  );
}

interface Spec {
  label: string;
  input: ModelInput;
  options: ModelOptions;
  /** Where a module path or provider package is resolved from. */
  base: string;
}

function memo<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= load());
}

async function loadModule(path: string, base: string): Promise<ModelInput> {
  const file = resolve(base, path);
  if (!existsSync(file)) throw new Error(`model module not found: ${file}`);
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown; model?: unknown };
  const input = mod.default ?? mod.model;
  if (input === undefined) throw new Error(`${path} exports no model (export default a model or an adapter)`);
  return input as ModelInput;
}

function specModel(s: Spec): BenchModel {
  return {
    label: s.label,
    slug: slugOf(s.label),
    resolve: memo(async (): Promise<ModelClient> => {
      const input = typeof s.input === 'string' && isModulePath(s.input) ? await loadModule(s.input, s.base) : s.input;
      return resolveModel(input, { ...s.options, cwd: s.base });
    }),
  };
}

const isNamed = (m: BenchModelInput): m is { name: string; model: ModelInput; options?: ModelOptions } =>
  !!m && typeof m === 'object' && 'name' in m && 'model' in m && !('turn' in m);

/** The models, by precedence: `--model` flags, then `bench.models`, then the one model `compile` would use. */
export function benchModels(
  values: Values,
  env: Record<string, string | undefined>,
  loaded: LoadedConfig,
  cwd: string,
): BenchModel[] {
  const { config } = loaded;
  const base = loaded.path ? dirname(loaded.path) : cwd;
  // The config's modelOptions apply to every model, except `id`, which names the config's own model.
  const { id: _id, ...shared } = config.modelOptions ?? {};
  const flags = (values.model as string[] | undefined) ?? [];
  let models: BenchModel[];
  if (flags.length) {
    models = flags.map((m) => specModel({ label: m, input: m, options: shared, base: cwd }));
  } else if (config.bench?.models) {
    models = config.bench.models.map((m) =>
      isNamed(m)
        ? specModel({ label: m.name, input: m.model, options: { ...shared, ...m.options }, base })
        : specModel({ label: typeof m === 'string' ? m : describeModel(m), input: m, options: shared, base }),
    );
  } else {
    const label =
      env.ASSAY_MODEL ||
      (config.model !== undefined
        ? describeModel(config.model, config.modelOptions)
        : env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN
          ? 'claude-opus-5-5'
          : undefined);
    if (!label)
      throw new UsageError(
        'assay bench needs models to compare: --model <provider:model|./adapter.ts> (repeatable), `bench.models` or `model` in assay.config.ts',
      );
    models = [{ label, slug: slugOf(label), resolve: memo(() => chooseLive({}, env, loaded, 'bench')) }];
  }
  const labels = new Set<string>();
  const slugs = new Map<string, string>();
  for (const m of models) {
    if (labels.has(m.label)) throw new UsageError(`model "${m.label}" is given twice`);
    labels.add(m.label);
    const other = slugs.get(m.slug);
    if (other)
      throw new UsageError(`models "${other}" and "${m.label}" would share the cassette directory "${m.slug}"`);
    slugs.set(m.slug, m.label);
  }
  return models;
}

/**
 * The discovery strategies, by precedence: `--discovery` (comma-separated, repeatable), then
 * `bench.discovery`, then `['model']` (the bench as before ADR 0026).
 */
export function benchStrategies(values: Values, loaded: LoadedConfig): DiscoveryStrategy[] {
  const flags = (values.discovery as string[] | undefined) ?? [];
  if (flags.length) {
    const list = flags.flatMap((f) => f.split(',')).map((s) => s.trim());
    const err = strategyListError(list);
    if (err) throw new UsageError(`--discovery ${err}`);
    return list as DiscoveryStrategy[];
  }
  return loaded.config.bench?.discovery ?? ['model'];
}

/** A `--prices` file, its problems as a command error (exit 4), like a bad config. */
function priceFile(file: string, shown: string) {
  try {
    return readPriceFile(file, shown);
  } catch (e) {
    if (e instanceof ConfigError) throw new CliError(e.message);
    throw e;
  }
}

/** Ctrl-C stops the bench: the first one prints what finished, a second one exits at once. */
function sigint(): { signal: AbortSignal; dispose(): void } {
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once('SIGINT', stop);
  return { signal: ac.signal, dispose: () => process.off('SIGINT', stop) };
}

/** `assay bench`: run the comparison and print it; exit 1 when a job errored, 130 when stopped. */
export async function run({ values }: Invocation, io: Io): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const loaded = await cliConfig(values, io);
  const { config } = loaded;
  const bench = config.bench ?? {};
  const base = loaded.path ? dirname(loaded.path) : cwd;

  const tasksFlag = str(values.tasks);
  const tasksSpec = tasksFlag !== undefined ? resolve(cwd, tasksFlag) : (bench.tasks ?? config.checks);
  if (!tasksSpec)
    throw new UsageError('no tasks: pass --tasks <dir|glob>, or set `bench.tasks` or `checks` in assay.config.ts');
  const refsFlag = str(values.references);
  const referencesDir =
    refsFlag !== undefined
      ? resolve(cwd, refsFlag)
      : (bench.references ?? join(dirname(resolve(base, tasksDir(tasksSpec))), 'references'));
  const runs = positiveInt(str(values.runs), '--runs') ?? bench.runs ?? 1;
  const concurrency = positiveInt(str(values.concurrency), '--concurrency') ?? bench.concurrency ?? 2;
  const envMode = io.env.ASSAY_MODEL_MODE || undefined;
  if (envMode !== undefined && envMode !== 'replay' && envMode !== 'record')
    throw new CliError(`ASSAY_MODEL_MODE must be "replay" or "record", got ${JSON.stringify(envMode)}`);
  if (values.record && envMode === 'replay') throw new UsageError('--record and ASSAY_MODEL_MODE=replay contradict');
  const mode: CassetteMode =
    values.record || envMode === 'record' ? 'record' : envMode === 'replay' ? 'replay' : 'auto';
  const cassettesFlag = str(values.cassettes);
  const cassettes =
    cassettesFlag !== undefined ? resolve(cwd, cassettesFlag) : (bench.cassettes ?? join(base, 'assay-bench'));

  const strategies = benchStrategies(values, loaded);
  // mine-only runs no model: a bench of it alone needs none.
  const needsModel = strategies.some((s) => s !== 'mine-only');
  const models = needsModel ? benchModels(values, io.env, loaded, cwd) : [];
  if (!needsModel && values.model) io.err('mine-only runs no model: --model is not used');
  const pricesFlag = str(values.prices);
  const prices = priceBook({
    ...(pricesFlag !== undefined ? { file: priceFile(resolve(cwd, pricesFlag), pricesFlag) } : {}),
    ...(bench.prices ? { config: bench.prices } : {}),
  });
  const { tasks, skipped } = await findTasks(
    tasksSpec,
    referencesDir,
    (values.task as string[] | undefined) ?? [],
    base,
    cwd,
  );
  for (const s of skipped) io.err(`skipped ${s}`);
  if (!tasks.length) {
    throw new CliError(
      values.task
        ? `no task matches --task ${(values.task as string[]).join(', ')}`
        : `no task has runs under ${referencesDir}`,
    );
  }

  const interrupt = io.signal ? undefined : sigint();
  const shownCassettes = relative(cwd, cassettes) || '.';
  const shownStrategies = strategies.length === 1 && strategies[0] === 'model' ? '' : ` (${strategies.join(', ')})`;
  io.err(
    `Benchmarking ${models.length} model(s)${shownStrategies} on ${tasks.length} task(s)${runs > 1 ? ` × ${runs} runs` : ''}` +
      (mode === 'record'
        ? `, recording to ${shownCassettes}`
        : mode === 'replay'
          ? `, replaying ${shownCassettes}`
          : ''),
  );
  let result;
  try {
    result = await runBench({
      tasks,
      models,
      runs,
      concurrency,
      cassettes,
      mode,
      escalate: !!values.escalate,
      discovery: strategies,
      prices,
      ...(config.stress ? { stress: config.stress } : {}),
      ...((io.signal ?? interrupt?.signal) ? { signal: (io.signal ?? interrupt?.signal)! } : {}),
      onJob(j, n, total) {
        const what =
          j.status === 'compiled'
            ? `compiled (${j.turns} turns${j.stress && !j.stress.clean ? `; stress: ${j.stress.problems.join(', ')}` : ''})`
            : j.status === 'refused'
              ? `not compiled: ${j.reason}`
              : `error: ${j.reason}`;
        const row =
          j.discovery === 'mine-only'
            ? 'mine-only'
            : `${j.model}${j.discovery && shownStrategies ? ` · ${j.discovery}` : ''}`;
        io.err(`[${n}/${total}] ${row} · ${j.task}${runs > 1 ? ` · run ${j.run}` : ''}: ${what}`);
      },
    });
  } finally {
    interrupt?.dispose();
  }

  const out = str(values.out);
  if (out) {
    mkdirSync(dirname(resolve(cwd, out)), { recursive: true });
    writeFileSync(resolve(cwd, out), formatBenchMarkdown(result));
  }
  io.out(values.json ? benchJson(result) : formatBench(result, io.color));
  if (out) io.err(`Wrote ${out}`);
  if (result.interrupted) {
    // Jobs still in flight (a live model call) would keep the process alive: leave once the output is out.
    if (interrupt) setTimeout(() => process.exit(EXIT_INTERRUPTED), 100).unref();
    return EXIT_INTERRUPTED;
  }
  return result.models.some((m) => m.jobs.some((j) => j.status === 'error')) ? EXIT.fail : EXIT.ok;
}
