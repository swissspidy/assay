import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import {
  evaluate,
  loadSnapshot,
  verifyPage,
  type CaptureOptions,
  type CheckSet,
  type EvidenceSnapshot,
  type Outcome,
} from '../src/index.ts';

export function loadChecks(name: string): CheckSet {
  return JSON.parse(
    readFileSync(new URL(`../examples/tiny-shop/tasks/${name}.checks.json`, import.meta.url), 'utf8'),
  ) as CheckSet;
}

export { ready, shopProbes } from '../examples/tiny-shop/agent.ts';

const statuses = (o: Outcome) => o.checks.map((c) => `${c.check}:${c.status}${c.reason ? '/' + c.reason : ''}`);

/**
 * Evaluate on the live page, then evaluate the serialized snapshot offline,
 * and assert both give identical results.
 */
export async function judge(
  page: Page,
  checks: CheckSet,
  opts: CaptureOptions = {},
): Promise<{ outcome: Outcome; snapshot: EvidenceSnapshot }> {
  const { outcome, snapshot } = await verifyPage(page, checks, opts);
  const offline = evaluate(checks, loadSnapshot(JSON.stringify(snapshot)));
  expect(statuses(offline), 'live and snapshot evaluation must agree').toEqual(statuses(outcome));
  expect(offline.verdict).toBe(outcome.verdict);
  expect(offline.snapshot.digest).toBe(outcome.snapshot.digest);
  return { outcome, snapshot };
}

// Scripted agent actions live with the example app so scripts can reuse them.
export {
  addToCart,
  checkout,
  choose,
  openCart,
  openSettings,
  removeFromCart,
  setNewsletter,
  setQuantity,
} from '../examples/tiny-shop/agent.ts';
