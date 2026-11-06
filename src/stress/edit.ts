/** Low-level, immutable snapshot edits used by variant and mutant generators. */
import type { AXNode, EvidenceSnapshot, Json } from '../types.ts';
import { formatInstant } from '../runtime/values.ts';
import { AXIndex, type INode } from '../runtime/axindex.ts';
import { plainNode, regularTree } from '../store/ax.ts';

export const clone = <T>(x: T): T => structuredClone(x);

/**
 * Rebuild the a11y tree, applying `fn` to nodes by pre-order id (the ids AXIndex
 * assigns). `fn` may return a replacement node, an array (splice), or null (remove).
 * Only the tree is rebuilt; the rest of the snapshot is shared, so callers that
 * change other parts must copy them.
 *
 * The new tree shares every subtree the edit left alone with the old one (ADR 0016): a node
 * is copied only when its children changed or it had an empty `children` list (which the
 * copy drops). `fn` gets that node, and must not edit it: it returns a new node instead.
 *
 * `only`, when given, lists every id for which `fn` may return something other than
 * undefined: `fn` is then called for those alone, and only their ancestors are rebuilt
 * (in a tree whose `children` lists are all non-empty; any other tree is walked whole).
 */
export function editById(
  snapshot: EvidenceSnapshot,
  fn: (node: AXNode, id: number) => AXNode | AXNode[] | null | undefined,
  only?: Iterable<number>,
): EvidenceSnapshot {
  if (only !== undefined && regularTree(snapshot.a11y)) return editAt(snapshot, fn, only);
  let id = 0;
  // Appends what `node` becomes (none, one or several nodes) to `out`.
  const walk = (node: AXNode, out: AXNode[]): void => {
    const myId = id++;
    const kids = node.children;
    let copy = node;
    if (kids !== undefined || Object.hasOwn(node, 'children')) {
      let children: AXNode[];
      let same: boolean;
      if (Array.isArray(kids)) {
        children = [];
        // An inherited list is copied into the node, as `{ ...node }` and the new list always did.
        same = kids.length > 0 && Object.hasOwn(node, 'children');
        for (let i = 0; i < kids.length; i++) {
          if (!(i in kids)) continue; // a hole, as flatMap skips it
          const k = kids[i]!;
          const at = children.length;
          walk(k, children);
          if (same && (children.length !== at + 1 || children[at] !== k)) same = false;
        }
        if (children.length !== kids.length) same = false;
      } else {
        // Not a list (a malformed tree): fails as it always did.
        children = (kids ?? []).flatMap((k: AXNode) => {
          const o: AXNode[] = [];
          walk(k, o);
          return o;
        });
        same = false;
      }
      if (!same) {
        copy = { ...node };
        if (children.length) copy.children = children;
        else delete copy.children;
      }
    }
    // A node with a prototype of its own is copied as before: the copy keeps own fields only.
    if (copy === node && !plainNode(node)) copy = { ...node };
    const r = fn(copy, myId);
    if (r === undefined) out.push(copy);
    else if (r === null) return;
    else if (Array.isArray(r)) out.push(...r);
    else out.push(r);
  };
  const roots: AXNode[] = [];
  walk(snapshot.a11y, roots);
  return { ...snapshot, a11y: roots[0] ?? { role: 'document' } };
}

/** `editById` for a regular tree when the ids `fn` edits are known: rebuilds their ancestors only. */
function editAt(
  snapshot: EvidenceSnapshot,
  fn: (node: AXNode, id: number) => AXNode | AXNode[] | null | undefined,
  only: Iterable<number>,
): EvidenceSnapshot {
  const idx = AXIndex.of(snapshot.a11y);
  const targets = new Set<number>();
  // The targets and their ancestors: the nodes the full walk could copy.
  const path = new Set<number>();
  for (const t of only) {
    const n = idx.all[t];
    if (!n || n.id !== t) continue;
    targets.add(t);
    for (let a: INode | null = n; a && !path.has(a.id); a = a.parent) path.add(a.id);
  }
  // As the full walk: post-order, so `fn` sees a node's edited children, in the same order.
  const walk = (n: INode, out: AXNode[]): void => {
    if (!path.has(n.id)) {
      out.push(n.node);
      return;
    }
    const node = n.node;
    let copy = node;
    if (n.children.length) {
      const children: AXNode[] = [];
      let same = true;
      for (const c of n.children) {
        const at = children.length;
        walk(c, children);
        if (same && (children.length !== at + 1 || children[at] !== c.node)) same = false;
      }
      if (!same) {
        copy = { ...node };
        if (children.length) copy.children = children;
        else delete copy.children;
      }
    }
    if (!targets.has(n.id)) {
      out.push(copy);
      return;
    }
    const r = fn(copy, n.id);
    if (r === undefined) out.push(copy);
    else if (r === null) return;
    else if (Array.isArray(r)) out.push(...r);
    else out.push(r);
  };
  const roots: AXNode[] = [];
  walk(idx.root, roots);
  return { ...snapshot, a11y: roots[0] ?? { role: 'document' } };
}

