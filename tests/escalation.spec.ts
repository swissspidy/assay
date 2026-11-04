/** Milestone 4 acceptance: escalation to the agentic verifier, outcome records, proposals and locking. */
import { expect } from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expectOutcome } from '../src/playwright/index.ts';
import {
  captureSnapshot,
  isLocked,
  lockCheckSet,
  reviewSheet,
  runVerifier,
  sameOrigin,
  unwrapNodes,
  validateCheckSet,
  verifyWithEscalation,
  writeOutcomeRecord,
  type EvidenceSnapshot,
  type ModelClient,
  type OutcomeRecord,
} from '../src/index.ts';
import { call, lastResults, scripted } from './support/scripted.ts';
import { addToCart, loadChecks, openCart } from './helpers.ts';

const ref = (task: string, name: string): EvidenceSnapshot =>
  JSON.parse(readFileSync(new URL(`../examples/tiny-shop/references/${task}/${name}.json`, import.meta.url), 'utf8'))
    .snapshot;

const TWO_MUGS = loadChecks('03-cart-two-mugs');
/** A correct run whose cart table lost its semantics: the checks abstain. */
const unanchored = () => unwrapNodes(ref('03-cart-two-mugs', 'both-mugs'), { role: 'table' });

const verdict = (requirement: string, status: 'pass' | 'fail' | 'unknown', cites: number[] = []) => ({
  requirement,
  status,
  cites,
  reasoning: 'see cited observations',
});

