import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from '@playwright/test';
import { captureBaseline, captureSnapshot, EvidenceRecorder, test } from '../src/playwright/index.ts';
import { evaluate, type CheckSet, type EvidenceSnapshot } from '../src/index.ts';
import { cutUtf8 } from '../src/snapshot/capture.ts';
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
    // Navigate one task later, so this evaluate returns before the page unloads.
    setTimeout(() => (location.href = '/cart'), 0);
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

/** A local server for one test; `handle` serves everything except `/`, which is an empty page. */
async function withServer(
  handle: (req: IncomingMessage, res: ServerResponse) => boolean,
  run: (origin: string, open: Set<ServerResponse>) => Promise<void>,
): Promise<void> {
  const open = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    if (req.url !== '/' && handle(req, res)) return;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>t</title><main>t</main>');
  });
  server.on('request', (_req, res) => open.add(res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, open);
  } finally {
    for (const res of open) res.destroy();
    await new Promise((r) => server.close(r));
  }
}

test('a streaming response without a length is not held up by the tap', async ({ page }) => {
  // /stream sends one NDJSON line and never ends.
  await withServer(
    (req, res) => {
      if (req.url !== '/stream') return false;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write('{"n":1}\n');
      return true;
    },
    async (origin) => {
      await page.goto(`${origin}/`);
      const ms = await page.evaluate(async () => {
        const t0 = performance.now();
        const res = await fetch('/stream');
        const first = await res.body!.getReader().read();
        if (!first.value) throw new Error('no first chunk');
        return performance.now() - t0;
      });
      // The tap holds a response for at most 500 ms (WAIT in pageTap); the rest is overhead.
      expect(ms).toBeLessThan(1500);
      await captureSnapshot(page); // and capture still completes
    },
  );
});

test('a reused XHR reports each response once, so its failed first request gets no body', async ({ page }) => {
  let first = true;
  let received!: () => void;
  const gotFirst = new Promise<void>((r) => (received = r));
  await withServer(
    (req, res) => {
      if (req.url !== '/item') return false;
      if (first) {
        first = false;
        received();
        return true; // held until aborted
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"n":2}');
      return true;
    },
    async (origin) => {
      await page.goto(`${origin}/`);
      const failed = page.waitForEvent('requestfailed');
      await page.evaluate(() => {
        const x = new XMLHttpRequest();
        (window as unknown as { xhr: XMLHttpRequest }).xhr = x;
        x.open('GET', '/item');
        x.send();
      });
      await gotFirst;
      await page.evaluate(() => (window as unknown as { xhr: XMLHttpRequest }).xhr.abort());
      await failed;
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            const x = (window as unknown as { xhr: XMLHttpRequest }).xhr;
            x.addEventListener('load', resolve, { once: true });
            x.open('GET', '/item');
            x.send();
          }),
      );
      // Exactly one tapped body: the reused XHR reported its one response once.
      await expect.poll(() => EvidenceRecorder.for(page.context())?.tappedCount()).toBe(1);
      const s = await captureSnapshot(page);
      const items = s.network!.filter((e) => e.url.endsWith('/item'));
      expect(items).toHaveLength(2);
      expect(items[0]!.failure).toBeDefined();
      expect(items[0]!.responseBody).toBeUndefined();
      expect(items[1]).toMatchObject({ status: 200, responseBody: { n: 2 } });
    },
  );
});

test('cutUtf8 counts bytes and never splits a character', () => {
  expect(cutUtf8('abc', 3)).toBeUndefined();
  expect(cutUtf8('aé', 2)).toBe('a'); // é is two bytes: half of it is dropped
  expect(cutUtf8('ééé', 4)).toBe('éé');
  expect(cutUtf8('😀x', 3)).toBe('');
  expect(cutUtf8('ab', -5)).toBe(''); // a negative limit keeps nothing
});

test.describe('body limit', () => {
  test.use({ evidenceOptions: { maxBodyBytes: 10 } });

  test('is counted in UTF-8 bytes for request and response bodies', async ({ page }) => {
    await withServer(
      (req, res) => {
        if (req.url !== '/text') return false;
        req.resume();
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('é'.repeat(7)); // 14 bytes, 7 characters
        return true;
      },
      async (origin) => {
        await page.goto(`${origin}/`);
        await page.evaluate(() => fetch('/text').then((r) => r.text()));
        await page.evaluate(() =>
          fetch('/text', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'ü'.repeat(6) }),
        );
        const s = await captureSnapshot(page);
        const [get, post] = s.network!.filter((x) => x.url.endsWith('/text'));
        expect(get!.responseBody).toBe('ééééé'); // 10 bytes
        expect(get!.bodyTruncated).toBe(true);
        expect(post!.requestBody).toBe('üüüüü'); // 12 bytes sent, 10 kept
        expect(post!.bodyTruncated).toBe(true);
      },
    );
  });
});

