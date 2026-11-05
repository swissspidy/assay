/**
 * Outcome records (milestone 4): one auditable JSON document per verification,
 * written next to content-addressed copies of the evidence snapshot, the check
 * set and every observation the verifier made.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AbstainReason, CheckSet, Evidence, EvidenceSnapshot, Json, Status, Verdict } from '../types.ts';
import { checkSetDigest, sha256, snapshotDigest } from '../snapshot/digest.ts';
import type { Observation, RequirementVerdict, VerifierResult } from './verifier.ts';
import type { SignatureStatus } from './lock.ts';

export const RECORD_SCHEMA = 'assay.record/v1' as const;

export interface RecordedRequirement {
  id: string;
  kind: 'hard' | 'soft';
  quote: string;
  status: Status;
  /** Who decided: the locked checks, the agentic verifier, or nobody (abstain). */
  decidedBy: 'checks' | 'verifier' | 'none';
  reason?: AbstainReason | string;
  /**
   * Set when a verifier was given: why the requirement was escalated ("policy", or
   * "onFail" when its failed checks asked for it), or "kept" when a failed check's
   * `onFail: "keep"` kept a failure the policy would have escalated.
   */
  escalation?: 'policy' | 'onFail' | 'kept';
  /**
   * What decided it: observed check evidence, or the tool outputs the verifier
   * cited (labelled verifier-cited). Never the model's prose or the agent's claims.
   */
  evidence: (Evidence | { origin: 'verifier-cited'; channel: 'verifier'; observation: string })[];
}

export interface RecordedObservation extends Omit<Observation, 'output'> {
  /** First characters of the output; the full output is stored content-addressed. */
  excerpt: string;
  outputDigest: string;
  file?: string;
}

export interface OutcomeRecord {
  schema: typeof RECORD_SCHEMA;
  id: string;
  createdAt: string;
  task: { id: string; instruction: string; outcomes?: string };
  checkSet: {
    id: string;
    version: string;
    digest: string;
    /** The valid lock; `signature` when it is signed (its status against the trusted keys `verify` was given). */
    locked: {
      by: string;
      at: string;
      signature?: { keyId: string; status: SignatureStatus; signer?: string };
    } | null;
    /** A lock is present but no longer matches the content. */
    lockBroken: boolean;
    /** Why the lock is broken (e.g. "changed after approval: check C2 changed"). */
    lockProblems?: string[];
    file?: string;
  };
  snapshot: { digest: string; url: string; capturedAt: string; file?: string };
  verdict: Verdict;
  requirements: RecordedRequirement[];
  checks: {
    id: string;
    requirement: string;
    status: Status;
    reason?: AbstainReason;
    message: string;
    /** The check's own escalation setting, when it has one. */
    onFail?: 'escalate' | 'keep';
    /** "abstain" when the check reads route evidence (ADR 0011). */
    onMissing?: 'fail' | 'abstain';
  }[];
  drift: { check: string; locator: string }[];
  escalation?: {
    policy: { on: ('abstain' | 'fail')[]; includeSoft: boolean };
    requirements: string[];
    model: string;
    modelsUsed: string[];
    status: VerifierResult['status'] | 'error';
    error?: string;
    /** The verifier's verdicts, including its reasoning (notes, not evidence). */
    verdicts: RequirementVerdict[];
    observations: (Observation | RecordedObservation)[];
    usage: VerifierResult['usage'];
    turns: number;
  };
  /**
   * What the agent said it did, kept for audit next to the evidence. Labelled
   * agent-claimed; never used to decide anything.
   */
  agentClaims?: { origin: 'agent-claimed'; text: string };
  /** A recompiled check set proposed after escalation; it needs human approval before use. */
  proposal?:
    | {
        status: 'pending-approval';
        version: string;
        checkSetDigest: string;
        checks: number;
        file?: string;
        reason: string;
      }
    | { status: 'failed'; error: string; reason: string };
  timings: { checksMs: number; escalationMs?: number; proposalMs?: number };
}

export function newRecordId(): string {
  return randomUUID();
}

export interface WrittenRecord {
  recordFile: string;
  snapshotFile: string;
  checkSetFile: string;
  proposalFile?: string;
}

const hex = (digest: string) => digest.replace('sha256:', '');

function writeOnce(file: string, content: string): void {
  if (!existsSync(file)) writeFileSync(file, content);
}

/** What `writeOutcomeRecord` needs: the parts of a `verify` result it writes. */
export interface RecordInput {
  record: OutcomeRecord;
  snapshot: EvidenceSnapshot;
  checkSet: CheckSet;
  proposal?: CheckSet;
}

/**
 * Write a `verify` result's record to `<dir>/records/<createdAt>-<id>.json` with
 * content-addressed copies under `snapshots/`, `checksets/`, `observations/` and
 * `proposals/`. The snapshot and check-set digests are recomputed, not trusted
 * from the record.
 */
export function writeOutcomeRecord(dir: string, { record, snapshot, checkSet, proposal }: RecordInput): WrittenRecord {
  const snapDigest = snapshotDigest(snapshot);
  if (snapDigest !== record.snapshot.digest)
    throw new Error(`Snapshot digest ${snapDigest} does not match the record (${record.snapshot.digest}).`);
  const csDigest = checkSetDigest(checkSet);
  if (csDigest !== record.checkSet.digest)
    throw new Error(`Check set digest ${csDigest} does not match the record (${record.checkSet.digest}).`);
  for (const sub of ['records', 'snapshots', 'checksets', 'observations'])
    mkdirSync(join(dir, sub), { recursive: true });

  const snapshotFile = join(dir, 'snapshots', `${hex(snapDigest)}.json`);
  writeOnce(snapshotFile, JSON.stringify(snapshot) + '\n');
  const checkSetFile = join(dir, 'checksets', `${hex(csDigest)}.json`);
  writeOnce(checkSetFile, JSON.stringify(checkSet, null, 2) + '\n');

  const out: OutcomeRecord = {
    ...record,
    snapshot: { ...record.snapshot, file: snapshotFile },
    checkSet: { ...record.checkSet, file: checkSetFile },
  };
  if (record.escalation) {
    out.escalation = {
      ...record.escalation,
      observations: record.escalation.observations.map((o) => {
        if (!('output' in o)) return o;
        const digest = sha256(o.output);
        const file = join(dir, 'observations', `${hex(digest)}.txt`);
        writeOnce(file, o.output);
        const { output, ...rest } = o;
        return { ...rest, excerpt: output.slice(0, 300), outputDigest: digest, file };
      }),
    };
  }
  let proposalFile: string | undefined;
  if (proposal && record.proposal?.status === 'pending-approval') {
    mkdirSync(join(dir, 'proposals'), { recursive: true });
    proposalFile = join(dir, 'proposals', `${hex(record.proposal.checkSetDigest)}.checks.json`);
    writeFileSync(proposalFile, JSON.stringify(proposal as unknown as Json, null, 2) + '\n');
    out.proposal = { ...record.proposal, file: proposalFile };
  }
  const recordFile = join(dir, 'records', `${record.createdAt.replace(/[:.]/g, '-')}-${record.id}.json`);
  writeFileSync(recordFile, JSON.stringify(out, null, 2) + '\n');
  return { recordFile, snapshotFile, checkSetFile, ...(proposalFile ? { proposalFile } : {}) };
}
