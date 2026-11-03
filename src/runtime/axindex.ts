import type { AXNode, Locator, Target, AbstainReason } from '../types.ts';
import { LANDMARK_ROLES } from '../types.ts';
import { describeTextMatch, matchText } from '../text.ts';

const LANDMARKS = new Set<string>(LANDMARK_ROLES);

export interface INode {
  id: number;
  node: AXNode;
  parent: INode | null;
  children: INode[];
}

/** Indexed, read-only view of an AXNode tree with parent links and derived text. */
export class AXIndex {
  readonly root: INode;
  readonly all: INode[] = [];
  private readonly textCache = new Map<INode, string>();

  constructor(tree: AXNode) {
    const build = (node: AXNode, parent: INode | null): INode => {
      const n: INode = { id: this.all.length, node, parent, children: [] };
      this.all.push(n);
      for (const c of node.children ?? []) n.children.push(build(c, n));
      return n;
    };
    this.root = build(tree, null);
  }

  /** Derived visible text: text runs and leaf names of the subtree, space-joined. */
  text(n: INode): string {
    const cached = this.textCache.get(n);
    if (cached !== undefined) return cached;
    let t: string;
    if (n.node.role === 'text') t = n.node.name ?? '';
    else if (n.children.length)
      t = n.children
        .map((c) => this.text(c))
        .filter(Boolean)
        .join(' ');
    else t = n.node.name ?? '';
    this.textCache.set(n, t);
    return t;
  }

  /** All strict descendants of `scope` in document order. */
  descendants(scope: INode): INode[] {
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
    const node = n.node;
    if (node.role !== loc.role) return false;
    if (loc.level !== undefined && node.level !== loc.level) return false;
    if (loc.name !== undefined && !matchText(loc.name, node.name)) return false;
    if (loc.text !== undefined && !matchText(loc.text, this.text(n))) return false;
    if (loc.landmark) {
      const lm = loc.landmark;
      let found = false;
      for (let a = n.parent; a; a = a.parent) {
        if (
          LANDMARKS.has(a.node.role) &&
          a.node.role === lm.role &&
          (lm.name === undefined || matchText(lm.name, a.node.name))
        ) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    if (loc.within) {
      let found = false;
      for (let a = n.parent; a; a = a.parent) {
        if (this.matches(a, loc.within)) {
          found = true;
          break;
        }
      }
      if (!found) return false;
    }
    return true;
  }

  find(loc: Locator, scope: INode = this.root): INode[] {
    return this.descendants(scope).filter((n) => this.matches(n, loc));
  }

  /** Human-readable path, e.g. `main › table "Cart" › row "Blue Mug 1 $12.00"`. */
  path(n: INode): string {
    const parts: string[] = [];
    for (let a: INode | null = n; a && a.parent; a = a.parent) parts.unshift(label(a.node));
    return parts.join(' › ') || 'document';
  }
}

function label(node: AXNode): string {
  if (!node.name) return node.role;
  const name = node.name.length > 60 ? node.name.slice(0, 57) + '…' : node.name;
  return `${node.role} ${JSON.stringify(name)}`;
}

export function describeLocator(loc: Locator): string {
  let s = loc.role;
  if (loc.name !== undefined) s += ` named ${describeTextMatch(loc.name)}`;
  if (loc.text !== undefined) s += ` with text ${describeTextMatch(loc.text)}`;
  if (loc.level !== undefined) s += ` (level ${loc.level})`;
  if (loc.landmark)
    s += ` in ${loc.landmark.role}${loc.landmark.name !== undefined ? ' ' + describeTextMatch(loc.landmark.name) : ''}`;
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
 * Resolve a target with redundant-anchor consensus (ADR 0001, §2.2).
 */
export function resolveTarget(index: AXIndex, target: Target): Resolution {
  const locs = targetLocators(target);
  const results = locs.map((loc) => ({ loc, nodes: index.find(loc) }));
  const drift = results.filter((r) => r.nodes.length === 0).map((r) => describeLocator(r.loc));
  const matched = results.filter((r) => r.nodes.length > 0);
  const what = locs.map(describeLocator).join(' | ');

  if (matched.length === 0) {
    return { ok: false, reason: 'anchor_missing', message: `Anchor not found: ${what}`, drift: [] };
  }
  const unique = matched.filter((r) => r.nodes.length === 1);
  if (unique.length === 0) {
    const counts = matched.map((r) => `${describeLocator(r.loc)} → ${r.nodes.length} matches`).join('; ');
    return { ok: false, reason: 'anchor_ambiguous', message: `Anchor is ambiguous: ${counts}`, drift };
  }
  const chosen = unique[0]!.nodes[0]!;
  for (const r of matched) {
    if (!r.nodes.includes(chosen)) {
      return {
        ok: false,
        reason: 'anchor_conflict',
        message: `Redundant anchors disagree: ${describeLocator(unique[0]!.loc)} → ${index.path(chosen)}, but ${describeLocator(r.loc)} → ${r.nodes.map((n) => index.path(n)).join(', ')}`,
        drift,
      };
    }
  }
  return { ok: true, node: chosen, drift };
}
