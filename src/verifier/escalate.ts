/**
 * Verification (pipeline step 7): run the locked checks; when a requirement
 * abstains (or, if configured, fails), ask the agentic verifier; record the
 * outcome; optionally propose a recompiled check set for re-approval.
 */
import type { Page } from '@playwright/test';
import type { CheckSet, EvidenceSnapshot, Outcome, Requirement, RequirementResult, Verdict } from '../types.ts';
import { kleeneAnd } from '../plan/assertions.ts';
import { compileChecks, runPlan, runPlanMany, type CheckPlan } from '../plan/plan.ts';
import { buildStore } from '../store/store.ts';
import { checkSetDigest } from '../snapshot/digest.ts';
import type { ModelClient } from '../model/types.ts';
import { describeModel, noModelError, resolveModel, type ModelInput, type ModelOptions } from '../model/resolve.ts';
import { loadConfig, normalizeConfig, readTrustedKeys, type AssayConfig } from '../config/config.ts';
import type { Probe } from '../snapshot/capture.ts';
import { compileTask } from '../compiler/compile.ts';
import { citedEvidence, runVerifier, type VerifierResult } from './verifier.ts';
import {
  newRecordId,
  RECORD_SCHEMA,
  writeOutcomeRecord,
  type OutcomeRecord,
  type RecordedRequirement,
  type WrittenRecord,
} from './record.ts';
import { assertLocked, lockState, type LockCheckOptions, type LockRequirement } from './lock.ts';

export interface EscalationPolicy {
  /**
   * Requirement statuses that trigger the verifier (default ["abstain"]). A check's
   * `onFail` overrides this for failures it causes (see selectRequirement).
   */
  on?: ('abstain' | 'fail')[];
  /** Also escalate soft requirements (default false). */
  includeSoft?: boolean;
}

export interface VerifyOptions {
  /**
   * Model for the agentic verifier: a `ModelClient`, an AI SDK model, an adapter or a
   * `'provider:model'` string (ADR 0017). Without it (and without `escalate` in the
   * config), nothing escalates and no model runs. It is resolved only when a requirement
   * escalates.
   */
  verifier?: ModelInput;
  /**
   * Escalate with the config's `model` (default: the config's `escalate`, else false).
   * `false` turns off escalation the config asks for; an explicit `verifier` always escalates.
   */
  escalate?: boolean;
  /** How to drive and name `verifier` and `proposer` (default: the config's `modelOptions`). */
  modelOptions?: ModelOptions;
  /**
   * A config to fill in what is not given (`recordDir`, `requireLocked`, `trustedKeys`,
   * escalation): an object or a file path. Default: none; `verify` never reads
   * assay.config.* by itself (the CLI and the Playwright helpers do). Explicit options win.
   */
  config?: AssayConfig | string | false;
  policy?: EscalationPolicy;
  /** Live read-only access for the verifier (an isolated context with a copy of the session). */
  page?: Page;
  probes?: Record<string, Probe>;
  /** The agent's own report (recorded as agent-claimed; context only for the verifier). */
  agentReport?: string;
  /**
   * When the verifier passes hard requirements the checks abstained on and the
   * final verdict is success, recompile the checks (keeping the confirmed
   * requirements) from this snapshot with this model. The proposal is recorded
   * as pending approval and is never used automatically.
   */
  proposer?: ModelInput;
  /**
   * Refuse to run a check set without a valid lock (default false): `true` accepts any
   * valid lock; `{ trustedKeys }` also requires a signature by one of those Ed25519
   * public keys (ADR 0013). Throws `LockError`, naming what changed when a lock is broken.
   */
  requireLocked?: LockRequirement;
  /**
   * Ed25519 public keys whose lock signatures are trusted: the record says whether the
   * lock is signed by one of them. To require it, pass them as `requireLocked: { trustedKeys }`.
   */
  trustedKeys?: LockCheckOptions['trustedKeys'];
  /** Task id for the record (defaults to the check set id). */
  taskId?: string;
  maxVerifierTurns?: number;
  /** Write the outcome record (with the snapshot and check set) under this directory. */
  recordDir?: string;
}

