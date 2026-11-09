/**
 * Declared read-sets (ADR 0015): what each check can read in a snapshot, derived from the
 * check alone. Evidence outside a check's read-set cannot change its result, which is what
 * delta stress testing (re-evaluate only checks whose read-set an edit touches) and scoped
 * capture (capture only what the check set reads) will rely on.
 */
import type { Assertion, Locator, Moment, RequestMatch, Target, ValueSource } from '../types.ts';

export interface ReadSet {
  /** The active page's accessibility tree (locators, scoped text, records). */
  a11y: boolean;
  /** The active page's text (a text source with no scope, outside a record). */
  text: boolean;
  /** The active page's URL (url assertions and sources, and storage read at the page's origin). */
  url: boolean;
  /**
   * The open pages' URLs and titles, the active page's included (a `page` assertion selects
   * one); the selected page's tree, text and URL are read as the flags above say.
   */
  pages: boolean;
  /**
   * The roles the check's locators name (matches, targets, scopes, witnesses, `within` and
   * landmarks), sorted. A hint for scoped capture: derived text, column headers and paths
   * read other nodes of the tree too, so `a11y` still means the whole tree.
   */
  roles: string[];
  /** The requests read: the network log, filtered by these matches (method, URL, status, bodies). */
  requests: RequestMatch[];
  /** Storage keys read; `origin` absent means the page's origin (or host, for cookies). */
  storage: { area: 'cookie' | 'local' | 'session'; key: string; origin?: string; at: Moment }[];
  /** Probe results read (the whole result: pointers select inside it). */
  probes: { probe: string; at: Moment }[];
  /**
   * The trajectory (ADR 0024): the order of requests and navigations a `sequence` reads. Its
   * request steps are also listed in `requests`, since they match through the network log.
   */
  trajectory: boolean;
  /**
   * The check has a part the read-set cannot describe (an unknown assertion kind or value
   * source): it may read anything. Validation rejects such checks; `evaluate` does not.
   */
  opaque: boolean;
}

export const emptyReadSet = (): ReadSet => ({
  a11y: false,
  text: false,
  url: false,
  pages: false,
  roles: [],
  requests: [],
  storage: [],
  probes: [],
  trajectory: false,
  opaque: false,
});

/** What assertion `a` reads. */
export function readSetOf(a: Assertion): ReadSet {
  const rs = emptyReadSet();
  const roles = new Set<string>();
  walk(a, rs, roles, false);
  return finish(rs, roles);
}

/** The union of read-sets (a check set's, from its checks'). */
export function unionReadSets(sets: ReadSet[]): ReadSet {
  const out = emptyReadSet();
  const roles = new Set<string>();
  for (const s of sets) {
    out.a11y ||= s.a11y;
    out.text ||= s.text;
    out.url ||= s.url;
    out.pages ||= s.pages;
    out.trajectory ||= s.trajectory;
    out.opaque ||= s.opaque;
    for (const r of s.roles) roles.add(r);
    out.requests.push(...s.requests);
    out.storage.push(...s.storage);
    out.probes.push(...s.probes);
  }
  return finish(out, roles);
}

const unique = <T>(xs: T[]): T[] => [...new Map(xs.map((x) => [JSON.stringify(x), x] as const)).values()];

function finish(rs: ReadSet, roles: Set<string>): ReadSet {
  return {
    ...rs,
    roles: [...roles].toSorted(),
    requests: [...new Set(rs.requests)],
    storage: unique(rs.storage),
    probes: unique(rs.probes),
  };
}

function locator(l: Locator | undefined, rs: ReadSet, roles: Set<string>): void {
  if (!l) return;
  rs.a11y = true;
  roles.add(l.role);
  if (l.landmark) roles.add(l.landmark.role);
  locator(l.within, rs, roles);
}

function target(t: Target | undefined, rs: ReadSet, roles: Set<string>): void {
  if (!t) return;
  // Resolving a target reads the tree, even one with no locators to resolve.
  rs.a11y = true;
  for (const l of 'anchors' in t ? t.anchors : [t]) locator(l, rs, roles);
}

