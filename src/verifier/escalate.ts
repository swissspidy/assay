/**
 * Escalation (pipeline step 7): run the locked checks; when a requirement
 * abstains (or, if configured, fails), ask the agentic verifier; record the
 * outcome; optionally propose a recompiled check set for re-approval.
 */
import type { Page } from '@playwright/test';
import type { CheckSet, EvidenceSnapshot, Outcome, Requirement, RequirementResult, Status, Verdict } from '../types.ts';
import { evaluate, kleeneAnd } from '../runtime/evaluate.ts';
import { checkSetDigest } from '../snapshot/digest.ts';
import type { ModelClient } from '../model/types.ts';
import type { Probe } from '../snapshot/capture.ts';
import { compileTask } from '../compiler/compile.ts';
import { citedEvidence, runVerifier, type VerifierResult } from './verifier.ts';
import { newRecordId, RECORD_SCHEMA, type OutcomeRecord, type RecordedRequirement } from './record.ts';
import { isLocked, lockState } from './lock.ts';

export interface EscalationPolicy {
  /** Requirement statuses that trigger the verifier (default ["abstain"]). */
  on?: ('abstain' | 'fail')[];
  /** Also escalate soft requirements (default false). */
  includeSoft?: boolean;
}

export interface VerifyOptions {
  /** Model for the agentic verifier. Without it, nothing escalates. */
  verifier?: ModelClient;
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
  proposer?: ModelClient;
  /** Refuse to run an unlocked (or edited-after-locking) check set (default false). */
  requireLocked?: boolean;
  /** Task id for the record (defaults to the check set id). */
  taskId?: string;
  maxVerifierTurns?: number;
}

export interface VerifyResult {
  /** Final outcome after escalation; requirement and verdict statuses reflect the verifier's decisions. */
  outcome: Outcome;
  /** The checks-only outcome. */
  checksOutcome: Outcome;
  record: OutcomeRecord;
  verifier?: VerifierResult;
  proposal?: CheckSet;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function verifyWithEscalation(
  cs: CheckSet,
  snapshot: EvidenceSnapshot,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  if (opts.requireLocked && !isLocked(cs))
    throw new Error(`Check set ${cs.id} v${cs.version} is not locked (or was edited after locking).`);
  const policy = {
    on: opts.policy?.on ?? (['abstain'] as ('abstain' | 'fail')[]),
    includeSoft: opts.policy?.includeSoft ?? false,
  };
  const t0 = performance.now();
  const checksOutcome = evaluate(cs, snapshot);
  const checksMs = performance.now() - t0;
  const checksStatus = new Map(checksOutcome.requirements.map((r) => [r.requirement, r.status] as const));

  const toEscalate: Requirement[] = cs.requirements.filter(
    (r) => (r.kind === 'hard' || policy.includeSoft) && (policy.on as Status[]).includes(checksStatus.get(r.id)!),
  );

  let verifier: VerifierResult | undefined;
  let verifierError: string | undefined;
  let escalationMs: number | undefined;
  if (opts.verifier && toEscalate.length) {
    const hints: Record<string, string> = {};
    for (const r of toEscalate) {
      hints[r.id] = checksOutcome.checks
        .filter((c) => c.requirement === r.id && c.status !== 'pass')
        .map((c) => `${c.check} ${c.status}${c.reason ? ` (${c.reason})` : ''}: ${c.message}`)
        .join(' | ');
    }
    const t1 = performance.now();
    try {
      verifier = await runVerifier(
        opts.verifier,
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
  if (opts.proposer && verdict === 'success' && rescued.length) {
    const t2 = performance.now();
    try {
      const res = await compileTask(
        {
          id: cs.id,
          instruction: cs.task.instruction,
          ...(cs.task.outcomes !== undefined ? { outcomes: cs.task.outcomes } : {}),
        },
        [{ name: 'escalated-run', kind: 'success', snapshot }],
        { model: opts.proposer, requirements: cs.requirements },
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
    return {
      id: req.id,
      kind: req.kind,
      quote: req.source.quote,
      status: r.status,
      decidedBy: r.status === 'abstain' ? 'none' : byVerifier ? 'verifier' : 'checks',
      ...(r.reason ? { reason: r.reason } : {}),
      evidence: byVerifier
        ? (r.verifierEvidence ?? []).map((observation) => ({
            origin: 'verifier-cited' as const,
            channel: 'verifier' as const,
            observation,
          }))
        : checks.flatMap((c) => c.evidence),
    };
  });

  const lock = lockState(cs);
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
    })),
    drift: checksOutcome.drift,
    ...(opts.verifier && toEscalate.length
      ? {
          escalation: {
            policy,
            requirements: toEscalate.map((r) => r.id),
            model: opts.verifier.id,
            modelsUsed: verifier?.models ?? [],
            status: verifierError !== undefined ? 'error' : verifier!.status,
            ...(verifierError !== undefined ? { error: verifierError } : {}),
            verdicts: verifier?.verdicts ?? [],
            observations: verifier?.observations ?? [],
            usage: verifier?.usage ?? { inputTokens: 0, outputTokens: 0 },
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

  return { outcome, checksOutcome, record, ...(verifier ? { verifier } : {}), ...(proposal ? { proposal } : {}) };
}
