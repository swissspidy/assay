/**
 * WordPress 6.6 (CMS; the agent works in wp-admin, including the block editor,
 * whose canvas is an iframe). MariaDB + the official image; installed and seeded
 * with WP-CLI, reset by restoring a database dump.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import {
  docker,
  ensureNetwork,
  mariadbQuery,
  removeContainer,
  sh,
  sqlStr,
  waitFor,
  waitHttp,
  workDir,
} from '../lib/sh.ts';
import type { OracleResult, RealApp, RealTask } from '../lib/types.ts';

const NET = 'assay-real';
const DB = 'assay-real-wp-db';
const WEB = 'assay-real-wp';
const PORT = Number(process.env.ASSAY_WORDPRESS_PORT ?? 4320);
const BASE = `http://localhost:${PORT}`;
export const PASSWORD = 'Assay-admin-1';
const DB_ENV = [
  '-e',
  `WORDPRESS_DB_HOST=${DB}`,
  '-e',
  'WORDPRESS_DB_USER=root',
  '-e',
  'WORDPRESS_DB_PASSWORD=root',
  '-e',
  'WORDPRESS_DB_NAME=wordpress',
];
const CONFIG_EXTRA = [
  "define('WP_ENVIRONMENT_TYPE', 'local');",
  "define('DISABLE_WP_CRON', true);",
  "define('AUTOMATIC_UPDATER_DISABLED', true);",
  "define('WP_HTTP_BLOCK_EXTERNAL', true);",
].join(' ');

// --- seed --------------------------------------------------------------------

/** Run with `wp eval-file`: users, categories, tags, posts, pages, comments, settings. */
const SEED_PHP = String.raw`<?php
update_option('blogdescription', 'Notes on verifying web agents');
update_option('posts_per_page', 10);
update_option('timezone_string', 'UTC');
update_option('permalink_structure', '/%postname%/');
foreach ([['maria','Editor','editor'],['tom','Tom','author']] as $u) {
  wp_insert_user(['user_login'=>$u[0],'user_pass'=>'Assay-user-1','user_email'=>$u[0].'@example.com','display_name'=>$u[1],'role'=>$u[2]]);
}
$cat = [];
foreach (['News','Tutorials','Events'] as $c) { $cat[$c] = wp_insert_term($c, 'category')['term_id']; }
foreach (['release','community','performance'] as $t) { wp_insert_term($t, 'post_tag'); }
$admin = get_user_by('login','admin')->ID;
$tom = get_user_by('login','tom')->ID;
$posts = [
  ['Getting started with Assay', 'Install the package, capture a snapshot and run your first check set.', 'Tutorials', [], 'publish', $admin, '2026-10-01 09:00:00'],
  ['Writing your first check', 'A check reads one piece of evidence and compares it with what the task asked for.', 'News', [], 'publish', $tom, '2026-10-05 09:00:00'],
  ['Flaky tests and how to avoid them', 'Wait for outcomes, not for time. Poll the evidence instead of sleeping.', 'Tutorials', ['performance'], 'publish', $tom, '2026-10-08 09:00:00'],
  ['Old pricing announcement', 'Our pricing changes on November 1. This post is out of date.', 'News', [], 'publish', $admin, '2026-09-01 09:00:00'],
  ['Community call: November', 'Join the community call on November 20 at 16:00 UTC.', 'Events', ['community'], 'publish', $admin, '2026-10-20 09:00:00'],
  ['Release 0.1 notes', 'The first public release of Assay.', 'News', ['release'], 'publish', $admin, '2026-10-10 09:00:00'],
  ['Why outcome verification matters', 'Agents report success; the page may say otherwise.', 'News', [], 'publish', $tom, '2026-10-12 09:00:00'],
  ['Spring meetup recap', 'Thanks to everyone who came to the spring meetup. Slides are linked below.', 'Events', ['community'], 'draft', $tom, '2026-10-25 09:00:00'],
  ['Roadmap 2027', 'What we plan to build next year.', 'News', [], 'draft', $admin, '2026-10-26 09:00:00'],
  ['Pricing update for teams', 'New team plans start on December 1.', 'News', [], 'draft', $admin, '2026-10-27 09:00:00'],
];
$ids = [];
foreach ($posts as $p) {
  $ids[$p[0]] = wp_insert_post(['post_title'=>$p[0], 'post_content'=>'<!-- wp:paragraph --><p>'.$p[1].'</p><!-- /wp:paragraph -->', 'post_status'=>$p[4], 'post_author'=>$p[5], 'post_date'=>$p[6], 'post_category'=>[$cat[$p[2]]], 'tags_input'=>$p[3]]);
}
wp_delete_post(1, true); // "Hello world!"
foreach ([['About','Assay is an open source project.'],['Contact','Write to hello@example.com.']] as $pg) {
  wp_insert_post(['post_title'=>$pg[0],'post_content'=>'<!-- wp:paragraph --><p>'.$pg[1].'</p><!-- /wp:paragraph -->','post_status'=>'publish','post_type'=>'page','post_author'=>$admin]);
}
wp_delete_post(2, true); // "Sample Page"
$comments = [
  ['Getting started with Assay', 'Lee', 'Clear and short, thank you.', 1, '2026-10-02 10:00:00'],
  ['Getting started with Assay', 'Dana', 'Thanks, this helped me set up my first project!', 0, '2026-10-03 11:00:00'],
  ['Getting started with Assay', 'Cheap Watches', 'Best replica watches at unbeatable prices, visit our shop now!!!', 0, '2026-10-03 12:00:00'],
  ['Flaky tests and how to avoid them', 'Sam', 'Great tips. Polling fixed half of our flaky tests.', 0, '2026-10-09 08:00:00'],
  ['Flaky tests and how to avoid them', 'Priya', 'Do you have an example for network waits?', 1, '2026-10-09 09:00:00'],
  ['Why outcome verification matters', 'Dana', 'Agreed, we saw the same with our agents.', 0, '2026-10-13 10:00:00'],
];
foreach ($comments as $c) {
  wp_insert_comment(['comment_post_ID'=>$ids[$c[0]], 'comment_author'=>$c[1], 'comment_author_email'=>strtolower(str_replace(' ','',$c[1])).'@example.org', 'comment_content'=>$c[2], 'comment_approved'=>$c[3], 'comment_date'=>$c[4], 'comment_date_gmt'=>$c[4]]);
}
// The block editor's welcome guide is dismissed, as for anyone who has used it before.
update_user_meta($admin, $GLOBALS['wpdb']->get_blog_prefix().'persisted_preferences', ['core/edit-post'=>['welcomeGuide'=>false], 'core'=>['isComplementaryAreaVisible'=>true], '_modified'=>'2026-10-01T00:00:00.000Z']);
$app = WP_Application_Passwords::create_new_application_password($admin, ['name'=>'assay-probes']);
file_put_contents('/seed/app-password.txt', $app[0]);
`;

