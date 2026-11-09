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
  Redacted,
  StorageRecord,
  ValueSource,
} from '../types.ts';
import { AXIndex, readNodeField, resolveTarget, type INode } from '../runtime/axindex.ts';
import { applyNormalizers, describeValue, zoneOffset, type TypedValue } from '../runtime/values.ts';
import { compareValues } from '../runtime/compare.ts';
import { canonical, stripGlobal } from '../text.ts';
import { editById, replaceText, sameJson, treeChanged } from './edit.ts';
import { AXTable, noteDerived, regularTree } from '../store/ax.ts';
import { PRECISIONS, fromScalar, readSpan, readTyped, rewriteValue, scalarOf, snapTo, timezoneOf } from './mutants.ts';

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
  'nested-array-order',
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

/**
 * The ids an `editById` callback can edit, picked from the tree's table, so the edit rebuilds
 * their ancestors only (ADR 0016, 0023); undefined (walk the whole tree) when it is not regular.
 */
function editable(s: EvidenceSnapshot, pick: (t: AXTable) => Iterable<number>): Iterable<number> | undefined {
  return regularTree(s.a11y) ? pick(AXTable.of(s.a11y)) : undefined;
}

/** The ids of the nodes with any of `roles`. */
const withRoles =
  (...roles: string[]) =>
  (t: AXTable): number[] =>
    roles.flatMap((r) => [...t.withRole(r)]);
const isHeader = (n: AXNode): boolean => n.role === 'columnheader' || (n.children ?? []).some(isHeader);

function reorder(s: EvidenceSnapshot): EvidenceSnapshot | null {
  const out = editById(
    s,
    (n) => {
      if (!REORDERABLE.has(n.role) || !n.children || n.children.length < 2) return undefined;
      // Header rows (and header rowgroups) stay first.
      const head = n.children.filter(isHeader);
      const body = n.children.filter((c) => !head.includes(c));
      if (body.length < 2) return undefined;
      return { ...n, children: [...head, ...body.toReversed()] };
    },
    editable(s, withRoles(...REORDERABLE)),
  );
  return treeChanged(s, out) ? out : null;
}

/**
 * Term groups (a term with the definitions after it) in reverse order within a run of
 * terms and definitions, as a description list may order its fields.
 */
const isTermPart = (n: AXNode) => n.role === 'term' || n.role === 'definition';

function reorderTerms(s: EvidenceSnapshot): EvidenceSnapshot | null {
  const out = editById(
    s,
    (n) => {
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
    },
    editable(s, termParents),
  );
  return treeChanged(s, out) ? out : null;
}

/** The nodes with a term among their children (edits keep every node's role). */
function termParents(t: AXTable): number[] {
  const out = new Set<number>();
  for (const id of t.withRole('term')) if (t.parent[id]! >= 0) out.add(t.parent[id]!);
  return [...out];
}

const UNRELATED_TEXT = ['Recommended for you', 'Gift card', 'Tea towel', 'Free shipping on orders over $50.00'];
/** Unrelated content, made anew for each variant (a literal costs less than a structured clone). */
const unrelated = (): AXNode[] => [
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
  let out = editById(
    s,
    (n) => {
      if (n.role !== 'main' || placed) return undefined;
      placed = true;
      return { ...n, children: [...(n.children ?? []), ...unrelated()] };
    },
    editable(s, withRoles('main')),
  );
  if (!placed) {
    const a11y = { ...out.a11y, children: [...(out.a11y.children ?? []), ...unrelated()] };
    noteDerived(a11y, out.a11y);
    out = { ...out, a11y };
  }
  return { ...out, text: `${out.text}\n${UNRELATED_TEXT.join('\n')}` };
}

const hasFrameContent = (n: AXNode): boolean =>
  (n.role === 'iframe' && !!n.children?.length) || (n.children ?? []).some(hasFrameContent);

/** `tree` with `extra` added to its first `main` outside any iframe, or to its root. */
function addOutsideFrames(tree: AXNode, extra: AXNode): AXNode {
  let placed = false;
  const walk = (n: AXNode): AXNode => {
    if (placed || n.role === 'iframe') return n;
    if (n.role === 'main') {
      placed = true;
      return { ...n, children: [...(n.children ?? []), extra] };
    }
    return n.children ? { ...n, children: n.children.map(walk) } : n;
  };
  const out = walk(tree);
  return placed ? out : { ...out, children: [...(out.children ?? []), extra] };
}

/** The advertisement frame of the extra-frame variant, on the origin of `url`. */
const adFrame = (url: string): AXNode => ({
  role: 'iframe',
  name: 'Advertisement',
  url: `${httpOrigin(url) ?? 'https://ads.example'}/ads/frame`,
  children: unrelated(),
});

