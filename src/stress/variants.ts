/**
 * Valid variants: edits of a correct snapshot that a correct outcome may show.
 * A check set must accept all of them; a check that rejects one is flagged as
 * over-constrained (it imposes a condition the task did not state).
 *
 * Generic variants are presentation changes; some do not apply to every task
 * (e.g. `reorder` when the task asks for a sort order, `extra-row` when it fixes
 * the number of items). Tasks list those in `skipVariants`.
 */
import type {
  Assertion,
  CheckSet,
  EvidenceSnapshot,
  Json,
  Normalizer,
  NetworkEntry,
  AXNode,
  ProbeResult,
  ValueSource,
} from '../types.ts';
import { AXIndex, readNodeField, resolveTarget, type INode } from '../runtime/axindex.ts';
import { applyNormalizers, zoneOffset, type TypedValue } from '../runtime/values.ts';
import { canonical, stripGlobal } from '../text.ts';
import { clone, editById, replaceText, treeChanged } from './edit.ts';
import { readSpan, timezoneOf } from './mutants.ts';

export interface Variant {
  id: string;
  description: string;
  snapshot: EvidenceSnapshot;
}

export const GENERIC_VARIANTS = [
  'reorder',
  'reorder-terms',
  'extra-content',
  'extra-row',
  'wrap-main',
  'spacing',
  'extra-json-fields',
  'json-array-order',
  'network-noise',
  'retry',
  'extra-storage',
  'url-decoration',
  'url-hash',
  // Only for snapshots with captured frames or several open pages (ADR 0012).
  'extra-frame',
  'extra-page',
] as const;

const REORDERABLE = new Set(['list', 'rowgroup', 'table', 'listbox', 'menu', 'grid', 'tree', 'feed']);
const isHeader = (n: AXNode): boolean => n.role === 'columnheader' || (n.children ?? []).some(isHeader);

function reorder(s: EvidenceSnapshot): EvidenceSnapshot | null {
  const out = editById(s, (n) => {
    if (!REORDERABLE.has(n.role) || !n.children || n.children.length < 2) return undefined;
    // Header rows (and header rowgroups) stay first.
    const head = n.children.filter(isHeader);
    const body = n.children.filter((c) => !head.includes(c));
    if (body.length < 2) return undefined;
    return { ...n, children: [...head, ...body.toReversed()] };
  });
  return treeChanged(s, out) ? out : null;
}

/**
 * Term groups (a term with the definitions after it) in reverse order within a run of
 * terms and definitions, as a description list may order its fields.
 */
const isTermPart = (n: AXNode) => n.role === 'term' || n.role === 'definition';

function reorderTerms(s: EvidenceSnapshot): EvidenceSnapshot | null {
  const out = editById(s, (n) => {
    const kids = n.children ?? [];
    if (!kids.some((c) => c.role === 'term')) return undefined;
    const next: AXNode[] = [];
    for (let i = 0; i < kids.length;) {
      if (!isTermPart(kids[i]!)) {
        next.push(kids[i++]!);
        continue;
      }
      // One run of terms and definitions, split into groups that each start at a term.
      const groups: AXNode[][] = [];
      for (; i < kids.length && isTermPart(kids[i]!); i++) {
        const k = kids[i]!;
        const prev = groups.at(-1);
        if (!prev || (k.role === 'term' && prev.at(-1)!.role === 'definition')) groups.push([k]);
        else prev.push(k);
      }
      next.push(...groups.toReversed().flat());
    }
    return { ...n, children: next };
  });
  return treeChanged(s, out) ? out : null;
}

const UNRELATED_TEXT = ['Recommended for you', 'Gift card', 'Tea towel', 'Free shipping on orders over $50.00'];
const UNRELATED: AXNode[] = [
  {
    role: 'region',
    name: 'Recommended for you',
    children: [
      { role: 'heading', name: 'Recommended for you', level: 2 },
      {
        role: 'list',
        children: [
          { role: 'listitem', children: [{ role: 'text', name: 'Gift card' }] },
          { role: 'listitem', children: [{ role: 'text', name: 'Tea towel' }] },
        ],
      },
    ],
  },
  { role: 'status', children: [{ role: 'text', name: 'Free shipping on orders over $50.00' }] },
];

