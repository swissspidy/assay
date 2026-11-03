// Tiny Shop: a self-contained demo web app for Assay's tests and examples.
// State is kept per browser session (sid cookie) so parallel tests don't interfere.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { redesign } from '../lib/kit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);

export const PRODUCTS = [
  { sku: 'MUG-BLUE', name: 'Blue Mug', price: 12.0 },
  { sku: 'MUG-RED', name: 'Red Mug', price: 9.5 },
  { sku: 'POT-GREEN', name: 'Green Teapot', price: 27.0 },
];
// Fixed, deterministic delivery estimates.
const DELIVERY = { standard: '2026-11-12', express: '2026-11-05' };

// The deliberate UI change for the stability run (UI_VARIANT=redesign).
const rewrite = redesign([
  ['aria-label="Cart"', 'aria-label="Shopping basket"'],
  ['<h1>Your cart</h1>', '<h1>Basket</h1>'],
  ['aria-label="Cart total"', 'aria-label="Order total"'],
  ['>Place order<', '>Buy now<'],
  ['aria-label="Order summary"', 'aria-label="Your order"'],
  ['Email me the newsletter', 'Send me news by email'],
  ['Estimated delivery:', 'Arrives:'],
  ['<main>', '<main><div class="container">'],
  ['</main>', '</div></main>'],
]);

const sessions = new Map();
function session(req, res) {
  const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  if (sid && sessions.has(sid)) return sessions.get(sid);
  const id = randomUUID();
  const s = { id, cart: [], orders: [], settings: { newsletter: false } };
  sessions.set(id, s);
  res.setHeader('Set-Cookie', `sid=${id}; Path=/; HttpOnly; SameSite=Lax`);
  return s;
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

const cartView = (s) => {
  const items = s.cart.map((l) => {
    const p = PRODUCTS.find((x) => x.sku === l.sku);
    return { sku: l.sku, name: p.name, qty: l.qty, price: p.price, lineTotal: +(p.price * l.qty).toFixed(2) };
  });
  return { items, total: +items.reduce((a, b) => a + b.lineTotal, 0).toFixed(2) };
};

const PAGES = {
  '/': 'index.html',
  '/cart': 'cart.html',
  '/checkout': 'checkout.html',
  '/settings': 'settings.html',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const s = session(req, res);
    const p = url.pathname;

    if (p === '/api/products' && req.method === 'GET') return json(res, 200, PRODUCTS);
    if (p === '/api/cart' && req.method === 'GET') return json(res, 200, cartView(s));
    if (p === '/api/cart/items' && req.method === 'POST') {
      const { sku, qty = 1 } = await readBody(req);
      if (!PRODUCTS.some((x) => x.sku === sku)) return json(res, 400, { error: 'unknown sku' });
      const line = s.cart.find((l) => l.sku === sku);
      if (line) line.qty += qty;
      else s.cart.push({ sku, qty });
      return json(res, 200, cartView(s));
    }
    const item = /^\/api\/cart\/items\/([\w-]+)$/.exec(p);
    if (item && req.method === 'PATCH') {
      const { qty } = await readBody(req);
      const line = s.cart.find((l) => l.sku === item[1]);
      if (!line || !(qty >= 1)) return json(res, 400, { error: 'bad request' });
      line.qty = qty;
      return json(res, 200, cartView(s));
    }
    if (item && req.method === 'DELETE') {
      s.cart = s.cart.filter((l) => l.sku !== item[1]);
      return json(res, 200, cartView(s));
    }
    if (p === '/api/orders' && req.method === 'POST') {
      const body = await readBody(req);
      if (!s.cart.length) return json(res, 409, { error: 'cart is empty' });
      if (!body.name) return json(res, 422, { error: 'name is required' });
      const shipping = body.shipping === 'express' ? 'express' : 'standard';
      const { items, total } = cartView(s);
      const order = {
        id: `A${1000 + s.orders.length + 1}`,
        status: 'placed',
        name: body.name,
        shipping,
        giftWrap: !!body.giftWrap,
        items,
        total,
        estimatedDelivery: DELIVERY[shipping],
      };
      s.orders.push(order);
      s.cart = [];
      return json(res, 201, order);
    }
    if (p === '/api/orders' && req.method === 'GET') return json(res, 200, s.orders);
    const order = /^\/api\/orders\/([\w-]+)$/.exec(p);
    if (order && req.method === 'GET') {
      const o = order[1] === 'latest' ? s.orders.at(-1) : s.orders.find((x) => x.id === order[1]);
      return o ? json(res, 200, o) : json(res, 404, { error: 'not found' });
    }
    if (p === '/api/settings' && req.method === 'GET') return json(res, 200, s.settings);
    if (p === '/api/settings' && req.method === 'PUT') {
      Object.assign(s.settings, await readBody(req));
      return json(res, 200, s.settings);
    }

    const file = PAGES[p] ?? (/^\/orders\/[\w-]+$/.test(p) ? 'order.html' : p === '/app.js' ? 'app.js' : null);
    if (file) {
      const body = await readFile(join(here, 'public', file), 'utf8');
      res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
      return res.end(rewrite(body));
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
});

server.listen(PORT, () => console.log(`tiny-shop listening on http://localhost:${PORT}`));
