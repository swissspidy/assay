/** Scripted agent actions on Tiny Calendar (JSON API behind every action). */
import type { Page, Probe } from '../tiny-shop/deps.ts';

export const ready = (page: Page) => page.locator('body[data-ready]').waitFor();

export async function openCalendar(page: Page): Promise<void> {
  await page.goto('/calendar');
  await ready(page);
}

export async function openEvent(page: Page, title: string): Promise<void> {
  await openCalendar(page);
  await Promise.all([page.waitForURL(/\/events\/\d+$/), page.getByRole('link', { name: title, exact: true }).click()]);
  await ready(page);
}

export async function createEvent(
  page: Page,
  o: {
    title: string;
    date: string;
    time: string;
    duration?: '30 minutes' | '1 hour' | '1.5 hours' | '2 hours';
    location?: string;
    reminder?: boolean;
  },
): Promise<void> {
  await page.goto('/events/new');
  await ready(page);
  await page.getByLabel('Title').fill(o.title);
  await page.getByLabel('Date').fill(o.date);
  await page.getByLabel('Start time').fill(o.time);
  if (o.duration) await page.getByLabel('Duration').selectOption({ label: o.duration });
  if (o.location) await page.getByLabel('Location').fill(o.location);
  if (o.reminder) await page.getByRole('checkbox', { name: /Remind me/ }).check();
  await Promise.all([
    page.waitForURL(/\/events\/\d+$/),
    page.getByRole('button', { name: /Create event|Add to calendar/ }).click(),
  ]);
  await ready(page);
}

export async function rsvp(page: Page, title: string, answer: 'Going' | 'Maybe' | 'Not going'): Promise<void> {
  await openEvent(page, title);
  const radio = page.getByRole('radio', { name: answer, exact: true });
  if (await radio.isChecked()) return; // already the answer: nothing to save
  const saved = page.waitForResponse((r) => r.url().endsWith('/rsvp') && r.request().method() === 'PUT');
  saved.catch(() => {}); // surface the click error instead of an orphaned wait
  await radio.check();
  await saved;
}

export async function editEvent(
  page: Page,
  title: string,
  changes: { title?: string; date?: string; time?: string; location?: string },
): Promise<void> {
  await openEvent(page, title);
  const form = page.getByRole('form', { name: 'Edit event' });
  if (changes.title !== undefined) await form.getByLabel('Title').fill(changes.title);
  if (changes.date !== undefined) await form.getByLabel('Date').fill(changes.date);
  if (changes.time !== undefined) await form.getByLabel('Start time').fill(changes.time);
  if (changes.location !== undefined) await form.getByLabel('Location').fill(changes.location);
  const saved = page.waitForResponse((r) => r.request().method() === 'PATCH');
  saved.catch(() => {});
  await form.getByRole('button', { name: /Save changes|Update event/ }).click();
  await saved;
  await page
    .getByRole('status')
    .filter({ hasText: /saved|Could not/ })
    .waitFor();
}

export async function deleteEvent(page: Page, title: string): Promise<void> {
  await openEvent(page, title);
  page.once('dialog', (d) => d.accept());
  await Promise.all([page.waitForURL(/\/calendar$/), page.getByRole('button', { name: 'Delete event' }).click()]);
  await ready(page);
}

export async function openSettings(page: Page): Promise<void> {
  await page.goto('/settings');
  await ready(page);
}

export async function choose(page: Page, label: string, option: string): Promise<void> {
  await page.getByLabel(label).selectOption({ label: option });
  await page.getByRole('status').filter({ hasText: 'Settings saved' }).waitFor();
}

export function calendarProbes(page: Page): Record<string, Probe> {
  const get = async (path: string) => {
    const r = await page.request.get(path);
    if (!r.ok()) throw new Error(`${path} → ${r.status()}`);
    return r.json();
  };
  return { events: () => get('/api/events'), settings: () => get('/api/settings') };
}