function extraContent(s: EvidenceSnapshot): EvidenceSnapshot {
  let placed = false;
  let out = editById(s, (n) => {
    if (n.role !== 'main' || placed) return undefined;
    placed = true;
    return { ...n, children: [...(n.children ?? []), ...clone(UNRELATED)] };
  });
  if (!placed) out = { ...out, a11y: { ...out.a11y, children: [...(out.a11y.children ?? []), ...clone(UNRELATED)] } };
  return { ...out, text: `${out.text}\n${UNRELATED_TEXT.join('\n')}` };
}

const hasFrameContent = (n: AXNode): boolean =>
  (n.role === 'iframe' && !!n.children?.length) || (n.children ?? []).some(hasFrameContent);

/**
 * An unrelated embedded frame (an advertisement) with content of its own, next to the
 * page's content (ADR 0012). Only for pages whose frames were captured: a check that
 * reads frame content must not pick up another frame's.
 */
function extraFrame(s: EvidenceSnapshot): EvidenceSnapshot | null {
  if (!hasFrameContent(s.a11y)) return null;
  let origin = 'https://ads.example';
  try {
    origin = new URL(s.page.url).origin;
  } catch {
    /* keep the default */
  }
  const ad: AXNode = { role: 'iframe', name: 'Advertisement', url: `${origin}/ads/frame`, children: clone(UNRELATED) };
  let placed = false;
  let out = editById(s, (n) => {
    if (n.role !== 'main' || placed) return undefined;
    placed = true;
    return { ...n, children: [...(n.children ?? []), ad] };
  });
  if (!placed) out = { ...out, a11y: { ...out.a11y, children: [...(out.a11y.children ?? []), ad] } };
  return { ...out, text: `${out.text}\n${UNRELATED_TEXT.join('\n')}` };
}

