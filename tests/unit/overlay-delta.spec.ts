/**
 * Re-checking only what an overlay changed (ADR 0029): a check whose reads of a changed part
 * provably give what they gave on the base takes the base's result. Skipping must be exactly
 * what re-evaluating gives, for every committed reference, check set, variant, mutant and
 * success claim, and for edits the generators do not make; an edit that reaches what a check
 * reads must never be skipped.
 */
import { test, expect } from '@playwright/test';
import type { AXNode, Assertion, CheckSet, EvidenceSnapshot, Json, NetworkEntry } from '../../src/types.ts';
import { buildStore, changedKeys } from '../../src/store/store.ts';
import { compileChecks, PlanRun, runPlan, type CheckPlan } from '../../src/plan/plan.ts';
import { readsChanged } from '../../src/plan/readset.ts';
import {
  fineReadsOf,
  networkDelta,
  sameUrlRead,
  sameValue,
  treeDelta,
  TREE_DELTA_BUDGET,
} from '../../src/plan/delta.ts';
import { AXTable, regularEdit, regularTree } from '../../src/store/ax.ts';
import { generateMutants, generateVariants, stressTest, withSuccessClaim } from '../../src/stress/index.ts';
import { stressVariants } from '../../src/stress/variants.ts';
import { editById, withPointer } from '../../src/stress/edit.ts';
import { collectCases } from './equivalence/cases.ts';

const cases = collectCases().stress;

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

/** Counts of checks an overlay run reused although a part they read changed (the fine skips). */
interface Tally {
  overlays: number;
  fine: number;
  ran: number;
}

/**
 * An overlay run of `s` on `over` against a full run on a copy that shares nothing: the same
 * outcome, byte for byte, and every check's result alike. Also run with every check treated as
 * targeted (no fine description): the same again.
 */
function same(plan: CheckPlan, s: EvidenceSnapshot, over: PlanRun, what: string, tally: Tally): PlanRun {
  const run = new PlanRun(plan, buildStore(s), over);
  const full = runPlan(plan, buildStore(structuredClone(s)), { digests: false });
  const got = JSON.stringify(run.outcome({ digests: false }));
  const want = JSON.stringify(full);
  if (got !== want) expect(JSON.parse(got), what).toEqual(JSON.parse(want));
  expect(got, what).toBe(want);
  const targeted = new PlanRun(plan, buildStore(s), over);
  plan.checks.forEach((_, i) => targeted.check(i, true));
  expect(JSON.stringify(targeted.outcome({ digests: false })), `${what} (targeted)`).toBe(want);
  const changed = changedKeys(over.store.snapshot, s);
  tally.overlays++;
  plan.checks.forEach((c, i) => {
    if (run.check(i) !== over.check(i)) tally.ran++;
    else if (c.reads && changed && readsChanged(c.reads, changed)) tally.fine++;
  });
  return run;
}

test('every variant, mutant and success claim of every committed check set: skipping gives what re-evaluating gives', () => {
  test.setTimeout(300_000);
  const tally: Tally = { overlays: 0, fine: 0, ran: 0 };
  for (const c of cases) {
    const plan = compileChecks(c.checkSet);
    for (const r of c.refs) {
      const ref = new PlanRun(plan, buildStore(r.snapshot));
      const where = `${c.id} @ ${r.name}`;
      for (const v of generateVariants(c.checkSet, r.snapshot)) same(plan, v.snapshot, ref, `${where}: ${v.id}`, tally);
      for (const m of generateMutants(c.checkSet, r.snapshot)) {
        const o = same(plan, m.snapshot, ref, `${where}: ${m.id}`, tally);
        same(plan, withSuccessClaim(m).snapshot, o, `${where}: ${m.id}+claim`, tally);
      }
    }
  }
  expect(tally.overlays).toBeGreaterThan(4000);
  // The fine descriptions are exercised: thousands of checks are reused although a part they read changed.
  expect(tally.fine).toBeGreaterThan(1000);
  expect(tally.ran).toBeGreaterThan(1000);
});

// --- Edits the generators do not make ------------------------------------------------

/** Roles the check set reads (locators) and roles whose derived text it reads. */
function rolesOf(cs: CheckSet): { roles: string[]; deep: string[] } {
  const roles = new Set<string>();
  const deep = new Set<string>();
  for (const c of cs.checks) {
    const f = fineReadsOf(c.assert);
    for (const r of f?.roles ?? []) roles.add(r);
    for (const r of f?.deep ?? []) deep.add(r);
  }
  return { roles: [...roles], deep: [...deep] };
}

