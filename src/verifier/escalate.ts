/**
 * Escalation (pipeline step 7): run the locked checks; when a requirement
 * abstains (or, if configured, fails), ask the agentic verifier; record the
 * outcome; optionally propose a recompiled check set for re-approval.
 */
import type { Page } from '@playwright/test';
import type { CheckSet, EvidenceSnapshot, Outcome, Requirement, Status, Verdict } from '../types.ts';
import { evaluate, kleeneAnd } from '../runtime/evaluate.ts';
import { checkSetDigest } from '../snapshot/digest.ts';
import type { ModelClient } from '../model/types.ts';
import type { Probe } from '../snapshot/capture.ts';
import { compileTask } from '../compiler/compile.ts';
import { runVerifier, type VerifierResult } from './verifier.ts';
import { newRecordId, RECORD_SCHEMA, type OutcomeRecord, type RecordedRequirement } from './record.ts';
import { isLocked } from './lock.ts';

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
  /** Live read-only access for the verifier. */
  page?: Page;
  probes?: Record<string, Probe>;
  /** The agent's own report (recorded as agent-claimed; context only for the verifier). */
  agentReport?: string;
  /**
   * When the verifier decides requirements the checks abstained on and the final
   * verdict is success, recompile checks from this snapshot with this model.
   * The proposal is returned and recorded as pending approval; it is never used
   * automatically.
   */
  proposer?: ModelClient;
  /** Refuse to run an unlocked check set (default false). */
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

const toStatus = (s: 'pass' | 'fail' | 'unknown'): Status => (s === 'unknown' ? 'abstain' : s);

export async function verifyWithEscalation(
  cs: CheckSet,
  snapshot: EvidenceSnapshot,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  if (opts.requireLocked && !isLocked(cs))
    throw new Error(`Check set ${cs.id} v${cs.version} is not locked (or was edited after locking).`);
  const policy = { on: opts.policy?.on ?? ['abstain'], includeSoft: opts.policy?.includeSoft ?? false };
  const t0 = performance.now();
  const checksOutcome = evaluate(cs, snapshot);
  const checksMs = performance.now() - t0;

  const toEscalate: Requirement[] = cs.requirements.filter((r) => {
    const st = checksOutcome.requirements.find((x) => x.requirement === r.id)!.status;
    return (r.kind === 'hard' || policy.includeSoft) && (policy.on as Status[]).includes(st);
  });

  let verifier: VerifierResult | undefined;
  let escalationMs: number | undefined;
  if (opts.verifier && toEscalate.length) {
    const hints: Record<string, string> = {};
    for (const r of toEscalate) {
      const msgs = checksOutcome.checks
        .filter((c) => c.requirement === r.id && c.status !== 'pass')
        .map((c) => `${c.check} ${c.status}${c.reason ? ` (${c.reason})` : ''}: ${c.message}`);
      hints[r.id] = msgs.join(' | ');
    }
    const t1 = performance.now();
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
    escalationMs = performance.now() - t1;
  }

  // Merge: the checks decide wherever they decided; the verifier fills in the rest.
  const verdictFor = new Map((verifier?.verdicts ?? []).map((v) => [v.requirement, v] as const));
  const requirements = checksOutcome.requirements.map((r) => {
    const v = verdictFor.get(r.requirement);
    if (!v || !toEscalate.some((e) => e.id === r.requirement)) return r;
    const status = toStatus(v.status);
    return {
      ...r,
      status,
      ...(status === 'abstain' ? { reason: 'subcheck_abstained' as const } : {}),
      decidedBy: 'verifier',
    };
  });
  const hard = kleeneAnd(requirements.filter((r) => r.kind === 'hard').map((r) => r.status));
  const verdict: Verdict = hard === 'pass' ? 'success' : hard;
  const outcome: Outcome = {
    ...checksOutcome,
    verdict,
    requirements: requirements.map(
      ({ decidedBy: _d, ...r }: (typeof requirements)[number] & { decidedBy?: string }) => r,
    ),
  };

  // Proposal: the checks abstained on something the verifier then passed, and the run succeeded.
  let proposal: CheckSet | undefined;
  let proposalMs: number | undefined;
  const rescued = requirements.filter(
    (r) => (r as { decidedBy?: string }).decidedBy === 'verifier' && r.status === 'pass',
  );
  if (opts.proposer && verdict === 'success' && rescued.length) {
    const t2 = performance.now();
    const res = await compileTask(
      {
        id: cs.id,
        instruction: cs.task.instruction,
        ...(cs.task.outcomes !== undefined ? { outcomes: cs.task.outcomes } : {}),
      },
      [{ name: 'escalated-run', kind: 'success', snapshot }],
      { model: opts.proposer, rubric: 'model' },
    );
    proposalMs = performance.now() - t2;
    if (res.checkSet) proposal = { ...res.checkSet, version: `${cs.version}+proposal` };
  }

  const recordedReqs: RecordedRequirement[] = cs.requirements.map((req) => {
    const r = requirements.find((x) => x.requirement === req.id)!;
    const v = verdictFor.get(req.id);
    const byVerifier = (r as { decidedBy?: string }).decidedBy === 'verifier';
    const checks = checksOutcome.checks.filter((c) => c.requirement === req.id);
    return {
      id: req.id,
      kind: req.kind,
      quote: req.source.quote,
      status: r.status,
      decidedBy: r.status === 'abstain' ? 'none' : byVerifier ? 'verifier' : 'checks',
      ...(r.reason ? { reason: r.reason } : {}),
      evidence:
        byVerifier && v
          ? v.evidence.map((observation) => ({
              origin: 'observed' as const,
              channel: 'verifier' as const,
              observation,
            }))
          : checks.flatMap((c) => c.evidence),
    };
  });

  const lock = (cs as CheckSet & { locked?: { by: string; at: string } }).locked;
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
      locked: isLocked(cs) && lock ? { by: lock.by, at: lock.at } : null,
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
    ...(verifier && opts.verifier
      ? {
          escalation: {
            policy,
            requirements: toEscalate.map((r) => r.id),
            model: opts.verifier.id,
            modelsUsed: verifier.models,
            status: verifier.status,
            verdicts: verifier.verdicts,
            observations: verifier.observations,
            usage: verifier.usage,
            turns: verifier.turns,
          },
        }
      : {}),
    ...(opts.agentReport ? { agentClaims: { origin: 'agent-claimed' as const, text: opts.agentReport } } : {}),
    ...(proposal
      ? {
          proposal: {
            status: 'pending-approval' as const,
            checkSetDigest: checkSetDigest(proposal),
            checks: proposal.checks.length,
            reason: `Checks could not decide ${rescued.map((r) => r.requirement).join(', ')}; the verifier passed them.`,
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
