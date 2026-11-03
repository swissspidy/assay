/**
 * Milestone 1 acceptance: 10 handwritten check sets on the Tiny Shop app.
 * For every task:
 *   - a correct run → success (live, and identically on the serialized snapshot)
 *   - incorrect runs (wrong item, partial, over-completion, spoofed success) → fail
 *   - removing anchors / evidence channels → abstain (live DOM edits and snapshot edits)
 */
import { expect, type Page } from '@playwright/test';
import { test, expectOutcome } from '../src/playwright/index.ts';
import { evaluate, editNodes, removeNodes, type EvidenceSnapshot, type Outcome } from '../src/index.ts';
import {
  addToCart,
  checkout,
  judge,
  loadChecks,
  openCart,
  openSettings,
  ready,
  setNewsletter,
  shopProbes,
} from './helpers.ts';

const byId = (o: Outcome, id: string) => o.checks.find((c) => c.check === id)!;
const req = (o: Outcome, id: string) => o.requirements.find((r) => r.requirement === id)!;

/** Remove the accessible semantics of an element in the live page. */
const strip = (page: Page, selector: string, attrs: Record<string, string | null>) =>
  page.evaluate(
    ([sel, a]) => {
      for (const el of document.querySelectorAll(sel))
        for (const [k, v] of Object.entries(a)) {
          if (v === null) el.removeAttribute(k);
          else el.setAttribute(k, v);
        }
    },
    [selector, attrs] as const,
  );

// ---------------------------------------------------------------------------
test.describe('01 newsletter (state with redundant anchors, last response value)', () => {
  const checks = loadChecks('01-newsletter');

  test('subscribed → success', async ({ page }) => {
    await openSettings(page);
    await setNewsletter(page, true);
    await expectOutcome(page, checks, { probes: shopProbes(page) });
    const { outcome } = await judge(page, checks, { probes: shopProbes(page) });
    expect(outcome.verdict).toBe('success');
    expect(outcome.drift).toEqual([]);
  });

  test('never subscribed → fail', async ({ page }) => {
    await openSettings(page);
    const { outcome } = await judge(page, checks, { probes: shopProbes(page) });
    expect(outcome.verdict).toBe('fail');
    expect(byId(outcome, 'C1').status).toBe('fail'); // no PUT at all
    expect(byId(outcome, 'C2')).toMatchObject({ status: 'abstain', reason: 'value_unavailable' });
    expect(byId(outcome, 'C3').status).toBe('fail');
    expect(byId(outcome, 'C4').status).toBe('fail');
  });

  test('saved response says subscribed, but the backend did not store it → fail', async ({ page }) => {
    // The release-5 regression of the stability run: the PUT echoes newsletter=true and the
    // checkbox stays checked, but the stored settings are unchanged. Only the probe sees it.
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      await route.fulfill({ json: { ...route.request().postDataJSON(), stored: false } });
    });
    await openSettings(page);
    await setNewsletter(page, true);
    const { outcome } = await judge(page, checks, { probes: shopProbes(page) });
    expect(byId(outcome, 'C2').status).toBe('pass');
    expect(byId(outcome, 'C3').status).toBe('pass');
    expect(byId(outcome, 'C4').status).toBe('fail');
    expect(outcome.verdict).toBe('fail');
  });

  test('subscribed then unsubscribed (final state matters) → fail', async ({ page }) => {
    await openSettings(page);
    await setNewsletter(page, true);
    await setNewsletter(page, false);
    const { outcome } = await judge(page, checks, { probes: shopProbes(page) });
    expect(outcome.verdict).toBe('fail');
    expect(byId(outcome, 'C2').status).toBe('fail');
  });

  test('checkbox relabelled and form renamed → abstain, not fail', async ({ page }) => {
    await openSettings(page);
    await setNewsletter(page, true);
    await page.evaluate(() => {
      document.querySelector('form')!.setAttribute('aria-label', 'Options');
      document.getElementById('newsletter')!.setAttribute('aria-label', 'Send me updates');
    });
    const { outcome } = await judge(page, checks, { probes: shopProbes(page) });
    expect(req(outcome, 'R1').status).toBe('pass');
    expect(byId(outcome, 'C3')).toMatchObject({ status: 'abstain', reason: 'anchor_missing' });
    expect(outcome.verdict).toBe('abstain');
  });

  test('one anchor drifts → still decides, drift reported', async ({ page }) => {
    await openSettings(page);
    await setNewsletter(page, true);
    await strip(page, '#newsletter', { 'aria-label': 'Newsletter by email' });
    const { outcome } = await judge(page, checks, { probes: shopProbes(page) });
    expect(outcome.verdict).toBe('success');
    expect(outcome.drift).toEqual([{ check: 'C3', locator: 'checkbox named "Email me the newsletter"' }]);
  });
});