type Edit = (s: EvidenceSnapshot, pick: (n: number) => number, cs: CheckSet) => EvidenceSnapshot | undefined;

/** A node id chosen among the nodes with one of `roles` (any node when none has one), never the root. */
function nodeWith(t: AXTable, roles: string[], pick: (n: number) => number): number | undefined {
  const ids = roles.flatMap((r) => [...t.withRole(r)]).filter((i) => i > 0);
  if (ids.length) return ids[pick(ids.length)];
  return t.size > 1 ? 1 + pick(t.size - 1) : undefined;
}

/** A tree edit of one node chosen among `which` roles of the check set (read roles, derived-text roles, or any). */
const treeEdit =
  (
    which: 'roles' | 'deep' | 'any',
    fn: (n: AXNode, t: AXTable, pick: (n: number) => number) => AXNode | AXNode[] | null,
  ): Edit =>
  (s, pick, cs) => {
    if (!regularTree(s.a11y)) return undefined;
    const t = AXTable.of(s.a11y);
    const rs = which === 'any' ? [] : rolesOf(cs)[which];
    let id = nodeWith(t, rs, pick);
    if (id === undefined) return undefined;
    // For derived text: edit a node below one with such a role, so that node is kept but its text changes.
    if (which === 'deep' && t.end[id]! > id + 1) id = id + 1 + pick(t.end[id]! - id - 1);
    return editById(s, (n, i) => (i === id ? fn(n, t, pick) : undefined), [id]);
  };

const leaf = (role: string, name: string): AXNode => ({ role, children: [{ role: 'text', name }] });