const dumpFile = () => join(workDir('wordpress'), 'pristine.sql');
const appPasswordFile = () => join(workDir('wordpress', 'seed'), 'app-password.txt');

async function wp(...args: string[]): Promise<string> {
  const { stdout } = await sh('docker', [
    'run',
    '--rm',
    '--network',
    NET,
    '--volumes-from',
    WEB,
    '-v',
    `${workDir('wordpress', 'seed')}:/seed`,
    '--user',
    '33:33',
    ...DB_ENV,
    'wordpress:cli-2.11',
    'wp',
    ...args,
  ]);
  return stdout;
}

async function startContainers(): Promise<void> {
  await ensureNetwork(NET);
  await removeContainer(WEB);
  await removeContainer(DB);
  await docker(
    'run',
    '-d',
    '--name',
    DB,
    '--network',
    NET,
    '-e',
    'MARIADB_ROOT_PASSWORD=root',
    '-e',
    'MARIADB_DATABASE=wordpress',
    'mariadb:11.4',
  );
  await waitFor('wordpress db', () => mariadbQuery(DB, 'wordpress', 'SELECT 1'));
}

async function startWeb(): Promise<void> {
  await docker(
    'run',
    '-d',
    '--name',
    WEB,
    '--network',
    NET,
    '-p',
    `${PORT}:80`,
    ...DB_ENV,
    '-e',
    `WORDPRESS_CONFIG_EXTRA=${CONFIG_EXTRA}`,
    'wordpress:6.6-apache',
  );
  await waitHttp(`${BASE}/wp-login.php`);
}

async function restore(): Promise<void> {
  await sh('docker', ['exec', '-i', DB, 'mariadb', '-uroot', '-proot', 'wordpress'], {
    input: readFileSync(dumpFile(), 'utf8'),
  });
}

async function start(): Promise<void> {
  await startContainers();
  if (!existsSync(dumpFile())) {
    await startWeb();
    await wp(
      'core',
      'install',
      `--url=${BASE}`,
      '--title=Assay Journal',
      '--admin_user=admin',
      `--admin_password=${PASSWORD}`,
      '--admin_email=admin@example.com',
      '--skip-email',
    );
    writeFileSync(join(workDir('wordpress', 'seed'), 'seed.php'), SEED_PHP);
    await sh('chmod', ['777', workDir('wordpress', 'seed')]);
    await wp('eval-file', '/seed/seed.php');
    await wp('rewrite', 'flush');
    const { stdout } = await sh('docker', [
      'exec',
      DB,
      'mariadb-dump',
      '-uroot',
      '-proot',
      '--skip-dump-date',
      'wordpress',
    ]);
    writeFileSync(dumpFile(), stdout);
  } else {
    await restore();
    await startWeb();
  }
}

async function reset(): Promise<void> {
  await restore();
}

async function stop(): Promise<void> {
  await removeContainer(WEB);
  await removeContainer(DB);
}

// --- backend reads -----------------------------------------------------------

async function rest<T = unknown>(path: string): Promise<T> {
  const auth = Buffer.from(`admin:${readFileSync(appPasswordFile(), 'utf8').trim()}`).toString('base64');
  const r = await fetch(`${BASE}/wp-json${path}`, { headers: { authorization: `Basic ${auth}` } });
  if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}

const q = (sql: string) => mariadbQuery(DB, 'wordpress', sql);

/** Posts (any status) with their categories and tags, straight from the database (oracle side). */
async function dbPosts(): Promise<
  { id: number; title: string; status: string; categories: string[]; tags: string[]; content: string }[]
