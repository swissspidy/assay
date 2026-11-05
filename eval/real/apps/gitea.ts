/**
 * Gitea 1.22 (a self-hosted Git forge with issues, milestones and labels), the
 * stand-in for WebArena's GitLab. SQLite, one container, starts in seconds.
 * Seeded through the admin API; reset by restoring a copy of /data.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { docker, removeContainer, sh, waitFor, waitHttp, workDir } from '../lib/sh.ts';
import type { OracleResult, RealApp, RealTask } from '../lib/types.ts';

const IMAGE = 'gitea/gitea:1.22.6';
const CONTAINER = 'assay-real-gitea';
const PORT = Number(process.env.ASSAY_GITEA_PORT ?? 4310);
const BASE = `http://localhost:${PORT}`;
const ADMIN = { user: 'siteadmin', pass: 'Assay-admin-1' };
export const PASSWORD = 'Assay-user-1';
export const REPO = 'acme/webapp';

// --- API ---------------------------------------------------------------------

async function api<T = unknown>(method: string, path: string, body?: unknown, sudo?: string): Promise<T> {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`${ADMIN.user}:${ADMIN.pass}`).toString('base64')}`,
      'content-type': 'application/json',
      ...(sudo ? { sudo } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

interface ApiIssue {
  number: number;
  title: string;
  state: string;
  labels: { name: string }[];
  assignees: { login: string }[] | null;
  milestone: { title: string } | null;
  comments: number;
}

export async function issues(): Promise<ApiIssue[]> {
  const out: ApiIssue[] = [];
  for (let page = 1; ; page++) {
    const batch = await api<ApiIssue[]>('GET', `/repos/${REPO}/issues?state=all&type=issues&limit=50&page=${page}`);
    out.push(...batch);
    if (batch.length < 50) return out;
  }
}

export const issueByTitle = async (title: string) => (await issues()).filter((i) => i.title.trim() === title);

interface ApiComment {
  issue_url: string;
  user: { login: string };
  body: string;
  id: number;
}
export const comments = () => api<ApiComment[]>('GET', `/repos/${REPO}/issues/comments?limit=200`);
export const milestones = () =>
  api<{ title: string; state: string; due_on: string | null; description: string }[]>(
    'GET',
    `/repos/${REPO}/milestones?state=all&limit=50`,
  );
export const userRepos = (user: string) =>
  api<{ full_name: string; private: boolean; description: string; empty: boolean }[]>(
    'GET',
    '/user/repos?limit=50',
    undefined,
    user,
  );
export const starred = (user: string) => api<{ full_name: string }[]>('GET', '/user/starred?limit=50', undefined, user);
const labelIds = async () =>
  Object.fromEntries(
    (await api<{ id: number; name: string }[]>('GET', `/repos/${REPO}/labels?limit=50`)).map((l) => [l.name, l.id]),
  );

// --- seed --------------------------------------------------------------------

const USERS = ['alice', 'bob', 'carol', 'dave'];
const LABELS: [string, string, string][] = [
  ['bug', 'ee0701', 'Something is not working'],
  ['feature', '0e8a16', 'New functionality'],
  ['docs', '1d76db', 'Documentation'],
  ['security', 'b60205', 'Security-relevant'],
  ['question', 'cc317c', 'Further information is requested'],
];
interface SeedIssue {
  title: string;
  body: string;
  by: string;
  labels: string[];
  closed?: boolean;
  assignees?: string[];
  milestone?: string;
  comments?: [string, string][];
}
const ISSUES: SeedIssue[] = [
  {
    title: 'Crash when uploading empty file',
    body: 'Uploading a 0-byte file through the attachments dialog crashes the worker with a division by zero.',
    by: 'bob',
    labels: ['bug'],
    comments: [['carol', 'Confirmed on main.']],
  },
  {
    title: 'Add CSV export',
    body: 'Users want to download the report table as CSV.',
    by: 'carol',
    labels: ['feature'],
    milestone: 'v1.1',
  },
  {
    title: 'Dark mode toggle does not persist',
    body: 'When I switch to the dark theme and reload the page, the setting is lost and the light theme comes back.',
    by: 'dave',
    labels: ['bug'],
    comments: [['bob', 'Probably the preference is only kept in memory.']],
  },
  {
    title: 'Typo in README',
    body: '"recieve" should be "receive" in the installation section.',
    by: 'dave',
    labels: ['bug'],
  },
  {
    title: 'Session expires too early',
    body: 'Sessions end after 5 minutes of inactivity instead of 30.',
    by: 'bob',
    labels: ['bug'],
    closed: true,
    milestone: 'v1.0',
  },
  {
    title: 'Improve onboarding docs',
    body: 'The getting started guide skips the database setup.',
    by: 'carol',
    labels: ['docs'],
  },
  {
    title: 'Upgrade to Node 24',
    body: 'Node 20 reaches end of life; move CI and the runtime to Node 24.',
    by: 'alice',
    labels: ['feature'],
    assignees: ['carol'],
    milestone: 'v1.1',
  },
  { title: 'Login fails with SSO', body: 'SAML login returns a 500.', by: 'dave', labels: ['bug'], closed: true },
  { title: 'Add keyboard shortcuts', body: 'j/k to move through lists, / to search.', by: 'bob', labels: ['feature'] },
  {
    title: 'Broken link in footer',
    body: 'The "Privacy" link in the footer returns 404.',
    by: 'carol',
    labels: ['bug'],
  },
  {
    title: 'Rate limit API endpoints',
    body: 'Add per-token rate limits to the public API.',
    by: 'alice',
    labels: ['security'],
  },
  {
    title: 'Crash when uploading large file',
    body: 'Files over 2 GB crash the upload worker with an out-of-memory error.',
    by: 'dave',
    labels: ['bug'],
  },
  {
    title: 'Settings page loads slowly',
    body: 'The settings page takes 4 seconds to render.',
    by: 'bob',
    labels: ['bug'],
    assignees: ['bob'],
  },
  { title: 'How do I reset my API token?', body: 'I cannot find the option.', by: 'dave', labels: ['question'] },
];

async function seed(): Promise<void> {
  for (const u of USERS) {
    await api('POST', '/admin/users', {
      username: u,
      email: `${u}@example.com`,
      password: PASSWORD,
      must_change_password: false,
      full_name: u[0]!.toUpperCase() + u.slice(1),
    });
  }
  await api('POST', '/orgs', { username: 'acme', full_name: 'Acme Corp', visibility: 'public' });
  const teams = await api<{ id: number; name: string }[]>('GET', '/orgs/acme/teams');
  const owners = teams.find((t) => t.name === 'Owners')!;
  for (const u of USERS) await api('PUT', `/teams/${owners.id}/members/${u}`);
  for (const [name, description] of [
    ['webapp', 'The Acme customer web application'],
    ['docs', 'Product documentation'],
    ['infra', 'Deployment and infrastructure'],
  ]) {
    await api('POST', '/orgs/acme/repos', { name, description, auto_init: true, readme: 'Default' });
  }
  await api('POST', '/admin/users/alice/repos', {
    name: 'dotfiles',
    description: 'My dotfiles',
    auto_init: true,
    readme: 'Default',
  });
  await api('POST', '/admin/users/bob/repos', { name: 'scratch', description: 'Experiments', auto_init: true });
  for (const [name, color, description] of LABELS) {
    await api('POST', `/repos/${REPO}/labels`, { name, color: `#${color}`, description });
  }
  const ms: Record<string, number> = {};
  for (const [title, due, state] of [
    ['v1.0', '2026-09-30T12:00:00Z', 'closed'],
    ['v1.1', '2026-12-15T12:00:00Z', 'open'],
  ] as const) {
    const m = await api<{ id: number }>('POST', `/repos/${REPO}/milestones`, { title, due_on: due });
    ms[title] = m.id;
    if (state === 'closed') await api('PATCH', `/repos/${REPO}/milestones/${m.id}`, { state: 'closed' });
  }
  const ids = await labelIds();
  for (const i of ISSUES) {
    const created = await api<{ number: number }>(
      'POST',
      `/repos/${REPO}/issues`,
      {
        title: i.title,
        body: i.body,
        labels: i.labels.map((l) => ids[l]),
        ...(i.assignees ? { assignees: i.assignees } : {}),
        ...(i.milestone ? { milestone: ms[i.milestone] } : {}),
      },
      i.by,
    );
    for (const [who, text] of i.comments ?? []) {
      await api('POST', `/repos/${REPO}/issues/${created.number}/comments`, { body: text }, who);
    }
    if (i.closed) await api('PATCH', `/repos/${REPO}/issues/${created.number}`, { state: 'closed' });
  }
  await api('POST', '/repos/acme/docs/issues', { title: 'Document the export API', body: 'No docs yet.' }, 'carol');
  await api('PUT', '/user/starred/acme/infra', undefined, 'alice');
}

// --- container lifecycle -----------------------------------------------------

const dataDir = () => workDir('gitea', 'data');
const pristineDir = () => join(workDir('gitea'), 'pristine');

async function run(): Promise<void> {
  await removeContainer(CONTAINER);
  await docker(
    'run',
    '-d',
    '--name',
    CONTAINER,
    '-p',
    `${PORT}:3000`,
    '-v',
    `${dataDir()}:/data`,
    '-e',
    'GITEA__security__INSTALL_LOCK=true',
    '-e',
    `GITEA__server__ROOT_URL=${BASE}/`,
    '-e',
    'GITEA__database__DB_TYPE=sqlite3',
    '-e',
    'GITEA__mailer__ENABLED=false',
    '-e',
    'GITEA__service__DISABLE_REGISTRATION=true',
    '-e',
    'GITEA__api__ENABLE_SWAGGER=false',
    '-e',
    'GITEA__ui__SHOW_USER_EMAIL=false',
    '-e',
    'GITEA__time__DEFAULT_UI_LOCATION=UTC',
    '-e',
    'GITEA__cron__ENABLED=false',
    IMAGE,
  );
  await waitHttp(`${BASE}/api/v1/version`);
}

async function start(): Promise<void> {
  if (!existsSync(join(pristineDir(), 'gitea'))) {
    rmSync(dataDir(), { recursive: true, force: true });
    workDir('gitea', 'data');
    await run();
    // The admin is created with the CLI (the API needs an admin to exist).
    await waitFor('gitea admin', () =>
      sh('docker', [
        'exec',
        '-u',
        '1000',
        CONTAINER,
        'gitea',
        'admin',
        'user',
        'create',
        '--admin',
        '--username',
        ADMIN.user,
        '--password',
        ADMIN.pass,
        '--email',
        'admin@example.com',
        '--must-change-password=false',
      ]),
    );
    await seed();
    await docker('stop', CONTAINER);
    rmSync(pristineDir(), { recursive: true, force: true });
    cpSync(dataDir(), pristineDir(), { recursive: true, preserveTimestamps: true });
  }
  await reset();
}

async function reset(): Promise<void> {
  await removeContainer(CONTAINER);
  // The container's files belong to uid 1000; copying as root keeps the modes, and the
  // entrypoint fixes ownership on start.
  rmSync(dataDir(), { recursive: true, force: true });
  cpSync(pristineDir(), dataDir(), { recursive: true, preserveTimestamps: true });
  await run();
}

// --- browser -----------------------------------------------------------------

async function signIn(context: BrowserContext, user: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(`${BASE}/user/login`);
  await page.getByLabel('Username or Email Address').fill(user);
  await page.getByLabel('Password').fill(PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/user/login')),
    page.getByRole('button', { name: 'Sign In' }).click(),
  ]);
  await page.close();
}

const compactIssue = (i: ApiIssue) => ({
  number: i.number,
  title: i.title,
  state: i.state,
  labels: i.labels.map((l) => l.name),
  assignees: (i.assignees ?? []).map((a) => a.login),
  milestone: i.milestone?.title ?? null,
  comments: i.comments,
});

function probes(): Record<string, () => Promise<unknown>> {
  return {
    issues: async () => (await issues()).map(compactIssue).toSorted((a, b) => a.number - b.number),
    issueComments: async () =>
      (await comments()).map((c) => ({
        issue: Number(c.issue_url.split('/').pop()),
        user: c.user.login,
        body: c.body,
      })),
    milestones: async () => (await milestones()).map((m) => ({ title: m.title, state: m.state, due_on: m.due_on })),
    aliceRepos: async () =>
      (await userRepos('alice')).map((r) => ({
        full_name: r.full_name,
        private: r.private,
        description: r.description,
        empty: r.empty,
      })),
    aliceStarred: async () => (await starred('alice')).map((r) => r.full_name).toSorted(),
  };
}

// --- tasks -------------------------------------------------------------------

const ok = (reason: string, facts?: unknown): OracleResult => ({ success: true, reason, facts });
const no = (reason: string, facts?: unknown): OracleResult => ({ success: false, reason, facts });
/** Dictated prose: a final period or exclamation mark and surrounding whitespace are accepted. */
const prose = (s: string) => s.trim().replace(/[.!]$/, '');