const EDITS: Record<string, Edit> = {
  'rename a read node': treeEdit('roles', (n) => ({ ...n, name: `${n.name ?? ''} renamed` })),
  'change a read node’s value': treeEdit('roles', (n) => ({ ...n, value: 'changed' })),
  'check a read node': treeEdit('roles', (n) => ({ ...n, states: { ...n.states, checked: !n.states?.checked } })),
  'remove a read node': treeEdit('roles', () => null),
  'change a read node’s role': treeEdit('roles', (n) => ({ ...n, role: n.role === 'generic' ? 'group' : 'generic' })),
  'replace a read node by another of its role': treeEdit('roles', (n, t, pick) => {
    const ofRole = [...t.withRole(n.role)];
    return structuredClone(t.nodes[ofRole[pick(ofRole.length)]!]!);
  }),
  'duplicate a read node': treeEdit('roles', (n) => [n, n]),
  'wrap a read node': treeEdit('roles', (n) => ({ role: 'region', name: 'Wrapper', children: [n] })),
  'insert before a read node': treeEdit('roles', (n) => [leaf('status', 'Inserted'), n]),
  'change text under a derived-text node': treeEdit('deep', (n) =>
    n.name !== undefined ? { ...n, name: `${n.name} and more` } : [n, { role: 'text', name: 'more' }],
  ),
  'insert a copy of a read role elsewhere': (s, pick, cs) => {
    if (!regularTree(s.a11y)) return undefined;
    const t = AXTable.of(s.a11y);
    const from = nodeWith(t, rolesOf(cs).roles, pick);
    const at = t.size > 1 ? 1 + pick(t.size - 1) : undefined;
    if (from === undefined || at === undefined) return undefined;
    const copy = structuredClone(t.nodes[from]!);
    return editById(s, (n, i) => (i === at ? [n, copy] : undefined), [at]);
  },
  'reverse a list': (s, pick) => {
    if (!regularTree(s.a11y)) return undefined;
    const t = AXTable.of(s.a11y);
    const parents = [...Array(t.size).keys()].filter((i) => (t.nodes[i]!.children?.length ?? 0) >= 2);
    if (!parents.length) return undefined;
    const id = parents[pick(parents.length)]!;
    return editById(s, (n, i) => (i === id ? { ...n, children: n.children!.toReversed() } : undefined), [id]);
  },
  'rename an unrelated node': treeEdit('any', (n) => ({ ...n, name: `${n.name ?? ''}!` })),
  'add an unrelated node': treeEdit('any', (n) => [n, leaf('note', 'Unrelated')]),
  'remove a network entry': (s, pick) => {
    if (!s.network?.length) return undefined;
    const i = pick(s.network.length);
    return { ...s, network: s.network.filter((_, j) => j !== i) };
  },
  'add a copy of a network entry': (s, pick) => {
    if (!s.network?.length) return undefined;
    const e = s.network[pick(s.network.length)]!;
    return { ...s, network: [...s.network, { ...e, seq: 10_000 + e.seq }] };
  },
  'change a network entry’s status': (s, pick) => {
    if (!s.network?.length) return undefined;
    const i = pick(s.network.length);
    return { ...s, network: s.network.map((e, j) => (j === i ? { ...e, status: e.status === 200 ? 500 : 200 } : e)) };
  },
  'change a response body': (s, pick) => {
    const withBody = s.network?.filter((e) => e.responseBody !== undefined) ?? [];
    if (!withBody.length) return undefined;
    const target = withBody[pick(withBody.length)]!;
    return {
      ...s,
      network: s.network!.map((e) => (e === target ? { ...e, responseBody: { changed: true } } : e)),
    };
  },
  'add an unrelated request': (s) =>
    s.network ? { ...s, network: [...s.network, { ...beacon, seq: 99_999 }] } : undefined,
  'reorder two network entries': (s) =>
    s.network && s.network.length >= 2
      ? { ...s, network: [s.network[1]!, s.network[0]!, ...s.network.slice(2)] }
      : undefined,
  'change a probe value somewhere': (s, pick) => probeEdit(s, pick, 'probes'),
  'change a baseline probe value somewhere': (s, pick) => probeEdit(s, pick, 'baseline'),
  'a probe fails': (s, pick) => {
    const names = Object.keys(s.probes);
    if (!names.length) return undefined;
    const k = names[pick(names.length)]!;
    return { ...s, probes: { ...s.probes, [k]: { ok: false, error: 'down' } } };
  },
  'add an unrelated storage key': (s) => {
    if (!s.storage) return undefined;
    const o = originOf(s.page.url);
    return {
      ...s,
      storage: { ...s.storage, local: { ...s.storage.local, [o]: { ...s.storage.local[o], other: '1' } } },
    };
  },
  'change every storage value': (s) => {
    if (!s.storage) return undefined;
    const area = (a: Record<string, Record<string, unknown>>) =>
      Object.fromEntries(
        Object.entries(a).map(([o, kv]) => [o, Object.fromEntries(Object.keys(kv).map((k) => [k, 'changed']))]),
      );
    return {
      ...s,
      storage: {
        cookies: s.storage.cookies.map((c) => ({ ...c, value: `${String(c.value)}x` })),
        local: area(s.storage.local) as never,
        session: area(s.storage.session) as never,
      },
    };
  },
  'a fragment on the URL': (s) => ({ ...s, page: { ...s.page, url: `${s.page.url.split('#')[0]}#x` } }),
  'a query parameter on the URL': (s) => {
    try {
      const u = new URL(s.page.url);
      u.searchParams.set('q', '1');
      return { ...s, page: { ...s.page, url: u.toString() } };
    } catch {
      return undefined;
    }
  },
  'another path': (s) => {
    try {
      const u = new URL(s.page.url);
      u.pathname = '/elsewhere';
      return { ...s, page: { ...s.page, url: u.toString() } };
    } catch {
      return undefined;
    }
  },
  'another origin': (s) => {
    try {
      const u = new URL(s.page.url);
      u.host = 'other.example';
      return { ...s, page: { ...s.page, url: u.toString() } };
    } catch {
      return undefined;
    }
  },
};

const beacon: NetworkEntry = {
  seq: 0,
  method: 'POST',
  url: 'https://beacon.example/collect',
  resourceType: 'beacon',
  status: 204,
  requestHeaders: {},
  responseHeaders: {},
};

function originOf(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return '';
  }
}

/** Pointers into a JSON value, a few levels deep. */
function pointers(v: Json, at = '', out: string[] = [], depth = 0): string[] {
  out.push(at);
  if (depth < 4 && v && typeof v === 'object')
    for (const [k, x] of Object.entries(v).slice(0, 5))
      pointers(x as Json, `${at}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`, out, depth + 1);
  return out;
}

function probeEdit(s: EvidenceSnapshot, pick: (n: number) => number, where: 'probes' | 'baseline') {
  const probes = where === 'probes' ? s.probes : s.baseline?.probes;
  const names = Object.keys(probes ?? {}).filter((k) => probes![k]!.ok);
  if (!names.length) return undefined;
  const k = names[pick(names.length)]!;
  const p = probes![k]! as { ok: true; value: Json };
  const ps = pointers(p.value);
  const edited = withPointer(p.value, ps[pick(ps.length)]!, 'changed');
  if (!edited) return undefined;
  const next = { ...probes, [k]: { ok: true as const, value: edited.doc } };
  return where === 'probes' ? { ...s, probes: next } : { ...s, baseline: { ...s.baseline!, probes: next } };
}

