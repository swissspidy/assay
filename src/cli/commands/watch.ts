/**
 * `assay watch`: the edit loop for check sets (ADR 0019). Watches check set files
 * (`*.checks.json`, `*.checks.ts`) and their runs; on a change it validates the sets that
 * changed, verifies their runs again with `verifyMany` and prints a compact table of verdicts
 * with what changed since the previous run. No model and no lock: it is a development loop.
 */
import { existsSync, globSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CheckSet, EvidenceSnapshot, Status, Verdict } from '../../types.ts';
import { validateCheckSet, verifyMany } from '../../index.ts';
import { stressTest } from '../../stress/index.ts';
import { CHECK_SET_FILE, CHECK_SET_GLOBS, isModuleFile, loadCheckSetFile } from '../../checks/load.ts';
import { CliError, EXIT, UsageError, paint, readSnapshotFile, toSnapshot, type Invocation, type Io } from '../io.ts';
import { cliConfig } from '../config.ts';
import { problems } from './stress.ts';

interface RunResult {
  name: string;
  file: string;
  expected?: 'success' | 'fail';
  verdict?: Verdict;
  /** Check id → status. */
  checks: Record<string, Status>;
  error?: string;
}

interface SetResult {
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
  stress?: string;
}

const setName = (file: string) => basename(file).replace(CHECK_SET_FILE, '');
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** Editor and tool scratch files: never a change worth a run. */
const scratch = (f: string) => /(^|[\\/])\.|~$|\.(swp|tmp)$/.test(f);

/** Every check set the specs name: files, directories (searched) and globs. */
export function discoverSets(specs: string[]): string[] {
  const files = new Set<string>();
  for (const spec of specs) {
    if (existsSync(spec)) {
      if (statSync(spec).isDirectory()) {
        for (const g of CHECK_SET_GLOBS) for (const f of globSync(g, { cwd: spec })) files.add(resolve(spec, f));
      } else files.add(resolve(spec));
    } else for (const f of globSync(spec)) files.add(resolve(f));
  }
  return [...files].filter((f) => !f.split(sep).includes('node_modules')).toSorted();
}

/** Where a set's runs live: `<root>/<name>/` for each run root, and references/ next to the set's directory. */
export function runDirsFor(file: string, roots: string[]): string[] {
  const all = [...roots, join(dirname(dirname(file)), 'references')];
  return [...new Set(all.map((r) => join(r, setName(file))))];
}

/** Snapshots read once per file version: the same object keeps its evidence store (ADR 0015). */
const snapshots = new Map<string, { mtime: number; expected?: 'success' | 'fail'; snapshot: EvidenceSnapshot }>();

function readRun(file: string): { expected?: 'success' | 'fail'; snapshot: EvidenceSnapshot } {
  const mtime = statSync(file).mtimeMs;
  const hit = snapshots.get(file);
  if (hit && hit.mtime === mtime) return hit;
  const f = readSnapshotFile(file);
  const entry = { mtime, ...(f.expected ? { expected: f.expected } : {}), snapshot: toSnapshot(f) };
  snapshots.set(file, entry);
  return entry;
}

interface Options {
  roots: string[];
  stress: boolean;
  skipVariants: string[];
  successClaims?: boolean;
}

