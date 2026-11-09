/**
 * The agent regression gate (ADR 0021): verify the runs captured before an agent change
 * (baseline) and after it (candidate) with the same deterministic check sets, and classify
 * every task and requirement as regressed, improved, unchanged, new or missing. A change is
 * kept only when nothing regressed.
 *
 * No model runs and no config is read: `verifyMany` with the checks alone. Both sides are
 * judged by one check set per task (the same content digest), so a difference between the
 * sides is a difference in the agent, not in the checks.
 */
import { existsSync, globSync, readdirSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';
import type { CheckSet, Channel, EvidenceSnapshot, Json, Status, Verdict } from '../types.ts';
import { validateCheckSet } from '../dsl/validate.ts';
import { verifyMany } from '../verifier/escalate.ts';
import { contentDigest, describeAssertion } from '../verifier/lock.ts';
import { loadSnapshot } from '../snapshot/load.ts';
import { CHECK_SET_FILE, checkSetName, discoverSets, loadCheckSetFile } from '../checks/load.ts';
import { readSnapshotFile, toSnapshot } from '../cli/io.ts';
import { escapeGlob } from '../config/config.ts';

export const GATE_SCHEMA = 'assay.gate/v1';

/** What happened to a task, a requirement or a task's outcome between the two sides. */
export type GateStatus = 'regressed' | 'improved' | 'unchanged' | 'new' | 'missing';

/** A run given in memory: a snapshot, or a snapshot with a name (and a path to show). */
export type GateRunInput = EvidenceSnapshot | { name?: string; path?: string; snapshot: EvidenceSnapshot | unknown };

/**
 * One side's runs: directories (or globs of directories) holding `<task>/*.json`, as
 * `references/` does, or the runs in memory by task name.
 */
export type GateSideInput = string | readonly string[] | Readonly<Record<string, readonly GateRunInput[]>>;

export interface GateOptions {
  /** The runs from before the change. */
  baseline: GateSideInput;
  /** The runs from after the change. */
  candidate: GateSideInput;
  /**
   * The check sets, matched to tasks by name (`02-add-blue-mug.checks.ts` judges the runs in
   * `<side>/02-add-blue-mug/`): files, directories or globs, or the sets in memory by task name.
   * A side directory may also hold `<task>.checks.json` (or `.ts`) next to `<task>/`, the set it
   * was judged with; both sides must come to the same set either way.
   */
  checks?: string | readonly string[] | Readonly<Record<string, CheckSet | unknown>>;
  /** How many runs a pass count may drop by (on the candidate's scale) before it is a regression. Default 0. */
  tolerance?: number;
  /** The fewest runs a side may have for a task it ran. Default 1. */
  minRuns?: number;
  /** `'<task>'` or `'<task>:<requirement>'` (globs): regressions there are reported but do not block. */
  allow?: readonly string[];
  /** What relative paths are resolved against (default: the current directory). */
  cwd?: string;
  /** What paths in the result are shown relative to (default: `cwd`). */
  relativeTo?: string;
}

/** Runs of one side for a task or requirement: how many passed (succeeded, for an outcome), failed, abstained. */
export interface GateCounts {
  runs: number;
  pass: number;
  fail: number;
  abstain: number;
}

export interface GateRequirement {
  id: string;
  kind: 'hard' | 'soft';
  text: string;
  status: GateStatus;
  /** Regressed (or missing) and not allowed: it fails the gate. */
  blocking: boolean;
  /** Matched by an `allow` rule. */
  allowed: boolean;
  baseline: GateCounts | null;
  candidate: GateCounts | null;
}

export interface GateEvidence {
  channel: Channel;
  locator?: string;
  value?: Json;
}

/** A check that did not pass in a candidate run, next to what it read in a baseline run where it passed. */
export interface GateCheckDetail {
  check: string;
  description: string;
  /** What the check tests, in the review sheet's plain language. */
  expects: string;
  status: Status;
  reason?: string;
  message: string;
  found: GateEvidence[];
  baseline?: { run: string; status: Status; found: GateEvidence[] };
}

/** Why a requirement (or, without one, the task's outcome) regressed: the first candidate run it did not pass. */
export interface GateFinding {
  requirement?: string;
  allowed: boolean;
  /** The run shown. */
  run: string;
  verdict: Verdict;
  /** Every candidate run it did not pass (did not succeed in, for an outcome). */
  runs: string[];
  checks: GateCheckDetail[];
}

export interface GateRunResult {
  name: string;
  path: string;
  verdict: Verdict;
  /** Requirement id → status. */
  requirements: Record<string, Status>;
}

export interface GateTask {
  task: string;
  checkSet: { id: string; version: string; digest: string; file?: string };
  status: GateStatus;
  blocking: boolean;
  /** Regressed or missing, but every regression is allowed. */
  allowed: boolean;
  /** The task's verdicts: `pass` counts successes. */
  outcome: { status: GateStatus; baseline: GateCounts | null; candidate: GateCounts | null };
  requirements: GateRequirement[];
  findings: GateFinding[];
  runs: { baseline: GateRunResult[]; candidate: GateRunResult[] };
}

export interface GateSummary {
  tasks: number;
  regressed: number;
  improved: number;
  unchanged: number;
  new: number;
  missing: number;
  /** Tasks that fail the gate. */
  blocking: number;
  /** Tasks that regressed (or went missing) with every regression allowed. */
  allowed: number;
}

export interface GateResult {
  schema: typeof GATE_SCHEMA;
  /** Nothing blocking: keep the change. */
  ok: boolean;
  tolerance: number;
  minRuns: number;
  allow: string[];
  baseline: { sources: string[]; runs: number };
  candidate: { sources: string[]; runs: number };
  summary: GateSummary;
  /** Changed tasks first (regressed, missing, improved, new), then unchanged; by name within each. */
  tasks: GateTask[];
  /** Tasks with runs the gate could not judge (no check set), and empty run directories. */
  skipped: { task: string; reason: string }[];
}

/** Input the gate cannot judge: a missing or empty side, check sets that differ between the sides, too few runs. */
export class GateError extends Error {
  override name = 'GateError';
}

interface Run {
  name: string;
  path: string;
  snapshot: EvidenceSnapshot;
}

interface Side {
  sources: string[];
  /** Task → runs. */
  runs: Map<string, Run[]>;
  /** Task → the check set file a side directory pins. */
  pinned: Map<string, string>;
  empty: string[];
}

const isPathList = (x: unknown): x is string | readonly string[] => typeof x === 'string' || Array.isArray(x);
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The directories a side names: each spec a directory, or a glob of directories. */
function sideRoots(specs: readonly string[], cwd: string, what: string): string[] {
  const roots: string[] = [];
  for (const spec of specs) {
    const abs = resolve(cwd, spec);
    if (existsSync(abs)) {
      if (!statSync(abs).isDirectory()) throw new GateError(`${what} ${spec} is not a directory of runs`);
      roots.push(abs);
      continue;
    }
    const pattern = isAbsolute(spec) ? spec : `${escapeGlob(resolve(cwd))}/${spec}`;
    const dirs = globSync(pattern).filter((d) => statSync(d).isDirectory());
    if (!dirs.length) throw new GateError(`${what} not found: ${spec}`);
    roots.push(...dirs.map((d) => resolve(d)).toSorted(byName));
  }
  return [...new Set(roots)];
}

/** A side from directories: `<root>/<task>/*.json` runs, and `<root>/<task>.checks.*` pinned sets. */
function readSideDirs(specs: readonly string[], cwd: string, show: (p: string) => string, what: string): Side {
  const side: Side = { sources: [], runs: new Map(), pinned: new Map(), empty: [] };
  for (const root of sideRoots(specs, cwd, what)) {
    side.sources.push(show(root));
    const entries = readdirSync(root, { withFileTypes: true }).toSorted((a, b) => byName(a.name, b.name));
    for (const e of entries) {
      const path = join(root, e.name);
      if (e.isFile() && CHECK_SET_FILE.test(e.name)) {
        const task = checkSetName(e.name);
        const other = side.pinned.get(task);
        if (other && other !== path) side.pinned.set(task, `${other}\0${path}`);
        else side.pinned.set(task, path);
        continue;
      }
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const files = readdirSync(path)
        .filter((f) => f.endsWith('.json'))
        .toSorted(byName);
      if (!files.length) {
        side.empty.push(show(path));
        if (!side.runs.has(e.name)) side.runs.set(e.name, []);
        continue;
      }
      const runs = side.runs.get(e.name) ?? [];
      for (const f of files) {
        const file = join(path, f);
        runs.push({ name: basename(f, '.json'), path: show(file), snapshot: toSnapshot(readSnapshotFile(file)) });
      }
      side.runs.set(e.name, runs);
    }
  }
  if (!totalRuns(side))
    throw new GateError(
      `no runs in the ${what} (${side.sources.join(', ')}): expected one directory of .json snapshots per task, <dir>/<task>/*.json`,
    );
  return side;
}

/** A side given in memory. */
function readSideMemory(input: Readonly<Record<string, readonly GateRunInput[]>>, what: string): Side {
  const side: Side = { sources: ['(in memory)'], runs: new Map(), pinned: new Map(), empty: [] };
  for (const task of Object.keys(input).toSorted(byName)) {
    const list = input[task] ?? [];
    if (!list.length) side.empty.push(task);
    side.runs.set(
      task,
      list.map((r, i) => {
        const wrapped = !!r && typeof r === 'object' && 'snapshot' in r && !('schema' in r);
        const name = (wrapped && (r as { name?: string }).name) || `run-${i + 1}`;
        const path = (wrapped && (r as { path?: string }).path) || `${what}/${task}/${name}`;
        const snapshot = loadSnapshot(wrapped ? (r as { snapshot: unknown }).snapshot : r);
        return { name, path, snapshot };
      }),
    );
  }
  if (![...side.runs.values()].some((r) => r.length)) throw new GateError(`no runs in the ${what}`);
  return side;
}

interface ResolvedSet {
  set: CheckSet;
  digest: string;
  file?: string;
}

async function loadSet(file: string, show: (p: string) => string): Promise<ResolvedSet> {
  let value: unknown;
  try {
    value = await loadCheckSetFile(file);
  } catch (e) {
    throw new GateError((e as Error).message);
  }
  return checked(value, show(file));
}

function checked(value: unknown, where: string): ResolvedSet {
  const report = validateCheckSet(value);
  if (!report.ok) throw new GateError(`${where}: invalid check set: ${report.errors.join('; ')}`);
  const set = value as CheckSet;
  return { set, digest: contentDigest(set) };
}

/**
 * Whether `p` of `n` runs is a regression, an improvement or no change from `bp` of `bn`. The
 * baseline's rate is scaled to the candidate's run count: a regression is a candidate count more
 * than `tolerance` runs below `bp × n / bn`, an improvement one more than `tolerance` above it.
 * Multiplied out, so a whole-run tolerance compares integers and the result is exact.
 */
export function classifyCounts(bp: number, bn: number, p: number, n: number, tolerance = 0): GateStatus {
  const drop = bp * n - p * bn;
  if (drop > tolerance * bn) return 'regressed';
  if (-drop > tolerance * bn) return 'improved';
  return 'unchanged';
}

const dropped = (b: GateCounts, c: GateCounts) => c.pass * b.runs < b.pass * c.runs;
const matches = (s: string, p: string) => s === p || matchesGlob(s, p);
const totalRuns = (s: Side) => [...s.runs.values()].reduce((a, r) => a + r.length, 0);

/** An `allow` rule: `<task>` or `<task>:<requirement>`, each part a glob. */
function allowRules(rules: readonly string[]) {
  const parsed = rules.map((r) => {
    const i = r.lastIndexOf(':');
    return i === -1 ? { task: r } : { task: r.slice(0, i), requirement: r.slice(i + 1) };
  });
  return {
    task: (task: string) => parsed.some((r) => r.requirement === undefined && matches(task, r.task)),
    requirement: (task: string, id: string) =>
      parsed.some((r) => r.requirement !== undefined && matches(task, r.task) && matches(id, r.requirement)),
  };
}

const evidenceOf = (c: { evidence: { channel: Channel; locator?: string; value?: Json }[] }): GateEvidence[] =>
  c.evidence.map((e) => ({
    channel: e.channel,
    ...(e.locator ? { locator: e.locator } : {}),
    ...(e.value !== undefined ? { value: e.value } : {}),
  }));

interface Verified {
  run: Run;
  result: Awaited<ReturnType<typeof verifyMany>>[number];
}

function counts(statuses: Status[]): GateCounts {
  return {
    runs: statuses.length,
    pass: statuses.filter((s) => s === 'pass').length,
    fail: statuses.filter((s) => s === 'fail').length,
    abstain: statuses.filter((s) => s === 'abstain').length,
  };
}

const verdictStatus = (v: Verdict): Status => (v === 'success' ? 'pass' : v);

/** A candidate run that did not pass, its checks that did not pass, and what they read in a passing baseline run. */
function finding(
  cs: CheckSet,
  requirement: string | undefined,
  allowed: boolean,
  baseline: Verified[],
  candidate: Verified[],
): GateFinding | undefined {
  const reqStatus = (v: Verified, id: string) =>
    v.result.outcome.requirements.find((r) => r.requirement === id)?.status;
  const failing = candidate.filter((v) =>
    requirement === undefined ? v.result.outcome.verdict !== 'success' : reqStatus(v, requirement) !== 'pass',
  );
  const first = failing[0];
  if (!first) return undefined;
  const reqs =
    requirement === undefined
      ? cs.requirements.filter((r) => r.kind === 'hard' && reqStatus(first, r.id) !== 'pass').map((r) => r.id)
      : [requirement];
  const passing = (id: string) => baseline.find((v) => reqStatus(v, id) === 'pass');
  const checks: GateCheckDetail[] = [];
  for (const id of reqs) {
    const good = passing(id);
    for (const c of first.result.outcome.checks) {
      if (c.requirement !== id || c.status === 'pass') continue;
      const def = cs.checks.find((x) => x.id === c.check)!;
      const before = good?.result.outcome.checks.find((x) => x.check === c.check);
      checks.push({
        check: c.check,
        description: c.description,
        expects: describeAssertion(def.assert),
        status: c.status,
        ...(c.reason ? { reason: c.reason } : {}),
        message: c.message,
        found: evidenceOf(c),
        ...(good && before
          ? { baseline: { run: good.run.path, status: before.status, found: evidenceOf(before) } }
          : {}),
      });
    }
  }
  return {
    ...(requirement !== undefined ? { requirement } : {}),
    allowed,
    run: first.run.path,
    verdict: first.result.outcome.verdict,
    runs: failing.map((v) => v.run.path),
    checks,
  };
}

const runResult = (v: Verified): GateRunResult => ({
  name: v.run.name,
  path: v.run.path,
  verdict: v.result.outcome.verdict,
  requirements: Object.fromEntries(v.result.outcome.requirements.map((r) => [r.requirement, r.status])),
});

const ORDER: Record<GateStatus, number> = { regressed: 0, missing: 1, improved: 2, new: 3, unchanged: 4 };

/**
 * Compare the runs before and after an agent change, task by task and requirement by
 * requirement, with deterministic checks only. Throws `GateError` for input it cannot judge.
 *
 * ```ts
 * const result = await gate({ baseline: 'runs/before', candidate: 'runs/after', checks: 'checks' });
 * if (!result.ok) reject(result.tasks.filter((t) => t.blocking));
 * ```
 */
export async function gate(options: GateOptions): Promise<GateResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const base = resolve(cwd, options.relativeTo ?? cwd);
  const show = (p: string) => (relative(base, p) || '.').split(sep).join('/');
  const tolerance = options.tolerance ?? 0;
  if (!(Number.isFinite(tolerance) && tolerance >= 0))
    throw new GateError(`tolerance must be a number of runs, 0 or more, got ${tolerance}`);
  const minRuns = options.minRuns ?? 1;
  if (!Number.isInteger(minRuns) || minRuns < 1)
    throw new GateError(`minRuns must be a positive integer, got ${minRuns}`);
  const allow = [...(options.allow ?? [])];
  const rules = allowRules(allow);

  const side = (input: GateSideInput, what: string): Side =>
    isPathList(input)
      ? readSideDirs(typeof input === 'string' ? [input] : input, cwd, show, what)
      : readSideMemory(input as Record<string, GateRunInput[]>, what);
  const before = side(options.baseline, 'baseline');
  const after = side(options.candidate, 'candidate');

  // The shared check sets, by task name.
  const shared = new Map<string, () => Promise<ResolvedSet>>();
  if (options.checks !== undefined) {
    if (isPathList(options.checks)) {
      const specs = (typeof options.checks === 'string' ? [options.checks] : options.checks).map((s) =>
        isAbsolute(s) || existsSync(resolve(cwd, s)) ? resolve(cwd, s) : `${escapeGlob(cwd)}/${s}`,
      );
      const files = discoverSets(specs);
      if (!files.length) throw new GateError(`no check sets (*.checks.json, *.checks.ts) at ${specs.join(', ')}`);
      const seen = new Map<string, string>();
      for (const f of files) {
        const name = checkSetName(f);
        if (seen.has(name))
          throw new GateError(`two check sets are named "${name}": ${show(seen.get(name)!)} and ${show(f)}`);
        seen.set(name, f);
        shared.set(name, () => loadSet(f, show).then((r) => ({ ...r, file: show(f) })));
      }
    } else {
      for (const [task, value] of Object.entries(options.checks))
        shared.set(task, async () => checked(value, `check set for ${task}`));
    }
  }

  const tasks = [...new Set([...before.runs.keys(), ...after.runs.keys()])].toSorted(byName);
  const skipped: GateResult['skipped'] = [
    ...before.empty.map((d) => ({ task: d.split('/').at(-1)!, reason: `no runs in ${d}` })),
    ...after.empty.map((d) => ({ task: d.split('/').at(-1)!, reason: `no runs in ${d}` })),
  ];
  const pinnedSet = async (s: Side, task: string): Promise<ResolvedSet | undefined> => {
    const p = s.pinned.get(task);
    if (!p) return undefined;
    const [first, ...more] = await Promise.all(
      p.split('\0').map((f) => loadSet(f, show).then((r) => ({ ...r, file: show(f) }))),
    );
    const other = more.find((m) => m.digest !== first!.digest);
    if (other)
      throw new GateError(
        `the check sets for "${task}" differ within one side: ${first!.file} and ${other.file} (${first!.digest.slice(7, 19)} ≠ ${other.digest.slice(7, 19)})`,
      );
    return first;
  };

  const mismatches: string[] = [];
  const tooFew: string[] = [];
  const judged: { task: string; set: ResolvedSet; b: Run[]; c: Run[] }[] = [];
  for (const task of tasks) {
    const b = before.runs.get(task) ?? [];
    const c = after.runs.get(task) ?? [];
    if (!b.length && !c.length) continue;
    const common = await shared.get(task)?.();
    const sb = (await pinnedSet(before, task)) ?? common;
    const sc = (await pinnedSet(after, task)) ?? common;
    if (!sb && !sc) {
      skipped.push({ task, reason: `no check set named "${task}"` });
      continue;
    }
    if (sb && sc && sb.digest !== sc.digest) {
      mismatches.push(
        `${task}: baseline ${sb.file ?? 'set'} (${sb.digest.slice(7, 19)}) ≠ candidate ${sc.file ?? 'set'} (${sc.digest.slice(7, 19)})`,
      );
      continue;
    }
    for (const [what, runs] of [
      ['baseline', b],
      ['candidate', c],
    ] as const)
      if (runs.length && runs.length < minRuns) tooFew.push(`${task}: ${plural(runs.length, `${what} run`)}`);
    judged.push({ task, set: (sb ?? sc)!, b, c });
  }
  if (mismatches.length)
    throw new GateError(
      `the check sets differ between the baseline and the candidate, so their runs cannot be compared:\n  ${mismatches.join('\n  ')}\nJudge both sides with one check set (re-verify or re-capture the baseline under the new set).`,
    );
  if (tooFew.length) throw new GateError(`too few runs (minimum ${minRuns} per side):\n  ${tooFew.join('\n  ')}`);
  if (!judged.length)
    throw new GateError(
      `no task has both runs and a check set${skipped.length ? `:\n  ${skipped.map((s) => `${s.task}: ${s.reason}`).join('\n  ')}` : ''}`,
    );

  const out: GateTask[] = [];
  for (const { task, set, b, c } of judged) {
    const cs = set.set;
    const results = await verifyMany(
      cs,
      [...b, ...c].map((r) => r.snapshot),
      { config: false },
    );
    const vb: Verified[] = b.map((run, i) => ({ run, result: results[i]! }));
    const vc: Verified[] = c.map((run, i) => ({ run, result: results[b.length + i]! }));
    const taskAllowed = rules.task(task);
    const sideCounts = (vs: Verified[], id?: string) =>
      vs.length
        ? counts(
            vs.map((v) =>
              id === undefined
                ? verdictStatus(v.result.outcome.verdict)
                : (v.result.outcome.requirements.find((r) => r.requirement === id)?.status ?? 'abstain'),
            ),
          )
        : null;
    const oneSided: GateStatus | undefined = !vb.length ? 'new' : !vc.length ? 'missing' : undefined;
    const status = (bc: GateCounts | null, cc: GateCounts | null): GateStatus =>
      oneSided ?? classifyCounts(bc!.pass, bc!.runs, cc!.pass, cc!.runs, tolerance);

    const requirements: GateRequirement[] = cs.requirements.map((r) => {
      const bc = sideCounts(vb, r.id);
      const cc = sideCounts(vc, r.id);
      const st = status(bc, cc);
      const allowed = taskAllowed || rules.requirement(task, r.id);
      return {
        id: r.id,
        kind: r.kind,
        text: r.text,
        status: st,
        blocking: (st === 'regressed' || st === 'missing') && !allowed,
        allowed,
        baseline: bc,
        candidate: cc,
      };
    });
    const ob = sideCounts(vb);
    const oc = sideCounts(vc);
    const outcomeStatus = status(ob, oc);
    // An outcome regression that allowed requirements account for entirely is allowed too.
    const lost = requirements.filter(
      (r) => r.kind === 'hard' && r.baseline && r.candidate && dropped(r.baseline, r.candidate),
    );
    const outcomeAllowed = taskAllowed || (lost.length > 0 && lost.every((r) => r.allowed));
    const outcomeBlocks =
      (outcomeStatus === 'regressed' && !outcomeAllowed) || (outcomeStatus === 'missing' && !taskAllowed);

    const statuses = new Set([outcomeStatus, ...requirements.map((r) => r.status)]);
    const taskStatus: GateStatus =
      oneSided ?? (statuses.has('regressed') ? 'regressed' : statuses.has('improved') ? 'improved' : 'unchanged');
    const blocking = outcomeBlocks || requirements.some((r) => r.blocking && r.status === 'regressed');

    const findings: GateFinding[] = [];
    if (taskStatus === 'regressed') {
      for (const r of requirements.filter((x) => x.status === 'regressed')) {
        const f = finding(cs, r.id, r.allowed, vb, vc);
        if (f) findings.push(f);
      }
      if (outcomeStatus === 'regressed' && !findings.length) {
        const f = finding(cs, undefined, outcomeAllowed, vb, vc);
        if (f) findings.push(f);
      }
    }
    out.push({
      task,
      checkSet: { id: cs.id, version: cs.version, digest: set.digest, ...(set.file ? { file: set.file } : {}) },
      status: taskStatus,
      blocking,
      allowed: (taskStatus === 'regressed' || taskStatus === 'missing') && !blocking,
      outcome: { status: outcomeStatus, baseline: ob, candidate: oc },
      requirements,
      findings,
      runs: { baseline: vb.map(runResult), candidate: vc.map(runResult) },
    });
  }
  out.sort((x, y) => ORDER[x.status] - ORDER[y.status] || byName(x.task, y.task));

  const n = (s: GateStatus) => out.filter((t) => t.status === s).length;
  const summary: GateSummary = {
    tasks: out.length,
    regressed: n('regressed'),
    improved: n('improved'),
    unchanged: n('unchanged'),
    new: n('new'),
    missing: n('missing'),
    blocking: out.filter((t) => t.blocking).length,
    allowed: out.filter((t) => t.allowed).length,
  };
  return {
    schema: GATE_SCHEMA,
    ok: summary.blocking === 0,
    tolerance,
    minRuns,
    allow,
    baseline: { sources: before.sources, runs: totalRuns(before) },
    candidate: { sources: after.sources, runs: totalRuns(after) },
    summary,
    tasks: out,
    skipped: skipped.toSorted((a, b) => byName(a.task, b.task) || byName(a.reason, b.reason)),
  };
}
