/** Stress testing over frame content, other open pages and parsed form fields (ADR 0012). */
import { expect, test } from '@playwright/test';
import type { Assertion, CheckSet, EvidenceSnapshot } from '../../src/index.ts';
import { generateMutants, generateVariants, stressTest } from '../../src/stress/index.ts';

const reference: EvidenceSnapshot = {
  schema: 'assay.snapshot/v1',
  capturedAt: '2026-11-05T00:00:00Z',
  page: { url: 'https://cms.test/wp-admin/post.php?post=12&action=edit', title: 'Edit Post' },
  a11y: {
    role: 'document',
    children: [
      {
        role: 'main',
        children: [
          { role: 'heading', name: 'Edit Post', level: 1 },
          {
            role: 'iframe',
            name: 'Editor canvas',
            url: 'https://cms.test/canvas',
            children: [
              {
                role: 'main',
                name: 'Block editor',
                children: [
                  { role: 'textbox', name: 'Add title', value: 'Roadmap 2027' },
                  { role: 'paragraph', children: [{ role: 'text', name: 'What we plan to build next year.' }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  text: 'Edit Post\nWhat we plan to build next year.',
  network: [
    {
      seq: 0,
      method: 'POST',
      url: 'https://forge.test/alice/demo/issues/new',
      resourceType: 'document',
      status: 303,
      requestHeaders: { 'content-type': 'multipart/form-data; boundary=x' },
      requestBody: {
        title: 'Login button misaligned',
        label: ['bug', 'ui'],
        attachment: { filename: 'screenshot.png', type: 'image/png', size: 2048 },
      },
      responseHeaders: {},
    },
  ],
  storage: null,
  probes: {},
  pages: [
    {
      url: 'https://cms.test/2027/roadmap',
      title: 'Roadmap 2027 – Preview',
      a11y: {
        role: 'document',
        children: [{ role: 'article', children: [{ role: 'heading', name: 'Roadmap 2027', level: 1 }] }],
      },
      text: 'Roadmap 2027',
    },
  ],
  meta: { capturer: 'test', redacted: [] },
};

const set = (assertions: Assertion[]): CheckSet => ({
  schema: 'assay.checks/v1',
  id: 'coverage',
  version: '1',
  task: { instruction: 'Write the post.' },
  requirements: [{ id: 'R1', kind: 'hard', text: 'post', source: { field: 'instruction', quote: 'Write the post' } }],
  checks: assertions.map((assert, i) => ({ id: `C${i + 1}`, requirement: 'R1', description: 'd', assert })),
});

const canvas = { role: 'iframe', name: 'Editor canvas' };
const title: Assertion = {
  kind: 'state',
  target: { role: 'textbox', name: 'Add title', within: canvas },
  expect: { value: 'Roadmap 2027' },
};
const heading: Assertion = { kind: 'state', target: { role: 'heading', level: 1 }, expect: { name: 'Edit Post' } };

test('a frame that never loaded is a mutant of the checks that read the frame', () => {
  const cs = set([title, heading]);
  const mutants = generateMutants(cs, reference);
  expect(mutants.map((m) => m.id)).toContain('C1:frame:unloaded');
  // The heading is outside the frame: the frame's absence changes nothing for it.
  expect(mutants.some((m) => m.id.startsWith('C2:frame:'))).toBe(false);
  const r = stressTest(cs, [{ name: 'ref', snapshot: reference }]);
  const unloaded = r.mutants.find((m) => m.id === 'C1:frame:unloaded' && !m.claim)!;
  expect(unloaded).toMatchObject({ rejected: true, rejectedBy: 'abstain' });
  expect(r.weak).toEqual([]);
});

test('an absence check inside a frame without a witness is weak: an unloaded frame passes it', () => {
  const cs = set([{ kind: 'contains', scope: canvas, match: { role: 'alert' }, count: { eq: 0 } }]);
  const r = stressTest(cs, [{ name: 'ref', snapshot: reference }]);
  expect(r.weak.map((w) => [w.check, w.mutants.map((m) => m.id)])).toEqual([['C1', ['C1:frame:unloaded']]]);
  // With a witness it is not.
  const witnessed = set([
    {
      kind: 'contains',
      scope: canvas,
      witness: { role: 'textbox', name: 'Add title' },
      match: { role: 'alert' },
      count: { eq: 0 },
    },
  ]);
  expect(stressTest(witnessed, [{ name: 'ref', snapshot: reference }]).weak).toEqual([]);
});

test('frame and page variants apply only where frames and pages were captured, and stay valid', () => {
  const ids = (s: EvidenceSnapshot) => generateVariants(set([title]), s).map((v) => v.id);
  expect(ids(reference)).toEqual(expect.arrayContaining(['extra-frame', 'extra-page']));
  const { pages: _, ...onePage } = reference;
  const flat = { ...onePage, a11y: { role: 'document', children: [{ role: 'main' }] } };
  expect(ids(flat)).not.toContain('extra-frame');
  expect(ids(flat)).not.toContain('extra-page');

  const onPreview: Assertion = {
    kind: 'page',
    match: { url: { path: '/2027/roadmap' } },
    assert: { kind: 'contains', scope: { role: 'article' }, match: { role: 'heading', name: 'Roadmap 2027' } },
  };
  const r = stressTest(set([title, onPreview]), [{ name: 'ref', snapshot: reference }]);
  expect(r.variants.filter((v) => ['extra-frame', 'extra-page'].includes(v.id)).map((v) => v.accepted)).toEqual([
    true,
    true,
  ]);
  // A page selected only by its origin is ambiguous once another tab of the site is open.
  const loose: Assertion = { ...onPreview, match: { url: { origin: 'https://cms.test' } } } as Assertion;
  const lr = stressTest(set([loose]), [
    { name: 'ref', snapshot: { ...reference, page: { ...reference.page, url: 'https://other.test/' } } },
  ]);
  expect(lr.fragile.map((f) => [f.check, f.variants.map((v) => v.id)])).toEqual([['C1', ['extra-page']]]);
});

test('a page assertion is broken on the page it selects, and by that page never opening', () => {
  const cs = set([
    {
      kind: 'page',
      match: { title: { contains: 'Preview' } },
      assert: { kind: 'state', target: { role: 'heading', level: 1 }, expect: { name: 'Roadmap 2027' } },
    },
  ]);
  const mutants = generateMutants(cs, reference);
  expect(mutants.map((m) => m.id)).toEqual(expect.arrayContaining(['C1:page:closed', 'C1:state:name']));
  const renamed = mutants.find((m) => m.id === 'C1:state:name')!;
  // The edit lands on the selected page; the active page is untouched.
  expect(renamed.snapshot.a11y).toEqual(reference.a11y);
  expect(renamed.snapshot.pages![0]!.a11y).not.toEqual(reference.pages![0]!.a11y);
  const r = stressTest(cs, [{ name: 'ref', snapshot: reference }]);
  expect(r.mutants.filter((m) => !m.advisory).every((m) => m.rejected)).toBe(true);
  expect(r.mutants.find((m) => m.id === 'C1:page:closed')!.rejectedBy).toBe('abstain');
});

test('parsed multipart fields are mutated like JSON bodies', () => {
  const cs = set([
    {
      kind: 'request',
      match: {
        method: 'POST',
        url: { path: '/alice/demo/issues/new' },
        status: 303,
        requestBody: {
          type: 'object',
          required: ['title', 'label'],
          properties: {
            title: { const: 'Login button misaligned' },
            label: { type: 'array', contains: { const: 'ui' } },
          },
        },
      },
    },
    {
      kind: 'value',
      source: {
        from: 'request',
        match: { method: 'POST', url: { path: '/alice/demo/issues/new' }, status: 303 },
        pointer: '/attachment/filename',
      },
      expect: { equals: 'screenshot.png' },
    },
  ]);
  const r = stressTest(cs, [{ name: 'ref', snapshot: reference }]);
  const ids = r.mutants.filter((m) => !m.claim).map((m) => m.id);
  expect(ids.filter((id) => id.startsWith('C1:request:requestBody:schema')).length).toBeGreaterThan(0);
  expect(ids.filter((id) => id.startsWith('C2:')).length).toBeGreaterThan(0);
  expect(r.mutants.filter((m) => !m.advisory && !m.rejected).map((m) => `${m.id}: ${m.description}`)).toEqual([]);
  expect(r.variants.filter((v) => !v.accepted).map((v) => v.id)).toEqual([]);
});
