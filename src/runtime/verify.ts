import type { Page } from '@playwright/test';
import type { CheckSet, EvidenceSnapshot, Outcome } from '../types.js';
import { SNAPSHOT_SCHEMA } from '../types.js';
import { captureSnapshot, type CaptureOptions } from '../snapshot/capture.js';
import { assertValidCheckSet } from '../dsl/validate.js';
import { evaluate } from './evaluate.js';

export interface VerifyResult {
  outcome: Outcome;
  snapshot: EvidenceSnapshot;
}

/** Parse and minimally validate a serialized snapshot. */
export function loadSnapshot(input: string | unknown): EvidenceSnapshot {
  const s = (typeof input === 'string' ? JSON.parse(input) : input) as EvidenceSnapshot;
  if (!s || typeof s !== 'object' || s.schema !== SNAPSHOT_SCHEMA)
    throw new Error(`not an ${SNAPSHOT_SCHEMA} document`);
  if (!s.a11y || typeof s.page?.url !== 'string') throw new Error('snapshot is missing a11y or page');
  return s;
}

/** Validate a check set (throws CheckSetError) and evaluate it against a snapshot. */
export function verifySnapshot(checkSet: unknown, snapshot: EvidenceSnapshot): Outcome {
  return evaluate(assertValidCheckSet(checkSet), snapshot);
}

/** Live mode: capture a snapshot of the page, then evaluate it (ADR 0001 §3). */
export async function verifyPage(page: Page, checkSet: unknown, opts: CaptureOptions = {}): Promise<VerifyResult> {
  const cs: CheckSet = assertValidCheckSet(checkSet);
  const snapshot = await captureSnapshot(page, opts);
  return { outcome: evaluate(cs, snapshot), snapshot };
}
