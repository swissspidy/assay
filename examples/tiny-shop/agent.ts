/**
 * Scripted "agent" actions on Tiny Shop. They stand in for a real web agent in
 * tests, reference captures and evaluation trajectories.
 */
import type { Page, Probe } from './deps.ts';

export const ready = (page: Page) => page.locator('body[data-ready]').waitFor();

export async function addToCart(page: Page, product: string): Promise<void> {
  if (!page.url().endsWith('/')) {
    await page.goto('/');
    await ready(page);
  }
  const done = page.waitForResponse((r) => r.url().endsWith('/api/cart/items') && r.request().method() === 'POST');
  await page.getByRole('button', { name: `Add ${product} to cart` }).click();
  await done;
  await page
    .getByRole('status')
    .filter({ hasText: `${product} added to cart` })
    .waitFor();
}

export async function openCart(page: Page): Promise<void> {
  await page.goto('/cart');
  await ready(page);
}

export async function removeFromCart(page: Page, product: string): Promise<void> {
  const done = page.waitForResponse((r) => r.request().method() === 'DELETE');
  await page.getByRole('button', { name: `Remove ${product}` }).click();
  await done;
  await page.getByRole('row', { name: new RegExp(product) }).waitFor({ state: 'detached' });
}

const money = (n: number) => `$${n.toFixed(2)}`;

export async function setQuantity(page: Page, product: string, qty: number): Promise<void> {
  const saved = page.waitForResponse((r) => r.request().method() === 'PATCH');
  await page.getByRole('spinbutton', { name: `Quantity for ${product}` }).fill(String(qty));
  await page.keyboard.press('Tab');
  const { total } = (await (await saved).json()) as { total: number };
  // Wait until the page shows the total this PATCH returned, not just any total.
  await page
    .getByRole('status', { name: 'Cart total' })
    .filter({ hasText: money(total) })
    .waitFor();
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

export async function choose(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole('combobox', { name: label }).selectOption({ label: option });
  await page.getByRole('status').filter({ hasText: 'Settings saved' }).waitFor();
}

/** Read-only backend probes (they share the browser context's session cookie). */
export function shopProbes(page: Page): Record<string, Probe> {
  const get = async (path: string) => {
    const r = await page.request.get(path);
    if (!r.ok()) throw new Error(`${path} → ${r.status()}`);
    return r.json();
  };
  return { cart: () => get('/api/cart'), latestOrder: () => get('/api/orders/latest') };
}
