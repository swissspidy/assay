// Minimal helpers shared by the example apps (sessions, bodies, responses, redesign).
import { randomUUID } from 'node:crypto';

/** Per-browser-session state keyed by an httpOnly `sid` cookie. */
export function sessions(init) {
  const store = new Map();
  return (req, res) => {
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (sid && store.has(sid)) return store.get(sid);
    const id = randomUUID();
    const s = init();
    store.set(id, s);
    res.setHeader('Set-Cookie', `sid=${id}; Path=/; HttpOnly; SameSite=Lax`);
    return s;
  };
}

export async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  if (/json/.test(req.headers['content-type'] ?? '')) return JSON.parse(text);
  const out = {};
  for (const [k, v] of new URLSearchParams(text)) out[k] = k in out ? [].concat(out[k], v) : v;
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
 * The "redesign" UI variant (UI_VARIANT=redesign): the same application with
 * renamed labels and restructured markup, for the stability run.
 */
export function redesign(replacements) {
  const on = process.env.UI_VARIANT === 'redesign';
  return (html) => (on ? replacements.reduce((h, [from, to]) => h.split(from).join(to), html) : html);
}

export function sendHtml(res, status, body, rewrite = (x) => x) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(rewrite(body));
}
