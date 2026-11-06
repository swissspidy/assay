import type { TextMatch } from './types.ts';

/** Printable ASCII words separated by single spaces: already canonical. */
const PLAIN = /^[!-~]+(?: [!-~]+)*$/;

/** Canonical text form used for all text matching: NFC, collapsed whitespace, trimmed. */
export function canonical(s: string): string {
  if (typeof s === 'string' && PLAIN.test(s)) return s;
  return s.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

export function describeTextMatch(m: TextMatch): string {
  if (typeof m === 'string') return JSON.stringify(m);
  if ('equals' in m) return `${JSON.stringify(m.equals)}${m.ignoreCase ? ' (any case)' : ''}`;
  if ('contains' in m) return `containing ${JSON.stringify(m.contains)}${m.ignoreCase ? ' (any case)' : ''}`;
  return `/${m.regex}/${m.flags ?? ''}`;
}

export function matchText(m: TextMatch, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const a = canonical(actual);
  if (typeof m === 'string') return a === canonical(m);
  if ('equals' in m) {
    const e = canonical(m.equals);
    return m.ignoreCase ? a.toLowerCase() === e.toLowerCase() : a === e;
  }
  if ('contains' in m) {
    const e = canonical(m.contains);
    return m.ignoreCase ? a.toLowerCase().includes(e.toLowerCase()) : a.includes(e);
  }
  return new RegExp(m.regex, stripGlobal(m.flags)).test(a);
}

/** A text match prepared once: tests text that is already canonical. */
export type TextTest = (canonicalActual: string) => boolean;

/**
 * `matchText` prepared for repeated use (ADR 0015): the expected text canonicalized and the
 * regex built once, on the first call, so a malformed match throws where `matchText` threw.
 * `test(canonical(actual))` equals `matchText(m, actual)` for any defined `actual`.
 */
export function textTest(m: TextMatch): TextTest {
  let fn: TextTest | undefined;
  return (a) => (fn ??= buildTextTest(m))(a);
}

function buildTextTest(m: TextMatch): TextTest {
  if (typeof m === 'string') {
    const e = canonical(m);
    return (a) => a === e;
  }
  if ('equals' in m) {
    const e = canonical(m.equals);
    if (!m.ignoreCase) return (a) => a === e;
    const lower = e.toLowerCase();
    return (a) => a.toLowerCase() === lower;
  }
  if ('contains' in m) {
    const e = canonical(m.contains);
    if (!m.ignoreCase) return (a) => a.includes(e);
    const lower = e.toLowerCase();
    return (a) => a.toLowerCase().includes(lower);
  }
  const re = new RegExp(m.regex, stripGlobal(m.flags));
  return (a) => re.test(a);
}

/**
 * The canonical text a match accepts exactly (a string, or `equals` without `ignoreCase`), so a
 * lookup by name can replace a scan; undefined for other matches or a malformed one.
 */
export function exactText(m: TextMatch | undefined): string | undefined {
  try {
    if (typeof m === 'string') return canonical(m);
    if (m && typeof m === 'object' && 'equals' in m && !m.ignoreCase && typeof m.equals === 'string')
      return canonical(m.equals);
  } catch {
    /* scanned instead */
  }
  return undefined;
}

/** The `g`/`y` flags make RegExp#test stateful; never allow them. */
export function stripGlobal(flags: string | undefined): string {
  return (flags ?? '').replace(/[gy]/g, '');
}
