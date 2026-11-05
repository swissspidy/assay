/** Form request bodies parsed into fields (ADR 0012): multipart and URL-encoded, files by metadata. */
import { expect } from '@playwright/test';
import { captureSnapshot, test } from '../src/playwright/index.ts';
import { evaluate, type CheckSet, type EvidenceSnapshot, type NetworkEntry } from '../src/index.ts';
import { decodeRequestBody } from '../src/snapshot/capture.ts';
import { parseMultipart } from '../src/snapshot/body.ts';
import { startSites, type Site } from './support/sites.ts';

const B = '----WebKitFormBoundaryAbC123';
const multipart = (parts: string[]) => Buffer.from(parts.map((p) => `--${B}\r\n${p}\r\n`).join('') + `--${B}--\r\n`);
const CT = `multipart/form-data; boundary=${B}`;

test('multipart bodies parse into fields: repeated fields become arrays, files keep only metadata', () => {
  const body = multipart([
    'Content-Disposition: form-data; name="title"\r\n\r\nHéllo wörld',
    'Content-Disposition: form-data; name="label"\r\n\r\nbug',
    'Content-Disposition: form-data; name="label"\r\n\r\nui',
    'Content-Disposition: form-data; name="attachment"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\nsecret file content',
    'Content-Disposition: form-data; name="empty"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n',
    'Content-Disposition: form-data; name="a \\"quoted\\" name"\r\n\r\nline 1\r\nline 2',
  ]);
  const { body: parsed, raw, truncated } = decodeRequestBody(body, CT, 1 << 20)!;
  expect(truncated).toBe(false);
  expect(parsed).toEqual({
    title: 'Héllo wörld',
    label: ['bug', 'ui'],
    attachment: { filename: 'notes.txt', type: 'text/plain', size: 19 },
    empty: { filename: '', type: 'application/octet-stream', size: 0 },
    'a "quoted" name': 'line 1\r\nline 2',
  });
  // The raw text is kept, without the content of file parts.
  expect(raw).toContain('Héllo wörld');
  expect(raw).toContain('filename="notes.txt"');
  expect(raw).not.toContain('secret file content');
  expect(raw!.endsWith(`--${B}--\r\n`)).toBe(true);
});