// ---------------------------------------------------------------------------
test.describe('02 add blue mug (backend probe + JSON Schema)', () => {
  const checks = loadChecks('02-add-blue-mug');

  test('added Blue Mug → success', async ({ page }) => {
    await addToCart(page, 'Blue Mug');
    await expectOutcome(page, checks, { probes: shopProbes(page) });
    expect((await judge(page, checks, { probes: shopProbes(page) })).outcome.verdict).toBe('success');
  });

  test('added the wrong mug → fail', async ({ page }) => {
    await addToCart(page, 'Red Mug');
    expect((await judge(page, checks, { probes: shopProbes(page) })).outcome.verdict).toBe('fail');
  });

  test('probe unavailable → abstain', async ({ page }) => {
    await addToCart(page, 'Blue Mug');
    const { outcome, snapshot } = await judge(page, checks, {
      probes: { cart: async () => Promise.reject(new Error('backend down')) },
    });
    expect(byId(outcome, 'C1')).toMatchObject({ status: 'abstain', reason: 'probe_error' });
    expect(evaluate(checks, { ...snapshot, probes: {} }).checks[0]).toMatchObject({
      status: 'abstain',
      reason: 'evidence_unavailable',
    });
  });
});

// ---------------------------------------------------------------------------
test.describe('03 cart has two mugs (contains in an anchored scope)', () => {
  const checks = loadChecks('03-cart-two-mugs');

  test('both mugs → success', async ({ page }) => {
    await addToCart(page, 'Blue Mug');
    await addToCart(page, 'Red Mug');
    await openCart(page);
    await expectOutcome(page, checks);
  });

  test('an extra item is not penalised (no unstated conditions)', async ({ page }) => {
    await addToCart(page, 'Blue Mug');
    await addToCart(page, 'Red Mug');
    await addToCart(page, 'Green Teapot');
    await openCart(page);
    expect((await judge(page, checks)).outcome.verdict).toBe('success');
  });

  test('only one mug (partial completion) → fail', async ({ page }) => {
    await addToCart(page, 'Blue Mug');
    await openCart(page);
    const { outcome } = await judge(page, checks);
    expect(outcome.verdict).toBe('fail');
    expect(req(outcome, 'R1').status).toBe('pass');
    expect(req(outcome, 'R2').status).toBe('fail');
  });

  test('table semantics removed → abstain (live and snapshot)', async ({ page }) => {
    await addToCart(page, 'Blue Mug');
    await addToCart(page, 'Red Mug');
    await openCart(page);
    const { snapshot } = await judge(page, checks);
    expect(evaluate(checks, removeNodes(snapshot, { role: 'table' })).verdict).toBe('abstain');

    await strip(page, 'table', { role: 'presentation' });
    const { outcome } = await judge(page, checks);
    expect(outcome.verdict).toBe('abstain');
    expect(byId(outcome, 'C1').reason).toBe('anchor_missing');
  });
});

