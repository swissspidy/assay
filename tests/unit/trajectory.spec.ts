/**
 * Trajectory evidence and the `sequence` assertion (ADR 0024): evaluator semantics (in order,
 * out of order, missing evidence, unreadable bodies), validation, read-sets, stress mutants and
 * variants, the builder and printer, compiler exposure, and snapshots without a trajectory.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  evaluate,
  loadSnapshot,
  snapshotDigest,
  validateCheckSet,
  type Assertion,
  type CheckSet,
  type EvidenceSnapshot,
  type NetworkEntry,
  type TrajectoryEvent,
} from '../../src/index.ts';
import { readKeys, readSetOf } from '../../src/plan/readset.ts';
import { describeAssertion } from '../../src/verifier/lock.ts';
import { stressTest } from '../../src/stress/index.ts';
import { generateMutants, generateVariants } from '../../src/stress/index.ts';
import { checks, network, printCheckSet, req, sequence, url } from '../../src/checks/index.ts';
import { assertToolSchema, discoverySystem, dslDefinitions } from '../../src/compiler/compile.ts';
import { trajectoryView } from '../../src/compiler/explore.ts';
import { DISCOVERY_TRAJECTORY } from '../../src/compiler/prompts.ts';

const refill = (f: string) => new URL(`../../examples/refill/${f}`, import.meta.url);
const readJson = <T>(u: URL): T => JSON.parse(readFileSync(u, 'utf8')) as T;
const CHECKS = readJson<CheckSet>(refill('refill.checks.json'));
const ref = (name: string) => loadSnapshot(readJson<{ snapshot: unknown }>(refill(`references/${name}.json`)).snapshot);

const ORIGIN = 'https://rx.test';
const entry = (seq: number, method: string, path: string, extra: Partial<NetworkEntry> = {}): NetworkEntry => ({
  seq,
  method,
  url: `${ORIGIN}${path}`,
  resourceType: 'fetch',
  status: 200,
  requestHeaders: {},
  responseHeaders: {},
  ...extra,
});

/** A snapshot whose trajectory is these requests (in this order) and navigations ("nav:/path"). */
function snap(order: string[], extra: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot {
  const log: NetworkEntry[] = [];
  const trajectory: TrajectoryEvent[] = [];
  order.forEach((x, t) => {
    if (x.startsWith('nav:')) trajectory.push({ type: 'navigation', url: `${ORIGIN}${x.slice(4)}`, page: 0, t });
    else {
      const [method, path] = x.split(' ') as [string, string];
      log.push(entry(log.length, method, path));
      trajectory.push({ type: 'request', seq: log.length - 1, t });
    }
  });
  return {
    schema: 'assay.snapshot/v1',
    capturedAt: '2026-11-09T00:00:00Z',
    page: { url: `${ORIGIN}/done`, title: 'Done' },
    a11y: { role: 'document' },
    text: '',
    network: log,
    storage: null,
    probes: {},
    trajectory,
    meta: { capturer: 'test', redacted: [] },
    ...extra,
  };
}

const VERIFY = { request: { method: 'POST', url: { path: '/api/verify' } } };
const REFILL = { request: { method: 'POST', url: { path: '/api/refill' } } };
const ordered: Assertion = { kind: 'sequence', steps: [VERIFY, REFILL] };

function set(a: Assertion, onMissing?: 'fail' | 'abstain'): CheckSet {
  return {
    schema: 'assay.checks/v1',
    id: 't',
    version: '1',
    task: { instruction: 'Verify the identity before refilling.' },
    requirements: [
      {
        id: 'R1',
        kind: 'hard',
        text: 'order',
        source: { field: 'instruction', quote: 'Verify the identity before refilling' },
      },
    ],
    checks: [{ id: 'C1', requirement: 'R1', description: 'order', assert: a, ...(onMissing ? { onMissing } : {}) }],
  };
}
const check = (a: Assertion, s: EvidenceSnapshot, onMissing?: 'fail' | 'abstain') =>
  evaluate(set(a, onMissing), s).checks[0]!;

test('the committed references differ only in order, and only the sequence check tells them apart', () => {
  const good = ref('verified-first');
  const bad = ref('refill-first');
  // Same requests, same end state: only the order differs.
  const shape = (s: EvidenceSnapshot) => s.network!.map((e) => `${e.method} ${e.url} ${e.status}`).toSorted();
  expect(shape(bad)).toEqual(shape(good));
  expect(bad.probes).toEqual(good.probes);
  expect(bad.page.url).toBe(good.page.url);

  const ok = evaluate(CHECKS, good);
  expect(ok.verdict).toBe('success');
  const ko = evaluate(CHECKS, bad);
  expect(ko.verdict).toBe('fail');
  expect(ko.checks.map((c) => [c.check, c.status])).toEqual([
    ['C1', 'pass'],
    ['C2', 'pass'],
    ['C3', 'fail'],
  ]);
  expect(ko.checks[2]!.message).toMatch(
    /POST, path \/api\/refill first occurred at \[\d\] #1 POST .*\/api\/refill, before/,
  );
  expect(validateCheckSet(CHECKS)).toEqual({ ok: true, errors: [], warnings: [] });
});

test('sequence: in order passes, out of order fails, a missing step fails', () => {
  const pass = check(ordered, snap(['GET /', 'POST /api/verify', 'GET /x', 'POST /api/refill']));
  expect(pass).toMatchObject({ status: 'pass' });
  expect(pass.message).toBe(
    'in order: [1] #1 POST https://rx.test/api/verify → [3] #3 POST https://rx.test/api/refill',
  );
  expect(pass.evidence.map((e) => [e.channel, e.locator])).toEqual([
    ['network', 'trajectory, step 1: a request POST, path /api/verify'],
    ['network', 'trajectory, step 2: a request POST, path /api/refill'],
  ]);
  expect(check(ordered, snap(['POST /api/refill', 'POST /api/verify'])).status).toBe('fail');
  // Every refill must have a verification before it: a later, second refill does not excuse the first.
  expect(check(ordered, snap(['POST /api/refill', 'POST /api/verify', 'POST /api/refill'])).status).toBe('fail');
  // A refill without any verification, and a verification without a refill.
  expect(check(ordered, snap(['POST /api/refill'])).message).toMatch(
    /without a request POST, path \/api\/verify before it/,
  );
  expect(check(ordered, snap(['POST /api/verify'])).message).toBe(
    'no event matches step 2: a request POST, path /api/refill',
  );
  // Repeats of an earlier step after the next began are fine unless strict.
  const repeat = snap(['POST /api/verify', 'POST /api/refill', 'POST /api/verify']);
  expect(check(ordered, repeat).status).toBe('pass');
  expect(check({ ...ordered, strict: true }, repeat)).toMatchObject({
    status: 'fail',
    message: expect.stringMatching(/occurred again at \[2\].*\(strict order\)/),
  });
  expect(
    check({ ...ordered, strict: true }, snap(['POST /api/verify', 'POST /api/verify', 'POST /api/refill'])).status,
  ).toBe('pass');
});

test('sequence: navigations are steps too, and three steps chain', () => {
  const a: Assertion = { kind: 'sequence', steps: [{ url: { path: '/review' } }, VERIFY, REFILL] };
  expect(check(a, snap(['nav:/', 'nav:/review', 'POST /api/verify', 'POST /api/refill'])).status).toBe('pass');
  expect(check(a, snap(['nav:/', 'POST /api/verify', 'nav:/review', 'POST /api/refill'])).status).toBe('fail');
  // A request that is not a navigation never matches a URL step.
  expect(check(a, snap(['GET /review', 'POST /api/verify', 'POST /api/refill'])).status).toBe('fail');
});

test('sequence: missing evidence abstains, never fails', () => {
  // A snapshot captured without the trajectory (every snapshot before ADR 0024).
  const { trajectory: _t, ...old } = snap(['POST /api/verify', 'POST /api/refill']);
  expect(check(ordered, old as EvidenceSnapshot)).toMatchObject({
    status: 'abstain',
    reason: 'evidence_unavailable',
    message: expect.stringContaining('trajectory'),
  });
  expect(check(ordered, snap(['POST /api/verify', 'POST /api/refill'], { network: null }))).toMatchObject({
    status: 'abstain',
    reason: 'evidence_unavailable',
  });
  // A URL-only sequence needs no network log.
  const nav: Assertion = { kind: 'sequence', steps: [{ url: { path: '/a' } }, { url: { path: '/b' } }] };
  expect(check(nav, snap(['nav:/a', 'nav:/b'], { network: null })).status).toBe('pass');

  // A candidate whose body could not be read: decided only when every reading agrees.
  const step = { request: { method: 'POST', url: { path: '/api/verify' }, responseBody: { const: 'ok' } } };
  const a: Assertion = { kind: 'sequence', steps: [step, REFILL] };
  const s = snap(['POST /api/verify', 'POST /api/refill']);
  s.network![0] = { ...s.network![0]!, bodyUnavailable: true };
  expect(check(a, s)).toMatchObject({ status: 'abstain', reason: 'value_unavailable' });
  // ...but a definite violation fails whatever the unknown one is.
  const t = snap(['POST /api/refill', 'POST /api/verify', 'POST /api/verify']);
  t.network![1] = { ...t.network![1]!, bodyUnavailable: true };
  t.network![2] = { ...t.network![2]!, responseBody: 'ok' };
  expect(check(a, t).status).toBe('fail');
});

test('sequence with onMissing "abstain": a route not taken abstains, a broken order still fails', () => {
  expect(check(ordered, snap(['GET /']), 'abstain')).toMatchObject({ status: 'abstain', reason: 'route_missing' });
  expect(check(ordered, snap(['POST /api/refill']), 'abstain').status).toBe('fail');
  expect(check(ordered, snap(['POST /api/refill', 'POST /api/verify']), 'abstain').status).toBe('fail');
});

test('validation: placement, repeated steps, loose steps and strict GET steps', () => {
  const report = (a: Assertion) => validateCheckSet(set(a));
  expect(report(ordered)).toEqual({ ok: true, errors: [], warnings: [] });
  expect(report({ kind: 'sequence', steps: [VERIFY] }).ok).toBe(false); // at least two steps
  expect(report({ kind: 'sequence', steps: [VERIFY, VERIFY, REFILL] }).errors).toEqual([
    'check C1: steps 1 and 2 are the same, so their first events are one event and can never be in order',
  ]);
  expect(
    report({ kind: 'each', scope: { role: 'table' }, match: { role: 'row' }, assert: ordered }).errors,
  ).toContainEqual(expect.stringContaining('a sequence assertion inside each does not read the record'));
  expect(report({ kind: 'page', match: { title: 'x' }, assert: ordered }).errors).toContainEqual(
    expect.stringContaining('a sequence assertion inside a page assertion'),
  );
  expect(report({ kind: 'sequence', steps: [{ request: { method: 'POST' } }, REFILL] }).warnings).toEqual([
    'check C1 step 1: has no url, so an unrelated request (an earlier one too) can stand for this step and the order is not tested; give it a url',
  ]);
  expect(
    report({
      kind: 'sequence',
      strict: true,
      steps: [{ request: { method: 'GET', url: { path: '/api/id' } } }, REFILL],
    }).warnings,
  ).toEqual([expect.stringContaining('strict order with a GET step')]);
  expect(
    report({ kind: 'sequence', steps: [{ request: { url: { regex: 'verify' } } }, REFILL] }).warnings,
  ).toContainEqual(expect.stringContaining('check C1 step 1 url: regex /verify/ has no anchors'));
  // onMissing "abstain" applies: a sequence reads route evidence.
  expect(validateCheckSet(set(ordered, 'abstain')).warnings).toEqual([]);
});

test('read-set: the trajectory, and the network log for request steps', () => {
  expect(readKeys(readSetOf(ordered))).toEqual(new Set(['network', 'trajectory']));
  expect(readKeys(readSetOf({ kind: 'sequence', steps: [{ url: { path: '/a' } }, { url: { path: '/b' } }] }))).toEqual(
    new Set(['trajectory']),
  );
  expect(readSetOf(ordered)).toMatchObject({ trajectory: true, requests: [VERIFY.request, REFILL.request] });
});

test('describeAssertion states the order', () => {
  expect(describeAssertion(ordered)).toBe(
    "in this order in the run's trajectory: a request POST, path /api/verify, then a request POST, path /api/refill",
  );
  expect(describeAssertion({ kind: 'sequence', strict: true, steps: [{ url: { path: '/cart' } }, REFILL] })).toBe(
    "in this order in the run's trajectory: a navigation to path /cart, then a request POST, path /api/refill (strict: no step occurs again once the next has begun)",
  );
});

test('stress: reordering is a near miss the check set rejects, interleaved noise and retries are valid', () => {
  const report = stressTest(CHECKS, [{ name: 'verified-first', snapshot: ref('verified-first') }]);
  const ids = report.mutants.map((m) => m.id);
  expect(ids).toEqual(expect.arrayContaining(['C3:sequence:swap', 'C3:sequence:missing[1]', 'C3:sequence:missing[2]']));
  expect(report.mutants.filter((m) => m.check === 'C3' && !m.claim).every((m) => m.rejected)).toBe(true);
  expect(report.variants.map((v) => v.id)).toEqual(
    expect.arrayContaining(['trajectory-noise', 'retry', 'network-noise']),
  );
  expect(report.variants.filter((v) => !v.accepted)).toEqual([]);
  expect(report.weak).toEqual([]);
  expect(report.missed).toEqual([]);
  expect(report.untested).toEqual([]);
});

test('stress: a sequence whose first step also matches an earlier, unrelated request is weak', () => {
  // Step 1 matches any request under /, so the page's own GET stands for the verification.
  const loose = structuredClone(CHECKS);
  loose.checks[2]!.assert = { kind: 'sequence', steps: [{ request: { url: { path: '/**' } } }, REFILL] };
  const report = stressTest(loose, [{ name: 'verified-first', snapshot: ref('verified-first') }]);
  expect(report.weak).toEqual([
    {
      check: 'C3',
      mutants: [expect.objectContaining({ id: 'C3:sequence:late' })],
    },
  ]);
});

test('variants that renumber the network log keep the trajectory pointing at the same requests', () => {
  const s = ref('verified-first');
  const variants = new Map(generateVariants(CHECKS, s).map((v) => [v.id, v.snapshot]));
  const names = (x: EvidenceSnapshot) => {
    const bySeq = new Map(x.network!.map((e) => [e.seq, e]));
    return x.trajectory!.map((e) =>
      e.type === 'request'
        ? `${bySeq.get(e.seq)!.method} ${new URL(bySeq.get(e.seq)!.url).pathname} ${bySeq.get(e.seq)!.status}`
        : `nav ${e.url}`,
    );
  };
  expect(names(variants.get('retry')!).filter((n) => n.startsWith('POST'))).toEqual([
    'POST /api/verify 503',
    'POST /api/verify 200',
    'POST /api/refill 503',
    'POST /api/refill 200',
  ]);
  expect(names(variants.get('network-noise')!).at(-1)).toMatch(/^GET \/analytics\/collect/);
  expect(variants.get('trajectory-noise')!.trajectory).toHaveLength(2 * s.trajectory!.length - 1);
  // Snapshots without a trajectory get none, and no trajectory variant.
  const { trajectory: _t, ...old } = s;
  const plain = generateVariants(CHECKS, old as EvidenceSnapshot);
  expect(plain.some((v) => 'trajectory' in v.snapshot)).toBe(false);
  expect(plain.map((v) => v.id)).not.toContain('trajectory-noise');
  expect(generateMutants(CHECKS, old as EvidenceSnapshot).filter((m) => m.check === 'C3')).toEqual([]);
});

test('the builder writes sequence, and the printer gives it back', () => {
  const cs = checks('Verify the identity before refilling. Then finish.', [
    req('R1', 'verified, then refilled', { quote: 'Verify the identity before refilling' })
      .check(sequence(network.post('/api/verify').status(200), network.post('/api/refill')))
      .check(sequence(url('/review'), network.post('/api/refill'), { url: { path: '/done' } }).strict())
      .check(
        sequence(
          network.request({ method: ['POST', 'PUT'], url: { regex: '^https://rx\\.test/api/verify$' } }),
          REFILL,
        ).strict(false),
      ),
  ]);
  expect(cs.checks.map((c) => c.assert)).toEqual([
    {
      kind: 'sequence',
      steps: [{ request: { method: 'POST', url: { path: '/api/verify' }, status: 200 } }, REFILL],
    },
    { kind: 'sequence', steps: [{ url: { path: '/review' } }, REFILL, { url: { path: '/done' } }], strict: true },
    {
      kind: 'sequence',
      steps: [{ request: { method: ['POST', 'PUT'], url: { regex: '^https://rx\\.test/api/verify$' } } }, REFILL],
      strict: false,
    },
  ]);
  expect(validateCheckSet(cs).ok).toBe(true);
  expect(() => sequence(network.post('/a').count(2), REFILL)).toThrow(/drop \.count\(\)/);
  expect(() => sequence(REFILL)).toThrow('a sequence needs at least two steps, got 1');
  expect(() => sequence()).toThrow('got 0');
  const printed = printCheckSet(cs);
  expect(printed).toContain("sequence(network.post('/api/verify').status(200), network.post('/api/refill'))");
  expect(printed).toContain("sequence(url('/review'), network.post('/api/refill'), url('/done')).strict()");
  expect(printed).toContain('.strict(false)');
  expect(printCheckSet(CHECKS)).toContain('sequence(');
});

test('the compiler offers sequence and the trajectory only for references that have one', () => {
  const r = (snapshot: EvidenceSnapshot) => [{ name: 'r', kind: 'success' as const, snapshot }];
  const { trajectory: _t, ...old } = ref('verified-first');
  expect(discoverySystem(r(old as EvidenceSnapshot))).not.toContain(DISCOVERY_TRAJECTORY);
  expect(discoverySystem(r(ref('verified-first')))).toContain(DISCOVERY_TRAJECTORY);
  expect(JSON.stringify(assertToolSchema(false))).not.toContain('sequence');
  expect(JSON.stringify(assertToolSchema(false, false, true))).toContain('"sequence"');
  expect('sequenceStep' in dslDefinitions(false, false, true)).toBe(true);
  expect(trajectoryView(ref('verified-first'))).toMatch(
    /^\[0\] request #0 GET http:\/\/127\.0\.0\.1:4176\/ → 200 \(document\)\n\[1\] navigation \(page 0\) to http:\/\/127\.0\.0\.1:4176\//,
  );
  expect(trajectoryView(old as EvidenceSnapshot)).toBe('The trajectory was not recorded for this snapshot.');
});

test('the trajectory tool pages past its first 200 events, with absolute indices', () => {
  const base = ref('verified-first');
  const trajectory = Array.from({ length: 450 }, (_, i) => ({
    type: 'navigation' as const,
    url: `http://x/${i}`,
    page: 0,
    t: i,
  }));
  const long = { ...base, trajectory } as EvidenceSnapshot;
  const first = trajectoryView(long);
  expect(first.split('\n')).toHaveLength(201);
  expect(first).toContain('[199] navigation (page 0) to http://x/199');
  expect(first).toMatch(/… 250 more; pass offset 200$/);
  const second = trajectoryView(long, undefined, 200);
  expect(second.split('\n')[0]).toBe('[200] navigation (page 0) to http://x/200');
  expect(second).toMatch(/… 50 more; pass offset 400$/);
  const last = trajectoryView(long, undefined, 400);
  expect(last.split('\n')).toHaveLength(50);
  expect(last.split('\n').at(-1)).toBe('[449] navigation (page 0) to http://x/449');
  expect(trajectoryView(long, undefined, 450)).toBe('No events at offset 450; the trajectory has 450.');
});

test('snapshots without a trajectory load and digest as before; a malformed one does not load', () => {
  const shop = readJson<{ snapshot: EvidenceSnapshot }>(
    new URL('../../examples/tiny-shop/references/02-add-blue-mug/added-blue-mug.json', import.meta.url),
  ).snapshot;
  expect('trajectory' in shop).toBe(false);
  expect(loadSnapshot(structuredClone(shop))).toEqual(shop);
  // The committed sets on such a snapshot: a sequence abstains as unrecorded evidence.
  expect(check(ordered, shop)).toMatchObject({ status: 'abstain', reason: 'evidence_unavailable' });
  // Adding a trajectory is what changes the digest; leaving it out keeps the old one.
  const s = ref('verified-first');
  const { trajectory: _t, ...without } = s;
  expect(snapshotDigest(without)).not.toBe(snapshotDigest(s));
  expect(snapshotDigest({ ...without, trajectory: undefined } as EvidenceSnapshot)).toBe(snapshotDigest(without));
  expect(() => loadSnapshot({ ...s, trajectory: [{ type: 'click', t: 1 }] })).toThrow(
    'snapshot trajectory[0] is not a request or navigation event',
  );
  expect(() => loadSnapshot({ ...s, trajectory: {} })).toThrow('snapshot trajectory is not an array');
});
