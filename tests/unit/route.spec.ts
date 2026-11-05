/**
 * Route-robust compilation (ADR 0011): route evidence that abstains when missing
 * (`onMissing`), anyOf over alternative routes, items `flatten` for "add X keeps what was
 * there", the compiler's route checks, and cassettes that re-record only what changed.
 */
import { test, expect } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluate,
  reviewSheet,
  validateCheckSet,
  type Assertion,
  type Check,
  type CheckSet,
  type EvidenceSnapshot,
  type Json,
  type NetworkEntry,
  type Normalizer,
} from '../../src/index.ts';
import { coverage, verifyCandidate, type Reference } from '../../src/compiler/index.ts';
import { discoverySystem, literalRuns, routeOnlyFindings, unmarkedRouteChecks } from '../../src/compiler/compile.ts';
import { selectRequirement } from '../../src/verifier/escalate.ts';
import { applyNormalizers, NormalizeError } from '../../src/runtime/values.ts';
import { stressTest } from '../../src/stress/index.ts';
import { NO_RECORDING, recordingModel, replayOrRecordModel } from '../../src/model/replay.ts';
import type { ModelClient, ModelRequest } from '../../src/model/types.ts';

const ORIGIN = 'https://blog.test';
let seq = 0;
const post = (path: string, body: Json, status = 200): NetworkEntry => ({
  seq: ++seq,
  method: 'POST',
  url: `${ORIGIN}${path}`,
  resourceType: 'xhr',
  status,
  requestHeaders: {},
  requestBody: body,
  responseHeaders: {},
});
const HEARTBEAT = post('/wp-admin/admin-ajax.php', { action: 'heartbeat' });
const ADMIN_REPLY = post('/wp-admin/admin-ajax.php', { action: 'replyto-comment', comment_ID: '6', content: 'Yes.' });
const PUBLIC_REPLY = (parent: string) =>
  post('/wp-comments-post.php', { comment: 'Yes.', comment_parent: parent }, 302);

const comments = (...extra: Json[]) => ({
  ok: true as const,
  value: [{ id: 6, post: 6, author: 'Priya', content: 'Do you have an example?' }, ...extra],
});
const REPLY = { id: 8, post: 6, author: 'admin', content: 'Yes.' };

