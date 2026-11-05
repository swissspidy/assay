/** Every open page of the context in the snapshot, and `page` assertions (ADR 0012). */
import { expect } from '@playwright/test';
import { captureSnapshot, test } from '../src/playwright/index.ts';
import { readOtherPage } from '../src/snapshot/capture.ts';
import {
  evaluate,
  loadSnapshot,
  reviewSheet,
  validateCheckSet,
  type Assertion,
  type CheckSet,
  type EvidenceSnapshot,
} from '../src/index.ts';
import { judge } from './helpers.ts';
import { startSites, type Site } from './support/sites.ts';

let app: Site;
let other: Site;
test.beforeAll(async () => ({ app, other } = await startSites()));
test.afterAll(async () => {
  await app.close();
  await other.close();
});

const checks = (assertions: Assertion[]): CheckSet => ({
  schema: 'assay.checks/v1',
  id: 'pages',
  version: '1',
  task: { instruction: 'Pay and keep the receipt.' },
  requirements: [{ id: 'R1', kind: 'hard', text: 'paid', source: { field: 'instruction', quote: 'Pay' } }],
  checks: assertions.map((assert, i) => ({ id: `C${i + 1}`, requirement: 'R1', description: 'd', assert })),
});

const paid: Assertion = {
  kind: 'state',
  target: { role: 'status' },
  expect: { text: { contains: 'Paid US$21.50' } },
};

test('a tab the page opened becomes the active page; the opener is kept in pages', async ({ page }) => {
  await page.goto(`${app.origin}/popup`);
  const [tab] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('link', { name: 'Open receipt' }).click(),
  ]);
  await tab.waitForLoadState();
  const s = await captureSnapshot(page);
  expect(s.page).toEqual({ url: `${app.origin}/receipt`, title: 'Receipt' });
  expect(s.pages!.map((p) => p.url)).toEqual([`${app.origin}/popup`]);
  expect(s.pages![0]!.text).toContain('Checkout');

  const cs = checks([
    paid,
    { kind: 'url', match: { path: '/receipt' } },
    // The checkout page is still open: select it by URL or title.
    {
      kind: 'page',
      match: { url: { path: '/popup' } },
      assert: { kind: 'contains', match: { role: 'link', name: 'Open receipt' } },
    },
    { kind: 'page', match: { title: 'Checkout' }, assert: { kind: 'url', match: { path: '/popup' } } },
    // The active page can be selected too.
    { kind: 'page', match: { title: { contains: 'Receipt' } }, assert: paid },
  ]);
  const { outcome } = await judge(page, cs);
  expect(outcome.checks.map((c) => c.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass']);
  expect(outcome.checks[2]!.message).toMatch(/^on page http:\/\/localhost:\d+\/popup: 1 × link/);

  // `pages: false`: only the page given, as before.
  const one = await captureSnapshot(page, { pages: false });
  expect(one.page.url).toBe(`${app.origin}/popup`);
  expect(one.pages).toBeUndefined();
});

test('a page the test opens itself does not take over; a closed popup is gone', async ({ page, context }) => {
  await page.goto(`${app.origin}/popup`);
  const [help] = await Promise.all([page.waitForEvent('popup'), page.getByRole('button', { name: 'Help' }).click()]);
  await help.waitForLoadState();
  const admin = await context.newPage();
  await admin.goto(`${app.origin}/receipt`);
  let s = await captureSnapshot(page);
  // The help popup opened after the checkout page navigated; the test's own page is not the agent's.
  expect(s.page.url).toBe(`${app.origin}/help`);
  expect(s.pages!.map((p) => p.url)).toEqual([`${app.origin}/popup`, `${app.origin}/receipt`]);

  // A navigation makes a page active again.
  await page.goto(`${app.origin}/popup?again=1`);
  s = await captureSnapshot(page);
  expect(s.page.url).toBe(`${app.origin}/popup?again=1`);

  await help.close();
  await admin.close();
  s = await captureSnapshot(page);
  expect(s.pages).toBeUndefined();
});

test('a page that cannot be read is unavailable within the time limit, and keeps its title', async ({ context }) => {
  const old = await context.newPage();
  await old.goto(`${app.origin}/frameset`); // no body to snapshot
  const busy = await context.newPage();
  await busy.goto(`${other.origin}/busy`);
  await busy.waitForTimeout(200); // its main thread is now stuck
  let t = Date.now();
  const v = await readOtherPage(old, true, 800);
  expect(Date.now() - t).toBeLessThan(2000);
  expect(v).toMatchObject({ url: `${app.origin}/frameset`, title: 'Old frames', text: '', unavailable: true });
  t = Date.now();
  expect(await readOtherPage(busy, true, 800)).toMatchObject({ unavailable: true });
  expect(Date.now() - t).toBeLessThan(2000);
  // Selected by its title, the unreadable page abstains as unreadable, not as missing.
  const r = evaluate(checks([{ kind: 'page', match: { title: 'Old frames' }, assert: paid }]), snap([v])).checks[0]!;
  expect(r.reason).toBe('evidence_unavailable');
  await busy.close({ runBeforeUnload: false });
});

const snap = (pages: EvidenceSnapshot['pages']): EvidenceSnapshot => ({
  schema: 'assay.snapshot/v1',
  capturedAt: '2026-11-05T00:00:00Z',
  page: { url: 'https://shop.test/checkout', title: 'Checkout' },
  a11y: { role: 'document', children: [{ role: 'heading', name: 'Checkout', level: 1 }] },
  text: 'Checkout',
  network: [],
  storage: null,
  probes: {},
  ...(pages ? { pages } : {}),
  meta: { capturer: 'test', redacted: [] },
});

