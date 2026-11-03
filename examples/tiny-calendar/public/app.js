// Shared helpers for Tiny Calendar pages.
const LOCALE = 'en-US';
export async function api(method, path, body) {
  const init = { method };
  if (body) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const at = (date, time) => new Date(`${date}T${time}:00Z`);
export const fmtDate = (date) =>
  new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeZone: 'UTC' }).format(at(date, '00:00'));
export const fmtLongDate = (date) =>
  new Intl.DateTimeFormat(LOCALE, { dateStyle: 'full', timeZone: 'UTC' }).format(at(date, '00:00'));
export const fmtTime = (date, time) =>
  new Intl.DateTimeFormat(LOCALE, { timeStyle: 'short', timeZone: 'UTC' }).format(at(date, time));
export const header = `<header><a href="/calendar">Tiny Calendar</a><nav aria-label="Primary"><a href="/calendar">Calendar</a> · <a href="/events/new">New event</a> · <a href="/settings">Settings</a></nav></header>`;
