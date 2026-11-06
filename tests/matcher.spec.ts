/**
 * `expect(page).toHaveCompleted(task)` on the live Tiny Shop (ADR 0019): builder sets, JSON
 * sets and paths; polling; `.not`; the expected verdict; escalation; and the failure message.
 */
import { stripVTControlCharacters } from 'node:util';
import { test, expect as pwExpect } from '../src/playwright/index.ts';
import { expect } from '../src/playwright/index.ts';
import { checks, node, probe, req } from '../src/checks/index.ts';
import { addToCart, loadChecks, ready, shopProbes } from './helpers.ts';
import blueMug from './support/add-blue-mug.checks.ts';
import { call, scripted } from './support/scripted.ts';

const TS_FILE = 'tests/support/add-blue-mug.checks.ts';
const JSON_FILE = 'examples/tiny-shop/tasks/02-add-blue-mug.checks.json';

/** The failure message of an assertion that is expected to fail. */
async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return stripVTControlCharacters((e as Error).message);
  }
  throw new Error('the assertion passed');
}

test('passes for a builder set, a JSON set and a path, and attaches the outcome and snapshot', async ({
  page,
}, info) => {
  await addToCart(page, 'Blue Mug');
  const probes = shopProbes(page);
  await expect(page).toHaveCompleted(blueMug, { probes });
  await expect(page).toHaveCompleted(loadChecks('02-add-blue-mug'), { probes });
  await expect(page).toHaveCompleted(TS_FILE, { probes });
  await expect(page).toHaveCompleted(JSON_FILE, { probes });
  pwExpect(info.attachments.map((a) => a.name)).toEqual(
    pwExpect.arrayContaining([
      'assay-outcome-tiny-shop_add-blue-mug-ts.json',
      'assay-snapshot-tiny-shop_add-blue-mug-ts.json',
    ]),
  );
});

test('polls like a web-first assertion until the task is done', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const done = expect(page).toHaveCompleted(blueMug, { probes: shopProbes(page), timeout: 10_000, interval: 100 });
  await page.waitForTimeout(300);
  await addToCart(page, 'Blue Mug');
  await done;
});

test('.not and verdict: a wrong run is not completed, and is a FAIL', async ({ page }) => {
  await addToCart(page, 'Red Mug');
  const probes = shopProbes(page);
  await expect(page).not.toHaveCompleted(blueMug, { probes });
  await expect(page).toHaveCompleted(blueMug, { probes, verdict: 'fail' });
  // .not fails on a completed task, and says so.
  await addToCart(page, 'Blue Mug');
  const msg = await failure(expect(page).not.toHaveCompleted(blueMug, { probes, timeout: 0 }));
  pwExpect(msg).toContain('expect(page).not.toHaveCompleted(task)');
  pwExpect(msg).toContain('Expected verdict: not "SUCCESS"');
  pwExpect(msg).toContain('Received verdict: "SUCCESS"');
});

test('the failure message tells the story per requirement, with expected, received and the evidence', async ({
  page,
}) => {
  await addToCart(page, 'Red Mug');
  const msg = await failure(
    expect(page).toHaveCompleted(blueMug, { probes: shopProbes(page), timeout: 600, interval: 200 }),
  );
  pwExpect(msg).toContain('expect(page).toHaveCompleted(task)');
  pwExpect(msg).toContain('Task: tiny-shop/add-blue-mug-ts v1: "Add a Blue Mug to my cart."');
  pwExpect(msg).toContain('Expected verdict: "SUCCESS"');
  pwExpect(msg).toMatch(/Received verdict: "FAIL" {2}\(\d+ snapshots in \d\.\ds\)/);
  pwExpect(msg).toContain('✘ R1 [hard] The cart contains a Blue Mug: fail');
  pwExpect(msg).toContain('    ✘ C1: The backend cart has a Blue Mug line.');
  pwExpect(msg).toContain('        expected: backend probe cart at /items, {"schema":{"type":"array"');
  pwExpect(msg).toContain('        received: [{"sku":"MUG-RED","name":"Red Mug"');
  pwExpect(msg).toContain('        why: schema mismatch: data must contain at least 1 valid item(s)');
  pwExpect(msg).toContain(
    '        evidence: probe cart at /items (probe, structured) in assay-snapshot-tiny-shop_add-blue-mug-ts.json',
  );
  pwExpect(msg).toContain('    ? C2: The Blue Mug went through the cart API.');
  pwExpect(msg).toContain('        abstained: route_missing: no request matches POST');
  pwExpect(msg).toContain('✘ R2 [soft] The shop confirms the Blue Mug was added: fail');
  pwExpect(msg).toContain(
    '        expected: main contains at least 1 status with text containing "Blue Mug added to cart"',
  );
  pwExpect(msg).toContain('        received: nothing matched');
  pwExpect(msg).toContain(
    'Attached: assay-outcome-tiny-shop_add-blue-mug-ts.json, assay-snapshot-tiny-shop_add-blue-mug-ts.json',
  );
  test.info().annotations.push({ type: 'message', description: msg });
});

test('escalate: what the checks cannot decide goes to the config model once polling settles', async ({ page }) => {
  await addToCart(page, 'Blue Mug');
  // R1 reads a table that is not on this page: the checks abstain.
  const unanchored = checks({ id: 'cart-table', instruction: 'Add a Blue Mug to my cart.' }, [
    req('R1', 'The cart lists a Blue Mug', { quote: 'Add a Blue Mug' }).check(
      node('table', 'Cart').contains({ role: 'row', name: { contains: 'Blue Mug' } }),
    ),
  ]);
  const abstains = await failure(expect(page).toHaveCompleted(unanchored, { timeout: 0, config: false }));
  pwExpect(abstains).toContain('Received verdict: "ABSTAIN"');
  pwExpect(abstains).toContain('? R1 [hard] The cart lists a Blue Mug: abstain (anchor_missing)');

  const model = scripted([
    () => call('page_outline', {}),
    () =>
      call('submit_verdict', {
        verdicts: [{ requirement: 'R1', status: 'pass', cites: [1], reasoning: 'the status says it was added' }],
      }),
  ]);
  await expect(page).toHaveCompleted(unanchored, { timeout: 0, escalate: true, config: { model } });
  pwExpect(model.requests.length).toBe(2);
  // Without a model, escalation says what it needs.
  pwExpect(await failure(expect(page).toHaveCompleted(unanchored, { timeout: 0, escalate: true, config: {} }))).toMatch(
    /needs a model/,
  );
});

test('a check set that does not load or is invalid is an error, not a verdict', async ({ page }) => {
  await page.goto('/');
  pwExpect(await failure(expect(page).toHaveCompleted('tests/support/missing.checks.ts'))).toContain(
    'check set not found: ',
  );
  const bad = { ...blueMug, requirements: [] };
  pwExpect(await failure(expect(page).toHaveCompleted(bad))).toContain('requirements');
  // A builder value that is not a complete set is caught by validation too.
  pwExpect(await failure(expect(page).toHaveCompleted(probe('cart') as never))).toMatch(/invalid check set|must have/);
});
