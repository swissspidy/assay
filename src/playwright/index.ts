import { test as base, type Page } from '@playwright/test';
import type { CheckSet, EvidenceSnapshot, Outcome, Verdict } from '../types.ts';
import {
  EvidenceRecorder,
  captureBaseline,
  captureSnapshot,
  type CaptureOptions,
  type RecorderOptions,
} from '../snapshot/capture.ts';
import { assertValidCheckSet } from '../dsl/validate.ts';
import { evaluate } from '../runtime/evaluate.ts';
import { formatOutcome } from '../report.ts';
import { verify, type VerifyOptions, type VerifyResult } from '../verifier/escalate.ts';
import type { OutcomeRecord } from '../verifier/record.ts';
import { isLocked } from '../verifier/lock.ts';

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

const notLocked = (cs: CheckSet) =>
  new Error(`Check set ${cs.id} v${cs.version} is not locked (or was edited after locking).`);

/** Capture and verification options for a live page. The verifier gets read-only live access to it. */
export interface VerifyPageOptions extends CaptureOptions, Omit<VerifyOptions, 'page' | 'probes'> {}

/**
 * Capture a snapshot of the page and `verify` it: run the checks, escalate what
 * they cannot decide to `verifier` (if given), and build the outcome record.
 */
export async function verifyPage(
  page: Page,
  checks: CheckSet | unknown,
  opts: VerifyPageOptions = {},
): Promise<VerifyResult> {
  const cs = assertValidCheckSet(checks);
  // Before capturing: an unlocked set must not run probes or touch the page.
  if (opts.requireLocked && !isLocked(cs)) throw notLocked(cs);
  const snapshot = await captureSnapshot(page, opts);
  return verify(cs, snapshot, { ...opts, page });
}

export interface ExpectOutcomeOptions extends VerifyPageOptions {
  /** Verdict the test expects (default "success"). */
  verdict?: Verdict;
  /** Poll until the expected verdict is reached or this many ms elapse (default 5000). 0 = single evaluation. */
  timeout?: number;
  /** Poll interval in ms (default 250). */
  interval?: number;
  /** Attach the snapshot and outcome (and record) to the Playwright report (default true). */
  attach?: boolean;
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
  opts: ExpectOutcomeOptions = {},
): Promise<Outcome> {
  const cs = assertValidCheckSet(checks);
  if (opts.requireLocked && !isLocked(cs)) throw notLocked(cs);
  const want = opts.verdict ?? 'success';
  const timeout = opts.timeout ?? 5000;
  const interval = opts.interval ?? 250;
  const deadline = Date.now() + timeout;

  let snapshot: EvidenceSnapshot;
  let outcome: Outcome;
  for (;;) {
    snapshot = await captureSnapshot(page, opts);
    outcome = evaluate(cs, snapshot);
    if (outcome.verdict === want || Date.now() + interval > deadline) break;
    await page.waitForTimeout(interval);
  }

  // Escalation only after polling settled: the checks had every chance to decide.
  let record: OutcomeRecord | undefined;
  if (opts.verifier || opts.recordDir) {
    const res = await verify(cs, snapshot, {
      ...opts,
      page,
      // The checks already reached the expected verdict: nothing to escalate.
      ...(opts.verifier && outcome.verdict !== want ? {} : { verifier: undefined }),
    });
    outcome = res.outcome;
    record = res.record;
  }

  if (opts.attach !== false) {
    try {
      const info = base.info();
      await info.attach(`assay-outcome-${cs.id.replace(/[^\w.-]+/g, '_')}.json`, {
        body: JSON.stringify(outcome, null, 2),
        contentType: 'application/json',
      });
      await info.attach(`assay-snapshot-${cs.id.replace(/[^\w.-]+/g, '_')}.json`, {
        body: JSON.stringify(snapshot),
        contentType: 'application/json',
      });
      if (record) {
        await info.attach(`assay-record-${cs.id.replace(/[^\w.-]+/g, '_')}.json`, {
          body: JSON.stringify(record, null, 2),
          contentType: 'application/json',
        });
      }
    } catch {
      /* not running inside a Playwright test */
    }
  }

  if (outcome.verdict !== want) {
    throw new OutcomeError(
      `Expected verdict ${want.toUpperCase()}, got ${outcome.verdict.toUpperCase()}\n\n${formatOutcome(outcome)}`,
      outcome,
      snapshot,
    );
  }
  return outcome;
}

export { EvidenceRecorder, captureBaseline, captureSnapshot };
export type { BaselineOptions, CaptureOptions, Probe, RecorderOptions } from '../snapshot/capture.ts';