export interface VerifyResult {
  /** Final outcome after escalation; requirement and verdict statuses reflect the verifier's decisions. */
  outcome: Outcome;
  /** The checks-only outcome. */
  checksOutcome: Outcome;
  record: OutcomeRecord;
  /** The validated check set that ran. */
  checkSet: CheckSet;
  snapshot: EvidenceSnapshot;
  verifier?: VerifierResult;
  proposal?: CheckSet;
  /** Where the record went, when `recordDir` was given. */
  written?: WrittenRecord;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Why a requirement is (or is not) escalated:
 * - "policy": its status is in `policy.on`, and no failed check says otherwise;
 * - "onFail": it failed, the policy keeps failures, and every check that failed it says "escalate";
 * - "kept": it failed, the policy escalates failures, but a check that failed it says "keep";
 * - undefined: not escalated (passed, soft without includeSoft, or not in the policy).
 *
 * A failure is escalated only when every check that failed the requirement allows it:
 * one robust check that failed is enough to keep the failure.
 */
export function selectRequirement(
  cs: CheckSet,
  req: Requirement,
  outcome: Outcome,
  policy: Required<EscalationPolicy>,
): EscalationSelection | undefined {
  if (req.kind !== 'hard' && !policy.includeSoft) return undefined;
  const status = outcome.requirements.find((r) => r.requirement === req.id)?.status;
  if (status === 'abstain') return policy.on.includes('abstain') ? 'policy' : undefined;
  if (status !== 'fail') return undefined;
  const byPolicy = policy.on.includes('fail');
  const failed = outcome.checks.filter((c) => c.requirement === req.id && c.status === 'fail');
  const onFail = (id: string) => cs.checks.find((c) => c.id === id)?.onFail ?? (byPolicy ? 'escalate' : 'keep');
  const escalate = failed.length > 0 && failed.every((c) => onFail(c.check) === 'escalate');
  if (escalate) return byPolicy ? 'policy' : 'onFail';
  return byPolicy ? 'kept' : undefined;
}

export type EscalationSelection = 'policy' | 'onFail' | 'kept';

/**
 * Verify a task outcome: validate the check set (throws `CheckSetError`), run it
 * on the snapshot, escalate what it cannot decide to `opts.verifier` (if given),
 * and build the outcome record. No model runs unless `verifier` or `proposer` is set.
 */
export async function verify(
  checkSet: CheckSet | unknown,
  snapshot: EvidenceSnapshot,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const [opts, models] = await withConfig(options);
  const [plan, cs] = prepare(checkSet, opts);
  const t0 = performance.now();
  const checksOutcome = runPlan(plan, buildStore(snapshot));
  return finish(plan, cs, snapshot, checksOutcome, performance.now() - t0, opts, models);
}

/** A model resolved on first use, once: a run that escalates nothing never loads it. */
interface LazyModel {
  label: string;
  get(): Promise<ModelClient>;
}

function lazyModel(input: ModelInput, opts: ModelOptions): LazyModel {
  let p: Promise<ModelClient> | undefined;
  return { label: describeModel(input, opts), get: () => (p ??= resolveModel(input, opts)) };
}

interface Models {
  verifier?: LazyModel;
  proposer?: LazyModel;
}

const keysOf = new WeakMap<AssayConfig, ReturnType<typeof readTrustedKeys>>();
/** A config object passed in, checked once (a hot loop passes the same object every time). */
const given = new WeakMap<AssayConfig, AssayConfig>();

/**
 * The config an option names: an object (checked once per object) or a file path. Nothing,
 * or `false`, is no config: library calls never read assay.config.* by themselves (ADR 0017).
 */
export async function configOf(config: AssayConfig | string | false | undefined): Promise<AssayConfig> {
  if (config === undefined || config === false) return {};
  if (typeof config === 'string') return (await loadConfig({ path: config })).config;
  let c = given.get(config);
  if (!c) given.set(config, (c = normalizeConfig(config, process.cwd(), 'config')));
  return c;
}

/**
 * The options with a config's defaults filled in (explicit options win): `recordDir`,
 * `requireLocked`, `trustedKeys`, the escalation policy, and the config's `model` as the
 * verifier when it escalates. The result carries `config: false`, so it is not applied again.
 */
export function applyConfig(opts: VerifyOptions, config: AssayConfig): VerifyOptions {
  const out: VerifyOptions = { ...opts, config: false };
  if (out.recordDir === undefined && config.recordDir !== undefined) out.recordDir = config.recordDir;
  if (config.trustedKeys?.length) {
    let keys = keysOf.get(config);
    if (!keys) keysOf.set(config, (keys = readTrustedKeys(config.trustedKeys)));
    out.trustedKeys ??= keys;
    if (out.requireLocked === undefined && config.requireLocked === 'signed') out.requireLocked = { trustedKeys: keys };
  }
  if (out.requireLocked === undefined && config.requireLocked === true) out.requireLocked = true;
  if (out.policy === undefined && typeof config.escalate === 'object') out.policy = config.escalate;
  if (out.verifier === undefined && (out.escalate ?? (config.escalate !== undefined && config.escalate !== false))) {
    if (config.model === undefined)
      throw noModelError('verify with escalation', 'pass `verifier`, or turn escalation off');
    out.verifier = config.model;
    out.modelOptions = { ...config.modelOptions, ...opts.modelOptions };
  }
  return out;
}

/** The options with the given config applied, and the models to use (resolved on first use). */
async function withConfig(opts: VerifyOptions): Promise<[VerifyOptions, Models]> {
  const out = applyConfig(opts, await configOf(opts.config));
  const models: Models = {};
  if (out.verifier !== undefined) models.verifier = lazyModel(out.verifier, out.modelOptions ?? {});
  if (out.proposer !== undefined) models.proposer = lazyModel(out.proposer, out.modelOptions ?? {});
  return [out, models];
}

/**
 * Verify many runs of one task: the same results as `verify` on each snapshot in turn, in
 * order. The check set is validated (and its lock checked) once, and its checks run one at a
 * time across all snapshots before escalation and records follow, run by run (ADR 0015).
 */
export async function verifyMany(
  checkSet: CheckSet | unknown,
  snapshots: readonly EvidenceSnapshot[],
  options: VerifyOptions = {},
): Promise<VerifyResult[]> {
  // Mapping `verify` over no snapshots never validates the set, so neither does this.
  if (snapshots.length === 0) return [];
  const [opts, models] = await withConfig(options);
  const [plan, cs] = prepare(checkSet, opts);
  const timings = new Float64Array(snapshots.length);
  const outcomes = runPlanMany(plan, snapshots.map(buildStore), {}, timings);
  const results: VerifyResult[] = [];
  for (const [i, snapshot] of snapshots.entries())
    results.push(await finish(plan, cs, snapshot, outcomes[i]!, timings[i]!, opts, models));
  return results;
}

/**
 * The check set's plan (validation, digest, prepared checks) and the set itself, validated and
 * its lock checked. Plans and stores are built once per object and reused (ADR 0015).
 */
function prepare(checkSet: CheckSet | unknown, opts: VerifyOptions): [CheckPlan, CheckSet] {
  const plan = compileChecks(checkSet);
  const cs = plan.assertValid();
  assertLocked(cs, opts.requireLocked, plan.lockStatus);
  return [plan, cs];
}

/** Escalate what the checks could not decide, merge, propose, and build the record. */
async function finish(
  plan: CheckPlan,
  cs: CheckSet,
  snapshot: EvidenceSnapshot,
  checksOutcome: Outcome,
  checksMs: number,
  opts: VerifyOptions,
  models: Models,
): Promise<VerifyResult> {
  const policy: Required<EscalationPolicy> = {
    on: opts.policy?.on ?? ['abstain'],
    includeSoft: opts.policy?.includeSoft ?? false,
  };
  const checksStatus = new Map(checksOutcome.requirements.map((r) => [r.requirement, r.status] as const));

  const selection = new Map(
    cs.requirements.map((r) => [r.id, selectRequirement(cs, r, checksOutcome, policy)] as const),
  );
  const toEscalate: Requirement[] = cs.requirements.filter((r) => {
    const sel = selection.get(r.id);
    return sel === 'policy' || sel === 'onFail';
  });

  let verifier: VerifierResult | undefined;
  let verifierError: string | undefined;
  let escalationMs: number | undefined;
  let verifierId = models.verifier?.label;
  if (models.verifier && toEscalate.length) {
    const hints: Record<string, string> = {};
    for (const r of toEscalate) {
      hints[r.id] = checksOutcome.checks
        .filter((c) => c.requirement === r.id && c.status !== 'pass')
        .map((c) => `${c.check} ${c.status}${c.reason ? ` (${c.reason})` : ''}: ${c.message}`)
        .join(' | ');
    }
    const t1 = performance.now();
    try {
      const client = await models.verifier.get();
      verifierId = client.id;
      verifier = await runVerifier(
        client,
        {
          task: cs.task,
          requirements: toEscalate,
          snapshot,
          hints,
          ...(opts.page ? { page: opts.page } : {}),
          ...(opts.probes ? { probes: opts.probes } : {}),
          ...(opts.agentReport ? { agentReport: opts.agentReport } : {}),
        },
        opts.maxVerifierTurns,
      );
    } catch (e) {
      // A model or API failure must not discard the checks' outcome or the record.
      verifierError = message(e);
    }
    escalationMs = performance.now() - t1;
  }

  // Merge: the checks decide wherever they decided; the verifier's pass/fail fills in
  // what they could not. A verifier "unknown" never overrides a decision of the checks.
  const verdictFor = new Map((verifier?.verdicts ?? []).map((v) => [v.requirement, v] as const));
  const requirements: RequirementResult[] = checksOutcome.requirements.map((r) => {
    const v = verdictFor.get(r.requirement);
    if (!v || !toEscalate.some((e) => e.id === r.requirement)) return r;
    if (v.status === 'unknown') {
      return r.status === 'abstain' ? { ...r, reason: 'verifier_unknown' } : { ...r, decidedBy: 'checks' };
    }
    const { reason: _r, ...rest } = r;
    return {
      ...rest,
      status: v.status,
      decidedBy: 'verifier',
      verifierEvidence: citedEvidence(v, verifier!.observations),
    };
  });
  const hard = kleeneAnd(requirements.filter((r) => r.kind === 'hard').map((r) => r.status));
  const verdict: Verdict = hard === 'pass' ? 'success' : hard;
  const outcome: Outcome = { ...checksOutcome, verdict, requirements };

  // Proposal: a hard requirement the checks abstained on was passed by the verifier, and the run succeeded.
  let proposal: CheckSet | undefined;
  let proposalError: string | undefined;
  let proposalMs: number | undefined;
  const rescued = requirements.filter(
    (r) =>
      r.kind === 'hard' &&
      r.decidedBy === 'verifier' &&
      r.status === 'pass' &&
      checksStatus.get(r.requirement) === 'abstain',
  );
  if (models.proposer && verdict === 'success' && rescued.length) {
    const t2 = performance.now();
    try {
      const res = await compileTask(
        {
          id: cs.id,
          instruction: cs.task.instruction,
          ...(cs.task.outcomes !== undefined ? { outcomes: cs.task.outcomes } : {}),
        },
        [{ name: 'escalated-run', kind: 'success', snapshot }],
        { model: await models.proposer.get(), requirements: cs.requirements, config: false },
      );
      if (res.checkSet) {
        const draft = { ...res.checkSet, version: `${cs.version}+proposal` };
        proposal = { ...draft, version: `${cs.version}+proposal.${checkSetDigest(draft).slice(7, 15)}` };
      } else proposalError = res.report.reason ?? 'not compiled';
    } catch (e) {
      proposalError = message(e);
    }
    proposalMs = performance.now() - t2;
  }

  const recordedReqs: RecordedRequirement[] = cs.requirements.map((req) => {
    const r = requirements.find((x) => x.requirement === req.id)!;
    const byVerifier = r.decidedBy === 'verifier';
    // Only evidence of checks that agree with the requirement's status decided it.
    const checks = checksOutcome.checks.filter(
      (c) => c.requirement === req.id && (r.status === 'abstain' || c.status === r.status),
    );
    const sel = models.verifier ? selection.get(req.id) : undefined;
    return {
      id: req.id,
      kind: req.kind,
      quote: req.source.quote,
      status: r.status,
      decidedBy: r.status === 'abstain' ? 'none' : byVerifier ? 'verifier' : 'checks',
      ...(r.reason ? { reason: r.reason } : {}),
      ...(sel ? { escalation: sel } : {}),
      evidence: byVerifier
        ? (r.verifierEvidence ?? []).map((observation) => ({
            origin: 'verifier-cited' as const,
            channel: 'verifier' as const,
            observation,
          }))
        : checks.flatMap((c) => c.evidence),
    };
  });

  const trustedKeys = typeof opts.requireLocked === 'object' ? opts.requireLocked.trustedKeys : opts.trustedKeys;
  const lock = lockState(cs, trustedKeys ? { trustedKeys } : {}, plan.lockStatus);
  const onFailOf = new Map(cs.checks.map((c) => [c.id, c.onFail] as const));
  const onMissingOf = new Map(cs.checks.map((c) => [c.id, c.onMissing] as const));
  const record: OutcomeRecord = {
    schema: RECORD_SCHEMA,
    id: newRecordId(),
    createdAt: new Date().toISOString(),
    task: {
      id: opts.taskId ?? cs.id,
      instruction: cs.task.instruction,
      ...(cs.task.outcomes !== undefined ? { outcomes: cs.task.outcomes } : {}),
    },
    checkSet: {
      id: cs.id,
      version: cs.version,
      digest: checksOutcome.checkSet.digest,
      locked: lock.locked,
      lockBroken: lock.broken,
      ...(lock.problems.length ? { lockProblems: lock.problems } : {}),
    },
    snapshot: { ...checksOutcome.snapshot },
    verdict,
    requirements: recordedReqs,
    checks: checksOutcome.checks.map((c) => ({
      id: c.check,
      requirement: c.requirement,
      status: c.status,
      ...(c.reason ? { reason: c.reason } : {}),
      message: c.message,
      ...(onFailOf.get(c.check) ? { onFail: onFailOf.get(c.check) } : {}),
      ...(onMissingOf.get(c.check) ? { onMissing: onMissingOf.get(c.check) } : {}),
    })),
    drift: checksOutcome.drift,
    ...(models.verifier && toEscalate.length
      ? {
          escalation: {
            policy,
            requirements: toEscalate.map((r) => r.id),
            model: verifierId!,
            modelsUsed: verifier?.models ?? [],
            // How the model was driven, when not only native tool calling (ADR 0017).
            ...(verifier?.modes.some((m) => m !== 'tools') ? { modes: verifier.modes } : {}),
            status: verifierError !== undefined ? 'error' : verifier!.status,
            ...(verifierError !== undefined ? { error: verifierError } : {}),
            verdicts: verifier?.verdicts ?? [],
            observations: verifier?.observations ?? [],
            usage: verifier?.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
            turns: verifier?.turns ?? 0,
          },
        }
      : {}),
    ...(opts.agentReport ? { agentClaims: { origin: 'agent-claimed' as const, text: opts.agentReport } } : {}),
    ...(proposal
      ? {
          proposal: {
            status: 'pending-approval' as const,
            version: proposal.version,
            checkSetDigest: checkSetDigest(proposal),
            checks: proposal.checks.length,
            reason: `Checks could not decide ${rescued.map((r) => r.requirement).join(', ')}; the verifier passed them.`,
          },
        }
      : proposalError !== undefined
        ? {
            proposal: {
              status: 'failed' as const,
              error: proposalError,
              reason: `Recompiling after escalation failed.`,
            },
          }
        : {}),
    timings: {
      checksMs,
      ...(escalationMs !== undefined ? { escalationMs } : {}),
      ...(proposalMs !== undefined ? { proposalMs } : {}),
    },
  };

  const result: VerifyResult = {
    outcome,
    checksOutcome,
    record,
    checkSet: cs,
    snapshot,
    ...(verifier ? { verifier } : {}),
    ...(proposal ? { proposal } : {}),
  };
  if (opts.recordDir) result.written = writeOutcomeRecord(opts.recordDir, result);
  return result;
}
