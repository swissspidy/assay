/** Per-record checks (`each`, ADR 0008) and multi-field `items` projections (`pick`). */
import { test, expect } from '@playwright/test';
import {
  describeAssertion,
  evaluate,
  validateCheckSet,
  type Assertion,
  type Check,
  type CheckSet,
  type EvidenceSnapshot,
  type Json,
} from '../../src/index.ts';
import { evaluateAssertion } from '../../src/runtime/evaluate.ts';
import { applyNormalizers, fromJson, toJson } from '../../src/runtime/values.ts';
import { AXIndex } from '../../src/runtime/axindex.ts';
import { parseAriaSnapshot } from '../../src/snapshot/aria.ts';
import { looseMatches } from '../../src/dsl/validate.ts';
import { pickOnSameShapes, type Reference } from '../../src/compiler/compile.ts';

const YAML = `
- main:
  - heading "Lunch with Sam" [level=1]
  - term: When
  - definition: Thursday, November 5, 2026, 12:30 PM
  - term: Duration
  - definition: 1 hour
  - term: Organizer
  - term: Host
  - definition: Sam
  - term: Location
  - definition: —
  - table "Issues":
    - rowgroup:
      - row "# Title Status Labels":
        - columnheader "#"
        - columnheader "Title"
        - columnheader "Status"
        - columnheader "Labels"
    - rowgroup:
      - row "1 Login button misaligned Open bug":
        - cell "1"
        - cell "Login button misaligned":
          - link "Login button misaligned"
        - cell "Open"
        - cell "bug"
      - row "2 Add dark mode Closed feature":
        - cell "2"
        - cell "Add dark mode":
          - link "Add dark mode"
        - cell "Closed"
        - cell "feature"
  - list "Orders":
    - listitem:
      - text: Order A1
      - list:
        - listitem: Blue Mug × 2
        - listitem: Red Mug × 1
    - listitem:
      - text: Order A2
      - list:
        - listitem: Tea towel × 3
`;

function snap(): EvidenceSnapshot {
  return {
    schema: 'assay.snapshot/v1',
    capturedAt: '2026-11-05T00:00:00.000Z',
    page: { url: 'https://calendar.test/events/1', title: 't' },
    a11y: parseAriaSnapshot(YAML),
    text: 'When\nThursday, November 5, 2026, 12:30 PM',
    network: [],
    storage: { cookies: [], local: {}, session: {} },
    probes: {},
    meta: { capturer: 'test', redacted: [] },
  };
}

const run = (a: Assertion, s = snap()) => evaluateAssertion({ snapshot: s, index: new AXIndex(s.a11y) }, a);

const issues = { role: 'table', name: 'Issues' } as const;
const rowOf = (title: string, assert: Assertion): Assertion => ({
  kind: 'each',
  scope: issues,
  match: { role: 'row', name: { contains: title } },
  assert,
});
const cell = (name: string): Assertion => ({ kind: 'contains', match: { role: 'cell', name } });

const dateOf = (term: string): Assertion => ({
  kind: 'each',
  scope: { role: 'main' },
  match: { role: 'term', text: term },
  assert: {
    kind: 'value',
    source: { from: 'node', target: { role: 'definition' }, field: 'text' },
    normalize: [
      { op: 'replace', regex: ', \\d{1,2}:\\d{2} [AP]M$', with: '' },
      { op: 'date', locale: 'en-US' },
    ],
    expect: { equals: '2026-11-05' },
  },
});