/** Every committed reference, each edit of `kinds` made twice at seeded places, and again on top: overlay against full runs. */
function editsAgree(kinds: string[]): Tally {
  const tally: Tally = { overlays: 0, fine: 0, ran: 0 };
  cases.forEach((c, k) => {
    const plan = compileChecks(c.checkSet);
    for (const r of c.refs) {
      const ref = new PlanRun(plan, buildStore(r.snapshot));
      const pick = rng(k * 7919 + r.name.length + 1);
      for (const kind of kinds) {
        const edit = EDITS[kind]!;
        for (let round = 0; round < 2; round++) {
          const s = edit(r.snapshot, pick, c.checkSet);
          if (!s) continue;
          const what = `${c.id} @ ${r.name}: ${kind} (round ${round})`;
          const o = same(plan, s, ref, what, tally);
          // The edit made again on top of it, as a success claim is made on a mutant.
          const again = edit(s, pick, c.checkSet);
          if (again) same(plan, again, o, `${what}, again`, tally);
        }
      }
    }
  });
  return tally;
}

/** The tree edits: those listed before the first network edit. */
const TREE_EDITS = Object.keys(EDITS).slice(0, Object.keys(EDITS).indexOf('remove a network entry'));

test('tree edits the generators do not make, at what the checks read and elsewhere: skipping gives what re-evaluating gives', () => {
  test.setTimeout(300_000);
  const tally = editsAgree(TREE_EDITS);
  expect(TREE_EDITS.length).toBeGreaterThan(10);
  expect(tally.overlays).toBeGreaterThan(8000);
  expect(tally.fine).toBeGreaterThan(1000);
  expect(tally.ran).toBeGreaterThan(1500);
});

test('network, probe, storage and URL edits the generators do not make: skipping gives what re-evaluating gives', () => {
  test.setTimeout(300_000);
  const tally = editsAgree(Object.keys(EDITS).filter((k) => !TREE_EDITS.includes(k)));
  expect(tally.overlays).toBeGreaterThan(8000);
  expect(tally.fine).toBeGreaterThan(1000);
  expect(tally.ran).toBeGreaterThan(1000);
});

// --- The change description, case by case ---------------------------------------------

const page = (children: AXNode[]): AXNode => ({ role: 'document', children: [{ role: 'main', children }] });

const SNAP: EvidenceSnapshot = {
  schema: 'assay.snapshot/v1',
  capturedAt: '2026-01-01T00:00:00Z',
  page: { url: 'https://shop.example/orders/12?tab=items', title: 'Order 12' },
  a11y: page([
    { role: 'heading', name: 'Order 12', level: 1 },
    { role: 'button', name: 'Pay', states: { disabled: false } },
    {
      role: 'table',
      name: 'Items',
      children: [
        {
          role: 'row',
          children: [
            { role: 'columnheader', name: 'Item' },
            { role: 'columnheader', name: 'Qty' },
          ],
        },
        {
          role: 'row',
          children: [
            { role: 'cell', name: 'Mug' },
            { role: 'cell', name: '2' },
          ],
        },
      ],
    },
    { role: 'region', name: 'Note', children: [{ role: 'paragraph', children: [{ role: 'text', name: 'Thanks' }] }] },
    {
      role: 'list',
      children: [
        { role: 'term', name: 'Total' },
        { role: 'definition', name: '$24' },
      ],
    },
  ]),
  text: 'Order 12\nPay\nThanks',
  network: [
    {
      seq: 1,
      method: 'POST',
      url: 'https://shop.example/api/orders',
      resourceType: 'fetch',
      status: 201,
      requestHeaders: {},
      responseHeaders: {},
      requestBody: { qty: 2 },
    },
    {
      seq: 2,
      method: 'GET',
      url: 'https://shop.example/api/cart',
      resourceType: 'fetch',
      status: 200,
      requestHeaders: {},
      responseHeaders: {},
    },
  ],
  storage: {
    cookies: [{ name: 'sid', value: 'abc', domain: 'shop.example', path: '/', httpOnly: true, secure: true }],
    local: { 'https://shop.example': { cart: '[]' } },
    session: {},
  },
  probes: { order: { ok: true, value: { id: 12, items: [{ sku: 'mug', qty: 2 }], total: 24 } } },
  baseline: {
    capturedAt: '2026-01-01T00:00:00Z',
    url: 'https://shop.example/',
    storage: null,
    probes: { order: { ok: true, value: { id: 11, total: 0 } } },
    redacted: [],
  },
  meta: { capturer: 'test', redacted: [] },
};

