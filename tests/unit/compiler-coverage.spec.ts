/** The compiler learns about frames, other pages and form bodies only from references that have them (ADR 0012). */
import { expect, test } from '@playwright/test';
import type { EvidenceSnapshot } from '../../src/index.ts';
import { checkSetSchema } from '../../src/dsl/schema.ts';
import { discoverySystem, dslDefinitions } from '../../src/compiler/compile.ts';
import { outline, summary } from '../../src/compiler/explore.ts';
import { DISCOVERY_FORMS, DISCOVERY_FRAMES, DISCOVERY_PAGES, DISCOVERY_SYSTEM } from '../../src/compiler/prompts.ts';

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

const kinds = (defs: ReturnType<typeof dslDefinitions>) =>
  defs.assertion.oneOf.map((a) => ('const' in a.properties.kind ? a.properties.kind.const : a.properties.kind.enum));

test('references of one page without frames or form bodies get the prompt and tools as before', () => {
  // An empty iframe node (a snapshot captured before frames were) is not frame content.
  expect(discoverySystem([plain])).toBe(DISCOVERY_SYSTEM);
  expect(kinds(dslDefinitions(false))).not.toContain('page');
  expect('pageMatch' in dslDefinitions(false)).toBe(false);
  expect(dslDefinitions(true)).toBe(checkSetSchema.definitions);
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
  expect(discoverySystem([framed])).toBe(`${DISCOVERY_SYSTEM}\n\n${DISCOVERY_FRAMES}`);
  expect(discoverySystem([plain, paged])).toBe(`${DISCOVERY_SYSTEM}\n\n${DISCOVERY_PAGES}`);
  expect(discoverySystem([form])).toBe(`${DISCOVERY_SYSTEM}\n\n${DISCOVERY_FORMS}`);
  expect(kinds(dslDefinitions(true))).toContain('page');
  expect(summary(paged)).toContain(
    'other open pages (read with a page assertion): https://shop.test/receipt "Receipt"',
  );
  expect(outline(paged)).toContain('=== other open page 1: https://shop.test/receipt — title "Receipt"');
});