async function openIssue(page: Page, title: string): Promise<void> {
  await page.goto(`${BASE}/${REPO}/issues?state=all&q=${encodeURIComponent(title)}`);
  await page.getByRole('link', { name: title, exact: true }).first().click();
  await page.waitForLoadState('load');
}

/** Toggles items in one of the issue sidebar's dropdown menus (labels, assignees, milestone). */
async function sidebarSelect(page: Page, menu: 'Labels' | 'Assignees' | 'Milestone', items: string[]): Promise<void> {
  const combo = page.getByRole('combobox').filter({ hasText: menu }).first();
  await combo.click();
  for (const item of items) {
    await combo
      .locator('.item')
      .filter({ hasText: new RegExp(`^\\s*${item.replace(/[.]/g, '\\.')}(\\s|$)`) })
      .first()
      .click();
    await page.waitForTimeout(300);
  }
  // Closing the menu saves the selection (on an existing issue the page then reloads).
  await page.mouse.click(5, 300);
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);
}

const TASKS: RealTask[] = [
  {
    id: 'g01-create-issue',
    instruction:
      'In the acme/webapp repository, open a new issue titled "Search results ignore accents" with the label bug.',
    start: `/${REPO}/issues`,
    user: 'alice',
    oracleDoc: 'Exactly one issue has that title, it is open, and its labels are exactly [bug].',
    async reference(page) {
      await page.goto(`${BASE}/${REPO}/issues/new`);
      await page.getByPlaceholder('Title').fill('Search results ignore accents');
      await sidebarSelect(page, 'Labels', ['bug']);
      await Promise.all([
        page.waitForURL(/\/issues\/\d+$/),
        page.getByRole('button', { name: 'Create Issue' }).click(),
      ]);
    },
    perturbations: [
      {
        name: 'perturbed-wrong-label',
        kind: 'wrong-item',
        async run(page) {
          await page.goto(`${BASE}/${REPO}/issues/new`);
          await page.getByPlaceholder('Title').fill('Search results ignore accents');
          await sidebarSelect(page, 'Labels', ['feature']);
          await Promise.all([
            page.waitForURL(/\/issues\/\d+$/),
            page.getByRole('button', { name: 'Create Issue' }).click(),
          ]);
        },
      },
    ],
    async oracle() {
      const found = await issueByTitle('Search results ignore accents');
      const facts = found.map(compactIssue);
      if (found.length !== 1) return no(`${found.length} issues with that title`, facts);
      const labels = found[0]!.labels.map((l) => l.name).toSorted();
      if (found[0]!.state !== 'open') return no('issue is not open', facts);
      if (labels.join(',') !== 'bug') return no(`labels are [${labels.join(', ')}]`, facts);
      return ok('one open issue labelled bug', facts);
    },
  },
  {
    id: 'g02-close-issue',
    instruction: 'Close the issue "Crash when uploading empty file" in acme/webapp.',
    start: `/${REPO}/issues`,
    user: 'alice',
    oracleDoc:
      'The issue with that title is closed; every other issue keeps its seeded state (in particular "Crash when uploading large file" stays open).',
    async reference(page) {
      await openIssue(page, 'Crash when uploading empty file');
      await page.getByRole('button', { name: 'Close Issue' }).click();
      await page.waitForLoadState('load');
      await page.getByRole('button', { name: 'Reopen', exact: true }).waitFor();
    },
    perturbations: [
      {
        name: 'perturbed-closed-similar',
        kind: 'wrong-item',
        async run(page) {
          await openIssue(page, 'Crash when uploading large file');
          await page.getByRole('button', { name: 'Close Issue' }).click();
          await page.getByRole('button', { name: 'Reopen', exact: true }).waitFor();
        },
      },
    ],
    async oracle() {
      const all = (await issues()).map(compactIssue);
      const target = all.find((i) => i.title === 'Crash when uploading empty file');
      const changed = all.filter(
        (i) => i.title !== 'Crash when uploading empty file' && i.state !== (SEEDED_STATE.get(i.title) ?? i.state),
      );
      const facts = { target, otherStateChanges: changed };
      if (target?.state !== 'closed') return no('target issue is not closed', facts);
      if (changed.length) return no(`other issues changed state: ${changed.map((c) => c.title).join(', ')}`, facts);
      return ok('target closed, nothing else changed state', facts);
    },
  },
  {
    id: 'g03-comment',
    instruction:
      'On the acme/webapp issue about the dark mode setting not being saved, add the comment "I can reproduce this in Firefox 128."',
    start: `/${REPO}/issues`,
    user: 'alice',
    oracleDoc:
      'Issue "Dark mode toggle does not persist" has exactly one new comment by alice whose text is the dictated sentence (final period optional); alice commented nowhere else.',
    async reference(page) {
      await openIssue(page, 'Dark mode toggle does not persist');
      await page.locator('#comment-form textarea').fill('I can reproduce this in Firefox 128.');
      await page.getByRole('button', { name: 'Comment', exact: true }).click();
      await page.getByText('I can reproduce this in Firefox 128.').first().waitFor();
    },
    perturbations: [
      {
        name: 'perturbed-wrong-issue',
        kind: 'wrong-item',
        async run(page) {
          await openIssue(page, 'Settings page loads slowly');
          await page.locator('#comment-form textarea').fill('I can reproduce this in Firefox 128.');
          await page.getByRole('button', { name: 'Comment', exact: true }).click();
          await page.getByText('I can reproduce this in Firefox 128.').first().waitFor();
        },
      },
    ],
    async oracle() {
      const all = await issues();
      const target = all.find((i) => i.title === 'Dark mode toggle does not persist')!;
      const mine = (await comments()).filter((c) => c.user.login === 'alice');
      const facts = mine.map((c) => ({ issue: Number(c.issue_url.split('/').pop()), body: c.body }));
      const onTarget = facts.filter((c) => c.issue === target.number);
      if (onTarget.length !== 1) return no(`${onTarget.length} comments by alice on the target issue`, facts);
      if (prose(onTarget[0]!.body) !== 'I can reproduce this in Firefox 128') return no('comment text differs', facts);
      if (facts.length !== 1) return no('alice also commented elsewhere', facts);
      return ok('one matching comment on the target issue', facts);
    },
  },
  {
    id: 'g04-assign',
    instruction: 'Assign the "Add CSV export" issue in acme/webapp to bob.',
    start: `/${REPO}/issues`,
    user: 'alice',
    oracleDoc: 'The issue "Add CSV export" has exactly the assignees [bob].',
    async reference(page) {
      await openIssue(page, 'Add CSV export');
      await sidebarSelect(page, 'Assignees', ['bob']);
    },
    perturbations: [
      {
        name: 'perturbed-assigned-carol',
        kind: 'wrong-item',
        async run(page) {
          await openIssue(page, 'Add CSV export');
          await sidebarSelect(page, 'Assignees', ['carol']);
        },
      },
    ],
    async oracle() {
      const [i] = (await issueByTitle('Add CSV export')).map(compactIssue);
      if (i?.assignees.toSorted().join(',') !== 'bob') return no(`assignees are [${i?.assignees.join(', ')}]`, i);
      return ok('assigned to bob only', i);
    },
  },
  {
    id: 'g05-milestone',
    instruction: 'Create a milestone "v2.0" in acme/webapp with the due date December 31, 2026.',
    start: `/${REPO}/issues`,
    user: 'alice',
    oracleDoc: 'Exactly one milestone is titled "v2.0", it is open, and its due date (UTC date part) is 2026-12-31.',
    async reference(page) {
      await page.goto(`${BASE}/${REPO}/milestones/new`);
      await page.locator('input[name=title]').fill('v2.0');
      await page.locator('input[name=deadline]').fill('2026-12-31');
      await Promise.all([
        page.waitForURL(/\/milestones$/),
        page.getByRole('button', { name: 'Create Milestone' }).click(),
      ]);
    },
    perturbations: [
      {
        name: 'perturbed-wrong-date',
        kind: 'wrong-item',
        async run(page) {
          await page.goto(`${BASE}/${REPO}/milestones/new`);
          await page.locator('input[name=title]').fill('v2.0');
          await page.locator('input[name=deadline]').fill('2026-12-01');
          await Promise.all([
            page.waitForURL(/\/milestones$/),
            page.getByRole('button', { name: 'Create Milestone' }).click(),
          ]);
        },
      },
    ],
    async oracle() {
      const found = (await milestones()).filter((m) => m.title.trim() === 'v2.0');
      if (found.length !== 1) return no(`${found.length} milestones titled v2.0`, found);
      const m = found[0]!;
      if (m.state !== 'open') return no('milestone is closed', m);
      if (!m.due_on?.startsWith('2026-12-31')) return no(`due date is ${m.due_on}`, m);
      return ok('milestone v2.0 due 2026-12-31', m);
    },
  },
  {
    id: 'g06-relabel',
    instruction: 'The issue "Typo in README" in acme/webapp was labelled bug by mistake. Replace that label with docs.',
    start: `/${REPO}/issues`,
    user: 'alice',
    oracleDoc: 'The issue "Typo in README" has exactly the labels [docs] and is still open.',
    async reference(page) {
      await openIssue(page, 'Typo in README');
      await sidebarSelect(page, 'Labels', ['bug', 'docs']);
    },
    perturbations: [
      {
        name: 'perturbed-added-only',
        kind: 'partial',
        async run(page) {
          await openIssue(page, 'Typo in README');
          await sidebarSelect(page, 'Labels', ['docs']);
        },
      },
    ],
    async oracle() {
      const [i] = (await issueByTitle('Typo in README')).map(compactIssue);
      if (i?.labels.toSorted().join(',') !== 'docs') return no(`labels are [${i?.labels.join(', ')}]`, i);
      if (i.state !== 'open') return no('issue was closed', i);
      return ok('labelled docs only', i);
    },
  },
  {
    id: 'g07-star',
    instruction: 'Star the acme/docs repository.',
    start: '/',
    user: 'alice',
    oracleDoc: "alice's starred repositories are exactly the seeded acme/infra plus acme/docs.",
    async reference(page) {
      await page.goto(`${BASE}/acme/docs`);
      await page.locator('button[aria-label="Star"], form[action$="/action/star"] button').first().click();
      await page.waitForLoadState('load');
      await page.waitForTimeout(800);
    },
    perturbations: [
      {
        name: 'perturbed-starred-webapp',
        kind: 'wrong-item',
        async run(page) {
          await page.goto(`${BASE}/acme/webapp`);
          await page.locator('button[aria-label="Star"], form[action$="/action/star"] button').first().click();
          await page.waitForTimeout(800);
        },
      },
    ],
    async oracle() {
      const s = (await starred('alice')).map((r) => r.full_name).toSorted();
      if (s.join(',') !== 'acme/docs,acme/infra') return no(`starred: [${s.join(', ')}]`, s);
      return ok('acme/docs starred, nothing else changed', s);
    },
  },
  {
    id: 'g08-new-repo',
    instruction: 'Create a new private repository called "meeting-notes" under my account, initialized with a README.',
    start: '/',
    user: 'alice',
    oracleDoc: 'alice/meeting-notes exists, is private and is not empty (it has an initial commit).',
    async reference(page) {
      await page.goto(`${BASE}/repo/create`);
      await page.locator('input[name=repo_name]').fill('meeting-notes');
      await page.locator('input[name=private]').check({ force: true });
      await page.locator('input[name=auto_init]').check({ force: true });
      await Promise.all([
        page.waitForURL(/\/alice\/meeting-notes$/),
        page.getByRole('button', { name: 'Create Repository' }).click(),
      ]);
    },
    perturbations: [
      {
        name: 'perturbed-public',
        kind: 'partial',
        async run(page) {
          await page.goto(`${BASE}/repo/create`);
          await page.locator('input[name=repo_name]').fill('meeting-notes');
          await page.locator('input[name=auto_init]').check({ force: true });
          await Promise.all([
            page.waitForURL(/\/alice\/meeting-notes$/),
            page.getByRole('button', { name: 'Create Repository' }).click(),
          ]);
        },
      },
    ],
    async oracle() {
      const r = (await userRepos('alice')).find((x) => x.full_name === 'alice/meeting-notes');
      if (!r) return no('alice/meeting-notes does not exist');
      const facts = { private: r.private, empty: r.empty };
      if (!r.private) return no('repository is public', facts);
      if (r.empty) return no('repository is empty (no README)', facts);
      return ok('private, initialized', facts);
    },
  },
  {
    id: 'g09-filter-bugs',
    instruction: 'Show me the open issues in acme/webapp that are labelled bug.',
    start: `/${REPO}`,
    user: 'alice',
    oracleDoc:
      "The final page is acme/webapp's issue list filtered to exactly the bug label, showing open issues (state open or unset).",
    skipVariants: [],
    async reference(page) {
      await page.goto(`${BASE}/${REPO}/issues`);
      await page.locator('.list-header-label, .ui.dropdown.label-filter').filter({ hasText: 'Label' }).first().click();
      await page
        .locator('.menu.visible .item, .menu .item')
        .filter({ hasText: /^\s*bug\b/ })
        .first()
        .click();
      await page.waitForURL(/labels=\d+/);
    },
    perturbations: [
      {
        name: 'perturbed-all-states',
        kind: 'partial',
        async run(page) {
          const ids = await labelIds();
          await page.goto(`${BASE}/${REPO}/issues?state=all&labels=${ids.bug}`);
        },
      },
    ],
    async oracle(_app, end) {
      const u = new URL(end.url);
      const ids = await labelIds();
      const facts = { path: u.pathname, state: u.searchParams.get('state'), labels: u.searchParams.get('labels') };
      if (u.pathname !== `/${REPO}/issues`) return no('not on the issue list', facts);
      if ((u.searchParams.get('labels') ?? '') !== String(ids.bug)) return no('label filter is not exactly bug', facts);
      if (!['', 'open'].includes(u.searchParams.get('state') ?? '')) return no('not showing open issues', facts);
      return ok('open issues filtered by bug', facts);
    },
  },
  {
    id: 'g10-reopen-milestone',
    instruction: 'Reopen the issue "Session expires too early" in acme/webapp and put it in the v1.1 milestone.',
    start: `/${REPO}/issues`,
    user: 'alice',
    oracleDoc: 'The issue "Session expires too early" is open and its milestone is v1.1.',
    async reference(page) {
      await openIssue(page, 'Session expires too early');
      await page.getByRole('button', { name: 'Reopen', exact: true }).click();
      await page.getByRole('button', { name: 'Close Issue' }).waitFor();
      await sidebarSelect(page, 'Milestone', ['v1.1']);
    },
    perturbations: [
      {
        name: 'perturbed-reopened-only',
        kind: 'partial',
        async run(page) {
          await openIssue(page, 'Session expires too early');
          await page.getByRole('button', { name: 'Reopen', exact: true }).click();
          await page.getByRole('button', { name: 'Close Issue' }).waitFor();
        },
      },
    ],
    async oracle() {
      const [i] = (await issueByTitle('Session expires too early')).map(compactIssue);
      if (i?.state !== 'open') return no('issue is not open', i);
      if (i.milestone !== 'v1.1') return no(`milestone is ${i.milestone}`, i);
      return ok('open, in v1.1', i);
    },
  },
  {
    id: 'g11-repo-description',
    instruction: 'Change the description of my dotfiles repository to "Shell and editor configuration".',
    start: '/',
    user: 'alice',
    oracleDoc: 'alice/dotfiles has the description "Shell and editor configuration" (final period optional).',
    async reference(page) {
      await page.goto(`${BASE}/alice/dotfiles/settings`);
      await page
        .locator('textarea[name=description], input[name=description]')
        .first()
        .fill('Shell and editor configuration');
      await page.getByRole('button', { name: 'Update Settings' }).first().click();
      await page.waitForLoadState('load');
    },
    perturbations: [
      {
        name: 'perturbed-website-field',
        kind: 'wrong-item',
        async run(page) {
          await page.goto(`${BASE}/alice/dotfiles/settings`);
          await page.locator('input[name=website]').fill('https://example.com/shell-and-editor-configuration');
          await page.getByRole('button', { name: 'Update Settings' }).first().click();
          await page.waitForLoadState('load');
        },
      },
    ],
    async oracle() {
      const r = (await userRepos('alice')).find((x) => x.full_name === 'alice/dotfiles');
      const d = r?.description ?? '';
      if (prose(d) !== 'Shell and editor configuration') return no(`description is ${JSON.stringify(d)}`, d);
      return ok('description updated', d);
    },
  },
];