> {
  const rows = await q(
    `SELECT p.ID id, p.post_title title, p.post_status status, p.post_content content,
       (SELECT GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR '|') FROM wp_term_relationships r JOIN wp_term_taxonomy tt USING (term_taxonomy_id) JOIN wp_terms t USING (term_id) WHERE r.object_id = p.ID AND tt.taxonomy = 'category') cats,
       (SELECT GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR '|') FROM wp_term_relationships r JOIN wp_term_taxonomy tt USING (term_taxonomy_id) JOIN wp_terms t USING (term_id) WHERE r.object_id = p.ID AND tt.taxonomy = 'post_tag') tags
     FROM wp_posts p WHERE p.post_type = 'post' AND p.post_status <> 'auto-draft' AND p.post_status <> 'inherit' ORDER BY p.ID`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    title: r.title ?? '',
    status: r.status ?? '',
    categories: r.cats ? r.cats.split('|') : [],
    tags: r.tags ? r.tags.split('|') : [],
    content: (r.content ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  }));
}

async function dbComments(): Promise<{ id: number; post: string; author: string; status: string; content: string }[]> {
  const rows = await q(
    `SELECT c.comment_ID id, p.post_title post, c.comment_author author, c.comment_approved status, c.comment_content content
     FROM wp_comments c JOIN wp_posts p ON p.ID = c.comment_post_ID ORDER BY c.comment_ID`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    post: r.post ?? '',
    author: r.author ?? '',
    status: r.status ?? '',
    content: r.content ?? '',
  }));
}

const option = async (name: string) =>
  (await q(`SELECT option_value v FROM wp_options WHERE option_name = ${sqlStr(name)}`))[0]?.v ?? null;

// --- browser -----------------------------------------------------------------

async function signIn(context: BrowserContext, user: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(`${BASE}/wp-login.php`);
  await page.locator('#user_login').fill(user);
  await page.locator('#user_pass').fill(user === 'admin' ? PASSWORD : 'Assay-user-1');
  await Promise.all([page.waitForURL(/wp-admin/), page.locator('#wp-submit').click()]);
  await page.close();
}