const CHECKS: Record<string, Assertion> = {
  button: { kind: 'state', target: { role: 'button', name: 'Pay' }, expect: { disabled: false } },
  heading: {
    kind: 'value',
    source: { from: 'node', target: { role: 'heading' }, field: 'name' },
    expect: { contains: '12' },
  },
  inMain: {
    kind: 'contains',
    match: { role: 'button', landmark: { role: 'main' } },
  },
  mainText: { kind: 'state', target: { role: 'main' }, expect: { text: { contains: 'Pay' } } },
  regionText: {
    kind: 'value',
    source: { from: 'text', scope: { role: 'region', name: 'Note' }, pattern: 'Thanks' },
    expect: { exists: true },
  },
  qty: {
    kind: 'value',
    source: { from: 'node', target: { role: 'cell', column: 'Qty' }, field: 'name' },
    expect: { equals: '2' },
  },
  terms: { kind: 'each', match: { role: 'term' }, assert: { kind: 'state', target: { role: 'term' }, expect: {} } },
  pages: {
    kind: 'page',
    match: { url: { path: '/orders/*' } },
    assert: { kind: 'contains', match: { role: 'heading' } },
  },
  post: { kind: 'request', match: { method: 'POST', url: { path: '/api/orders' } } },
  postBody: {
    kind: 'value',
    source: { from: 'request', match: { method: 'POST', url: { path: '/api/orders' } }, pointer: '/qty' },
    expect: { equals: 2 },
  },
  sequence: { kind: 'sequence', steps: [{ request: { method: 'POST' } }] },
  total: { kind: 'value', source: { from: 'probe', probe: 'order', pointer: '/total' }, expect: { equals: 24 } },
  // A field the probe does not have: unreadable while the probe works, a probe error when it fails.
  nope: { kind: 'value', source: { from: 'probe', probe: 'order', pointer: '/nope' }, expect: { exists: true } },
  totalBefore: {
    kind: 'value',
    source: { from: 'probe', probe: 'order', pointer: '/total', at: 'before' },
    expect: { equals: 0 },
  },
  sameAs: {
    kind: 'value',
    source: { from: 'probe', probe: 'order', pointer: '/items/0/qty' },
    expect: { sameAs: { source: { from: 'request', match: { method: 'POST' }, pointer: '/qty' } } },
  },
  cart: { kind: 'value', source: { from: 'storage', area: 'local', key: 'cart' }, expect: { equals: '[]' } },
  sid: { kind: 'value', source: { from: 'storage', area: 'cookie', key: 'sid' }, expect: { exists: true } },
  path: { kind: 'value', source: { from: 'url', part: 'pathname' }, expect: { equals: '/orders/12' } },
  tab: { kind: 'value', source: { from: 'url', part: { param: 'tab' } }, expect: { equals: 'items' } },
  missingParam: { kind: 'value', source: { from: 'url', part: { param: 'none' } }, expect: { equals: null } },
  url: { kind: 'url', match: { path: '/orders/*' } },
};

const SET: CheckSet = {
  schema: 'assay.checks/v1',
  id: 'delta',
  version: '1',
  task: { instruction: 'test' },
  requirements: [{ id: 'R1', kind: 'hard', text: 'r' }],
  checks: Object.entries(CHECKS).map(([id, assert]) => ({ id, requirement: 'R1', description: id, assert })),
} as CheckSet;

/** Which checks an overlay ran (the others took the base's result); and the outcome equals a full run. */
function ran(s: EvidenceSnapshot, base: EvidenceSnapshot = SNAP): string[] {
  const plan = compileChecks(SET);
  const ref = new PlanRun(plan, buildStore(base));
  const run = new PlanRun(plan, buildStore(s), ref);
  const full = runPlan(plan, buildStore(structuredClone(s)), { digests: false });
  expect(JSON.stringify(run.outcome({ digests: false }))).toBe(JSON.stringify(full));
  return plan.checks.filter((_, i) => run.check(i) !== ref.check(i)).map((c) => c.check.id);
}

/** `SNAP` with the node `role` (named `name`, when given) edited by `fn`. */
function editNode(
  role: string,
  fn: (n: AXNode) => AXNode | AXNode[] | null,
  name?: string,
  s = SNAP,
): EvidenceSnapshot {
  const t = AXTable.of(s.a11y);
  const id = [...t.withRole(role)].find((i) => name === undefined || t.nodes[i]!.name === name)!;
  return editById(s, (n, i) => (i === id ? fn(n) : undefined), [id]);
}

