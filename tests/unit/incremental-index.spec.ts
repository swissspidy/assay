/**
 * Incremental accessibility-tree index (ADR 0023): the index of a tree made by an edit that
 * shares the untouched subtrees is derived from the edited tree's, copying the rows of every
 * shared subtree. Whatever the edit, it must answer every lookup as an index built from
 * scratch on the same tree does.
 */
import { test, expect } from '@playwright/test';
import { AXIndex, compileLocator, type INode } from '../../src/runtime/axindex.ts';
import { AXTable, noteDerived, regularTree } from '../../src/store/ax.ts';
import { generateMutants, generateVariants, withSuccessClaim } from '../../src/stress/index.ts';
import { editById } from '../../src/stress/edit.ts';
import type { AXNode, EvidenceSnapshot } from '../../src/types.ts';
import { collectCases } from './equivalence/cases.ts';

const cases = collectCases().stress;
/** Every committed reference snapshot, once. */
const references = [...new Set(cases.flatMap((c) => c.refs.map((r) => r.snapshot)))];

/** A small seeded generator, so a failure names a reproducible edit. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return (n: number) => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) % n;
  };
}

type Edit = (n: AXNode, id: number) => AXNode | AXNode[] | null | undefined;

/** The kinds of tree edit the stress generators make, each at one node `pick` chooses. */
const KINDS: Record<string, (t: AXTable, pick: (n: number) => number) => { ids: number[]; edit: Edit }> = {
  rename: (t, pick) => one(t, pick, (n) => ({ ...n, name: `${n.name ?? ''} renamed` })),
  'change role': (t, pick) => one(t, pick, (n) => ({ ...n, role: n.role === 'cell' ? 'gridcell' : 'cell' })),
  remove: (t, pick) => one(t, pick, () => null, 1),
  'insert after': (t, pick) =>
    one(t, pick, (n) => [n, { role: 'status', children: [{ role: 'text', name: 'Inserted' }] }], 1),
  // A subtree of the tree placed a second time elsewhere (a duplicated row, a moved node).
  'duplicate elsewhere': (t, pick) => {
    const other = t.nodes[pick(t.size)]!;
    return one(t, pick, (n) => [n, other], 1);
  },
  wrap: (t, pick) => one(t, pick, (n) => ({ role: 'region', name: 'Wrapper', children: [n] }), 1),
  'replace by a copy of another node': (t, pick) => {
    const other = structuredClone(t.nodes[pick(t.size)]!);
    return one(t, pick, () => other, 1);
  },
  'reverse children': (t, pick) => {
    const parents = [...Array(t.size).keys()].filter((i) => (t.nodes[i]!.children?.length ?? 0) >= 2);
    if (!parents.length) return { ids: [], edit: () => undefined };
    const id = parents[pick(parents.length)]!;
    return { ids: [id], edit: (n, i) => (i === id ? { ...n, children: n.children!.toReversed() } : undefined) };
  },
  'drop children': (t, pick) =>
    one(t, pick, (n) => {
      const { children: _gone, ...rest } = n;
      return rest;
    }),
  'replace the root': () => ({
    ids: [0],
    edit: (n, i) =>
      i === 0 ? { ...n, name: 'New root', children: [...(n.children ?? []), { role: 'note' }] } : undefined,
  }),
  'several edits': (t, pick) => {
    const ids = [pick(t.size), pick(t.size), pick(t.size)].filter((i) => i > 0);
    return {
      ids,
      edit: (n, i) =>
        i === ids[0] ? null : i === ids[1] ? { ...n, name: 'second' } : i === ids[2] ? [n, n] : undefined,
    };
  },
};

/** An edit of one node, chosen among ids >= `from` (1: never the root). */
function one(t: AXTable, pick: (n: number) => number, fn: (n: AXNode) => AXNode | AXNode[] | null, from = 0) {
  const id = t.size > from ? from + pick(t.size - from) : 0;
  return { ids: [id], edit: (n: AXNode, i: number) => (i === id ? fn(n) : undefined) };
}

/** Every lookup an index answers, as plain data (node ids for nodes). */
function lookups(idx: AXIndex): unknown {
  const t = idx.table;
  const ids = (ns: INode[]) => ns.map((n) => n.id);
  const nodes = idx.all.map((n) => [
    n.id,
    t.parent[n.id],
    t.depth[n.id],
    t.end[n.id],
    t.roles.strings[t.role[n.id]!],
    idx.canonicalName(n),
    idx.text(n),
    idx.canonicalText(n),
    idx.path(n),
    idx.columnHeader(n)?.id,
    n.parent?.id,
    ids(n.children),
  ]);
  const roles = [...new Set(idx.all.map((n) => n.node.role))].map((role) => [
    role,
    [...t.withRole(role)],
    ids(compileLocator({ role }).find(idx)),
  ]);
  const names = idx.all
    .filter((n) => idx.canonicalName(n) !== undefined)
    .map((n) => {
      const name = idx.canonicalName(n)!;
      return [
        n.id,
        [...(t.withRoleAndName(n.node.role, name) ?? [])],
        ids(compileLocator({ role: n.node.role, name }).find(idx)),
      ];
    });
  return {
    size: t.size,
    root: JSON.stringify(t.nodes[0]),
    nodes,
    roles,
    names,
    none: t.withRole('no-such-role').length,
  };
}

