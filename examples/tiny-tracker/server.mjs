// Tiny Tracker: a server-rendered issue tracker (forms POST, then redirect).
import { createServer } from 'node:http';
import { esc, json, readBody, redesign, redirect, sendHtml, sessions } from '../lib/kit.mjs';

const PORT = Number(process.env.PORT ?? 4174);
const USERS = ['alice', 'bob', 'carol'];
const LABELS = ['bug', 'feature', 'docs'];

const session = sessions(() => ({
  nextId: 4,
  issues: [
    {
      id: 1,
      title: 'Login button misaligned',
      body: 'On narrow screens.',
      status: 'open',
      priority: 'normal',
      assignee: null,
      labels: ['bug'],
      comments: [],
    },
    {
      id: 2,
      title: 'Add dark mode',
      body: '',
      status: 'open',
      priority: 'low',
      assignee: 'alice',
      labels: ['feature'],
      comments: [],
    },
    {
      id: 3,
      title: 'Typo in docs',
      body: 'README says "teh".',
      status: 'closed',
      priority: 'low',
      assignee: null,
      labels: ['docs'],
      comments: [],
    },
  ],
}));

const rewrite = redesign([
  ['aria-label="Issues"', 'aria-label="Issue list"'],
  ['<h1>Issues</h1>', '<h1>All issues</h1>'],
  ['>Close issue<', '>Resolve<'],
  ['>Reopen issue<', '>Reopen<'],
  ['aria-label="Issue details"', 'aria-label="Summary"'],
  ['>Save assignee<', '>Update assignee<'],
  ['>Save labels<', '>Apply labels<'],
  ['>Comment</button>', '>Post comment</button>'],
  ['<main>', '<main><div class="layout">'],
  ['</main>', '</div></main>'],
  ['>Create issue<', '>Submit issue<'],
]);

const page = (
  title,
  body,
) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Tiny Tracker</title></head><body>
<header><a href="/issues">Tiny Tracker</a><nav aria-label="Primary"><a href="/issues">Issues</a> · <a href="/issues/new">New issue</a></nav></header>
<main>${body}</main></body></html>`;

const opt = (v, cur, label) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`;

function list(s, q) {
  let rows = s.issues;
  if (q.status) rows = rows.filter((i) => i.status === q.status);
  if (q.label) rows = rows.filter((i) => i.labels.includes(q.label));
  if (q.q) rows = rows.filter((i) => i.title.toLowerCase().includes(q.q.toLowerCase()));
  return page(
    'Issues',
    `<h1>Issues</h1>
<form role="search" aria-label="Filter issues" method="get" action="/issues">
<label>Status <select name="status">${opt('', q.status ?? '', 'All')}${opt('open', q.status, 'Open')}${opt('closed', q.status, 'Closed')}</select></label>
<label>Label <select name="label">${opt('', q.label ?? '', 'Any')}${LABELS.map((l) => opt(l, q.label, l)).join('')}</select></label>
<label>Search <input type="search" name="q" value="${esc(q.q ?? '')}"></label>
<button>Filter</button></form>
<table aria-label="Issues"><thead><tr><th>#</th><th>Title</th><th>Status</th><th>Assignee</th><th>Labels</th></tr></thead><tbody>
${rows.map((i) => `<tr><td>${i.id}</td><td><a href="/issues/${i.id}">${esc(i.title)}</a></td><td>${i.status === 'open' ? 'Open' : 'Closed'}</td><td>${esc(i.assignee ?? 'Unassigned')}</td><td>${i.labels.join(', ')}</td></tr>`).join('\n')}
</tbody></table>
<p role="status">${rows.length} issue${rows.length === 1 ? '' : 's'}</p>`,
  );
}

