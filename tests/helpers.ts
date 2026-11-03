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
  type Probe,
} from '../src/index.js';

export function loadChecks(name: string): CheckSet {
  return JSON.parse(
    readFileSync(new URL(`../examples/tiny-shop/tasks/${name}.checks.json`, import.meta.url), 'utf8'),
  ) as CheckSet;
}

/** Read-only backend probes for Tiny Shop (they share the browser context's session cookie). */
export function shopProbes(page: Page): Record<string, Probe> {
  const get = async (path: string) => {
    const r = await page.request.get(path);
    if (!r.ok()) throw new Error(`${path} → ${r.status()}`);
    return r.json();
  };
  return { cart: () => get('/api/cart'), latestOrder: () => get('/api/orders/latest') };
}

export const ready = (page: Page) => page.locator('body[data-ready]').waitFor();

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

// --- "Agent" actions on Tiny Shop -------------------------------------------

export async function addToCart(page: Page, product: string): Promise<void> {
  if (!page.url().endsWith('/')) {
    await page.goto('/');
    await ready(page);
  }
  const done = page.waitForResponse((r) => r.url().endsWith('/api/cart/items') && r.request().method() === 'POST');
  await page.getByRole('button', { name: `Add ${product} to cart` }).click();
  await done;
  await expect(page.getByRole('status')).toHaveText(`${product} added to cart`);
}

export async function openCart(page: Page): Promise<void> {
  await page.goto('/cart');
  await ready(page);
}

export async function checkout(
  page: Page,
  opts: { name?: string; shipping?: 'standard' | 'express'; giftWrap?: boolean },
): Promise<void> {
  await page.goto('/checkout');
  await ready(page);
  if (opts.name) await page.getByLabel('Full name').fill(opts.name);
  if (opts.shipping === 'express') await page.getByRole('radio', { name: 'Express' }).check();
  if (opts.giftWrap) await page.getByRole('checkbox', { name: 'Gift wrap' }).check();
  await page.getByRole('button', { name: 'Place order' }).click();
  await page.waitForURL(/\/orders\/\w+$/);
  await ready(page);
}

export async function openSettings(page: Page): Promise<void> {
  await page.goto('/settings');
  await ready(page);
}

export async function setNewsletter(page: Page, on: boolean): Promise<void> {
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/settings') && r.request().method() === 'PUT');
  await page.getByRole('checkbox', { name: 'Email me the newsletter' }).setChecked(on);
  await saved;
}