test('field names cannot reach the prototype; malformed multipart is never kept; the limit counts the kept text', () => {
  const proto = decodeRequestBody(
    multipart(['Content-Disposition: form-data; name="__proto__"\r\n\r\nx']),
    CT,
    1 << 20,
  )!.body as Record<string, unknown>;
  expect(Object.hasOwn(proto, '__proto__')).toBe(true);
  expect(({} as Record<string, unknown>).x).toBeUndefined();

  const broken = Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="x"\r\n\r\nno end`);
  expect(parseMultipart(broken, B)).toBeUndefined();
  // Kept as text, a body that does not parse could hold a file's bytes: it is not kept at all.
  const secret = Buffer.from(
    `--${B}\r\nContent-Disposition: form-data; name="f"; filename="a.bin"\r\n\r\nSECRET BYTES`,
  );
  expect(decodeRequestBody(broken, CT, 1 << 20)).toBeUndefined();
  expect(decodeRequestBody(secret, CT, 1 << 20)).toBeUndefined();
  expect(decodeRequestBody(secret, 'multipart/form-data', 1 << 20)).toBeUndefined(); // no boundary

  // A big file does not count towards the limit; text fields do.
  const withFile = multipart([
    'Content-Disposition: form-data; name="f"; filename="big.bin"\r\n\r\n' + 'x'.repeat(5000),
  ]);
  expect(decodeRequestBody(withFile, CT, 200)!.body).toEqual({
    f: { filename: 'big.bin', type: 'application/octet-stream', size: 5000 },
  });
  const longText = multipart(['Content-Disposition: form-data; name="t"\r\n\r\n' + 'y'.repeat(500)]);
  expect(decodeRequestBody(longText, CT, 200)!.truncated).toBe(true);
});

test('URL-encoded bodies keep their raw text next to the parsed fields', () => {
  const r = decodeRequestBody(Buffer.from('a=1&b=x%20y&a=2'), 'application/x-www-form-urlencoded', 1 << 20);
  expect(r).toEqual({ body: { a: ['1', '2'], b: 'x y' }, raw: 'a=1&b=x%20y&a=2', truncated: false });
  // JSON bodies are unchanged: parsed, no raw.
  expect(decodeRequestBody(Buffer.from('{"q":1}'), 'application/json', 100)).toEqual({
    body: { q: 1 },
    truncated: false,
  });
});

const cs = (match: object): CheckSet => ({
  schema: 'assay.checks/v1',
  id: 't',
  version: '1',
  task: { instruction: 'Create the issue.' },
  requirements: [
    { id: 'R1', kind: 'hard', text: 'created', source: { field: 'instruction', quote: 'Create the issue' } },
  ],
  checks: [{ id: 'C1', requirement: 'R1', description: 'd', assert: { kind: 'request', match } as never }],
});

const titled = {
  method: 'POST',
  url: { path: '/issues/new' },
  requestBody: { type: 'object', required: ['title'], properties: { title: { const: 'Héllo wörld' } } },
};

test('a cut response body leaves a request body check decided, and the reverse (older snapshots: both)', () => {
  const entry: NetworkEntry = {
    seq: 0,
    method: 'POST',
    url: 'http://app.test/issues/new',
    resourceType: 'fetch',
    status: 201,
    requestHeaders: { 'content-type': CT },
    requestBody: { title: 'Héllo wörld' },
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: '{"big":',
    bodyTruncated: true,
    responseBodyTruncated: true,
  };
  const net = (e: NetworkEntry): EvidenceSnapshot => ({
    schema: 'assay.snapshot/v1',
    capturedAt: '2026-11-05T00:00:00Z',
    page: { url: 'http://app.test/', title: '' },
    a11y: { role: 'document' },
    text: '',
    network: [e],
    storage: null,
    probes: {},
    meta: { capturer: 'test', redacted: [] },
  });
  const status = (m: object, e: NetworkEntry) => evaluate(cs(m), net(e)).checks[0]!.status;
  const onResponse = { ...titled, responseBody: { type: 'object' } };
  expect(status(titled, entry)).toBe('pass');
  expect(status(onResponse, entry)).toBe('abstain');
  const { responseBodyTruncated: _, ...old } = entry;
  expect(status(titled, old)).toBe('abstain'); // an older snapshot: either body may be the cut one
  expect(status({ ...titled, url: { path: '/other' } }, entry)).toBe('fail');
});

test('a multipart body that could not be read makes body checks abstain, not fail', () => {
  const entry: NetworkEntry = {
    seq: 0,
    method: 'POST',
    url: 'http://app.test/issues/new',
    resourceType: 'document',
    status: 303,
    requestHeaders: { 'content-type': CT },
    requestBodyUnavailable: true,
    responseHeaders: {},
  };
  const snap: EvidenceSnapshot = {
    schema: 'assay.snapshot/v1',
    capturedAt: '2026-11-05T00:00:00Z',
    page: { url: 'http://app.test/issues/1', title: '' },
    a11y: { role: 'document' },
    text: '',
    network: [entry],
    storage: null,
    probes: {},
    meta: { capturer: 'test', redacted: [] },
  };
  const r = evaluate(cs(titled), snap).checks[0]!;
  expect(r.status).toBe('abstain');
  // With onMissing "abstain" (ADR 0011) the route was taken but its body unread: not route_missing.
  const marked = cs(titled);
  marked.checks[0]!.onMissing = 'abstain';
  expect(evaluate(marked, snap).checks[0]!).toMatchObject({ status: 'abstain', reason: 'value_unavailable' });
  // Without the marker, a missing body is an observed absence, as before.
  const { requestBodyUnavailable: _, ...plain } = entry;
  expect(evaluate(cs(titled), { ...snap, network: [plain] }).checks[0]!.status).toBe('fail');
});

test.describe('live multipart posts', () => {
  let app: Site;
  let other: Site;
  test.beforeAll(async () => ({ app, other } = await startSites()));
  test.afterAll(async () => {
    await app.close();
    await other.close();
  });

  test('a form post without a file is parsed from the network', async ({ page }) => {
    await page.goto(`${app.origin}/upload`);
    await page.getByRole('button', { name: 'Create issue' }).click();
    await page.waitForURL('**/issues/new');
    const s = await captureSnapshot(page);
    const post = s.network!.find((e) => e.method === 'POST')!;
    expect(post.requestBody).toEqual({
      title: 'Héllo wörld',
      label: ['bug', 'ui'],
      attachment: { filename: '', type: 'application/octet-stream', size: 0 },
    });
    expect(post.requestBodyRaw).toContain('name="title"');
    expect(post.requestBodyUnavailable).toBeUndefined();
    expect(evaluate(cs(titled), s).verdict).toBe('success');
  });

  test('a form post with a file is filled from the page: name, type and size, no content', async ({ page }) => {
    await page.goto(`${app.origin}/upload`);
    await page.getByLabel('Attachment').setInputFiles({
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('hello file content'),
    });
    await page.getByRole('button', { name: 'Create issue' }).click();
    await page.waitForURL('**/issues/new');
    const s = await captureSnapshot(page);
    const post = s.network!.find((e) => e.method === 'POST')!;
    expect(app.received.at(-1)!.bytes).toBeGreaterThan(18); // the server got the file
    expect(post.requestBody).toEqual({
      title: 'Héllo wörld',
      label: ['bug', 'ui'],
      attachment: { filename: 'notes.txt', type: 'text/plain', size: 18 },
    });
    expect(JSON.stringify(s)).not.toContain('hello file content');
    const attached = cs({
      method: 'POST',
      url: { path: '/issues/new' },
      requestBody: {
        type: 'object',
        required: ['attachment'],
        properties: {
          attachment: {
            type: 'object',
            required: ['filename'],
            properties: { filename: { const: 'notes.txt' } },
          },
        },
      },
    });
    expect(evaluate(attached, s).verdict).toBe('success');
  });

  test('FormData sent with fetch and XHR is filled from the page', async ({ page }) => {
    await page.goto(`${app.origin}/upload`);
    await page.getByRole('button', { name: 'Send with fetch' }).click();
    await page.getByRole('button', { name: 'Send with XHR' }).click();
    await expect.poll(() => app.received.filter((r) => r.path.startsWith('/api/')).length).toBe(2);
    const s = await captureSnapshot(page);
    const byPath = (p: string) => s.network!.find((e) => e.url.endsWith(p))!;
    expect(byPath('/api/comments').requestBody).toEqual({
      comment: 'Looks good',
      file: { filename: 'data.csv', type: 'text/csv', size: 6 },
    });
    // new FormData(form) fires a formdata event; the XHR that sends it reports it once.
    expect(byPath('/api/xhr-upload').requestBody).toEqual({
      title: 'Héllo wörld',
      label: ['bug', 'ui'],
      attachment: { filename: '', type: 'application/octet-stream', size: 0 },
      via: 'xhr',
    });
  });

  test("one document's superseded form report does not hide another frame's upload", async ({ page }) => {
    await page.goto(`${app.origin}/two-forms`);
    // The main document reports new FormData(form), then the fetch that sends it supersedes it.
    await page.getByRole('button', { name: 'Send' }).click();
    const frame = page.frameLocator('iframe[title="Uploader"]');
    await frame
      .getByLabel('Document')
      .setInputFiles({ name: 'cv.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
    await frame.getByRole('button', { name: 'Upload' }).click();
    await expect.poll(() => app.received.filter((r) => r.path === '/api/frame-upload').length).toBe(1);
    const s = await captureSnapshot(page);
    expect(s.network!.find((e) => e.url.endsWith('/api/frame-upload'))!.requestBody).toEqual({
      doc: { filename: 'cv.pdf', type: 'application/pdf', size: 4 },
    });
    expect(s.network!.find((e) => e.url.endsWith('/api/main-form'))!.requestBody).toEqual({ a: '1' });
  });

  test('a Request built with a FormData body is filled from the page', async ({ page }) => {
    await page.goto(`${app.origin}/upload`);
    await page.evaluate(async () => {
      const fd = new FormData();
      fd.append('note', 'hi');
      fd.append('f', new Blob(['12345'], { type: 'text/plain' }), 'n.txt');
      await fetch(new Request('/api/request-object', { method: 'POST', body: fd }));
    });
    const s = await captureSnapshot(page);
    expect(s.network!.find((e) => e.url.endsWith('/api/request-object'))!.requestBody).toEqual({
      note: 'hi',
      f: { filename: 'n.txt', type: 'text/plain', size: 5 },
    });
  });

  test('page scripts cannot fill an upload body through the tap binding', async ({ page }) => {
    await page.goto(`${app.origin}/upload`);
    await page.evaluate(async () => {
      const name = Object.keys(window).find((k) => k.startsWith('__assay_'))!;
      const call = (window as unknown as Record<string, (p: unknown) => Promise<void>>)[name]!;
      const fd = new FormData();
      fd.append('f', new Blob(['real']), 'real.txt');
      // The page's own report needs the tap's token; a guess is dropped.
      await call({ token: 'guess', kind: 'form', method: 'POST', url: location.origin + '/api/up', fields: [] });
      await fetch('/api/up', { method: 'POST', body: fd });
    });
    const s = await captureSnapshot(page);
    expect(s.network!.find((e) => e.url.endsWith('/api/up'))!.requestBody).toEqual({
      f: { filename: 'real.txt', type: 'application/octet-stream', size: 4 },
    });
  });

  test('a GET with a content type but no body is not marked unavailable', async ({ page }) => {
    await page.goto(`${app.origin}/upload`);
    await page.evaluate(() => fetch('/api/list', { headers: { 'content-type': 'application/json' } }));
    const s = await captureSnapshot(page);
    const get = s.network!.find((e) => e.url.endsWith('/api/list'))!;
    expect(get.requestBody).toBeUndefined();
    expect(get.requestBodyUnavailable).toBeUndefined();
  });

  test('a POST with a JSON content type and no body is not marked unavailable', async ({ page }) => {
    await page.goto(`${app.origin}/upload`);
    await page.evaluate(() => fetch('/api/ping', { method: 'POST', headers: { 'content-type': 'application/json' } }));
    const s = await captureSnapshot(page);
    const post = s.network!.find((e) => e.url.endsWith('/api/ping'))!;
    expect(post.requestBody).toBeUndefined();
    expect(post.requestBodyUnavailable).toBeUndefined();
  });

  test('a multipart body that does not parse is marked unavailable, and its bytes are not kept', async ({ page }) => {
    await page.goto(`${app.origin}/upload`);
    await page.evaluate(() =>
      fetch('/api/raw', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=zz' },
        body: '--zz\r\nContent-Disposition: form-data; name="f"; filename="a.bin"\r\n\r\nSECRET BYTES',
      }),
    );
    const s = await captureSnapshot(page);
    const post = s.network!.find((e) => e.url.endsWith('/api/raw'))!;
    expect(post.requestBodyUnavailable).toBe(true);
    expect(JSON.stringify(s)).not.toContain('SECRET BYTES');
  });

  test('two different uploads to one URL stay unavailable rather than be paired by guess', async ({ page }) => {
    await page.goto(`${app.origin}/upload`);
    await page.evaluate(async () => {
      for (const name of ['a.txt', 'b.txt']) {
        const fd = new FormData();
        fd.append('f', new Blob([name]), name);
        await fetch('/api/same', { method: 'POST', body: fd });
      }
    });
    const s = await captureSnapshot(page);
    const posts = s.network!.filter((e) => e.url.endsWith('/api/same'));
    expect(posts).toHaveLength(2);
    for (const p of posts) {
      expect(p.requestBody).toBeUndefined();
      expect(p.requestBodyUnavailable).toBe(true);
    }
  });
});