// Multi-step tasks, added after the first agent runs were all correct (ADR 0009).
TASKS.push(
  {
    id: 'g12-answer-and-close',
    instruction:
      'Answer the question about resetting an API token in acme/webapp with the comment "Go to Settings > Applications to regenerate it." and then close that issue.',
    start: `/${REPO}/issues`,
    user: 'alice',
    oracleDoc:
      'Issue "How do I reset my API token?" is closed and has exactly one comment by alice with the dictated text (final period optional); alice commented nowhere else.',
    async reference(page) {
      await openIssue(page, 'How do I reset my API token?');
      await page.locator('#comment-form textarea').fill('Go to Settings > Applications to regenerate it.');
      await page.getByRole('button', { name: 'Comment', exact: true }).click();
      await page.getByText('Go to Settings > Applications to regenerate it.').first().waitFor();
      await page.getByRole('button', { name: 'Close Issue' }).click();
      await page.getByRole('button', { name: 'Reopen', exact: true }).waitFor();
    },
    perturbations: [
      {
        name: 'perturbed-not-closed',
        kind: 'partial',
        async run(page) {
          await openIssue(page, 'How do I reset my API token?');
          await page.locator('#comment-form textarea').fill('Go to Settings > Applications to regenerate it.');
          await page.getByRole('button', { name: 'Comment', exact: true }).click();
          await page.getByText('Go to Settings > Applications to regenerate it.').first().waitFor();
        },
      },
    ],
    async oracle() {
      const [i] = await issueByTitle('How do I reset my API token?');
      const mine = (await comments())
        .filter((c) => c.user.login === 'alice')
        .map((c) => ({ issue: Number(c.issue_url.split('/').pop()), body: c.body }));
      const facts = { state: i?.state, comments: mine };
      const onTarget = mine.filter((c) => c.issue === i?.number);
      if (onTarget.length !== 1) return no(`${onTarget.length} comments by alice on the question`, facts);
      if (prose(onTarget[0]!.body) !== 'Go to Settings > Applications to regenerate it')
        return no('comment text differs', facts);
      if (mine.length !== 1) return no('alice also commented elsewhere', facts);
      if (i?.state !== 'closed') return no('question is still open', facts);
      return ok('answered and closed', facts);
    },
  },
  {
    id: 'g13-assign-open-bugs',
    instruction: 'Assign every open bug in acme/webapp that has no assignee yet to dave.',
    start: `/${REPO}/issues`,
    user: 'alice',
    oracleDoc:
      'The five open issues labelled bug that were seeded without an assignee have exactly [dave]; every other issue keeps its seeded assignees.',
    async reference(page) {
      for (const t of UNASSIGNED_OPEN_BUGS) {
        await openIssue(page, t);
        await sidebarSelect(page, 'Assignees', ['dave']);
      }
    },
    perturbations: [
      {
        name: 'perturbed-three-of-five',
        kind: 'partial',
        async run(page) {
          for (const t of UNASSIGNED_OPEN_BUGS.slice(0, 3)) {
            await openIssue(page, t);
            await sidebarSelect(page, 'Assignees', ['dave']);
          }
        },
      },
    ],
    async oracle() {
      const all = (await issues()).map(compactIssue);
      const bad = all.filter((i) => {
        const want = UNASSIGNED_OPEN_BUGS.includes(i.title)
          ? ['dave']
          : (ISSUES.find((s) => s.title === i.title)?.assignees ?? []);
        return i.assignees.toSorted().join(',') !== want.toSorted().join(',');
      });
      const facts = all.map((i) => [i.title, i.assignees.join(',')]);
      if (bad.length) return no(`wrong assignees on: ${bad.map((b) => b.title).join(', ')}`, facts);
      return ok('all five open unassigned bugs assigned to dave', facts);
    },
  },
  {
    id: 'g14-move-milestone',
    instruction: 'Create a milestone "v1.2" in acme/webapp and move every open issue of milestone v1.1 into it.',
    start: `/${REPO}/issues`,
    user: 'alice',
    oracleDoc:
      'Exactly one milestone v1.2 exists; "Add CSV export" and "Upgrade to Node 24" (the open v1.1 issues) are in v1.2; no open issue is left in v1.1 and no other issue changed milestone.',
    async reference(page) {
      await page.goto(`${BASE}/${REPO}/milestones/new`);
      await page.locator('input[name=title]').fill('v1.2');
      await Promise.all([
        page.waitForURL(/\/milestones$/),
        page.getByRole('button', { name: 'Create Milestone' }).click(),
      ]);
      for (const t of ['Add CSV export', 'Upgrade to Node 24']) {
        await openIssue(page, t);
        await sidebarSelect(page, 'Milestone', ['v1.2']);
      }
    },
    perturbations: [
      {
        name: 'perturbed-moved-one',
        kind: 'partial',
        async run(page) {
          await page.goto(`${BASE}/${REPO}/milestones/new`);
          await page.locator('input[name=title]').fill('v1.2');
          await Promise.all([
            page.waitForURL(/\/milestones$/),
            page.getByRole('button', { name: 'Create Milestone' }).click(),
          ]);
          await openIssue(page, 'Add CSV export');
          await sidebarSelect(page, 'Milestone', ['v1.2']);
        },
      },
    ],
    async oracle() {
      const ms = (await milestones()).filter((m) => m.title.trim() === 'v1.2');
      const all = (await issues()).map(compactIssue);
      const moved = new Set(['Add CSV export', 'Upgrade to Node 24']);
      const facts = { milestones: ms.length, issues: all.map((i) => [i.title, i.state, i.milestone]) };
      if (ms.length !== 1) return no(`${ms.length} milestones v1.2`, facts);
      const wrong = all.filter((i) => {
        const seeded = ISSUES.find((s) => s.title === i.title)?.milestone ?? null;
        return (moved.has(i.title) ? 'v1.2' : seeded) !== i.milestone;
      });
      if (wrong.length) return no(`wrong milestone on: ${wrong.map((w) => w.title).join(', ')}`, facts);
      return ok('v1.2 holds the open v1.1 issues', facts);
    },
  },
);

const UNASSIGNED_OPEN_BUGS = ISSUES.filter(
  (i) => i.labels.includes('bug') && !i.closed && !(i.assignees ?? []).length,
).map((i) => i.title);

/** Seeded open/closed state per issue title (for "nothing else changed" in g02). */
const SEEDED_STATE = new Map(ISSUES.map((i) => [i.title, i.closed ? 'closed' : 'open']));

export const gitea: RealApp = {
  name: 'gitea',
  title: 'Gitea 1.22 (Git forge: repositories, issues, labels, milestones)',
  baseURL: BASE,
  start,
  reset,
  stop: () => removeContainer(CONTAINER),
  signIn,
  probes,
  tasks: TASKS,
};
