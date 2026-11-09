/**
 * `assay watch`: the edit loop for check sets (ADR 0019). Watches check set files
 * (`*.checks.json`, `*.checks.ts`), the modules they import, and their runs; on a change it
 * validates the sets that changed, verifies their runs again with `verifyMany` and prints a
 * compact table of verdicts with what changed since the previous run. No model and no lock:
 * it is a development loop.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CheckSet, EvidenceSnapshot, Status, Verdict } from '../../types.ts';
import { validateCheckSet, verifyMany } from '../../index.ts';
import { stressTest } from '../../stress/index.ts';
import { checkSetName, discoverSets, isModuleFile, loadCheckSetFileWithDeps } from '../../checks/load.ts';
import { CliError, EXIT, UsageError, paint, readSnapshotFile, toSnapshot, type Invocation, type Io } from '../io.ts';
import { cliConfig } from '../config.ts';
import { problems } from './stress.ts';
import { tasksDir } from './bench.ts';

interface RunResult {
  name: string;
  file: string;
  expected?: 'success' | 'fail';
  verdict?: Verdict;
  /** Check id → status. */
  checks: Record<string, Status>;
  error?: string;
}

export interface SetResult {
  file: string;
  name: string;
  /** Could not be read or loaded. */
  error?: string;
  errors: string[];
  warnings: string[];
  checkSet?: { id: string; version: string; requirements: number; checks: number };
  runs: RunResult[];
  /** Where runs are looked for (when there are none). */
  runDirs: string[];
  /** The local files a module set loaded (itself and its imports): a change to one re-verifies the set. */
  deps: string[];
  stress?: string;
}

export { discoverSets };

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Editor and tool scratch files, and paths in .git and node_modules: never a change worth a
 * round. Other hidden files (a helper under `.data/`, a run named `.baseline.json`) count.
 */
export function isScratch(path: string): boolean {
  const parts = path.split(/[\\/]/);
  if (parts.includes('.git') || parts.includes('node_modules')) return true;
  const name = parts.at(-1) ?? '';
  return /^\.#|~$|\.(swp|swo|swx|tmp)$|^4913$|^\.DS_Store$/.test(name);
}

/** Where a set's runs live: `<root>/<name>/` for each run root, and references/ next to the set's directory. */
export function runDirsFor(file: string, roots: string[]): string[] {
  const all = [...roots, join(dirname(dirname(file)), 'references')];
  return [...new Set(all.map((r) => join(r, checkSetName(file))))];
}

interface CachedRun {
  hash: string;
  expected?: 'success' | 'fail';
  snapshot: EvidenceSnapshot;
}

/**
 * Snapshots read once per version of a run file's contents: the same object keeps its evidence
 * store (ADR 0015). Runs that are no longer watched are evicted after each round.
 */
