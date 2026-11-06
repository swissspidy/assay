/**
 * The accessibility tree as columns (ADR 0015): one row per node in pre-order, so a node's
 * subtree is the contiguous id range [id, end[id]) and "descendants of X with role R" is a
 * binary search in R's sorted id list.
 */
import type { AXNode } from '../types.ts';
import { canonical } from '../text.ts';
import { Interner } from './intern.ts';

/** Not computed yet (a lazily filled column). */
const PENDING = -2;
/** No value (a node without a name). */
export const NONE = -1;
/** A name that is not a string (a malformed snapshot): never interned, so reading it throws as before. */
const INVALID = -3;

export class AXTable {
  /** Number of nodes. */
  readonly size: number;
  /** Interned roles (ids fixed once the table is built). */
  readonly roles = new Interner();
  /** Interned canonical names (added to as names are first read). */
  readonly names = new Interner();
  /** The node objects, by id (pre-order position). */
  readonly nodes: AXNode[] = [];
  /** Interned role of each node. */
  readonly role: Uint32Array;
  /** Parent id; -1 for the root. */
  readonly parent: Int32Array;
  /** Depth below the root (the root is 0). */
  readonly depth: Uint32Array;
  /** One past the last id of the node's subtree. */
  readonly end: Int32Array;
  /** Interned canonical name (`canonical(node.name)`), NONE without a name; filled on first read. */
  private name?: Int32Array;
  /** Node ids sorted by role, then id; `roleStart[r]` is where role r's ids begin. Built on first lookup. */
  private roleIds?: Int32Array;
  private roleStart?: Int32Array;
  /** Ids of the nodes of each role by canonical name, ascending; built per role on first lookup. */
  private readonly byRoleName = new Map<number, Map<number, Int32Array> | null>();

  constructor(tree: AXNode) {
    const nodes = this.nodes;
    const roles = this.roles;
    let cap = 256;
    let role = new Uint32Array(cap);
    let parent = new Int32Array(cap);
    let depth = new Uint32Array(cap);
    let end = new Int32Array(cap);
    const grow = () => {
      cap *= 2;
      const r = new Uint32Array(cap);
      r.set(role);
      role = r;
      const p = new Int32Array(cap);
      p.set(parent);
      parent = p;
      const d = new Uint32Array(cap);
      d.set(depth);
      depth = d;
      const e = new Int32Array(cap);
      e.set(end);
      end = e;
    };
    // Pre-order, recursive like the index before it: `children` is read first, so a malformed
    // tree throws the same error at the same node.
    const visit = (node: AXNode, p: number, d: number): void => {
      const kids = node.children;
      const id = nodes.length;
      if (id === cap) grow();
      nodes.push(node);
      role[id] = roles.intern(node.role);
      parent[id] = p;
      depth[id] = d;
      if (kids) for (const c of kids) visit(c, id, d + 1);
      end[id] = nodes.length;
    };
    visit(tree, -1, 0);
    const n = (this.size = nodes.length);
    this.role = role.subarray(0, n);
    this.parent = parent.subarray(0, n);
    this.depth = depth.subarray(0, n);
    this.end = end.subarray(0, n);
  }

  /** The interned canonical name of node `id`: NONE without a name, INVALID for a name that is not a string. */
  private nameId(id: number): number {
    const names = (this.name ??= new Int32Array(this.size).fill(PENDING));
    let n = names[id]!;
    if (n === PENDING) {
      const raw = this.nodes[id]!.name;
      n = raw === undefined ? NONE : typeof raw === 'string' ? this.names.intern(canonical(raw)) : INVALID;
      names[id] = n;
    }
    return n;
  }

  /**
   * The canonical name of node `id` (undefined without a name). A name that is not a string
   * throws here, where `canonical` threw before the store existed.
   */
  canonicalName(id: number): string | undefined {
    const n = this.nameId(id);
    if (n === INVALID) return canonical(this.nodes[id]!.name!);
    return n === NONE ? undefined : this.names.strings[n];
  }

  /** Ids of the nodes with role `role`, ascending (empty when none). */
  withRole(role: string): Int32Array {
    const r = this.roles.lookup(role);
    return r < 0 ? EMPTY : this.ofRole(r);
  }

  /** Ids with interned role `r`, ascending: a counting sort of all ids by role, done once. */
  private ofRole(r: number): Int32Array {
    if (!this.roleIds) {
      const roles = this.roles.size;
      const start = new Int32Array(roles + 1);
      for (let i = 0; i < this.size; i++) start[this.role[i]! + 1]!++;
      for (let k = 0; k < roles; k++) start[k + 1]! += start[k]!;
      const next = start.slice(0, roles);
      const ids = new Int32Array(this.size);
      for (let i = 0; i < this.size; i++) ids[next[this.role[i]!]!++] = i;
      this.roleIds = ids;
      this.roleStart = start;
    }
    return this.roleIds.subarray(this.roleStart![r]!, this.roleStart![r + 1]!);
  }

  /**
   * Ids of the nodes with role `role` whose canonical name is `name` (already canonical),
   * ascending; undefined when a node of that role has a name that is not a string, so the
   * caller scans the role (and throws where it always did).
   */
  withRoleAndName(role: string, name: string): Int32Array | undefined {
    const r = this.roles.lookup(role);
    if (r < 0) return EMPTY;
    let byName = this.byRoleName.get(r);
    if (byName === undefined) {
      const lists = new Map<number, number[]>();
      let invalid = false;
      for (const id of this.ofRole(r)) {
        const n = this.nameId(id);
        if (n === INVALID) invalid = true;
        if (n < 0) continue;
        let l = lists.get(n);
        if (!l) lists.set(n, (l = []));
        l.push(id);
      }
      byName = invalid ? null : new Map([...lists].map(([n, l]) => [n, Int32Array.from(l)] as const));
      this.byRoleName.set(r, byName);
    }
    if (byName === null) return undefined;
    const n = this.names.lookup(name);
    return (n >= 0 && byName.get(n)) || EMPTY;
  }

  /** The ids of `ids` (ascending) that lie in the strict subtree of `scope`: (scope, end[scope]). */
  within(ids: Int32Array, scope: number): Int32Array {
    if (scope === 0 && (ids.length === 0 || ids[0]! > 0)) return ids;
    return ids.subarray(lowerBound(ids, scope + 1), lowerBound(ids, this.end[scope]!));
  }
}

const EMPTY = new Int32Array(0);

/** The first index of sorted `xs` whose value is ≥ `x`. */
function lowerBound(xs: Int32Array, x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