/** The origin of an http(s) URL, if it is one. */
function httpOrigin(u: string): string | undefined {
  try {
    const o = new URL(u).origin;
    return o.startsWith('http') ? o : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An unrelated extra tab (a help page) on the site of the last tab opened, next to the
 * others (ADR 0012). Only for snapshots of several pages.
 */
function extraPage(s: EvidenceSnapshot): EvidenceSnapshot | null {
  if (!s.pages?.length) return null;
  const origin = httpOrigin(s.pages.at(-1)!.url) ?? httpOrigin(s.page.url) ?? 'https://help.example';
  const help = {
    url: `${origin}/help/getting-started`,
    title: 'Getting started',
    a11y: {
      role: 'document',
      children: [
        {
          role: 'main',
          children: [
            { role: 'heading', name: 'Getting started', level: 1 },
            { role: 'paragraph', children: [{ role: 'text', name: 'Read the guide.' }] },
          ],
        },
      ],
    },
    text: 'Getting started\nRead the guide.',
  };
  return { ...s, pages: [...s.pages, help] };
}

function extraTableRow(s: EvidenceSnapshot): EvidenceSnapshot | null {
  const out = editById(s, (n) => {
    if (n.role !== 'rowgroup' && n.role !== 'table') return undefined;
    const rows = (n.children ?? []).filter((r) => r.role === 'row' && !isHeader(r));
    const sample = rows.find((r) => r.children?.some((c) => c.role === 'cell' || c.role === 'gridcell'));
    if (!sample) return undefined;
    const cells = (sample.children ?? []).map((c, i) => ({ role: c.role, name: i === 0 ? 'Gift card' : '' }));
    return { ...n, children: [...(n.children ?? []), { role: 'row', name: 'Gift card', children: cells }] };
  });
  return treeChanged(s, out) ? out : null;
}

function wrapMain(s: EvidenceSnapshot): EvidenceSnapshot | null {
  let done = false;
  const out = editById(s, (n) => {
    if (n.role !== 'main' || done) return undefined;
    done = true;
    return { ...n, children: [{ role: 'region', name: 'Page content', children: n.children ?? [] }] };
  });
  return done ? out : null;
}

/** Non-breaking space followed by a space: same rendering, different characters. */
const respace = (t: string) => t.replace(/ /g, '  ');

function spacing(s: EvidenceSnapshot): EvidenceSnapshot {
  const out = editById(s, (n) => (n.name !== undefined ? { ...n, name: respace(n.name) } : undefined));
  return { ...out, text: out.text.replace(/ /g, '  ') };
}

/** Objects whose keys are data (ids, SKUs) rather than field names: adding keys would add records. */
function isRecordLike(v: Record<string, Json>): boolean {
  const keys = Object.keys(v);
  if (keys.length === 0) return true;
  if (keys.some((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))) return true;
  const types = new Set(Object.values(v).map((x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x)));
  return keys.length > 1 && types.size === 1 && !types.has('string') && !types.has('object');
}

function addFields(v: Json): Json {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return isRecordLike(v) ? v : { ...v, _links: { self: '/x' }, requestId: 'r-123' };
  }
  if (Array.isArray(v)) return v.map(addFields);
  return v;
}

const isObj = (v: Json | undefined): v is Json => v !== undefined && v !== null && typeof v === 'object';

function mapBodies(s: EvidenceSnapshot, fn: (v: Json) => Json): EvidenceSnapshot | null {
  let changed = false;
  const apply = (v: Json) => {
    const out = fn(v);
    if (JSON.stringify(out) !== JSON.stringify(v)) changed = true;
    return out;
  };
  const network = s.network?.map((e) => ({
    ...e,
    ...(isObj(e.requestBody) ? { requestBody: apply(e.requestBody) } : {}),
    ...(isObj(e.responseBody) ? { responseBody: apply(e.responseBody) } : {}),
  }));
  const mapProbes = (ps: Record<string, ProbeResult>) =>
    Object.fromEntries(
      Object.entries(ps).map(([k, p]) => [
        k,
        p.ok && isObj(p.value) ? { ok: true as const, value: apply(p.value) } : p,
      ]),
    );
  const probes = mapProbes(s.probes);
  // The API's shape is the same before and after the task, so the baseline gets the same edit.
  const baseline = s.baseline ? { ...s.baseline, probes: mapProbes(s.baseline.probes) } : undefined;
  return changed ? { ...s, network: network ?? null, probes, ...(baseline ? { baseline } : {}) } : null;
}

const reverseArrays = (v: Json): Json =>
  Array.isArray(v)
    ? v.map(reverseArrays).toReversed()
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, reverseArrays(x)]))
      : v;

function networkNoise(s: EvidenceSnapshot): EvidenceSnapshot | null {
  if (!s.network) return null;
  let origin: string;
  try {
    origin = new URL(s.page.url).origin;
  } catch {
    return null;
  }
  let seq = Math.max(-1, ...s.network.map((e) => e.seq)) + 1;
  const extra: NetworkEntry[] = [
    {
      seq: seq++,
      method: 'GET',
      url: `${origin}/analytics/collect?e=pageview`,
      resourceType: 'fetch',
      status: 204,
      requestHeaders: {},
      responseHeaders: {},
    },
  ];
  // A polling client re-fetches what it already fetched.
  for (const e of s.network
    .filter((x) => x.method === 'GET' && x.resourceType === 'fetch' && x.status === 200)
    .slice(0, 3)) {
    extra.push({ ...clone(e), seq: seq++ });
  }
  return { ...s, network: [...s.network, ...extra] };
}

/** Each state-changing request first failed (HTTP 503) and was retried successfully. */
function retry(s: EvidenceSnapshot): EvidenceSnapshot | null {
  if (!s.network) return null;
  const out: NetworkEntry[] = [];
  let seq = 0;
  let changed = false;
  for (const e of s.network) {
    if (e.method !== 'GET' && e.status !== null && e.status < 400) {
      out.push({ ...clone(e), seq: seq++, status: 503, responseBody: { error: 'Service Unavailable' } });
      changed = true;
    }
    out.push({ ...e, seq: seq++ });
  }
  return changed ? { ...s, network: out } : null;
}

