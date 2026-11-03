/**
 * Tiny Shop tasks and scripted trajectories. Each scenario is a labelled run:
 * `success` runs complete the task; `fail` runs are near misses (wrong item,
 * partial or over-completion, a page that only claims success).
 * Used by the M1 tests, reference capture (compiler input) and evaluation.
 */
import type { Page } from './deps.ts';
import {
  addToCart,
  checkout,
  choose,
  openCart,
  openSettings,
  ready,
  removeFromCart,
  setNewsletter,
  setQuantity,
} from './agent.ts';

export type ScenarioKind =
  | 'correct'
  | 'wrong-item'
  | 'partial'
  | 'over-completion'
  | 'no-op'
  | 'adversarial'
  | 'undone';

export interface Scenario {
  name: string;
  expected: 'success' | 'fail';
  kind: ScenarioKind;
  run(page: Page): Promise<void>;
}

export interface TaskDef {
  /** File stem under tasks/ (handwritten check set, also the task text). */
  id: string;
  /** Probes the task's checks may use. */
  probes: ('cart' | 'latestOrder')[];
  /** Generic stress variants that do not apply to this task (see src/stress/variants.ts). */
  skipVariants?: string[];
  scenarios: Scenario[];
}

const ok = (name: string, run: (page: Page) => Promise<void>): Scenario => ({
  name,
  expected: 'success',
  kind: 'correct',
  run,
});
const bad = (name: string, kind: ScenarioKind, run: (page: Page) => Promise<void>): Scenario => ({
  name,
  expected: 'fail',
  kind,
  run,
});

const twoMugsInCart = async (page: Page) => {
  await addToCart(page, 'Blue Mug');
  await addToCart(page, 'Red Mug');
  await openCart(page);
};

/** The page claims an order was placed although none was. */
const spoofOrder = async (page: Page) => {
  await addToCart(page, 'Blue Mug');
  await openCart(page);
  await page.evaluate(() => {
    history.pushState({}, '', '/orders/A9999');
    document.querySelector('main')!.innerHTML =
      '<h1>Order confirmed</h1><section aria-label="Order summary"><p>Order number: A9999</p>' +
      '<p>Shipping: Express, gift wrapped</p><p>Estimated delivery: 5 November 2026</p></section>';
  });
};

