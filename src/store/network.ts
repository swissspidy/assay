/**
 * The network log as a table (ADR 0015): entries in capture order with their methods
 * upper-cased and indexed, URLs parsed once, and bodies read through one accessor.
 */
import type { Json, NetworkEntry } from '../types.ts';

/** A URL parsed once, with the parts request and page matching read. */
export class ParsedUrl {
  readonly url: URL;
  private originValue?: string;
  private segmentsValue?: string[];
  private readonly decodedValue: (string | undefined)[] = [];

  constructor(url: URL) {
    this.url = url;
  }

  get origin(): string {
    return (this.originValue ??= this.url.origin);
  }

  /** The path's segments, a trailing slash dropped (as `matchPath` splits a path). */
  get segments(): string[] {
    if (!this.segmentsValue) {
      const p = this.url.pathname;
      this.segmentsValue = (p.length > 1 ? p.replace(/\/+$/, '') : p).split('/');
    }
    return this.segmentsValue;
  }

  /** Segment `i` percent-decoded, or as it is when it does not decode. */
  decoded(i: number): string {
    let d = this.decodedValue[i];
    if (d === undefined) {
      const s = this.segments[i]!;
      try {
        d = decodeURIComponent(s);
      } catch {
        d = s;
      }
      this.decodedValue[i] = d;
    }
    return d;
  }
}

/** Parsed URLs by href, shared: the same URLs recur across the runs of one app. */
const parsed = new Map<string, ParsedUrl | null>();
const MAX_PARSED = 10_000;

/** `href` parsed (null when `new URL` throws), cached by href. */
export function parseUrl(href: string): ParsedUrl | null {
  if (typeof href !== 'string') return tryParse(href);
  let p = parsed.get(href);
  if (p === undefined) {
    if (parsed.size >= MAX_PARSED) parsed.clear();
    parsed.set(href, (p = tryParse(href)));
  }
  return p;
}

function tryParse(href: string): ParsedUrl | null {
  try {
    return new ParsedUrl(new URL(href));
  } catch {
    return null;
  }
}

export class NetworkTable {
  readonly entries: readonly NetworkEntry[];
  readonly size: number;
  private all?: Int32Array;
  /** Entry ids by upper-cased method; null when an entry's method is not a string (scan instead). */
  private methods?: Map<string, Int32Array> | null;

  constructor(entries: readonly NetworkEntry[]) {
    this.entries = entries;
    this.size = entries.length;
  }

  /** All entry ids, in capture order. */
  ids(): Int32Array {
    return (this.all ??= Int32Array.from(this.entries.keys()));
  }

  /**
   * Entry ids whose upper-cased method is one of `upper` (already upper-cased), in capture
   * order; every id when the method index cannot be built.
   */
  withMethods(upper: string[]): Int32Array {
    if (this.methods === undefined) {
      try {
        const m = new Map<string, number[]>();
        this.entries.forEach((e, i) => {
          const k = e.method.toUpperCase();
          let l = m.get(k);
          if (!l) m.set(k, (l = []));
          l.push(i);
        });
        this.methods = new Map([...m].map(([k, l]) => [k, Int32Array.from(l)] as const));
      } catch {
        this.methods = null;
      }
    }
    if (this.methods === null) return this.ids();
    if (upper.length === 1) return this.methods.get(upper[0]!) ?? EMPTY;
    const ids = [...new Set(upper)].flatMap((k) => [...(this.methods!.get(k) ?? EMPTY)]);
    return Int32Array.from(ids.toSorted((a, b) => a - b));
  }

  /** The parsed URL of entry `i` (null when it does not parse). */
  url(i: number): ParsedUrl | null {
    return parseUrl(this.entries[i]!.url);
  }

  /**
   * The request or response body of entry `i`. Bodies of a parsed snapshot are already
   * values; a store read from bytes (a later format) parses them here, on first read.
   */
  body(i: number, which: 'request' | 'response'): Json | undefined {
    const e = this.entries[i]!;
    return which === 'request' ? e.requestBody : e.responseBody;
  }
}

const EMPTY = new Int32Array(0);
const tables = new WeakMap<readonly NetworkEntry[], NetworkTable>();

/** The table of a network log, built once per log object. */
export function networkTable(entries: readonly NetworkEntry[]): NetworkTable {
  let t = tables.get(entries);
  if (!t) tables.set(entries, (t = new NetworkTable(entries)));
  return t;
}