export class RunCache {
  readonly #runs = new Map<string, CachedRun>();
  read(file: string): CachedRun {
    const text = readFileSync(file);
    const hash = createHash('sha256').update(text).digest('hex');
    const hit = this.#runs.get(file);
    if (hit && hit.hash === hash) return hit;
    const f = readSnapshotFile(file);
    const entry: CachedRun = { hash, ...(f.expected ? { expected: f.expected } : {}), snapshot: toSnapshot(f) };
    this.#runs.set(file, entry);
    return entry;
  }
  /** Keep only these run files. */
  prune(keep: Set<string>): void {
    for (const f of this.#runs.keys()) if (!keep.has(f)) this.#runs.delete(f);
  }
  get files(): string[] {
    return [...this.#runs.keys()];
  }
}

export interface CheckOptions {
  roots: string[];
  stress: boolean;
  skipVariants: string[];
  successClaims?: boolean;
  cache: RunCache;
  /** Load modules in a fresh process (and learn what they import). */
  fresh: boolean;
  signal?: AbortSignal;
}

/** Load, validate and verify one set against its runs (and stress-test it). */
export async function checkSet(file: string, opts: CheckOptions): Promise<SetResult> {
  const runDirs = runDirsFor(file, opts.roots);
  const base: SetResult = { file, name: checkSetName(file), errors: [], warnings: [], runs: [], runDirs, deps: [] };
  let input: unknown;
  try {
    const loaded = await loadCheckSetFileWithDeps(file, {
      fresh: opts.fresh && isModuleFile(file),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    input = loaded.value;
    base.deps = loaded.deps;
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
  const report = validateCheckSet(input);
  if (!report.ok) return { ...base, errors: report.errors, warnings: report.warnings };
  const cs = input as CheckSet;
  const res: SetResult = {
    ...base,
    warnings: report.warnings,
    checkSet: { id: cs.id, version: cs.version, requirements: cs.requirements.length, checks: cs.checks.length },
  };
  const files = runDirs
    .filter((d) => existsSync(d) && statSync(d).isDirectory())
    .flatMap((d) =>
      readdirSync(d)
        .filter((f) => f.endsWith('.json'))
        .toSorted()
        .map((f) => join(d, f)),
    );
  const ok: { run: RunResult; snapshot: EvidenceSnapshot }[] = [];
  for (const f of files) {
    const runResult: RunResult = { name: basename(f, '.json'), file: f, checks: {} };
    try {
      const r = opts.cache.read(f);
      if (r.expected) runResult.expected = r.expected;
      ok.push({ run: runResult, snapshot: r.snapshot });
    } catch (e) {
      runResult.error = (e as Error).message;
    }
    res.runs.push(runResult);
  }
  if (ok.length) {
    try {
      const results = await verifyMany(
        cs,
        ok.map((o) => o.snapshot),
        { config: false },
      );
      results.forEach((r, i) => {
        const one = ok[i]!.run;
        one.verdict = r.outcome.verdict;
        one.checks = Object.fromEntries(r.outcome.checks.map((c) => [c.check, c.status]));
      });
    } catch (e) {
      for (const o of ok) o.run.error = (e as Error).message;
    }
  }
  if (opts.stress) {
    const refs = ok.filter((o) => o.run.expected !== 'fail').map((o) => ({ name: o.run.name, snapshot: o.snapshot }));
    if (!refs.length) res.stress = 'no correct run to stress-test';
    else {
      try {
        const stressed = stressTest(cs, refs, {
          skipVariants: opts.skipVariants,
          ...(opts.successClaims === false ? { successClaims: false } : {}),
        });
        const found = problems(stressed);
        res.stress = found.length ? `✘ ${found.join(', ')}` : '✔ no problems';
      } catch (e) {
        res.stress = `error: ${(e as Error).message}`;
      }
    }
  }
  return res;
}

/** What changed for a run since the previous table. */
function runChange(prev: RunResult | undefined, now: RunResult, first: boolean): string {
  if (!prev) return first ? '' : 'new';
  const parts: string[] = [];
  if (prev.verdict !== now.verdict && now.verdict) parts.push(`was ${(prev.verdict ?? 'error').toUpperCase()}`);
  const ids = [...new Set([...Object.keys(prev.checks), ...Object.keys(now.checks)])];
  const moved = ids
    .filter((id) => prev.checks[id] !== now.checks[id])
    .map((id) => `${id} ${prev.checks[id] ?? '—'}→${now.checks[id] ?? '—'}`);
  if (moved.length)
    parts.push(moved.length > 3 ? `${moved.slice(0, 3).join(', ')}, +${moved.length - 3}` : moved.join(', '));
  return parts.join(' · ');
}

const asExpected = (r: RunResult) => !r.error && !!r.verdict && (!r.expected || r.expected === r.verdict);

/** The table: one block per set, one row per run. */
export function renderTable(
  sets: SetResult[],
  previous: Map<string, SetResult>,
  opts: { color: boolean; cwd: string; first: boolean; changed: string[]; now?: Date; ms?: number },
): string {
  const c = (style: 'red' | 'green' | 'yellow' | 'dim' | 'bold', s: string) => paint(opts.color, style, s);
  const shown = (f: string) => {
    const r = relative(opts.cwd, f);
    return r && !r.startsWith('..') && !isAbsolute(r) ? r : f;
  };
  const runs = sets.flatMap((s) => s.runs);
  const width = Math.max(
    8,
    ...sets.flatMap((s) =>
      s.runs.map((r) => (s.runs.filter((x) => x.name === r.name).length > 1 ? shown(r.file) : r.name).length),
    ),
  );
  const time = (opts.now ?? new Date()).toTimeString().slice(0, 8);
  const lines: string[] = [];
  const changed = opts.changed.length
    ? ` · changed: ${opts.changed.slice(0, 3).map(shown).join(', ')}${opts.changed.length > 3 ? ` +${opts.changed.length - 3}` : ''}`
    : '';
  lines.push(
    c(
      'bold',
      `assay watch · ${plural(sets.length, 'check set')} · ${plural(runs.length, 'run')} · ${time}${opts.ms !== undefined ? ` · ${Math.round(opts.ms)} ms` : ''}${changed}`,
    ),
  );
  lines.push('');
  let diffs = 0;
  for (const s of sets) {
    const prev = previous.get(s.file);
    const invalid = !!s.error || s.errors.length > 0;
    const icon = invalid
      ? c('red', '✘')
      : s.runs.some((r) => !asExpected(r))
        ? c('red', '✘')
        : s.warnings.length
          ? c('yellow', '!')
          : c('green', '✔');
    const what = s.error
      ? c('red', 'does not load')
      : s.errors.length
        ? c('red', `invalid (${plural(s.errors.length, 'error')})`)
        : `${s.checkSet!.id} v${s.checkSet!.version} · ${plural(s.checkSet!.requirements, 'requirement')}, ${plural(s.checkSet!.checks, 'check')}${s.warnings.length ? ` · ${plural(s.warnings.length, 'warning')}` : ''}`;
    const wasValid = prev && !prev.error && !prev.errors.length;
    const setChange = prev && wasValid === invalid ? c('yellow', invalid ? '  (was valid)' : '  (now valid)') : '';
    lines.push(`${icon} ${shown(s.file)}  ${what}${setChange}`);
    if (s.error) lines.push(`    ${c('red', 'error:')} ${s.error}`);
    for (const e of s.errors) lines.push(`    ${c('red', 'error:')} ${e}`);
    for (const w of s.warnings) lines.push(`    ${c('yellow', 'warning:')} ${w}`);
    if (!invalid && !s.runs.length) {
      lines.push(c('dim', `    no runs (put snapshots in ${s.runDirs.map(shown).join(' or ')})`));
    }
    const names = s.runs.map((r) => r.name);
    const label = (r: RunResult) => (names.filter((n) => n === r.name).length > 1 ? shown(r.file) : r.name);
    for (const r of s.runs) {
      const p = prev?.runs.find((x) => x.file === r.file);
      const change = runChange(p, r, opts.first || !prev);
      if (change && change !== 'new') diffs++;
      const ok = asExpected(r);
      const mark = r.error ? c('red', '✘') : !r.expected ? c('dim', '·') : ok ? c('green', '✔') : c('red', '✘');
      const verdict = r.error
        ? c('red', 'ERROR')
        : r.verdict === 'success'
          ? c('green', 'SUCCESS')
          : r.verdict === 'fail'
            ? c('red', 'FAIL   ')
            : c('yellow', 'ABSTAIN');
      const expected = r.expected ? `expected ${r.expected.padEnd(7)}` : c('dim', 'unlabelled      ');
      const detail = r.error ? c('red', r.error) : change ? c('yellow', change) : '';
      lines.push(`    ${mark} ${label(r).padEnd(width)}  ${verdict}  ${expected}  ${detail}`.trimEnd());
    }
    if (s.stress) lines.push(`    stress: ${s.stress}`);
  }
  const labelled = runs.filter((r) => r.expected);
  const wrong = runs.filter((r) => !asExpected(r));
  const invalid = sets.filter((s) => s.error || s.errors.length).length;
  lines.push('');
  lines.push(
    [
      `${labelled.length - wrong.filter((r) => r.expected).length}/${labelled.length} labelled runs as expected`,
      ...(wrong.length ? [c('red', `${wrong.length} not`)] : []),
      ...(invalid ? [c('red', `${plural(invalid, 'invalid set')}`)] : []),
      ...(opts.first ? [] : [`${plural(diffs, 'run')} changed`]),
    ].join(' · '),
  );
  return lines.join('\n');
}

/** The machine-readable form of a round (`--json`): one JSON object per line. */
export function roundJson(
  sets: SetResult[],
  previous: Map<string, SetResult>,
  opts: { first: boolean; changed: string[]; ms?: number },
): string {
  return JSON.stringify({
    changed: opts.changed,
    ...(opts.ms !== undefined ? { ms: Math.round(opts.ms) } : {}),
    sets: sets.map((s) => {
      const prev = previous.get(s.file);
      return {
        file: s.file,
        name: s.name,
        ok: !s.error && !s.errors.length,
        ...(s.error ? { error: s.error } : {}),
        errors: s.errors,
        warnings: s.warnings,
        ...(s.checkSet ? { checkSet: s.checkSet } : {}),
        ...(s.stress ? { stress: s.stress } : {}),
        runs: s.runs.map((r) => {
          const p = prev?.runs.find((x) => x.file === r.file);
          return {
            ...r,
            asExpected: asExpected(r),
            ...(p && !opts.first ? { previous: { verdict: p.verdict, checks: p.checks } } : {}),
          };
        }),
      };
    }),
  });
}

/** Ctrl-C stops watching. */
function sigint(): { signal: AbortSignal; dispose(): void } {
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once('SIGINT', stop);
  return { signal: ac.signal, dispose: () => process.off('SIGINT', stop) };
}

/** The closest directory at or above `dir` that exists. */
function existingAncestor(dir: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(d) && statSync(d).isDirectory()) return d;
    if (dirname(d) === d) return undefined;
  }
}

const within = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

export async function run({ values, positionals }: Invocation, io: Io): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const { config } = await cliConfig(values, io);
  if (!positionals.length && !config.checks)
    throw new UsageError(
      'missing argument: check set files or directories, or `checks` in assay.config.ts (usage: assay watch [checks...])',
    );
  const specs = positionals.length ? positionals.map((p) => resolve(cwd, p)) : [config.checks!];
  const debounce = values.debounce === undefined ? 100 : Number(values.debounce);
  if (!Number.isFinite(debounce) || debounce < 0)
    throw new UsageError(`--debounce must be a number of milliseconds, got ${JSON.stringify(values.debounce)}`);
  const flagged = (values.reference as string[] | undefined)?.map((r) => resolve(cwd, r));
  for (const r of flagged ?? []) if (!existsSync(r)) throw new CliError(`run directory not found: ${r}`);
  const roots = flagged ?? [config.bench?.references, config.snapshots].filter((x): x is string => !!x);
  const once = !!values.once;
  const json = !!values.json;
  const interrupt = once || io.signal ? undefined : sigint();
  const signal = io.signal ?? interrupt?.signal;
  const opts: CheckOptions = {
    roots,
    stress: !!values.stress,
    skipVariants: config.stress?.skipVariants ?? [],
    ...(config.stress?.successClaims === false ? { successClaims: false } : {}),
    cache: new RunCache(),
    // While watching, a module runs in a fresh process: edits to what it imports are seen, and
    // the imports are watched too. --once loads it in this process.
    fresh: !once,
    ...(signal ? { signal } : {}),
  };
  const clear = !json && ((values.clear as boolean | undefined) ?? !!io.tty);

  let files = discoverSets(specs);
  if (!files.length && once) throw new CliError(`no check sets (*.checks.json, *.checks.ts) at ${specs.join(', ')}`);
  let results = new Map<string, SetResult>();
  let previous = new Map<string, SetResult>();
  let first = true;

  const show = (changed: string[], ms: number) => {
    const sets = files.map((f) => results.get(f)!).filter(Boolean);
    if (json) return io.out(roundJson(sets, previous, { first, changed, ms }));
    const table = renderTable(sets, previous, { color: io.color, cwd, first, changed, ms });
    io.out(clear ? `\x1b[H\x1b[2J${table}` : first ? table : `\n${table}`);
  };
  const evictRuns = () => opts.cache.prune(new Set([...results.values()].flatMap((s) => s.runs.map((r) => r.file))));

  if (once) {
    const t0 = performance.now();
    for (const f of files) results.set(f, await checkSet(f, opts));
    show([], performance.now() - t0);
    const bad = [...results.values()].some((s) => s.error || s.errors.length || s.runs.some((r) => !asExpected(r)));
    return bad ? EXIT.fail : EXIT.ok;
  }

  // `once` is false here, so there is a signal: the caller's or Ctrl-C's.
  const stop = signal!;
  /** Watchers by directory; a recursive one covers everything under it. */
  const watchers = new Map<string, { w: FSWatcher; recursive: boolean }>();
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), debounce);
  };
  const covered = (d: string, recursive: boolean) =>
    [...watchers].some(([w, x]) => (x.recursive ? within(d, w) : !recursive && w === d));

  const watchDir = (d: string, recursive: boolean) => {
    if (stop.aborted || covered(d, recursive)) return;
    try {
      const w = watch(d, { recursive }, (_event, name) => {
        const p = name ? join(d, name.toString()) : d;
        if (isScratch(p)) return;
        pending.add(p);
        schedule();
      });
      // A lost watch (its directory deleted, an error on some platforms): say so, forget it, and
      // look again in a round, which watches the directory or its closest existing parent.
      w.on('error', (e) => {
        w.close();
        if (watchers.get(d)?.w === w) watchers.delete(d);
        if (stop.aborted) return;
        io.err(`${paint(io.errColor, 'yellow', 'warning:')} lost the watch on ${d} (${e.message}); watching again`);
        pending.add(d);
        schedule();
      });
      watchers.set(d, { w, recursive });
    } catch {
      /* a directory that went away: the next round looks again */
    }
  };

  /** Watch what a round reads: set directories, glob roots, run roots and the modules sets import. */
  const watchRoots = () => {
    const trees = new Set<string>();
    for (const s of specs) trees.add(tasksDir(s));
    for (const f of files) trees.add(dirname(f));
    for (const r of [...roots, ...files.map((f) => join(dirname(dirname(f)), 'references'))]) trees.add(r);
    for (const d of trees) {
      if (existsSync(d)) watchDir(d, true);
      else {
        // Not there yet: watch its closest existing parent (only that directory), so creating it starts a round.
        const a = existingAncestor(dirname(d));
        if (a) watchDir(a, false);
      }
    }
    // Each imported module's own directory, not recursively: a helper outside the set's directory.
    for (const s of results.values())
      for (const dep of s.deps) if (existsSync(dirname(dep))) watchDir(dirname(dep), false);
    // Drop watchers whose directory is gone; a round watches them again when they come back.
    for (const [d, x] of watchers) {
      if (!existsSync(d)) {
        x.w.close();
        watchers.delete(d);
      }
    }
  };

  /** Which sets a changed path affects. */
  const affected = (changed: string[]): Set<string> => {
    const out = new Set<string>();
    for (const p of changed) {
      for (const f of files) {
        const s = results.get(f);
        if (
          p === f ||
          s?.deps.includes(p) ||
          // A run file, or a run directory (or a parent of one) that appeared or went away.
          runDirsFor(f, roots).some((d) => within(p, d) || within(d, p)) ||
          // A module set that did not load has unknown imports: any other change may fix it.
          (isModuleFile(f) && (!s || !!s.error))
        )
          out.add(f);
      }
    }
    return out;
  };

  /** One round: what changed is verified again and the table redrawn. */
  const round = async (changed: string[]): Promise<void> => {
    files = discoverSets(specs);
    const todo = affected(changed);
    for (const f of files) if (!results.has(f)) todo.add(f);
    const removed = [...results.keys()].some((f) => !files.includes(f));
    if (!todo.size && !removed) return;
    const next = new Map([...results].filter(([f]) => files.includes(f)));
    const started = performance.now();
    for (const f of files) if (todo.has(f)) next.set(f, await checkSet(f, opts));
    if (stop.aborted) return;
    previous = results;
    results = next;
    evictRuns();
    show(changed, performance.now() - started);
    watchRoots();
  };

  /** Run rounds until nothing is pending; changes during a round make another one. */
  const flush = async (): Promise<void> => {
    if (running) return;
    running = (async () => {
      while (pending.size && !stop.aborted) {
        const changed = [...pending].toSorted();
        pending.clear();
        try {
          await round(changed);
        } catch (e) {
          io.err(`${paint(io.errColor, 'red', 'error:')} ${(e as Error).message}`);
        }
      }
    })();
    await running;
    running = undefined;
  };

  // Watch before the first round, so an edit made while it runs is not missed: it is pending
  // when the round ends and makes another one.
  watchRoots();
  running = (async () => {
    const t0 = performance.now();
    for (const f of files) results.set(f, await checkSet(f, opts));
    if (stop.aborted) return;
    evictRuns();
    show([], performance.now() - t0);
    first = false;
    watchRoots();
  })();
  await running;
  running = undefined;
  if (pending.size) schedule();

  await new Promise<void>((done) => {
    if (stop.aborted) return done();
    stop.addEventListener('abort', () => done(), { once: true });
  });
  interrupt?.dispose();
  // A round still running ends first (its loads are stopped), so no watcher it opens is left behind.
  await running;
  clearTimeout(timer);
  for (const x of watchers.values()) x.w.close();
  watchers.clear();
  return EXIT.ok;
}