const snap = (network: NetworkEntry[], extra: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot => ({
  schema: 'assay.snapshot/v1',
  capturedAt: '',
  page: { url: `${ORIGIN}/wp-admin/edit-comments.php`, title: '' },
  a11y: { role: 'document', children: [{ role: 'main' }] },
  text: '',
  network,
  storage: { cookies: [], local: {}, session: {} },
  probes: { comments: comments(REPLY) },
  meta: { capturer: 't', redacted: [] },
  ...extra,
});

const AJAX_ROUTE = {
  method: 'POST',
  url: { path: '/wp-admin/admin-ajax.php' },
  requestBody: {
    type: 'object',
    properties: { action: { const: 'replyto-comment' } },
    required: ['action'],
  },
};
/** The admin route: the reply request, then its parent comment. */
const adminBranch: Assertion = {
  kind: 'value',
  source: { from: 'request', match: AJAX_ROUTE, pick: 'last' },
  expect: { schema: { type: 'object', properties: { comment_ID: { const: '6' } }, required: ['comment_ID'] } },
};
/** The public route: the comment form post, then its parent. */
const publicBranch: Assertion = {
  kind: 'value',
  source: { from: 'request', match: { method: 'POST', url: { path: '/wp-comments-post.php' } }, pick: 'last' },
  expect: { schema: { type: 'object', properties: { comment_parent: { const: '6' } }, required: ['comment_parent'] } },
};
const stored: Check = {
  id: 'stored',
  requirement: 'R1',
  description: 'A new comment by the admin is stored on post 6.',
  assert: {
    kind: 'value',
    source: { from: 'probe', probe: 'comments' },
    expect: {
      schema: {
        type: 'array',
        contains: {
          type: 'object',
          properties: { post: { const: 6 }, author: { const: 'admin' } },
          required: ['post', 'author'],
        },
      },
    },
  },
};

const set = (checks: Check[]): CheckSet => ({
  schema: 'assay.checks/v1',
  id: 'reply',
  version: '1',
  task: { instruction: "Reply to Priya's question." },
  requirements: [
    {
      id: 'R1',
      kind: 'hard',
      text: 'Reply to Priya.',
      source: { field: 'instruction', quote: "Reply to Priya's question" },
    },
  ],
  checks,
});
const check = (assert: Assertion, onMissing?: 'abstain'): Check => ({
  id: 'route',
  requirement: 'R1',
  description: 'The reply is to Priya.',
  assert,
  ...(onMissing ? { onMissing } : {}),
});
const status = (cs: CheckSet, s: EvidenceSnapshot, id = 'route') => {
  const c = evaluate(cs, s).checks.find((x) => x.check === id)!;
  return c.status === 'abstain' ? `abstain:${c.reason}` : c.status;
};

test.describe('onMissing "abstain": route evidence', () => {
  const request: Assertion = { kind: 'request', match: AJAX_ROUTE };

  test('a request check that matches no request abstains (route_missing) instead of failing', () => {
    const other = snap([HEARTBEAT, PUBLIC_REPLY('6')]);
    expect(status(set([check(request)]), other)).toBe('fail');
    expect(status(set([check(request, 'abstain')]), other)).toBe('abstain:route_missing');
    expect(evaluate(set([check(request, 'abstain')]), other).checks[0]!.message).toContain('another way');
    expect(status(set([check(request, 'abstain')]), snap([HEARTBEAT, ADMIN_REPLY]))).toBe('pass');
  });

  test('a request seen once too few or too often still fails: the route was taken', () => {
    const twice: Assertion = { kind: 'request', match: AJAX_ROUTE, count: { eq: 2 } };
    expect(status(set([check(twice, 'abstain')]), snap([ADMIN_REPLY]))).toBe('fail');
    const once: Assertion = { kind: 'request', match: AJAX_ROUTE, count: { eq: 1 } };
    expect(status(set([check(once, 'abstain')]), snap([ADMIN_REPLY, ADMIN_REPLY]))).toBe('fail');
    // An absence check is decided by its evidence either way.
    const none: Assertion = { kind: 'request', match: AJAX_ROUTE, count: { eq: 0 } };
    expect(status(set([check(none, 'abstain')]), snap([]))).toBe('pass');
  });

  test("a value read from a route's request: missing abstains, found but wrong fails", () => {
    expect(status(set([check(adminBranch, 'abstain')]), snap([HEARTBEAT]))).toBe('abstain:route_missing');
    expect(status(set([check(adminBranch)]), snap([HEARTBEAT]))).toBe('abstain:value_unavailable');
    const wrong = post('/wp-admin/admin-ajax.php', { action: 'replyto-comment', comment_ID: '5' });
    expect(status(set([check(adminBranch, 'abstain')]), snap([wrong]))).toBe('fail');
  });

  test('a URL elsewhere abstains; on the route, a wrong query parameter fails', () => {
    const url: Assertion = { kind: 'url', match: { path: '/wp-admin/edit.php', query: { post_status: 'draft' } } };
    const at = (u: string) => snap([], { page: { url: `${ORIGIN}${u}`, title: '' } });
    expect(status(set([check(url, 'abstain')]), at('/wp-admin/post.php?post=12'))).toBe('abstain:route_missing');
    expect(status(set([check(url, 'abstain')]), at('/wp-admin/edit.php?post_status=pending'))).toBe('fail');
    expect(status(set([check(url, 'abstain')]), at('/wp-admin/edit.php?post_status=draft'))).toBe('pass');
    expect(status(set([check(url)]), at('/wp-admin/post.php?post=12'))).toBe('fail');
  });

  test('the route of a URL is its origin and path shape; regex, query and record ids are outcome', () => {
    const at = (u: string) => snap([], { page: { url: `${ORIGIN}${u}`, title: '' } });
    const regex: Assertion = { kind: 'url', match: { path: '/wp-admin/edit.php', regex: 'post_status=draft' } };
    expect(status(set([check(regex, 'abstain')]), at('/wp-admin/edit.php?post_status=publish'))).toBe('fail');
    expect(status(set([check(regex, 'abstain')]), at('/wp-admin/post.php?post=1'))).toBe('abstain:route_missing');
    // A regex alone names no route: it is always decided.
    const only: Assertion = { kind: 'url', match: { regex: 'post_status=draft' } };
    expect(status(set([check(only, 'abstain')]), at('/wp-admin/post.php?post=1'))).toBe('fail');
    // Another record on the same page is the route taken with the wrong record.
    const issue: Assertion = { kind: 'url', match: { path: '/acme/webapp/issues/5' } };
    expect(status(set([check(issue, 'abstain')]), at('/acme/webapp/issues/6'))).toBe('fail');
    expect(status(set([check(issue, 'abstain')]), at('/acme/webapp/pulls/5'))).toBe('abstain:route_missing');
    // The compiler does not demand onMissing for a URL leaf that is never route_missing.
    const refs: Reference[] = [
      { name: 'a', kind: 'success', snapshot: at('/x?post_status=draft') },
      { name: 'b', kind: 'success', snapshot: at('/y?post_status=draft') },
    ];
    expect(unmarkedRouteChecks(set([check(only)]), refs)).toEqual([]);
  });

  test('anyOf over two routes: the route the run took decides; with neither, it abstains', () => {
    const both = set([check({ kind: 'anyOf', of: [adminBranch, publicBranch] }, 'abstain')]);
    expect(status(both, snap([HEARTBEAT, ADMIN_REPLY]))).toBe('pass');
    expect(status(both, snap([HEARTBEAT, PUBLIC_REPLY('6')]))).toBe('pass');
    // A top-level comment through the public form: that route was taken, with the wrong parent.
    expect(status(both, snap([HEARTBEAT, PUBLIC_REPLY('0')]))).toBe('fail');
    expect(status(both, snap([HEARTBEAT]))).toBe('abstain:route_missing');
    // Without onMissing, the missing branch fails and the anyOf follows plain Kleene logic.
    expect(status(set([check({ kind: 'anyOf', of: [adminBranch, publicBranch] })]), snap([PUBLIC_REPLY('0')]))).toBe(
      'abstain:value_unavailable',
    );
  });

  test('anyOf over routes: when both were taken, the route used last decides', () => {
    const branch = (path: string): Assertion => ({
      kind: 'value',
      source: { from: 'request', match: { method: 'POST', url: { path } }, pick: 'last' },
      expect: { schema: { type: 'object', properties: { d: { const: 'ok' } }, required: ['d'] } },
    });
    const cs = set([check({ kind: 'anyOf', of: [branch('/a'), branch('/b')] }, 'abstain')]);
    const a = (d: string) => post('/a', { d });
    const b = (d: string) => post('/b', { d });
    // Set right through /a, then overwritten wrongly through /b: the final state is wrong.
    expect(status(cs, snap([a('ok'), b('bad')]))).toBe('fail');
    expect(status(cs, snap([b('bad'), a('ok')]))).toBe('pass');
    expect(status(cs, snap([a('bad'), b('ok')]))).toBe('pass');
    // The sequence number is internal: it does not appear in the check results.
    expect(Object.keys(evaluate(cs, snap([a('ok')])).checks[0]!)).not.toContain('seq');
  });

  test('the requirement abstains (and escalates) unless other evidence fails it: near misses still fail', () => {
    const cs = set([check({ kind: 'request', match: AJAX_ROUTE }, 'abstain'), stored]);
    const otherRoute = evaluate(cs, snap([PUBLIC_REPLY('6')]));
    expect(otherRoute.requirements[0]).toMatchObject({ status: 'abstain', reason: 'route_missing' });
    expect(otherRoute.verdict).toBe('abstain');
    expect(selectRequirement(cs, cs.requirements[0]!, otherRoute, { on: ['abstain'], includeSoft: false })).toBe(
      'policy',
    );
    // Nothing stored: the probe fails the requirement whatever the route evidence says.
    const nothing = evaluate(cs, snap([], { probes: { comments: comments() } }));
    expect(nothing.requirements[0]!.status).toBe('fail');
    expect(nothing.verdict).toBe('fail');
  });

  test('validation: onMissing is part of the DSL, warned about where it has no effect, and shown for review', () => {
    expect(validateCheckSet(set([check({ kind: 'request', match: AJAX_ROUTE }, 'abstain')])).ok).toBe(true);
    expect(validateCheckSet(set([{ ...stored, onMissing: 'sometimes' as 'abstain' }])).ok).toBe(false);
    const probeOnly = validateCheckSet(set([{ ...stored, onMissing: 'abstain' }]));
    expect(probeOnly.ok).toBe(true);
    expect(probeOnly.warnings.join('\n')).toContain('has no effect');
    // A value check on route evidence marked onMissing "abstain" is meant to abstain when missing.
    const plain = validateCheckSet(set([check(adminBranch), stored]));
    expect(plain.warnings.join('\n')).toContain('add a "request" check');
    const marked = validateCheckSet(set([check(adminBranch, 'abstain')]));
    expect(marked.warnings.join('\n')).not.toContain('add a "request" check');
    expect(reviewSheet(set([check(adminBranch, 'abstain')]))).toContain('on missing route evidence: abstain');
    // A request inside an abstain-marked allOf abstains when missing too: it proves nothing is sent.
    const both = check({ kind: 'allOf', of: [{ kind: 'request', match: AJAX_ROUTE }, adminBranch] }, 'abstain');
    expect(validateCheckSet(set([both, { ...check(adminBranch), id: 'value' }])).warnings.join('\n')).toContain(
      'add a "request" check',
    );
    const plainBoth = { ...both, onMissing: undefined };
    expect(
      validateCheckSet(set([plainBoth, { ...check(adminBranch), id: 'value' }])).warnings.join('\n'),
    ).not.toContain('add a "request" check');
  });
});

test.describe('items flatten: "add X" keeps what was there', () => {
  const posts = (tags: string[]) => [
    { id: 3, title: 'Flaky tests', tags },
    { id: 4, title: 'Other', tags: ['release'] },
  ];
  const tagsOf: Normalizer[] = [
    {
      op: 'items',
      where: { properties: { title: { const: 'Flaky tests' } }, required: ['title'] },
      pointer: '/tags',
      flatten: true,
    },
    { op: 'items', where: { not: { const: 'testing' } } },
  ];

  test("flatten makes a record's array field the collection", () => {
    expect(applyNormalizers({ type: 'json', value: posts(['testing', 'performance']) }, tagsOf)).toEqual({
      type: 'json',
      value: ['performance'],
    });
    expect(() =>
      applyNormalizers({ type: 'json', value: [{ title: 'Flaky tests', tags: 'x' }] }, [
        { op: 'items', pointer: '/tags', flatten: true },
      ]),
    ).toThrow(NormalizeError);
  });

  const kept: Check = {
    id: 'kept',
    requirement: 'R1',
    description: 'The tags the post had before are still there.',
    assert: {
      kind: 'value',
      source: { from: 'probe', probe: 'posts' },
      normalize: tagsOf,
      expect: { sameAs: { source: { from: 'probe', probe: 'posts', at: 'before' }, normalize: tagsOf } },
    },
  };
  const added: Check = {
    id: 'added',
    requirement: 'R1',
    description: 'The post has the tag testing.',
    assert: {
      kind: 'value',
      source: { from: 'probe', probe: 'posts' },
      expect: {
        schema: {
          type: 'array',
          contains: {
            type: 'object',
            properties: { title: { const: 'Flaky tests' }, tags: { type: 'array', contains: { const: 'testing' } } },
            required: ['title', 'tags'],
          },
        },
      },
    },
  };
  const cs: CheckSet = {
    schema: 'assay.checks/v1',
    id: 'add-tag',
    version: '1',
    task: { instruction: 'Add the tag "testing" to the post "Flaky tests".' },
    requirements: [
      {
        id: 'R1',
        kind: 'hard',
        text: 'The post has the tag testing.',
        source: { field: 'instruction', quote: 'Add the tag "testing" to the post "Flaky tests".' },
      },
    ],
    checks: [added, kept],
  };
  const run = (before: string[], after: string[]): EvidenceSnapshot =>
    snap([], {
      probes: { posts: { ok: true, value: posts(after) } },
      baseline: {
        capturedAt: '',
        url: ORIGIN,
        storage: null,
        probes: { posts: { ok: true, value: posts(before) } },
        redacted: [],
      },
    });

  test('the added tag joins the existing ones; replacing them fails', () => {
    expect(validateCheckSet(cs)).toMatchObject({ ok: true });
    expect(evaluate(cs, run(['performance'], ['performance', 'testing'])).verdict).toBe('success');
    expect(evaluate(cs, run(['performance'], ['testing', 'performance'])).verdict).toBe('success');
    expect(evaluate(cs, run(['performance'], ['testing'])).verdict).toBe('fail');
    expect(evaluate(cs, run(['performance'], ['performance'])).verdict).toBe('fail');
  });

  test('stress: valid variants accepted, the no-op and broken collections rejected', () => {
    const r = stressTest(cs, [{ name: 'ok', snapshot: run(['performance'], ['performance', 'testing']) }]);
    expect(r.overConstrained).toEqual([]);
    expect(r.fragile).toEqual([]);
    // The no-op is not a weakness of the check on the kept tags: they are the same before and after.
    expect(r.weak).toEqual([]);
    expect(r.rates.variantsAccepted).toBe(r.rates.variantsTotal);
    expect(r.rates.mutantsRejected).toBe(r.rates.mutantsTotal);
    expect(r.rates.mutantsTotal).toBeGreaterThan(0);
  });

  test('two flattened fields of one probe are two collections, not a field-wise comparison', () => {
    const categoriesOf: Normalizer[] = [
      {
        op: 'items',
        where: { properties: { title: { const: 'Flaky tests' } }, required: ['title'] },
        pointer: '/categories',
        flatten: true,
      },
    ];
    const keptCategories: Check = {
      ...kept,
      id: 'categories',
      assert: {
        kind: 'value',
        source: { from: 'probe', probe: 'posts' },
        normalize: categoriesOf,
        expect: { sameAs: { source: { from: 'probe', probe: 'posts', at: 'before' }, normalize: categoriesOf } },
      },
    };
    const both = { ...cs, checks: [added, kept, keptCategories] };
    expect(validateCheckSet(both).warnings.join('\n')).not.toContain('one field at a time');
    const withCats = (tags: string[]) => [
      { id: 3, title: 'Flaky tests', tags, categories: ['Tutorials'] },
      { id: 4, title: 'Other', tags: ['release'], categories: ['News'] },
    ];
    const ref = snap([], {
      probes: { posts: { ok: true, value: withCats(['performance', 'testing']) } },
      baseline: {
        capturedAt: '',
        url: ORIGIN,
        storage: null,
        probes: { posts: { ok: true, value: withCats(['performance']) } },
        redacted: [],
      },
    });
    expect(verifyCandidate(both, [{ name: 'ok', kind: 'success', snapshot: ref }], false).errors).toEqual([]);
  });

  test('validation: flatten needs a pointer and cannot take pick', () => {
    const withSteps = (normalize: unknown) =>
      validateCheckSet({ ...cs, checks: [{ ...kept, assert: { ...kept.assert, normalize } }] });
    expect(withSteps([{ op: 'items', flatten: true }]).errors.join('\n')).toContain('needs a pointer');
    expect(withSteps([{ op: 'items', pick: ['/a'], flatten: true }]).errors.join('\n')).toContain('pick');
  });
});

test('JSON Schema comparisons enforce minContains and maxContains (draft 2019-09)', () => {
  // A compiled check counted cart lines with these; draft-07 ignored them, so one cushion passed for two.
  const lines: Check = {
    ...stored,
    assert: {
      kind: 'value',
      source: { from: 'probe', probe: 'comments' },
      expect: {
        schema: { type: 'array', contains: { properties: { post: { const: 6 } } }, minContains: 2, maxContains: 2 },
      },
    },
  };
  expect(evaluate(set([lines]), snap([], { probes: { comments: comments() } })).verdict).toBe('fail');
  expect(evaluate(set([lines]), snap([])).verdict).toBe('success');
  expect(evaluate(set([lines]), snap([], { probes: { comments: comments(REPLY, REPLY) } })).verdict).toBe('fail');
});

test('a JSON Schema that declares draft-07 still validates and evaluates', () => {
  const declared: Check = {
    ...stored,
    assert: {
      kind: 'value',
      source: { from: 'probe', probe: 'comments' },
      expect: {
        schema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'array',
          contains: { properties: { author: { const: 'admin' } }, required: ['author'] },
        },
      },
    },
  };
  expect(validateCheckSet(set([declared]))).toMatchObject({ ok: true, errors: [] });
  expect(evaluate(set([declared]), snap([])).verdict).toBe('success');
  expect(evaluate(set([declared]), snap([], { probes: { comments: comments() } })).verdict).toBe('fail');
});