test('credential-like storage keys and cookie names are redacted; checks on them abstain', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.evaluate(() => {
    localStorage.setItem('authToken', 'eyJhbGciOi.secret');
    sessionStorage.setItem('sessionToken', 'sess.secret');
    localStorage.setItem('theme', 'dark');
    document.cookie = 'session_id=abc123; path=/';
  });
  const s = await captureSnapshot(page);
  const local = Object.values(s.storage!.local)[0]!;
  expect(local.authToken).toEqual({ redacted: true });
  expect(local.theme).toBe('dark');
  expect(s.storage!.cookies.find((c) => c.name === 'session_id')!.value).toEqual({ redacted: true });
  expect(Object.values(s.storage!.session)[0]!.sessionToken).toEqual({ redacted: true });
  expect(s.meta.redacted).toEqual(
    expect.arrayContaining(['localStorage:authToken', 'sessionStorage:sessionToken', 'cookie:session_id']),
  );
  expect(JSON.stringify(s)).not.toContain('sess.secret');
  expect(JSON.stringify(s)).not.toContain('eyJhbGciOi');
  const check = (key: string): CheckSet => ({
    schema: 'assay.checks/v1',
    id: 't',
    version: '1',
    task: { instruction: 'Set it.' },
    requirements: [{ id: 'R1', kind: 'hard', text: 'set', source: { field: 'instruction', quote: 'Set it' } }],
    checks: [
      {
        id: 'C1',
        requirement: 'R1',
        description: key,
        assert: { kind: 'value', source: { from: 'storage', area: 'local', key }, expect: { equals: 'dark' } },
      },
    ],
  });
  expect(evaluate(check('theme'), s).verdict).toBe('success');
  expect(evaluate(check('authToken'), s).checks[0]).toMatchObject({
    status: 'abstain',
    reason: 'evidence_unavailable',
  });
  // keepStorage keeps a named key readable.
  const kept = await captureSnapshot(page, { keepStorage: ['authToken'] });
  expect(Object.values(kept.storage!.local)[0]!.authToken).toBe('eyJhbGciOi.secret');
});

test('a baseline captured before the agent acts joins later snapshots of the context', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await page.evaluate(() => localStorage.setItem('theme', 'light'));
  await addToCart(page, 'Blue Mug');
  const cart = async () => (await page.request.get('/api/cart')).json();
  const baseline = await captureBaseline(page, { probes: { cart } });
  expect(baseline.url).toMatch(/\/$/);
  expect(baseline.probes.cart).toMatchObject({ ok: true, value: { items: [{ name: 'Blue Mug' }] } });
  expect(Object.values(baseline.storage!.local)[0]!.theme).toBe('light');
  expect(baseline.redacted).toContain('cookie:sid'); // httpOnly, as in snapshots

  await addToCart(page, 'Red Mug');
  await page.evaluate(() => localStorage.setItem('theme', 'dark'));
  const s = await captureSnapshot(page, { probes: { cart } });
  expect(s.baseline).toEqual(baseline);
  expect(s.probes.cart).toMatchObject({ ok: true, value: { items: [{}, {}] } });
  // Leave it out, or pass another one.
  expect((await captureSnapshot(page, { baseline: null })).baseline).toBeUndefined();
  const other = { ...baseline, probes: {} };
  expect((await captureSnapshot(page, { baseline: other })).baseline).toEqual(other);

  const themeKept: CheckSet = {
    schema: 'assay.checks/v1',
    id: 't',
    version: '1',
    task: { instruction: 'Keep my theme.' },
    requirements: [{ id: 'R1', kind: 'hard', text: 'kept', source: { field: 'instruction', quote: 'Keep my theme' } }],
    checks: [
      {
        id: 'C1',
        requirement: 'R1',
        description: 'The theme is what it was before.',
        assert: {
          kind: 'value',
          source: { from: 'storage', area: 'local', key: 'theme' },
          expect: { sameAs: { source: { from: 'storage', area: 'local', key: 'theme', at: 'before' } } },
        },
      },
    ],
  };
  expect(evaluate(themeKept, s).verdict).toBe('fail');
  await page.evaluate(() => localStorage.setItem('theme', 'light'));
  expect(evaluate(themeKept, await captureSnapshot(page)).verdict).toBe('success');
});

test('a baseline belongs to its browser context', async ({ page, browser }) => {
  await page.goto('/');
  await ready(page);
  await captureBaseline(page);
  const other = await browser.newContext();
  try {
    const p = await other.newPage();
    await p.goto(page.url());
    expect((await captureSnapshot(p)).baseline).toBeUndefined();
  } finally {
    await other.close();
  }
});
