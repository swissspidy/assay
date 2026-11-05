import type { EvidenceSnapshot } from '../types.ts';
import { SNAPSHOT_SCHEMA } from '../types.ts';

/**
 * The accessibility tree's shape: every node an object with a string role, and
 * children (where present) an array of nodes. Checked without recursion, so a
 * deep tree cannot overflow the stack.
 */
function assertTree(root: unknown, at = 'a11y'): void {
  const stack: [unknown, string][] = [[root, at]];
  while (stack.length) {
    const [node, path] = stack.pop()!;
    if (!node || typeof node !== 'object' || Array.isArray(node))
      throw new Error(`snapshot ${path} is not an accessibility node`);
    const { role, children } = node as { role?: unknown; children?: unknown };
    if (typeof role !== 'string') throw new Error(`snapshot ${path}.role is not a string`);
    if (children === undefined) continue;
    if (!Array.isArray(children)) throw new Error(`snapshot ${path}.children is not an array`);
    children.forEach((c, i) => stack.push([c, `${path}.children[${i}]`]));
  }
}

/**
 * Parse and minimally validate a serialized snapshot (envelope, page URL, the accessibility
 * tree's shape, and the baseline and other open pages where present). Snapshots written
 * before frames, pages and parsed form bodies were captured load unchanged (ADR 0012).
 */
export function loadSnapshot(input: string | unknown): EvidenceSnapshot {
  const s = (typeof input === 'string' ? JSON.parse(input) : input) as EvidenceSnapshot;
  if (!s || typeof s !== 'object' || s.schema !== SNAPSHOT_SCHEMA)
    throw new Error(`not an ${SNAPSHOT_SCHEMA} document`);
  if (!s.a11y || typeof s.page?.url !== 'string') throw new Error('snapshot is missing a11y or page');
  assertTree(s.a11y);
  if (s.baseline !== undefined) assertBaseline(s.baseline);
  if (s.pages !== undefined) assertPages(s.pages);
  return s;
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Other open pages: each with a URL, title, text and an accessibility tree. `page` checks select among them. */
function assertPages(pages: unknown): void {
  if (!Array.isArray(pages)) throw new Error('snapshot pages is not an array');
  pages.forEach((p: unknown, i) => {
    const at = `pages[${i}]`;
    if (!isObject(p) || typeof p.url !== 'string' || typeof p.title !== 'string' || typeof p.text !== 'string')
      throw new Error(`snapshot ${at} is not a page (url, title, text and a11y)`);
    assertTree(p.a11y, `${at}.a11y`);
  });
}

/**
 * The optional baseline (state before the task): a URL, probe results shaped
 * `{ok, value}` or `{ok: false, error}`, storage (an object or null) and the
 * redacted keys. Checks read it with `at: "before"`, so a malformed one must not load.
 */
function assertBaseline(b: unknown): void {
  if (!isObject(b)) throw new Error('snapshot baseline is not an object');
  if (typeof b.url !== 'string') throw new Error('snapshot baseline.url is not a string');
  if (!isObject(b.probes)) throw new Error('snapshot baseline.probes is not an object');
  for (const [name, r] of Object.entries(b.probes)) {
    const ok = isObject(r) && (r.ok === true ? 'value' in r : r.ok === false && typeof r.error === 'string');
    if (!ok) throw new Error(`snapshot baseline.probes.${name} is not a probe result`);
  }
  if (b.storage !== null) assertStorage(b.storage, 'baseline.storage');
  if (!Array.isArray(b.redacted) || !b.redacted.every((x) => typeof x === 'string'))
    throw new Error('snapshot baseline.redacted is not a list of strings');
}

/** A stored value: a string, or `{redacted: true}` when it was redacted at capture. */
const isStoredValue = (v: unknown) => typeof v === 'string' || (isObject(v) && v.redacted === true);

/**
 * A storage record as the runtime reads it: cookies with a name, domain, path,
 * value and flags, and per-origin maps of web storage values.
 */
function assertStorage(st: unknown, path: string): void {
  if (!isObject(st)) throw new Error(`snapshot ${path} is not a storage record or null`);
  if (!Array.isArray(st.cookies)) throw new Error(`snapshot ${path}.cookies is not an array`);
  st.cookies.forEach((c: unknown, i) => {
    const ok =
      isObject(c) &&
      typeof c.name === 'string' &&
      typeof c.domain === 'string' &&
      typeof c.path === 'string' &&
      isStoredValue(c.value) &&
      typeof c.httpOnly === 'boolean' &&
      typeof c.secure === 'boolean';
    if (!ok) throw new Error(`snapshot ${path}.cookies[${i}] is not a cookie`);
  });
  for (const area of ['local', 'session'] as const) {
    const byOrigin = st[area];
    if (!isObject(byOrigin)) throw new Error(`snapshot ${path}.${area} is not an object`);
    for (const [origin, kv] of Object.entries(byOrigin)) {
      if (!isObject(kv) || !Object.values(kv).every(isStoredValue))
        throw new Error(`snapshot ${path}.${area}[${JSON.stringify(origin)}] is not a map of stored values`);
    }
  }
}