test.describe('compiler: route evidence', () => {
  const ref = (name: string, network: NetworkEntry[], extra: Partial<EvidenceSnapshot> = {}): Reference => ({
    name,
    kind: 'success',
    snapshot: snap(network, extra),
  });
  const refs = [ref('reference', [HEARTBEAT, ADMIN_REPLY]), ref('reference-public', [PUBLIC_REPLY('6')])];
  const anyOfRoutes: Assertion = { kind: 'anyOf', of: [adminBranch, publicBranch] };

  test('route evidence that a correct reference lacks must be marked onMissing "abstain"', () => {
    const errors = unmarkedRouteChecks(set([check(anyOfRoutes), stored]), refs);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"onMissing": "abstain"');
    expect(errors[0]).toContain('reference-public');
    expect(unmarkedRouteChecks(set([check(anyOfRoutes, 'abstain'), stored]), refs)).toEqual([]);
    // One reference: nothing shows the route is one of several.
    expect(unmarkedRouteChecks(set([check(adminBranch), stored]), refs.slice(0, 1))).toEqual([]);
    const v = verifyCandidate(set([check(anyOfRoutes), stored]), refs, false);
    expect(v.errors.join('\n')).toContain('onMissing');
    expect(verifyCandidate(set([check(anyOfRoutes, 'abstain'), stored]), refs, false).errors).toEqual([]);
  });

  test('a branch for a route no correct reference took is refused', () => {
    const v = verifyCandidate(
      set([check({ kind: 'anyOf', of: [adminBranch, publicBranch] }, 'abstain'), stored]),
      refs.slice(0, 1),
      false,
    );
    expect(v.errors.join('\n')).toContain('abstains on every correct run');
  });

  test('a requirement with only route evidence: refused when a probe holds what it compares, else a warning', () => {
    const text: Assertion = {
      kind: 'value',
      source: { from: 'request', match: AJAX_ROUTE, pick: 'last' },
      expect: {
        schema: {
          type: 'object',
          properties: { content: { type: 'string', pattern: '^\\s*Yes, see the docs[.!]?\\s*$' } },
          required: ['content'],
        },
      },
    };
    const reply = { id: 8, post: 6, author: 'admin', content: 'Yes, see the docs.' };
    const baseline = {
      capturedAt: '',
      url: ORIGIN,
      storage: null,
      probes: { comments: comments() },
      redacted: [],
    };
    const withProbe = [ref('reference', [ADMIN_REPLY], { probes: { comments: comments(reply) }, baseline })];
    const refused = routeOnlyFindings(set([check(text, 'abstain')]), withProbe);
    expect(refused.errors).toHaveLength(1);
    expect(refused.errors[0]).toContain('probe comments holds "Yes, see the docs"');
    // The probe does not hold it: a warning that names the probes.
    const warned = routeOnlyFindings(set([check(adminBranch, 'abstain')]), withProbe);
    expect(warned.errors).toEqual([]);
    expect(warned.warnings[0]).toContain('no evidence independent of');
    expect(warned.warnings[0]).toContain('abstains');
    expect(warned.warnings[0]).toContain('comments');
    // With a probe check as well, the requirement is not route-only.
    expect(routeOnlyFindings(set([check(text, 'abstain'), stored]), withProbe)).toEqual({ errors: [], warnings: [] });
    expect(coverage(set([check(adminBranch, 'abstain')]))[0]!.routeOnly).toBe(true);
    expect(coverage(set([check(adminBranch, 'abstain'), stored]))[0]!.routeOnly).toBeUndefined();
    // A view's URL alone is the state of the view, not route evidence.
    expect(coverage(set([check({ kind: 'url', match: { path: '/drafts' } })]))[0]!.routeOnly).toBeUndefined();
  });

  test('the absence section is added only when a probe cannot show a record missing', () => {
    const base = (ok: boolean) => ({
      capturedAt: '',
      url: ORIGIN,
      storage: null,
      probes: { latest: ok ? { ok: true as const, value: [] } : { ok: false as const, error: '404' } },
      redacted: [],
    });
    const has = (extra: Partial<EvidenceSnapshot>) =>
      discoverySystem([ref('r', [], extra)]).includes('Records a probe cannot show missing');
    expect(has({})).toBe(true);
    expect(has({ baseline: base(false) })).toBe(true);
    expect(has({ baseline: base(true) })).toBe(false);
    expect(discoverySystem([ref('r', [], { baseline: base(true) })])).toContain('State before the task');
  });

  test('literal runs of a pattern', () => {
    expect(literalRuns('^\\s*Yes, see the network waits section in the docs[.!]?\\s*$')).toEqual([
      'Yes, see the network waits section in the docs',
    ]);
    expect(literalRuns('^0?1$')).toEqual([]);
    expect(literalRuns('Scheduled\\s+2027/01/05 at 9:00 am')).toEqual(['Scheduled', '2027/01/05 at 9:00 am']);
  });
});

