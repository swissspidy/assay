import type { NetworkEntry, PageMatch, RequestMatch, TextMatch, UrlMatch } from '../types.ts';
import { textTest, canonical, describeTextMatch } from '../text.ts';
import { compareNumber, compileSchema, describeNumberCompare } from './compare.ts';
import { parseUrl, type ParsedUrl } from '../store/network.ts';
import { once } from './once.ts';

function normPath(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

export function matchPath(pattern: string, pathname: string): boolean {
  const pat = normPath(pattern).split('/');
  const segs = normPath(pathname).split('/');
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i]!;
    if (p === '**' && i === pat.length - 1) return true;
    const s = segs[i];
    if (s === undefined) return false;
    if (p === '*' || (p.startsWith(':') && p.length > 1)) {
      if (s === '') return false;
      continue;
    }
    let decoded = s;
    try {
      decoded = decodeURIComponent(s);
    } catch {
      /* keep raw */
    }
    if (p !== s && p !== decoded) return false;
  }
  return pat.length === segs.length;
}

/** `matchPath(pattern, url.pathname)` with the pattern split once and the URL's segments cached. */
function pathTest(pattern: string): (u: ParsedUrl) => boolean {
  const split = once(() => normPath(pattern).split('/'));
  return (u) => {
    const pat = split();
    const segs = u.segments;
    for (let i = 0; i < pat.length; i++) {
      const p = pat[i]!;
      if (p === '**' && i === pat.length - 1) return true;
      const s = segs[i];
      if (s === undefined) return false;
      if (p === '*' || (p.startsWith(':') && p.length > 1)) {
        if (s === '') return false;
        continue;
      }
      if (p !== s && p !== u.decoded(i)) return false;
    }
    return pat.length === segs.length;
  };
}

/**
 * Prepared matchers are cached per match object (check sets are not edited once they run,
 * ADR 0015); a malformed match that is not an object is prepared anew each time.
 */
function cached<K, V>(make: (k: K) => V): (k: K) => V {
  const cache = new WeakMap<object, V>();
  return (k) => {
    if (!k || typeof k !== 'object') return make(k);
    let v = cache.get(k);
    if (v === undefined) cache.set(k, (v = make(k)));
    return v;
  };
}

/** `matchText(m, actual)` for a match prepared once. */
function prepared(m: TextMatch): (actual: string | undefined) => boolean {
  const test = textTest(m);
  return (actual) => actual !== undefined && test(canonical(actual));
}

/** A URL match prepared once: its origin and path parsed, its regex built, its query matches ready. */
export const urlMatcher = cached((m: UrlMatch): ((href: string) => boolean) => {
  const origin = once(() => new URL(m.origin!).origin);
  const path = m.path !== undefined ? pathTest(m.path) : undefined;
  const regex = once(() => new RegExp(m.regex!));
  const query = once(() =>
    Object.entries(m.query ?? {}).map(([k, tm]) => [k, tm === null ? null : prepared(tm)] as const),
  );
  return (href) => {
    const u = parseUrl(href);
    if (!u) return false;
    if (m.origin !== undefined && u.origin !== origin()) return false;
    if (path && !path(u)) return false;
    if (m.regex !== undefined && !regex().test(href)) return false;
    for (const [k, tm] of query()) {
      const v = u.url.searchParams.get(k);
      if (tm === null) {
        if (v !== null) return false;
      } else if (v === null || !tm(v)) return false;
    }
    return true;
  };
});

export function matchUrl(m: UrlMatch, href: string): boolean {
  return urlMatcher(m)(href);
}

/** A path segment that names one record (an id), not a screen: `12`, a hex digest, a UUID. */
const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * The route a url match names, for `onMissing: "abstain"` (ADR 0011): its origin and the shape
 * of its path, with record ids as wildcards (`/repo/issues/5` names the issue page, whichever
 * issue). `regex` and `query` are outcome, never route: a match without a path has no route,
 * so it is always decided. Returns whether the page URL is on that route.
 */
export function onUrlRoute(m: UrlMatch, href: string): boolean {
  if (m.path === undefined) return true;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (m.origin !== undefined && u.origin !== new URL(m.origin).origin) return false;
  const shape = m.path
    .split('/')
    .map((seg) => (ID_SEGMENT.test(seg) ? '*' : seg))
    .join('/');
  return matchPath(shape, u.pathname);
}

