import type { AXNode, Locator, Target, AbstainReason, TextMatch } from '../types.ts';
import { LANDMARK_ROLES } from '../types.ts';
import { canonical, describeTextMatch, exactText, textTest, type TextTest } from '../text.ts';
import { AXTable } from '../store/ax.ts';

const LANDMARKS = new Set<string>(LANDMARK_ROLES);
/** Roles that take a column position in a row. */
const CELLS = new Set(['cell', 'gridcell', 'rowheader', 'columnheader']);
const TABLES = new Set(['table', 'grid', 'treegrid']);

export interface INode {
  id: number;
  node: AXNode;
  parent: INode | null;
  children: INode[];
}

/** Indexes of trees, built once per tree object (trees are not edited once indexed: ADR 0015). */
const indexes = new WeakMap<AXNode, AXIndex>();

/**
 * Indexed, read-only view of an AXNode tree with parent links and derived text. Backed by an
 * `AXTable` (ADR 0015): nodes are numbered in pre-order, so a subtree is an id range, and
 * locators look up candidates by role (and by name when they name one exactly) instead of
 * walking the tree.
 */
export class AXIndex {
  readonly root: INode;
  readonly all: INode[];
  /** The tree's columns and lookup indexes. */
  readonly table: AXTable;
  private readonly texts: (string | undefined)[];
  private readonly canonicalTexts: (string | undefined)[];
  private readonly paths: (string | undefined)[];
  /** Derived text of nodes outside the tree (term groups, made anew on each read). */
  private textCache?: WeakMap<INode, string>;
  private headerCache?: Map<INode, INode[]>;

  constructor(tree: AXNode) {
    const table = (this.table = new AXTable(tree));
    const all: INode[] = (this.all = []);
    for (let i = 0; i < table.size; i++) {
      const p = table.parent[i]!;
      const n: INode = { id: i, node: table.nodes[i]!, parent: p < 0 ? null : all[p]!, children: [] };
      all[i] = n;
      if (n.parent) n.parent.children.push(n);
    }
    this.root = all[0]!;
    this.texts = [];
    this.canonicalTexts = [];
    this.paths = [];
  }

  /** The index of `tree`, built on first use and shared by every reader of the same tree object. */
  static of(tree: AXNode): AXIndex {
    let index = indexes.get(tree);
    if (!index) indexes.set(tree, (index = new AXIndex(tree)));
    return index;
  }

  /** Whether `n` is one of this tree's nodes (not a term group or a node of another tree). */
  private owns(n: INode): boolean {
    return n.id >= 0 && this.all[n.id] === n;
  }

  /** Derived visible text: text runs and leaf names of the subtree, space-joined. */
  text(n: INode): string {
    const own = this.owns(n);
    const cached = own ? this.texts[n.id] : this.textCache?.get(n);
    if (cached !== undefined) return cached;
    let t: string;
    if (n.node.role === 'text') t = n.node.name ?? '';
    else if (n.children.length)
      t = n.children
        .map((c) => this.text(c))
        .filter(Boolean)
        .join(' ');
    else t = n.node.name ?? '';
    if (own) this.texts[n.id] = t;
    else (this.textCache ??= new WeakMap()).set(n, t);
    return t;
  }

  /** `canonical(this.text(n))`, cached. */
  canonicalText(n: INode): string {
    if (!this.owns(n)) return canonical(this.text(n));
    let t = this.canonicalTexts[n.id];
    if (t === undefined) this.canonicalTexts[n.id] = t = canonical(this.text(n));
    return t;
  }

  /** `canonical(n.node.name)`, or undefined without a name. */
  canonicalName(n: INode): string | undefined {
    if (this.owns(n)) return this.table.canonicalName(n.id);
    return n.node.name === undefined ? undefined : canonical(n.node.name);
  }

  /** All strict descendants of `scope` in document order. */
  descendants(scope: INode): INode[] {
    if (this.owns(scope)) return this.all.slice(scope.id + 1, this.table.end[scope.id]);
    const out: INode[] = [];
    const walk = (n: INode) => {
      for (const c of n.children) {
        out.push(c);
        walk(c);
      }
    };
    walk(scope);
    return out;
  }

  matches(n: INode, loc: Locator): boolean {
    return compileLocator(loc).matches(this, n);
  }

  /**
   * The header of a cell's column: the columnheader at the cell's position among its row's
   * cells, in the first row of the enclosing table (grid, treegrid) that has column headers.
   * Positions are counted, since the accessibility tree has no column indices; a cell
   * spanning several columns shifts the cells after it.
   */
  columnHeader(n: INode): INode | undefined {
    const row = n.parent;
    if (!CELLS.has(n.node.role) || row?.node.role !== 'row') return undefined;
    let table: INode | null = row.parent;
    while (table && !TABLES.has(table.node.role)) table = table.parent;
    if (!table) return undefined;
    let headers = this.headerCache?.get(table);
    if (!headers) {
      const headerRow = this.descendants(table).find(
        (r) => r.node.role === 'row' && r.children.some((c) => c.node.role === 'columnheader'),
      );
      headers = headerRow ? headerRow.children.filter((c) => CELLS.has(c.node.role)) : [];
      (this.headerCache ??= new Map()).set(table, headers);
    }
    const header = headers[row.children.filter((c) => CELLS.has(c.node.role)).indexOf(n)];
    return header?.node.role === 'columnheader' ? header : undefined;
  }