test.describe('cassettes: a turn that cannot be recorded reads as a stale cassette', () => {
  const req: ModelRequest = { system: 's', messages: [{ role: 'user', text: 'new' }], tools: [] };
  const cassette = () => {
    const path = join(mkdtempSync(join(tmpdir(), 'assay-hybrid-')), 'c.json');
    const rec = recordingModel(
      {
        id: 'fake:model',
        turn: async () => ({
          stop: 'end_turn',
          text: 'x',
          toolCalls: [],
          raw: null,
          usage: { inputTokens: 1, outputTokens: 1 },
          model: 'm',
        }),
      },
      path,
    );
    rec.save();
    return { path, before: readFileSync(path, 'utf8') };
  };
  for (const [what, live] of [
    [
      'another model',
      async (): Promise<ModelClient> => ({
        id: 'fake:other',
        turn: async () => {
          throw new Error('unused');
        },
      }),
    ],
    [
      'a failed live call',
      async (): Promise<ModelClient> => ({
        id: 'fake:model',
        turn: async () => {
          throw new Error('HTTP 529 overloaded');
        },
      }),
    ],
    [
      'no live model',
      async (): Promise<ModelClient> => {
        throw new Error('no SDK');
      },
    ],
  ] as const) {
    test(what, async () => {
      const { path, before } = cassette();
      const m = replayOrRecordModel(path, live);
      const err = await m.turn(req).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err?.message).toContain(NO_RECORDING);
      expect(m.misses).toBe(0);
      expect(m.id).toBe('fake:model (replay)');
      m.save();
      expect(readFileSync(path, 'utf8')).toBe(before);
    });
  }
});