export function describeUrlMatch(m: UrlMatch): string {
  const parts: string[] = [];
  if (m.origin) parts.push(m.origin);
  if (m.path) parts.push(`path ${m.path}`);
  if (m.regex) parts.push(`/${m.regex}/`);
  for (const [k, v] of Object.entries(m.query ?? {}))
    parts.push(v === null ? `no ?${k}` : `?${k} ${describeTextMatch(v)}`);
  return parts.join(', ') || 'any URL';
}

/** A page match prepared once. */
export const pageMatcher = cached((m: PageMatch): ((page: { url: string; title: string }) => boolean) => {
  const title = m.title !== undefined ? prepared(m.title) : undefined;
  return (page) => {
    if (m.url && !urlMatcher(m.url)(page.url)) return false;
    return title === undefined || title(page.title);
  };
});

/** Whether an open page (its URL and title) is the one a `page` assertion selects. */
export function matchPage(m: PageMatch, page: { url: string; title: string }): boolean {
  return pageMatcher(m)(page);
}

export function describePageMatch(m: PageMatch): string {
  const parts: string[] = [];
  if (m.url) parts.push(`URL ${describeUrlMatch(m.url)}`);
  if (m.title !== undefined) parts.push(`title ${describeTextMatch(m.title)}`);
  return parts.join(', ');
}

export type MatchResult = 'yes' | 'no' | 'unknown';

/**
 * Whether the request or the response body of an entry was cut. Entries that say which
 * (requestBodyTruncated, responseBodyTruncated) are read that way; in older ones
 * bodyTruncated covers both.
 */
export function truncated(e: NetworkEntry, which: 'request' | 'response'): boolean {
  if (e.requestBodyTruncated || e.responseBodyTruncated)
    return !!(which === 'request' ? e.requestBodyTruncated : e.responseBodyTruncated);
  return !!e.bodyTruncated;
}

/** A request match prepared once. */
export interface RequestMatcher {
  /** The methods it accepts, upper-cased; undefined for any method. */
  methods(): string[] | undefined;
  test(e: NetworkEntry): MatchResult;
}

export const requestMatcher = cached((m: RequestMatch): RequestMatcher => {
  const methods = once(() =>
    m.method === undefined ? undefined : (Array.isArray(m.method) ? m.method : [m.method]).map((x) => x.toUpperCase()),
  );
  const url = m.url ? urlMatcher(m.url) : undefined;
  const requestBody = once(() => compileSchema(m.requestBody!));
  const responseBody = once(() => compileSchema(m.responseBody!));
  return {
    methods,
    test(e) {
      if (m.method !== undefined) {
        if (!methods()!.includes(e.method.toUpperCase())) return 'no';
      }
      if (url && !url(e.url)) return 'no';
      let unknown = false;
      if (m.status !== undefined) {
        if (e.status === null) {
          if (e.failure) return 'no';
          unknown = true; // still in flight
        } else if (typeof m.status === 'number' ? e.status !== m.status : !compareNumber(e.status, m.status))
          return 'no';
      }
      if (m.requestBody !== undefined) {
        if (e.requestBody === undefined) {
          // A body was sent but could not be read (a multipart upload the page tap did not see).
          if (!e.requestBodyUnavailable) return 'no';
          unknown = true;
        } else if (truncated(e, 'request')) unknown = true;
        else if (!requestBody()(e.requestBody)) return 'no';
      }
      if (m.responseBody !== undefined) {
        if (e.responseBody === undefined) {
          if (e.bodyUnavailable || (e.status === null && !e.failure)) unknown = true;
          else return 'no';
        } else if (truncated(e, 'response')) unknown = true;
        else if (!responseBody()(e.responseBody)) return 'no';
      }
      return unknown ? 'unknown' : 'yes';
    },
  };
});

/**
 * Three-valued request matching: 'unknown' when the entry could match but the
 * evidence needed to decide (a body, a status) was not captured.
 */
export function matchRequest(m: RequestMatch, e: NetworkEntry): MatchResult {
  return requestMatcher(m).test(e);
}

export function describeRequestMatch(m: RequestMatch): string {
  const parts: string[] = [];
  parts.push(m.method ? (Array.isArray(m.method) ? m.method.join('|') : m.method) : 'any method');
  if (m.url) parts.push(describeUrlMatch(m.url));
  if (m.status !== undefined)
    parts.push(typeof m.status === 'number' ? `status ${m.status}` : `status ${describeNumberCompare(m.status)}`);
  if (m.requestBody !== undefined) parts.push('request body matching schema');
  if (m.responseBody !== undefined) parts.push('response body matching schema');
  return parts.join(', ');
}