export const TASKS: TaskDef[] = [
  {
    id: '01-newsletter',
    probes: [],
    scenarios: [
      ok('subscribed', async (p) => {
        await openSettings(p);
        await setNewsletter(p, true);
      }),
      ok('subscribed-and-dark-theme', async (p) => {
        await openSettings(p);
        await choose(p, 'Theme', 'Dark');
        await setNewsletter(p, true);
      }),
      bad('never-subscribed', 'no-op', openSettings),
      bad('subscribed-then-unsubscribed', 'undone', async (p) => {
        await openSettings(p);
        await setNewsletter(p, true);
        await setNewsletter(p, false);
      }),
    ],
  },
  {
    id: '02-add-blue-mug',
    probes: ['cart'],
    scenarios: [
      ok('added-blue-mug', (p) => addToCart(p, 'Blue Mug')),
      ok('added-blue-and-red-mug', async (p) => {
        await addToCart(p, 'Red Mug');
        await addToCart(p, 'Blue Mug');
      }),
      bad('added-red-mug', 'wrong-item', (p) => addToCart(p, 'Red Mug')),
    ],
  },
  {
    id: '03-cart-two-mugs',
    probes: [],
    scenarios: [
      ok('both-mugs', twoMugsInCart),
      ok('both-mugs-and-teapot', async (p) => {
        await addToCart(p, 'Blue Mug');
        await addToCart(p, 'Red Mug');
        await addToCart(p, 'Green Teapot');
        await openCart(p);
      }),
      bad('only-blue-mug', 'partial', async (p) => {
        await addToCart(p, 'Blue Mug');
        await openCart(p);
      }),
    ],
  },
  {
    id: '04-remove-red-mug',
    probes: ['cart'],
    scenarios: [
      ok('removed-red-mug', async (p) => {
        await twoMugsInCart(p);
        await removeFromCart(p, 'Red Mug');
      }),
      ok('removed-red-mug-keeping-teapot', async (p) => {
        await addToCart(p, 'Green Teapot');
        await twoMugsInCart(p);
        await removeFromCart(p, 'Red Mug');
      }),
      bad('removed-blue-mug', 'wrong-item', async (p) => {
        await twoMugsInCart(p);
        await removeFromCart(p, 'Blue Mug');
      }),
      bad('emptied-cart', 'over-completion', async (p) => {
        await twoMugsInCart(p);
        await removeFromCart(p, 'Red Mug');
        await removeFromCart(p, 'Blue Mug');
      }),
    ],
  },
  {
    id: '05-set-quantity',
    probes: [],
    scenarios: [
      ok('quantity-3', async (p) => {
        await addToCart(p, 'Blue Mug');
        await openCart(p);
        await setQuantity(p, 'Blue Mug', 3);
      }),
      ok('quantity-2-then-3', async (p) => {
        await addToCart(p, 'Blue Mug');
        await openCart(p);
        await setQuantity(p, 'Blue Mug', 2);
        await setQuantity(p, 'Blue Mug', 3);
      }),
      bad('quantity-2', 'wrong-item', async (p) => {
        await addToCart(p, 'Blue Mug');
        await openCart(p);
        await setQuantity(p, 'Blue Mug', 2);
      }),
    ],
  },
  {
    id: '06-cart-total',
    probes: [],
    scenarios: [
      ok('blue-and-red', twoMugsInCart),
      ok('red-then-blue', async (p) => {
        await addToCart(p, 'Red Mug');
        await addToCart(p, 'Blue Mug');
        await openCart(p);
      }),
      bad('blue-and-teapot', 'wrong-item', async (p) => {
        await addToCart(p, 'Blue Mug');
        await addToCart(p, 'Green Teapot');
        await openCart(p);
      }),
    ],
  },
  {
    id: '07-express-order',
    probes: [],
    scenarios: [
      ok('express-order', async (p) => {
        await addToCart(p, 'Blue Mug');
        await checkout(p, { name: 'Ada Lovelace', shipping: 'express' });
      }),
      ok('express-gift-wrapped', async (p) => {
        await addToCart(p, 'Blue Mug');
        await checkout(p, { name: 'Ada Lovelace', shipping: 'express', giftWrap: true });
      }),
      bad('standard-order', 'wrong-item', async (p) => {
        await addToCart(p, 'Blue Mug');
        await checkout(p, { name: 'Ada Lovelace', shipping: 'standard' });
      }),
      bad('spoofed-confirmation', 'adversarial', spoofOrder),
      bad('validation-error', 'partial', async (p) => {
        await addToCart(p, 'Blue Mug');
        await p.goto('/checkout');
        await ready(p);
        await p.getByRole('radio', { name: 'Express' }).check();
        await p.getByRole('button', { name: 'Place order' }).click();
        await p.getByRole('alert').filter({ hasText: 'name is required' }).waitFor();
      }),
    ],
  },
  {
    id: '08-delivery-date',
    probes: [],
    scenarios: [
      ok('express-order', async (p) => {
        await addToCart(p, 'Red Mug');
        await checkout(p, { name: 'Grace Hopper', shipping: 'express' });
      }),
      ok('express-two-items', async (p) => {
        await addToCart(p, 'Red Mug');
        await addToCart(p, 'Green Teapot');
        await checkout(p, { name: 'Grace Hopper', shipping: 'express' });
      }),
      bad('standard-order', 'wrong-item', async (p) => {
        await addToCart(p, 'Red Mug');
        await checkout(p, { name: 'Grace Hopper', shipping: 'standard' });
      }),
      bad('spoofed-confirmation', 'adversarial', spoofOrder),
    ],
  },
  {
    id: '09-gift-wrap',
    probes: ['latestOrder'],
    scenarios: [
      ok('gift-wrapped', async (p) => {
        await addToCart(p, 'Green Teapot');
        await checkout(p, { name: 'Alan Turing', giftWrap: true });
      }),
      ok('gift-wrapped-express', async (p) => {
        await addToCart(p, 'Green Teapot');
        await checkout(p, { name: 'Alan Turing', giftWrap: true, shipping: 'express' });
      }),
      bad('not-gift-wrapped', 'partial', async (p) => {
        await addToCart(p, 'Green Teapot');
        await checkout(p, { name: 'Alan Turing' });
      }),
      bad('spoofed-confirmation', 'adversarial', spoofOrder),
    ],
  },
  {
    id: '10-dark-german',
    probes: [],
    scenarios: [
      ok('dark-and-german', async (p) => {
        await openSettings(p);
        await choose(p, 'Theme', 'Dark');
        await choose(p, 'Language', 'Deutsch');
      }),
      ok('german-then-dark', async (p) => {
        await openSettings(p);
        await choose(p, 'Language', 'Deutsch');
        await choose(p, 'Theme', 'Dark');
      }),
      bad('only-dark', 'partial', async (p) => {
        await openSettings(p);
        await choose(p, 'Theme', 'Dark');
      }),
      bad('german-light', 'partial', async (p) => {
        await openSettings(p);
        await choose(p, 'Language', 'Deutsch');
      }),
    ],
  },
];