function newForm(error, values = {}) {
  const pr = values.priority ?? 'normal';
  return page(
    'New issue',
    `<h1>New issue</h1>
${error ? `<div role="alert">${esc(error)}</div>` : ''}
<form aria-label="New issue" method="post" action="/issues">
<p><label>Title <input name="title" value="${esc(values.title ?? '')}"></label></p>
<p><label>Description <textarea name="body">${esc(values.body ?? '')}</textarea></label></p>
<p><label>Priority <select name="priority">${['low', 'normal', 'high'].map((p) => `<option value="${p}"${p === pr ? ' selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select></label></p>
<fieldset><legend>Labels</legend>${LABELS.map((l) => `<label><input type="checkbox" name="labels" value="${l}"> ${l}</label>`).join(' ')}</fieldset>
<button>Create issue</button></form>`,
  );
}

function detail(i) {
  const labels = LABELS.map(
    (l) =>
      `<label><input type="checkbox" name="labels" value="${l}"${i.labels.includes(l) ? ' checked' : ''}> ${l}</label>`,
  ).join(' ');
  return page(
    `#${i.id} ${i.title}`,
    `<h1>#${i.id} ${esc(i.title)}</h1>
<dl aria-label="Issue details">
<dt>Status</dt><dd>${i.status === 'open' ? 'Open' : 'Closed'}</dd>
<dt>Priority</dt><dd>${i.priority[0].toUpperCase() + i.priority.slice(1)}</dd>
<dt>Assignee</dt><dd>${esc(i.assignee ?? 'Unassigned')}</dd>
<dt>Labels</dt><dd>${i.labels.join(', ') || 'None'}</dd>
</dl>
<p>${esc(i.body)}</p>
<form aria-label="Assignee" method="post" action="/issues/${i.id}/assign"><label>Assignee <select name="assignee"><option value="">Unassigned</option>${USERS.map((u) => `<option value="${u}"${u === i.assignee ? ' selected' : ''}>${u}</option>`).join('')}</select></label> <button>Save assignee</button></form>
<form aria-label="Labels" method="post" action="/issues/${i.id}/labels"><fieldset><legend>Labels</legend>${labels}</fieldset><button>Save labels</button></form>
<form aria-label="Rename" method="post" action="/issues/${i.id}/rename"><label>Title <input name="title" value="${esc(i.title)}"></label> <button>Rename</button></form>
<form aria-label="Issue state" method="post" action="/issues/${i.id}/state"><input type="hidden" name="status" value="${i.status === 'open' ? 'closed' : 'open'}"><button>${i.status === 'open' ? 'Close issue' : 'Reopen issue'}</button></form>
<section aria-label="Comments"><h2>Comments</h2><ul>${i.comments.map((c) => `<li>${esc(c.author)}: ${esc(c.text)}</li>`).join('')}</ul>
<form aria-label="Add comment" method="post" action="/issues/${i.id}/comments"><label>Comment text <textarea name="text"></textarea></label> <button>Comment</button></form></section>`,
  );
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const s = session(req, res);
    const p = url.pathname;
    const html = (status, body) => sendHtml(res, status, body, rewrite);
    if (p === '/') return redirect(res, '/issues');
    if (p === '/api/issues' && req.method === 'GET') return json(res, 200, s.issues);
    let m = /^\/api\/issues\/(\d+)$/.exec(p);
    if (m && req.method === 'GET') {
      const i = s.issues.find((x) => x.id === Number(m[1]));
      return i ? json(res, 200, i) : json(res, 404, { error: 'not found' });
    }
    if (p === '/issues' && req.method === 'GET') return html(200, list(s, Object.fromEntries(url.searchParams)));
    if (p === '/issues/new' && req.method === 'GET') return html(200, newForm());
    if (p === '/issues' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.title?.trim()) return html(422, newForm('Title is required', b));
      const issue = {
        id: s.nextId++,
        title: b.title.trim(),
        body: b.body ?? '',
        status: 'open',
        priority: ['low', 'normal', 'high'].includes(b.priority) ? b.priority : 'normal',
        assignee: null,
        labels: [].concat(b.labels ?? []).filter((l) => LABELS.includes(l)),
        comments: [],
      };
      s.issues.push(issue);
      return redirect(res, `/issues/${issue.id}`);
    }
    m = /^\/issues\/(\d+)(?:\/(assign|labels|rename|state|comments))?$/.exec(p);
    if (m) {
      const i = s.issues.find((x) => x.id === Number(m[1]));
      if (!i) return html(404, page('Not found', '<h1>Issue not found</h1>'));
      if (!m[2] && req.method === 'GET') return html(200, detail(i));
      if (m[2] && req.method === 'POST') {
        const b = await readBody(req);
        if (m[2] === 'assign') i.assignee = USERS.includes(b.assignee) ? b.assignee : null;
        if (m[2] === 'labels') i.labels = [].concat(b.labels ?? []).filter((l) => LABELS.includes(l));
        if (m[2] === 'rename' && b.title?.trim()) i.title = b.title.trim();
        if (m[2] === 'state' && ['open', 'closed'].includes(b.status)) i.status = b.status;
        if (m[2] === 'comments' && b.text?.trim()) i.comments.push({ author: 'you', text: b.text.trim() });
        return redirect(res, `/issues/${i.id}`);
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
});

server.listen(PORT, () => console.log(`tiny-tracker listening on http://localhost:${PORT}`));
