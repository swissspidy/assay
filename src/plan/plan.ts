/**
 * Compiled check plans (ADR 0015): everything about a check set that does not depend on the
 * snapshot, done once per check-set object. Evaluation runs a plan against evidence stores.
 */
import type {
  AssertionResult,
  Check,
  CheckResult,
  CheckSet,
  EvidenceSnapshot,
  Outcome,
  RequirementResult,
} from '../types.ts';
import { CheckSetError, validateCheckSet, type ValidationReport } from '../dsl/validate.ts';
import { checkSetDigest } from '../snapshot/digest.ts';
import { verifyLock, type LockCheckOptions, type LockStatus } from '../verifier/lock.ts';
import { keyId, trustedKeySet, type TrustedKeySet } from '../verifier/sign.ts';
import { buildStore, changedKeys, type EvidenceStore } from '../store/store.ts';
import { regularTree } from '../store/ax.ts';
import { abstain, compileAssertion, kleeneAnd, type EvalCtx, type Run, type Seq } from './assertions.ts';
import { readKeys, readsChanged, readSetOf, unionReadSets, type ReadKey, type ReadSet } from './readset.ts';
import { once } from '../runtime/once.ts';

/** One check of a plan. */
export interface PlannedCheck {
  readonly check: Check;
  /** The check's assertion, prepared on first evaluation. */
  readonly run: () => Run;
  /** What the check can read (see `ReadSet`). */
  readonly readSet: ReadSet;
  /**
   * The parts of a snapshot the check's result depends on (`readKeys`); null when that
   * cannot be told (an unknown kind, or a check too malformed to describe): all of it.
   */
  readonly reads: ReadonlySet<ReadKey> | null;
}

export class CheckPlan {
  /** The check set, as given (validated by `assertValid`, not by compiling). */
  readonly checkSet: CheckSet;
  private readonly validation: () => ValidationReport;
  private readonly digestOf: () => string;
  private readonly checksOf: () => PlannedCheck[];
  private readonly readSetValue: () => ReadSet;
  private noKeys?: LockStatus;
  /** By the content of the trusted key set (ids and names), never by the caller's object, which can change. */
  private readonly byKeys = new Map<string, LockStatus>();

  constructor(checkSet: CheckSet) {
    this.checkSet = checkSet;
    this.validation = once(() => validateCheckSet(checkSet));
    this.digestOf = once(() => checkSetDigest(checkSet));
    this.checksOf = once(() =>
      checkSet.checks.map((check) => {
        const readSet = once(() => readSetOf(check.assert));
        const reads = once(() => {
          try {
            return readKeys(readSet());
          } catch {
            return null;
          }
        });
        return {
          check,
          run: once(() => compileAssertion(check.assert)),
          get readSet() {
            return readSet();
          },
          get reads() {
            return reads();
          },
        };
      }),
    );
    this.readSetValue = once(() => unionReadSets(this.checks.map((c) => c.readSet)));
  }

  /** `validateCheckSet(checkSet)`, run once. */
  get report(): ValidationReport {
    return this.validation();
  }

  /** The check set, or a `CheckSetError` when it is not valid (as `assertValidCheckSet`). */
  assertValid(): CheckSet {
    const report = this.validation();
    if (!report.ok) throw new CheckSetError(report);
    return this.checkSet;
  }

  /** `checkSetDigest(checkSet)`, computed once. */
  get digest(): string {
    return this.digestOf();
  }

  get checks(): PlannedCheck[] {
    return this.checksOf();
  }

  /** What the check set can read: the union of its checks' read-sets. */
  get readSet(): ReadSet {
    return this.readSetValue();
  }

