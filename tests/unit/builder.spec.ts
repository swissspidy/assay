/**
 * The check builder and its printer (ADR 0019): the builder produces exactly the
 * assay.checks/v1 JSON, and every committed check set prints as builder code that evaluates
 * back to a deep-equal set (and typechecks). No browser, no model.
 */
import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { globSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  allOf,
  anchors,
  anyOf,
  check,
  checks,
  contains,
  each,
  exact,
  includes,
  like,
  matching,
  network,
  node,
  norm,
  page,
  printCheckSet,
  probe,
  re,
  req,
  storage,
  text,
  url,
  value,
} from '../../src/checks/index.ts';
import { loadCheckSetFile } from '../../src/checks/load.ts';
import { describeAssertion, validateCheckSet, verify, type CheckSet } from '../../src/index.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const BUILDER = join(root, 'src/checks/index.ts');

/** Every committed check set (examples, the real-app dataset, test fixtures). */
const committed = globSync(
  ['examples/**/*.checks.json', 'eval/real/compiled/**/*.checks.json', 'tests/support/*.checks.json'],
  {
    cwd: root,
  },
)
  .filter((f) => !f.includes('.scratch'))
  .toSorted();

test('the builder writes the README example as plain assay.checks/v1 JSON', () => {
  const cs = checks('Add a blue mug to the cart', [
    req('R1', 'cart has a blue mug', { quote: 'blue mug' })
      .check(network.post('/api/cart').responseBody(like({ items: [{ color: 'blue' }] })))
      .check(node({ role: 'status' }).text().contains('Added')),
  ]);
  expect(cs).toStrictEqual({
    schema: 'assay.checks/v1',
    id: 'add-a-blue-mug-to-the-cart',
    version: '1',
    task: { instruction: 'Add a blue mug to the cart' },
    requirements: [
      { id: 'R1', kind: 'hard', text: 'cart has a blue mug', source: { field: 'instruction', quote: 'blue mug' } },
    ],
    checks: [
      {
        id: 'C1',
        requirement: 'R1',
        description: describeAssertion(cs.checks[0]!.assert),
        assert: {
          kind: 'request',
          match: {
            method: 'POST',
            url: { path: '/api/cart' },
            responseBody: {
              type: 'object',
              required: ['items'],
              properties: {
                items: {
                  type: 'array',
                  contains: { type: 'object', required: ['color'], properties: { color: { const: 'blue' } } },
                },
              },
            },
          },
        },
      },
      {
        id: 'C2',
        requirement: 'R1',
        description: describeAssertion(cs.checks[1]!.assert),
        assert: {
          kind: 'value',
          source: { from: 'node', target: { role: 'status' }, field: 'text' },
          expect: { contains: 'Added' },
        },
      },
    ],
  });
  expect(validateCheckSet(cs)).toMatchObject({ ok: true });
  // A plain object: no builder survives in the output.
  expect(JSON.parse(JSON.stringify(cs))).toStrictEqual(cs);
});