test.describe('each: runtime', () => {
  test('a cell belongs to the row it is in, not to any row of the table', () => {
    expect(run(rowOf('Login button misaligned', cell('Open'))).status).toBe('pass');
    // "Closed" is in the table, but in another row.
    const wrong = run(rowOf('Login button misaligned', cell('Closed')));
    expect(wrong.status).toBe('fail');
    expect(wrong.message).toContain('row "1 Login button misaligned Open bug"');
    // Unscoped, the same cell is found in the other row: the gap each closes.
    expect(run({ kind: 'contains', scope: issues, match: { role: 'cell', name: 'Closed' } }).status).toBe('pass');
  });

  test('a term record is the term with the definitions after it', () => {
    expect(run(dateOf('When')).status).toBe('pass');
    // The date is on the page, but not under Duration: the definition there does not parse.
    const elsewhere = run(dateOf('Duration'));
    expect(elsewhere.status).toBe('abstain');
    expect(elsewhere.reason).toBe('normalize_failed');
    // Consecutive terms share the definitions after the last of them.
    const host = (term: string): Assertion => ({
      kind: 'each',
      scope: { role: 'main' },
      match: { role: 'term', text: term },
      assert: { kind: 'state', target: { role: 'definition' }, expect: { text: 'Sam' } },
    });
    expect(run(host('Organizer')).status).toBe('pass');
    expect(run(host('Host')).status).toBe('pass');
    // A term group's own text is the term and its definitions.
    const idx = new AXIndex(snap().a11y);
    const [when] = idx.records({ role: 'term', text: 'When' });
    expect(idx.text(when!)).toBe('When Thursday, November 5, 2026, 12:30 PM');
    expect(idx.path(when!)).toBe('main › term "When"');
  });

  test('every record must satisfy the assertion (strong Kleene conjunction)', () => {
    const rows = (assert: Assertion): Assertion => ({
      kind: 'each',
      scope: issues,
      witness: { role: 'columnheader', name: 'Status' },
      match: { role: 'row', name: { regex: '^\\d+ ' } },
      assert,
    });
    expect(run(rows({ kind: 'contains', match: { role: 'link' } })).status).toBe('pass');
    const open = run(rows(cell('Open')));
    expect(open.status).toBe('fail');
    expect(open.message).toContain('[fail] main › table "Issues" › rowgroup › row "2 Add dark mode Closed feature"');
    expect(open.message).not.toContain('[pass]');
    // One record abstains (its anchor is missing), the others pass: abstain.
    const status = run(rows({ kind: 'state', target: { role: 'cell', name: 'Open' }, expect: { disabled: false } }));
    expect(status.status).toBe('abstain');
    expect(status.reason).toBe('anchor_missing');
  });

  test('the number of records is outcome evidence; the scope and witness are anchors', () => {
    const none = run(rowOf('Fix typo', cell('Open')));
    expect(none.status).toBe('fail');
    expect(none.message).toContain('0 record(s)');
    expect(run({ ...(rowOf('Login', cell('Open')) as object), count: { eq: 2 } } as Assertion).status).toBe('fail');
    const missing = run({
      ...(rowOf('Login', cell('Open')) as object),
      scope: { role: 'table', name: 'Cart' },
    } as Assertion);
    expect(missing.status).toBe('abstain');
    expect(missing.reason).toBe('anchor_missing');
    const noWitness = run({
      ...(rowOf('Login', cell('Open')) as object),
      witness: { role: 'columnheader', name: 'Priority' },
    } as Assertion);
    expect(noWitness.status).toBe('abstain');
    expect(noWitness.message).toContain('Witness columnheader named "Priority"');
  });

  test('locators and text sources resolve inside the record', () => {
    // A target that is ambiguous on the page is unique inside one row.
    const status: Assertion = rowOf('Add dark mode', {
      kind: 'value',
      source: { from: 'node', target: { role: 'link' }, field: 'name' },
      expect: { equals: 'Add dark mode' },
    });
    expect(run(status).status).toBe('pass');
    // An anchor missing in the record abstains and says where it looked.
    const missing = run(rowOf('Login', { kind: 'state', target: { role: 'checkbox' }, expect: { checked: true } }));
    expect(missing.status).toBe('abstain');
    expect(missing.message).toContain('Anchor not found in main › table "Issues" › rowgroup › row "1 Login');
    // An unscoped text source reads the record's text, not the page text.
    const text = (pattern: string) =>
      run(rowOf('Login', { kind: 'value', source: { from: 'text', pattern }, expect: { exists: true } })).status;
    expect(text('Open')).toBe('pass');
    expect(text('Closed')).toBe('abstain');
  });

  test('records nest: the order whose items include a Blue Mug', () => {
    const order = (item: string): Assertion => ({
      kind: 'each',
      scope: { role: 'list', name: 'Orders' },
      match: { role: 'listitem', text: { contains: 'Order A1' } },
      assert: {
        kind: 'each',
        match: { role: 'listitem', text: { contains: item } },
        assert: { kind: 'value', source: { from: 'text', pattern: '× (\\d+)' }, expect: { equals: '2' } },
      },
    });
    expect(run(order('Blue Mug')).status).toBe('pass');
    expect(run(order('Red Mug')).status).toBe('fail');
    // Tea towel is in another order: no record inside A1.
    expect(run(order('Tea towel')).status).toBe('fail');
  });

  test('describeAssertion renders an each for review', () => {
    expect(describeAssertion(dateOf('When'))).toContain(
      'in main, at least 1 term with text "When" (with its definitions), and inside each: the text of definition',
    );
  });
});

