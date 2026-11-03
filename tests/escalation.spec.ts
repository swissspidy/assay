/** Milestone 4 acceptance: escalation to the agentic verifier, outcome records, proposals and locking. */
import { expect } from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expectOutcome } from '../src/playwright/index.ts';
import {
  isLocked,
  lockCheckSet,
  reviewSheet,
  unwrapNodes,
  validateCheckSet,
  verifyWithEscalation,
  writeOutcomeRecord,
  type CheckSet,
  type EvidenceSnapshot,
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

const pass = (id: string, evidence: string) => ({
  requirement: id,
  status: 'pass',
  evidence: [evidence],
  reasoning: 'seen',
});

test('abstained requirements escalate to the verifier, which decides from observed evidence', async () => {
  const verifier = scripted([
    (req) => {
      const prompt = req.messages[0]!.role === 'user' ? req.messages[0]!.text! : '';
      expect(prompt).toContain('Why the compiled checks could not decide: C1 abstain (anchor_missing)');
      expect(prompt).toContain('<agent_report>');
      expect(req.tools.map((t) => t.name)).not.toContain('open_page'); // no live access offered
      return call('find_nodes', { text: 'Mug' });
    },
    (req) => {
      expect(lastResults(req)[0]!.content).toContain('Blue Mug');
      return call('submit_verdict', {
        verdicts: [
          pass('R1', 'find_nodes: text "Blue Mug 1 $12.00" in main'),
          pass('R2', 'find_nodes: text "Red Mug 1 $9.50" in main'),
        ],
      });
    },
  ]);
  const res = await verifyWithEscalation(TWO_MUGS, unanchored(), { verifier, agentReport: 'I added both mugs. Done!' });
  expect(res.checksOutcome.verdict).toBe('abstain');
  expect(res.outcome.verdict).toBe('success');
  const rec = res.record;
  expect(rec.schema).toBe('assay.record/v1');
  expect(rec.requirements.map((r) => [r.id, r.status, r.decidedBy])).toEqual([
    ['R1', 'pass', 'verifier'],
    ['R2', 'pass', 'verifier'],
  ]);
  expect(rec.requirements[0]!.evidence).toEqual([
    { origin: 'observed', channel: 'verifier', observation: 'find_nodes: text "Blue Mug 1 $12.00" in main' },
  ]);
  expect(rec.agentClaims).toEqual({ origin: 'agent-claimed', text: 'I added both mugs. Done!' });
  expect(rec.escalation).toMatchObject({
    requirements: ['R1', 'R2'],
    status: 'done',
    model: 'scripted:test',
    turns: 2,
  });
  expect(rec.escalation!.observations.map((o) => o.tool)).toEqual(['find_nodes']);
  expect(rec.checks.map((c) => c.status)).toEqual(['abstain', 'abstain']);
});

test('decided requirements are never escalated; failures escalate only when the policy says so', async () => {
  const partial = ref('03-cart-two-mugs', 'only-blue-mug');
  const never = scripted([]); // throws if called
  const res = await verifyWithEscalation(TWO_MUGS, partial, { verifier: never });
  expect(res.outcome.verdict).toBe('fail');
  expect(res.record.escalation).toBeUndefined();
  expect(res.record.requirements.map((r) => r.decidedBy)).toEqual(['checks', 'checks']);

  const verifier = scripted([
    () =>
      call('submit_verdict', {
        verdicts: [
          {
            requirement: 'R2',
            status: 'fail',
            evidence: ['page_outline: only a Blue Mug row'],
            reasoning: 'no red mug',
          },
        ],
      }),
  ]);
  const res2 = await verifyWithEscalation(TWO_MUGS, partial, { verifier, policy: { on: ['abstain', 'fail'] } });
  expect(res2.record.escalation!.requirements).toEqual(['R2']);
  expect(res2.record.requirements.find((r) => r.id === 'R2')).toMatchObject({ status: 'fail', decidedBy: 'verifier' });
  expect(res2.outcome.verdict).toBe('fail');
});

test('verdicts need cited evidence; "unknown" stays abstain', async () => {
  const verifier = scripted([
    () =>
      call('submit_verdict', {
        verdicts: [
          { requirement: 'R1', status: 'pass', evidence: [], reasoning: 'the agent said so' },
          pass('R2', 'x'),
        ],
      }),
    (req) => {
      expect(lastResults(req)[0]).toMatchObject({
        isError: true,
        content: expect.stringContaining('without cited evidence for R1'),
      });
      return call('submit_verdict', {
        verdicts: [
          { requirement: 'R1', status: 'unknown', evidence: [], reasoning: 'cannot see the cart' },
          pass('R2', 'find_nodes: Red Mug row'),
        ],
      });
    },
  ]);
  const res = await verifyWithEscalation(TWO_MUGS, unanchored(), { verifier });
  expect(res.record.requirements.map((r) => [r.status, r.decidedBy])).toEqual([
    ['abstain', 'none'],
    ['pass', 'verifier'],
  ]);
  expect(res.outcome.verdict).toBe('abstain');
});

test('a rescued run yields a recompiled proposal pending approval; records and snapshots are written', async () => {
  const verifier = scripted([
    () =>
      call('submit_verdict', {
        verdicts: [pass('R1', 'find_nodes: Blue Mug row'), pass('R2', 'find_nodes: Red Mug row')],
      }),
  ]);
  const proposer = scripted([
    () =>
      call('submit_rubric', {
        requirements: [
          {
            id: 'R1',
            kind: 'hard',
            text: 'Blue Mug listed',
            field: 'outcomes',
            quote: 'the cart page lists a Blue Mug',
          },
          { id: 'R2', kind: 'hard', text: 'Red Mug listed', field: 'outcomes', quote: 'the cart page lists a Red Mug' },
        ],
      }),
    () =>
      call('submit_checks', {
        checks: ['Blue Mug', 'Red Mug'].map((p, i) => ({
          id: `C${i + 1}`,
          requirement: `R${i + 1}`,
          description: `The main content shows a ${p}.`,
          assert: { kind: 'contains', scope: { role: 'main' }, match: { role: 'row', name: { contains: p } } },
        })),
      }),
  ]);
  const snapshot = unanchored();
  const res = await verifyWithEscalation(TWO_MUGS, snapshot, { verifier, proposer });
  expect(res.proposal?.version).toBe('1+proposal');
  expect(res.record.proposal).toMatchObject({ status: 'pending-approval', checks: 2 });
  expect(isLocked(res.proposal!)).toBe(false);

  const dir = mkdtempSync(join(tmpdir(), 'assay-records-'));
  const w1 = writeOutcomeRecord(dir, res.record, snapshot, res.proposal as never);
  const w2 = writeOutcomeRecord(dir, { ...res.record, id: 'second' }, snapshot);
  expect(w1.snapshotFile).toBe(w2.snapshotFile); // content-addressed, written once
  expect(readdirSync(join(dir, 'records'))).toHaveLength(2);
  const saved = JSON.parse(readFileSync(w1.recordFile, 'utf8')) as OutcomeRecord;
  expect(saved.snapshot.file).toBe(w1.snapshotFile);
  expect(saved.proposal!.file).toBe(w1.proposalFile);
  expect(JSON.parse(readFileSync(w1.proposalFile!, 'utf8')).checks).toHaveLength(2);
});

test('locking: confirmed sets are tamper-evident, and can be required', async () => {
  const locked = lockCheckSet(TWO_MUGS, 'reviewer@example.com', '2026-11-03T00:00:00.000Z');
  expect(isLocked(locked)).toBe(true);
  expect(validateCheckSet(locked).errors).toEqual([]);
  const edited: CheckSet = { ...locked, checks: locked.checks.slice(0, 1) };
  expect(isLocked(edited)).toBe(false);
  await expect(
    verifyWithEscalation(TWO_MUGS, ref('03-cart-two-mugs', 'both-mugs'), { requireLocked: true }),
  ).rejects.toThrow('not locked');
  const res = await verifyWithEscalation(locked, ref('03-cart-two-mugs', 'both-mugs'), { requireLocked: true });
  expect(res.record.checkSet.locked).toEqual({ by: 'reviewer@example.com', at: '2026-11-03T00:00:00.000Z' });
  const sheet = reviewSheet(locked);
  expect(sheet).toContain('## R1 (hard): "the cart page lists a Blue Mug"');
  expect(sheet).toContain(
    'tests: table named "Cart" (or table in main) contains at least 1 row named containing "Blue Mug"',
  );
  expect(sheet).toContain('Locked by reviewer@example.com');
  expect(reviewSheet(edited)).toContain('BROKEN');
});

test('live: expectOutcome escalates with read-only page access and writes a record', async ({ page }) => {
  await addToCart(page, 'Blue Mug');
  await addToCart(page, 'Red Mug');
  await openCart(page);
  // The table loses its semantics (no name, presentational): both anchors are gone.
  await page.evaluate(() => {
    const t = document.querySelector('table')!;
    t.removeAttribute('aria-label');
    t.setAttribute('role', 'presentation');
  });
  const verifier = scripted([
    (req) => {
      expect(req.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['open_page', 'fetch_json']));
      return call('fetch_json', { url: 'https://evil.example/api/cart' });
    },
    (req) => {
      expect(lastResults(req)[0]).toMatchObject({ isError: true, content: expect.stringContaining('same-origin') });
      return call('fetch_json', { url: '/api/cart' });
    },
    (req) => {
      expect(lastResults(req)[0]!.content).toContain('"name": "Red Mug"');
      return call('submit_verdict', {
        verdicts: [pass('R1', 'fetch_json /api/cart: Blue Mug ×1'), pass('R2', 'fetch_json /api/cart: Red Mug ×1')],
      });
    },
  ]);
  const dir = mkdtempSync(join(tmpdir(), 'assay-live-'));
  const outcome = await expectOutcome(page, TWO_MUGS, { timeout: 0, escalate: { verifier }, recordDir: dir });
  expect(outcome.verdict).toBe('success');
  const [file] = readdirSync(join(dir, 'records'));
  const rec = JSON.parse(readFileSync(join(dir, 'records', file!), 'utf8')) as OutcomeRecord;
  expect(rec.requirements.every((r) => r.decidedBy === 'verifier')).toBe(true);
  // the refused cross-origin call is not an observation
  expect(rec.escalation!.observations.map((o) => o.tool)).toEqual(['fetch_json']);
});