/** Storage keys some check reads; an unrelated-storage variant must not write them. */
function readKeys(cs: CheckSet): Set<string> {
  const keys = new Set<string>();
  // Only value sources count, not data that merely looks like one (e.g. inside a schema).
  const walk = (a: Assertion): void => {
    if (a.kind === 'value') {
      if (a.source.from === 'storage') keys.add(a.source.key);
      if ('sameAs' in a.expect && a.expect.sameAs.source.from === 'storage') keys.add(a.expect.sameAs.source.key);
    } else if (a.kind === 'allOf' || a.kind === 'anyOf') a.of.forEach(walk);
    else if (a.kind === 'each' || a.kind === 'page') walk(a.assert);
  };
  for (const c of cs.checks) walk(c.assert);
  return keys;
}

function extraStorage(s: EvidenceSnapshot, cs: CheckSet): EvidenceSnapshot | null {
  if (!s.storage) return null;
  const read = readKeys(cs);
  if (['_ga', 'consent', 'scrollY'].some((k) => read.has(k))) return null;
  let u: URL;
  try {
    u = new URL(s.page.url);
  } catch {
    return null;
  }
  const st = s.storage;
  // Overwriting a key the task itself stores would not be an unrelated change.
  if (st.local[u.origin]?.consent !== undefined || st.session[u.origin]?.scrollY !== undefined) return null;
  return {
    ...s,
    storage: {
      cookies: [
        ...st.cookies,
        { name: '_ga', value: 'GA1.1.123', domain: u.hostname, path: '/', httpOnly: false, secure: false },
      ],
      local: { ...st.local, [u.origin]: { ...st.local[u.origin], consent: 'granted' } },
      session: { ...st.session, [u.origin]: { ...st.session[u.origin], scrollY: '0' } },
    },
  };
}

function urlVariant(s: EvidenceSnapshot, fn: (u: URL) => void): EvidenceSnapshot | null {
  let u: URL;
  try {
    u = new URL(s.page.url);
  } catch {
    return null;
  }
  fn(u);
  return u.toString() === s.page.url ? null : { ...s, page: { ...s.page, url: u.toString() } };
}

// --- value formatting variants -------------------------------------------------

const uniq = (xs: string[]) => [...new Set(xs)];

