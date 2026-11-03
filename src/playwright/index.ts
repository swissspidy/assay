import { test as base, type Page } from '@playwright/test';
import type { CheckSet, EvidenceSnapshot, Outcome, Verdict } from '../types.ts';
import { EvidenceRecorder, captureSnapshot, type CaptureOptions } from '../snapshot/capture.ts';
import { assertValidCheckSet } from '../dsl/validate.ts';
import { evaluate } from '../runtime/evaluate.ts';
import { formatOutcome } from '../report.ts';
import { verifyWithEscalation, type VerifyOptions } from '../verifier/escalate.ts';
import { writeOutcomeRecord, type OutcomeRecord } from '../verifier/record.ts';
import type { Json } from '../types.ts';

/**
 * Playwright `test` with an auto fixture that records the network log of every
 * test's browser context from its start, so network checks have evidence.
 */
export const test = base.extend<{ evidence: EvidenceRecorder }>({
  evidence: [
    async ({ context }, use) => {
      await use(await EvidenceRecorder.attach(context));
    },
    { auto: true },
  ],
});

export interface ExpectOutcomeOptions extends CaptureOptions {
  /** Verdict the test expects (default "success"). */
  verdict?: Verdict;
  /** Poll until the expected verdict is reached or this many ms elapse (default 5000). 0 = single evaluation. */
  timeout?: number;
  /** Poll interval in ms (default 250). */
  interval?: number;
  /** Attach the snapshot and outcome to the Playwright report (default true). */
  attach?: boolean;
  /**
   * Escalate requirements the checks cannot decide to the agentic verifier
   * (needs `escalate.verifier`). The verifier gets read-only live access to the page.
   */
  escalate?: Omit<VerifyOptions, 'page' | 'probes'>;
  /** Write an outcome record (and the snapshot) under this directory. */
  recordDir?: string;
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
 * the locked check set, polling like Playwright's web-first assertions. Returns
 * the final outcome; throws OutcomeError if the expected verdict is not reached.
 */
export async function expectOutcome(
  page: Page,
  checks: CheckSet | unknown,
  opts: ExpectOutcomeOptions = {},
): Promise<Outcome> {
  const cs = assertValidCheckSet(checks);
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
  if (opts.escalate?.verifier || opts.recordDir) {
    const res = await verifyWithEscalation(cs, snapshot, {
      ...opts.escalate,
      page,
      ...(opts.probes ? { probes: opts.probes } : {}),
      ...(opts.escalate?.verifier && outcome.verdict !== want ? {} : { verifier: undefined }),
    });
    outcome = res.outcome;
    record = res.record;
    if (opts.recordDir) writeOutcomeRecord(opts.recordDir, record, snapshot, res.proposal as unknown as Json);
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

export { EvidenceRecorder, captureSnapshot };
