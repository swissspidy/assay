/**
 * Read-only views of evidence snapshots for the discovery agent. Everything is
 * rendered as compact text so the model can find where each requirement is
 * observable.
 */
import type { AXNode, EvidenceSnapshot, Json, NetworkEntry } from '../types.ts';
import { AXIndex } from '../runtime/axindex.ts';

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function header(n: AXNode): string {
  let s = n.role;
  if (n.name !== undefined) s += ` ${JSON.stringify(n.name)}`;
  if (n.level !== undefined) s += ` [level=${n.level}]`;
  for (const [k, v] of Object.entries(n.states ?? {})) if (v) s += v === true ? ` [${k}]` : ` [${k}=${v}]`;
  if (n.value !== undefined) s += ` = ${JSON.stringify(n.value)}`;
  if (n.url !== undefined) s += ` (url ${n.url})`;
  return s;
}

/** Indented outline of the accessibility tree, ariaSnapshot-like. */
export function outline(snapshot: EvidenceSnapshot, maxLines = 300): string {
  const lines: string[] = [];
  let truncated = false;
  const walk = (n: AXNode, depth: number) => {
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }
    lines.push(`${'  '.repeat(depth)}- ${n.role === 'text' ? `text: ${JSON.stringify(n.name ?? '')}` : header(n)}`);
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  for (const c of snapshot.a11y.children ?? []) walk(c, 0);
  if (truncated) lines.push(`… (truncated at ${maxLines} lines; use find_nodes to search)`);
  return lines.join('\n');
}

const has = (hay: string | undefined, needle: string | undefined) =>
  needle === undefined || (hay ?? '').toLowerCase().includes(needle.toLowerCase());

export function findNodes(
  snapshot: EvidenceSnapshot,
  q: { role?: string; name?: string; text?: string },
  limit = 30,
): string {
  const idx = new AXIndex(snapshot.a11y);
  const hits = idx.all.filter(
    (n) =>
      n.parent &&
      (q.role === undefined || n.node.role === q.role) &&
      has(n.node.name, q.name) &&
      has(idx.text(n), q.text),
  );
  if (!hits.length) return 'No matching nodes.';
  return (
    hits
      .slice(0, limit)
      .map(
        (n) =>
          `${n.parent && n.parent.parent ? idx.path(n.parent) + ' › ' : ''}${header(n.node)}  | text: ${JSON.stringify(clip(idx.text(n), 120))}`,
      )
      .join('\n') + (hits.length > limit ? `\n… ${hits.length - limit} more` : '')
  );
}

export function networkLog(
  snapshot: EvidenceSnapshot,
  q: { method?: string; pathContains?: string; allTypes?: boolean; offset?: number },
  limit = 100,
): string {
  if (!snapshot.network) return 'The network log was not recorded for this snapshot.';
  const rows = snapshot.network.filter(
    (e) =>
      (q.allTypes || ['fetch', 'xhr', 'document'].includes(e.resourceType)) &&
      (!q.method || e.method.toUpperCase() === q.method.toUpperCase()) &&
      (!q.pathContains || e.url.includes(q.pathContains)),
  );
  if (!rows.length) return 'No matching requests.';
  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  if (offset >= rows.length) return `No rows at offset ${offset}; ${rows.length} requests match.`;
  const left = rows.length - offset - limit;
  const more = left > 0 ? `\n… ${left} more; narrow with method or pathContains, or pass offset ${offset + limit}` : '';
  return (
    rows
      .slice(offset, offset + limit)
      .map(
        (e) =>
          `#${e.seq} ${e.method} ${e.url} → ${e.status ?? e.failure ?? 'pending'} (${e.resourceType}${e.requestBody !== undefined ? ', has request body' : ''}${e.responseBody !== undefined ? ', has response body' : ''})`,
      )
      .join('\n') + more
  );
}

const body = (b: Json | undefined) =>
  b === undefined ? '(none)' : clip(typeof b === 'string' ? b : JSON.stringify(b, null, 1), 3000);

export function networkEntry(snapshot: EvidenceSnapshot, seq: number): string {
  const e: NetworkEntry | undefined = snapshot.network?.find((x) => x.seq === seq);
  if (!e) return `No request #${seq}.`;
  return [
    `#${e.seq} ${e.method} ${e.url} → ${e.status ?? e.failure ?? 'pending'} (${e.resourceType})`,
    `request headers: ${JSON.stringify(e.requestHeaders)}`,
    `request body: ${body(e.requestBody)}`,
    `response headers: ${JSON.stringify(e.responseHeaders)}`,
    `response body: ${body(e.responseBody)}`,
    e.bodyTruncated ? 'NOTE: a body was truncated.' : '',
    e.bodyUnavailable ? 'NOTE: the response body could not be captured.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function storageView(snapshot: EvidenceSnapshot): string {
  if (!snapshot.storage) return 'Storage was not captured.';
  const s = snapshot.storage;
  return [
    'cookies:',
    ...s.cookies.map(
      (c) =>
        `  ${c.name} = ${typeof c.value === 'string' ? JSON.stringify(c.value) : '(redacted)'}  [${c.domain}${c.path}]`,
    ),
    'localStorage:',
    ...Object.entries(s.local).flatMap(([o, kv]) =>
      Object.entries(kv).map(
        ([k, v]) => `  ${o} ${k} = ${typeof v === 'string' ? JSON.stringify(clip(v, 200)) : '(redacted)'}`,
      ),
    ),
    'sessionStorage:',
    ...Object.entries(s.session).flatMap(([o, kv]) =>
      Object.entries(kv).map(
        ([k, v]) => `  ${o} ${k} = ${typeof v === 'string' ? JSON.stringify(clip(v, 200)) : '(redacted)'}`,
      ),
    ),
  ].join('\n');
}

export function probesView(snapshot: EvidenceSnapshot): string {
  const entries = Object.entries(snapshot.probes);
  if (!entries.length) return 'No probes were run.';
  return entries
    .map(([k, r]) => (r.ok ? `${k}: ${clip(JSON.stringify(r.value, null, 1), 3000)}` : `${k}: ERROR ${r.error}`))
    .join('\n\n');
}

export function summary(snapshot: EvidenceSnapshot): string {
  return `URL ${snapshot.page.url} — title ${JSON.stringify(snapshot.page.title)}; network ${snapshot.network ? `${snapshot.network.length} entries` : 'not recorded'}; storage ${snapshot.storage ? 'captured' : 'not captured'}; probes: ${Object.keys(snapshot.probes).join(', ') || 'none'}`;
}