// ---------------------------------------------------------------------------
test.describe('04 remove red mug (absence via count 0, keep the rest)', () => {
  const checks = loadChecks('04-remove-red-mug');
  const setup = async (page: Page) => {
    await addToCart(page, 'Blue Mug');
    await addToCart(page, 'Red Mug');
    await openCart(page);
  };
  const remove = async (page: Page, product: string) => {
    await page.getByRole('button', { name: `Remove ${product}` }).click();
    await expect(page.getByRole('row', { name: new RegExp(product) })).toHaveCount(0);
  };

  test('removed Red Mug → success', async ({ page }) => {
    await setup(page);
    await remove(page, 'Red Mug');
    await expectOutcome(page, checks, { probes: shopProbes(page) });
  });

  test('removed the wrong item → fail', async ({ page }) => {
    await setup(page);
    await remove(page, 'Blue Mug');
    const { outcome } = await judge(page, checks, { probes: shopProbes(page) });
    expect(outcome.verdict).toBe('fail');
    expect(req(outcome, 'R1').status).toBe('fail');
    expect(req(outcome, 'R2').status).toBe('fail');
  });

  test('emptied the whole cart (over-completion) → fail', async ({ page }) => {
    await setup(page);
    await remove(page, 'Red Mug');
    await remove(page, 'Blue Mug');
    const { outcome } = await judge(page, checks, { probes: shopProbes(page) });
    expect(req(outcome, 'R1').status).toBe('pass');
    expect(req(outcome, 'R2').status).toBe('fail');
    expect(outcome.verdict).toBe('fail');
  });

  test('an empty-looking table without its anchor does not count as "removed" → abstain', async ({ page }) => {
    await setup(page);
    await remove(page, 'Red Mug');
    await strip(page, 'table', { 'aria-label': 'Basket' });
    const { outcome } = await judge(page, checks, { probes: shopProbes(page) });
    expect(byId(outcome, 'C1')).toMatchObject({ status: 'abstain', reason: 'anchor_missing' });
    expect(byId(outcome, 'C2').status).toBe('pass');
    expect(req(outcome, 'R1').status).toBe('abstain'); // pass ∧ abstain
    expect(outcome.verdict).toBe('abstain');
  });
});

// ---------------------------------------------------------------------------
test.describe('05 set quantity (node value + number normalizer)', () => {
  const checks = loadChecks('05-set-quantity');
  const setQty = async (page: Page, n: number) => {
    await addToCart(page, 'Blue Mug');
    await openCart(page);
    const saved = page.waitForResponse((r) => r.request().method() === 'PATCH');
    await page.getByRole('spinbutton', { name: 'Quantity for Blue Mug' }).fill(String(n));
    await page.keyboard.press('Tab');
    await saved;
    await expect(page.getByRole('status', { name: 'Cart total' })).toHaveText(`$${(12 * n).toFixed(2)}`);
  };

  test('quantity 3 → success', async ({ page }) => {
    await setQty(page, 3);
    await expectOutcome(page, checks);
  });

  test('quantity 2 → fail', async ({ page }) => {
    await setQty(page, 2);
    expect((await judge(page, checks)).outcome.verdict).toBe('fail');
  });

  test('field relabelled → second anchor decides, drift reported', async ({ page }) => {
    await setQty(page, 3);
    await strip(page, 'input[type=number]', { 'aria-label': 'Qty' });
    const { outcome, snapshot } = await judge(page, checks);
    expect(outcome.verdict).toBe('success');
    expect(outcome.drift.map((d) => d.locator)).toEqual(['spinbutton named "Quantity for Blue Mug"']);
    expect(evaluate(checks, removeNodes(snapshot, { role: 'spinbutton' })).checks[0]).toMatchObject({
      status: 'abstain',
      reason: 'anchor_missing',
    });
  });

  test('field changed to a free-text box → abstain', async ({ page }) => {
    await setQty(page, 3);
    await strip(page, 'input[type=number]', { type: 'text' });
    expect((await judge(page, checks)).outcome.verdict).toBe('abstain');
  });
});