/** A page view with the ad frame added, when it has frame content; else the same view. */
function withAd<V extends { url: string; a11y: AXNode; text: string }>(v: V): V {
  if (!hasFrameContent(v.a11y)) return v;
  return { ...v, a11y: addOutsideFrames(v.a11y, adFrame(v.url)), text: `${v.text}\n${UNRELATED_TEXT.join('\n')}` };
}

/**
 * An unrelated embedded frame (an advertisement) with content of its own, next to the
 * page's content and outside its frames (ADR 0012), on every open page whose frames were
 * captured: a check that reads frame content, on the active page or one a page assertion
 * selects, must not pick up another frame's.
 */
function extraFrame(s: EvidenceSnapshot): EvidenceSnapshot | null {
  const active = withAd({ url: s.page.url, a11y: s.a11y, text: s.text });
  const pages = s.pages?.map(withAd);
  if (active.a11y === s.a11y && (pages ?? []).every((p, i) => p === s.pages![i])) return null;
  return { ...s, a11y: active.a11y, text: active.text, ...(pages ? { pages } : {}) };
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
  const out = editById(
    s,
    (n) => {
      if (n.role !== 'rowgroup' && n.role !== 'table') return undefined;
      const rows = (n.children ?? []).filter((r) => r.role === 'row' && !isHeader(r));
      const sample = rows.find((r) => r.children?.some((c) => c.role === 'cell' || c.role === 'gridcell'));
      if (!sample) return undefined;
      const cells = (sample.children ?? []).map((c, i) => ({ role: c.role, name: i === 0 ? 'Gift card' : '' }));
      return { ...n, children: [...(n.children ?? []), { role: 'row', name: 'Gift card', children: cells }] };
    },
    editable(s, withRoles('rowgroup', 'table')),
  );
  return treeChanged(s, out) ? out : null;
}

function wrapMain(s: EvidenceSnapshot): EvidenceSnapshot | null {
  let done = false;
  const out = editById(
    s,
    (n) => {
      if (n.role !== 'main' || done) return undefined;
      done = true;
      return { ...n, children: [{ role: 'region', name: 'Page content', children: n.children ?? [] }] };
    },
    editable(s, withRoles('main')),
  );
  return done ? out : null;
}

/** The nodes with a name (an edit copies a node's fields, its name among them). */
function named(t: AXTable): number[] {
  const out: number[] = [];
  for (let i = 0; i < t.size; i++) if (t.nodes[i]!.name !== undefined) out.push(i);
  return out;
}

/** Non-breaking space followed by a space: same rendering, different characters. */
const respace = (t: string) => t.replace(/ /g, '  ');

function spacing(s: EvidenceSnapshot): EvidenceSnapshot {
  const out = editById(
    s,
    (n) => (n.name !== undefined ? { ...n, name: respace(n.name) } : undefined),
    editable(s, named),
  );
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
  if (Array.isArray(v)) return mapItems(v, addFields);
  return v;
}

/**
 * The JSON-transforming variants below return their input wherever they change nothing
 * (ADR 0016): the variant shares those parts with the reference, and comparing it with
 * the reference (`sameJson`) skips them.
 */

/** `v.map(fn)`, or `v` itself when `fn` returns every item unchanged. */
function mapItems(v: Json[], fn: (x: Json) => Json): Json[] {
  let out: Json[] | undefined;
  for (let i = 0; i < v.length; i++) {
    if (!(i in v)) return v.map(fn); // a sparse array: as map does
    const x = v[i]!;
    const y = fn(x);
    if (y !== x && !out) out = v.slice(0, i);
    if (out) out.push(y);
  }
  return out ?? v;
}

/** `Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fn(x)]))`, or `v` itself when nothing changed. */
function mapFields(v: { [key: string]: Json }, fn: (x: Json) => Json): Json {
  const keys = Object.keys(v);
  let out: { [key: string]: Json } | undefined;
  for (let i = 0; i < keys.length; i++) {
    const x = v[keys[i]!]!;
    const y = fn(x);
    if (y !== x && !out) {
      out = {};
      for (let j = 0; j < i; j++) put(out, keys[j]!, v[keys[j]!]!);
    }
    if (out) put(out, keys[i]!, y);
  }
  return out ?? v;
}

/** `o[k] = x` as a data property, as Object.fromEntries defines it (also for `__proto__`). */
function put(o: { [key: string]: Json }, k: string, x: Json): void {
  if (k === '__proto__')
    Object.defineProperty(o, k, { value: x, writable: true, enumerable: true, configurable: true });
  else o[k] = x;
}

