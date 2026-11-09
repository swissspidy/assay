/**
 * The readiness ladder (ADR 0022): for each task, how far its check set is on the way to
 * production, and what blocks it. Every stage reuses what Assay already has: check-set and run
 * discovery (ADR 0019), validation, lock verification (ADR 0013), overlay stress (ADR 0016)
 * and `verifyMany` (ADR 0015). A stage is evaluated only once the one before it passed.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CheckSet, EvidenceSnapshot, Outcome, Rejection } from '../types.ts';
import { CheckSetFileError, checkSetName, discoverSets, loadCheckSetFile, runDirsFor } from '../checks/load.ts';
import { readSnapshotFile, toSnapshot } from '../cli/io.ts';
import {
  STATUS_STAGES,
  checkRecentRuns,
  escapeGlob,
  readTrustedKeys,
  type AssayConfig,
  type StatusConfig,
  type StatusStage,
} from '../config/config.ts';
import { compileChecks } from '../plan/plan.ts';
import { stressTest } from '../stress/stress.ts';
import { configOf, verifyMany } from '../verifier/escalate.ts';
import { contentDigest, describeChange } from '../verifier/lock.ts';
import { trustedKeySet, type TrustedKey, type TrustedKeySet } from '../verifier/sign.ts';

export { STATUS_STAGES, type StatusConfig, type StatusStage };

/**
 * `pass` and `fail` were evaluated; `not-reached`: an earlier stage failed, so this one was not
 * evaluated; `skipped`: the stage is not part of this ladder (`--no-stress`, `status.stages`), or
 * it does not apply to the task (`recent` with no recent runs). A skipped stage does not block.
 */
export type StageStatus = 'pass' | 'fail' | 'not-reached' | 'skipped';

/** One stage of one task's ladder. */
export interface StageResult {
  status: StageStatus;
  /** Why the stage failed: one line naming the first problem. */
  blocker?: string;
  /** What a passed (or skipped) stage found, e.g. "22/22 variants accepted". */
  detail?: string;
}

/** One task's row: its ladder and, when blocked, where and why. */
export interface TaskStatus {
  /** The task's name: the check set's file name without `.checks.json` / `.checks.ts`. */
  name: string;
  /** The check set file, relative to `cwd` (with `/`), or absolute when outside it. */
  file: string;
  /** The set's id and version, once it validates. */
  checkSet?: { id: string; version: string };
  /** Every stage passed or was skipped. */
  ready: boolean;
  /** The first stage that failed. */
  blockedAt?: StatusStage;
  /** That stage's blocker. */
  blocker?: string;
  /** Every stage, in ladder order. */
  stages: Record<StatusStage, StageResult>;
  /** Runs read for the task (0 when the stage that needs them was not reached). */
  runs: { references: number; recent: number };
}

/** What `status()` returns, and `assay status --json` prints (`assay.status/v1`). */
export interface StatusResult {
  schema: 'assay.status/v1';
  /** The stages this ladder evaluates, in order (the others are skipped for every task). */
  stages: StatusStage[];
  tasks: TaskStatus[];
  summary: {
    tasks: number;
    ready: number;
    /** Tasks per stage they are blocked at, in ladder order; stages blocking none are left out. */
    blocked: Partial<Record<StatusStage, number>>;
  };
}

/** Options of `status()`; each defaults to the config's setting when a config is given. */
export interface StatusOptions {
  /** Check set files, directories (searched for `*.checks.json` and `*.checks.ts`) or globs. Default: the config's `checks`. */
  checks?: string | readonly string[];
  /**
   * Directories with one subdirectory of runs per task (`<dir>/<task>/*.json`). Default: the
   * config's `bench.references`. `references/` next to each set's directory is always searched.
   */
  references?: readonly string[];
  /** The root of recent runs (`<dir>/<task>/*.json`), or false for none. Default: the config's `snapshots`. */
  recent?: string | false;
  /** Public keys a lock must be signed by. Default: the config's `trustedKeys`; without any, any valid lock passes. */
  trustedKeys?: readonly TrustedKey[] | TrustedKeySet;
  /** The stages to evaluate. Default: the config's `status.stages`, else all. */
  stages?: readonly StatusStage[];
  /** The `recent` stage's window and threshold. Default: the config's `status.recentRuns`. */
  recentRuns?: StatusConfig['recentRuns'];
  /** Stress variants that do not apply. Default: the config's `stress.skipVariants`. */
  skipVariants?: readonly string[];
  /** A config for the defaults above: an object or a file path. Library calls never read assay.config.* by themselves. */
  config?: AssayConfig | string | false;
  /** What relative paths are resolved against and file names shown relative to (default: the current directory). */
  cwd?: string;
}

