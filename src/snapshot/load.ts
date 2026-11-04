import type { EvidenceSnapshot } from '../types.ts';
import { SNAPSHOT_SCHEMA } from '../types.ts';

/**
 * The accessibility tree's shape: every node an object with a string role, and
 * children (where present) an array of nodes. Checked without recursion, so a
 * deep tree cannot overflow the stack.
 */
function assertTree(root: unknown): void {
  const stack: [unknown, string][] = [[root, 'a11y']];
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

/** Parse and minimally validate a serialized snapshot (envelope, page URL and the accessibility tree's shape). */
export function loadSnapshot(input: string | unknown): EvidenceSnapshot {
  const s = (typeof input === 'string' ? JSON.parse(input) : input) as EvidenceSnapshot;
  if (!s || typeof s !== 'object' || s.schema !== SNAPSHOT_SCHEMA)
    throw new Error(`not an ${SNAPSHOT_SCHEMA} document`);
  if (!s.a11y || typeof s.page?.url !== 'string') throw new Error('snapshot is missing a11y or page');
  assertTree(s.a11y);
  if (s.baseline !== undefined) assertBaseline(s.baseline);
  return s;
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

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
  const st = b.storage;
  if (st !== null && !(isObject(st) && Array.isArray(st.cookies) && isObject(st.local) && isObject(st.session)))
    throw new Error('snapshot baseline.storage is not a storage record or null');
  if (!Array.isArray(b.redacted) || !b.redacted.every((x) => typeof x === 'string'))
    throw new Error('snapshot baseline.redacted is not a list of strings');
}