const receipt = (url = 'https://shop.test/receipt') => ({
  url,
  title: 'Receipt',
  a11y: { role: 'document', children: [{ role: 'status', children: [{ role: 'text', name: 'Paid US$21.50' }] }] },
  text: 'Paid US$21.50',
});

test('page assertions: missing, ambiguous and unreadable pages abstain; a wrong page fails', () => {
  const onReceipt = (assert: Assertion): CheckSet =>
    checks([{ kind: 'page', match: { url: { path: '/receipt' } }, assert }]);
  const status = (cs: CheckSet, s: EvidenceSnapshot) => {
    const c = evaluate(cs, s).checks[0]!;
    return `${c.status}${c.reason ? '/' + c.reason : ''}`;
  };
  expect(status(onReceipt(paid), snap([receipt()]))).toBe('pass');
  // A snapshot from before pages were captured: only the active page can be selected.
  expect(status(onReceipt(paid), snap(undefined))).toBe('abstain/anchor_missing');
  expect(status(onReceipt(paid), snap([receipt(), receipt('https://shop.test/receipt?copy=1')]))).toBe(
    'abstain/anchor_ambiguous',
  );
  expect(
    status(onReceipt(paid), snap([{ ...receipt(), a11y: { role: 'document' }, text: '', unavailable: true }])),
  ).toBe('abstain/evidence_unavailable');
  expect(
    status(onReceipt({ ...paid, expect: { text: { contains: 'Paid US$99.00' } } } as Assertion), snap([receipt()])),
  ).toBe('fail');
  // Text and URL sources read the selected page.
  const text = checks([
    {
      kind: 'page',
      match: { title: 'Receipt' },
      assert: {
        kind: 'allOf',
        of: [
          { kind: 'value', source: { from: 'text', pattern: 'Paid (\\S+)' }, expect: { equals: 'US$21.50' } },
          { kind: 'value', source: { from: 'url', part: 'pathname' }, expect: { equals: '/receipt' } },
        ],
      },
    },
  ]);
  expect(status(text, snap([receipt()]))).toBe('pass');
});

test('with onMissing "abstain", a page the run never opened is a route not taken (ADR 0011)', () => {
  const receiptUrl: Assertion = {
    kind: 'page',
    match: { title: 'Receipt' },
    assert: { kind: 'url', match: { path: '/receipt' } },
  };
  const cs = (onMissing?: 'abstain') => {
    const c = checks([receiptUrl]);
    if (onMissing) c.checks[0]!.onMissing = onMissing;
    return c;
  };
  const reason = (c: CheckSet, s: EvidenceSnapshot) => evaluate(c, s).checks[0]!.reason;
  expect(reason(cs(), snap(undefined))).toBe('anchor_missing');
  expect(reason(cs('abstain'), snap(undefined))).toBe('route_missing');
  // The route lives inside the page: a url check there is route evidence, so onMissing applies.
  expect(validateCheckSet(cs('abstain')).warnings.join()).not.toMatch(/onMissing "abstain" has no effect/);
  // Selected and on the wrong path: still decided (and route_missing again for a path elsewhere).
  expect(evaluate(cs('abstain'), snap([receipt()])).checks[0]!.status).toBe('pass');
  expect(reason(cs('abstain'), snap([receipt('https://shop.test/orders')]))).toBe('route_missing');
});

test('the validator keeps page assertions to what a page shows', () => {
  const errors = (a: Assertion) => validateCheckSet(checks([a])).errors;
  const on = (assert: Assertion): Assertion => ({ kind: 'page', match: { title: 'Receipt' }, assert });
  expect(errors(on(paid))).toEqual([]);
  expect(errors(on({ kind: 'request', match: { method: 'POST' } })).join()).toMatch(/does not read the page/);
  expect(
    errors(on({ kind: 'value', source: { from: 'probe', probe: 'orders' }, expect: { exists: true } })).join(),
  ).toMatch(/a probe source inside a page assertion/);
  expect(errors(on(on(paid))).join()).toMatch(/inside another page assertion/);
  expect(
    errors({ kind: 'each', scope: { role: 'list' }, match: { role: 'listitem' }, assert: on(paid) }).join(),
  ).toMatch(/cannot be inside each/);
  // At least one of url and title.
  expect(errors({ kind: 'page', match: {}, assert: paid } as Assertion).length).toBeGreaterThan(0);
  expect(reviewSheet(checks([on(paid)]))).toContain('on the one open page (tab or popup) with title "Receipt"');
});

test('the loader checks other pages; snapshots without them load unchanged', () => {
  const s = snap([receipt()]);
  expect(loadSnapshot(JSON.stringify(s))).toEqual(s);
  expect(loadSnapshot(JSON.stringify(snap(undefined))).pages).toBeUndefined();
  expect(() => loadSnapshot({ ...s, pages: [{ url: 'x' }] })).toThrow(/pages\[0\] is not a page/);
  expect(() => loadSnapshot({ ...s, pages: [{ ...receipt(), unavailable: 'false' }] })).toThrow(
    /pages\[0\]\.unavailable must be true or absent/,
  );
  expect(loadSnapshot({ ...s, pages: [{ ...receipt(), unavailable: true }] }).pages![0]!.unavailable).toBe(true);
  expect(() => loadSnapshot({ ...s, pages: [{ ...receipt(), a11y: { children: [] } }] })).toThrow(
    /pages\[0\]\.a11y\.role/,
  );
});