interface Run {
  name: string;
  expected?: 'success' | 'fail';
  snapshot?: EvidenceSnapshot;
  capturedAt: string;
  error?: string;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const more = (n: number) => (n > 1 ? ` (+${n - 1} more)` : '');
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const GLOB = /[*?[\]{}]/;

/** The `.json` runs in these directories, each read once (and its snapshot built once). */
function readRuns(dirs: readonly string[]): Run[] {
  const out: Run[] = [];
  for (const d of dirs) {
    if (!existsSync(d) || !statSync(d).isDirectory()) continue;
    for (const f of readdirSync(d)
      .filter((x) => x.endsWith('.json'))
      .toSorted()) {
      const file = join(d, f);
      const name = basename(f, '.json');
      try {
        const sf = readSnapshotFile(file);
        const snapshot = toSnapshot(sf);
        out.push({
          name,
          ...(sf.expected ? { expected: sf.expected } : {}),
          snapshot,
          capturedAt: snapshot.capturedAt,
        });
      } catch (e) {
        out.push({ name, capturedAt: '', error: (e as Error).message });
      }
    }
  }
  return out;
}

/** The check that decided a run that did not succeed: the first failing (else not passing) check of a hard requirement. */
export function decidingCheck(o: Outcome): string {
  const open = new Set(
    o.requirements.filter((r) => r.kind === 'hard' && r.status !== 'pass').map((r) => r.requirement),
  );
  const c =
    o.checks.find((x) => open.has(x.requirement) && x.status === 'fail') ??
    o.checks.find((x) => open.has(x.requirement) && x.status !== 'pass');
  if (c) return `${c.check} ${c.status}${c.reason ? ` (${c.reason})` : ''}`;
  const r = o.requirements.find((x) => open.has(x.requirement));
  return r ? `${r.requirement} ${r.status}${r.reason ? ` (${r.reason})` : ''}` : '';
}

const freeText = (w: string, id: string) =>
  (w.startsWith(`check ${id}:`) || w.startsWith(`check ${id}.`) || w.startsWith(`check ${id} `)) &&
  w.includes('reads free page text');

/** Hard requirements with no check, or whose every check reads free page text (as the validator warns). */
function coverage(cs: CheckSet, warnings: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of cs.requirements) {
    if (r.kind !== 'hard') continue;
    const mine = cs.checks.filter((c) => c.requirement === r.id);
    if (!mine.length) out.push(`${r.id} has no checks`);
    else if (mine.every((c) => warnings.some((w) => freeText(w, c.id))))
      out.push(`${r.id} is checked by free page text only (${mine.map((c) => c.id).join(', ')})`);
  }
  return out;
}

const keySetOf = (k: readonly TrustedKey[] | TrustedKeySet): TrustedKeySet =>
  'keys' in k && (k as TrustedKeySet).keys instanceof Map ? (k as TrustedKeySet) : trustedKeySet(k as TrustedKey[]);

/**
 * The readiness ladder of every task: valid, covered, reviewed and locked, stress-clean,
 * passes its references, passes its recent runs. Needs no model and changes no file.
 */
