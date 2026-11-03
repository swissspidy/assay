import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import {
  parseAriaSnapshot,
  evaluate,
  evaluateAssertion,
  kleeneAnd,
  kleeneOr,
  validateCheckSet,
  snapshotDigest,
  type Assertion,
  type CheckSet,
  type EvidenceSnapshot,
} from '../../src/index.ts';
import { AXIndex, resolveTarget } from '../../src/runtime/axindex.ts';

const YAML = `
- banner:
  - navigation "Primary":
    - link "Cart (2)":
      - /url: /cart
- main:
  - form "Checkout":
    - textbox "Qty": "2"
    - checkbox "Gift wrap" [checked]
    - checkbox "Insurance"
    - checkbox "Terms" [checked=mixed]
    - button "Pay" [disabled]
    - heading "Shipping" [level=2]
  - table "Cart":
    - row "Widget \\"x\\" $3.00":
      - cell "Widget \\"x\\""
      - cell "$3.00"
    - row "Gadget $4.00":
      - cell "Gadget"
      - cell "$4.00"
  - paragraph:
    - text: "Total:"
    - strong: $7.00
  - status: "Order placed: #123"
`;

function snap(partial: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot {
  return {
    schema: 'assay.snapshot/v1',
    capturedAt: '2026-11-02T00:00:00.000Z',
    page: { url: 'https://shop.test/orders/A1?ref=x', title: 't' },
    a11y: parseAriaSnapshot(YAML),
    text: 'Total: $7.00\nOrder placed: #123',
    network: [],
    storage: { cookies: [], local: {}, session: {} },
    probes: {},
    meta: { capturer: 'test', redacted: [] },
    ...partial,
  };
}

const run = (a: Assertion, s = snap()) => evaluateAssertion({ snapshot: s, index: new AXIndex(s.a11y) }, a);

test('aria snapshot parsing', () => {
  const tree = parseAriaSnapshot(YAML);
  const idx = new AXIndex(tree);
  const find = (role: string, name?: string) =>
    idx.all.find((n) => n.node.role === role && (name === undefined || n.node.name === name))!.node;
  expect(find('link').url).toBe('/cart');
  expect(find('textbox').value).toBe('2');
  expect(find('checkbox', 'Gift wrap').states).toEqual({ checked: true });
  expect(find('checkbox', 'Insurance').states).toBeUndefined();
  expect(find('checkbox', 'Terms').states).toEqual({ checked: 'mixed' });
  expect(find('button').states).toEqual({ disabled: true });
  expect(find('heading').level).toBe(2);
  expect(find('row', 'Widget "x" $3.00')).toBeTruthy();
  const para = idx.all.find((n) => n.node.role === 'paragraph')!;
  expect(idx.text(para)).toBe('Total: $7.00');
  expect(idx.text(idx.all.find((n) => n.node.role === 'status')!)).toBe('Order placed: #123');
});

test.describe('target resolution', () => {
  const idx = new AXIndex(parseAriaSnapshot(YAML));
  test('unique', () => {
    const r = resolveTarget(idx, { role: 'checkbox', name: 'Gift wrap' });
    expect(r.ok).toBe(true);
  });
  test('missing → anchor_missing', () => {
    const r = resolveTarget(idx, { role: 'checkbox', name: 'Nope' });
    expect(r).toMatchObject({ ok: false, reason: 'anchor_missing' });
  });
  test('ambiguous → anchor_ambiguous (never first match)', () => {
    const r = resolveTarget(idx, { role: 'row' });
    expect(r).toMatchObject({ ok: false, reason: 'anchor_ambiguous' });
  });
  test('redundant anchors: agreement with drift', () => {
    const r = resolveTarget(idx, {
      anchors: [
        { role: 'checkbox', name: 'Gift wrapping' },
        { role: 'checkbox', name: 'Gift wrap', landmark: { role: 'form', name: 'Checkout' } },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.drift).toEqual(['checkbox named "Gift wrapping"']);
  });
  test('redundant anchors: an ambiguous anchor that includes the chosen node is consistent', () => {
    const r = resolveTarget(idx, {
      anchors: [
        { role: 'checkbox', name: 'Gift wrap' },
        { role: 'checkbox', landmark: { role: 'main' } },
      ],
    });
    expect(r.ok).toBe(true);
  });
  test('redundant anchors: disagreement → anchor_conflict', () => {
    const r = resolveTarget(idx, {
      anchors: [
        { role: 'checkbox', name: 'Gift wrap' },
        { role: 'checkbox', name: 'Insurance' },
      ],
    });
    expect(r).toMatchObject({ ok: false, reason: 'anchor_conflict' });
  });
  test('within', () => {
    const r = resolveTarget(idx, {
      role: 'cell',
      name: { contains: '$' },
      within: { role: 'row', name: { contains: 'Gadget' } },
    });
    expect(r.ok && r.node.node.name).toBe('$4.00');
  });
});

test.describe('assertions', () => {
  test('state: pass, fail, abstain', () => {
    expect(
      run({ kind: 'state', target: { role: 'checkbox', name: 'Gift wrap' }, expect: { checked: true } }).status,
    ).toBe('pass');
    expect(
      run({ kind: 'state', target: { role: 'checkbox', name: 'Insurance' }, expect: { checked: true } }).status,
    ).toBe('fail');
    expect(run({ kind: 'state', target: { role: 'checkbox', name: 'Terms' }, expect: { checked: true } }).status).toBe(
      'fail',
    );
    expect(run({ kind: 'state', target: { role: 'checkbox', name: 'Gone' }, expect: { checked: true } })).toMatchObject(
      { status: 'abstain', reason: 'anchor_missing' },
    );
  });
  test('contains: missing content fails, missing scope abstains', () => {
    const scope = { role: 'table', name: 'Cart' };
    expect(run({ kind: 'contains', scope, match: { role: 'row', name: { contains: 'Gadget' } } }).status).toBe('pass');
    expect(run({ kind: 'contains', scope, match: { role: 'row', name: { contains: 'Doohickey' } } }).status).toBe(
      'fail',
    );
    expect(run({ kind: 'contains', scope, match: { role: 'row' }, count: { eq: 2 } }).status).toBe('pass');
    expect(
      run({ kind: 'contains', scope, match: { role: 'row', name: { contains: 'Gadget' } }, count: { eq: 0 } }).status,
    ).toBe('fail');
    expect(run({ kind: 'contains', scope: { role: 'table', name: 'Basket' }, match: { role: 'row' } })).toMatchObject({
      status: 'abstain',
      reason: 'anchor_missing',
    });
  });
  test('value: currency with tolerance', () => {
    const a: Assertion = {
      kind: 'value',
      source: { from: 'node', target: { role: 'strong' }, field: 'text' },
      normalize: [{ op: 'currency', locale: 'en-US', currency: 'USD' }],
      expect: { approx: { value: { amount: 7, currency: 'USD' }, abs: 0.005 } },
    };
    expect(run(a).status).toBe('pass');
    expect(run({ ...a, expect: { approx: { value: { amount: 7.01, currency: 'USD' }, abs: 0.005 } } }).status).toBe(
      'fail',
    );
    expect(run({ ...a, expect: { approx: { value: { amount: 7, currency: 'EUR' }, abs: 0.005 } } }).status).toBe(
      'fail',
    );
  });
  test('value: unparseable → abstain normalize_failed; type mismatch → abstain', () => {
    expect(
      run({
        kind: 'value',
        source: { from: 'node', target: { role: 'status' }, field: 'text' },
        normalize: [{ op: 'number', locale: 'en-US' }],
        expect: { equals: 1 },
      }),
    ).toMatchObject({
      status: 'abstain',
      reason: 'normalize_failed',
    });
    expect(
      run({ kind: 'value', source: { from: 'node', target: { role: 'status' }, field: 'text' }, expect: { gt: 3 } }),
    ).toMatchObject({ status: 'abstain', reason: 'type_mismatch' });
  });
  test('value: free text with a regex', () => {
    expect(
      run({ kind: 'value', source: { from: 'text', pattern: 'Order placed: #(\\d+)' }, expect: { equals: '123' } }),
    ).toMatchObject({ status: 'pass', evidence: [{ trust: 'freetext' }] });
    expect(
      run({ kind: 'value', source: { from: 'text', pattern: 'Refund #(\\d+)' }, expect: { equals: '123' } }),
    ).toMatchObject({ status: 'abstain', reason: 'value_unavailable' });
  });
  test('url', () => {
    expect(run({ kind: 'url', match: { path: '/orders/:id', query: { ref: 'x' } } }).status).toBe('pass');
    expect(run({ kind: 'url', match: { path: '/orders/:id', query: { ref: null } } }).status).toBe('fail');
    expect(run({ kind: 'url', match: { path: '/orders/**' } }).status).toBe('pass');
    expect(run({ kind: 'url', match: { path: '/cart' } }).status).toBe('fail');
    expect(
      run({ kind: 'value', source: { from: 'url', part: { param: 'ref' } }, expect: { equals: 'x' } }).status,
    ).toBe('pass');
  });
  test('request and response values; network channel missing → abstain', () => {
    const s = snap({
      network: [
        {
          seq: 0,
          method: 'POST',
          url: 'https://shop.test/api/orders',
          resourceType: 'fetch',
          status: 201,
          requestHeaders: {},
          requestBody: { shipping: 'express' },
          responseHeaders: {},
          responseBody: { id: 'A1', status: 'placed' },
        },
        {
          seq: 1,
          method: 'POST',
          url: 'https://shop.test/api/orders',
          resourceType: 'fetch',
          status: 201,
          requestHeaders: {},
          requestBody: { shipping: 'standard' },
          responseHeaders: {},
          responseBody: { id: 'A2', status: 'placed' },
        },
      ],
    });
    const match = { method: 'POST', url: { path: '/api/orders' }, status: 201 };
    expect(run({ kind: 'request', match }, s).status).toBe('pass');
    expect(run({ kind: 'request', match, count: { eq: 1 } }, s).status).toBe('fail');
    expect(
      run({ kind: 'request', match: { ...match, responseBody: { properties: { status: { const: 'cancelled' } } } } }, s)
        .status,
    ).toBe('fail');
    expect(
      run(
        { kind: 'value', source: { from: 'request', match, pointer: '/shipping' }, expect: { equals: 'express' } },
        s,
      ),
    ).toMatchObject({ status: 'abstain', reason: 'value_ambiguous' });
    expect(
      run(
        {
          kind: 'value',
          source: { from: 'request', match, pointer: '/shipping', pick: 'last' },
          expect: { equals: 'express' },
        },
        s,
      ).status,
    ).toBe('fail');
    expect(
      run(
        {
          kind: 'value',
          source: { from: 'request', match, pointer: '/shipping', pick: 'first' },
          expect: { equals: 'express' },
        },
        s,
      ).status,
    ).toBe('pass');
    expect(
      run(
        {
          kind: 'value',
          source: { from: 'request', match, pointer: '/nope', pick: 'first' },
          expect: { equals: 'express' },
        },
        s,
      ),
    ).toMatchObject({ status: 'abstain', reason: 'value_unavailable' });
    expect(run({ kind: 'request', match }, snap({ network: null }))).toMatchObject({
      status: 'abstain',
      reason: 'evidence_unavailable',
    });
  });
  test('storage: redacted cookie → abstain', () => {
    const s = snap({
      storage: {
        cookies: [
          { name: 'lang', value: 'de', domain: 'shop.test', path: '/', httpOnly: false, secure: false },
          { name: 'sid', value: { redacted: true }, domain: 'shop.test', path: '/', httpOnly: true, secure: false },
        ],
        local: { 'https://shop.test': { theme: 'dark' } },
        session: {},
      },
    });
    expect(
      run({ kind: 'value', source: { from: 'storage', area: 'cookie', key: 'lang' }, expect: { equals: 'de' } }, s)
        .status,
    ).toBe('pass');
    expect(
      run({ kind: 'value', source: { from: 'storage', area: 'local', key: 'theme' }, expect: { equals: 'dark' } }, s)
        .status,
    ).toBe('pass');
    expect(
      run({ kind: 'value', source: { from: 'storage', area: 'cookie', key: 'sid' }, expect: { exists: true } }, s),
    ).toMatchObject({ status: 'abstain', reason: 'evidence_unavailable' });
  });
  test('probes', () => {
    const s = snap({
      probes: {
        order: { ok: true, value: { status: 'placed', total: 7 } },
        broken: { ok: false, error: 'ECONNREFUSED' },
      },
    });
    expect(
      run(
        {
          kind: 'value',
          source: { from: 'probe', probe: 'order', pointer: '/total' },
          expect: { approx: { value: 7, abs: 0.01 } },
        },
        s,
      ).status,
    ).toBe('pass');
    expect(
      run({ kind: 'value', source: { from: 'probe', probe: 'broken' }, expect: { exists: true } }, s),
    ).toMatchObject({ status: 'abstain', reason: 'probe_error' });
    expect(
      run({ kind: 'value', source: { from: 'probe', probe: 'missing' }, expect: { exists: true } }, s),
    ).toMatchObject({ status: 'abstain', reason: 'evidence_unavailable' });
  });
});

test('Kleene logic', () => {
  expect(kleeneAnd(['pass', 'pass'])).toBe('pass');
  expect(kleeneAnd(['pass', 'abstain'])).toBe('abstain');
  expect(kleeneAnd(['abstain', 'fail'])).toBe('fail');
  expect(kleeneOr(['fail', 'abstain'])).toBe('abstain');
  expect(kleeneOr(['abstain', 'pass'])).toBe('pass');
  expect(kleeneOr(['fail', 'fail'])).toBe('fail');
});

test('verdict aggregation: soft requirements do not decide; uncovered abstains', () => {
  const cs: CheckSet = {
    schema: 'assay.checks/v1',
    id: 't',
    version: '1',
    task: { instruction: 'Enable gift wrap and insurance. Optionally accept terms.' },
    requirements: [
      { id: 'R1', kind: 'hard', text: 'gift wrap', source: { field: 'instruction', quote: 'enable gift wrap' } },
      { id: 'R2', kind: 'soft', text: 'insurance', source: { field: 'instruction', quote: 'insurance' } },
    ],
    checks: [
      {
        id: 'C1',
        requirement: 'R1',
        description: 'gift wrap checked',
        assert: { kind: 'state', target: { role: 'checkbox', name: 'Gift wrap' }, expect: { checked: true } },
      },
      {
        id: 'C2',
        requirement: 'R2',
        description: 'insurance checked',
        assert: { kind: 'state', target: { role: 'checkbox', name: 'Insurance' }, expect: { checked: true } },
      },
    ],
  };
  const o = evaluate(cs, snap());
  expect(o.verdict).toBe('success');
  expect(o.requirements.map((r) => r.status)).toEqual(['pass', 'fail']);
  const uncovered = evaluate(
    {
      ...cs,
      requirements: [
        ...cs.requirements,
        { id: 'R3', kind: 'hard', text: 'terms', source: { field: 'instruction', quote: 'accept terms' } },
      ],
    },
    snap(),
  );
  expect(uncovered.verdict).toBe('abstain');
  expect(uncovered.requirements[2]).toMatchObject({ status: 'abstain', reason: 'uncovered' });
});

test('snapshot digest ignores capture time and key order', () => {
  const a = snap();
  const b = { ...snap(), capturedAt: '2030-01-01T00:00:00Z' };
  expect(snapshotDigest(a)).toBe(snapshotDigest(b));
  expect(snapshotDigest(a)).not.toBe(snapshotDigest(snap({ text: 'different' })));
});

test.describe('check set validation', () => {
  const dir = new URL('../../examples/tiny-shop/tasks/', import.meta.url);
  for (const f of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
    test(`example ${f} is valid`, () => {
      const r = validateCheckSet(JSON.parse(readFileSync(new URL(f, dir), 'utf8')));
      expect(r.errors).toEqual([]);
    });
  }
  const base = (): CheckSet => ({
    schema: 'assay.checks/v1',
    id: 'x',
    version: '1',
    task: { instruction: 'Set the quantity to 3.' },
    requirements: [{ id: 'R1', kind: 'hard', text: 'qty 3', source: { field: 'instruction', quote: 'quantity to 3' } }],
    checks: [
      {
        id: 'C1',
        requirement: 'R1',
        description: 'qty',
        assert: {
          kind: 'value',
          source: { from: 'node', target: { role: 'spinbutton' }, field: 'value' },
          normalize: [{ op: 'number', locale: 'en-US' }],
          expect: { equals: 3 },
        },
      },
    ],
  });
  test('rejects untraceable requirements', () => {
    const cs = base();
    cs.requirements[0]!.source.quote = 'quantity to 3 and colour to red';
    expect(validateCheckSet(cs).errors.join()).toContain('does not appear');
  });
  test('rejects unknown requirement refs and duplicate ids', () => {
    const cs = base();
    cs.checks.push({ ...cs.checks[0]!, requirement: 'R9' });
    const errs = validateCheckSet(cs).errors.join('\n');
    expect(errs).toContain('duplicate check id C1');
    expect(errs).toContain('unknown requirement R9');
  });
  test('rejects code-like and malformed checks', () => {
    const cs = base() as unknown as { checks: { assert: unknown }[] };
    cs.checks[0]!.assert = { kind: 'script', code: 'return true' };
    expect(validateCheckSet(cs).ok).toBe(false);
  });
  test('rejects type errors in the normalizer pipeline', () => {
    const cs = base();
    (cs.checks[0]!.assert as { expect: unknown }).expect = { equals: '3' };
    expect(validateCheckSet(cs).errors.join()).toContain('cannot match a number');
    const cs2 = base();
    (cs2.checks[0]!.assert as { normalize: unknown }).normalize = undefined;
    (cs2.checks[0]!.assert as { expect: unknown }).expect = { gte: 3 };
    expect(validateCheckSet(cs2).errors.join()).toContain('add a number, currency or date normalizer');
  });
  test('rejects invalid regex and JSON schema', () => {
    const cs = base();
    cs.checks[0]!.assert = { kind: 'value', source: { from: 'text', pattern: '(' }, expect: { exists: true } };
    expect(validateCheckSet(cs).errors.join()).toContain('invalid regex');
    cs.checks[0]!.assert = { kind: 'request', match: { responseBody: { type: 'banana' } } };
    expect(validateCheckSet(cs).errors.join()).toContain('invalid JSON Schema');
  });
  test('warns about low-trust and unscoped checks', () => {
    const cs = base();
    cs.checks[0]!.assert = { kind: 'contains', match: { role: 'status' } };
    expect(validateCheckSet(cs).warnings.join()).toContain('without a scope');
  });
});