/** A probe result written exactly as `{ ok: true, value }` would be. */
const isOkValue = (p: ProbeResult): boolean => {
  const keys = Object.keys(p);
  return p.ok === true && keys.length === 2 && keys[0] === 'ok' && keys[1] === 'value';
};

const isObj = (v: Json | undefined): v is Json => v !== undefined && v !== null && typeof v === 'object';

function mapBodies(s: EvidenceSnapshot, fn: (v: Json) => Json): EvidenceSnapshot | null {
  let changed = false;
  const apply = (v: Json) => {
    const out = fn(v);
    if (!changed && !sameJson(out, v)) changed = true;
    return out;
  };
  // An entry or probe whose bodies `fn` returns unchanged is kept as it is (the same JSON).
  const network = s.network?.map((e) => {
    const req = isObj(e.requestBody) ? apply(e.requestBody) : e.requestBody;
    const res = isObj(e.responseBody) ? apply(e.responseBody) : e.responseBody;
    return req === e.requestBody && res === e.responseBody
      ? e
      : {
          ...e,
          ...(isObj(e.requestBody) ? { requestBody: req } : {}),
          ...(isObj(e.responseBody) ? { responseBody: res } : {}),
        };
  });
  const mapProbes = (ps: Record<string, ProbeResult>) =>
    Object.fromEntries(
      Object.entries(ps).map(([k, p]) => {
        if (!p.ok || !isObj(p.value)) return [k, p];
        const value = apply(p.value);
        return [k, value === p.value && isOkValue(p) ? p : { ok: true as const, value }];
      }),
    );
  const probes = mapProbes(s.probes);
  // The API's shape is the same before and after the task, so the baseline gets the same edit.
  const baseline = s.baseline ? { ...s.baseline, probes: mapProbes(s.baseline.probes) } : undefined;
  return changed ? { ...s, network: network ?? null, probes, ...(baseline ? { baseline } : {}) } : null;
}

const reverseArrays = (v: Json): Json =>
  Array.isArray(v)
    ? v.length < 2
      ? mapItems(v, reverseArrays)
      : v.map(reverseArrays).toReversed()
    : v && typeof v === 'object'
      ? mapFields(v, reverseArrays)
      : v;

const reverseInArray = (x: Json) => reverseNested(x, true);
const reverseOutside = (x: Json) => reverseNested(x, false);

/** Arrays inside an array's items (each line's options, each record's tags) reversed; the outer arrays keep their order. */
const reverseNested = (v: Json, inArray = false): Json =>
  Array.isArray(v)
    ? inArray && v.length >= 2
      ? v.map(reverseInArray).toReversed()
      : mapItems(v, reverseInArray)
    : v && typeof v === 'object'
      ? mapFields(v, inArray ? reverseInArray : reverseOutside)
      : v;

/**
 * `nested-array-order`: the arrays nested inside records reversed in JSON bodies, probe
 * results (before and after the task) and JSON text in local and session storage. Unlike
 * `json-array-order` it keeps the outer lists' order, so a task that asks for an order of
 * its records (and skips that variant) still has the order inside each record tested.
 */
function nestedArrayOrder(s: EvidenceSnapshot): EvidenceSnapshot | null {
  const out = mapBodies(s, (v) => reverseNested(v)) ?? s;
  const storage = mapStorageJson(out.storage, reverseNested);
  const baseline = out.baseline
    ? { ...out.baseline, storage: mapStorageJson(out.baseline.storage, reverseNested) }
    : undefined;
  const next = { ...out, storage, ...(baseline ? { baseline } : {}) };
  // As JSON.stringify(next) === JSON.stringify(s), comparing only what was rebuilt.
  return sameJson(next, s) ? null : next;
}

/** Local and session storage with `fn` applied to every value that is JSON text of an object or array. */
function mapStorageJson(st: StorageRecord | null, fn: (v: Json) => Json): StorageRecord | null {
  if (!st) return st;
  const value = (x: string | Redacted): string | Redacted => {
    if (typeof x !== 'string') return x;
    let parsed: Json;
    try {
      parsed = JSON.parse(x) as Json;
    } catch {
      return x;
    }
    if (!isObj(parsed)) return x;
    const next = JSON.stringify(fn(parsed));
    return next === JSON.stringify(parsed) ? x : next;
  };
  const area = (a: StorageRecord['local']): StorageRecord['local'] =>
    Object.fromEntries(
      Object.entries(a).map(([origin, kv]) => [
        origin,
        Object.fromEntries(Object.entries(kv).map(([k, x]) => [k, value(x)])),
      ]),
    );
  return { ...st, local: area(st.local), session: area(st.session) };
}

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
    extra.push({ ...e, seq: seq++ });
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
      out.push({ ...e, seq: seq++, status: 503, responseBody: { error: 'Service Unavailable' } });
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
          const snap = editById(
            s,
            (n, id) => {
              if (id !== target) return undefined;
              if (field === 'value' || field === 'url') return { ...n, [field]: next };
              return replaceText(n, span, alt) ?? undefined;
            },
            [target],
          );
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