test.describe('cassettes: replay what is recorded, record what is not', () => {
  const req = (text: string): ModelRequest => ({ system: 's', messages: [{ role: 'user', text }], tools: [] });
  const fake = (calls: string[]): ModelClient => ({
    id: 'fake:model',
    async turn(r) {
      const text = (r.messages[0] as { text: string }).text;
      calls.push(text);
      return {
        stop: 'end_turn',
        text: `answer ${text}`,
        toolCalls: [],
        raw: null,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'fake',
      };
    },
  });

  test('hits replay without a live model; a miss records, and save writes only the turns used', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'assay-hybrid-'));
    const path = join(dir, 'c.json');
    const calls: string[] = [];
    const rec = recordingModel(fake(calls), path);
    await rec.turn(req('a'));
    await rec.turn(req('b'));
    rec.save();
    const before = readFileSync(path, 'utf8');
    const recordedAt = JSON.parse(before).recordedAt;

    let started = 0;
    const live = async () => (started++, fake(calls));
    const same = replayOrRecordModel(path, live);
    await same.turn(req('a'));
    same.save();
    expect(started).toBe(0);
    expect(same.recorded.at).toBe(recordedAt);
    expect(readFileSync(path, 'utf8')).toBe(before);

    const changed = replayOrRecordModel(path, live);
    expect((await changed.turn(req('a'))).text).toBe('answer a');
    await changed.turn(req('c'));
    expect(started).toBe(1);
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(changed.misses).toBe(1);
    expect(changed.recorded.at).not.toBe(recordedAt);
    changed.save();
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.keys(after.turns)).toHaveLength(2);
    expect(after.recordedAt).toBe(changed.recorded.at);
    expect(existsSync(`${path}.partial`)).toBe(false);
  });
});