/** Load, validate and verify one set against its runs (and stress-test it). */
export async function checkSet(file: string, opts: Options, fresh: boolean): Promise<SetResult> {
  const runDirs = runDirsFor(file, opts.roots);
  const base: SetResult = { file, name: setName(file), errors: [], warnings: [], runs: [], runDirs };
  let input: unknown;
  try {
    input = await loadCheckSetFile(file, { fresh: fresh && isModuleFile(file) });
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
      const r = readRun(f);
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
  const width = Math.max(8, ...runs.map((r) => r.name.length));
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
      lines.push(`    ${mark} ${r.name.padEnd(width)}  ${verdict}  ${expected}  ${detail}`.trimEnd());
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

/** Ctrl-C stops watching. */
function sigint(): { signal: AbortSignal; dispose(): void } {
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once('SIGINT', stop);
  return { signal: ac.signal, dispose: () => process.off('SIGINT', stop) };
}

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
  const opts: Options = {
    roots,
    stress: !!values.stress,
    skipVariants: config.stress?.skipVariants ?? [],
    ...(config.stress?.successClaims === false ? { successClaims: false } : {}),
  };
  const clear = (values.clear as boolean | undefined) ?? !!io.tty;

  let files = discoverSets(specs);
  if (!files.length && values.once)
    throw new CliError(`no check sets (*.checks.json, *.checks.ts) at ${specs.join(', ')}`);
  let results = new Map<string, SetResult>();
  let previous = new Map<string, SetResult>();
  let first = true;

  const show = (changed: string[], ms: number) => {
    const table = renderTable(files.map((f) => results.get(f)!).filter(Boolean), previous, {
      color: io.color,
      cwd,
      first,
      changed,
      ms,
    });
    io.out(clear ? `\x1b[H\x1b[2J${table}` : first ? table : `\n${table}`);
  };

  // The first table: every set.
  const t0 = performance.now();
  for (const f of files) results.set(f, await checkSet(f, opts, false));
  show([], performance.now() - t0);
  if (values.once) {
    const bad = [...results.values()].some((s) => s.error || s.errors.length || s.runs.some((r) => !asExpected(r)));
    return bad ? EXIT.fail : EXIT.ok;
  }
  first = false;

  const interrupt = io.signal ? undefined : sigint();
  const signal = io.signal ?? interrupt!.signal;
  const watchers = new Map<string, FSWatcher>();
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const watchRoots = () => {
    const dirs = new Set<string>();
    for (const s of specs) {
      if (existsSync(s)) dirs.add(statSync(s).isDirectory() ? s : dirname(s));
    }
    for (const f of files) dirs.add(dirname(f));
    for (const r of [...roots, ...files.map((f) => join(dirname(dirname(f)), 'references'))]) {
      if (existsSync(r)) dirs.add(r);
    }
    for (const d of dirs) {
      if (watchers.has(d) || [...watchers.keys()].some((w) => d.startsWith(w + sep))) continue;
      try {
        const w = watch(d, { recursive: true }, (_event, name) => {
          if (!name) return;
          const p = join(d, name.toString());
          if (scratch(name.toString())) return;
          pending.add(p);
          clearTimeout(timer);
          timer = setTimeout(() => void flush(), debounce);
        });
        w.on('error', () => w.close());
        watchers.set(d, w);
      } catch {
        /* a directory that went away: the next round looks again */
      }
    }
  };

  /** Which sets a changed path affects. */
  const affected = (changed: string[]): Set<string> => {
    const out = new Set<string>();
    for (const p of changed) {
      if (files.includes(p)) {
        out.add(p);
        continue;
      }
      let matched = false;
      for (const f of files) {
        if (runDirsFor(f, roots).some((d) => p === d || p.startsWith(d + sep))) {
          out.add(f);
          matched = true;
        }
      }
      // Anything else (a helper module, shared data): every module set may import it.
      if (!matched) for (const f of files) if (isModuleFile(f)) out.add(f);
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
    previous = results;
    results = new Map([...results].filter(([f]) => files.includes(f)));
    const started = performance.now();
    for (const f of files) if (todo.has(f)) results.set(f, await checkSet(f, opts, true));
    show(changed, performance.now() - started);
    watchRoots();
  };

  /** Run rounds until nothing is pending; changes during a round make another one. */
  const flush = async (): Promise<void> => {
    if (running) return;
    running = (async () => {
      while (pending.size && !signal.aborted) {
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

  watchRoots();
  await new Promise<void>((done) => {
    if (signal.aborted) return done();
    signal.addEventListener('abort', () => done(), { once: true });
  });
  clearTimeout(timer);
  for (const w of watchers.values()) w.close();
  interrupt?.dispose();
  await running;
  return EXIT.ok;
}