// --- sameAs tolerance variants -------------------------------------------------

/**
 * A `sameAs` binding with a tolerance accepts values that differ by up to the tolerance:
 * each side in turn moved toward the edge of the tolerance (all of it, or half), in both
 * directions, at a precision its source can show. A check that rejects one is
 * over-constrained by its own reviewed tolerance (or by another check of the set).
 */
function toleranceVariants(cs: CheckSet, s: EvidenceSnapshot, idx: AXIndex): Variant[] {
  const out: Variant[] = [];
  // A side that another assertion also reads (in another check, or a sibling in the same
  // allOf/anyOf/each/page) is left alone: that assertion holds the value to its own terms.
  const readers = new Map<string, Set<Assertion>>();
  const collect = (a: Assertion): void => {
    if (a.kind === 'value')
      for (const r of readsOf(a)) {
        const k = JSON.stringify(r.source);
        readers.set(k, new Set([...(readers.get(k) ?? []), a]));
      }
    const parts = a as { assert?: Assertion; of?: Assertion[] };
    if (parts.assert) collect(parts.assert);
    for (const b of parts.of ?? []) collect(b);
  };
  for (const c of cs.checks) collect(c.assert);
  const sharedWithOther = (src: ValueSource, self: Assertion) =>
    [...(readers.get(JSON.stringify(src)) ?? [])].some((x) => x !== self);
  for (const c of cs.checks) {
    let records = 0;
    for (const { a, rec } of valueAssertions(c.assert, idx)) {
      if (!('sameAs' in a.expect) || !a.expect.sameAs.tolerance) continue;
      if (rec && ++records > 2) break;
      const other = a.expect.sameAs;
      const tol = other.tolerance!;
      const left = readTyped(s, idx, a.source, a.normalize, rec);
      const right = readTyped(s, idx, other.source, other.normalize, rec);
      if (!left || !right || left.type !== right.type) continue;
      const sides = [
        { k: 0, src: a.source, steps: a.normalize, cur: left, base: right },
        { k: 1, src: other.source, steps: other.normalize, cur: right, base: left },
      ];
      for (const { k, src, steps, cur, base } of sides) {
        if (sharedWithOther(src, a)) continue;
        const b = scalarOf(base);
        if (b === undefined) continue;
        const width = Math.max(tol.abs ?? 0, (tol.rel ?? 0) * Math.abs(b));
        for (const sign of [1, -1]) {
          let found: { v: TypedValue; snap: EvidenceSnapshot } | undefined;
          for (const f of [1, 0.5]) {
            for (const g of PRECISIONS[cur.type] ?? []) {
              // Rounded toward the other side, so the precision never takes it past the tolerance.
              const v = fromScalar(cur, snapTo(b + sign * f * width, g, sign < 0));
              if (!v || JSON.stringify(v) === JSON.stringify(cur)) continue;
              const pair = k === 0 ? [v, base] : [base, v];
              let ok: boolean;
              try {
                ok = compareValues(pair[0]!, pair[1]!, tol).ok;
              } catch {
                ok = false;
              }
              if (!ok) continue;
              const edited = rewriteValue(s, idx, src, steps, v, rec);
              if (edited) {
                found = { v, snap: edited };
                break;
              }
            }
            if (found) break;
          }
          if (!found) continue;
          let id = `tolerance:${c.id}:${k ? 'sameAs:' : ''}${sign > 0 ? '+' : '-'}`;
          for (let n = 2; out.some((x) => x.id === id); n++)
            id = `tolerance:${c.id}:${k ? 'sameAs:' : ''}${sign > 0 ? '+' : '-'}#${n}`;
          out.push({
            id,
            description: `${c.id}'s ${k ? 'compared ' : ''}value is ${describeValue(found.v)} instead of ${describeValue(cur)}, within its tolerance of ${describeValue(base)}`,
            snapshot: found.snap,
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
    [
      'nested-array-order',
      'arrays nested inside JSON records (bodies, probe results, storage) in reverse order',
      nestedArrayOrder(s),
    ],
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
    ...formattingVariants(cs, s, AXIndex.of(s.a11y)),
    ...toleranceVariants(cs, s, AXIndex.of(s.a11y)),
  ];
}