  /**
   * `verifyLock(checkSet, opts)`, kept per set of trusted keys (a copy each call). The trusted
   * keys are read on every call and the memo is keyed by what they are (the map's id, the name,
   * and the fingerprint of the key itself), so a key removed or replaced in the caller's list is
   * no longer trusted on the next call.
   */
  readonly lockStatus = (cs: CheckSet, opts: LockCheckOptions): LockStatus => {
    let s: LockStatus | undefined;
    if (opts.trustedKeys === undefined) s = this.noKeys ??= verifyLock(cs, opts);
    else {
      const set: TrustedKeySet =
        'keys' in opts.trustedKeys && opts.trustedKeys.keys instanceof Map
          ? (opts.trustedKeys as TrustedKeySet)
          : trustedKeySet(opts.trustedKeys as Parameters<typeof trustedKeySet>[0]);
      // JSON, not joined strings: a name can contain any separator, so two different key sets
      // could otherwise produce the same memo key. The fingerprint is of the key object itself,
      // since a TrustedKeySet can hold a key under an id that is not its own.
      const key = JSON.stringify(
        [...set.keys]
          .map(([id, k]): [string, string, string] => [id, k.name, keyId(k.key)])
          .toSorted(([a, , x], [b, , y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)),
      );
      s = this.byKeys.get(key);
      if (!s) {
        s = verifyLock(cs, { trustedKeys: set });
        if (this.byKeys.size >= 64) this.byKeys.clear();
        this.byKeys.set(key, s);
      }
    }
    return { ...s, changes: [...s.changes], problems: [...s.problems] };
  };
}

const plans = new WeakMap<object, CheckPlan>();

/**
 * The plan of `checkSet`, compiled on first use and cached for the check-set object: its
 * validation, digest, lock status and prepared checks are computed once however many
 * snapshots it runs on. A check set must not be edited once it has run; edit a copy.
 */
export function compileChecks(checkSet: CheckSet | unknown): CheckPlan {
  if (!checkSet || typeof checkSet !== 'object') return new CheckPlan(checkSet as CheckSet);
  let p = plans.get(checkSet);
  if (!p) plans.set(checkSet, (p = new CheckPlan(checkSet as CheckSet)));
  return p;
}

export interface EvaluateOptions {
  /** Compute snapshot and check-set digests (default true). Stress testing skips them for speed. */
  digests?: boolean;
}

/** The two contexts a snapshot's checks run in: as given, and reading route evidence (`onMissing: "abstain"`). */
function contexts(store: EvidenceStore): [EvalCtx, EvalCtx] {
  const ctx: EvalCtx = { snapshot: store.snapshot, index: store.ax };
  return [ctx, { ...ctx, routeMissing: true }];
}

/** `contexts`, with the tree indexed when a check first reads it. */
function lazyContexts(store: EvidenceStore): [EvalCtx, EvalCtx] {
  const snapshot = store.snapshot;
  return [
    {
      snapshot,
      get index() {
        return store.ax;
      },
    },
    {
      snapshot,
      routeMissing: true,
      get index() {
        return store.ax;
      },
    },
  ];
}

function checkResult(c: PlannedCheck, [ctx, routed]: [EvalCtx, EvalCtx]): CheckResult {
  const check = c.check;
  let r: AssertionResult;
  try {
    r = c.run()(check.onMissing === 'abstain' ? routed : ctx);
  } catch (e) {
    // Defensive: a check that throws must never decide. Validation should prevent this.
    r = abstain('type_mismatch', `check raised an error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { seq: _seq, ...result } = r as Seq;
  return { check: check.id, requirement: check.requirement, description: check.description, ...result };
}

function outcomeOf(plan: CheckPlan, store: EvidenceStore, checks: CheckResult[], opts: EvaluateOptions): Outcome {
  const checkSet = plan.checkSet;
  const snapshot: EvidenceSnapshot = store.snapshot;
  const requirements: RequirementResult[] = checkSet.requirements.map((req) => {
    const mine = checks.filter((c) => c.requirement === req.id);
    const base = { requirement: req.id, kind: req.kind, text: req.text, checks: mine.map((c) => c.check) };
    if (mine.length === 0) return { ...base, status: 'abstain', reason: 'uncovered' };
    const status = kleeneAnd(mine.map((c) => c.status));
    if (status !== 'abstain') return { ...base, status };
    const reasons = [...new Set(mine.filter((c) => c.status === 'abstain').map((c) => c.reason))];
    return { ...base, status, reason: reasons.length === 1 && reasons[0] ? reasons[0] : 'subcheck_abstained' };
  });

  const hard = kleeneAnd(requirements.filter((r) => r.kind === 'hard').map((r) => r.status));
  const verdict = hard === 'pass' ? 'success' : hard;

  return {
    verdict,
    checkSet: {
      id: checkSet.id,
      version: checkSet.version,
      digest: opts.digests === false ? '' : plan.digest,
    },
    snapshot: {
      digest: opts.digests === false ? '' : store.digest,
      url: snapshot.page.url,
      capturedAt: snapshot.capturedAt,
    },
    requirements,
    checks,
    drift: checks.flatMap((c) => [...new Set(c.drift)].map((locator) => ({ check: c.check, locator }))),
  };
}

/** Run a plan on one store: the checks-only outcome `evaluate` returns. */
export function runPlan(plan: CheckPlan, store: EvidenceStore, opts: EvaluateOptions = {}): Outcome {
  const ctxs = contexts(store);
  const checks = plan.checks.map((c) => checkResult(c, ctxs));
  return outcomeOf(plan, store, checks, opts);
}

/**
 * A plan run on one store whose check results are computed on demand, each once (ADR 0016).
 *
 * With a `base` run, the store is an overlay on the base's: its snapshot was made from the
 * base's by replacing some parts and sharing the others by identity, as the stress test's
 * variants and mutants are. A check that reads none of the replaced parts (`readKeys`,
 * `changedKeys`) takes the base's result for it; only the others run here. Every result
 * equals what `runPlan(plan, store)` gives for that check, and `outcome()` equals its outcome.
 */
export class PlanRun {
  readonly plan: CheckPlan;
  readonly store: EvidenceStore;
  private readonly base?: PlanRun;
  /** What the store replaced of the base's snapshot; null: compare nothing, run every check. */
  private readonly changed: ReadonlySet<string> | null;
  private readonly ctxs: [EvalCtx, EvalCtx];
  private readonly results: (CheckResult | undefined)[];

  /** A run of `plan` on `store`; with `base`, an overlay on that run (the same plan). */
  constructor(plan: CheckPlan, store: EvidenceStore, base?: PlanRun) {
    this.plan = plan;
    this.store = store;
    this.changed = base && base.plan === plan ? changedKeys(base.store.snapshot, store.snapshot) : null;
    if (this.changed) this.base = base;
    // runPlan indexes the tree before any check runs, so a tree that cannot be indexed throws
    // there. An overlay whose tree is the base's, or regular (which always indexes), indexes
    // it when a check first reads it: a mutant whose checks read other evidence never does.
    const lazy = !!this.changed && (!this.changed.has('a11y') || regularTree(store.snapshot.a11y));
    this.ctxs = lazy ? lazyContexts(store) : contexts(store);
    this.results = Array.from({ length: plan.checks.length });
  }

  /** The result of the plan's check `i`. */
  check(i: number): CheckResult {
    let r = this.results[i];
    if (!r) {
      const c = this.plan.checks[i]!;
      const reads = c.reads;
      r =
        this.base && reads !== null && !readsChanged(reads, this.changed!)
          ? this.base.check(i)
          : checkResult(c, this.ctxs);
      this.results[i] = r;
    }
    return r;
  }

  /** The outcome: `runPlan(plan, store, opts)`. */
  outcome(opts: EvaluateOptions = {}): Outcome {
    return outcomeOf(
      this.plan,
      this.store,
      this.plan.checks.map((_, i) => this.check(i)),
      opts,
    );
  }
}

/**
 * Run a plan on many stores, check by check: each check's prepared assertion runs on every
 * store before the next check, so its matchers and indexes stay hot. The outcomes equal
 * `stores.map((s) => runPlan(plan, s, opts))`. `timings[i]`, when given, gains the time spent on store i.
 */
export function runPlanMany(
  plan: CheckPlan,
  stores: EvidenceStore[],
  opts: EvaluateOptions = {},
  timings?: Float64Array,
): Outcome[] {
  const ctxs = stores.map((s, i) => {
    const t0 = timings ? performance.now() : 0;
    const c = contexts(s);
    if (timings) timings[i]! += performance.now() - t0;
    return c;
  });
  const results: CheckResult[][] = stores.map(() => []);
  for (const c of plan.checks)
    for (let i = 0; i < stores.length; i++) {
      const t0 = timings ? performance.now() : 0;
      results[i]!.push(checkResult(c, ctxs[i]!));
      if (timings) timings[i]! += performance.now() - t0;
    }
  // Building the outcome (the snapshot digest, on a fresh store) is timed too, as in `runPlan`.
  return stores.map((s, i) => {
    const t0 = timings ? performance.now() : 0;
    const o = outcomeOf(plan, s, results[i]!, opts);
    if (timings) timings[i]! += performance.now() - t0;
    return o;
  });
}

/** Evaluate a check set on a snapshot (no validation, no escalation), through its plan and the snapshot's store. */
export function evaluate(checkSet: CheckSet, snapshot: EvidenceSnapshot, opts: EvaluateOptions = {}): Outcome {
  return runPlan(compileChecks(checkSet), buildStore(snapshot), opts);
}