test.describe('items pick', () => {
  const cart: Json = [
    { sku: 'A', qty: 1, price: 2 },
    { sku: 'B', qty: 2, price: 3 },
  ];
  const pick = (v: Json) => toJson(applyNormalizers(fromJson(v), [{ op: 'items', pick: ['/sku', '/qty'] }]));

  test('keeps the picked fields of each item together, sorted', () => {
    expect(pick(cart)).toEqual([
      { '/sku': 'A', '/qty': 1 },
      { '/sku': 'B', '/qty': 2 },
    ]);
    // Extra fields are ignored; the order of the array is not significant.
    expect(
      pick([
        { sku: 'B', qty: 2, lineTotal: 6 },
        { sku: 'A', qty: 1, lineTotal: 2 },
      ]),
    ).toEqual(pick(cart));
    // 1×A + 2×B is not 2×A + 1×B, though each field on its own matches.
    expect(
      pick([
        { sku: 'A', qty: 2 },
        { sku: 'B', qty: 1 },
      ]),
    ).not.toEqual(pick(cart));
  });

  test('a missing picked field cannot be read', () => {
    expect(() => pick([{ sku: 'A' }])).toThrow(/\/qty not present in item 0/);
  });
});

test.describe('each and pick: validation', () => {
  const set = (assert: Assertion, more: Check[] = []): CheckSet => ({
    schema: 'assay.checks/v1',
    id: 't',
    version: '1',
    task: { instruction: 'Add lunch on November 5, 2026.' },
    requirements: [{ id: 'R1', kind: 'hard', text: 't', source: { field: 'instruction', quote: 'Add lunch' } }],
    checks: [{ id: 'C1', requirement: 'R1', description: 'd', assert }, ...more],
  });

  test('an each validates and runs in a check set', () => {
    const cs = set(dateOf('When'));
    expect(validateCheckSet(cs)).toEqual({ ok: true, errors: [], warnings: [] });
    expect(evaluate(cs, snap()).verdict).toBe('success');
  });

  test('inside each, only the record may be read', () => {
    const inside = (assert: Assertion) =>
      validateCheckSet(set({ kind: 'each', scope: issues, match: { role: 'row' }, assert })).errors;
    expect(inside({ kind: 'url', match: { path: '/issues' } })).toEqual([
      expect.stringContaining('C1.assert: a url assertion inside each does not read the record'),
    ]);
    expect(inside({ kind: 'allOf', of: [{ kind: 'request', match: { method: 'POST' } }] })).toEqual([
      expect.stringContaining('a request assertion inside each'),
    ]);
    expect(inside({ kind: 'value', source: { from: 'probe', probe: 'issues' }, expect: { exists: true } })).toEqual([
      expect.stringContaining('inside each, a value check must read the record'),
    ]);
    // The other side of a binding may come from anywhere: the row's title is the probe's.
    expect(
      inside({
        kind: 'value',
        source: { from: 'node', target: { role: 'link' }, field: 'name' },
        expect: { sameAs: { source: { from: 'probe', probe: 'issue', pointer: '/title' } } },
      }),
    ).toEqual([]);
  });

  test('scope warnings: each without a scope, but not a contains inside a record', () => {
    const w = (a: Assertion) => validateCheckSet(set(a)).warnings;
    expect(w({ kind: 'each', match: { role: 'row' }, assert: cell('Open') })).toEqual([
      expect.stringContaining('each without a scope searches the whole page'),
    ]);
    expect(w(rowOf('Login', cell('Open')))).toEqual([]);
    expect(w({ ...(rowOf('Login', cell('Open')) as object), count: { gte: 0 } } as Assertion)).toEqual([
      expect.stringContaining('each with a count that allows no records passes vacuously'),
    ]);
  });

  test('a definition read by its own content is loose; inside its term it is bound', () => {
    const loose = (a: Assertion) => looseMatches(set(a));
    const advice = expect.stringContaining('reads a definition (a dd) found by its own content');
    expect(
      loose({
        kind: 'contains',
        scope: { role: 'main' },
        match: { role: 'definition', text: { regex: 'November 5, 2026' } },
      }),
    ).toEqual([advice]);
    expect(
      loose({
        kind: 'value',
        source: { from: 'node', target: { role: 'definition', text: { contains: '2026' } }, field: 'text' },
        expect: { contains: 'November 5' },
      }),
    ).toEqual([advice]);
    expect(
      loose({ kind: 'state', target: { role: 'text', within: { role: 'definition' } }, expect: { name: 'x' } }),
    ).toEqual([advice]);
    expect(loose(dateOf('When'))).toEqual([]);
    // An absence check across all definitions is a page-wide fact.
    expect(
      loose({
        kind: 'contains',
        scope: { role: 'main' },
        witness: { role: 'term' },
        match: { role: 'definition', text: 'Cancelled' },
        count: { eq: 0 },
      }),
    ).toEqual([]);
    // The validator reports it as a warning; the compiler refuses it.
    expect(
      validateCheckSet(set({ kind: 'contains', scope: { role: 'main' }, match: { role: 'definition' } })).warnings,
    ).toEqual([advice]);
  });

  test('items takes pointer or pick, not both; pick keeps fields paired for the field-wise rule', () => {
    const items = (proj: object): Assertion => ({
      kind: 'value',
      source: { from: 'probe', probe: 'latestOrder', pointer: '/items' },
      normalize: [{ op: 'items', ...proj }],
      expect: {
        sameAs: {
          source: { from: 'probe', probe: 'cart', pointer: '/items', at: 'before' },
          normalize: [{ op: 'items', ...proj }],
        },
      },
    });
    expect(validateCheckSet(set(items({ pointer: '/sku', pick: ['/qty'] }))).errors).toEqual([
      expect.stringContaining('items takes either pointer (one field) or pick (several fields), not both'),
      expect.stringContaining('sameAs: items takes either pointer'),
    ]);
    expect(validateCheckSet(set(items({ pick: [] }))).ok).toBe(false);
    const fieldwise = (...projections: object[]) =>
      looseMatches(
        set(
          items(projections[0]!),
          projections
            .slice(1)
            .map((p, i) => ({ id: `C${i + 2}`, requirement: 'R1', description: 'd', assert: items(p) })),
        ),
      ).filter((w) => w.includes('one field at a time'));
    expect(fieldwise({ pick: ['/sku', '/qty'] })).toEqual([]);
    expect(fieldwise({ pointer: '/sku' }, { pointer: '/qty' })).toHaveLength(1);
    // A pick of every compared field keeps them paired; the per-field checks are then redundant.
    expect(fieldwise({ pointer: '/sku' }, { pointer: '/qty' }, { pick: ['/qty', '/sku'] })).toEqual([]);
    // Two picks that each leave a field out still pair different records' fields.
    expect(fieldwise({ pick: ['/sku', '/qty'] }, { pick: ['/sku', '/price'] })).toEqual([
      expect.stringContaining('items fields /price, /qty, /sku'),
    ]);
  });
});