// ---------------------------------------------------------------------------
test.describe('06 cart total (currency normalizer + tolerance)', () => {
  const checks = loadChecks('06-cart-total');

  test('$21.50 → success', async ({ page }) => {
    await addToCart(page, 'Blue Mug');
    await addToCart(page, 'Red Mug');
    await openCart(page);
    await expectOutcome(page, checks);
  });

  test('formatting variants of the same amount are accepted (snapshot variants)', async ({ page }) => {
    await addToCart(page, 'Blue Mug');
    await addToCart(page, 'Red Mug');
    await openCart(page);
    const { snapshot } = await judge(page, checks);
    for (const shown of ['$21.50', '$ 21.5', 'US$21.50', '21.50 USD', 'USD 21.50']) {
      const variant = editNodes(snapshot, { role: 'status', name: 'Cart total' }, (n) => ({
        ...n,
        children: [{ role: 'text', name: shown }],
      }));
      expect(evaluate(checks, variant).verdict, shown).toBe('success');
    }
    for (const shown of ['$21.51', '€21.50', '$2,150.00']) {
      const mutant = editNodes(snapshot, { role: 'status', name: 'Cart total' }, (n) => ({
        ...n,
        children: [{ role: 'text', name: shown }],
      }));
      expect(evaluate(checks, mutant).verdict, shown).toBe('fail');
    }
    const unreadable = editNodes(snapshot, { role: 'status', name: 'Cart total' }, (n) => ({
      ...n,
      children: [{ role: 'text', name: '—' }],
    }));
    expect(evaluate(checks, unreadable).checks[0]).toMatchObject({ status: 'abstain', reason: 'normalize_failed' });
  });

  test('wrong items → fail', async ({ page }) => {
    await addToCart(page, 'Blue Mug');
    await addToCart(page, 'Green Teapot');
    await openCart(page);
    expect((await judge(page, checks)).outcome.verdict).toBe('fail');
  });

  test('total output loses its anchors → abstain', async ({ page }) => {
    await addToCart(page, 'Blue Mug');
    await addToCart(page, 'Red Mug');
    await openCart(page);
    await page.evaluate(() => {
      const out = document.getElementById('total')!;
      const span = document.createElement('span');
      span.textContent = out.textContent;
      out.replaceWith(span);
    });
    expect((await judge(page, checks)).outcome.verdict).toBe('abstain');
  });
});

// ---------------------------------------------------------------------------
test.describe('07 express order (network evidence vs. spoofed confirmation)', () => {
  const checks = loadChecks('07-express-order');

  test('express order placed → success', async ({ page }) => {
    await addToCart(page, 'Blue Mug');
    await checkout(page, { name: 'Ada Lovelace', shipping: 'express' });
    const outcome = await expectOutcome(page, checks);
    expect(req(outcome, 'R3').status).toBe('pass');
  });

  test('standard shipping → fail', async ({ page }) => {
    await addToCart(page, 'Blue Mug');
    await checkout(page, { name: 'Ada Lovelace', shipping: 'standard' });
    const { outcome } = await judge(page, checks);
    expect(outcome.verdict).toBe('fail');
    expect(req(outcome, 'R2').status).toBe('fail');
  });

  test('page merely claims success (spoofed heading + URL) → fail on structured evidence', async ({ page }) => {
    await addToCart(page, 'Blue Mug');
    await openCart(page);
    await page.evaluate(() => {
      history.pushState({}, '', '/orders/A9999');
      document.querySelector('main')!.innerHTML = '<h1>Order confirmed</h1><p>Shipping: Express</p>';
    });
    const { outcome } = await judge(page, checks);
    expect(req(outcome, 'R3').status).toBe('pass'); // the soft, page-level claim is fooled…
    expect(req(outcome, 'R1').status).toBe('fail'); // …the network evidence is not
    expect(outcome.verdict).toBe('fail');
  });

  test('validation error, no order → fail', async ({ page }) => {
    await addToCart(page, 'Blue Mug');
    await page.goto('/checkout');
    await ready(page);
    await page.getByRole('radio', { name: 'Express' }).check();
    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page.getByRole('alert')).toContainText('name is required');
    expect((await judge(page, checks)).outcome.verdict).toBe('fail');
  });

  test('network not recorded → abstain', async ({ page }) => {
    await addToCart(page, 'Blue Mug');
    await checkout(page, { name: 'Ada Lovelace', shipping: 'express' });
    const { outcome } = await judge(page, checks, { recorder: null });
    expect(outcome.verdict).toBe('abstain');
    expect(byId(outcome, 'C1')).toMatchObject({ status: 'abstain', reason: 'evidence_unavailable' });
  });
});

