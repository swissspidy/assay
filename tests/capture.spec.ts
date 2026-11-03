import { expect } from '@playwright/test';
import { test } from '../src/playwright/index.ts';
import { captureSnapshot, evaluate, type CheckSet, type EvidenceSnapshot } from '../src/index.ts';
import { addToCart, ready } from './helpers.ts';

test('XHR and fetch response bodies survive an immediate navigation', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.evaluate(async () => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/cart/items');
    xhr.setRequestHeader('content-type', 'application/json');
    await new Promise((r) => {
      xhr.addEventListener('load', r, { once: true });
      xhr.send(JSON.stringify({ sku: 'MUG-RED', qty: 2 }));
    });
    await fetch('/api/cart');
    location.href = '/cart';
  });
  await page.waitForURL('**/cart');
  const s = await captureSnapshot(page);
  const post = s.network!.find((e) => e.method === 'POST')!;
  expect(post.requestBody).toEqual({ sku: 'MUG-RED', qty: 2 });
  expect(post.responseBody).toMatchObject({ total: 19 });
  expect(
    s.network!.find((e) => e.method === 'GET' && e.url.endsWith('/api/cart') && e.resourceType === 'fetch')!
      .responseBody,
  ).toMatchObject({ total: 19 });
});

test('page scripts cannot forge network evidence through the tap binding', async ({ page }) => {
  await addToCart(page, 'Blue Mug');
  await page.evaluate(async () => {
    const name = Object.keys(window).find((k) => k.startsWith('__assay_'))!;
    const forged = {
      token: 'guess',
      method: 'POST',
      url: location.origin + '/api/orders',
      status: 201,
      contentType: 'application/json',
      body: '{"status":"placed"}',
      truncated: false,
    };
    await (window as unknown as Record<string, (p: unknown) => Promise<void>>)[name]!(forged);
  });
  const s = await captureSnapshot(page);
  expect(s.network!.some((e) => e.url.endsWith('/api/orders'))).toBe(false);
});

test('a response body that could not be read makes body checks abstain, not fail', async () => {
  const snap: EvidenceSnapshot = {
    schema: 'assay.snapshot/v1',
    capturedAt: '2026-11-02T00:00:00Z',
    page: { url: 'https://shop.test/orders/A1', title: '' },
    a11y: { role: 'document' },
    text: '',
    network: [
      {
        seq: 0,
        method: 'POST',
        url: 'https://shop.test/api/orders',
        resourceType: 'fetch',
        status: 201,
        requestHeaders: {},
        responseHeaders: { 'content-type': 'application/json' },
        bodyUnavailable: true,
      },
    ],
    storage: null,
    probes: {},
    meta: { capturer: 'test', redacted: [] },
  };
  const cs: CheckSet = {
    schema: 'assay.checks/v1',
    id: 't',
    version: '1',
    task: { instruction: 'Place an order.' },
    requirements: [
      { id: 'R1', kind: 'hard', text: 'order placed', source: { field: 'instruction', quote: 'place an order' } },
    ],
    checks: [
      {
        id: 'C1',
        requirement: 'R1',
        description: '',
        assert: {
          kind: 'request',
          match: {
            method: 'POST',
            url: { path: '/api/orders' },
            responseBody: { properties: { status: { const: 'placed' } } },
          },
        },
      },
      {
        id: 'C2',
        requirement: 'R1',
        description: '',
        assert: { kind: 'request', match: { method: 'POST', url: { path: '/api/orders' }, status: 201 } },
      },
      {
        id: 'C3',
        requirement: 'R1',
        description: '',
        assert: { kind: 'request', match: { method: 'DELETE' }, count: { eq: 0 } },
      },
    ],
  };
  cs.checks.forEach((c) => (c.description = c.id));
  const o = evaluate(cs, snap);
  expect(o.checks.map((c) => `${c.status}${c.reason ? '/' + c.reason : ''}`)).toEqual([
    'abstain/value_unavailable',
    'pass',
    'pass',
  ]);
});