test('every assertion kind, source, normalizer and comparison', () => {
  const row = { role: 'row', name: { contains: 'Blue Mug' } } as const;
  const table = { role: 'table', name: 'Cart' };
  const a = {
    state: node('checkbox', 'Newsletter').checked().toJSON(),
    stateFalse: node('checkbox', 'Newsletter').checked(false).toJSON(),
    stateMany: node({ role: 'switch' }).state({ pressed: 'mixed', disabled: false }).toJSON(),
    hasName: node('heading')
      .hasName(exact('Cart', { ignoreCase: true }))
      .toJSON(),
    hasLevel: node('heading').hasLevel(2).toJSON(),
    anchored: node(anchors({ role: 'status' }, { role: 'region', name: 'Messages' }))
      .hasText(includes('Added'))
      .toJSON(),
    contains: contains(row, { scope: table, count: 1 }).toJSON(),
    scoped: node(table)
      .contains(row, { witness: { role: 'columnheader', name: 'Qty' }, count: { gte: 1 } })
      .toJSON(),
    each: node(table).each(row, node('cell').text().matches(/^\d+$/), { count: 2 }).toJSON(),
    url: url('/cart').toJSON(),
    urlQuery: url({ path: '/search', query: { q: 'mug', page: null } }).toJSON(),
    request: network.put('/api/settings', { status: 200 }).count(1).toJSON(),
    requestAny: network.request({ method: ['PUT', 'PATCH'], url: { regex: 'settings' } }).toJSON(),
    page: page({ title: re(/receipt/i) }, contains({ role: 'heading' })).toJSON(),
    eachTop: each({ role: 'listitem' }, contains({ role: 'heading' })).toJSON(),
    allOf: allOf(url('/cart'), contains(row)).toJSON(),
    anyOf: anyOf(url('/orders/:id'), contains({ role: 'heading', name: 'Order confirmed' })).toJSON(),
  };
  expect(a.state).toStrictEqual({
    kind: 'state',
    target: { role: 'checkbox', name: 'Newsletter' },
    expect: { checked: true },
  });
  expect(a.stateFalse.expect).toStrictEqual({ checked: false });
  expect(a.stateMany.expect).toStrictEqual({ pressed: 'mixed', disabled: false });
  expect(a.hasName.expect).toStrictEqual({ name: { equals: 'Cart', ignoreCase: true } });
  expect(a.hasLevel.expect).toStrictEqual({ level: 2 });
  expect(a.anchored.target).toStrictEqual({ anchors: [{ role: 'status' }, { role: 'region', name: 'Messages' }] });
  expect(a.contains).toStrictEqual({ kind: 'contains', scope: table, match: row, count: { eq: 1 } });
  expect(a.scoped).toStrictEqual({
    kind: 'contains',
    scope: table,
    witness: { role: 'columnheader', name: 'Qty' },
    match: row,
    count: { gte: 1 },
  });
  expect(a.each).toStrictEqual({
    kind: 'each',
    scope: table,
    match: row,
    count: { eq: 2 },
    assert: {
      kind: 'value',
      source: { from: 'node', target: { role: 'cell' }, field: 'text' },
      expect: { regex: '^\\d+$' },
    },
  });
  expect(a.url).toStrictEqual({ kind: 'url', match: { path: '/cart' } });
  expect(a.urlQuery.match.query).toStrictEqual({ q: 'mug', page: null });
  expect(a.request).toStrictEqual({
    kind: 'request',
    match: { method: 'PUT', url: { path: '/api/settings' }, status: 200 },
    count: { eq: 1 },
  });
  expect(a.requestAny.match).toStrictEqual({ method: ['PUT', 'PATCH'], url: { regex: 'settings' } });
  expect(a.page).toStrictEqual({
    kind: 'page',
    match: { title: { regex: 'receipt', flags: 'i' } },
    assert: { kind: 'contains', match: { role: 'heading' } },
  });
  expect(a.eachTop).toStrictEqual({
    kind: 'each',
    match: { role: 'listitem' },
    assert: { kind: 'contains', match: { role: 'heading' } },
  });
  expect(a.allOf.of).toHaveLength(2);
  expect(a.anyOf.kind).toBe('anyOf');

  // Sources.
  expect(text(/Order #(\d+)/, { scope: { role: 'main' }, group: 1 }).source).toStrictEqual({
    from: 'text',
    scope: { role: 'main' },
    pattern: 'Order #(\\d+)',
    group: 1,
  });
  expect(text('total', { flags: 'i' }).source).toStrictEqual({ from: 'text', pattern: 'total', flags: 'i' });
  expect(url.part('pathname').source).toStrictEqual({ from: 'url', part: 'pathname' });
  expect(url.param('q').source).toStrictEqual({ from: 'url', part: { param: 'q' } });
  expect(network.post('/api/cart').request('/qty').source).toStrictEqual({
    from: 'request',
    match: { method: 'POST', url: { path: '/api/cart' } },
    pointer: '/qty',
  });
  expect(network.get('/api/cart').response({ pick: 'last' }).source).toStrictEqual({
    from: 'response',
    match: { method: 'GET', url: { path: '/api/cart' } },
    pick: 'last',
  });
  expect(storage.local('theme', { origin: 'http://localhost:4173' }).source).toStrictEqual({
    from: 'storage',
    area: 'local',
    key: 'theme',
    origin: 'http://localhost:4173',
  });
  expect(storage.cookie('consent', { at: 'before' }).source).toMatchObject({ area: 'cookie', at: 'before' });
  expect(probe('cart', { pointer: '/total', at: 'before' }).source).toStrictEqual({
    from: 'probe',
    probe: 'cart',
    pointer: '/total',
    at: 'before',
  });
  expect(value({ from: 'probe', probe: 'x' }).source).toStrictEqual({ from: 'probe', probe: 'x' });

  // Normalizers.
  expect([
    norm.number('en-US'),
    norm.currency('de-DE', 'EUR'),
    norm.date('en-US'),
    norm.datetime('en-US', 'Europe/Berlin'),
    norm.extract(/(\d+) items/i, { group: 1 }),
    norm.replace(/,/g, ''),
    norm.items({ where: like({ open: true }), pointer: '/title' }),
  ]).toStrictEqual([
    { op: 'number', locale: 'en-US' },
    { op: 'currency', locale: 'de-DE', currency: 'EUR' },
    { op: 'date', locale: 'en-US' },
    { op: 'datetime', locale: 'en-US', timezone: 'Europe/Berlin' },
    { op: 'extract', regex: '(\\d+) items', flags: 'i', group: 1 },
    { op: 'replace', regex: ',', flags: 'g', with: '' },
    {
      op: 'items',
      where: { type: 'object', required: ['open'], properties: { open: { const: true } } },
      pointer: '/title',
    },
  ]);

  // Comparisons.
  const total = probe('cart', '/total');
  const price = text(/Total: (.+)/, { group: 1 }).normalize('trim', norm.currency('en-US'));
  const expects = [
    total.equals(21.5),
    total.oneOf([1, 2]),
    total.approx(21.5, { abs: 0.01 }),
    total.gt(0),
    total.range({ gte: 1, lt: 100 }),
    total.schema({ type: 'number' }),
    total.exists(),
    price.sameAs(total, { tolerance: { abs: 0.01, because: 'rounding' } }),
    value({ from: 'url', part: 'search' }).contains('q=mug', { ignoreCase: true }),
    value({ from: 'url', part: 'hash' }).matches('^#top$'),
  ].map((b) => b.toJSON().expect);
  expect(expects).toStrictEqual([
    { equals: 21.5 },
    { oneOf: [1, 2] },
    { approx: { value: 21.5, abs: 0.01 } },
    { gt: 0 },
    { gte: 1, lt: 100 },
    { schema: { type: 'number' } },
    { exists: true },
    {
      sameAs: {
        source: { from: 'probe', probe: 'cart', pointer: '/total' },
        tolerance: { abs: 0.01, because: 'rounding' },
      },
    },
    { contains: 'q=mug', ignoreCase: true },
    { regex: '^#top$' },
  ]);
  expect(price.equals(1).toJSON().normalize).toStrictEqual(['trim', { op: 'currency', locale: 'en-US' }]);
});

