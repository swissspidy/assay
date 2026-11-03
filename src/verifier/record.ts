/**
 * Outcome records (milestone 4): one auditable JSON document per verification,
 * written next to a content-addressed copy of the evidence snapshot.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AbstainReason, Evidence, EvidenceSnapshot, Json, Status, Verdict } from '../types.ts';
import type { RequirementVerdict, VerifierResult } from './verifier.ts';

export const RECORD_SCHEMA = 'assay.record/v1' as const;

export interface RecordedRequirement {
  id: string;
  kind: 'hard' | 'soft';
  quote: string;
  status: Status;
  /** Who decided: the locked checks, the agentic verifier, or nobody (abstain). */
  decidedBy: 'checks' | 'verifier' | 'none';
  reason?: AbstainReason | string;
  /** Observed evidence only. */
  evidence: (Evidence | { origin: 'observed'; channel: 'verifier'; observation: string })[];
}

export interface OutcomeRecord {
  schema: typeof RECORD_SCHEMA;
  id: string;
  createdAt: string;
  task: { id: string; instruction: string; outcomes?: string };
  checkSet: { id: string; version: string; digest: string; locked: { by: string; at: string } | null };
  snapshot: { digest: string; url: string; capturedAt: string; file?: string };
  verdict: Verdict;
  requirements: RecordedRequirement[];
  checks: { id: string; requirement: string; status: Status; reason?: AbstainReason; message: string }[];
  drift: { check: string; locator: string }[];
  escalation?: {
    policy: { on: ('abstain' | 'fail')[]; includeSoft: boolean };
    requirements: string[];
    model: string;
    modelsUsed: string[];
    status: VerifierResult['status'];
    verdicts: RequirementVerdict[];
    observations: VerifierResult['observations'];
    usage: VerifierResult['usage'];
    turns: number;
  };
  /**
   * What the agent said it did, kept for audit next to the evidence. Labelled
   * agent-claimed; never used to decide anything.
   */
  agentClaims?: { origin: 'agent-claimed'; text: string };
  /** A recompiled check set proposed after escalation; it needs human approval before use. */
  proposal?: { status: 'pending-approval'; checkSetDigest: string; checks: number; file?: string; reason: string };
  timings: { checksMs: number; escalationMs?: number; proposalMs?: number };
}

export function newRecordId(): string {
  return randomUUID();
}

export interface WrittenRecord {
  recordFile: string;
  snapshotFile: string;
  proposalFile?: string;
}

/**
 * Write a record to `<dir>/records/<createdAt>-<id>.json` and the snapshot to
 * `<dir>/snapshots/<digest>.json` (deduplicated by digest).
 */
export function writeOutcomeRecord(
  dir: string,
  record: OutcomeRecord,
  snapshot: EvidenceSnapshot,
  proposal?: Json,
): WrittenRecord {
  const snapDir = join(dir, 'snapshots');
  const recDir = join(dir, 'records');
  mkdirSync(snapDir, { recursive: true });
  mkdirSync(recDir, { recursive: true });
  const snapshotFile = join(snapDir, `${record.snapshot.digest.replace('sha256:', '')}.json`);
  if (!existsSync(snapshotFile)) writeFileSync(snapshotFile, JSON.stringify(snapshot) + '\n');
  const stamp = record.createdAt.replace(/[:.]/g, '-');
  let proposalFile: string | undefined;
  const out: OutcomeRecord = { ...record, snapshot: { ...record.snapshot, file: snapshotFile } };
  if (proposal !== undefined && record.proposal) {
    const propDir = join(dir, 'proposals');
    mkdirSync(propDir, { recursive: true });
    proposalFile = join(propDir, `${record.proposal.checkSetDigest.replace('sha256:', '')}.checks.json`);
    writeFileSync(proposalFile, JSON.stringify(proposal, null, 2) + '\n');
    out.proposal = { ...record.proposal, file: proposalFile };
  }
  const recordFile = join(recDir, `${stamp}-${record.id}.json`);
  writeFileSync(recordFile, JSON.stringify(out, null, 2) + '\n');
  return { recordFile, snapshotFile, ...(proposalFile ? { proposalFile } : {}) };
}