test('an edit that touches a role a check reads makes it run; others take the base result', () => {
  // Renaming the button: every check that locates buttons runs; the heading, table and network checks do not.
  const renamed = ran(editNode('button', (n) => ({ ...n, name: 'Pay now' })));
  expect(renamed).toEqual(expect.arrayContaining(['button', 'inMain', 'pages', 'mainText']));
  for (const id of ['heading', 'qty', 'post', 'total', 'cart', 'path', 'regionText']) expect(renamed).not.toContain(id);
  // A state change of the button too (its own fields).
  expect(ran(editNode('button', (n) => ({ ...n, states: { disabled: true } })))).toContain('button');
  // A node added next to the button inside main: main's text changed, so a check of main's text runs;
  // the landmark of `inMain` is only matched on main's role and name, which did not change.
  const added = ran(editNode('button', (n) => [n, { role: 'note', name: 'Hi' }]));
  expect(added).toContain('mainText');
  expect(added).not.toContain('inMain');
  expect(added).not.toContain('button');
  // The button replaced by a link at the same place: the button is gone, so its checks run.
  expect(ran(editNode('button', (n) => ({ ...n, role: 'link' })))).toEqual(
    expect.arrayContaining(['button', 'inMain', 'mainText']),
  );
  // Main renamed: its label is in every path below it, and a landmark reads its name.
  const main = ran(editNode('main', (n) => ({ ...n, name: 'Content' })));
  expect(main).toEqual(expect.arrayContaining(['button', 'heading', 'inMain', 'mainText', 'qty', 'regionText']));
});

test('derived text, column headers, term records and page selection are read through other nodes', () => {
  // Text under the region: the scoped text source reads the region's derived text.
  expect(ran(editNode('text', (n) => ({ ...n, name: 'Thanks a lot' }), 'Thanks'))).toContain('regionText');
  // A column header renamed, or a row added: the column locator reads the header row and the rows.
  expect(ran(editNode('columnheader', (n) => ({ ...n, name: 'Count' }), 'Qty'))).toContain('qty');
  expect(
    ran(editNode('row', (n) => [n, { role: 'row', children: [{ role: 'cell', name: 'x' }] }], undefined)),
  ).toContain('qty');
  // A cell moved within its row: the header it falls under changed although no cell was added.
  expect(
    ran(
      editNode(
        'row',
        (n) => ({ ...n, children: n.children!.toReversed() }),
        undefined,
        editNode('heading', (h) => h),
      ),
    ),
  ).toContain('qty');
  // A definition beside a term: a term record is the term with its definitions (any tree change reruns it).
  expect(ran(editNode('definition', (n) => ({ ...n, name: '$25' })))).toContain('terms');
  // A page assertion selects among open pages: any tree change reruns it.
  expect(ran(editNode('paragraph', (n) => [n, { role: 'note' }]))).toContain('pages');
  expect(ran(editNode('paragraph', (n) => [n, { role: 'note' }]))).not.toContain('button');
});