test("explicit regex flags win over a RegExp literal's own", () => {
  expect(text(/added/, { flags: 'i' }).source).toStrictEqual({ from: 'text', pattern: 'added', flags: 'i' });
  expect(text(/added/i).source).toStrictEqual({ from: 'text', pattern: 'added', flags: 'i' });
  expect(probe('p').matches(/a/i, '').toJSON().expect).toStrictEqual({ regex: 'a', flags: '' });
  expect(norm.extract(/(\d+)/, { flags: 'i' })).toStrictEqual({ op: 'extract', regex: '(\\d+)', flags: 'i' });
  expect(norm.replace(/,/g, '', 'gi')).toStrictEqual({ op: 'replace', regex: ',', flags: 'gi', with: '' });
  expect(re(/x/m, 'i')).toStrictEqual({ regex: 'x', flags: 'i' });
});

test('like: objects need their keys, arrays contain an item like each element, the rest is equal', () => {
  expect(like('x')).toStrictEqual({ const: 'x' });
  expect(like(null)).toStrictEqual({ const: null });
  expect(like([])).toStrictEqual({ type: 'array' });
  expect(like({})).toStrictEqual({ type: 'object' });
  expect(like([{ a: 1 }, 2])).toStrictEqual({
    type: 'array',
    allOf: [
      { contains: { type: 'object', required: ['a'], properties: { a: { const: 1 } } } },
      { contains: { const: 2 } },
    ],
  });
  expect(like({ id: matching({ type: 'string' }) })).toStrictEqual({
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string' } },
  });
});

test('defaults: ids, versions, quote fields, check ids and descriptions; standalone checks keep their order', () => {
  const cs = checks({ instruction: 'Check out my cart as a gift.', outcomes: 'Then the order is gift wrapped' }, [
    req('R1', 'The order is gift wrapped', { quote: 'the order is gift wrapped' }),
    req('R2', 'An order is placed', { quote: 'Check out my cart' }).check(network.post('/api/orders'), {
      onMissing: 'abstain',
    }),
    check('R1', 'Stored with giftWrap true.', probe('latestOrder', '/giftWrap').equals(true), { id: 'wrapped' }),
    check('R2', probe('latestOrder', '/status').equals('placed'), { onFail: 'keep' }),
  ]);
  expect(cs.id).toBe('check-out-my-cart-as-a-gift');
  expect(cs.version).toBe('1');
  expect(cs.requirements.map((r) => [r.id, r.source.field])).toEqual([
    ['R1', 'outcomes'],
    ['R2', 'instruction'],
  ]);
  expect(cs.checks.map((c) => [c.id, c.requirement])).toEqual([
    ['C1', 'R2'],
    ['wrapped', 'R1'],
    ['C3', 'R2'],
  ]);
  expect(cs.checks[0]).toMatchObject({ onMissing: 'abstain', description: describeAssertion(cs.checks[0]!.assert) });
  expect(cs.checks[2]).toMatchObject({ onFail: 'keep' });
  expect(validateCheckSet(cs).ok).toBe(true);
  // A requirement without a quote quotes its own text; one not in the task is reported by validation.
  const loose = checks('Subscribe me to the newsletter.', [
    req('R1', 'Subscribe me').check(storage.local('subscribed').equals('1')),
    req('R2', 'Something else').check(url('/done')),
  ]);
  expect(loose.requirements[0]!.source).toEqual({ field: 'instruction', quote: 'Subscribe me' });
  expect(validateCheckSet(loose).errors).toEqual([
    'requirement R2: quote "Something else" does not appear in task.instruction',
  ]);
});