test.describe('pick only for collections of different shapes', () => {
  const binding = (source: object, other: object, proj: object = { pick: ['/sku', '/qty'] }): Assertion => ({
    kind: 'value',
    source: source as Extract<Assertion, { kind: 'value' }>['source'],
    normalize: [{ op: 'items', ...proj }],
    expect: {
      sameAs: {
        source: other as Extract<Assertion, { kind: 'value' }>['source'],
        normalize: [{ op: 'items', ...proj }],
      },
    },
  });
  const cartAfter = { from: 'probe', probe: 'cart', pointer: '/items' };
  const cartBefore = { ...cartAfter, at: 'before' };
  const order = { from: 'probe', probe: 'latestOrder', pointer: '/items' };
  const set = (a: Assertion): CheckSet => ({
    schema: 'assay.checks/v1',
    id: 't',
    version: '1',
    task: { instruction: 'Keep everything else.' },
    requirements: [{ id: 'R1', kind: 'hard', text: 't', source: { field: 'instruction', quote: 'Keep' } }],
    checks: [{ id: 'C1', requirement: 'R1', description: 'd', assert: a }],
  });

  test('the same collection before and after is one shape: pick is loose', () => {
    const advice = expect.stringContaining('items pick compares only some fields of one collection before and after');
    expect(looseMatches(set(binding(cartAfter, cartBefore)))).toEqual([advice]);
    expect(validateCheckSet(set(binding(cartAfter, cartBefore))).warnings).toEqual([advice]);
    // Whole items, a pointer (one field is all the task is about), or two collections are not flagged statically.
    expect(looseMatches(set(binding(cartAfter, cartBefore, {})))).toEqual([]);
    expect(looseMatches(set(binding(cartAfter, cartBefore, { pointer: '/sku' })))).toEqual([]);
    expect(looseMatches(set(binding(order, cartBefore)))).toEqual([]);
  });

  test('the compiler refuses pick when both collections hold items with the same fields', () => {
    const items = [
      { sku: 'MUG-BLUE', qty: 1, price: 12 },
      { sku: 'MUG-RED', qty: 2, price: 9.5 },
    ];
    const reference = (lines: Json[]): Reference => ({
      name: 'r',
      kind: 'success',
      snapshot: {
        ...snap(),
        probes: { latestOrder: { ok: true, value: { items: lines } } },
        baseline: {
          capturedAt: '',
          url: 'https://shop.test/cart',
          storage: null,
          probes: { cart: { ok: true, value: { items } } },
          redacted: [],
        },
      },
    });
    const errors = (lines: Json[]) => pickOnSameShapes(set(binding(order, cartBefore)), [reference(lines)]);
    expect(errors(items)).toEqual([
      expect.stringContaining('check C1: items pick compares only some fields of two collections'),
    ]);
    // Order lines with a field the cart lacks: pick is what keeps them comparable.
    expect(errors(items.map((x) => ({ ...x, lineTotal: x.qty * x.price })))).toEqual([]);
    // Nothing to judge the shapes by: not refused.
    expect(errors([])).toEqual([]);
  });
});

