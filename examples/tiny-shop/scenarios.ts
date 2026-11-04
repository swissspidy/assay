/**
 * Tiny Shop tasks and scripted trajectories. Each scenario is a labelled run:
 * `success` runs complete the task; `fail` runs are near misses (wrong item,
 * partial or over-completion, a page that only claims success).
 * Used by the M1 tests, reference capture (compiler input) and evaluation.
 */
import type { Page } from './deps.ts';
import { bad, ok, type TaskDef } from '../lib/scenario.ts';
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

export type { Scenario, ScenarioKind, TaskDef } from '../lib/scenario.ts';

const twoMugsInCart = async (page: Page) => {
  await addToCart(page, 'Blue Mug');
  await addToCart(page, 'Red Mug');
  await openCart(page);
};

/** In the cart, the page claims an order was placed although none was. */
const spoofConfirmation = async (page: Page) => {
  await openCart(page);
  await page.evaluate(() => {
    history.pushState({}, '', '/orders/A9999');
    document.querySelector('main')!.innerHTML =
      '<h1>Order confirmed</h1><section aria-label="Order summary"><p>Order number: A9999</p>' +
      '<p>Shipping: Express, gift wrapped</p><p>Estimated delivery: 5 November 2026</p></section>';
  });
};

const spoofOrder = async (page: Page) => {
  await addToCart(page, 'Blue Mug');
  await spoofConfirmation(page);
};

/** A cart that already holds these products when the task starts (scenario setup). */
const cartWith =
  (...products: string[]) =>
  async (page: Page) => {
    for (const p of products) await addToCart(page, p);
    await openCart(page);
  };

export const TASKS: TaskDef[] = [
  {
    id: '01-newsletter',
    probes: ['settings'],
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
      ok('removed-red-mug', (p) => removeFromCart(p, 'Red Mug'), cartWith('Blue Mug', 'Red Mug')),
      ok(
        'removed-red-mug-keeping-teapot',
        (p) => removeFromCart(p, 'Red Mug'),
        cartWith('Green Teapot', 'Blue Mug', 'Red Mug'),
      ),
      bad('removed-blue-mug', 'wrong-item', (p) => removeFromCart(p, 'Blue Mug'), cartWith('Blue Mug', 'Red Mug')),
      bad(
        'emptied-cart',
        'over-completion',
        async (p) => {
          await removeFromCart(p, 'Red Mug');
          await removeFromCart(p, 'Blue Mug');
        },
        cartWith('Blue Mug', 'Red Mug'),
      ),
      // Only the state before the task shows the Teapot was there to keep.
      bad(
        'removed-red-mug-and-teapot',
        'over-completion',
        async (p) => {
          await removeFromCart(p, 'Red Mug');
          await removeFromCart(p, 'Green Teapot');
        },
        cartWith('Green Teapot', 'Blue Mug', 'Red Mug'),
      ),
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
    probes: ['cart'],
    scenarios: [
      ok('express-order', (p) => checkout(p, { name: 'Ada Lovelace', shipping: 'express' }), cartWith('Blue Mug')),
      ok(
        'express-gift-wrapped',
        (p) => checkout(p, { name: 'Ada Lovelace', shipping: 'express', giftWrap: true }),
        cartWith('Blue Mug'),
      ),
      bad(
        'standard-order',
        'wrong-item',
        (p) => checkout(p, { name: 'Ada Lovelace', shipping: 'standard' }),
        cartWith('Blue Mug'),
      ),
      bad('spoofed-confirmation', 'adversarial', spoofConfirmation, cartWith('Blue Mug')),
      bad(
        'validation-error',
        'partial',
        async (p) => {
          await p.goto('/checkout');
          await ready(p);
          await p.getByRole('radio', { name: 'Express' }).check();
          await p.getByRole('button', { name: /Place order|Buy now/ }).click();
          await p.getByRole('alert').filter({ hasText: 'name is required' }).waitFor();
        },
        cartWith('Blue Mug'),
      ),
      // The order is not what was in the cart: the agent added an item first.
      bad(
        'ordered-extra-item',
        'over-completion',
        async (p) => {
          await addToCart(p, 'Red Mug');
          await checkout(p, { name: 'Ada Lovelace', shipping: 'express' });
        },
        cartWith('Blue Mug'),
      ),
    ],
  },
  {
    id: '08-delivery-date',
    probes: ['cart'],
    scenarios: [
      ok('express-order', (p) => checkout(p, { name: 'Grace Hopper', shipping: 'express' }), cartWith('Red Mug')),
      ok(
        'express-two-items',
        (p) => checkout(p, { name: 'Grace Hopper', shipping: 'express' }),
        cartWith('Red Mug', 'Green Teapot'),
      ),
      bad(
        'standard-order',
        'wrong-item',
        (p) => checkout(p, { name: 'Grace Hopper', shipping: 'standard' }),
        cartWith('Red Mug'),
      ),
      bad('spoofed-confirmation', 'adversarial', spoofConfirmation, cartWith('Red Mug')),
      // The agent removed an item before ordering: the order is not the cart it started with.
      bad(
        'ordered-part-of-cart',
        'partial',
        async (p) => {
          await removeFromCart(p, 'Green Teapot');
          await checkout(p, { name: 'Grace Hopper', shipping: 'express' });
        },
        cartWith('Red Mug', 'Green Teapot'),
      ),
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