test('builder sets verify like the JSON they stand for', async () => {
  const json = JSON.parse(readFileSync(join(root, 'examples/tiny-shop/tasks/02-add-blue-mug.checks.json'), 'utf8'));
  const built = (await loadCheckSetFile(join(root, 'tests/support/add-blue-mug.checks.ts'))) as CheckSet;
  expect(validateCheckSet(built)).toMatchObject({ ok: true, warnings: [] });
  for (const run of ['added-blue-mug', 'added-red-mug', 'added-blue-and-red-mug']) {
    const snap = JSON.parse(
      readFileSync(join(root, `examples/tiny-shop/references/02-add-blue-mug/${run}.json`), 'utf8'),
    ).snapshot;
    const [a, b] = await Promise.all([verify(json, snap), verify(built, snap)]);
    expect(b.outcome.verdict, run).toBe(a.outcome.verdict);
  }
});

test.describe('printing builder code', () => {
  test.describe.configure({ timeout: 120_000 });

  test(`every committed check set (${committed.length}) prints as builder code that evaluates back to it`, async () => {
    expect(committed.length).toBeGreaterThan(100);
    const dir = mkdtempSync(join(tmpdir(), 'assay-print-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    const files: string[] = [];
    let plainObjects = 0;
    for (const [i, f] of committed.entries()) {
      const cs = JSON.parse(readFileSync(join(root, f), 'utf8')) as CheckSet;
      const ts = printCheckSet(cs, { importFrom: BUILDER });
      // Builder code throughout: no assertion falls back to a plain object.
      if (/kind: '(state|contains|value|url|request|each|page|allOf|anyOf)'/.test(ts)) plainObjects++;
      const file = join(dir, `set${i}.checks.ts`);
      writeFileSync(file, ts);
      files.push(file);
      const back = await loadCheckSetFile(file);
      expect(back, f).toStrictEqual(cs);
      expect(validateCheckSet(back).ok, f).toBe(true);
    }
    expect(plainObjects).toBe(0);

    // And the printed modules typecheck against the builder's types.
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2024',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2024', 'DOM'],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
          noUncheckedIndexedAccess: true,
          verbatimModuleSyntax: true,
          erasableSyntaxOnly: true,
          types: ['node'],
          typeRoots: [join(root, 'node_modules/@types')],
        },
        include: ['*.ts'],
      }),
    );
    const { stdout } = await promisify(execFile)(join(root, 'node_modules/.bin/tsrs'), [
      '-p',
      join(dir, 'tsconfig.json'),
    ]).catch((e: { stdout: string; stderr: string }) => {
      // A failing typecheck fails the test, with tsrs's output.
      throw new Error(`tsrs failed:\n${e.stdout}${e.stderr}`);
    });
    expect(stdout).toBe('');
  });

  test('strings, regexes and fallbacks print as code that reads back exactly', async () => {
    const cs = checks(
      { id: 'edge', version: '2', instruction: 'It\'s "quoted"\nand separated \\ here', outcomes: 'Then ok' },
      [
        req('R1', 'quoted', { quote: "It's" })
          .check('slash', text('a/b').exists())
          .check(value({ from: 'text', pattern: 'x', flags: '' }).exists())
          .check(
            text(/[/]x\d/su, { group: 'n' })
              .normalize({ op: 'trim' }, norm.replace('a', 'b', 'gi'))
              .exists(),
          )
          .check(probe('p').compare({ gt: 1, lte: 5 }))
          .check(
            probe('p')
              .normalize()
              .equals({ a: [1, { b: null }] }),
          )
          .check(probe('p').schema({ type: 'array', items: { const: 1 } })),
        req('R2', 'soft', { kind: 'soft', quote: 'ok', field: 'outcomes' }).check(
          { kind: 'url', match: { regex: '^https://' } },
          { onFail: 'escalate' },
        ),
      ],
    );
    expect(validateCheckSet(cs).errors).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), 'assay-print-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    const file = join(dir, 'edge.checks.ts');
    writeFileSync(file, printCheckSet(cs, { importFrom: BUILDER }));
    expect(await loadCheckSetFile(file)).toStrictEqual(cs);
    expect(readFileSync(file, 'utf8')).toContain("text(/[/]x\\d/su, { group: 'n' })");
  });
});
