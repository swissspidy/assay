/**
 * Live-page verification shared by `expectOutcome` and the `toHaveCompleted` matcher: the
 * project config, polling like Playwright's web-first assertions, and report attachments.
 */
import { test as base, type Page } from '@playwright/test';
import type { CheckSet, EvidenceSnapshot, Outcome, Verdict } from '../types.ts';
import { captureSnapshot, type CaptureOptions } from '../snapshot/capture.ts';
import { evaluate } from '../runtime/evaluate.ts';
import { applyConfig, configOf, verify, type VerifyOptions } from '../verifier/escalate.ts';
import { cachedUntilRejected, loadConfig, type AssayConfig } from '../config/config.ts';
import type { OutcomeRecord } from '../verifier/record.ts';

/**
 * Capture and verification options for a live page. The verifier gets read-only live access to it.
 * `config`: the project's assay.config.* is read by default (once per process); pass a config
 * object or path instead, or `false` for none (ADR 0017).
 */
export interface VerifyPageOptions extends CaptureOptions, Omit<VerifyOptions, 'page' | 'probes'> {}

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

/** The project's config, loaded once per process; a failed load is retried on the next call. */
const projectConfig = cachedUntilRejected(async (): Promise<AssayConfig> => (await loadConfig()).config);

/**
 * The options with the config applied. These helpers are app-level entry points: unlike
 * `verify`, they read the project's assay.config.* from the current directory by default,
 * once per process.
 */
export async function withProjectConfig<T extends VerifyPageOptions>(opts: T): Promise<T> {
  // No config file, but the options are still checked (escalate: true needs a model).
  if (opts.config === false) return applyConfig(opts, {}) as T;
  const config = opts.config === undefined ? await projectConfig() : await configOf(opts.config);
  return applyConfig(opts, config) as T;
}

/** The final polled outcome, and what it was decided on. */
export interface Polled {
  outcome: Outcome;
  snapshot: EvidenceSnapshot;
  record?: OutcomeRecord;
  /** Snapshots taken while polling. */
  polls: number;
  /** Time spent, in ms. */
  elapsed: number;
}

/**
 * Capture and evaluate until `settled(verdict)` holds or the timeout passes, then escalate
 * (when a verifier is configured and the verdict did not settle) and write the record. The
 * options are those of `expectOutcome`, with the config already applied.
 */
export async function pollOutcome(
  page: Page,
  cs: CheckSet,
  opts: ExpectOutcomeOptions,
  settled: (v: Verdict) => boolean,
): Promise<Polled> {
  const t0 = Date.now();
  const timeout = opts.timeout ?? 5000;
  const interval = opts.interval ?? 250;
  const deadline = t0 + timeout;

  let snapshot: EvidenceSnapshot;
  let outcome: Outcome;
  let polls = 0;
  for (;;) {
    snapshot = await captureSnapshot(page, opts);
    outcome = evaluate(cs, snapshot);
    polls++;
    const left = deadline - Date.now();
    if (settled(outcome.verdict) || left <= 0) break;
    // The last wait is cut to the time left, so the final snapshot is taken at the deadline.
    await page.waitForTimeout(Math.min(interval, left));
  }

  // Escalation only after polling settled: the checks had every chance to decide.
  let record: OutcomeRecord | undefined;
  if (opts.verifier || opts.recordDir) {
    const res = await verify(cs, snapshot, {
      ...opts,
      page,
      // The checks already reached the expected verdict: nothing to escalate.
      // `escalate: false` too, so escalation asked for by `escalate: true` does not look for a model.
      ...(opts.verifier && !settled(outcome.verdict) ? {} : { verifier: undefined, escalate: false }),
    });
    outcome = res.outcome;
    record = res.record;
  }
  return { outcome, snapshot, ...(record ? { record } : {}), polls, elapsed: Date.now() - t0 };
}

/** The names of a check set's attachments: its outcome, snapshot and record. */
export function attachmentNames(cs: { id: string }): { outcome: string; snapshot: string; record: string } {
  const id = cs.id.replace(/[^\w.-]+/g, '_');
  return {
    outcome: `assay-outcome-${id}.json`,
    snapshot: `assay-snapshot-${id}.json`,
    record: `assay-record-${id}.json`,
  };
}

/** Attach the outcome, the snapshot and the record to the running Playwright test, if there is one. */
export async function attachOutcome(
  cs: CheckSet,
  outcome: Outcome,
  snapshot: EvidenceSnapshot,
  record: OutcomeRecord | undefined,
): Promise<boolean> {
  const names = attachmentNames(cs);
  try {
    const info = base.info();
    await info.attach(names.outcome, { body: JSON.stringify(outcome, null, 2), contentType: 'application/json' });
    await info.attach(names.snapshot, { body: JSON.stringify(snapshot), contentType: 'application/json' });
    if (record) {
      await info.attach(names.record, { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
    }
    return true;
  } catch {
    /* not running inside a Playwright test */
    return false;
  }
}