/** The wall clock of instant `t` in `timezone` as ISO 8601 with its offset ("2026-11-05T14:30+01:00"). */
function isoInZone(t: number, timezone: string, seconds: boolean): string {
  const offset = zoneOffset(t, timezone) / 60_000;
  const local = new Date(t + offset * 60_000).toISOString();
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const zone = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${local.slice(0, seconds ? 19 : 16)}${zone}`;
}

function formatsFor(v: TypedValue, span: string, locale: string, timezone: string | undefined): string[] {
  if (v.type === 'money') {
    const n = v.value.amount;
    const c = v.value.currency;
    const out = [
      new Intl.NumberFormat(locale, { style: 'currency', currency: c }).format(n),
      new Intl.NumberFormat(locale, { style: 'currency', currency: c, currencyDisplay: 'code' }).format(n),
      `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2 }).format(n)} ${c}`,
    ];
    if (Number.isInteger(n * 10) && !Number.isInteger(n)) {
      out.push(new Intl.NumberFormat(locale, { style: 'currency', currency: c, minimumFractionDigits: 1 }).format(n));
    }
    return uniq(out);
  }
  if (v.type === 'number') {
    // Only quantities already shown with grouping or decimals are re-formatted;
    // ids, years and codes ("10234") must not gain separators.
    const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
    const group = parts.find((p) => p.type === 'group')?.value ?? ',';
    const dec = parts.find((p) => p.type === 'decimal')?.value ?? '.';
    if (!span.includes(group) && !span.includes(dec)) return [];
    return uniq([
      new Intl.NumberFormat(locale, { useGrouping: true, maximumFractionDigits: 6 }).format(v.value),
      new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 6 }).format(v.value),
    ]);
  }
  if (v.type === 'date') {
    const d = new Date(v.value + 'T00:00:00Z');
    return uniq(
      (['full', 'long', 'medium', 'short'] as const)
        .map((dateStyle) => new Intl.DateTimeFormat(locale, { dateStyle, timeZone: 'UTC' }).format(d))
        .filter((x) => !/\b\d{2}$/.test(x) || /\d{4}/.test(x)) // 2-digit years are ambiguous by design
        .concat([v.value]),
    );
  }
  if (v.type === 'datetime') {
    // Rendered on the wall clock of the check's timezone; a value read with its own
    // offset and no timezone has no zone to render in.
    if (!timezone) return [];
    const t = Date.parse(v.value);
    if (t % 1000 !== 0) return []; // no localized style shows milliseconds
    const seconds = t % 60_000 !== 0;
    const timeStyle = seconds ? 'medium' : 'short';
    return uniq(
      (['full', 'long', 'medium', 'short'] as const)
        .map((dateStyle) => new Intl.DateTimeFormat(locale, { dateStyle, timeStyle, timeZone: timezone }).format(t))
        .filter((x) => /\d{4}/.test(x)) // 2-digit years are ambiguous by design
        .concat([isoInZone(t, timezone, seconds)]),
    );
  }
  return [];
}

function localeOf(steps: Normalizer[] | undefined): string | undefined {
  for (const s of steps ?? []) if (typeof s === 'object' && 'locale' in s) return s.locale;
  return undefined;
}

/** The value assertions inside `a`, each with the record it reads in (undefined: the page). */
function* valueAssertions(
  a: Assertion,
  idx: AXIndex,
  rec?: INode,
): Generator<{ a: Extract<Assertion, { kind: 'value' }>; rec: INode | undefined }> {
  if (a.kind === 'value') yield { a, rec };
  if (a.kind === 'allOf' || a.kind === 'anyOf') for (const s of a.of) yield* valueAssertions(s, idx, rec);
  if (a.kind === 'each') {
    let scope = rec ?? idx.root;
    if (a.scope) {
      const r = resolveTarget(idx, a.scope, rec);
      if (!r.ok) return;
      scope = r.node;
    }
    for (const record of idx.records(a.match, scope)) yield* valueAssertions(a.assert, idx, record);
  }
}

/** The sources a value assertion reads, with their normalizers: its own, and a `sameAs` operand. */
function readsOf(a: Extract<Assertion, { kind: 'value' }>): { source: ValueSource; normalize?: Normalizer[] }[] {
  return [{ source: a.source, normalize: a.normalize }, ...('sameAs' in a.expect ? [a.expect.sameAs] : [])];
}

/**
 * The node a value source reads, and the raw value it reads there: a node source's field,
 * or what a text source's pattern captures in the canonical text of its scope or record.
 * Unscoped page text outside a record is free text with no node to edit.
 */
function readsNode(
  idx: AXIndex,
  source: ValueSource,
  rec: INode | undefined,
): { node: INode; raw: string; field: 'name' | 'value' | 'text' | 'url' | 'text-source' } | undefined {
  if (source.from === 'node') {
    const r = resolveTarget(idx, source.target, rec);
    if (!r.ok) return undefined;
    const raw = readNodeField(idx, r.node, source.field);
    return raw === undefined ? undefined : { node: r.node, raw, field: source.field };
  }
  if (source.from !== 'text') return undefined;
  let node = rec;
  if (source.scope) {
    const r = resolveTarget(idx, source.scope, rec);
    if (!r.ok) return undefined;
    node = r.node;
  }
  if (!node) return undefined;
  const m = new RegExp(source.pattern, stripGlobal(source.flags)).exec(canonical(idx.text(node)));
  const g = source.group ?? (m && m.length > 1 ? 1 : 0);
  const raw = m ? (typeof g === 'number' ? m[g] : m.groups?.[g]) : undefined;
  return raw ? { node, raw, field: 'text-source' } : undefined;
}

/** The first text run (or named leaf) inside `node` whose name holds `span`, if one does. */
function textRunWith(idx: AXIndex, node: INode, span: string): INode | undefined {
  return [node, ...idx.descendants(node)].find(
    (n) => n.id >= 0 && (n.node.role === 'text' || !n.children.length) && n.node.name?.includes(span),
  );
}

function formattingVariants(cs: CheckSet, s: EvidenceSnapshot, idx: AXIndex): Variant[] {
  const out: Variant[] = [];
  for (const c of cs.checks) {
    for (const { a, rec } of valueAssertions(c.assert, idx)) {
      for (const [k, { source, normalize }] of readsOf(a).entries()) {
        const locale = localeOf(normalize);
        if (!locale) continue;
        const read = readsNode(idx, source, rec);
        if (!read) continue;
        const { raw } = read;
        const span = readSpan(raw, normalize);
        if (!span) continue;
        let typed: TypedValue;
        try {
          typed = applyNormalizers({ type: 'string', value: raw }, normalize);
        } catch {
          continue;
        }
        // A text source's value lives in some text run inside the node it reads.
        const target = read.field === 'text-source' ? textRunWith(idx, read.node, span)?.id : read.node.id;
        if (target === undefined) continue;
        const field = read.field;
        for (const [i, alt] of formatsFor(typed, span, locale, timezoneOf(normalize)).entries()) {
          if (alt === span) continue;
          const next = raw.replace(span, () => alt);
          const snap = editById(s, (n, id) => {
            if (id !== target) return undefined;
            if (field === 'value' || field === 'url') return { ...n, [field]: next };
            return replaceText(n, span, alt) ?? undefined;
          });
          if (!treeChanged(s, snap)) continue; // the value spans several text runs: no faithful edit
          // Several value assertions (or records of an each) can read the same check's values.
          let id = `format:${c.id}:${k ? 'sameAs:' : ''}${i}`;
          for (let n = 2; out.some((v) => v.id === id); n++) id = `format:${c.id}:${k ? 'sameAs:' : ''}${i}#${n}`;
          out.push({
            id,
            description: `${c.id}'s ${k ? 'compared ' : ''}value shown as ${JSON.stringify(alt)} instead of ${JSON.stringify(span)}`,
            snapshot: snap,
          });
        }
      }
    }
  }
  return out;
}