  find(loc: Locator, scope: INode = this.root): INode[] {
    return compileLocator(loc).find(this, scope);
  }

  /**
   * The records `loc` matches inside `scope` (an `each` assertion): each matching node
   * with its subtree, except that a term's record is the term together with the
   * definitions that follow it (a `dt` with its `dd`s, which the accessibility tree
   * keeps as siblings). Consecutive terms share the definitions after the last of them.
   */
  records(loc: Locator, scope: INode = this.root): INode[] {
    return this.recordsOf(compileLocator(loc), scope);
  }

  /** `records` for a prepared locator. */
  recordsOf(loc: CompiledLocator, scope: INode = this.root): INode[] {
    return loc.find(this, scope).map((n) => (n.node.role === 'term' ? this.termGroup(n) : n));
  }

  /** A term and its definitions, as a node outside the tree whose children are those siblings. */
  termGroup(term: INode): INode {
    const siblings = term.parent?.children ?? [term];
    let i = siblings.indexOf(term) + 1;
    while (i < siblings.length && siblings[i]!.node.role === 'term') i++;
    const definitions: INode[] = [];
    while (i < siblings.length && siblings[i]!.node.role === 'definition') definitions.push(siblings[i++]!);
    const name = canonical(this.text(term));
    const members = [term, ...definitions];
    return {
      // Negative: not a pre-order id of the tree, so edits by id never touch it.
      id: -1 - term.id,
      node: { role: 'term', ...(name ? { name } : {}), children: members.map((m) => m.node) },
      parent: term.parent,
      children: members,
    };
  }

  /** Human-readable path, e.g. `main › table "Cart" › row "Blue Mug 1 $12.00"`. */
  path(n: INode): string {
    const own = this.owns(n);
    if (own) {
      const cached = this.paths[n.id];
      if (cached !== undefined) return cached;
    }
    const parts: string[] = [];
    for (let a: INode | null = n; a && a.parent; a = a.parent) parts.unshift(label(a.node));
    const p = parts.join(' › ') || 'document';
    if (own) this.paths[n.id] = p;
    return p;
  }
}

function label(node: AXNode): string {
  if (!node.name) return node.role;
  const name = node.name.length > 60 ? node.name.slice(0, 57) + '…' : node.name;
  return `${node.role} ${JSON.stringify(name)}`;
}

// ---------------------------------------------------------------------------
// Prepared locators
// ---------------------------------------------------------------------------

/** A text match tested against a value that may be missing (a node without a name). */
const optionalTest = (m: TextMatch): ((canonicalActual: string | undefined) => boolean) => {
  const test: TextTest = textTest(m);
  return (a) => a !== undefined && test(a);
};

/**
 * A locator prepared once (ADR 0015): text matches canonicalized, regexes built, the exact
 * name (when it names one) ready for the role-and-name index. `matches` is
 * `AXIndex#matches` and tests the same properties in the same order, so a malformed
 * locator throws where it always did.
 */
export class CompiledLocator {
  readonly loc: Locator;
  private readonly name?: (a: string | undefined) => boolean;
  private readonly text?: TextTest;
  private readonly landmarkName?: (a: string | undefined) => boolean;
  private readonly column?: (a: string | undefined) => boolean;
  private readonly within?: CompiledLocator;
  private readonly exactName?: string;
  private description?: string;

  constructor(loc: Locator) {
    this.loc = loc;
    if (loc.name !== undefined) this.name = optionalTest(loc.name);
    if (loc.text !== undefined) this.text = textTest(loc.text);
    if (loc.landmark?.name !== undefined) this.landmarkName = optionalTest(loc.landmark.name);
    if (loc.column !== undefined) this.column = optionalTest(loc.column);
    if (loc.within) this.within = compileLocator(loc.within);
    if (loc.name !== undefined) this.exactName = exactText(loc.name);
  }

  /** `describeLocator(loc)`, computed once. */
  get desc(): string {
    return (this.description ??= describeLocator(this.loc));
  }

  matches(index: AXIndex, n: INode): boolean {
    return n.node.role === this.loc.role && this.rest(index, n);
  }

