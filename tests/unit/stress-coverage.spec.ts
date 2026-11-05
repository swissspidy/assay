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

test('an absence check scoped to an unloaded frame abstains; one that reaches it through within is weak', () => {
  // Scoped to the frame: the unloaded frame cannot be searched, so the check abstains.
  const cs = set([{ kind: 'contains', scope: canvas, match: { role: 'alert' }, count: { eq: 0 } }]);
  const r = stressTest(cs, [{ name: 'ref', snapshot: reference }]);
  expect(r.mutants.find((m) => m.id === 'C1:frame:unloaded' && !m.claim)).toMatchObject({
    rejected: true,
    rejectedBy: 'abstain',
  });
  expect(r.weak).toEqual([]);
  // Reaching into the frame with within: its result does not change, but it reads the frame.
  const within = set([{ kind: 'contains', match: { role: 'alert', within: canvas }, count: { eq: 0 } }]);
  const w = stressTest(within, [{ name: 'ref', snapshot: reference }]);
  expect(w.weak.map((x) => [x.check, x.mutants.map((m) => m.id)])).toEqual([['C1', ['C1:frame:unloaded']]]);
  // With a witness the scoped one is not weak either.
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

test('an iframe locator matched by contains, not only by its exact name, addresses the frame', () => {
  const cs = set([
    {
      kind: 'contains',
      match: { role: 'alert', within: { role: 'iframe', name: { contains: 'Editor' } } },
      count: { eq: 0 },
    },
  ]);
  const r = stressTest(cs, [{ name: 'ref', snapshot: reference }]);
  expect(r.weak.map((w) => w.mutants.map((m) => m.id))).toEqual([['C1:frame:unloaded']]);
});

test('an anyOf with an alternative that does not read the frame gets no unloaded-frame mutant', () => {
  const cs = set([
    {
      kind: 'anyOf',
      of: [{ kind: 'contains', scope: canvas, match: { role: 'alert' }, count: { eq: 0 } }, heading],
    },
  ]);
  expect(generateMutants(cs, reference).some((m) => m.id.includes('frame:'))).toBe(false);
  expect(stressTest(cs, [{ name: 'ref', snapshot: reference }]).weak).toEqual([]);
});

test('frames on a page a page assertion selects get unloaded-frame mutants and ad variants', () => {
  const framedPreview: EvidenceSnapshot = {
    ...reference,
    pages: [
      {
        ...reference.pages![0]!,
        a11y: {
          role: 'document',
          children: [
            {
              role: 'main',
              children: [
                {
                  role: 'iframe',
                  name: 'Comments',
                  children: [{ role: 'main', children: [{ role: 'heading', name: 'Great post', level: 2 }] }],
                },
              ],
            },
          ],
        },
      },
    ],
  };
  const cs = set([
    {
      kind: 'page',
      match: { title: { contains: 'Preview' } },
      assert: { kind: 'contains', scope: { role: 'iframe' }, match: { role: 'heading', name: 'Great post' } },
    },
  ]);
  const unloaded = generateMutants(cs, framedPreview).find((m) => m.id === 'C1:frame:unloaded')!;
  expect(unloaded.snapshot.a11y).toEqual(framedPreview.a11y); // the active page is untouched
  expect(JSON.stringify(unloaded.snapshot.pages![0]!.a11y)).toContain('"frame":"unavailable"');
  const r = stressTest(cs, [{ name: 'ref', snapshot: framedPreview }]);
  expect(r.mutants.find((m) => m.id === 'C1:frame:unloaded' && !m.claim)!.rejected).toBe(true);
  // The ad goes on that page too, outside its frame: the role-only iframe scope becomes
  // ambiguous there, which the stress test reports as fragile.
  const ad = generateVariants(cs, framedPreview).find((v) => v.id === 'extra-frame')!;
  expect(JSON.stringify(ad.snapshot.pages![0]!.a11y)).toContain('"name":"Advertisement"');
  expect(r.fragile.map((f) => [f.check, f.variants.map((v) => v.id)])).toEqual([['C1', ['extra-frame']]]);
});

test('the ad frame goes outside existing frames, so their content is unchanged', () => {
  const ad = generateVariants(set([title]), reference).find((v) => v.id === 'extra-frame')!;
  const main = ad.snapshot.a11y.children![0]!;
  expect(main.children!.at(-1)).toMatchObject({ role: 'iframe', name: 'Advertisement' });
  const canvasNode = main.children!.find((n) => n.name === 'Editor canvas')!;
  expect(canvasNode).toEqual(reference.a11y.children![0]!.children!.find((n) => n.name === 'Editor canvas'));
});
