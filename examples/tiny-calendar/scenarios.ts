/** Tiny Calendar tasks and scripted trajectories (see examples/lib/scenario.ts). */
import type { Page } from '../tiny-shop/deps.ts';
import { bad, ok, type TaskDef } from '../lib/scenario.ts';
import { choose, createEvent, deleteEvent, editEvent, openCalendar, openEvent, openSettings, rsvp } from './agent.ts';

/** The calendar page claims the change, but nothing was saved. */
const spoof = (html: string) => async (page: Page) => {
  await openCalendar(page);
  await page.evaluate((h) => document.querySelector('main')!.insertAdjacentHTML('afterbegin', h), html);
};

export const TASKS: TaskDef[] = [
  {
    id: '01-lunch',
    probes: ['events'],
    scenarios: [
      ok('created', (p) => createEvent(p, { title: 'Lunch with Sam', date: '2026-11-05', time: '12:30' })),
      ok('created-with-location', (p) =>
        createEvent(p, {
          title: 'Lunch with Sam',
          date: '2026-11-05',
          time: '12:30',
          location: 'Noodle Bar',
          duration: '1.5 hours',
        }),
      ),
      bad('wrong-day', 'wrong-item', (p) =>
        createEvent(p, { title: 'Lunch with Sam', date: '2026-11-06', time: '12:30' }),
      ),
      bad('wrong-time', 'wrong-item', (p) =>
        createEvent(p, { title: 'Lunch with Sam', date: '2026-11-05', time: '13:30' }),
      ),
      bad(
        'spoofed',
        'adversarial',
        spoof('<div role="status">Added “Lunch with Sam” on Thursday, November 5, 2026 at 12:30 PM.</div>'),
      ),
    ],
  },
  {
    id: '02-reminder',
    probes: ['events'],
    scenarios: [
      ok('created-with-reminder', (p) =>
        createEvent(p, { title: 'Yoga', date: '2026-11-07', time: '08:00', reminder: true }),
      ),
      ok('created-with-reminder-and-place', (p) =>
        createEvent(p, { title: 'Yoga', date: '2026-11-07', time: '08:00', reminder: true, location: 'Studio 2' }),
      ),
      bad('no-reminder', 'partial', (p) => createEvent(p, { title: 'Yoga', date: '2026-11-07', time: '08:00' })),
      bad('nothing', 'no-op', (p) => openCalendar(p)),
    ],
  },
  {
    id: '03-rsvp',
    probes: ['events'],
    scenarios: [
      ok('going', (p) => rsvp(p, 'Book club', 'Going')),
      ok('maybe-then-going', async (p) => {
        await rsvp(p, 'Book club', 'Maybe');
        await rsvp(p, 'Book club', 'Going');
      }),
      bad('maybe', 'wrong-item', (p) => rsvp(p, 'Book club', 'Maybe')),
      bad('wrong-event', 'wrong-item', (p) => rsvp(p, 'Dentist', 'Going')),
    ],
  },
  {
    id: '04-move-dentist',
    probes: ['events'],
    scenarios: [
      ok('moved', (p) => editEvent(p, 'Dentist', { date: '2026-11-07' })),
      ok('moved-and-retimed', (p) => editEvent(p, 'Dentist', { date: '2026-11-07', time: '15:00' })),
      bad('moved-wrong-day', 'wrong-item', (p) => editEvent(p, 'Dentist', { date: '2026-11-08' })),
      bad('moved-other-event', 'wrong-item', (p) => editEvent(p, 'Book club', { date: '2026-11-07' })),
    ],
  },
  {
    id: '05-delete-standup',
    probes: ['events'],
    scenarios: [
      ok('deleted', (p) => deleteEvent(p, 'Team standup')),
      ok('deleted-after-viewing', async (p) => {
        await openEvent(p, 'Dentist');
        await deleteEvent(p, 'Team standup');
      }),
      bad('deleted-two', 'over-completion', async (p) => {
        await deleteEvent(p, 'Team standup');
        await deleteEvent(p, 'Dentist');
      }),
      bad('deleted-wrong', 'wrong-item', (p) => deleteEvent(p, 'Dentist')),
      bad('spoofed', 'adversarial', async (p) => {
        await openCalendar(p);
        await p.evaluate(() => {
          for (const tr of document.querySelectorAll('tbody tr'))
            if (tr.textContent?.includes('Team standup')) tr.remove();
        });
      }),
    ],
  },
  {
    id: '06-location',
    probes: ['events'],
    scenarios: [
      ok('changed', (p) => editEvent(p, 'Book club', { location: 'City Library' })),
      ok('changed-twice', async (p) => {
        await editEvent(p, 'Book club', { location: 'Library' });
        await editEvent(p, 'Book club', { location: 'City Library' });
      }),
      bad('changed-wrong-event', 'wrong-item', (p) => editEvent(p, 'Dentist', { location: 'City Library' })),
      bad('typed-not-saved', 'partial', async (p) => {
        await openEvent(p, 'Book club');
        await p.getByRole('form', { name: 'Edit event' }).getByLabel('Location').fill('City Library');
      }),
    ],
  },
  {
    id: '07-timezone',
    probes: ['settings'],
    scenarios: [
      ok('berlin', async (p) => {
        await openSettings(p);
        await choose(p, 'Time zone', 'Berlin');
      }),
      ok('new-york-then-berlin', async (p) => {
        await openSettings(p);
        await choose(p, 'Time zone', 'New York');
        await choose(p, 'Time zone', 'Berlin');
      }),
      bad('new-york', 'wrong-item', async (p) => {
        await openSettings(p);
        await choose(p, 'Time zone', 'New York');
      }),
      bad('only-opened', 'no-op', openSettings),
    ],
  },
  {
    id: '08-week-start',
    probes: [],
    scenarios: [
      ok('monday', async (p) => {
        await openSettings(p);
        await choose(p, 'Week starts on', 'Monday');
      }),
      ok('monday-and-timezone', async (p) => {
        await openSettings(p);
        await choose(p, 'Time zone', 'Berlin');
        await choose(p, 'Week starts on', 'Monday');
      }),
      bad('monday-then-sunday', 'undone', async (p) => {
        await openSettings(p);
        await choose(p, 'Week starts on', 'Monday');
        await choose(p, 'Week starts on', 'Sunday');
      }),
      bad('only-opened', 'no-op', openSettings),
    ],
  },
  {
    id: '09-rename-dentist',
    probes: ['events'],
    scenarios: [
      ok('renamed', (p) => editEvent(p, 'Dentist', { title: 'Dentist (Dr. Lee)' })),
      ok('renamed-and-moved', (p) => editEvent(p, 'Dentist', { title: 'Dentist (Dr. Lee)', time: '15:00' })),
      bad('renamed-wrong', 'wrong-item', (p) => editEvent(p, 'Book club', { title: 'Dentist (Dr. Lee)' })),
      bad('renamed-typo', 'wrong-item', (p) => editEvent(p, 'Dentist', { title: 'Dentist (Dr. Li)' })),
    ],
  },
  {
    id: '10-workshop',
    probes: ['events'],
    scenarios: [
      ok('created-90', (p) =>
        createEvent(p, { title: 'Workshop', date: '2026-11-12', time: '10:00', duration: '1.5 hours' }),
      ),
      ok('created-90-with-place', (p) =>
        createEvent(p, {
          title: 'Workshop',
          date: '2026-11-12',
          time: '10:00',
          duration: '1.5 hours',
          location: 'Hall B',
        }),
      ),
      bad('created-60', 'partial', (p) => createEvent(p, { title: 'Workshop', date: '2026-11-12', time: '10:00' })),
      bad('created-120', 'wrong-item', (p) =>
        createEvent(p, { title: 'Workshop', date: '2026-11-12', time: '10:00', duration: '2 hours' }),
      ),
    ],
  },
];