export function generateVariants(cs: CheckSet, s: EvidenceSnapshot): Variant[] {
  const generic: [string, string, EvidenceSnapshot | null][] = [
    ['reorder', 'list items and table rows in reverse order', reorder(s)],
    ['reorder-terms', 'term groups (a term with its definitions) in reverse order', reorderTerms(s)],
    ['extra-content', 'unrelated recommendations and a promotional status message on the page', extraContent(s)],
    ['extra-row', 'an unrelated extra row in each table', extraTableRow(s)],
    ['wrap-main', 'main content wrapped in an extra region', wrapMain(s)],
    ['spacing', 'non-breaking and doubled spaces in visible text', spacing(s)],
    ['extra-json-fields', 'extra fields in JSON bodies and probe results', mapBodies(s, addFields)],
    ['json-array-order', 'arrays in JSON bodies and probe results in reverse order', mapBodies(s, reverseArrays)],
    ['network-noise', 'an analytics beacon and repeated GET requests', networkNoise(s)],
    ['retry', 'each state-changing request first failed with HTTP 503 and was retried', retry(s)],
    ['extra-storage', 'unrelated cookies and storage keys', extraStorage(s, cs)],
    [
      'url-decoration',
      'a tracking query parameter on the page URL',
      urlVariant(s, (u) => u.searchParams.set('utm_source', 'newsletter')),
    ],
    ['url-hash', 'a fragment on the page URL', urlVariant(s, (u) => (u.hash = 'top'))],
    ['extra-frame', 'an unrelated embedded frame (an advertisement) with its own content', extraFrame(s)],
    ['extra-page', 'an unrelated extra tab (a help page) is open', extraPage(s)],
  ];
  return [
    ...generic
      .filter((g): g is [string, string, EvidenceSnapshot] => g[2] !== null)
      .map(([id, description, snapshot]) => ({ id, description, snapshot })),
    ...formattingVariants(cs, s, new AXIndex(s.a11y)),
  ];
}
