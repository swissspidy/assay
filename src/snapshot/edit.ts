import type { AXNode, EvidenceSnapshot, Locator } from '../types.ts';
import { AXIndex } from '../runtime/axindex.ts';

/**
 * Immutable snapshot edits. These are the building blocks for mutants and
 * valid variants in stress testing (milestone 3), and for anchor-removal tests.
 */

/** Return a copy of the snapshot with `fn` applied to every a11y node (post-order). Returning null removes the node. */
export function mapA11y(
  snapshot: EvidenceSnapshot,
  fn: (node: AXNode, path: AXNode[]) => AXNode | null,
): EvidenceSnapshot {
  const walk = (node: AXNode, path: AXNode[]): AXNode | null => {
    const children = node.children?.map((c) => walk(c, [...path, node])).filter((c): c is AXNode => c !== null);
    const copy: AXNode = { ...node };
    if (children?.length) copy.children = children;
    else delete copy.children;
    return fn(copy, path);
  };
  const root = walk(structuredClone(snapshot.a11y), []) ?? { role: 'document' };
  return { ...structuredClone(snapshot), a11y: root };
}

/** Apply `fn` to every node matched by the locator (evaluated on the original snapshot). */
export function editNodes(
  snapshot: EvidenceSnapshot,
  locator: Locator,
  fn: (node: AXNode) => AXNode | null,
): EvidenceSnapshot {
  const index = new AXIndex(snapshot.a11y);
  const targets = new Set(index.find(locator).map((n) => n.id));
  // Node ids follow pre-order; recompute them during the walk.
  let id = 0;
  const walk = (node: AXNode): AXNode | null => {
    const myId = id++;
    const children = node.children?.map(walk).filter((c): c is AXNode => c !== null);
    const copy: AXNode = { ...node };
    if (children?.length) copy.children = children;
    else delete copy.children;
    return targets.has(myId) ? fn(copy) : copy;
  };
  const root = walk(structuredClone(snapshot.a11y)) ?? { role: 'document' };
  return { ...structuredClone(snapshot), a11y: root };
}

export const removeNodes = (s: EvidenceSnapshot, locator: Locator) => editNodes(s, locator, () => null);

/** Replace a matched node by its children (e.g. drop a landmark wrapper without dropping its content). */
export function unwrapNodes(s: EvidenceSnapshot, locator: Locator): EvidenceSnapshot {
  const index = new AXIndex(s.a11y);
  const targets = new Set(index.find(locator).map((n) => n.id));
  let id = 0;
  const walk = (node: AXNode): AXNode[] => {
    const myId = id++;
    const children = (node.children ?? []).flatMap(walk);
    if (targets.has(myId)) return children;
    const copy: AXNode = { ...node };
    if (children.length) copy.children = children;
    else delete copy.children;
    return [copy];
  };
  const [root] = walk(structuredClone(s.a11y));
  return { ...structuredClone(s), a11y: root ?? { role: 'document' } };
}
