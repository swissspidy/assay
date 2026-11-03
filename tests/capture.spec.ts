import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
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
    // A URL only this request uses: bodies of repeated same-URL requests are only
    // filled from the page tap when the pairing is unambiguous (see settle()).
    await fetch('/api/cart?after=post');
    location.href = '/cart';
  });
  await page.waitForURL('**/cart');
  const s = await captureSnapshot(page);
  const post = s.network!.find((e) => e.method === 'POST')!;
  expect(post.requestBody).toEqual({ sku: 'MUG-RED', qty: 2 });
  expect(post.responseBody).toMatchObject({ total: 19 });
  expect(
    s.network!.find((e) => e.method === 'GET' && e.url.endsWith('/api/cart?after=post'))!.responseBody,
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

test.describe('a response body that never finishes', () => {
  test.use({ evidenceOptions: { bodyTimeoutMs: 300 } });

  test('does not hang capture: the read times out and the body is marked unavailable', async ({ page }) => {
    // A server whose /stall response sends its headers and a first chunk, then never ends.
    const open = new Set<ServerResponse>();
    const server = createServer((req, res) => {
      if (req.url === '/stall') {
        open.add(res);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"partial":');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>stall</title><main>stall</main>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as AddressInfo;
      await page.goto(`http://127.0.0.1:${port}/`);
      const response = page.waitForResponse('**/stall');
      await page.evaluate(() => {
        void fetch('/stall').catch(() => {});
      });
      await response;
      const t0 = Date.now();
      const s = await captureSnapshot(page);
      // Below the 3000 ms default, so the test also fails if the option were ignored.
      expect(Date.now() - t0).toBeLessThan(2000);
      const stalled = s.network!.find((e) => e.url.endsWith('/stall'))!;
      expect(stalled.status).toBe(200);
      expect(stalled.responseBody).toBeUndefined();
      expect(stalled.bodyUnavailable).toBe(true);
    } finally {
      for (const res of open) res.destroy();
      await new Promise((r) => server.close(r));
    }
  });
});

test('a failed request never receives the body of a later request to the same URL', async ({ page, evidence }) => {
  // /item: the first request is held until the client aborts it; the second succeeds.
  let first = true;
  let received!: () => void;
  const gotFirst = new Promise<void>((r) => (received = r));
  const server = createServer((req, res) => {
    if (req.url === '/item') {
      if (first) {
        first = false;
        received();
        return; // never answered: the client aborts it
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"n":2}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>items</title><main>items</main>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address() as AddressInfo;
    await page.goto(`http://127.0.0.1:${port}/`);
    const failed = page.waitForEvent('requestfailed');
    await page.evaluate(() => {
      const c = new AbortController();
      (window as unknown as { abortFirst: () => void }).abortFirst = () => c.abort();
      void fetch('/item', { signal: c.signal }).catch(() => {});
    });
    await gotFirst;
    await page.evaluate(() => (window as unknown as { abortFirst: () => void }).abortFirst());
    await failed;
    await page.evaluate(() => fetch('/item').then((r) => r.text()));
    // The second response's body has reached the recorder through the page tap.
    await expect.poll(() => evidence.tappedCount()).toBeGreaterThan(0);
    const s = await captureSnapshot(page);
    const items = s.network!.filter((e) => e.url.endsWith('/item'));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ status: null, failure: expect.any(String) });
    expect(items[0]!.responseBody).toBeUndefined();
    expect(items[1]).toMatchObject({ status: 200, responseBody: { n: 2 } });
  } finally {
    await new Promise((r) => server.close(r));
  }
});
