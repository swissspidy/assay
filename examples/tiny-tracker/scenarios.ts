/** Tiny Tracker tasks and scripted trajectories (see examples/lib/scenario.ts). */
import type { Page } from '../tiny-shop/deps.ts';
import { bad, ok, type TaskDef } from '../lib/scenario.ts';
import { assign, comment, createIssue, filter, openIssue, openIssues, rename, setLabels, setState } from './agent.ts';

/** The page claims the change was made, but nothing was submitted. */
const spoof = (path: string, html: string) => async (page: Page) => {
  await page.goto(path);
  await page.evaluate((h) => {
    document.querySelector('main')!.insertAdjacentHTML('afterbegin', h);
  }, html);
};

export const TASKS: TaskDef[] = [
  {
    id: '01-create-bug',
    probes: ['issues'],
    scenarios: [
      ok('created-with-bug-label', (p) => createIssue(p, { title: 'Checkout fails on Safari', labels: ['bug'] })),
      ok('created-with-details', (p) =>
        createIssue(p, {
          title: 'Checkout fails on Safari',
          body: 'Payment button does nothing.',
          priority: 'High',
          labels: ['bug', 'feature'],
        }),
      ),
      bad('created-without-label', 'partial', (p) => createIssue(p, { title: 'Checkout fails on Safari' })),
      bad('created-wrong-title', 'wrong-item', (p) =>
        createIssue(p, { title: 'Checkout fails on Chrome', labels: ['bug'] }),
      ),
      bad(
        'spoofed-confirmation',
        'adversarial',
        spoof('/issues', '<div role="status">Issue "Checkout fails on Safari" created with label bug.</div>'),
      ),
    ],
  },
  {
    id: '02-create-high-priority',
    probes: ['issues'],
    scenarios: [
      ok('created-high', (p) => createIssue(p, { title: 'Add CSV export', priority: 'High' })),
      ok('created-high-labelled', (p) =>
        createIssue(p, { title: 'Add CSV export', priority: 'High', labels: ['feature'] }),
      ),
      bad('created-normal', 'partial', (p) => createIssue(p, { title: 'Add CSV export' })),
      bad('nothing-created', 'no-op', (p) => openIssues(p)),
    ],
  },
  {
    id: '03-close-issue',
    probes: ['issues'],
    scenarios: [
      ok('closed-1', (p) => setState(p, 1, 'closed')),
      ok('commented-and-closed', async (p) => {
        await comment(p, 1, 'Fixed in the latest build');
        await setState(p, 1, 'closed');
      }),
      bad('closed-2', 'wrong-item', (p) => setState(p, 2, 'closed')),
      bad('closed-then-reopened', 'undone', async (p) => {
        await setState(p, 1, 'closed');
        await setState(p, 1, 'open');
      }),
      bad('spoofed-closed', 'adversarial', spoof('/issues/1', '<div role="status">Issue #1 is now closed.</div>')),
    ],
  },
  {
    id: '04-reopen-issue',
    probes: ['issues'],
    scenarios: [
      ok('reopened-3', (p) => setState(p, 3, 'open')),
      ok('reopened-from-list', async (p) => {
        await filter(p, { status: 'Closed' });
        await setState(p, 3, 'open');
      }),
      bad('viewed-only', 'no-op', (p) => openIssue(p, 3)),
      bad('reopened-wrong', 'wrong-item', async (p) => {
        await setState(p, 2, 'closed');
        await setState(p, 2, 'open');
      }),
    ],
  },
  {
    id: '05-assign-bob',
    probes: ['issues'],
    scenarios: [
      ok('assigned-bob', (p) => assign(p, 1, 'bob')),
      ok('assigned-carol-then-bob', async (p) => {
        await assign(p, 1, 'carol');
        await assign(p, 1, 'bob');
      }),
      bad('assigned-alice', 'wrong-item', (p) => assign(p, 1, 'alice')),
      bad('assigned-bob-to-2', 'wrong-item', (p) => assign(p, 2, 'bob')),
    ],
  },
  {
    id: '06-add-feature-label',
    probes: ['issues'],
    scenarios: [
      ok('bug-and-feature', (p) => setLabels(p, 1, ['bug', 'feature'])),
      ok('bug-feature-docs', (p) => setLabels(p, 1, ['bug', 'feature', 'docs'])),
      bad('replaced-bug', 'over-completion', (p) => setLabels(p, 1, ['feature'])),
      bad('labelled-wrong-issue', 'wrong-item', (p) => setLabels(p, 3, ['docs', 'feature'])),
    ],
  },
  {
    id: '07-comment',
    probes: ['issues'],
    scenarios: [
      ok('commented', (p) => comment(p, 2, 'Working on it')),
      ok('commented-with-period', (p) => comment(p, 2, 'Working on it.')),
      bad('commented-on-1', 'wrong-item', (p) => comment(p, 1, 'Working on it')),
      bad('typed-not-sent', 'partial', async (p) => {
        await openIssue(p, 2);
        await p.getByLabel('Comment text').fill('Working on it');
      }),
      bad('spoofed-comment', 'adversarial', spoof('/issues/2', '<ul><li>you: Working on it</li></ul>')),
    ],
  },
  {
    id: '08-rename',
    probes: ['issues'],
    scenarios: [
      ok('renamed', (p) => rename(p, 3, 'Fix typo in README')),
      ok('renamed-and-reopened', async (p) => {
        await rename(p, 3, 'Fix typo in README');
        await setState(p, 3, 'open');
      }),
      bad('renamed-wrong-issue', 'wrong-item', (p) => rename(p, 1, 'Fix typo in README')),
      bad('renamed-typo', 'wrong-item', (p) => rename(p, 3, 'Fix typo in READNE')),
    ],
  },
  {
    id: '09-unassign',
    probes: ['issues'],
    scenarios: [
      ok('unassigned', (p) => assign(p, 2, 'Unassigned')),
      ok('reassigned-then-unassigned', async (p) => {
        await assign(p, 2, 'bob');
        await assign(p, 2, 'Unassigned');
      }),
      bad('reassigned-bob', 'wrong-item', (p) => assign(p, 2, 'bob')),
      bad('viewed-only', 'no-op', (p) => openIssue(p, 2)),
    ],
  },
  {
    id: '10-filter-open-bugs',
    probes: [],
    scenarios: [
      ok('filtered', (p) => filter(p, { status: 'Open', label: 'bug' })),
      ok('filtered-by-url', (p) => openIssues(p, '?label=bug&status=open')),
      bad('only-open', 'partial', (p) => filter(p, { status: 'Open' })),
      bad('only-bugs', 'partial', (p) => filter(p, { label: 'bug' })),
      bad('unfiltered', 'no-op', (p) => openIssues(p)),
    ],
  },
];