// ---------------------------------------------------------------------------
test.describe('08 delivery date (extract + date normalizer)', () => {
  const checks = loadChecks('08-delivery-date');

  test('express → 5 November 2026 → success', async ({ page }) => {
    await addToCart(page, 'Red Mug');
    await checkout(page, { name: 'Grace Hopper', shipping: 'express' });
    await expectOutcome(page, checks);
  });

  test('standard → 12 November 2026 → fail', async ({ page }) => {
    await addToCart(page, 'Red Mug');
    await checkout(page, { name: 'Grace Hopper', shipping: 'standard' });
    const { outcome } = await judge(page, checks);
    expect(byId(outcome, 'C2').status).toBe('fail');
    expect(outcome.verdict).toBe('fail');
  });

  test('date shown in another format is still read correctly (snapshot variants)', async ({ page }) => {
    await addToCart(page, 'Red Mug');
    await checkout(page, { name: 'Grace Hopper', shipping: 'express' });
    const { snapshot } = await judge(page, checks);
    const show = (s: EvidenceSnapshot, text: string) =>
      editNodes(s, { role: 'paragraph', text: { contains: 'Estimated delivery' } }, (n) => ({
        ...n,
        children: [{ role: 'text', name: text }],
      }));
    for (const t of [
      'Estimated delivery: 05/11/2026',
      'Estimated delivery: Thu, 5 Nov 2026',
      'Estimated delivery 2026-11-05',
    ])
      expect(evaluate(checks, show(snapshot, t)).verdict, t).toBe('success');
    expect(evaluate(checks, show(snapshot, 'Estimated delivery: soon')).checks[1]).toMatchObject({
      status: 'abstain',
      reason: 'normalize_failed',
    });
  });

  test('summary region unlabelled → abstain', async ({ page }) => {
    await addToCart(page, 'Red Mug');
    await checkout(page, { name: 'Grace Hopper', shipping: 'express' });
    await strip(page, '#summary', { 'aria-label': null });
    const { outcome } = await judge(page, checks);
    expect(byId(outcome, 'C2')).toMatchObject({ status: 'abstain', reason: 'anchor_missing' });
    expect(outcome.verdict).toBe('abstain');
  });
});

// ---------------------------------------------------------------------------
test.describe('09 gift wrap (request body schema + probe)', () => {
  const checks = loadChecks('09-gift-wrap');

  test('gift wrapped → success', async ({ page }) => {
    await addToCart(page, 'Green Teapot');
    await checkout(page, { name: 'Alan Turing', giftWrap: true });
    await expectOutcome(page, checks, { probes: shopProbes(page) });
  });

  test('not gift wrapped → fail', async ({ page }) => {
    await addToCart(page, 'Green Teapot');
    await checkout(page, { name: 'Alan Turing', giftWrap: false });
    const { outcome } = await judge(page, checks, { probes: shopProbes(page) });
    expect(outcome.checks.map((c) => c.status)).toEqual(['fail', 'fail']);
  });

  test('no evidence channels → abstain', async ({ page }) => {
    await addToCart(page, 'Green Teapot');
    await checkout(page, { name: 'Alan Turing', giftWrap: true });
    const { outcome } = await judge(page, checks, { recorder: null });
    expect(outcome.checks.map((c) => c.reason)).toEqual(['evidence_unavailable', 'evidence_unavailable']);
    expect(outcome.verdict).toBe('abstain');
  });
});

// ---------------------------------------------------------------------------
test.describe('10 dark theme + German (storage)', () => {
  const checks = loadChecks('10-dark-german');
  const choose = async (page: Page, label: string, option: string) => {
    await page.getByRole('combobox', { name: label }).selectOption({ label: option });
    await expect(page.getByRole('status')).toHaveText('Settings saved');
  };

  test('dark + Deutsch → success', async ({ page }) => {
    await openSettings(page);
    await choose(page, 'Theme', 'Dark');
    await choose(page, 'Language', 'Deutsch');
    await expectOutcome(page, checks);
  });

  test('only dark (partial) → fail, because an unset cookie is an observed absence', async ({ page }) => {
    await openSettings(page);
    await choose(page, 'Theme', 'Dark');
    const { outcome } = await judge(page, checks);
    expect(req(outcome, 'R1').status).toBe('pass');
    expect(req(outcome, 'R2').status).toBe('fail');
  });

  test('storage not captured → abstain', async ({ page }) => {
    await openSettings(page);
    await choose(page, 'Theme', 'Dark');
    await choose(page, 'Language', 'Deutsch');
    expect((await judge(page, checks, { storage: false })).outcome.verdict).toBe('abstain');
  });

  test('httpOnly session cookie is redacted in the snapshot', async ({ page }) => {
    await openSettings(page);
    const { snapshot } = await judge(page, checks);
    expect(snapshot.meta.redacted).toContain('cookie:sid');
    expect(snapshot.storage!.cookies.find((c) => c.name === 'sid')!.value).toEqual({ redacted: true });
  });
});
