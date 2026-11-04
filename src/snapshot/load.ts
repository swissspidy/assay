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
  return s;
}
