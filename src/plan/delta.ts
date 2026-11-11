/**
 * Change descriptions for overlay runs (ADR 0029). ADR 0016 re-runs a check on an overlay when
 * a part it reads (a read key: the tree, the network log, one probe) was replaced. Here a
 * replaced part is described more finely (which roles of the tree an edit touched, which
 * network entries it added or removed, which probe values, storage keys and URL parts differ),
 * and a check whose reads of that part provably give what they gave on the base takes the
 * base's result. Whatever cannot be described precisely is treated as changed.
 *
 * The rule throughout: a check's result is a function of what it reads (`FineReads`). A part
 * counts as unchanged for a check only when every read the check can make of it returns the
 * same value on both snapshots, so the result, message and evidence included, is the same.
 */
import type { AXNode, Assertion, Locator, NetworkEntry, RequestMatch, Target, ValueSource } from '../types.ts';
import type { EvidenceSnapshot, StorageRecord } from '../types.ts';
import { regularNode, regularTree } from '../store/ax.ts';
import { parseUrl } from '../store/network.ts';
import { cookiesByName } from '../store/store.ts';
import { requestMatcher } from '../runtime/network.ts';
import { jsonPointer } from '../runtime/json.ts';
import type { ReadKey } from './readset.ts';

/** A read of the page URL: the whole of it, a part a `url` source names, a query parameter, or what storage reads of it. */
export type UrlRead =
  | { href: true }
  | { part: string }
  | { param: string }
  /** The origin a storage read defaults to. */
  | { origin: true }
  /** The host a cookie read defaults to. */
  | { host: true };

/** A storage source, as the check reads it. */
type StorageRead = Extract<ValueSource, { from: 'storage' }>;

/**
 * What a check reads of each part of a snapshot, finely enough to tell whether an overlay's
 * change to that part can reach it. Derived from the check alone.
 */
export interface FineReads {
  /** The roles of every locator (matches, targets, scopes, witnesses, `within`, landmarks, column structure). */
  roles: Set<string>;
  /**
   * The roles whose nodes may be read beyond their own fields: their derived text (a `text`
   * locator, a node's `text` field, scoped or record text, a `text` state), or for a column
   * locator, the rows and tables whose children decide a cell's header.
   */
  deep: Set<string>;
  /** Any change to the tree may be seen: term records (siblings), or a `page` assertion (it selects among pages). */
  treeOpaque: boolean;
  url: UrlRead[];
  /** Request matches, outside a `sequence`. */
  requests: RequestMatch[];
  /** A `sequence` reads the network log through the trajectory: any change to the log may be seen. */
  sequence: boolean;
  probes: { probe: string; at: 'after' | 'before'; pointer: string | undefined }[];
  storage: StorageRead[];
}

/** Roles a column locator reads: the cell's own, the header's, and the rows and tables that place them. */
const COLUMN_ROLES = ['cell', 'gridcell', 'rowheader', 'columnheader', 'row', 'table', 'grid', 'treegrid'];
/** Of those, the ones whose children (not their own fields) decide a header: rows and tables. */
const COLUMN_DEEP = ['row', 'table', 'grid', 'treegrid'];

class Opaque extends Error {}
const opaque = (): never => {
  throw new Opaque();
};