/** Did an edit change the accessibility tree at all? (Generators drop no-op edits.) */
export function treeChanged(a: EvidenceSnapshot, b: EvidenceSnapshot): boolean {
  return !sameJson(a.a11y, b.a11y);
}

const plain = (x: unknown): x is Record<string, unknown> => {
  if (x === null || typeof x !== 'object') return false;
  const p = Object.getPrototypeOf(x) as unknown;
  return p === Object.prototype || p === null || p === Array.prototype;
};
/** An object JSON.stringify writes field by field: plain, and no `toJSON` (which may depend on its key). */
const literal = (x: unknown): x is Record<string, unknown> =>
  plain(x) && typeof (x as { toJSON?: unknown }).toJSON !== 'function';
/** What JSON.stringify writes for a value in an array: undefined, functions and symbols as null. */
const inArray = (x: unknown) => (x === undefined || typeof x === 'function' || typeof x === 'symbol' ? null : x);
/** Does JSON.stringify keep this property? */
const kept = (x: unknown) => x !== undefined && typeof x !== 'function' && typeof x !== 'symbol';

/** An object value JSON.stringify does not write field by field. */
const opaque = (v: unknown) => v !== null && typeof v === 'object' && !literal(v);

/** `structural` could not tell: a value JSON.stringify writes some other way (toJSON, a Date, a Map). */
const UNSURE = 2;

/**
 * 1 when `a` and `b`, found under the same key, serialize the same; 0 when not; UNSURE when
 * that depends on how JSON.stringify writes an object that is not a literal.
 */
function structural(a: unknown, b: unknown): 0 | 1 | typeof UNSURE {
  // The same value under the same key: the same JSON, toJSON(key) included.
  if (a === b) return 1;
  const ao = a !== null && typeof a === 'object';
  const bo = b !== null && typeof b === 'object';
  if ((ao && !literal(a)) || (bo && !literal(b))) return UNSURE;
  if (!ao || !bo) return ao || bo ? 0 : JSON.stringify(a) === JSON.stringify(b) ? 1 : 0;
  if (Array.isArray(a) !== Array.isArray(b)) return 0;
  if (Array.isArray(a)) {
    const y = b as unknown as unknown[];
    if (a.length !== y.length) return 0;
    for (let i = 0; i < a.length; i++) {
      const r = structural(inArray(a[i]), inArray(y[i]));
      if (r !== 1) return r;
    }
    return 1;
  }
  const x = a as Record<string, unknown>;
  const z = b as Record<string, unknown>;
  // Which fields are written can depend on a non-literal value (a toJSON giving undefined).
  const ka = Object.keys(x);
  const kb = Object.keys(z);
  if (ka.some((k) => opaque(x[k])) || kb.some((k) => opaque(z[k]))) return UNSURE;
  return sameFields(
    x,
    z,
    ka.filter((k) => kept(x[k])),
    kb.filter((k) => kept(z[k])),
  );
}

/** The kept fields `ka` of `x` and `kb` of `z`, in order, compared as `structural` compares values. */
function sameFields(
  x: Record<string, unknown>,
  z: Record<string, unknown>,
  ka: string[],
  kb: string[],
): 0 | 1 | typeof UNSURE {
  if (ka.length !== kb.length) return 0;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return 0;
    const r = structural(x[ka[i]!], z[kb[i]!]);
    if (r !== 1) return r;
  }
  return 1;
}

