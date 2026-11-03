/** Low-level, immutable snapshot edits used by variant and mutant generators. */
import type { AXNode, EvidenceSnapshot, Json } from '../types.ts';

export const clone = <T>(x: T): T => structuredClone(x);

/**
 * Rebuild the a11y tree, applying `fn` to nodes by pre-order id (the ids AXIndex
 * assigns). `fn` may return a replacement node, an array (splice), or null (remove).
 */
export function editById(
  snapshot: EvidenceSnapshot,
  fn: (node: AXNode, id: number) => AXNode | AXNode[] | null | undefined,
): EvidenceSnapshot {
  let id = 0;
  const walk = (node: AXNode): AXNode[] => {
    const myId = id++;
    const children = (node.children ?? []).flatMap(walk);
    const copy: AXNode = { ...node };
    if (children.length) copy.children = children;
    else delete copy.children;
    const out = fn(copy, myId);
    if (out === undefined) return [copy];
    if (out === null) return [];
    return Array.isArray(out) ? out : [out];
  };
  const [root] = walk(clone(snapshot.a11y));
  return { ...clone(snapshot), a11y: root ?? { role: 'document' } };
}

/** Replace `from` with `to` in the first text-bearing place under `node` (text runs, then name/value). */
export function replaceText(node: AXNode, from: string, to: string): AXNode | null {
  const n = clone(node);
  const visit = (x: AXNode): boolean => {
    if (x.role === 'text' && x.name?.includes(from)) {
      x.name = x.name.replace(from, to);
      return true;
    }
    for (const c of x.children ?? []) if (visit(c)) return true;
    return false;
  };
  if (visit(n)) {
    if (n.name?.includes(from) && n.children) n.name = n.name.replace(from, to);
    return n;
  }
  if (n.name?.includes(from)) {
    n.name = n.name.replace(from, to);
    return n;
  }
  if (n.value?.includes(from)) {
    n.value = n.value.replace(from, to);
    return n;
  }
  return null;
}

/** RFC 6901 set; returns false if the parent path does not exist. */
export function setPointer(doc: Json, pointer: string, value: Json | undefined): boolean {
  if (!pointer.startsWith('/')) return false;
  const keys = pointer
    .slice(1)
    .split('/')
    .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: Json = doc;
  for (const k of keys.slice(0, -1)) {
    if (cur === null || typeof cur !== 'object') return false;
    cur = Array.isArray(cur) ? cur[Number(k)]! : cur[k]!;
    if (cur === undefined) return false;
  }
  const last = keys.at(-1)!;
  if (cur === null || typeof cur !== 'object') return false;
  if (Array.isArray(cur)) {
    if (value === undefined) cur.splice(Number(last), 1);
    else cur[Number(last)] = value;
  } else if (value === undefined) delete cur[last];
  else cur[last] = value;
  return true;
}

/** A plausible near miss for a JSON value: flip booleans, shift numbers, alter strings. */
export function nearMiss(v: Json): Json {
  if (typeof v === 'boolean') return !v;
  if (typeof v === 'number') return Number.isInteger(v) ? v + 1 : Math.round((v + 1) * 100) / 100;
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
      const d = new Date(v.slice(0, 10) + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10) + v.slice(10);
    }
    if (v === '') return 'x';
    return v.length > 1 ? v.slice(0, -1) + (v.at(-1) === 'x' ? 'y' : 'x') : v + 'x';
  }
  if (v === null) return 'x';
  if (Array.isArray(v)) return v.slice(0, -1);
  return { ...v, __mutated: true };
}
