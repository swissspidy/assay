// Tiny Calendar: a single-page-style calendar backed by a JSON API.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { json as sendJson, loadReleases, readBody, release, sendHtml, sessions } from '../lib/kit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4175);
const DURATIONS = new Set([30, 60, 90, 120]);
const TIMEZONES = new Set(['UTC', 'Europe/Berlin', 'America/New_York']);

const session = sessions(() => ({
  nextId: 4,
  settings: { timezone: 'UTC' },
  events: [
    {
      id: 1,
      title: 'Team standup',
      date: '2026-11-04',
      time: '09:00',
      duration: 30,
      location: 'Room 1',
      reminder: false,
      rsvp: 'yes',
    },
    {
      id: 2,
      title: 'Dentist',
      date: '2026-11-06',
      time: '14:30',
      duration: 60,
      location: 'Main Street 5',
      reminder: true,
      rsvp: 'yes',
    },
    {
      id: 3,
      title: 'Book club',
      date: '2026-11-10',
      time: '19:00',
      duration: 90,
      location: 'Corner Cafe',
      reminder: false,
      rsvp: null,
    },
  ],
}));

// Simulated releases for the stability run (APP_VERSION, see releases.json).
const rel = release('tiny-calendar', loadReleases(new URL('./releases.json', import.meta.url)));
const rewrite = rel.rewrite;
const json = (res, status, body) => sendJson(res, status, rel.shape(body));

/** A real calendar date: 2026-02-30 and 2026-99-99 are rejected, not stored. */
const isDate = (d) => {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d);
};

const valid = (b, partial = false) => {
  const errors = [];
  const has = (k) => b[k] !== undefined;
  if ((!partial || has('title')) && (typeof b.title !== 'string' || !b.title.trim()))
    errors.push('title must be a non-empty string');
  if ((!partial || has('date')) && !isDate(b.date)) errors.push('date must be a real YYYY-MM-DD date');
  if ((!partial || has('time')) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(typeof b.time === 'string' ? b.time : ''))
    errors.push('time must be HH:MM');
  if (has('duration') && !DURATIONS.has(Number(b.duration))) errors.push('invalid duration');
  return errors;
};

const PAGES = { '/calendar': 'calendar.html', '/events/new': 'new.html', '/settings': 'settings.html' };

const server = createServer(async (req, res) => {
  try {
    if (rel.meta(req, res)) return;
    const url = new URL(req.url, `http://${req.headers.host}`);
    const s = session(req, res);
    const p = url.pathname;
    if (p === '/') {
      res.writeHead(303, { location: '/calendar' });
      return res.end();
    }
    if (p === '/api/events' && req.method === 'GET')
      return json(
        res,
        200,
        s.events.toSorted((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),
      );
    if (p === '/api/events' && req.method === 'POST') {
      const b = await readBody(req);
      const errors = valid(b);
      if (errors.length) return json(res, 422, { error: errors.join('; ') });
      const ev = {
        id: s.nextId++,
        title: b.title.trim(),
        date: b.date,
        time: b.time,
        duration: DURATIONS.has(Number(b.duration)) ? Number(b.duration) : 60,
        location: String(b.location ?? ''),
        reminder: !!b.reminder,
        rsvp: 'yes',
      };
      // Release 5 regression: the response echoes the reminder, but it is not stored.
      s.events.push(rel.has('bug:reminder-not-saved') ? { ...ev, reminder: false } : ev);
      return json(res, 201, ev);
    }
    let m = /^\/api\/events\/(\d+)(\/rsvp)?$/.exec(p);
    if (m) {
      const ev = s.events.find((e) => e.id === Number(m[1]));
      if (!ev) return json(res, 404, { error: 'not found' });
      if (m[2] && req.method === 'PUT') {
        const { rsvp } = await readBody(req);
        if (!['yes', 'no', 'maybe'].includes(rsvp)) return json(res, 422, { error: 'invalid rsvp' });
        ev.rsvp = rsvp;
        return json(res, 200, ev);
      }
      if (m[2]) return json(res, 405, { error: 'method not allowed' });
      if (req.method === 'GET') return json(res, 200, ev);
      if (req.method === 'PATCH') {
        const b = await readBody(req);
        const errors = valid(b, true);
        if (errors.length) return json(res, 422, { error: errors.join('; ') });
        for (const k of ['title', 'date', 'time', 'location'])
          if (b[k] !== undefined) ev[k] = k === 'title' ? b[k].trim() : b[k];
        if (b.duration !== undefined) ev.duration = Number(b.duration);
        return json(res, 200, ev);
      }
      if (req.method === 'DELETE') {
        s.events = s.events.filter((e) => e !== ev);
        return json(res, 200, { deleted: ev.id });
      }
    }
    if (p === '/api/settings' && req.method === 'GET') return json(res, 200, s.settings);
    if (p === '/api/settings' && req.method === 'PUT') {
      const b = await readBody(req);
      if (b.timezone !== undefined && !TIMEZONES.has(b.timezone)) return json(res, 422, { error: 'unknown timezone' });
      Object.assign(s.settings, b.timezone ? { timezone: b.timezone } : {});
      return json(res, 200, s.settings);
    }
    const file = PAGES[p] ?? (/^\/events\/\d+$/.test(p) ? 'event.html' : p === '/app.js' ? 'app.js' : null);
    if (file) {
      const body = await readFile(join(here, 'public', file), 'utf8');
      if (file.endsWith('.js')) {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end(rewrite(body));
      }
      return sendHtml(res, 200, body, rewrite);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
});

server.listen(PORT, () => console.log(`tiny-calendar listening on http://localhost:${PORT}`));