test.describe('review fixes', () => {
  const set = (assert: Assertion): CheckSet => ({
    schema: 'assay.checks/v1',
    id: 't',
    version: '1',
    task: { instruction: 'Keep the cart.' },
    requirements: [{ id: 'R1', kind: 'hard', text: 't', source: { field: 'instruction', quote: 'Keep' } }],
    checks: [{ id: 'C1', requirement: 'R1', description: 'd', assert }],
  });

  test('an each witness that matches more than one node abstains as ambiguous', () => {
    const r = run({
      kind: 'each',
      scope: issues,
      witness: { role: 'columnheader' },
      match: { role: 'row', name: { contains: 'Login' } },
      assert: cell('Open'),
    });
    expect(r.status).toBe('abstain');
    expect(r.reason).toBe('anchor_ambiguous');
    expect(r.message).toContain('matches 4 nodes');
  });

  test('a cell bound to its column: a title cell named Open is not the status', () => {
    const s = snap();
    // Issue 2 is closed but titled "Open": its title cell reads "Open".
    const row2 = s.a11y.children![0]!.children!.find((n) => n.role === 'table')!.children![1]!.children![1]!;
    row2.name = '2 Open Closed feature';
    row2.children![1] = { role: 'cell', name: 'Open', children: [{ role: 'link', name: 'Open' }] };
    const status = (column?: string): Assertion =>
      rowOf('Closed', {
        kind: 'contains',
        match: { role: 'cell', name: 'Open', ...(column ? { column } : {}) },
      });
    expect(run(status(), s).status).toBe('pass');
    expect(run(status('Status'), s).status).toBe('fail');
    expect(run(status('Title'), s).status).toBe('pass');
    // The header row's cells, and cells outside a table, have no column to match.
    const idx = new AXIndex(s.a11y);
    expect(idx.find({ role: 'cell', column: 'Status' }).map((n) => n.node.name)).toEqual(['Open', 'Closed']);
    expect(idx.find({ role: 'columnheader', column: 'Labels' }).map((n) => n.node.name)).toEqual(['Labels']);
    expect(
      validateCheckSet(set({ kind: 'contains', scope: issues, match: { role: 'row', column: 'Status' } })).errors,
    ).toEqual([expect.stringContaining('column binds a cell to its column header; role row has no column')]);
  });

  test('describeAssertion says "the record" for what an each reads inside its records', () => {
    const d = describeAssertion(
      rowOf('Login', {
        kind: 'allOf',
        of: [cell('Open'), { kind: 'value', source: { from: 'text', pattern: 'bug' }, expect: { exists: true } }],
      }),
    );
    expect(d).toContain(
      'inside each: all of: the record contains at least 1 cell named "Open"; the record text matching /bug/',
    );
    expect(describeAssertion(cell('Open'))).toContain('the page contains');
  });

  test('pick inside an each, and a storage key named with and without its origin, are refused', () => {
    const ref: Reference = {
      name: 'r',
      kind: 'success',
      snapshot: {
        ...snap(),
        page: { url: 'https://shop.test/cart', title: 't' },
        storage: {
          cookies: [],
          local: { 'https://shop.test': { cart: '[{"sku":"A","qty":1}]' } },
          session: {},
        },
        baseline: {
          capturedAt: '',
          url: 'https://shop.test/cart',
          storage: {
            cookies: [],
            local: { 'https://shop.test': { cart: '[{"sku":"A","qty":1}]' } },
            session: {},
          },
          probes: { cart: { ok: true, value: [{ sku: 'A', qty: 1 }] } },
          redacted: [],
        },
      },
    };
    const pick = [{ op: 'json' as const }, { op: 'items' as const, pick: ['/sku'] }];
    const keyed = (origin?: string): Assertion => ({
      kind: 'value',
      source: { from: 'storage', area: 'local', key: 'cart' },
      normalize: pick,
      expect: {
        sameAs: {
          source: { from: 'storage', area: 'local', key: 'cart', at: 'before', ...(origin ? { origin } : {}) },
          normalize: pick,
        },
      },
    });
    // Named the same way: the validator's static rule; with the page's origin spelled out: the compiler's.
    expect(looseMatches(set(keyed()))).toHaveLength(1);
    expect(looseMatches(set(keyed('https://shop.test')))).toEqual([]);
    expect(pickOnSameShapes(set(keyed('https://shop.test')), [ref])).toEqual([
      expect.stringContaining('one collection before and after the task'),
    ]);
    // Inside an each: record text holding a JSON array, compared with a probe of the same shape.
    const s = ref.snapshot;
    s.a11y = parseAriaSnapshot('- main:\n  - list:\n    - listitem: \'[{"sku":"A","qty":1}]\'');
    const inRecord: Assertion = {
      kind: 'each',
      scope: { role: 'main' },
      match: { role: 'listitem' },
      assert: {
        kind: 'value',
        source: { from: 'text', pattern: '^(.*)$' },
        normalize: [{ op: 'json' }, { op: 'items', pick: ['/sku'] }],
        expect: {
          sameAs: {
            source: { from: 'probe', probe: 'cart', at: 'before' },
            normalize: [{ op: 'items', pick: ['/sku'] }],
          },
        },
      },
    };
    expect(evaluateAssertion({ snapshot: s, index: new AXIndex(s.a11y) }, inRecord).status).toBe('pass');
    expect(pickOnSameShapes(set(inRecord), [ref])).toEqual([
      expect.stringContaining('check C1.assert: items pick compares only some fields of two collections'),
    ]);
  });
});