const text = (s: string, n = 200) => {
  const t = s
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

type Term = { id: number; name: string; slug: string; parent: number; count: number };
const termName = (list: Term[], id: number) => list.find((t) => t.id === id)?.name ?? String(id);
const terms = (tax: 'categories' | 'tags') => rest<Term[]>(`/wp/v2/${tax}?per_page=100&context=edit`);

function probes(): Record<string, () => Promise<unknown>> {
  return {
    posts: async () => {
      const [cats, tags] = await Promise.all([terms('categories'), terms('tags')]);
      const posts = await rest<
        {
          id: number;
          title: { raw: string };
          status: string;
          categories: number[];
          tags: number[];
          content: { raw: string };
        }[]
      >(
        '/wp/v2/posts?status=publish,future,draft,pending,private,trash&per_page=100&context=edit&orderby=id&order=asc',
      );
      return posts.map((p) => ({
        id: p.id,
        title: p.title.raw,
        status: p.status,
        categories: p.categories.map((c) => termName(cats, c)),
        tags: p.tags.map((t) => termName(tags, t)),
        excerpt: text(p.content.raw, 120),
      }));
    },
    comments: async () => {
      const out: unknown[] = [];
      for (const status of ['approve', 'hold', 'spam', 'trash']) {
        const cs = await rest<
          { id: number; post: number; author_name: string; status: string; content: { raw: string } }[]
        >(`/wp/v2/comments?status=${status}&per_page=100&context=edit`);
        out.push(
          ...cs.map((c) => ({
            id: c.id,
            post: c.post,
            author: c.author_name,
            status: c.status,
            content: text(c.content.raw, 80),
          })),
        );
      }
      return (out as { id: number }[]).toSorted((a, b) => a.id - b.id);
    },
    categories: async () => (await terms('categories')).map((t) => ({ name: t.name, slug: t.slug, parent: t.parent })),
    settings: async () => {
      const s = await rest<{ title: string; description: string; posts_per_page: number }>('/wp/v2/settings');
      return { title: s.title, description: s.description, posts_per_page: s.posts_per_page };
    },
    users: async () =>
      (
        await rest<{ username: string; email: string; roles: string[] }[]>('/wp/v2/users?context=edit&per_page=100')
      ).map((u) => ({
        username: u.username,
        email: u.email,
        roles: u.roles,
      })),
  };
}

// --- tasks -------------------------------------------------------------------

const ok = (reason: string, facts?: unknown): OracleResult => ({ success: true, reason, facts });
const no = (reason: string, facts?: unknown): OracleResult => ({ success: false, reason, facts });
const SEEDED_STATUS: Record<string, string> = {
  'Spring meetup recap': 'draft',
  'Roadmap 2027': 'draft',
  'Pricing update for teams': 'draft',
};
/** Posts whose status differs from the seed, other than `except`. */
async function otherStatusChanges(except: string) {
  return (await dbPosts()).filter((p) => p.title !== except && (SEEDED_STATUS[p.title] ?? 'publish') !== p.status);
}

const postRow = (page: Page, title: string) =>
  page.locator('#the-list tr').filter({ has: page.locator('a.row-title', { hasText: title }) });

async function openPostRow(page: Page, title: string): Promise<void> {
  await page.goto(`${BASE}/wp-admin/edit.php?post_type=post&post_status=all`);
  await postRow(page, title).hover();
}

async function quickEdit(page: Page, title: string, edit: (row: ReturnType<Page['locator']>) => Promise<unknown>) {
  await openPostRow(page, title);
  const row = postRow(page, title);
  await row.locator('button.editinline').click();
  const form = page.locator('#the-list tr.inline-edit-row');
  await edit(form);
  await form.getByRole('button', { name: 'Update' }).click();
  await page.locator('#the-list tr.inline-edit-row').waitFor({ state: 'detached' });
}

async function commentAction(page: Page, author: string, action: 'Approve' | 'Spam') {
  await page.goto(`${BASE}/wp-admin/edit-comments.php?comment_status=moderated`);
  const row = page.locator('#the-comment-list tr').filter({ hasText: author });
  await row.first().hover();
  await row.first().locator(`.row-actions .${action.toLowerCase()} a`).first().click();
  await page.waitForTimeout(1500);
}

async function newPost(page: Page, o: { title: string; body: string; category: string }) {
  await page.goto(`${BASE}/wp-admin/post-new.php`);
  const canvas = page.frameLocator('iframe[name="editor-canvas"]');
  await canvas.getByRole('textbox', { name: 'Add title' }).fill(o.title);
  await canvas.getByRole('textbox', { name: 'Add title' }).press('Enter');
  await page.keyboard.type(o.body);
  await page.getByRole('tab', { name: 'Post', exact: true }).click();
  const box = page.getByRole('checkbox', { name: o.category, exact: true });
  if (!(await box.isVisible())) await page.getByRole('button', { name: 'Categories', exact: true }).click();
  await box.check();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page
    .getByRole('region', { name: 'Editor publish' })
    .getByRole('button', { name: 'Publish', exact: true })
    .click();
  await page.getByText('is now live').first().waitFor();
}

const TASKS: RealTask[] = [
  {
    id: 'w01-publish-draft',
    instruction: 'Publish the draft post "Spring meetup recap".',
    start: '/wp-admin/',
    user: 'admin',
    oracleDoc: 'The post "Spring meetup recap" has status publish; no other post changed status.',
    async reference(page) {
      await quickEdit(page, 'Spring meetup recap', (form) =>
        form.locator('select[name=_status]').selectOption('publish'),
      );
    },
    perturbations: [
      {
        name: 'perturbed-pending-review',
        kind: 'wrong-item',
        async run(page) {
          await quickEdit(page, 'Spring meetup recap', (form) =>
            form.locator('select[name=_status]').selectOption('pending'),
          );
        },
      },
    ],
    async oracle() {
      const p = (await dbPosts()).find((x) => x.title === 'Spring meetup recap');
      const others = await otherStatusChanges('Spring meetup recap');
      const facts = { status: p?.status, others: others.map((o) => [o.title, o.status]) };
      if (p?.status !== 'publish') return no(`status is ${p?.status}`, facts);
      if (others.length) return no('other posts changed status', facts);
      return ok('published, nothing else changed', facts);
    },
  },
  {
    id: 'w02-category',
    instruction: 'Create a new post category named "Case Studies" with the slug case-studies.',
    start: '/wp-admin/',
    user: 'admin',
    oracleDoc: 'Exactly one category is named "Case Studies"; its slug is case-studies and it has no parent.',
    async reference(page) {
      await page.goto(`${BASE}/wp-admin/edit-tags.php?taxonomy=category`);
      await page.locator('#tag-name').fill('Case Studies');
      await page.locator('#tag-slug').fill('case-studies');
      await page.locator('#submit').click();
      await page.locator('#the-list a.row-title', { hasText: 'Case Studies' }).first().waitFor();
    },
    perturbations: [
      {
        name: 'perturbed-tag-instead',
        kind: 'wrong-item',
        async run(page) {
          await page.goto(`${BASE}/wp-admin/edit-tags.php?taxonomy=post_tag`);
          await page.locator('#tag-name').fill('Case Studies');
          await page.locator('#tag-slug').fill('case-studies');
          await page.locator('#submit').click();
          await page.locator('#the-list a.row-title', { hasText: 'Case Studies' }).first().waitFor();
        },
      },
    ],
    async oracle() {
      const rows = await q(
        `SELECT t.name, t.slug, tt.parent FROM wp_terms t JOIN wp_term_taxonomy tt USING (term_id) WHERE tt.taxonomy = 'category' AND t.name = 'Case Studies'`,
      );
      if (rows.length !== 1) return no(`${rows.length} categories named Case Studies`, rows);
      if (rows[0]!.slug !== 'case-studies') return no(`slug is ${rows[0]!.slug}`, rows);
      if (rows[0]!.parent !== '0') return no('category has a parent', rows);
      return ok('category created', rows);
    },
  },
  {
    id: 'w03-approve-comment',
    instruction: 'Approve the pending comment by Dana on the post "Getting started with Assay".',
    start: '/wp-admin/',
    user: 'admin',
    oracleDoc:
      'Dana\'s comment on "Getting started with Assay" is approved; every other comment keeps its seeded status (Dana\'s other pending comment stays pending).',
    async reference(page) {
      await page.goto(`${BASE}/wp-admin/edit-comments.php?comment_status=moderated`);
      const row = page.locator('#the-comment-list tr').filter({ hasText: 'Thanks, this helped me' });
      await row.hover();
      await row.locator('.row-actions .approve a').click();
      await page.waitForTimeout(1500);
    },
    perturbations: [
      {
        name: 'perturbed-other-dana-comment',
        kind: 'wrong-item',
        async run(page) {
          await page.goto(`${BASE}/wp-admin/edit-comments.php?comment_status=moderated`);
          const row = page.locator('#the-comment-list tr').filter({ hasText: 'Agreed, we saw the same' });
          await row.hover();
          await row.locator('.row-actions .approve a').click();
          await page.waitForTimeout(1500);
        },
      },
    ],
    async oracle() {
      const cs = await dbComments();
      const seeded: Record<string, string> = { Lee: '1', Priya: '1' };
      const target = cs.find((c) => c.author === 'Dana' && c.post === 'Getting started with Assay');
      const changed = cs.filter((c) => c !== target && (seeded[c.author] ?? '0') !== c.status);
      const facts = { target: target?.status, changed: changed.map((c) => [c.author, c.post, c.status]) };
      if (target?.status !== '1') return no(`target status is ${target?.status}`, facts);
      if (changed.length) return no('other comments changed status', facts);
      return ok('approved, nothing else changed', facts);
    },
  },
  {
    id: 'w04-spam-comment',
    instruction: 'Mark the comment that advertises watches as spam.',
    start: '/wp-admin/',
    user: 'admin',
    oracleDoc: 'The "Cheap Watches" comment has status spam; every other comment keeps its seeded status.',
    async reference(page) {
      await commentAction(page, 'Cheap Watches', 'Spam');
    },
    perturbations: [
      {
        name: 'perturbed-trashed',
        kind: 'wrong-item',
        async run(page) {
          await page.goto(`${BASE}/wp-admin/edit-comments.php?comment_status=moderated`);
          const row = page.locator('#the-comment-list tr').filter({ hasText: 'Cheap Watches' });
          await row.hover();
          await row.locator('.row-actions .trash a').click();
          await page.waitForTimeout(1500);
        },
      },
    ],
    async oracle() {
      const cs = await dbComments();
      const seeded: Record<string, string> = { Lee: '1', Priya: '1' };
      const target = cs.find((c) => c.author === 'Cheap Watches');
      const changed = cs.filter((c) => c !== target && (seeded[c.author] ?? '0') !== c.status);
      const facts = { target: target?.status, changed: changed.map((c) => [c.author, c.post, c.status]) };
      if (target?.status !== 'spam') return no(`target status is ${target?.status}`, facts);
      if (changed.length) return no('other comments changed status', facts);
      return ok('spam, nothing else changed', facts);
    },
  },
  {
    id: 'w05-site-title',
    instruction: 'Change the site title to "Assay Field Notes".',
    start: '/wp-admin/',
    user: 'admin',
    oracleDoc: 'Option blogname is exactly "Assay Field Notes" and the tagline is unchanged.',
    async reference(page) {
      await page.goto(`${BASE}/wp-admin/options-general.php`);
      await page.locator('#blogname').fill('Assay Field Notes');
      await page.locator('#submit').click();
      await page.getByText('Settings saved.').waitFor();
    },
    perturbations: [
      {
        name: 'perturbed-tagline',
        kind: 'wrong-item',
        async run(page) {
          await page.goto(`${BASE}/wp-admin/options-general.php`);
          await page.locator('#blogdescription').fill('Assay Field Notes');
          await page.locator('#submit').click();
          await page.getByText('Settings saved.').waitFor();
        },
      },
    ],
    async oracle() {
      const facts = { blogname: await option('blogname'), blogdescription: await option('blogdescription') };
      if (facts.blogname !== 'Assay Field Notes') return no(`title is ${JSON.stringify(facts.blogname)}`, facts);
      if (facts.blogdescription !== 'Notes on verifying web agents') return no('tagline changed', facts);
      return ok('title changed', facts);
    },
  },
  {
    id: 'w06-new-post',
    instruction:
      'Write and publish a new post titled "Release 0.2 is out" in the News category, with the text "Assay 0.2 adds per-row checks."',
    start: '/wp-admin/',
    user: 'admin',
    oracleDoc:
      'Exactly one post has that title; it is published, its categories are exactly [News] and its text contains the dictated sentence (final period optional).',
    async reference(page) {
      await newPost(page, { title: 'Release 0.2 is out', body: 'Assay 0.2 adds per-row checks.', category: 'News' });
    },
    perturbations: [
      {
        name: 'perturbed-uncategorized',
        kind: 'partial',
        async run(page) {
          await page.goto(`${BASE}/wp-admin/post-new.php`);
          const canvas = page.frameLocator('iframe[name="editor-canvas"]');
          await canvas.getByRole('textbox', { name: 'Add title' }).fill('Release 0.2 is out');
          await canvas.getByRole('textbox', { name: 'Add title' }).press('Enter');
          await page.keyboard.type('Assay 0.2 adds per-row checks.');
          await page.getByRole('button', { name: 'Publish', exact: true }).click();
          await page
            .getByRole('region', { name: 'Editor publish' })
            .getByRole('button', { name: 'Publish', exact: true })
            .click();
          await page.getByText('is now live').first().waitFor();
        },
      },
    ],
    async oracle() {
      const found = (await dbPosts()).filter((p) => p.title.trim() === 'Release 0.2 is out');
      if (found.length !== 1) return no(`${found.length} posts with that title`, found);
      const p = found[0]!;
      if (p.status !== 'publish') return no(`status is ${p.status}`, p);
      if (p.categories.join(',') !== 'News') return no(`categories are [${p.categories.join(', ')}]`, p);
      if (!p.content.includes('Assay 0.2 adds per-row checks')) return no('text missing', p);
      return ok('published in News with the text', p);
    },
  },
  {
    id: 'w07-trash-post',
    instruction: 'Move the post "Old pricing announcement" to the trash.',
    start: '/wp-admin/',
    user: 'admin',
    oracleDoc: 'The post "Old pricing announcement" has status trash; no other post changed status.',
    async reference(page) {
      await openPostRow(page, 'Old pricing announcement');
      const row = postRow(page, 'Old pricing announcement');
      await row.locator('.row-actions .trash a').click();
      await page.getByText('moved to the Trash').waitFor();
    },
    perturbations: [
      {
        name: 'perturbed-draft-instead',
        kind: 'wrong-item',
        async run(page) {
          await quickEdit(page, 'Old pricing announcement', (form) =>
            form.locator('select[name=_status]').selectOption('draft'),
          );
        },
      },
    ],
    async oracle() {
      const p = (await dbPosts()).find((x) => x.title === 'Old pricing announcement');
      const others = await otherStatusChanges('Old pricing announcement');
      const facts = { status: p?.status, others: others.map((o) => [o.title, o.status]) };
      if (p?.status !== 'trash') return no(`status is ${p?.status}`, facts);
      if (others.length) return no('other posts changed status', facts);
      return ok('trashed, nothing else changed', facts);
    },
  },
  {
    id: 'w08-recategorize',
    instruction: 'Move the post "Writing your first check" from the News category to Tutorials.',
    start: '/wp-admin/',
    user: 'admin',
    oracleDoc: 'The post "Writing your first check" has categories exactly [Tutorials] and is still published.',
    async reference(page) {
      await quickEdit(page, 'Writing your first check', async (form) => {
        await form.locator('.inline-edit-categories label').filter({ hasText: 'News' }).locator('input').uncheck();
        await form.locator('.inline-edit-categories label').filter({ hasText: 'Tutorials' }).locator('input').check();
      });
    },
    perturbations: [
      {
        name: 'perturbed-both-categories',
        kind: 'partial',
        async run(page) {
          await quickEdit(page, 'Writing your first check', async (form) => {
            await form
              .locator('.inline-edit-categories label')
              .filter({ hasText: 'Tutorials' })
              .locator('input')
              .check();
          });
        },
      },
    ],
    async oracle() {
      const p = (await dbPosts()).find((x) => x.title === 'Writing your first check');
      if (p?.categories.join(',') !== 'Tutorials') return no(`categories are [${p?.categories.join(', ')}]`, p);
      if (p.status !== 'publish') return no(`status is ${p.status}`, p);
      return ok('in Tutorials only', p);
    },
  },
  {
    id: 'w09-new-user',
    instruction: 'Add a new user with the username jordan, the email jordan@example.com and the Author role.',
    start: '/wp-admin/',
    user: 'admin',
    oracleDoc: 'A user jordan exists with email jordan@example.com and exactly the author role.',
    async reference(page) {
      await page.goto(`${BASE}/wp-admin/user-new.php`);
      await page.locator('#user_login').fill('jordan');
      await page.locator('#email').fill('jordan@example.com');
      await page.locator('#send_user_notification').uncheck();
      await page.locator('#role').selectOption('author');
      await page.locator('#createusersub').click();
      await page.waitForURL(/users\.php/);
    },
    perturbations: [
      {
        name: 'perturbed-subscriber',
        kind: 'partial',
        async run(page) {
          await page.goto(`${BASE}/wp-admin/user-new.php`);
          await page.locator('#user_login').fill('jordan');
          await page.locator('#email').fill('jordan@example.com');
          await page.locator('#send_user_notification').uncheck();
          await page.locator('#createusersub').click();
          await page.waitForURL(/users\.php/);
        },
      },
    ],
    async oracle() {
      const rows = await q(
        `SELECT u.user_login, u.user_email, m.meta_value caps FROM wp_users u LEFT JOIN wp_usermeta m ON m.user_id = u.ID AND m.meta_key = 'wp_capabilities' WHERE u.user_login = 'jordan'`,
      );
      const u = rows[0];
      if (!u) return no('no user jordan');
      const roles = [...(u.caps ?? '').matchAll(/s:\d+:"([a-z_]+)";b:1/g)].map((m) => m[1]);
      const facts = { email: u.user_email, roles };
      if (u.user_email !== 'jordan@example.com') return no(`email is ${u.user_email}`, facts);
      if (roles.join(',') !== 'author') return no(`roles are [${roles.join(', ')}]`, facts);
      return ok('author jordan created', facts);
    },
  },
  {
    id: 'w10-add-tag',
    instruction: 'Add the tag "testing" to the post "Flaky tests and how to avoid them".',
    start: '/wp-admin/',
    user: 'admin',
    oracleDoc:
      "The post's tags are exactly its seeded [performance] plus testing; its categories are unchanged ([Tutorials]) and it is still published.",
    async reference(page) {
      await quickEdit(page, 'Flaky tests and how to avoid them', async (form) => {
        const tags = form.locator('textarea[name="tax_input[post_tag]"]');
        await tags.fill(`${await tags.inputValue()}, testing`);
      });
    },
    perturbations: [
      {
        name: 'perturbed-replaced-tags',
        kind: 'over-completion',
        async run(page) {
          await quickEdit(page, 'Flaky tests and how to avoid them', async (form) => {
            await form.locator('textarea[name="tax_input[post_tag]"]').fill('testing');
          });
        },
      },
    ],
    async oracle() {
      const p = (await dbPosts()).find((x) => x.title === 'Flaky tests and how to avoid them');
      if (p?.tags.join(',') !== 'performance,testing') return no(`tags are [${p?.tags.join(', ')}]`, p);
      if (p.categories.join(',') !== 'Tutorials') return no(`categories are [${p.categories.join(', ')}]`, p);
      if (p.status !== 'publish') return no(`status is ${p.status}`, p);
      return ok('tag added', p);
    },
  },
  {
    id: 'w11-posts-per-page',
    instruction: 'Make the blog show at most 5 posts per page.',
    start: '/wp-admin/',
    user: 'admin',
    oracleDoc: 'Option posts_per_page is 5 (the RSS item count is not required).',
    async reference(page) {
      await page.goto(`${BASE}/wp-admin/options-reading.php`);
      await page.locator('#posts_per_page').fill('5');
      await page.locator('#submit').click();
      await page.getByText('Settings saved.').waitFor();
    },
    perturbations: [
      {
        name: 'perturbed-feed-count',
        kind: 'wrong-item',
        async run(page) {
          await page.goto(`${BASE}/wp-admin/options-reading.php`);
          await page.locator('#posts_per_rss').fill('5');
          await page.locator('#submit').click();
          await page.getByText('Settings saved.').waitFor();
        },
      },
    ],
    async oracle() {
      const v = await option('posts_per_page');
      if (v !== '5') return no(`posts_per_page is ${v}`, v);
      return ok('5 posts per page', v);
    },
  },
  {
    id: 'w12-filter-drafts',
    instruction: 'Show me the list of draft posts.',
    start: '/wp-admin/',
    user: 'admin',
    oracleDoc: 'The final page is the admin post list (edit.php, post type post) filtered to post_status=draft.',
    async reference(page) {
      await page.goto(`${BASE}/wp-admin/edit.php`);
      await page
        .locator('.subsubsub')
        .getByRole('link', { name: /^Drafts/ })
        .click();
      await page.waitForURL(/post_status=draft/);
    },
    perturbations: [
      {
        name: 'perturbed-pending',
        kind: 'wrong-item',
        async run(page) {
          await page.goto(`${BASE}/wp-admin/edit.php?post_status=pending&post_type=post`);
        },
      },
    ],
    async oracle(_app, end) {
      const u = new URL(end.url);
      const facts = {
        path: u.pathname,
        status: u.searchParams.get('post_status'),
        type: u.searchParams.get('post_type'),
      };
      if (u.pathname !== '/wp-admin/edit.php') return no('not on the post list', facts);
      if (!['', 'post'].includes(u.searchParams.get('post_type') ?? '')) return no('not the post list', facts);
      if (u.searchParams.get('post_status') !== 'draft') return no('not filtered to drafts', facts);
      return ok('draft list', facts);
    },
  },
];

// Multi-step tasks, added after the first agent runs were all correct (ADR 0009).
const REPLY = 'Yes, see the network waits section in the docs.';
const SEEDED_COMMENT_AUTHORS = new Set(['Lee', 'Dana', 'Cheap Watches', 'Sam', 'Priya']);
async function createCategory(page: Page, name: string): Promise<void> {
  await page.goto(`${BASE}/wp-admin/edit-tags.php?taxonomy=category`);
  await page.locator('#tag-name').fill(name);
  await page.locator('#submit').click();
  await page.locator('#the-list a.row-title', { hasText: name }).first().waitFor();
}
const checkCategory = (name: string) => async (form: ReturnType<Page['locator']>) => {
  await form.locator('.inline-edit-categories label').filter({ hasText: name }).locator('input').check();
};
async function schedule(page: Page, title: string, d: { mm: string; jj: string; aa: string; hh: string; mn: string }) {
  await quickEdit(page, title, async (form) => {
    await form.locator('select[name=mm]').selectOption(d.mm);
    await form.locator('input[name=jj]').fill(d.jj);
    await form.locator('input[name=aa]').fill(d.aa);
    await form.locator('input[name=hh]').fill(d.hh);
    await form.locator('input[name=mn]').fill(d.mn);
    await form.locator('select[name=_status]').selectOption('publish');
  });
}
TASKS.push(
  {
    id: 'w13-reply-comment',
    instruction: `Reply to Priya's question on the post "Flaky tests and how to avoid them" with: "${REPLY}"`,
    start: '/wp-admin/',
    user: 'admin',
    oracleDoc:
      "Exactly one new comment exists: by the admin, approved, a reply to Priya's comment (comment_parent), with the dictated text (final period optional); no other comment changed status.",
    async reference(page) {
      await page.goto(`${BASE}/wp-admin/edit-comments.php`);
      const row = page.locator('#the-comment-list tr').filter({ hasText: 'Do you have an example for network waits' });
      await row.hover();
      await row.locator('.row-actions .reply button, .row-actions .reply a').first().click();
      await page.locator('#replycontent').fill(REPLY);
      await page.locator('#replysubmit button.save, #replybtn').first().click();
      await page.locator('#the-comment-list').getByText(REPLY).first().waitFor();
    },
    perturbations: [
      {
        name: 'perturbed-top-level-comment',
        kind: 'wrong-item',
        async run(page) {
          await page.goto(`${BASE}/flaky-tests-and-how-to-avoid-them/`);
          await page.locator('#comment, textarea[name=comment]').first().fill(REPLY);
          await page.locator('#submit, .wp-block-post-comments-form input[type=submit]').first().click();
          await page.waitForLoadState('load');
        },
      },
    ],
    async oracle() {
      const rows = await q(
        `SELECT c.comment_ID id, c.comment_parent parent, c.user_id uid, c.comment_approved status, c.comment_content content, p.post_title post,
           (SELECT comment_author FROM wp_comments x WHERE x.comment_ID = c.comment_parent) parent_author
         FROM wp_comments c JOIN wp_posts p ON p.ID = c.comment_post_ID WHERE c.comment_author_email NOT LIKE '%@example.org'`,
      );
      const facts = rows;
      if (rows.length !== 1) return no(`${rows.length} new comments`, facts);
      const r = rows[0]!;
      if (r.parent_author !== 'Priya') return no('not a reply to Priya', facts);
      if (r.uid !== '1') return no('not written by the admin', facts);
      if (r.status !== '1') return no('reply is not approved', facts);
      if ((r.content ?? '').trim().replace(/[.!]$/, '') !== REPLY.replace(/\.$/, '')) return no('text differs', facts);
      // The seeded comments (authors @example.org): Lee's and Priya's approved, the others pending.
      const changed = (await dbComments()).filter(
        (c) =>
          SEEDED_COMMENT_AUTHORS.has(c.author) && c.status !== (c.author === 'Lee' || c.author === 'Priya' ? '1' : '0'),
      );
      if (changed.length) return no('other comments changed status', { facts, changed });
      return ok('replied to Priya', facts);
    },
  },
  {
    id: 'w14-community-category',
    instruction: 'Create a category "Community" and add every post of the Events category to it as well.',
    start: '/wp-admin/',
    user: 'admin',
    oracleDoc:
      'A category Community exists; the posts in Community are exactly the two Events posts (one published, one draft), which keep Events and their status.',
    async reference(page) {
      await createCategory(page, 'Community');
      await quickEdit(page, 'Community call: November', checkCategory('Community'));
      await quickEdit(page, 'Spring meetup recap', checkCategory('Community'));
    },
    perturbations: [
      {
        name: 'perturbed-published-only',
        kind: 'partial',
        async run(page) {
          await createCategory(page, 'Community');
          await quickEdit(page, 'Community call: November', checkCategory('Community'));
        },
      },
    ],
    async oracle() {
      const posts = await dbPosts();
      const inCommunity = posts
        .filter((p) => p.categories.includes('Community'))
        .map((p) => p.title)
        .toSorted();
      const events = posts.filter((p) => p.title === 'Community call: November' || p.title === 'Spring meetup recap');
      const facts = { inCommunity, events: events.map((p) => [p.title, p.status, p.categories.join(',')]) };
      if (inCommunity.join('|') !== 'Community call: November|Spring meetup recap')
        return no(`Community holds [${inCommunity.join(', ')}]`, facts);
      if (events.some((p) => !p.categories.includes('Events'))) return no('an Events post lost Events', facts);
      if (events.find((p) => p.title === 'Spring meetup recap')?.status !== 'draft')
        return no('draft status changed', facts);
      if (events.find((p) => p.title === 'Community call: November')?.status !== 'publish')
        return no('published status changed', facts);
      return ok('both Events posts in Community', facts);
    },
  },
  {
    id: 'w15-schedule-post',
    instruction: 'Schedule the draft post "Roadmap 2027" to be published on January 5, 2027 at 9:00.',
    start: '/wp-admin/',
    user: 'admin',
    oracleDoc:
      'The post "Roadmap 2027" has status future and post_date 2027-01-05 09:00 (site time, UTC); no other post changed status.',
    async reference(page) {
      await schedule(page, 'Roadmap 2027', { mm: '01', jj: '05', aa: '2027', hh: '09', mn: '00' });
    },
    perturbations: [
      {
        name: 'perturbed-may-fifth',
        kind: 'wrong-item',
        async run(page) {
          await schedule(page, 'Roadmap 2027', { mm: '05', jj: '01', aa: '2027', hh: '09', mn: '00' });
        },
      },
    ],
    async oracle() {
      const rows = await q(
        `SELECT post_status, post_date FROM wp_posts WHERE post_type = 'post' AND post_title = 'Roadmap 2027'`,
      );
      const others = await otherStatusChanges('Roadmap 2027');
      const facts = { rows, others: others.map((o) => [o.title, o.status]) };
      if (rows.length !== 1) return no(`${rows.length} posts titled Roadmap 2027`, facts);
      if (rows[0]!.post_status !== 'future') return no(`status is ${rows[0]!.post_status}`, facts);
      if (!(rows[0]!.post_date ?? '').startsWith('2027-01-05 09:00')) return no(`date is ${rows[0]!.post_date}`, facts);
      if (others.length) return no('other posts changed status', facts);
      return ok('scheduled for 2027-01-05 09:00', facts);
    },
  },
);

export const wordpress: RealApp = {
  name: 'wordpress',
  title: 'WordPress 6.6 (CMS admin: posts, block editor, comments, users, settings)',
  baseURL: BASE,
  start,
  reset,
  stop,
  signIn,
  probes,
  tasks: TASKS,
};