  /** Everything `matches` tests after the role. */
  private rest(index: AXIndex, n: INode): boolean {
    const loc = this.loc;
    const node = n.node;
    if (loc.level !== undefined && node.level !== loc.level) return false;
    if (this.name && !this.name(index.canonicalName(n))) return false;
    if (this.text && !this.text(index.canonicalText(n))) return false;
    if (loc.landmark) {
      const lm = loc.landmark;
      let found = false;
      for (let a = n.parent; a; a = a.parent) {
        if (
          LANDMARKS.has(a.node.role) &&
          a.node.role === lm.role &&
          (this.landmarkName === undefined || this.landmarkName(index.canonicalName(a)))
        ) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    if (this.column) {
      const header = index.columnHeader(n);
      if (!this.column(header && index.canonicalName(header))) return false;
    }
    if (this.within) {
      let found = false;
      for (let a = n.parent; a; a = a.parent) {
        if (this.within.matches(index, a)) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }

  /** The nodes the locator matches among the strict descendants of `scope`, in document order. */
  find(index: AXIndex, scope: INode = index.root): INode[] {
    const table = index.table;
    if (scope.id < 0 || index.all[scope.id] !== scope)
      return index.descendants(scope).filter((n) => this.matches(index, n));
    const byName = this.exactName !== undefined ? table.withRoleAndName(this.loc.role, this.exactName) : undefined;
    const ids = table.within(byName ?? table.withRole(this.loc.role), scope.id);
    const out: INode[] = [];
    for (let i = 0; i < ids.length; i++) {
      const n = index.all[ids[i]!]!;
      if (this.rest(index, n)) out.push(n);
    }
    return out;
  }
}

const locators = new WeakMap<Locator, CompiledLocator>();

/** The prepared form of `loc`, made once per locator object. */
export function compileLocator(loc: Locator): CompiledLocator {
  // A malformed locator (not an object) is not cached; it matches nothing, as before.
  if (!loc || typeof loc !== 'object') return new CompiledLocator(loc);
  let c = locators.get(loc);
  if (!c) locators.set(loc, (c = new CompiledLocator(loc)));
  return c;
}

/**
 * The value a node-derived source reads. Accessible names and text are
 * whitespace-normalized by definition (ADR 0001 §2.3); control values and URLs
 * are kept verbatim. Shared by the evaluator and the stress generators.
 */
export function readNodeField(index: AXIndex, n: INode, field: 'name' | 'value' | 'text' | 'url'): string | undefined {
  if (field === 'text') return index.canonicalText(n);
  if (field === 'name') return index.canonicalName(n);
  return n.node[field];
}

export function describeLocator(loc: Locator): string {
  let s = loc.role;
  if (loc.name !== undefined) s += ` named ${describeTextMatch(loc.name)}`;
  if (loc.text !== undefined) s += ` with text ${describeTextMatch(loc.text)}`;
  if (loc.level !== undefined) s += ` (level ${loc.level})`;
  if (loc.landmark)
    s += ` in ${loc.landmark.role}${loc.landmark.name !== undefined ? ' ' + describeTextMatch(loc.landmark.name) : ''}`;
  if (loc.column !== undefined) s += ` in column ${describeTextMatch(loc.column)}`;
  if (loc.within) s += ` within ${describeLocator(loc.within)}`;
  return s;
}

export function targetLocators(t: Target): Locator[] {
  return 'anchors' in t ? t.anchors : [t];
}

export type Resolution =
  | { ok: true; node: INode; drift: string[] }
  | {
      ok: false;
      reason: Extract<AbstainReason, 'anchor_missing' | 'anchor_ambiguous' | 'anchor_conflict'>;
      message: string;
      drift: string[];
    };

/**
 * Resolve a target with redundant-anchor consensus (ADR 0001, §2.2), among the
 * descendants of `scope` (the document, or a record of an `each` assertion).
 */
export function resolveTarget(index: AXIndex, target: Target, scope: INode = index.root): Resolution {
  return resolveLocators(index, targetLocators(target).map(compileLocator), scope);
}

/** `resolveTarget` for prepared locators. */
export function resolveLocators(index: AXIndex, locs: CompiledLocator[], scope: INode = index.root): Resolution {
  const results = locs.map((loc) => ({ loc, nodes: loc.find(index, scope) }));
  const drift = results.filter((r) => r.nodes.length === 0).map((r) => r.loc.desc);
  const matched = results.filter((r) => r.nodes.length > 0);
  const what = locs.map((l) => l.desc).join(' | ');
  const inside = () => (scope === index.root ? '' : ` in ${index.path(scope)}`);

  if (matched.length === 0) {
    return { ok: false, reason: 'anchor_missing', message: `Anchor not found${inside()}: ${what}`, drift: [] };
  }
  const unique = matched.filter((r) => r.nodes.length === 1);
  if (unique.length === 0) {
    const counts = matched.map((r) => `${r.loc.desc} → ${r.nodes.length} matches`).join('; ');
    return { ok: false, reason: 'anchor_ambiguous', message: `Anchor is ambiguous${inside()}: ${counts}`, drift };
  }
  const chosen = unique[0]!.nodes[0]!;
  for (const r of matched) {
    if (!r.nodes.includes(chosen)) {
      return {
        ok: false,
        reason: 'anchor_conflict',
        message: `Redundant anchors disagree: ${unique[0]!.loc.desc} → ${index.path(chosen)}, but ${r.loc.desc} → ${r.nodes.map((n) => index.path(n)).join(', ')}`,
        drift,
      };
    }
  }
  return { ok: true, node: chosen, drift };
}
