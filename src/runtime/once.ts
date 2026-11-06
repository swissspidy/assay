/**
 * A value computed on first use and kept. A computation that throws is not kept: it runs
 * (and throws) again on the next use, as it did when the value was computed on every use,
 * so preparing a check ahead never changes where or how a malformed one fails (ADR 0015).
 */
const regexps = new Map<string, RegExp>();

/**
 * `new RegExp(source, flags)`, built once per source and flags. Its `lastIndex` is reset on
 * every call, so a sticky or global regex behaves exactly like a fresh one. A source that
 * does not compile throws, every time, as `new RegExp` does.
 */
export function regExp(source: string, flags?: string): RegExp {
  if (typeof source !== 'string' || (flags !== undefined && typeof flags !== 'string'))
    return new RegExp(source, flags);
  const key = `${flags ?? ''}/${source}`;
  let re = regexps.get(key);
  if (!re) {
    re = new RegExp(source, flags);
    if (regexps.size >= 10_000) regexps.clear();
    regexps.set(key, re);
  }
  re.lastIndex = 0;
  return re;
}

export function once<T>(compute: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = compute();
      done = true;
    }
    return value;
  };
}
