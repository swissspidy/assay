/** The compiler learns about frames, other pages and form bodies only from references that have them (ADR 0012). */
import { expect, test } from '@playwright/test';
import type { EvidenceSnapshot } from '../../src/index.ts';
import { checkSetSchema } from '../../src/dsl/schema.ts';
import { assertToolSchema, checksToolSchema, discoverySystem, dslDefinitions } from '../../src/compiler/compile.ts';
import { outline, summary } from '../../src/compiler/explore.ts';
import {
  DISCOVERY_ABSENCE,
  DISCOVERY_FORMS,
  DISCOVERY_FRAMES,
  DISCOVERY_PAGES,
  DISCOVERY_SYSTEM,
} from '../../src/compiler/prompts.ts';

const plain: EvidenceSnapshot = {
  schema: 'assay.snapshot/v1',
  capturedAt: '2026-11-05T00:00:00Z',
  page: { url: 'https://shop.test/cart', title: 'Cart' },
  a11y: { role: 'document', children: [{ role: 'main', children: [{ role: 'iframe' }] }] },
  text: 'Cart',
  network: [],
  storage: null,
  probes: {},
  meta: { capturer: 'test', redacted: [] },
};

const refs = (...snapshots: EvidenceSnapshot[]) =>
  snapshots.map((snapshot, i) => ({ name: `r${i}`, kind: 'success' as const, snapshot }));
const BASE = `${DISCOVERY_SYSTEM}\n\n${DISCOVERY_ABSENCE}`;

const kinds = (defs: ReturnType<typeof dslDefinitions>) =>
  defs.assertion.oneOf.map((a) => ('const' in a.properties.kind ? a.properties.kind.const : a.properties.kind.enum));

test('references of one page without frames or form bodies get the prompt and tools as before', () => {
  // An empty iframe node (a snapshot captured before frames were) is not frame content.
  // No baseline: the absence section (ADR 0011) follows, and nothing else.
  expect(discoverySystem(refs(plain))).toBe(BASE);
  expect(kinds(dslDefinitions(false))).not.toContain('page');
  expect('pageMatch' in dslDefinitions(false)).toBe(false);
  // The full DSL once a sameAs tolerance is offered too (ADR 0014) and a reference has a
  // trajectory (ADR 0024); until then, without them.
  expect(dslDefinitions(true, true, true)).toBe(checkSetSchema.definitions);
  expect(kinds(dslDefinitions(true, true))).not.toContain('sequence');
  expect('sequenceStep' in dslDefinitions(true, true)).toBe(false);
  expect('tolerance' in dslDefinitions(true)).toBe(false);
  expect(JSON.stringify(dslDefinitions(true))).not.toContain('"tolerance"');
  expect(summary(plain)).not.toContain('other open pages');
});

test('frames, other pages and form bodies each add their section', () => {
  const framed: EvidenceSnapshot = {
    ...plain,
    a11y: { role: 'document', children: [{ role: 'iframe', name: 'Editor', children: [{ role: 'textbox' }] }] },
  };
  const paged: EvidenceSnapshot = {
    ...plain,
    pages: [{ url: 'https://shop.test/receipt', title: 'Receipt', a11y: { role: 'document' }, text: '' }],
  };
  const form: EvidenceSnapshot = {
    ...plain,
    network: [
      {
        seq: 0,
        method: 'POST',
        url: 'https://shop.test/x',
        resourceType: 'document',
        status: 200,
        requestHeaders: {},
        requestBody: { a: '1' },
        requestBodyRaw: 'a=1',
        responseHeaders: {},
      },
    ],
  };
  expect(discoverySystem(refs(framed))).toBe(`${BASE}\n\n${DISCOVERY_FRAMES}`);
  expect(discoverySystem(refs(plain, paged))).toBe(`${BASE}\n\n${DISCOVERY_PAGES}`);
  expect(discoverySystem(refs(form))).toBe(`${BASE}\n\n${DISCOVERY_FORMS}`);
  expect(kinds(dslDefinitions(true))).toContain('page');
  expect(summary(paged)).toContain(
    'other open pages (read with a page assertion): https://shop.test/receipt "Receipt"',
  );
  expect(outline(paged)).toContain('=== other open page 1: https://shop.test/receipt — title "Receipt"');
});

test('both tool schemas the compiler emits offer the page assertion only with pages; try_assertion keeps onMissing', () => {
  for (const schema of [checksToolSchema, assertToolSchema]) {
    const without = JSON.stringify(schema(false));
    expect(without).not.toContain('"pageMatch"');
    expect(without).not.toContain('"const":"page"');
    expect(JSON.stringify(schema(false).definitions)).toBe(JSON.stringify(dslDefinitions(false)));
    const withPages = JSON.stringify(schema(true));
    expect(withPages).toContain('"pageMatch"');
    expect(withPages).toContain('"const":"page"');
  }
  expect(checksToolSchema(false).properties).toEqual({
    checks: { type: 'array', minItems: 1, items: { $ref: '#/definitions/check' } },
  });
  expect(assertToolSchema(true).properties).toMatchObject({ onMissing: { enum: ['fail', 'abstain'] } });
});

test('the outline says when other pages were cut, and that find_nodes cannot search them', () => {
  const tree = (n: number): EvidenceSnapshot['a11y'] => ({
    role: 'document',
    children: Array.from({ length: n }, (_, i) => ({ role: 'paragraph', name: `p${i}` })),
  });
  const page = (url: string, n: number) => ({ url, title: '', a11y: tree(n), text: '' });
  // The active tree fills the limit exactly: the other pages are reported, not silently left out.
  const full: EvidenceSnapshot = { ...plain, a11y: tree(5), pages: [page('https://shop.test/a', 1)] };
  expect(outline(full, 5).split('\n').at(-1)).toBe(
    '… (other open pages truncated at 5 lines: 1 not shown; find_nodes searches only the active page)',
  );
  const cut: EvidenceSnapshot = { ...plain, a11y: tree(1), pages: [page('https://shop.test/a', 9)] };
  expect(outline(cut, 5)).toContain('0 not shown, the last one shown is cut; find_nodes searches only the active page');
  // One page, cut: as before.
  expect(
    outline({ ...plain, a11y: tree(9) }, 5)
      .split('\n')
      .at(-1),
  ).toBe('… (truncated at 5 lines; use find_nodes to search)');
});