test('abstained requirements escalate; the verifier decides from cited observations only', async () => {
  const verifier = scripted([
    (req) => {
      const prompt = req.messages[0]!.role === 'user' ? req.messages[0]!.text! : '';
      expect(prompt).toContain('Why the compiled checks could not decide: C1 abstain (anchor_missing)');
      expect(prompt).toContain('<agent_report>');
      expect(req.tools.map((t) => t.name)).not.toContain('open_page'); // no live access offered
      return call('find_nodes', { text: 'Mug' });
    },
    (req) => {
      expect(lastResults(req)[0]!.content).toMatch(/^\[observation 1\][\s\S]*Blue Mug/);
      return call('submit_verdict', { verdicts: [verdict('R1', 'pass', [1]), verdict('R2', 'pass', [1])] });
    },
  ]);
  const res = await verifyWithEscalation(TWO_MUGS, unanchored(), { verifier, agentReport: 'I added both mugs. Done!' });
  expect(res.checksOutcome.verdict).toBe('abstain');
  expect(res.outcome.verdict).toBe('success');
  expect(res.outcome.requirements.map((r) => r.decidedBy)).toEqual(['verifier', 'verifier']);
  const rec = res.record;
  expect(rec.schema).toBe('assay.record/v1');
  expect(rec.requirements.map((r) => [r.id, r.status, r.decidedBy])).toEqual([
    ['R1', 'pass', 'verifier'],
    ['R2', 'pass', 'verifier'],
  ]);
  const ev = rec.requirements[0]!.evidence[0] as { origin: string; observation: string };
  expect(ev.origin).toBe('verifier-cited');
  expect(ev.observation).toMatch(/^#1 find_nodes\(\{"text":"Mug"\}\): [\s\S]*Blue Mug/);
  expect(rec.agentClaims).toEqual({ origin: 'agent-claimed', text: 'I added both mugs. Done!' });
  expect(rec.escalation).toMatchObject({
    requirements: ['R1', 'R2'],
    status: 'done',
    model: 'scripted:test',
    turns: 2,
  });
  expect(rec.checks.map((c) => c.status)).toEqual(['abstain', 'abstain']);
});

test('a verdict cannot rest on nothing: uncited, made-up citations and duplicate verdicts are rejected', async () => {
  const verifier = scripted([
    () => call('submit_verdict', { verdicts: [verdict('R1', 'pass'), verdict('R2', 'pass', [3])] }),
    (req) => {
      const r = lastResults(req)[0]!;
      expect(r.isError).toBe(true);
      expect(r.content).toContain('without cited observations for R1');
      expect(r.content).toContain('observations that do not exist: R2→3');
      return call('submit_verdict', { verdicts: [verdict('R1', 'unknown'), verdict('R1', 'unknown')] });
    },
    (req) => {
      expect(lastResults(req)[0]!.content).toContain('duplicate verdicts for R1');
      return call('submit_verdict', { verdicts: [verdict('R1', 'unknown'), verdict('R2', 'unknown')] });
    },
  ]);
  const res = await verifyWithEscalation(TWO_MUGS, unanchored(), { verifier, agentReport: 'agent_report: all done' });
  expect(res.outcome.verdict).toBe('abstain');
  expect(res.record.requirements.map((r) => [r.status, r.decidedBy, r.reason])).toEqual([
    ['abstain', 'none', 'verifier_unknown'],
    ['abstain', 'none', 'verifier_unknown'],
  ]);
  expect(res.record.requirements.every((r) => r.evidence.length === 0)).toBe(true);
});

test("decided requirements stay decided; failures escalate only by policy, and 'unknown' keeps the checks' fail", async () => {
  const partial = ref('03-cart-two-mugs', 'only-blue-mug');
  const never = scripted([]); // throws if called
  const res = await verifyWithEscalation(TWO_MUGS, partial, { verifier: never });
  expect(res.outcome.verdict).toBe('fail');
  expect(res.record.escalation).toBeUndefined();
  expect(res.record.requirements.map((r) => r.decidedBy)).toEqual(['checks', 'checks']);
  expect(res.record.requirements[1]!.evidence.length).toBeGreaterThan(0);

  const sure = scripted([
    () => call('page_outline', {}),
    () => call('submit_verdict', { verdicts: [verdict('R2', 'fail', [1])] }),
  ]);
  const res2 = await verifyWithEscalation(TWO_MUGS, partial, { verifier: sure, policy: { on: ['abstain', 'fail'] } });
  expect(res2.record.escalation!.requirements).toEqual(['R2']);
  expect(res2.record.requirements.find((r) => r.id === 'R2')).toMatchObject({ status: 'fail', decidedBy: 'verifier' });

  const unsure = scripted([() => call('submit_verdict', { verdicts: [verdict('R2', 'unknown')] })]);
  const res3 = await verifyWithEscalation(TWO_MUGS, partial, { verifier: unsure, policy: { on: ['fail'] } });
  expect(res3.outcome.verdict).toBe('fail');
  expect(res3.record.requirements.find((r) => r.id === 'R2')).toMatchObject({ status: 'fail', decidedBy: 'checks' });
});

test('a check can ask for its failures to escalate ("onFail") or to be kept, overriding policy.on', async () => {
  const partial = ref('03-cart-two-mugs', 'only-blue-mug'); // R2 (Red Mug in the cart) fails on C2
  const withOnFail = (onFail: 'escalate' | 'keep', extra?: 'escalate' | 'keep' | 'unset') => {
    const c2 = TWO_MUGS.checks.find((c) => c.id === 'C2')!;
    const checks = TWO_MUGS.checks.map((c) => (c.id === 'C2' ? { ...c, onFail } : c));
    // A second check that fails R2 too, with its own setting (or none).
    if (extra) checks.push({ ...c2, id: 'C3', ...(extra === 'unset' ? {} : { onFail: extra }) });
    return { ...TWO_MUGS, checks };
  };
  const decides = () =>
    scripted([
      () => call('page_outline', {}),
      () => call('submit_verdict', { verdicts: [verdict('R2', 'fail', [1])] }),
    ]);

  // The default policy keeps failures; C2 asks to escalate them.
  const res = await verifyWithEscalation(withOnFail('escalate'), partial, { verifier: decides() });
  expect(res.record.escalation!.requirements).toEqual(['R2']);
  expect(res.record.requirements.find((r) => r.id === 'R2')).toMatchObject({
    decidedBy: 'verifier',
    escalation: 'onFail',
  });
  expect(res.record.checks.find((c) => c.id === 'C2')!.onFail).toBe('escalate');

  // Every check that failed the requirement must allow it: one without a setting follows the policy (keep).
  const never = scripted([]);
  const mixed = await verifyWithEscalation(withOnFail('escalate', 'unset'), partial, { verifier: never });
  expect(mixed.record.escalation).toBeUndefined();
  expect(mixed.record.requirements.find((r) => r.id === 'R2')!.escalation).toBeUndefined();

  // The policy escalates failures; C2 keeps its own.
  const kept = await verifyWithEscalation(withOnFail('keep'), partial, {
    verifier: never,
    policy: { on: ['abstain', 'fail'] },
  });
  expect(kept.record.escalation).toBeUndefined();
  expect(kept.record.requirements.find((r) => r.id === 'R2')).toMatchObject({
    status: 'fail',
    decidedBy: 'checks',
    escalation: 'kept',
  });

  // ...and with the policy, a failure all of whose checks allow it escalates "by policy".
  const both = await verifyWithEscalation(withOnFail('escalate', 'unset'), partial, {
    verifier: decides(),
    policy: { on: ['abstain', 'fail'] },
  });
  expect(both.record.requirements.find((r) => r.id === 'R2')!.escalation).toBe('policy');

  // onFail does not touch abstains, and needs no verifier to be valid.
  expect(validateCheckSet(withOnFail('escalate')).ok).toBe(true);
  expect(validateCheckSet({ ...TWO_MUGS, checks: [{ ...TWO_MUGS.checks[0]!, onFail: 'always' }] }).ok).toBe(false);
  expect(reviewSheet(withOnFail('escalate'))).toContain('on fail: escalate to the verifier');
});

test("a model error keeps the checks' outcome and is recorded", async () => {
  const broken: ModelClient = {
    id: 'broken',
    turn: async () => {
      throw new Error('529 overloaded');
    },
  };
  const res = await verifyWithEscalation(TWO_MUGS, unanchored(), { verifier: broken, proposer: broken });
  expect(res.outcome.verdict).toBe('abstain');
  expect(res.record.escalation).toMatchObject({ status: 'error', error: '529 overloaded' });
  expect(res.record.proposal).toBeUndefined(); // nothing was rescued
});

test('a rescued run yields a proposal that keeps the confirmed requirements; records are written content-addressed', async () => {
  const verifier = scripted([
    () => call('find_nodes', { text: 'Mug' }),
    () => call('submit_verdict', { verdicts: [verdict('R1', 'pass', [1]), verdict('R2', 'pass', [1])] }),
  ]);
  const proposer = scripted([
    (req) => {
      // No rubric step: the confirmed requirements are reused.
      expect(req.tools.map((t) => t.name)).toContain('submit_checks');
      return call('submit_checks', {
        checks: ['Blue Mug', 'Red Mug'].map((p, i) => ({
          id: `C${i + 1}`,
          requirement: `R${i + 1}`,
          description: `The main content shows a ${p}.`,
          assert: { kind: 'contains', scope: { role: 'main' }, match: { role: 'row', name: { contains: p } } },
        })),
      });
    },
  ]);
  const snapshot = unanchored();
  const res = await verifyWithEscalation(TWO_MUGS, snapshot, { verifier, proposer });
  expect(res.proposal?.version).toMatch(/^1\+proposal\.[0-9a-f]{8}$/);
  expect(res.proposal?.requirements).toEqual(TWO_MUGS.requirements);
  expect(res.record.proposal).toMatchObject({ status: 'pending-approval', checks: 2, version: res.proposal!.version });
  expect(isLocked(res.proposal!)).toBe(false);

  const dir = mkdtempSync(join(tmpdir(), 'assay-records-'));
  const w1 = writeOutcomeRecord(dir, res.record, snapshot, TWO_MUGS, res.proposal);
  const w2 = writeOutcomeRecord(dir, { ...res.record, id: 'second' }, snapshot, TWO_MUGS);
  expect(w1.snapshotFile).toBe(w2.snapshotFile); // content-addressed, written once
  expect(readdirSync(join(dir, 'records'))).toHaveLength(2);
  const saved = JSON.parse(readFileSync(w1.recordFile, 'utf8')) as OutcomeRecord;
  expect(saved.snapshot.file).toBe(w1.snapshotFile);
  expect(saved.checkSet.file).toBe(w1.checkSetFile);
  expect(JSON.parse(readFileSync(w1.checkSetFile, 'utf8')).id).toBe(TWO_MUGS.id);
  const obs = saved.escalation!.observations[0]! as { outputDigest: string; file: string };
  expect(readFileSync(obs.file, 'utf8')).toContain('Blue Mug'); // the full output is kept for audit
  expect(saved.proposal?.status === 'pending-approval' && saved.proposal.file).toBe(w1.proposalFile);
  // the writer recomputes digests instead of trusting the record
  expect(() => writeOutcomeRecord(dir, res.record, ref('03-cart-two-mugs', 'both-mugs'), TWO_MUGS)).toThrow(
    'does not match',
  );
});

test('no proposal when the verifier only decided a failure-escalated requirement', async () => {
  const proposer = scripted([]); // throws if called
  const sure = scripted([
    () => call('page_outline', {}),
    () => call('submit_verdict', { verdicts: [verdict('R2', 'pass', [1])] }),
  ]);
  const res = await verifyWithEscalation(TWO_MUGS, ref('03-cart-two-mugs', 'only-blue-mug'), {
    verifier: sure,
    proposer,
    policy: { on: ['fail'] },
  });
  expect(res.outcome.verdict).toBe('success');
  expect(res.record.proposal).toBeUndefined();
});

test('locking covers content, author and time; it can be required', async () => {
  const locked = lockCheckSet(TWO_MUGS, 'reviewer@example.com', '2026-11-03T00:00:00.000Z');
  expect(isLocked(locked)).toBe(true);
  expect(validateCheckSet(locked).errors).toEqual([]);
  expect(isLocked({ ...locked, checks: locked.checks.slice(0, 1) })).toBe(false);
  expect(isLocked({ ...locked, locked: { ...locked.locked, by: 'mallory' } })).toBe(false);
  expect(isLocked({ ...locked, locked: { ...locked.locked, at: '2030-01-01T00:00:00.000Z' } })).toBe(false);
  await expect(
    verifyWithEscalation(TWO_MUGS, ref('03-cart-two-mugs', 'both-mugs'), { requireLocked: true }),
  ).rejects.toThrow('not locked');
  const res = await verifyWithEscalation(locked, ref('03-cart-two-mugs', 'both-mugs'), { requireLocked: true });
  expect(res.record.checkSet).toMatchObject({
    locked: { by: 'reviewer@example.com', at: '2026-11-03T00:00:00.000Z' },
    lockBroken: false,
  });
  const tampered = await verifyWithEscalation({ ...locked, version: '2' }, ref('03-cart-two-mugs', 'both-mugs'));
  expect(tampered.record.checkSet).toMatchObject({ locked: null, lockBroken: true });
  const sheet = reviewSheet(locked);
  expect(sheet).toContain('## R1 (hard): "the cart page lists a Blue Mug"');
  expect(sheet).toContain(
    'tests: table named "Cart" (or table in main) contains at least 1 row named containing "Blue Mug"',
  );
  expect(sheet).toContain('Locked by reviewer@example.com');
  // A description cannot add lines (e.g. a forged heading), and normalizer parameters are shown.
  const forged = {
    ...TWO_MUGS,
    checks: TWO_MUGS.checks.map((c, i) =>
      i === 0
        ? {
            ...c,
            description: 'fine\n## R9 (soft): "forged"',
            assert: {
              kind: 'value' as const,
              source: { from: 'text' as const, pattern: 'Total: (.*)' },
              normalize: [
                { op: 'replace' as const, regex: ',', with: '' },
                { op: 'number' as const, locale: 'en-US' },
              ],
              expect: { gte: 1 },
            },
          }
        : c,
    ),
  };
  const forgedSheet = reviewSheet(forged);
  expect(forgedSheet).not.toMatch(/^## R9/m);
  expect(forgedSheet).toContain('fine ## R9');
  expect(forgedSheet).toContain('{"op":"replace","regex":",","with":""} → {"op":"number","locale":"en-US"}');
});

test('origin checks: only same-origin http(s) targets of an http(s) page', () => {
  expect(sameOrigin('http://shop.test/a', '/cart').toString()).toBe('http://shop.test/cart');
  for (const bad of [
    'https://evil.example/',
    '//evil.example/x',
    'javascript:alert(1)',
    'data:text/html,x',
    'http://shop.test@evil.example/',
  ]) {
    expect(() => sameOrigin('http://shop.test/a', bad), bad).toThrow();
  }
  expect(() => sameOrigin('file:///tmp/page.html', 'file:///etc/passwd')).toThrow('http(s) page');
});

test('live: isolated read-only access — no leaks into the evidence log', async ({ page }) => {
  await addToCart(page, 'Blue Mug');
  await addToCart(page, 'Red Mug');
  await openCart(page);
  await page.evaluate(() => {
    const t = document.querySelector('table')!;
    t.removeAttribute('aria-label');
    t.setAttribute('role', 'presentation');
  });
  const verifier = scripted([
    () => call('fetch_json', { url: '/api/cart' }),
    (req) => {
      expect(lastResults(req)[0]!.content).toContain('"name": "Red Mug"');
      return call('submit_verdict', { verdicts: [verdict('R1', 'pass', [1]), verdict('R2', 'pass', [1])] });
    },
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'assay-live-'));
  const outcome = await expectOutcome(page, TWO_MUGS, { timeout: 0, escalate: { verifier }, recordDir: dir });
  expect(outcome.verdict).toBe('success');
  // The verifier's browsing ran in its own context: none of it is in the run's evidence.
  const after = await captureSnapshot(page);
  expect(after.network!.some((e) => e.url.endsWith('/api/cart') && e.resourceType !== 'fetch')).toBe(false);
});

test('live: redirects off-origin are not followed; sessionStorage reaches the live context', async ({ page }) => {
  // A second origin the verifier must never reach.
  let reached = false;
  const other = createServer((_, res) => {
    reached = true;
    res.end('{"secret":"internal"}');
  });
  await new Promise<void>((r) => other.listen(0, r));
  const otherPort = (other.address() as { port: number }).port;
  const app = createServer((req, res) => {
    if (req.url === '/redir') {
      res.writeHead(302, { location: `http://localhost:${otherPort}/` });
      return res.end();
    }
    res.setHeader('content-type', 'text/html');
    if (req.url === '/whoami')
      return res.end(
        `<main><p id="u"></p></main><script>u.textContent = 'user ' + sessionStorage.getItem('token')</script>`,
      );
    res.end(`<main><h1>Home</h1></main><script>sessionStorage.setItem('token', 'alice')</script>`);
  });
  await new Promise<void>((r) => app.listen(0, r));
  const appPort = (app.address() as { port: number }).port;
  try {
    await page.goto(`http://localhost:${appPort}/`);
    const snapshot = await captureSnapshot(page);
    const requirement = {
      id: 'R1',
      kind: 'hard' as const,
      text: 'signed in',
      source: { field: 'instruction' as const, quote: 'x' },
    };
    const verifier = scripted([
      () => call('fetch_json', { url: '/redir' }),
      (req) => {
        const out = lastResults(req)[0]!.content;
        expect(out).toContain('HTTP 302 redirect');
        expect(out).toContain('(not followed)');
        expect(out).not.toContain('secret');
        return call('open_page', { url: '/whoami' });
      },
      (req) => {
        expect(lastResults(req)[0]!.content).toContain('user alice');
        return call('submit_verdict', { verdicts: [verdict('R1', 'pass', [2])] });
      },
    ]);
    const r = await runVerifier(verifier, {
      task: { instruction: 'x' },
      requirements: [requirement],
      snapshot,
      page,
    });
    expect(r.verdicts.map((v) => v.status)).toEqual(['pass']);
    expect(reached).toBe(false);
  } finally {
    other.close();
    app.close();
  }
});

test('expectOutcome: requireLocked is checked before polling; an expected fail is not escalated', async ({ page }) => {
  await openCart(page);
  await expect(expectOutcome(page, TWO_MUGS, { requireLocked: true, timeout: 0 })).rejects.toThrow('not locked');
  const never = scripted([]);
  const outcome = await expectOutcome(page, TWO_MUGS, { verdict: 'fail', timeout: 0, escalate: { verifier: never } });
  expect(outcome.verdict).toBe('fail');
});
