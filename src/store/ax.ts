/**
 * The accessibility tree as columns (ADR 0015): one row per node in pre-order, so a node's
 * subtree is the contiguous id range [id, end[id]) and "descendants of X with role R" is a
 * binary search in R's sorted id list.
 *
 * A tree made from another by an edit that shares the untouched subtrees (a stress variant or
 * mutant, ADR 0016) gets a table *derived* from the other's (ADR 0023): the rows of every
 * shared subtree are copied from the base table, and only the nodes the edit made are visited.
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

/** The columns of a table. */
interface Columns {
  roles: Interner;
  nodes: AXNode[];
  role: Uint32Array;
  parent: Int32Array;
  depth: Uint32Array;
  end: Int32Array;
}

/** The columns of a derived table (`AXTable.derive`), with what it copied from its base. */
interface Derivation extends Columns {
  base: AXTable;
  name: Int32Array | undefined;
  copies: number[];
}

/** The columns of `tree`, built from scratch. */
function build(tree: AXNode): Columns {
  const nodes: AXNode[] = [];
  const roles = new Interner();
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
  const n = nodes.length;
  const buffer = new ArrayBuffer(n * 16);
  const role = new Uint32Array(buffer, 0, n);
  const parent = new Int32Array(buffer, n * 4, n);
  const depth = new Uint32Array(buffer, n * 8, n);
  const end = new Int32Array(buffer, n * 12, n);
  role.set(roleOf);
  parent.set(parentOf);
  depth.set(depthOf);
  end.set(endOf);
  return { roles, nodes, role, parent, depth, end };
}

/** Tables of trees, built once per tree object (shared by the tree's index and its edits). */
const tables = new WeakMap<AXNode, AXTable>();
/** Trees made by an edit that shares subtrees with the tree it edited: new root → edited root. */
const lineage = new WeakMap<AXNode, AXNode>();

export class AXTable {
  /** Number of nodes. */
  readonly size: number;
  /** Interned roles. A derived table shares its base's (ids only grow, so they stay valid). */
  readonly roles: Interner;
  private namesValue?: Interner;
  /** The node objects, by id (pre-order position). */
  readonly nodes: AXNode[];
  /**
   * The table this one was derived from, and the subtrees it copied from it, as triplets
   * (id here, id there, size). Undefined for a table built from scratch.
   */
  readonly base?: AXTable;
  readonly copies?: readonly number[];
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
  private regularValue?: boolean;
  /** Node object → id, built on first derivation from this table. */
  private idsValue?: Map<AXNode, number>;

  /** Interned canonical names (added to as names are first read). */
  get names(): Interner {
    return (this.namesValue ??= new Interner());
  }

  private get byRoleName(): Map<number, Map<number, Int32Array> | null> {
    return (this.byRoleNameValue ??= new Map());
  }

  constructor(tree: AXNode, derived?: Derivation) {
    const c = derived ?? build(tree);
    this.roles = c.roles;
    this.nodes = c.nodes;
    this.size = c.nodes.length;
    this.role = c.role;
    this.parent = c.parent;
    this.depth = c.depth;
    this.end = c.end;
    if (derived) {
      this.base = derived.base;
      this.copies = derived.copies;
      this.namesValue = derived.base.names;
      this.name = derived.name;
      // Derivation visits every node the edit made and accepts only a regular tree (`derive`).
      this.regularValue = true;
    }
  }

  /**
   * The table of `tree`, built on first use and shared by every reader of the same tree object.
   * A tree recorded as an edit of a tree that has a regular table (`noteDerived`) gets a table
   * derived from that one; any other is built from scratch (and throws where it always did).
   */
  static of(tree: AXNode): AXTable {
    let t = tables.get(tree) ?? derivedTable(tree);
    if (!t) tables.set(tree, (t = new AXTable(tree)));
    return t;
  }

