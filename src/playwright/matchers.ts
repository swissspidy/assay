/**
 * `expect(page).toHaveCompleted(task)` (ADR 0019): a Playwright matcher that verifies a task's
 * outcome on the live page, polling like web-first assertions (`expectOutcome`), and fails with
 * the requirement-by-requirement story: each failing check's description, what it tests, what
 * it read, and where that evidence is.
 */
import { expect as baseExpect, type ExpectMatcherState, type MatcherReturnType, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import type { CheckResult, CheckSet, Outcome, Verdict } from '../types.ts';
import { assertValidCheckSet } from '../dsl/validate.ts';
import { assertLocked, describeAssertion } from '../verifier/lock.ts';
import { loadCheckSetFile } from '../checks/load.ts';
import {
  attachOutcome,
  attachmentNames,
  pollOutcome,
  withProjectConfig,
  type ExpectOutcomeOptions,
  type Polled,
} from './live.ts';

/**
 * The task: a check set (as JSON, or from the builder) or the path of a check set file
 * (`*.checks.json`, `*.checks.ts`), relative to the current directory.
 */
export type TaskInput = CheckSet | string;

/**
 * Options of `toHaveCompleted`: those of `expectOutcome`. `timeout` defaults to the expect
 * timeout; `verdict` is the verdict that counts as completed (default `'success'`); `escalate`
 * sends what the checks cannot decide to the config's model once polling settles.
 */
export interface CompletedOptions extends ExpectOutcomeOptions {}

/** Loaded check set files, by path and modification time. */
const files = new Map<string, Promise<CheckSet>>();

async function taskOf(task: TaskInput): Promise<CheckSet> {
  if (typeof task !== 'string') return assertValidCheckSet(task);
  const path = resolve(task);
  let mtime = 0;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    /* loadCheckSetFile names the missing file */
  }
  const key = `${path}@${mtime}`;
  let hit = files.get(key);
  if (!hit) {
    hit = loadCheckSetFile(path).then(assertValidCheckSet);
    files.set(key, hit);
    hit.catch(() => files.delete(key));
  }
  return hit;
}

const ICON = { pass: '✔', fail: '✘', abstain: '?' } as const;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** What a failing (or abstaining) check read: its evidence values, or that it read nothing. */
function received(c: CheckResult): string {
  const read = c.evidence.filter((e) => e.value !== undefined);
  if (!read.length) return '(no value)';
  if (read.every((e) => Array.isArray(e.value) && e.value.length === 0)) return 'nothing matched';
  return clip(read.map((e) => JSON.stringify(e.value)).join(' | '), 240);
}

/**
 * The failure story of an outcome, as the matcher prints it: each requirement with its status;
 * under a requirement that is not passed, each check that is not passed with its description,
 * what it tests (expected), what it read (received), why, and where the evidence is.
 */
export function formatCompletion(cs: CheckSet, outcome: Outcome, opts: { snapshotName?: string } = {}): string {
  const lines: string[] = [];
  const checkOf = new Map(cs.checks.map((c) => [c.id, c] as const));
  for (const r of outcome.requirements) {
    const by = r.decidedBy === 'verifier' ? ' (decided by the verifier)' : '';
    lines.push(
      `${ICON[r.status]} ${r.requirement} [${r.kind}] ${r.text}: ${r.status}${r.reason ? ` (${r.reason})` : ''}${by}`,
    );
    if (r.status === 'pass') continue;
    for (const e of r.verifierEvidence ?? []) lines.push(`    verifier: ${clip(oneLine(e), 200)}`);
    for (const id of r.checks) {
      const c = outcome.checks.find((x) => x.check === id);
      if (!c) continue;
      if (c.status === 'pass') {
        lines.push(`    ✔ ${c.check}: ${c.description}`);
        continue;
      }
      const def = checkOf.get(c.check);
      lines.push(`    ${ICON[c.status]} ${c.check}: ${c.description}`);
      if (def) lines.push(`        expected: ${clip(oneLine(describeAssertion(def.assert)), 300)}`);
      lines.push(`        received: ${received(c)}`);
      lines.push(
        `        ${c.status === 'fail' ? 'why' : 'abstained'}: ${c.reason ? `${c.reason}: ` : ''}${clip(oneLine(c.message), 300)}`,
      );
      for (const e of c.evidence) {
        const where = e.locator ? `${e.locator} ` : '';
        lines.push(
          `        evidence: ${where}(${e.channel}, ${e.trust})${opts.snapshotName ? ` in ${opts.snapshotName}` : ''}`,
        );
      }
    }
  }
  if (outcome.drift.length) {
    lines.push(`Drift: ${outcome.drift.map((d) => `${d.check} ${d.locator}`).join('; ')}`);
  }
  return lines.join('\n');
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function message(
  state: ExpectMatcherState,
  cs: CheckSet,
  want: Verdict,
  polled: Polled,
  attached: boolean,
  options: CompletedOptions,
): string {
  const { outcome } = polled;
  const u = state.utils;
  const names = attachmentNames(cs);
  const hint = u.matcherHint('toHaveCompleted', 'page', 'task', { isNot: state.isNot });
  const lines = [
    hint,
    '',
    `Task: ${cs.id} v${cs.version}: ${JSON.stringify(clip(oneLine(cs.task.instruction), 120))}`,
    `Expected verdict: ${state.isNot ? 'not ' : ''}${u.printExpected(want.toUpperCase())}`,
    `Received verdict: ${u.printReceived(outcome.verdict.toUpperCase())}  (${polled.polls} snapshot${polled.polls === 1 ? '' : 's'} in ${seconds(polled.elapsed)}${options.timeout === 0 ? ', timeout 0' : ''})`,
    '',
    formatCompletion(cs, outcome, attached ? { snapshotName: names.snapshot } : {}),
  ];
  if (attached)
    lines.push('', `Attached: ${names.outcome}, ${names.snapshot}${polled.record ? `, ${names.record}` : ''}`);
  return lines.join('\n');
}

/** Matchers for `expect.extend`: `expect(page).toHaveCompleted(task, options)`. */
export const assayMatchers = {
  /**
   * Verify the task on the page, polling until the verdict is `options.verdict` (default
   * `'success'`) or the timeout (default: the expect timeout) passes. With `.not`, polls until
   * the verdict is anything else (fail or abstain).
   */
  async toHaveCompleted(
    this: ExpectMatcherState,
    page: Page,
    task: TaskInput,
    options: CompletedOptions = {},
  ): Promise<MatcherReturnType> {
    const cs = await taskOf(task);
    const opts = await withProjectConfig({ ...options, timeout: options.timeout ?? this.timeout });
    assertLocked(cs, opts.requireLocked);
    const want = opts.verdict ?? 'success';
    const isNot = this.isNot;
    const polled = await pollOutcome(page, cs, opts, (v) => (v === want) !== isNot);
    const attached = opts.attach !== false && (await attachOutcome(cs, polled.outcome, polled.snapshot, polled.record));
    const pass = polled.outcome.verdict === want;
    return {
      pass,
      name: 'toHaveCompleted',
      expected: want,
      actual: polled.outcome.verdict,
      message: () => message(this, cs, want, polled, attached, opts),
      // Reported as a timeout when polling ran out without reaching the verdict asked for.
      ...(pass === isNot && (opts.timeout ?? 0) > 0 ? { timeout: opts.timeout } : {}),
    };
  },
};

/** Playwright's `expect` with `toHaveCompleted`. */
export const expect = baseExpect.extend(assayMatchers);