/** What assertion `a` reads, finely; null when some part of it cannot be described (it is re-run whenever a part it reads changes). */
export function fineReadsOf(a: Assertion): FineReads | null {
  const f: FineReads = {
    roles: new Set(),
    deep: new Set(),
    treeOpaque: false,
    url: [],
    requests: [],
    sequence: false,
    probes: [],
    storage: [],
  };
  try {
    walk(a, f, undefined);
  } catch {
    return null;
  }
  return f;
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object';

function locator(l: Locator | undefined, f: FineReads, deep: boolean): void {
  if (l === undefined) return;
  if (!isObject(l) || typeof l.role !== 'string') opaque();
  f.roles.add(l.role);
  // A text match reads the candidate's derived text.
  if (deep || l.text !== undefined) f.deep.add(l.role);
  if (l.landmark !== undefined) {
    // A landmark is matched on an ancestor's own role and name.
    if (!isObject(l.landmark) || typeof l.landmark.role !== 'string') opaque();
    f.roles.add(l.landmark.role);
  }
  if (l.column !== undefined) {
    for (const r of COLUMN_ROLES) f.roles.add(r);
    for (const r of COLUMN_DEEP) f.deep.add(r);
  }
  // `within` tests the whole locator (text included) on ancestors.
  locator(l.within, f, false);
}

function target(t: Target | undefined, f: FineReads, deep: boolean): void {
  if (t === undefined) return;
  if (!isObject(t)) opaque();
  if ('anchors' in t) {
    if (!Array.isArray(t.anchors)) opaque();
    for (const l of t.anchors) locator(l, f, deep);
  } else locator(t, f, deep);
}

/** `record`: inside an `each`, the role of its records (an unscoped text source reads the record's text). */
function source(s: ValueSource, f: FineReads, record: string | undefined): void {
  if (!isObject(s)) opaque();
  switch (s.from) {
    case 'node':
      target(s.target, f, s.field === 'text');
      return;
    case 'text':
      // As the evaluator decides it (`textSourceChannel`): a scope, or a record, makes it tree text.
      if (s.scope !== undefined) target(s.scope, f, true);
      else if (record !== undefined) f.deep.add(record);
      // Unscoped page text is the `text` key, which is not refined.
      return;
    case 'url':
      if (typeof s.part === 'string') f.url.push(s.part === 'href' ? { href: true } : { part: s.part });
      else if (isObject(s.part) && typeof s.part.param === 'string') f.url.push({ param: s.part.param });
      else opaque();
      return;
    case 'request':
    case 'response':
      if (!isObject(s.match)) opaque();
      f.requests.push(s.match);
      return;
    case 'storage':
      if (s.origin === undefined) f.url.push(s.area === 'cookie' ? { host: true } : { origin: true });
      f.storage.push(s);
      return;
    case 'probe':
      if (s.pointer !== undefined && typeof s.pointer !== 'string') opaque();
      f.probes.push({ probe: s.probe, at: s.at === 'before' ? 'before' : 'after', pointer: s.pointer });
      return;
    default:
      opaque();
  }
}

function walk(a: Assertion, f: FineReads, record: string | undefined): void {
  if (!isObject(a)) opaque();
  switch (a.kind) {
    case 'state':
      if (!isObject(a.expect)) opaque();
      target(a.target, f, a.expect.text !== undefined);
      return;
    case 'contains':
      target(a.scope, f, false);
      locator(a.witness, f, false);
      locator(a.match, f, false);
      return;
    case 'value':
      source(a.source, f, record);
      if (!isObject(a.expect)) opaque();
      if ('sameAs' in a.expect) {
        if (!isObject(a.expect.sameAs)) opaque();
        source(a.expect.sameAs.source, f, record);
      }
      return;
    case 'url':
      f.url.push({ href: true });
      return;
    case 'request':
      if (!isObject(a.match)) opaque();
      f.requests.push(a.match);
      return;
    case 'sequence':
      f.sequence = true;
      return;
    case 'each':
      target(a.scope, f, false);
      locator(a.witness, f, false);
      locator(a.match, f, false);
      // A term's record is the term with the definitions after it: it reads the term's siblings.
      if (a.match.role === 'term') f.treeOpaque = true;
      walk(a.assert, f, a.match.role);
      return;
    case 'page':
      // The page is selected among all open pages; its tree may not be the active page's.
      f.treeOpaque = true;
      walk(a.assert, f, record);
      return;
    case 'allOf':
    case 'anyOf':
      if (!Array.isArray(a.of)) opaque();
      for (const b of a.of) walk(b, f, record);
      return;
    default:
      opaque();
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const plain = (x: object): boolean => {
  const p = Object.getPrototypeOf(x) as unknown;
  return p === Object.prototype || p === null;
};

/**
 * Whether `a` and `b` are the same JSON value, strictly: the same primitives (`Object.is`), and
 * arrays and plain objects with the same own keys in the same order and the same values. Anything
 * else (another prototype, a hole) is not the same unless it is the same object.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!(i in a) || !(i in b)) return false;
      if (!sameValue(a[i], b[i])) return false;
    }
    return Reflect.ownKeys(a).length === Reflect.ownKeys(b).length;
  }
  if (Array.isArray(b) || !plain(a) || !plain(b)) return false;
  return sameFields(a, b, undefined);
}

/** Whether two plain objects have the same own keys, in order, with the same values; `skip` is left out. */
function sameFields(a: object, b: object, skip: string | undefined): boolean {
  const ka = Reflect.ownKeys(a);
  const kb = Reflect.ownKeys(b);
  // A key one has and the other has not: different, without comparing any value.
  const count = (ks: (string | symbol)[], o: object) =>
    ks.length - (skip !== undefined && Object.prototype.hasOwnProperty.call(o, skip) ? 1 : 0);
  if (count(ka, a) !== count(kb, b)) return false;
  let i = 0;
  let j = 0;
  for (;;) {
    while (i < ka.length && ka[i] === skip) i++;
    while (j < kb.length && kb[j] === skip) j++;
    if (i === ka.length || j === kb.length) return i === ka.length && j === kb.length;
    const k = ka[i++]!;
    if (k !== kb[j++]) return false;
    if (!sameValue((a as Record<PropertyKey, unknown>)[k], (b as Record<PropertyKey, unknown>)[k])) return false;
  }
}

// ---------------------------------------------------------------------------
// What an overlay changed
// ---------------------------------------------------------------------------

/**
 * How an overlay's tree differs from its base's. The trees are compared position by position:
 * nodes that are the same object are the same subtree; two nodes with the same own fields
 * (everything but `children`) are *kept* and their children compared (the identical ones at
 * either end aligned, the rest pairwise when as many remain, else replaced); any other pair
 * is *replaced*, every node of both subtrees touched.
 */
export interface TreeDelta {
  /** The roles of every node in a replaced subtree, on either side. */
  touched: Set<unknown>;
  /** The roles of the kept nodes whose subtree changed (their derived text and children may differ). */
  kept: Set<unknown>;
}

/**
 * At most this many node visits per tree delta. An edit that reaches further (doubled spaces in
 * every name, main wrapped in a region) touches most roles, so nearly every check of the tree
 * sees it anyway; it is not described, which costs a re-run, never a wrong result.
 */
export const TREE_DELTA_BUDGET = Number(process.env.BUDGET ?? 64);

/**
 * The tree delta of `base` → `next`; null when it is not described: either tree is not regular
 * (`regularTree`), or describing it would visit more than `budget` nodes. A delta establishes
 * that `next` is regular: each of its nodes is either checked here or in a subtree it shares
 * with the regular `base`.
 */
export function treeDelta(base: AXNode, next: AXNode, budget = TREE_DELTA_BUDGET): TreeDelta | null {
  if (!regularTree(base) || !next || typeof next !== 'object') return null;
  const d: TreeDelta = { touched: new Set(), kept: new Set() };
  let left = budget;
  /** Every node of a subtree touched; on the overlay's side, each checked to be regular. */
  const touch = (n: AXNode, check: boolean): boolean => {
    if (--left < 0 || (check && !regularNode(n))) return false;
    d.touched.add(n.role);
    const kids = n.children;
    if (kids) for (let i = 0; i < kids.length; i++) if (!touch(kids[i]!, check)) return false;
    return true;
  };
  const FAIL = -1;
  const SAME = 0;
  const CHANGED = 1;
  const replaced = (a: AXNode, b: AXNode) => (touch(a, false) && touch(b, true) ? CHANGED : FAIL);
  /** Compares a pair at the same position: SAME, CHANGED (recorded in `d`), or FAIL (not regular, or over budget). */
  const diff = (a: AXNode, b: AXNode): number => {
    if (a === b) return SAME;
    if (--left < 0 || !regularNode(b)) return FAIL;
    // Role and name first: they differ in most replaced pairs.
    if (a.role !== b.role || a.name !== b.name || !sameFields(a, b, 'children')) return replaced(a, b);
    const ka = a.children ?? [];
    const kb = b.children ?? [];
    let lo = 0;
    while (lo < ka.length && lo < kb.length && ka[lo] === kb[lo]) lo++;
    let ea = ka.length;
    let eb = kb.length;
    while (ea > lo && eb > lo && ka[ea - 1] === kb[eb - 1]) {
      ea--;
      eb--;
    }
    let out = SAME;
    if (ea - lo === eb - lo)
      for (let i = lo; i < ea; i++) {
        const r = diff(ka[i]!, kb[i]!);
        if (r === FAIL) return FAIL;
        out ||= r;
      }
    else {
      for (let i = lo; i < ea; i++) if (!touch(ka[i]!, false)) return FAIL;
      for (let i = lo; i < eb; i++) if (!touch(kb[i]!, true)) return FAIL;
      out = CHANGED;
    }
    // Kept: its own fields are the same, but its subtree (its derived text, its children) changed.
    if (out === CHANGED) d.kept.add(a.role);
    return out;
  };
  return diff(base, next) === FAIL ? null : d;
}

/**
 * The network entries an overlay added or removed (by identity); null when the entries both
 * logs hold are not in the same order, or a log holds an entry twice, or either is not a list.
 */
export function networkDelta(base: unknown, next: unknown): NetworkEntry[] | null {
  if (!Array.isArray(base) || !Array.isArray(next)) return null;
  const a = new Set<NetworkEntry>(base);
  const b = new Set<NetworkEntry>(next);
  if (a.size !== base.length || b.size !== next.length) return null;
  const changed: NetworkEntry[] = [];
  let i = 0;
  for (const e of next) {
    if (!a.has(e)) {
      changed.push(e);
      continue;
    }
    // The next shared entry must be the base's next entry that the overlay kept.
    while (i < base.length && !b.has(base[i])) changed.push(base[i++]);
    if (base[i] !== e) return null;
    i++;
  }
  for (; i < base.length; i++) changed.push(base[i]);
  return changed;
}

const safeOrigin = (u: string): string | null => parseUrl(u)?.origin ?? null;

/** Whether reading `r` of the page URL gives the same on `a` as on `b` (results included: an unparseable URL is echoed). */
export function sameUrlRead(a: string, b: string, r: UrlRead): boolean {
  if (a === b) return true;
  if ('href' in r) return false;
  const pa = parseUrl(a);
  const pb = parseUrl(b);
  if ('origin' in r) return (pa?.origin ?? null) === (pb?.origin ?? null);
  if ('host' in r) return (pa?.url.hostname ?? null) === (pb?.url.hostname ?? null);
  if (!pa || !pb) return false;
  if ('param' in r) {
    const va = pa.url.searchParams.get(r.param);
    const vb = pb.url.searchParams.get(r.param);
    // An absent parameter's result shows the whole URL.
    return va !== null && va === vb;
  }
  return Object.is(
    (pa.url as unknown as Record<string, unknown>)[r.part],
    (pb.url as unknown as Record<string, unknown>)[r.part],
  );
}

const NO_COOKIES: readonly unknown[] = [];
const hasKey = (area: unknown, key: string) => !!area && Object.prototype.hasOwnProperty.call(area, key);

/** Whether storage read `s` gives the same on both snapshots (`a`, `b`: their storage records at the read's moment). */
function sameStorageRead(
  s: StorageRead,
  a: StorageRecord | null | undefined,
  b: StorageRecord | null | undefined,
  urlA: string,
  urlB: string,
): boolean {
  if (!a || !b) return !a && !b;
  if (s.area === 'cookie')
    return sameValue(cookiesByName(a).get(s.key) ?? NO_COOKIES, cookiesByName(b).get(s.key) ?? NO_COOKIES);
  const oa = s.origin ? safeOrigin(s.origin) : safeOrigin(urlA);
  const ob = s.origin ? safeOrigin(s.origin) : safeOrigin(urlB);
  if (oa !== ob) return false;
  const x = a[s.area][oa ?? ''];
  const y = b[s.area][ob ?? ''];
  const hx = hasKey(x, s.key);
  if (hx !== hasKey(y, s.key)) return false;
  return !hx || sameValue(x![s.key], y![s.key]);
}

/** Whether a probe read gives the same on both results (`a`, `b`: the probe's result on each snapshot). */
function sameProbeRead(pointer: string | undefined, a: unknown, b: unknown): boolean {
  if (!a || !b) return !a && !b;
  const x = a as { ok?: unknown; error?: unknown; value?: unknown };
  const y = b as typeof x;
  if (!x.ok !== !y.ok) return false;
  if (!x.ok) return Object.is(x.error, y.error);
  return sameValue(jsonPointer(x.value as never, pointer), jsonPointer(y.value as never, pointer));
}

/**
 * What an overlay changed of its base (ADR 0029): `changed`, the read keys it replaced
 * (`changedKeys`), each described further on first need.
 */
export class OverlayChange {
  readonly base: EvidenceSnapshot;
  readonly next: EvidenceSnapshot;
  readonly changed: ReadonlySet<ReadKey>;
  private treeValue?: TreeDelta | null;
  private networkValue?: NetworkEntry[] | null;
  /** What has been found, by read: several checks often make the same read of a changed part. */
  private memo?: Map<unknown, boolean>;

  constructor(base: EvidenceSnapshot, next: EvidenceSnapshot, changed: ReadonlySet<ReadKey>) {
    this.base = base;
    this.next = next;
    this.changed = changed;
  }

  /** The tree delta (computed once); null when it cannot be described. */
  get tree(): TreeDelta | null {
    if (this.treeValue === undefined)
      this.treeValue = this.changed.has('a11y') ? treeDelta(this.base.a11y, this.next.a11y) : null;
    return this.treeValue;
  }

  /** The network entries added or removed (computed once); null when that cannot be described. */
  get network(): NetworkEntry[] | null {
    if (this.networkValue === undefined) this.networkValue = networkDelta(this.base.network, this.next.network);
    return this.networkValue;
  }

  /**
   * Whether a check that reads `keys` (finely: `fine`) may see this change: a key it reads,
   * or a part above one, changed, and the change to it cannot be shown to miss every read the
   * check makes of it. With `fine` null this is `readsChanged(keys, changed)`.
   */
  sees(keys: ReadonlySet<ReadKey>, fine: FineReads | null): boolean {
    const changed = this.changed;
    if (changed.size === 0) return false;
    for (const k of keys) {
      for (let i = 0; i < k.length; i++) {
        const c = k[i];
        if ((c === '.' || c === ':') && changed.has(k.slice(0, i))) return true;
      }
      if (!changed.has(k)) continue;
      if (!fine) return true;
      let unseen: boolean;
      try {
        unseen = this.misses(k, fine);
      } catch {
        unseen = false;
      }
      if (!unseen) return true;
    }
    return false;
  }

  private once(key: unknown, f: () => boolean): boolean {
    const memo = (this.memo ??= new Map());
    let v = memo.get(key);
    if (v === undefined) memo.set(key, (v = f()));
    return v;
  }

  /** Whether the change to key `k` (which changed) gives every read `fine` makes of it the same value. */
  private misses(k: ReadKey, fine: FineReads): boolean {
    const a = this.base;
    const b = this.next;
    if (k === 'a11y') {
      if (fine.treeOpaque) return false;
      const t = this.tree;
      if (!t) return false;
      for (const r of t.touched) if (fine.roles.has(r as string)) return false;
      for (const r of t.kept) if (fine.deep.has(r as string)) return false;
      return true;
    }
    if (k === 'page') {
      // A page assertion reads every open page's URL and title.
      if (fine.treeOpaque || fine.url.length === 0) return false;
      return fine.url.every((r) => sameUrlRead(a.page.url, b.page.url, r));
    }
    if (k === 'network') {
      if (fine.sequence || fine.requests.length === 0) return false;
      const changed = this.network;
      if (!changed) return false;
      // An entry no match accepts (or could accept) is never among a check's hits or unknowns,
      // and the entries both logs hold keep their order: every match reads the same entries.
      return fine.requests.every((m) => this.once(m, () => changed.every((e) => requestMatcher(m).test(e) === 'no')));
    }
    if (k === 'storage' || k === 'baseline.storage') {
      const before = k === 'baseline.storage';
      const reads = fine.storage.filter((s) => (s.at === 'before') === before);
      if (reads.length === 0) return false;
      const sa = before ? a.baseline!.storage : a.storage;
      const sb = before ? b.baseline!.storage : b.storage;
      return reads.every((s) => sameStorageRead(s, sa, sb, a.page.url, b.page.url));
    }
    const probe = k.startsWith('probes:') ? 'after' : k.startsWith('baseline.probes:') ? 'before' : undefined;
    if (probe) {
      const name = k.slice(probe === 'after' ? 7 : 16);
      const reads = fine.probes.filter((p) => p.at === probe && p.probe === name);
      if (reads.length === 0) return false;
      const pa = (probe === 'after' ? a.probes : a.baseline!.probes)[name];
      const pb = (probe === 'after' ? b.probes : b.baseline!.probes)[name];
      return reads.every((p) => this.once(`${k}\0${p.pointer ?? ''}`, () => sameProbeRead(p.pointer, pa, pb)));
    }
    // The page text, other pages, the trajectory and the rest are not described further.
    return false;
  }
}