  /**
   * The table of `tree` made from `base`'s: a subtree whose root is one of `base`'s node
   * objects is the same subtree (trees are not edited once indexed: ADR 0015), so its rows are
   * copied with their ids, parents and ends shifted, and its interned names kept. Only the nodes
   * the edit made are visited. Undefined when `base`'s tree is not regular or a node the edit
   * made is not (`regularTree`): such a tree is built from scratch.
   */
  static derive(tree: AXNode, base: AXTable): AXTable | undefined {
    if (!base.regular) return undefined;
    const ids = base.ids;
    // First the size (and whether every node the edit made is regular: -1 when not), so the
    // columns are written once, into one buffer.
    const sizeOf = (node: AXNode): number => {
      const b = ids.get(node);
      if (b !== undefined) return base.end[b]! - b;
      if (!regularNode(node)) return -1;
      let n = 1;
      const kids = node.children;
      if (kids)
        for (let i = 0; i < kids.length; i++) {
          const k = sizeOf(kids[i]!);
          if (k < 0) return -1;
          n += k;
        }
      return n;
    };
    const n = sizeOf(tree);
    if (n < 0) return undefined;
    const baseName = base.name;
    const [buffer, at] = slice(n * (baseName ? 20 : 16));
    const role = new Uint32Array(buffer, at, n);
    const parent = new Int32Array(buffer, at + n * 4, n);
    const depth = new Uint32Array(buffer, at + n * 8, n);
    const end = new Int32Array(buffer, at + n * 12, n);
    const name = baseName ? new Int32Array(buffer, at + n * 16, n) : undefined;
    const nodes: AXNode[] = [];
    const copies: number[] = [];
    const roles = base.roles;
    /**
     * Copies the base's rows [b, e): one subtree, or a run of sibling subtrees that follow one
     * another in the base too (`roots` of them), under `p` at depth `d`.
     */
    const copy = (b: number, e: number, p: number, d: number): void => {
      const id = nodes.length;
      role.set(base.role.subarray(b, e), id);
      if (name) name.set(baseName!.subarray(b, e), id);
      shifted(parent, id, base.parent, b, e, id - b);
      shifted(depth, id, base.depth, b, e, d - base.depth[b]!);
      shifted(end, id, base.end, b, e, id - b);
      for (let r = b; r < e; r = base.end[r]!) parent[id + r - b] = p;
      for (let i = b; i < e; i++) nodes.push(base.nodes[i]!);
      copies.push(id, b, e - b);
    };
    /** A node the edit made (not one of the base's). */
    const visit = (node: AXNode, p: number, d: number): void => {
      const id = nodes.length;
      nodes.push(node);
      role[id] = roles.intern(node.role);
      parent[id] = p;
      depth[id] = d;
      if (name) name[id] = PENDING;
      const kids = node.children;
      if (kids)
        for (let i = 0; i < kids.length;) {
          const b = ids.get(kids[i]!);
          if (b === undefined) {
            visit(kids[i++]!, id, d + 1);
            continue;
          }
          // Siblings that are consecutive subtrees of the base, at the same depth, copy as one range.
          let e = base.end[b]!;
          for (i++; i < kids.length && ids.get(kids[i]!) === e && base.depth[e] === base.depth[b]; i++)
            e = base.end[e]!;
          copy(b, e, id, d + 1);
        }
      end[id] = nodes.length;
    };
    const rootId = ids.get(tree);
    if (rootId !== undefined) copy(rootId, base.end[rootId]!, -1, 0);
    else visit(tree, -1, 0);
    return new AXTable(tree, { base, roles, nodes, role, parent, depth, end, name, copies });
  }

  /** Whether the tree is regular (`regularTree`); computed once. */
  get regular(): boolean {
    return (this.regularValue ??= walkRegular(this.nodes[0]!));
  }

  /**
   * `regularTree(tree)` for a tree that may share subtrees with this one (an edit of it, ADR
   * 0029), without building its table: a subtree whose root is one of this regular tree's nodes
   * is regular, so only the other nodes are asked (as `derive` asks them). Undefined when this
   * tree is not regular (ask `regularTree`).
   */
  regularOver(tree: AXNode): boolean | undefined {
    if (!this.regular) return undefined;
    const ids = this.ids;
    const ok = (node: AXNode): boolean => {
      if (ids.has(node)) return true;
      if (!regularNode(node)) return false;
      const kids = node.children;
      if (kids) for (let i = 0; i < kids.length; i++) if (!ok(kids[i]!)) return false;
      return true;
    };
    return ok(tree);
  }