test('network, probe, storage and URL changes run exactly the checks that read them', () => {
  const net = SNAP.network!;
  // An unrelated request: no request match accepts it.
  const beaconRan = ran({ ...SNAP, network: [...net, { ...beacon, seq: 3 }] });
  expect(beaconRan).not.toContain('post');
  expect(beaconRan).not.toContain('postBody');
  // The sequence reads the trajectory's view of the log: it runs on any change to the log.
  expect(beaconRan).toContain('sequence');
  // A second matching POST: every check that matches POSTs runs.
  const second = ran({ ...SNAP, network: [...net, { ...net[0]!, seq: 3 }] });
  expect(second).toEqual(expect.arrayContaining(['post', 'postBody', 'sameAs', 'sequence']));
  // A changed body of the matching entry (a replaced entry): runs.
  expect(ran({ ...SNAP, network: [{ ...net[0]!, requestBody: { qty: 3 } }, net[1]!] })).toEqual(
    expect.arrayContaining(['post', 'postBody', 'sameAs']),
  );
  // Shared entries in another order cannot be described: every network check runs.
  expect(ran({ ...SNAP, network: [net[1]!, net[0]!] })).toEqual(expect.arrayContaining(['post', 'postBody']));

  const order = SNAP.probes.order as { ok: true; value: { [k: string]: Json } };
  const probe = (value: Json) => ({ ...SNAP, probes: { order: { ok: true as const, value } } });
  // Another field of the probe: the total and the quantity read the same values.
  expect(ran(probe({ ...order.value, id: 13 }))).toEqual([]);
  expect(ran(probe({ ...order.value, total: 25 }))).toEqual(['total']);
  expect(ran(probe({ ...order.value, items: [{ sku: 'mug', qty: 3 }] }))).toEqual(['sameAs']);
  expect(ran({ ...SNAP, probes: { order: { ok: false, error: 'down' } } })).toEqual(['total', 'nope', 'sameAs']);
  // The baseline's probe: only the check that reads it before the task.
  expect(
    ran({ ...SNAP, baseline: { ...SNAP.baseline!, probes: { order: { ok: true, value: { id: 11, total: 1 } } } } }),
  ).toEqual(['totalBefore']);
  // A value is the same only when it is the same JSON, strictly: -0 is not 0 (it could compare otherwise).
  expect(ran(probe({ ...order.value, total: 24, id: 12 }))).toEqual([]);
  expect(ran(probe({ ...order.value, id: -0 }))).toEqual([]);
  expect(ran(probe({ ...order.value, total: 24.0 }))).toEqual([]);
  expect(
    ran({ ...SNAP, probes: { order: { ok: true, value: { ...order.value, items: [{ qty: 2, sku: 'mug' }] } } } }),
  ).toEqual([]);
  expect(sameValue(0, -0)).toBe(false);

  const st = SNAP.storage!;
  expect(ran({ ...SNAP, storage: { ...st, local: { 'https://shop.example': { cart: '[]', other: '1' } } } })).toEqual(
    [],
  );
  expect(ran({ ...SNAP, storage: { ...st, local: { 'https://shop.example': { cart: '[1]' } } } })).toEqual(['cart']);
  expect(
    ran({
      ...SNAP,
      storage: { ...st, cookies: [...st.cookies, { ...st.cookies[0]!, value: 'x', domain: 'other.example' }] },
    }),
  ).toEqual(['sid']);

  const at = (url: string) => ran({ ...SNAP, page: { ...SNAP.page, url } });
  // A fragment: only what reads the whole URL (an absent parameter's result shows the whole URL).
  expect(at('https://shop.example/orders/12?tab=items#top')).toEqual(['pages', 'missingParam', 'url']);
  // Another query: the parameter read and the absent one (its result shows the whole URL).
  expect(at('https://shop.example/orders/12?tab=other')).toEqual(['pages', 'tab', 'missingParam', 'url']);
  // Another origin: storage at the page's origin and host too.
  expect(at('https://other.example/orders/12?tab=items')).toEqual(['pages', 'cart', 'sid', 'missingParam', 'url']);
});

test('the tree delta: kept ancestors, touched subtrees, regularity and its budget', () => {
  const tree = SNAP.a11y;
  const renamed = editNode('button', (n) => ({ ...n, name: 'Pay now' })).a11y;
  const d = treeDelta(tree, renamed)!;
  expect([...d.touched]).toEqual(['button']);
  expect([...d.kept].toSorted()).toEqual(['document', 'main']);
  // A node inserted: only it is touched.
  const inserted = editNode('heading', (n) => [
    n,
    { role: 'status', children: [{ role: 'text', name: 'Saved' }] },
  ]).a11y;
  expect([...treeDelta(tree, inserted)!.touched].toSorted()).toEqual(['status', 'text']);
  // A wrapper: the wrapped subtree is touched on both sides.
  const wrapped = editNode('table', (n) => ({ role: 'region', children: [n] })).a11y;
  expect([...treeDelta(tree, wrapped)!.touched]).toEqual(expect.arrayContaining(['table', 'region', 'row', 'cell']));
  // Structurally equal copies are not changes.
  expect(treeDelta(tree, structuredClone(tree))).toEqual({ touched: new Set(), kept: new Set() });
  // Not regular: no delta, and regularEdit agrees with regularTree.
  const holes = { ...tree, children: [{ role: 'main', children: [] }] } as AXNode;
  expect(treeDelta(tree, holes)).toBeNull();
  expect(regularEdit(tree, holes)).toBe(false);
  expect(regularEdit(tree, renamed)).toBe(true);
  expect(regularEdit(tree, renamed)).toBe(regularTree(structuredClone(renamed)));
  // Over budget: not described (every check of the tree reruns).
  const many = editById(SNAP, (n) => (n.name !== undefined ? { ...n, name: `${n.name}.` } : undefined)).a11y;
  expect(treeDelta(tree, many, 4)).toBeNull();
  expect(TREE_DELTA_BUDGET).toBeGreaterThan(4);
});

