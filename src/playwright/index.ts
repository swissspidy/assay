import { test as base, type Page } from '@playwright/test';
import type { CheckSet, EvidenceSnapshot, Outcome, Verdict } from '../types.js';
import { EvidenceRecorder, captureSnapshot, type CaptureOptions } from '../snapshot/capture.js';
import { assertValidCheckSet } from '../dsl/validate.js';
import { evaluate } from '../runtime/evaluate.js';
import { formatOutcome } from '../report.js';

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
}

export class OutcomeError extends Error {
  constructor(
    message: string,
    readonly outcome: Outcome,
    readonly snapshot: EvidenceSnapshot,
  ) {
    super(message);
    this.name = 'OutcomeError';
  }
}

/**
 * Assert the outcome of a task on a live page. Captures a snapshot and evaluates
 * the locked check set, polling like Playwright's web-first assertions. Returns
 * the final outcome; throws OutcomeError if the expected verdict is not reached.
 */
export async function expectOutcome(page: Page, checks: CheckSet | unknown, opts: ExpectOutcomeOptions = {}): Promise<Outcome> {
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

  if (opts.attach !== false) {
    try {
      const info = base.info();
      await info.attach(`assay-outcome-${cs.id.replace(/[^\w.-]+/g, '_')}.json`, { body: JSON.stringify(outcome, null, 2), contentType: 'application/json' });
      await info.attach(`assay-snapshot-${cs.id.replace(/[^\w.-]+/g, '_')}.json`, { body: JSON.stringify(snapshot), contentType: 'application/json' });
    } catch {
      /* not running inside a Playwright test */
    }
  }

  if (outcome.verdict !== want) {
    throw new OutcomeError(`Expected verdict ${want.toUpperCase()}, got ${outcome.verdict.toUpperCase()}\n\n${formatOutcome(outcome)}`, outcome, snapshot);
  }
  return outcome;
}

export { EvidenceRecorder, captureSnapshot };
