/**
 * Two local fixture servers on different origins (ADR 0012 tests): frames on the same
 * origin and across origins, shadow DOM, multipart form posts and popups.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Site {
  origin: string;
  /** Request bodies the server received, by path. */
  received: { method: string; path: string; contentType: string; bytes: number }[];
  close(): Promise<void>;
}

type Route = (req: IncomingMessage, sites: { app: string; other: string }) => string | undefined;

const html = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

/** Pages of the app origin. `other` is the second origin, for cross-origin frames. */
const appRoutes: Record<string, Route> = {
  '/frames': (_req, { other }) =>
    html(
      'Editor',
      `<main><h1>Edit post</h1>
<iframe title="Editor canvas" src="/canvas"></iframe>
<iframe title="Payment" src="${other}/widget"></iframe>
<iframe title="Tracking pixel" src="/canvas" style="display:none"></iframe>
<p>Status: draft</p></main>`,
    ),
  '/canvas': (_req, { other }) =>
    html(
      'Canvas',
      `<main aria-label="Block editor"><h1 role="textbox" contenteditable="true" aria-label="Add title">Roadmap 2027</h1>
<label>Slug <input value="roadmap-2027"></label>
<div role="textbox" aria-label="Paragraph block" contenteditable="true"><p>What we plan to build next year.</p></div>
<label><input type="checkbox" checked> Sticky</label>
<iframe title="Embed" src="${other}/embed"></iframe></main>`,
    ),
  '/shadow': () =>
    html(
      'Shadow',
      `<main><h1>Shadow DOM</h1>
<x-card><span slot="title">Slotted title</span></x-card>
<x-closed></x-closed>
<script>
customElements.define('x-inner', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<label>Quantity <input type="number" value="3"></label>'; }
});
customElements.define('x-card', class extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML =
      '<section aria-label="Card"><h2><slot name="title"></slot></h2><button>Open shadow button</button><x-inner></x-inner>' +
      '<span id="preview-label">Card preview</span><iframe aria-labelledby="preview-label" src="/receipt"></iframe></section>';
  }
});
customElements.define('x-closed', class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = '<button>Closed shadow button</button>'; }
});
</script></main>`,
    ),
  '/upload': () =>
    html(
      'Upload',
      `<main><h1>New issue</h1>
<form method="post" enctype="multipart/form-data" action="/issues/new">
<label>Title <input name="title" value="Héllo wörld"></label>
<input name="label" value="bug"><input name="label" value="ui">
<label>Attachment <input type="file" name="attachment"></label>
<button>Create issue</button>
</form>
<button id="fetch-form" type="button">Send with fetch</button>
<button id="xhr-form" type="button">Send with XHR</button>
<script>
document.getElementById('fetch-form').addEventListener('click', () => {
  const fd = new FormData();
  fd.append('comment', 'Looks good');
  fd.append('file', new Blob(['abcdef'], { type: 'text/csv' }), 'data.csv');
  fetch('/api/comments', { method: 'POST', body: fd });
});
document.getElementById('xhr-form').addEventListener('click', () => {
  const fd = new FormData(document.querySelector('form'));
  fd.append('via', 'xhr');
  const x = new XMLHttpRequest();
  x.open('POST', '/api/xhr-upload');
  x.send(fd);
});
</script></main>`,
    ),
  '/issues/new': () => html('Issue created', '<main><h1>Issue created</h1></main>'),
  // A page that builds FormData from its own form and sends it (a report its frame supersedes),
  // with a frame whose form uploads natively: the two documents' report ids must not collide.
  '/two-forms': () =>
    html(
      'Two forms',
      `<main><form id="f" method="post" enctype="multipart/form-data" action="/api/main-form"><input name="a" value="1"></form>
<button id="send" type="button" onclick="fetch('/api/main-form', { method: 'POST', body: new FormData(document.getElementById('f')) })">Send</button>
<iframe title="Uploader" src="/upload-frame"></iframe></main>`,
    ),
  '/upload-frame': () =>
    html(
      'Uploader',
      `<form method="post" enctype="multipart/form-data" action="/api/frame-upload"><input type="file" name="doc" aria-label="Document"><button>Upload</button></form>`,
    ),
  '/frameset': () =>
    `<!doctype html><html><head><title>Old frames</title></head><frameset cols="50%,50%"><frame src="/help"><frame src="/help"></frameset></html>`,
  '/popup': () =>
    html(
      'Checkout',
      `<main><h1>Checkout</h1>
<a href="/receipt" target="_blank">Open receipt</a>
<button onclick="window.open('/help', 'help', 'popup')">Help</button>
</main>`,
    ),
  '/receipt': () => html('Receipt', '<main><h1>Receipt</h1><p role="status">Paid US$21.50</p></main>'),
  '/help': () => html('Help', '<main><h1>Help</h1><p>Contact us.</p></main>'),
};

const otherRoutes: Record<string, Route> = {
  '/widget': () =>
    html(
      'Payment widget',
      '<form aria-label="Card"><label>Card number <input value="4242 4242 4242 4242"></label><button type="button">Pay US$21.50</button></form>',
    ),
  '/embed': () => html('Embed', '<figure><figcaption>Embedded chart</figcaption></figure>'),
  // The main thread never yields: nothing can be read from this page.
  '/busy': () => html('Busy', '<p>Busy</p><script>setTimeout(() => { for (;;) {} }, 50)</script>'),
};

function serve(routes: Record<string, Route>, sites: { app: string; other: string }, received: Site['received']) {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (req.method !== 'GET')
        received.push({
          method: req.method ?? '',
          path,
          contentType: req.headers['content-type'] ?? '',
          bytes: Buffer.concat(chunks).length,
        });
      if (path.startsWith('/api/')) {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      const page = routes[path]?.(req, sites);
      if (page === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
    });
  });
}

const listen = (s: Server) =>
  new Promise<string>((resolve) => s.listen(0, () => resolve(`${(s.address() as AddressInfo).port}`)));

/** Start the app origin (localhost) and a second origin (127.0.0.1) for cross-origin frames. */
export async function startSites(): Promise<{ app: Site; other: Site }> {
  const sites = { app: '', other: '' };
  const appReceived: Site['received'] = [];
  const otherReceived: Site['received'] = [];
  const appServer = serve(appRoutes, sites, appReceived);
  const otherServer = serve(otherRoutes, sites, otherReceived);
  sites.app = `http://localhost:${await listen(appServer)}`;
  sites.other = `http://127.0.0.1:${await listen(otherServer)}`;
  const close = (s: Server) => () => new Promise<void>((r) => s.close(() => r()));
  return {
    app: { origin: sites.app, received: appReceived, close: close(appServer) },
    other: { origin: sites.other, received: otherReceived, close: close(otherServer) },
  };
}