/**
 * `JSON.stringify(a) === JSON.stringify(b)`, without writing either: shared subtrees (the
 * same object) are equal without a look inside, which is what makes comparing an edited
 * tree or body with its original cheap. Values JSON.stringify writes some other way (with
 * `toJSON`, or not plain objects) are compared by writing both.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  const r = structural(a, b);
  return r === UNSURE ? JSON.stringify(a) === JSON.stringify(b) : r === 1;
}

const replaceOnce = (s: string, from: string, to: string) => s.replace(from, () => to);

/** Replace `from` with `to` in the first text-bearing place under `node` (text runs, then name/value). */
export function replaceText(node: AXNode, from: string, to: string): AXNode | null {
  const n = clone(node);
  const visit = (x: AXNode): boolean => {
    if (x.role === 'text' && x.name?.includes(from)) {
      x.name = replaceOnce(x.name, from, to);
      return true;
    }
    for (const c of x.children ?? []) if (visit(c)) return true;
    return false;
  };
  if (visit(n)) {
    if (n.name?.includes(from) && n.children) n.name = replaceOnce(n.name, from, to);
    return n;
  }
  if (n.name?.includes(from)) {
    n.name = replaceOnce(n.name, from, to);
    return n;
  }
  if (n.value?.includes(from)) {
    n.value = replaceOnce(n.value, from, to);
    return n;
  }
  return null;
}

const shallowCopy = (x: Json): Json => (Array.isArray(x) ? x.slice() : { ...(x as Record<string, Json>) });

/**
 * `setPointer` on a copy of `doc`, copying only the objects and arrays on the path (the
 * rest is shared with `doc`): what `setPointer(clone(doc), pointer, value)` leaves in the
 * copy, or undefined where it returns false.
 */
export function withPointer(doc: Json, pointer: string, value: Json | undefined): { doc: Json } | undefined {
  if (!pointer.startsWith('/')) return undefined;
  const keys = pointer
    .slice(1)
    .split('/')
    .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
  const chain: Json[] = [doc];
  let cur: Json = doc;
  for (const k of keys.slice(0, -1)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? cur[Number(k)]! : cur[k]!;
    if (cur === undefined) return undefined;
    chain.push(cur);
  }
  if (cur === null || typeof cur !== 'object') return undefined;
  let child = shallowCopy(cur);
  setPointer(child, `/${keys.at(-1)!.replace(/~/g, '~0').replace(/\//g, '~1')}`, value);
  for (let i = chain.length - 2; i >= 0; i--) {
    const parent = shallowCopy(chain[i]!);
    const k = keys[i]!;
    if (Array.isArray(parent)) parent[Number(k)] = child;
    else (parent as Record<string, Json>)[k] = child;
    child = parent;
  }
  return { doc: child };
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

export function shiftDate(iso: string, days: number): string {
  const d = new Date(iso.slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10) + iso.slice(10);
}

/** Shift an instant ("…Z") by minutes (to the millisecond), keeping its canonical form. */
export function shiftInstant(iso: string, minutes: number): string {
  return formatInstant(Date.parse(iso) + Math.round(minutes * 60_000));
}

/**
 * A plausible near miss for a JSON value: flip booleans, shift numbers and
 * dates, alter one character of strings, change one leaf of an object, drop an
 * array's last item. `undefined` when no near miss exists (empty array/object).
 */
export function nearMiss(v: Json): Json | undefined {
  if (typeof v === 'boolean') return !v;
  if (typeof v === 'number') return Number.isInteger(v) ? v + 1 : Math.round((v + 1) * 100) / 100;
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(`${v.slice(0, 10)}T00:00:00Z`)))
      return shiftDate(v, 1);
    if (v === '') return 'x';
    return v.length > 1 ? v.slice(0, -1) + (v.at(-1) === 'x' ? 'y' : 'x') : v + 'x';
  }
  if (v === null) return 'x';
  if (Array.isArray(v)) return v.length ? v.slice(0, -1) : undefined;
  for (const [k, x] of Object.entries(v)) {
    const m = nearMiss(x);
    if (m !== undefined) return { ...v, [k]: m };
  }
  return undefined;
}