function source(s: ValueSource, rs: ReadSet, roles: Set<string>, inRecord: boolean): void {
  switch (s.from) {
    case 'node':
      target(s.target, rs, roles);
      return;
    case 'text':
      if (s.scope) target(s.scope, rs, roles);
      else if (inRecord) rs.a11y = true;
      else rs.text = true;
      return;
    case 'url':
      rs.url = true;
      return;
    case 'request':
    case 'response':
      rs.requests.push(s.match);
      return;
    case 'storage':
      if (s.origin === undefined) rs.url = true;
      rs.storage.push({
        area: s.area,
        key: s.key,
        ...(s.origin !== undefined ? { origin: s.origin } : {}),
        at: s.at ?? 'after',
      });
      return;
    case 'probe':
      rs.probes.push({ probe: s.probe, at: s.at ?? 'after' });
      return;
    default:
      rs.opaque = true;
  }
}

function walk(a: Assertion, rs: ReadSet, roles: Set<string>, inRecord: boolean): void {
  switch (a.kind) {
    case 'state':
      rs.a11y = true;
      target(a.target, rs, roles);
      return;
    case 'contains':
      rs.a11y = true;
      target(a.scope, rs, roles);
      locator(a.witness, rs, roles);
      locator(a.match, rs, roles);
      return;
    case 'value':
      source(a.source, rs, roles, inRecord);
      if ('sameAs' in a.expect) source(a.expect.sameAs.source, rs, roles, inRecord);
      return;
    case 'url':
      rs.url = true;
      return;
    case 'request':
      rs.requests.push(a.match);
      return;
    case 'sequence':
      rs.trajectory = true;
      for (const step of a.steps) if ('request' in step) rs.requests.push(step.request);
      return;
    case 'each':
      rs.a11y = true;
      target(a.scope, rs, roles);
      locator(a.witness, rs, roles);
      locator(a.match, rs, roles);
      walk(a.assert, rs, roles, true);
      return;
    case 'page':
      rs.pages = true;
      walk(a.assert, rs, roles, inRecord);
      return;
    case 'allOf':
    case 'anyOf':
      for (const b of a.of) walk(b, rs, roles, inRecord);
      return;
    default:
      rs.opaque = true;
  }
}

/**
 * A part of a snapshot that a check's result can depend on (ADR 0016): a top-level section
 * (`a11y`, `text`, `page`, `pages`, `network`, `storage`, `probes`, `baseline`, `trajectory`), or a part of
 * one: `probes:<name>` (one probe's result), `baseline.storage`, `baseline.probes:<name>`.
 * A key stands for everything under it, so `probes` covers `probes:cart`.
 */
export type ReadKey = string;

/**
 * The parts of a snapshot a read-set can depend on; null when it may read anything
 * (`opaque`). A check's result is a function of these parts alone, so a snapshot that
 * shares them (by identity) with another gets the same result (ADR 0016).
 */
export function readKeys(rs: ReadSet): ReadonlySet<ReadKey> | null {
  if (rs.opaque) return null;
  const out = new Set<ReadKey>();
  if (rs.a11y) out.add('a11y');
  if (rs.text) out.add('text');
  if (rs.url) out.add('page');
  // A page assertion selects among all open pages (their URLs and titles) and reads the selected one.
  if (rs.pages) for (const k of ['page', 'a11y', 'text', 'pages']) out.add(k);
  if (rs.requests.length) out.add('network');
  if (rs.trajectory) out.add('trajectory');
  // Before the task: whether a baseline was captured, then its storage or probe.
  for (const st of rs.storage) out.add(st.at === 'before' ? 'baseline.storage' : 'storage');
  for (const p of rs.probes) out.add(p.at === 'before' ? `baseline.probes:${p.probe}` : `probes:${p.probe}`);
  return out;
}

/**
 * Whether a check that reads `keys` can see a change to `changed` (from `changedKeys`): some
 * key it reads, or a part above one (`baseline` above `baseline.probes:cart`), changed.
 */
export function readsChanged(keys: ReadonlySet<ReadKey>, changed: ReadonlySet<ReadKey>): boolean {
  if (changed.size === 0) return false;
  for (const k of keys) {
    if (changed.has(k)) return true;
    for (let i = 0; i < k.length; i++) {
      const c = k[i];
      if ((c === '.' || c === ':') && changed.has(k.slice(0, i))) return true;
    }
  }
  return false;
}
