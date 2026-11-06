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
  }
}

function walk(a: Assertion, rs: ReadSet, roles: Set<string>, inRecord: boolean): void {
  switch (a.kind) {
    case 'state':
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
  }
}
