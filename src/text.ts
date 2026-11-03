import type { TextMatch } from './types.ts';

/** Canonical text form used for all text matching: NFC, collapsed whitespace, trimmed. */
export function canonical(s: string): string {
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

/** The `g`/`y` flags make RegExp#test stateful; never allow them. */
export function stripGlobal(flags: string | undefined): string {
  return (flags ?? '').replace(/[gy]/g, '');
}