/** Every lookup of the incrementally built index equals the same lookup on one built from scratch. */
function sameLookups(tree: AXNode, what: string): void {
  const inc = JSON.stringify(lookups(AXIndex.of(tree)));
  const full = JSON.stringify(lookups(new AXIndex(structuredClone(tree))));
  if (inc !== full) expect(JSON.parse(inc), what).toEqual(JSON.parse(full));
  expect(regularTree(tree), what).toBe(regularTree(structuredClone(tree)));
}

/** The base index with its derived text computed, so a derived index has text to copy. */
function warm(tree: AXNode): AXIndex {
  const idx = AXIndex.of(tree);
  for (const n of idx.all) idx.canonicalText(n);
  return idx;
}

test('each kind of tree edit, at random nodes of every committed snapshot: the derived index answers as one built from scratch', () => {
  test.setTimeout(300_000);
  let derived = 0;
  let checked = 0;
  references.forEach((s, r) => {
    const pick = rng(r + 1);
    for (const [kind, make] of Object.entries(KINDS)) {
      for (let round = 0; round < 2; round++) {
        const base = warm(s.a11y);
        const { ids, edit } = make(base.table, pick);
        const out = editById(s, edit, ids);
        if (out.a11y === s.a11y) continue;
        const what = `snapshot ${r}, ${kind} at ${ids.join(',')}`;
        sameLookups(out.a11y, what);
        if (AXIndex.of(out.a11y).table.base) derived++;
        checked++;
        // An edit of the edited tree: derived along the recorded edits (from the reference's table).
        const again = editById(out, (n, id) => (id === 1 ? { ...n, name: 'again' } : undefined), [1]);
        if (again.a11y !== out.a11y) sameLookups(again.a11y, `${what}, edited again`);
      }
    }
  });
  expect(checked).toBeGreaterThan(references.length * 15);
  // The committed trees are regular, so every edit above was indexed incrementally.
  expect(derived).toBe(checked);
});

test('every variant, mutant and success claim of a quarter of the committed check sets is indexed as from scratch', () => {
  test.setTimeout(300_000);
  let n = 0;
  for (const c of cases.filter((_, i) => i % 4 === 1)) {
    for (const r of c.refs) {
      warm(r.snapshot.a11y);
      const trees = new Set<AXNode>();
      for (const v of generateVariants(c.checkSet, r.snapshot)) trees.add(v.snapshot.a11y);
      for (const m of generateMutants(c.checkSet, r.snapshot)) {
        trees.add(m.snapshot.a11y);
        trees.add(withSuccessClaim(m).snapshot.a11y);
      }
      trees.delete(r.snapshot.a11y);
      for (const t of trees) {
        sameLookups(t, `${c.id}/${r.name}`);
        n++;
      }
    }
  }
  expect(n).toBeGreaterThan(300);
});

test('a tree that is not regular is never derived: it is indexed from scratch, and fails where it always failed', () => {
  const base = { role: 'document', children: [{ role: 'main', children: [{ role: 'text', name: 'a' }] }] } as AXNode;
  AXIndex.of(base);
  // An empty children list made by the edit: not regular, so built from scratch (which reads it fine).
  const empty = { role: 'document', children: [{ role: 'list', children: [] }, base.children![0]!] } as AXNode;
  noteDerived(empty, base);
  expect(regularTree(empty)).toBe(false);
  expect(AXTable.of(empty).base).toBeUndefined();
  sameLookups(empty, 'empty children');
  // A hole in a children list: the full build throws, as it always did.
  const kids: AXNode[] = [base.children![0]!];
  kids[2] = { role: 'note' };
  const holey = { role: 'document', children: kids } as AXNode;
  noteDerived(holey, base);
  expect(regularTree(holey)).toBe(false);
  expect(() => AXIndex.of(holey)).toThrow();
  // A base that is not regular: its edits are built from scratch too.
  const irregular = { role: 'document', children: [{ role: 'list', children: [] }, { role: 'note' }] } as AXNode;
  AXIndex.of(irregular);
  const edited = editById({ a11y: irregular } as EvidenceSnapshot, (n, id) =>
    id === 2 ? { ...n, name: 'x' } : undefined,
  );
  expect(AXTable.of(edited.a11y).base).toBeUndefined();
  sameLookups(edited.a11y, 'irregular base');
});

test('roles a derived table adds to the shared role list are absent from its base and its siblings', () => {
  const s = references[0]!;
  const base = AXIndex.of(s.a11y);
  base.table.withRole('main'); // the base's role slices are sorted before the new roles exist
  const a = editById(s, (n, id) => (id === 1 ? [n, { role: 'x-new-role-a' }] : undefined), [1]);
  const b = editById(s, (n, id) => (id === 1 ? [n, { role: 'x-new-role-b' }] : undefined), [1]);
  expect(AXTable.of(a.a11y).withRole('x-new-role-a').length).toBe(1);
  expect(AXTable.of(b.a11y).withRole('x-new-role-a').length).toBe(0);
  expect(base.table.withRole('x-new-role-a').length).toBe(0);
  expect(base.table.withRole('x-new-role-b').length).toBe(0);
  expect(base.table.withRoleAndName('x-new-role-a', 'anything')!.length).toBe(0);
});
