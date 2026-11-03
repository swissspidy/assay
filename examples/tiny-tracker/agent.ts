/** Scripted agent actions on Tiny Tracker (server-rendered: every form submit navigates). */
import type { Page, Probe } from '../tiny-shop/deps.ts';

const settle = (page: Page) => page.waitForLoadState('load');

export async function openIssues(page: Page, query = ''): Promise<void> {
  await page.goto(`/issues${query}`);
}

export async function openIssue(page: Page, id: number): Promise<void> {
  await page.goto(`/issues/${id}`);
}

export async function createIssue(
  page: Page,
  o: { title: string; body?: string; priority?: 'Low' | 'Normal' | 'High'; labels?: string[] },
): Promise<void> {
  await page.goto('/issues/new');
  await page.getByLabel('Title').fill(o.title);
  if (o.body) await page.getByLabel('Description').fill(o.body);
  if (o.priority) await page.getByLabel('Priority').selectOption({ label: o.priority });
  for (const l of o.labels ?? []) await page.getByRole('checkbox', { name: l, exact: true }).check();
  await Promise.all([
    page.waitForURL(/\/issues\/\d+$|\/issues$/),
    page.getByRole('button', { name: /Create issue|Submit issue/ }).click(),
  ]);
  await settle(page);
}

async function submit(page: Page, button: RegExp): Promise<void> {
  const url = page.url();
  await Promise.all([page.waitForURL(url), page.getByRole('button', { name: button }).click()]);
  await settle(page);
}

export async function setState(page: Page, id: number, to: 'closed' | 'open'): Promise<void> {
  await openIssue(page, id);
  await submit(page, to === 'closed' ? /Close issue|Resolve/ : /Reopen/);
}

export async function assign(page: Page, id: number, user: string): Promise<void> {
  await openIssue(page, id);
  await page.getByRole('combobox', { name: 'Assignee' }).selectOption({ label: user });
  await submit(page, /Save assignee|Update assignee/);
}

export async function setLabels(page: Page, id: number, labels: string[]): Promise<void> {
  await openIssue(page, id);
  const form = page.getByRole('form', { name: 'Labels' });
  for (const l of ['bug', 'feature', 'docs'])
    await form.getByRole('checkbox', { name: l, exact: true }).setChecked(labels.includes(l));
  await submit(page, /Save labels|Apply labels/);
}

export async function comment(page: Page, id: number, text: string): Promise<void> {
  await openIssue(page, id);
  await page.getByLabel('Comment text').fill(text);
  await submit(page, /^(Comment|Post comment)$/);
}

export async function rename(page: Page, id: number, title: string): Promise<void> {
  await openIssue(page, id);
  await page.getByRole('form', { name: 'Rename' }).getByLabel('Title').fill(title);
  await submit(page, /Rename/);
}

export async function filter(page: Page, o: { status?: 'Open' | 'Closed' | 'All'; label?: string }): Promise<void> {
  await openIssues(page);
  if (o.status) await page.getByLabel('Status').selectOption({ label: o.status });
  if (o.label) await page.getByLabel('Label').selectOption({ label: o.label });
  await Promise.all([page.waitForURL(/\/issues\?/), page.getByRole('button', { name: 'Filter' }).click()]);
  await settle(page);
}

export function trackerProbes(page: Page): Record<string, Probe> {
  return {
    issues: async () => {
      const r = await page.request.get('/api/issues');
      if (!r.ok()) throw new Error(`/api/issues → ${r.status()}`);
      return r.json();
    },
  };
}