test('the network delta, URL reads and fine reads', () => {
  const [a, b] = SNAP.network!;
  const c = { ...beacon };
  expect(networkDelta([a, b], [a, b, c])).toEqual([c]);
  expect(networkDelta([a, b], [b])).toEqual([a]);
  expect(networkDelta([a, b], [a, c, b])).toEqual([c]);
  expect(networkDelta([a, b], [b, a])).toBeNull();
  expect(networkDelta([a, a], [a])).toBeNull();
  expect(networkDelta(null, [a])).toBeNull();

  expect(sameUrlRead('https://a.example/x#1', 'https://a.example/x#2', { part: 'pathname' })).toBe(true);
  expect(sameUrlRead('https://a.example/x#1', 'https://a.example/x#2', { href: true })).toBe(false);
  expect(sameUrlRead('not a url', 'also not', { part: 'pathname' })).toBe(false);
  expect(sameUrlRead('https://a.example/x', 'https://a.example/y', { origin: true })).toBe(true);
  expect(sameUrlRead('https://a.example/?p=1', 'https://a.example/?p=1&q=2', { param: 'p' })).toBe(true);
  expect(sameUrlRead('https://a.example/?q=1', 'https://a.example/?q=2', { param: 'p' })).toBe(false);

  const f = fineReadsOf(CHECKS.sameAs!)!;
  expect(f.probes).toEqual([{ probe: 'order', at: 'after', pointer: '/items/0/qty' }]);
  expect(f.requests).toHaveLength(1);
  expect(fineReadsOf(CHECKS.qty!)!.deep).toEqual(new Set(['row', 'table', 'grid', 'treegrid']));
  expect(fineReadsOf(CHECKS.terms!)!.treeOpaque).toBe(true);
  expect(fineReadsOf({ kind: 'nope' } as never)).toBeNull();
  expect(fineReadsOf({ kind: 'state', target: { anchors: 'x' }, expect: {} } as never)).toBeNull();
  expect(fineReadsOf({ kind: 'state', target: { role: 7 }, expect: {} } as never)).toBeNull();
});

test('variants left unbuilt are the variants generateVariants builds, and change nothing a check reads', () => {
  test.setTimeout(120_000);
  let unbuilt = 0;
  for (const c of cases) {
    const plan = compileChecks(c.checkSet);
    for (const r of c.refs) {
      const all = generateVariants(c.checkSet, r.snapshot);
      const keysOf = new Map(all.map((v) => [v.id, changedKeys(r.snapshot, v.snapshot)!]));
      // Every variant unread, so the shortcut is tried for every one that has it.
      const some = stressVariants(c.checkSet, r.snapshot, () => true);
      expect(some.map((v) => [v.id, v.description])).toEqual(all.map((v) => [v.id, v.description]));
      // As the stress test asks: only those no check reads.
      const unread = (keys: readonly string[]) =>
        plan.checks.every((x) => x.reads !== null && !readsChanged(x.reads, new Set(keys)));
      for (const v of stressVariants(c.checkSet, r.snapshot, unread)) {
        if (v.snapshot) continue;
        unbuilt++;
        for (const x of plan.checks) expect(readsChanged(x.reads!, keysOf.get(v.id)!), `${c.id}: ${v.id}`).toBe(false);
      }
    }
  }
  expect(unbuilt).toBeGreaterThan(200);
});

test('a malformed snapshot is built as before: it fails where generateVariants fails', () => {
  const base = SNAP;
  const malformed: EvidenceSnapshot[] = [
    { ...base, network: [null as never] },
    { ...base, trajectory: 'x' as never },
    { ...base, a11y: page([{ role: 'button', name: 7 as never }]) },
    { ...base, a11y: page([{ role: 'list', children: [] }]) },
    { ...base, text: 5 as never },
    { ...base, storage: { ...base.storage!, cookies: 'x' as never } },
    { ...base, storage: { ...base.storage!, local: undefined as never } },
  ];
  for (const s of malformed) {
    let want: string;
    try {
      want = JSON.stringify(generateVariants(SET, s).map((v) => v.id));
    } catch (e) {
      want = `throws ${(e as Error).message}`;
    }
    let got: string;
    try {
      got = JSON.stringify(stressVariants(SET, s, () => true).map((v) => v.id));
    } catch (e) {
      got = `throws ${(e as Error).message}`;
    }
    expect(got).toBe(want);
  }
});

test('stressTest gives the same report whatever the check set reads', () => {
  // The example set over SNAP, and the same set without its tree checks (more variants unbuilt).
  const noTree: CheckSet = { ...SET, checks: SET.checks.filter((c) => fineReadsOf(c.assert)!.roles.size === 0) };
  for (const cs of [SET, noTree]) {
    const r = stressTest(cs, [{ name: 'ref', snapshot: SNAP }]);
    const variants = generateVariants(cs, SNAP);
    expect(r.variants.map((v) => v.id)).toEqual(
      r.variants[0]?.id === 'reference' ? ['reference'] : variants.map((v) => v.id),
    );
  }
});