  /** Node object → id (the last id of a node object that occurs more than once). */
  private get ids(): Map<AXNode, number> {
    if (!this.idsValue) {
      const m = new Map<AXNode, number>();
      for (let i = 0; i < this.size; i++) m.set(this.nodes[i]!, i);
      this.idsValue = m;
    }
    return this.idsValue;
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
    // A role interned after the sort (by a table that shares the interner) has no node here.
    if (r + 1 >= this.roleStart!.length) return EMPTY;
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
 * Whether a node inherits nothing (its prototype is Object.prototype or null), so the node
 * reads the same as `{ ...node }`, its copy.
 */
export function plainNode(node: AXNode): boolean {
  const p = Object.getPrototypeOf(node) as unknown;
  return p === Object.prototype || p === null;
}

/**
 * Whether every node of the tree is an object whose `children`, when it has the field, is its
 * own non-empty list without holes (ADR 0016). Such a tree indexes without error, and an edit
 * that leaves a node alone leaves it as it is. A tree recorded as an edit of a regular tree
 * (`noteDerived`) is checked by deriving its table, along the nodes the edit made (ADR 0023);
 * any other is walked, remembering regular nodes.
 */
export function regularTree(node: AXNode): boolean {
  if (!node || typeof node !== 'object') return false;
  const t = tables.get(node) ?? derivedTable(node);
  return t ? t.regular : walkRegular(node);
}

/**
 * `regularTree(next)` for `next` made by an edit of `base` that shares subtrees with it (an
 * overlay, ADR 0029): only the nodes that are not `base`'s are asked, and `next`'s table is not
 * built (it waits for a check that reads the tree).
 */
export function regularEdit(base: AXNode, next: AXNode): boolean {
  const own = next && typeof next === 'object' ? tables.get(next) : undefined;
  if (own) return own.regular;
  return (regularTree(base) && AXTable.of(base).regularOver(next)) || regularTree(next);
}

/** `regularTree` by walking the tree, remembered per node, so a tree is checked along its new nodes only. */
function walkRegular(node: AXNode): boolean {
  if (!node || typeof node !== 'object') return false;
  if (regularNodes.has(node)) return true;
  if (!regularNode(node)) return false;
  const kids = node.children;
  if (kids) for (let i = 0; i < kids.length; i++) if (!walkRegular(kids[i]!)) return false;
  regularNodes.add(node);
  return true;
}

/**
 * What `regularTree` asks of one node: an object that inherits nothing, whose `children`, when
 * it has the field, is its own non-empty list without holes. (Its children are asked in turn.)
 */
export function regularNode(node: AXNode): boolean {
  if (!node || typeof node !== 'object' || !plainNode(node)) return false;
  if (Object.hasOwn(node, 'children')) {
    const kids = node.children;
    if (!Array.isArray(kids) || kids.length === 0) return false;
    for (let i = 0; i < kids.length; i++) if (!(i in kids)) return false;
    return true;
  }
  // An inherited list: the index reads it, but a copy of the node ({ ...node }) loses it.
  return node.children === undefined;
}

/**
 * Records that `next` was made from `from` by an edit that shares the subtrees it left alone
 * (and edits nothing in place), so `next`'s table can be derived from `from`'s (ADR 0023).
 */
export function noteDerived(next: AXNode, from: AXNode): void {
  if (next !== from && next && typeof next === 'object' && from && typeof from === 'object') lineage.set(next, from);
}

/** A table for `tree` derived from the last of its recorded ancestors that has one (usually the reference's). */
function derivedTable(tree: AXNode): AXTable | undefined {
  let base: AXTable | undefined;
  for (let a = lineage.get(tree); a !== undefined; a = lineage.get(a)) base = tables.get(a) ?? base;
  const t = base && AXTable.derive(tree, base);
  if (t) tables.set(tree, t);
  return t;
}

/**
 * Derived tables take their columns from shared slabs: they are made by the thousand (one per
 * stress variant or mutant), and allocating an ArrayBuffer each cost more than deriving the
 * columns. A slab is freed once no table in it is reachable.
 */
const SLAB = 64 * 1024;
let slab = new ArrayBuffer(SLAB);
let slabUsed = 0;

/** `bytes` (zeroed) in a slab: the buffer and the offset, 8-byte aligned. */
function slice(bytes: number): [ArrayBuffer, number] {
  if (bytes > SLAB / 4) return [new ArrayBuffer(bytes), 0];
  if (slabUsed + bytes > SLAB) {
    slab = new ArrayBuffer(SLAB);
    slabUsed = 0;
  }
  const at = slabUsed;
  slabUsed += (bytes + 7) & ~7;
  return [slab, at];
}

/** Writes `from[b..e)` into `to` from index `at`, each value plus `add`. */
function shifted(
  to: Int32Array | Uint32Array,
  at: number,
  from: Int32Array | Uint32Array,
  b: number,
  e: number,
  add: number,
) {
  for (let i = b, j = at; i < e; i++, j++) to[j] = from[i]! + add;
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