export async function status(options: StatusOptions = {}): Promise<StatusResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  // A config path is relative to `cwd`, like every other path here.
  const config = await configOf(typeof options.config === 'string' ? resolve(cwd, options.config) : options.config);
  if (options.recentRuns !== undefined) checkRecentRuns(options.recentRuns, 'status()');
  const abs = (p: string) => resolve(cwd, p);
  const specs =
    options.checks === undefined ? [] : typeof options.checks === 'string' ? [options.checks] : options.checks;
  for (const s of specs) if (!GLOB.test(s) && !existsSync(abs(s))) throw new Error(`check set not found: ${abs(s)}`);
  // A relative glob keeps `cwd` literal, even with glob characters in its name (as `gate` does).
  const specList = specs.length
    ? specs.map((s) => (isAbsolute(s) || existsSync(abs(s)) ? abs(s) : `${escapeGlob(cwd)}/${s}`))
    : config.checks
      ? [config.checks]
      : [];
  if (!specList.length) throw new Error('no check sets: pass `checks`, or set `checks` in the config');
  if (!specs.length && !GLOB.test(config.checks!) && !existsSync(config.checks!))
    throw new Error(`check set not found: ${config.checks}`);
  const files = discoverSets(specList);
  if (!files.length) throw new Error(`no check sets (*.checks.json, *.checks.ts) at ${specList.join(', ')}`);

  const refRoots = (options.references ?? (config.bench?.references ? [config.bench.references] : [])).map(abs);
  const recentOpt = options.recent ?? config.snapshots ?? false;
  const recentRoot = recentOpt === false ? undefined : abs(recentOpt);
  const keyInput =
    options.trustedKeys ??
    (config.trustedKeys?.length ? trustedKeySet(readTrustedKeys(config.trustedKeys)) : undefined);
  const keys = keyInput ? keySetOf(keyInput) : undefined;
  const wanted = new Set(options.stages ?? config.status?.stages ?? STATUS_STAGES);
  // `recent` is part of the ladder only where recent runs can be: under a recent-runs root.
  if (!recentRoot) wanted.delete('recent');
  const enabled = STATUS_STAGES.filter((s) => wanted.has(s));
  const window = options.recentRuns ?? config.status?.recentRuns ?? {};
  const last = window.last ?? 10;
  const minPassRate = window.minPassRate ?? 1;
  const skipVariants = [...(options.skipVariants ?? config.stress?.skipVariants ?? [])];

  const shown = (f: string) => {
    const r = relative(cwd, f);
    return r && !r.startsWith('..') && !isAbsolute(r) ? r.split(sep).join('/') : f;
  };

  /** Runs per directory, read once: a directory that is both a references and a recent-runs directory is read once. */
  const runCache = new Map<string, Run[]>();
  const runsIn = (dir: string): Run[] => {
    let runs = runCache.get(dir);
    if (!runs) runCache.set(dir, (runs = readRuns([dir])));
    return runs;
  };

  const tasks: TaskStatus[] = [];
  for (const file of files) {
    const name = checkSetName(file);
    const stages = {} as Record<StatusStage, StageResult>;
    const task: TaskStatus = {
      name,
      file: shown(file),
      ready: false,
      stages,
      runs: { references: 0, recent: 0 },
    };
    let cs: CheckSet | undefined;
    let warnings: string[] = [];
    const refDirs = runDirsFor(file, refRoots);
    const references = () => refDirs.flatMap(runsIn);

    // The set and its validation come first, whatever the ladder: every other stage reads them.
    const load = async (): Promise<StageResult> => {
      let input: unknown;
      try {
        input = await loadCheckSetFile(file);
      } catch (e) {
        if (!(e instanceof CheckSetFileError)) throw e;
        const why =
          e.code === 'EJSON' ? e.message.replace(/^check set .* is not valid JSON/, 'not valid JSON') : e.message;
        return { status: 'fail', blocker: oneLine(why) };
      }
      const plan = compileChecks(input);
      const report = plan.report;
      if (!report.ok) return { status: 'fail', blocker: oneLine(report.errors[0]!) + more(report.errors.length) };
      cs = input as CheckSet;
      warnings = report.warnings;
      task.checkSet = { id: cs.id, version: cs.version };
      return {
        status: 'pass',
        detail: `${plural(cs.requirements.length, 'requirement')}, ${plural(cs.checks.length, 'check')}`,
      };
    };
    const validity = await load();

    const evaluate: Record<StatusStage, () => Promise<StageResult>> = {
      valid: async () => validity,
      covered: async () => {
        const gaps = coverage(cs!, warnings);
        if (gaps.length) return { status: 'fail', blocker: gaps[0]! + more(gaps.length) };
        const hard = cs!.requirements.filter((r) => r.kind === 'hard').length;
        return { status: 'pass', detail: `${plural(hard, 'hard requirement')} covered` };
      },
      locked: async () => {
        const s = compileChecks(cs!).lockStatus(cs!, keys ? { trustedKeys: keys } : {});
        if (s.state === 'none') {
          const rejected = (cs as CheckSet & { rejected?: Rejection }).rejected;
          if (rejected && rejected.content === contentDigest(cs!))
            return { status: 'fail', blocker: `rejected by ${rejected.by}: ${oneLine(rejected.note)}` };
          return { status: 'fail', blocker: 'not locked' };
        }
        if (s.state === 'broken') {
          if (s.changes.length)
            return { status: 'fail', blocker: `changed since lock: ${s.changes.map(describeChange).join(', ')}` };
          return { status: 'fail', blocker: `lock broken: ${s.problems[0] ?? 'edited after locking'}` };
        }
        const by = s.lock!.by;
        if (!keys)
          return { status: 'pass', detail: `locked by ${by}${s.lock!.signature ? ' (signature not checked)' : ''}` };
        if (s.signature === 'trusted') return { status: 'pass', detail: `locked by ${by}, signed by ${s.signer}` };
        if (s.signature === 'untrusted')
          return { status: 'fail', blocker: `untrusted key: signed with ${s.lock!.signature!.keyId}` };
        return { status: 'fail', blocker: `not signed (locked by ${by}; a trusted key is required)` };
      },
      stress: async () => {
        const runs = references();
        const refs = runs
          .filter((r) => r.snapshot && r.expected !== 'fail')
          .map((r) => ({ name: r.name, snapshot: r.snapshot! }));
        task.runs.references = runs.length;
        if (!refs.length) return { status: 'fail', blocker: 'no correct reference run to stress-test' };
        // Only the valid variants decide this stage: mutants are reviewed with the lock, not gated here.
        const report = stressTest(cs!, refs, { skipVariants, successClaims: false });
        // A reference the checks reject is the next stage's blocker, named with its run.
        const variants = report.variants.filter((v) => v.id !== 'reference');
        const rejected = variants.filter((v) => !v.accepted);
        if (rejected.length) {
          const v = rejected[0]!;
          const by = v.rejectedBy.map((c) => `${c.check} ${c.status === 'fail' ? 'fails' : 'abstains'}`).join(', ');
          return {
            status: 'fail',
            blocker: `${by || 'rejected'} on variant ${v.reference}/${v.id}${more(rejected.length)}`,
          };
        }
        return { status: 'pass', detail: `${variants.length}/${variants.length} variants accepted` };
      },
      references: async () => {
        const runs = references();
        task.runs.references = runs.length;
        const broken = runs.find((r) => r.error);
        if (broken) return { status: 'fail', blocker: `${broken.name}: ${oneLine(broken.error!)}` };
        const labelled = runs.filter((r) => r.expected);
        if (!labelled.some((r) => r.expected === 'success'))
          return { status: 'fail', blocker: 'no labelled correct reference run' };
        const results = await verifyMany(
          cs!,
          labelled.map((r) => r.snapshot!),
          { config: false },
        );
        const wrong: string[] = [];
        results.forEach(({ outcome: o }, i) => {
          const r = labelled[i]!;
          if (r.expected === 'success' && o.verdict !== 'success')
            wrong.push(`${r.name}: ${o.verdict.toUpperCase()}, expected success (${decidingCheck(o)})`);
          // Only a fail is as labelled, as in `assay watch`: an abstain does not show the run is wrong.
          if (r.expected === 'fail' && o.verdict !== 'fail')
            wrong.push(`${r.name}: ${o.verdict.toUpperCase()}, expected fail`);
        });
        if (wrong.length) return { status: 'fail', blocker: wrong[0]! + more(wrong.length) };
        return { status: 'pass', detail: `${labelled.length}/${labelled.length} labelled runs as expected` };
      },
      recent: async () => {
        const dir = join(recentRoot!, name);
        const runs = runsIn(dir);
        if (!runs.length) return { status: 'skipped', detail: 'no recent runs' };
        // A run that cannot be read, or whose capture time is unknown, cannot be placed in the
        // window: it fails the stage rather than silently falling out of it.
        const broken = runs.find((r) => r.error);
        if (broken) return { status: 'fail', blocker: `${broken.name}: ${oneLine(broken.error!)}` };
        const at = new Map(runs.map((r) => [r, Date.parse(r.capturedAt)] as const));
        const undated = runs.find((r) => Number.isNaN(at.get(r)));
        if (undated) {
          const what =
            typeof undated.capturedAt === 'string'
              ? `capturedAt ${JSON.stringify(undated.capturedAt)} is not a date`
              : 'no capturedAt';
          return { status: 'fail', blocker: `${undated.name}: ${what}` };
        }
        // Newest first: by the instant captured (offsets count), then by name (assay capture names files by time).
        const newest = runs
          .toSorted((a, b) => at.get(b)! - at.get(a)! || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
          .slice(0, last);
        task.runs.recent = newest.length;
        const results = await verifyMany(
          cs!,
          newest.map((r) => r.snapshot!),
          { config: false },
        );
        const failed = results.flatMap(({ outcome: o }, i) =>
          o.verdict === 'success' ? [] : [`${newest[i]!.name}: ${o.verdict.toUpperCase()} (${decidingCheck(o)})`],
        );
        const ok = newest.length - failed.length;
        const rate = `${ok}/${newest.length} recent runs succeed`;
        if (ok / newest.length < minPassRate) {
          const need = minPassRate < 1 ? `, needs ${Math.round(minPassRate * 100)}%` : '';
          return { status: 'fail', blocker: `${rate}${need}; ${failed[0]}` };
        }
        return { status: 'pass', detail: rate };
      },
    };

    let blocked = false;
    for (const stage of STATUS_STAGES) {
      if (!enabled.includes(stage)) stages[stage] = { status: 'skipped' };
      else if (blocked) stages[stage] = { status: 'not-reached' };
      else {
        // Without `valid` in the ladder, a set that does not load or validate blocks the first stage.
        const r: StageResult =
          stage === 'valid' || cs
            ? await evaluate[stage]()
            : { status: 'fail', blocker: `invalid check set: ${validity.blocker!}` };
        stages[stage] = r;
        if (r.status === 'fail') {
          blocked = true;
          task.blockedAt = stage;
          task.blocker = r.blocker!;
        }
      }
    }
    task.ready = !blocked;
    // Fields in a fixed order, for a stable JSON shape.
    tasks.push({
      name: task.name,
      file: task.file,
      ...(task.checkSet ? { checkSet: task.checkSet } : {}),
      ready: task.ready,
      ...(task.blockedAt ? { blockedAt: task.blockedAt, blocker: task.blocker! } : {}),
      stages,
      runs: task.runs,
    });
  }

  const blocked: Partial<Record<StatusStage, number>> = {};
  for (const s of STATUS_STAGES) {
    const n = tasks.filter((t) => t.blockedAt === s).length;
    if (n) blocked[s] = n;
  }
  return {
    schema: 'assay.status/v1',
    stages: enabled,
    tasks,
    summary: { tasks: tasks.length, ready: tasks.filter((t) => t.ready).length, blocked },
  };
}

/** Whether a task got through `stage`: every stage up to and including it passed or was skipped. */
export function reached(task: TaskStatus, stage: StatusStage): boolean {
  for (const s of STATUS_STAGES) {
    const st = task.stages[s].status;
    if (st === 'fail' || st === 'not-reached') return false;
    if (s === stage) return true;
  }
  return true;
}
