// Minimal helpers shared by the example apps (sessions, bodies, responses, releases).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Per-browser-session state keyed by an httpOnly `sid` cookie. */
export function sessions(init, max = 1000) {
  const store = new Map();
  return (req, res) => {
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (sid && store.has(sid)) return store.get(sid);
    const id = randomUUID();
    const s = init();
    // A demo server: keep the newest sessions only, so cookieless clients cannot grow it forever.
    if (store.size >= max) store.delete(store.keys().next().value);
    store.set(id, s);
    res.setHeader('Set-Cookie', `sid=${id}; Path=/; HttpOnly; SameSite=Lax`);
    return s;
  };
}

const MAX_BODY = 1 << 20;

export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('request body too large');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  if (/json/.test(req.headers['content-type'] ?? '')) return JSON.parse(text);
  // No prototype: field names like "constructor" or "__proto__" are plain keys.
  const out = Object.create(null);
  for (const [k, v] of new URLSearchParams(text)) out[k] = Object.hasOwn(out, k) ? [].concat(out[k], v) : v;
  return out;
}

export const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export const redirect = (res, location) => {
  res.writeHead(303, { location });
  res.end();
};

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * Simulated releases for the stability run (see docs/adr/0005). APP_VERSION=N
 * applies releases 2..N from the app's releases.json, cumulatively, or APP_RELEASES
 * names them ("5" applies only release 5): markup and
 * copy replacements (also applied to served scripts), and named behaviour flags
 * that the server checks with `has()`. Version 1 is the app as recorded.
 */
export function release(app, releases) {
  // APP_RELEASES (e.g. "5") picks releases explicitly, so a regression can be applied on its own.
  const picked = process.env.APP_RELEASES?.split(',').filter(Boolean).map(Number);
  const version = Number(process.env.APP_VERSION ?? 1);
  const active = picked
    ? releases.filter((r) => picked.includes(r.version))
    : releases.filter((r) => r.version <= version);
  const replacements = active.flatMap((r) => r.html ?? []);
  const flags = new Set(active.flatMap((r) => r.flags ?? []));
  const ids = active.map((r) => r.version);
  return {
    app,
    releases: ids,
    has: (flag) => flags.has(flag),
    rewrite: (text) => replacements.reduce((t, [from, to]) => t.split(from).join(to), text),
    /** GET /__assay/version, so a runner can tell which app and version answers on a port. */
    meta(req, res) {
      if (req.url !== '/__assay/version') return false;
      json(res, 200, { app, releases: ids });
      return true;
    },
    /** Release flag "api:extra-fields": every record in a JSON response gains fields nobody asked for. */
    shape(body) {
      if (!flags.has('api:extra-fields')) return body;
      const visit = (x) =>
        Array.isArray(x)
          ? x.map(visit)
          : x && typeof x === 'object'
            ? {
                ...Object.fromEntries(Object.entries(x).map(([k, v]) => [k, visit(v)])),
                ...('id' in x ? { updatedAt: '2026-11-01T00:00:00Z', etag: `W/"${String(x.id)}"` } : {}),
              }
            : x;
      return visit(body);
    },
  };
}

/** Loads an app's releases.json (next to its server.mjs). */
export const loadReleases = (url) => JSON.parse(readFileSync(url, 'utf8')).releases;

export function sendHtml(res, status, body, rewrite = (x) => x) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(rewrite(body));
}
