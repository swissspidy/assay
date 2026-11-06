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
  private namesValue?: Interner;
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
  private byRoleNameValue?: Map<number, Map<number, Int32Array> | null>;

  /** Interned canonical names (added to as names are first read). */
  get names(): Interner {
    return (this.namesValue ??= new Interner());
  }

  private get byRoleName(): Map<number, Map<number, Int32Array> | null> {
    return (this.byRoleNameValue ??= new Map());
  }

  constructor(tree: AXNode) {
    const nodes = this.nodes;
    const roles = this.roles;
    // Collected in plain arrays, then copied into one buffer of exactly the tree's size.
    const roleOf: number[] = [];
    const parentOf: number[] = [];
    const depthOf: number[] = [];
    const endOf: number[] = [];
    // Pre-order, recursive like the index before it: `children` is read first, so a malformed
    // tree throws the same error at the same node.
    const visit = (node: AXNode, p: number, d: number): void => {
      const kids = node.children;
      const id = nodes.length;
      nodes.push(node);
      roleOf.push(roles.intern(node.role));
      parentOf.push(p);
      depthOf.push(d);
      endOf.push(0);
      if (kids) for (const c of kids) visit(c, id, d + 1);
      endOf[id] = nodes.length;
    };
    visit(tree, -1, 0);
    const n = (this.size = nodes.length);
    const buffer = new ArrayBuffer(n * 16);
    (this.role = new Uint32Array(buffer, 0, n)).set(roleOf);
    (this.parent = new Int32Array(buffer, n * 4, n)).set(parentOf);
    (this.depth = new Uint32Array(buffer, n * 8, n)).set(depthOf);
    (this.end = new Int32Array(buffer, n * 12, n)).set(endOf);
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

const regularNodes = new WeakSet<AXNode>();

/**
 * Whether every node of the tree is an object whose `children`, when it has the field, is a
 * non-empty list without holes (ADR 0016). Such a tree indexes without error, and an edit
 * that leaves a node alone leaves it as it is. Remembered per node, so an edited tree is
 * checked along its new nodes only.
 */
export function regularTree(node: AXNode): boolean {
  if (!node || typeof node !== 'object') return false;
  if (regularNodes.has(node)) return true;
  if (Object.hasOwn(node, 'children')) {
    const kids = node.children;
    if (!Array.isArray(kids) || kids.length === 0) return false;
    for (let i = 0; i < kids.length; i++) if (!(i in kids) || !regularTree(kids[i]!)) return false;
  }
  regularNodes.add(node);
  return true;
}

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
