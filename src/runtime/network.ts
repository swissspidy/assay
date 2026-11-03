import type { NetworkEntry, RequestMatch, UrlMatch } from '../types.js';
import { matchText, describeTextMatch } from '../text.js';
import { compareNumber, compileSchema, describeNumberCompare } from './compare.js';

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

export function matchUrl(m: UrlMatch, href: string): boolean {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (m.origin !== undefined && u.origin !== new URL(m.origin).origin) return false;
  if (m.path !== undefined && !matchPath(m.path, u.pathname)) return false;
  if (m.regex !== undefined && !new RegExp(m.regex).test(href)) return false;
  for (const [k, tm] of Object.entries(m.query ?? {})) {
    const v = u.searchParams.get(k);
    if (tm === null) {
      if (v !== null) return false;
    } else if (v === null || !matchText(tm, v)) return false;
  }
  return true;
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

export type MatchResult = 'yes' | 'no' | 'unknown';

/**
 * Three-valued request matching: 'unknown' when the entry could match but the
 * evidence needed to decide (a body, a status) was not captured.
 */
export function matchRequest(m: RequestMatch, e: NetworkEntry): MatchResult {
  if (m.method !== undefined) {
    const methods = (Array.isArray(m.method) ? m.method : [m.method]).map((x) => x.toUpperCase());
    if (!methods.includes(e.method.toUpperCase())) return 'no';
  }
  if (m.url && !matchUrl(m.url, e.url)) return 'no';
  let unknown = false;
  if (m.status !== undefined) {
    if (e.status === null) {
      if (e.failure) return 'no';
      unknown = true; // still in flight
    } else if (typeof m.status === 'number' ? e.status !== m.status : !compareNumber(e.status, m.status)) return 'no';
  }
  if (m.requestBody !== undefined) {
    if (e.requestBody === undefined) return 'no';
    if (e.bodyTruncated) unknown = true;
    else if (!compileSchema(m.requestBody)(e.requestBody)) return 'no';
  }
  if (m.responseBody !== undefined) {
    if (e.responseBody === undefined) {
      if (e.bodyUnavailable || (e.status === null && !e.failure)) unknown = true;
      else return 'no';
    } else if (e.bodyTruncated) unknown = true;
    else if (!compileSchema(m.responseBody)(e.responseBody)) return 'no';
  }
  return unknown ? 'unknown' : 'yes';
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
