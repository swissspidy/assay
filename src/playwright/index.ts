import { test as base, type Page } from '@playwright/test';
import type { CheckSet, EvidenceSnapshot, Outcome } from '../types.ts';
import {
  EvidenceRecorder,
  captureBaseline,
  captureScopedSnapshot,
  captureSnapshot,
  type RecorderOptions,
} from '../snapshot/capture.ts';
import { assertValidCheckSet } from '../dsl/validate.ts';
import { formatOutcome } from '../report.ts';
import { verify, type VerifyResult } from '../verifier/escalate.ts';
import { assertLocked } from '../verifier/lock.ts';
import {
  attachOutcome,
  pollOutcome,
  withProjectConfig,
  type ExpectOutcomeOptions,
  type VerifyPageOptions,
} from './live.ts';

/**
 * Playwright `test` with an auto fixture that records the network log of every
 * test's browser context from its start, so network checks have evidence.
 * Configure the recorder with `test.use({ evidenceOptions: { bodyTimeoutMs: 10_000 } })`;
 * it is attached once per context, so later `EvidenceRecorder.attach` options are ignored.
 */
export const test = base.extend<{ evidence: EvidenceRecorder; evidenceOptions: RecorderOptions }>({
  evidenceOptions: [{}, { option: true }],
  evidence: [
    async ({ context, evidenceOptions }, use) => {
      await use(await EvidenceRecorder.attach(context, evidenceOptions));
    },
    { auto: true },
  ],
});

/**
 * Capture a snapshot of the page and `verify` it: run the checks, escalate what
 * they cannot decide to `verifier` (if given), and build the outcome record.
 */
export async function verifyPage(
  page: Page,
  checks: CheckSet | unknown,
  options: VerifyPageOptions = {},
): Promise<VerifyResult> {
  const cs = assertValidCheckSet(checks);
  const opts = await withProjectConfig(options);
  // Before capturing: an unlocked set must not run probes or touch the page.
  assertLocked(cs, opts.requireLocked);
  const snapshot = await captureSnapshot(page, opts);
  return verify(cs, snapshot, { ...opts, page });
}

export class OutcomeError extends Error {
  readonly outcome: Outcome;
  readonly snapshot: EvidenceSnapshot;
  constructor(message: string, outcome: Outcome, snapshot: EvidenceSnapshot) {
    super(message);
    this.outcome = outcome;
    this.snapshot = snapshot;
    this.name = 'OutcomeError';
  }
}

/**
 * Assert the outcome of a task on a live page. Captures a snapshot and evaluates
 * the check set, polling like Playwright's web-first assertions. With `verifier`,
 * requirements the checks still cannot decide once polling settles escalate to
 * the agentic verifier. Returns the final outcome; throws OutcomeError if the
 * expected verdict is not reached.
 */
export async function expectOutcome(
  page: Page,
  checks: CheckSet | unknown,
  options: ExpectOutcomeOptions = {},
): Promise<Outcome> {
  const cs = assertValidCheckSet(checks);
  const opts = await withProjectConfig(options);
  assertLocked(cs, opts.requireLocked);
  const want = opts.verdict ?? 'success';
  const { outcome, snapshot, record } = await pollOutcome(page, cs, opts, (v) => v === want);
  if (opts.attach !== false) await attachOutcome(cs, outcome, snapshot, record);

  if (outcome.verdict !== want) {
    throw new OutcomeError(
      `Expected verdict ${want.toUpperCase()}, got ${outcome.verdict.toUpperCase()}\n\n${formatOutcome(outcome)}`,
      outcome,
      snapshot,
    );
  }
  return outcome;
}

export type { ExpectOutcomeOptions, Polled, VerifyPageOptions } from './live.ts';
export { assayMatchers, expect, formatCompletion, type CompletedOptions, type TaskInput } from './matchers.ts';
export { EvidenceRecorder, captureBaseline, captureScopedSnapshot, captureSnapshot };
export type { BaselineOptions, CaptureOptions, Probe, RecorderOptions } from '../snapshot/capture.ts';
