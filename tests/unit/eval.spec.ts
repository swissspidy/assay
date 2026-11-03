/** Milestone 5: metrics, cost accounting and the LLM-judge baseline (with a scripted model). */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { costUsd, llmJudge, metrics, PRICING, type EvidenceSnapshot, type Prediction } from '../../src/index.ts';
import { call, scripted } from '../support/scripted.ts';
import { decodeBody } from '../../src/snapshot/capture.ts';

const p = (expected: Prediction['expected'], verdict: Prediction['verdict'], ms = 1, usd = 0): Prediction => ({
  expected,
  verdict,
  ms,
  costUsd: usd,
});

test('metrics: abstain counts as not-success; decided rates exclude abstains', () => {
  const m = metrics([
    p('success', 'success', 1, 0.01),
    p('success', 'abstain', 2, 0.01),
    p('success', 'fail', 3, 0.01),
    p('fail', 'fail', 4, 0.01),
    p('fail', 'abstain', 5, 0.01),
    p('fail', 'success', 6, 0.01),
  ]);
  expect(m).toMatchObject({ n: 6, positives: 3, negatives: 3, abstainRate: 2 / 6 });
  expect(m.tpr).toBeCloseTo(1 / 3);
  expect(m.tnr).toBeCloseTo(2 / 3);
  expect(m.balancedAccuracy).toBeCloseTo(0.5);
  expect(m.decidedTpr).toBeCloseTo(1 / 2);
  expect(m.decidedTnr).toBeCloseTo(1 / 2);
  expect(m.costUsdPerRun).toBeCloseTo(0.01);
  expect(m.msPerRunMedian).toBe(3.5); // even count: mean of the two middle values
  expect(m.msPerRunP95).toBe(6);
});

test('metrics: latency quantiles ignore unmeasured (NaN) runs and say how many were timed', () => {
  const m = metrics([
    p('success', 'success', NaN),
    p('success', 'success', 5000),
    p('fail', 'fail', 6000),
    p('fail', 'fail', 0.1),
    p('fail', 'fail', NaN),
  ]);
  expect(m.msPerRunMedian).toBe(5000);
  expect(m.msPerRunP95).toBe(6000);
  expect(m.msMeasured).toBe(3);
});

test('metrics: empty classes give NaN, not a misleading 0 or 1', () => {
  const m = metrics([p('success', 'success')]);
  expect(m.tpr).toBe(1);
  expect(m.tnr).toBeNaN();
  expect(metrics([]).msPerRunMedian).toBeNaN();
});

test('costUsd: cache reads and writes are priced separately from fresh input', () => {
  const price = PRICING['claude-opus-5-5']!;
  // 1M input of which 600k cache reads and 100k cache writes; 100k output.
  const usd = costUsd({ inputTokens: 1e6, outputTokens: 1e5, cacheReadTokens: 6e5, cacheWriteTokens: 1e5 }, price);
  expect(usd).toBeCloseTo(0.3 * price.input + 0.6 * price.cacheRead + 0.1 * price.cacheWrite + 0.1 * price.output);
  expect(costUsd({ inputTokens: 1, outputTokens: 1 }, undefined)).toBeNaN();
});

const ref = JSON.parse(
  readFileSync(new URL('../../examples/tiny-shop/references/01-newsletter/subscribed.json', import.meta.url), 'utf8'),
) as { snapshot: EvidenceSnapshot };

test('llmJudge: returns the submitted verdict and shows the judge the page and the agent report', async () => {
  const model = scripted([() => call('submit_judgment', { verdict: 'success', reasoning: 'The box is checked.' })]);
  const r = await llmJudge(model, {
    task: { instruction: 'Subscribe to the newsletter.', outcomes: 'Then the newsletter is on' },
    snapshot: ref.snapshot,
    agentReport: 'Done!',
  });
  expect(r).toMatchObject({ verdict: 'success', reasoning: 'The box is checked.', status: 'done' });
  const prompt = JSON.stringify(model.requests[0]!.messages[0]);
  expect(prompt).toContain('Subscribe to the newsletter.');
  expect(prompt).toContain('Then the newsletter is on');
  expect(prompt).toContain('The agent reported: Done!');
  expect(prompt).toContain(ref.snapshot.page.url);
  expect(prompt).toContain('Accessibility tree:');
  expect(prompt).toContain('Visible text:');
  expect(prompt).toContain(JSON.stringify(ref.snapshot.text.split('\n')[0]!).slice(1, -1));
  expect(r.usage.inputTokens).toBe(10);
});

test('llmJudge: no judgment → abstain, never success', async () => {
  const model = scripted(Array.from({ length: 5 }, () => () => ({ text: 'I think it worked.' })));
  const r = await llmJudge(model, { task: { instruction: 'x' }, snapshot: ref.snapshot });
  expect(r.verdict).toBe('abstain');
  expect(r.reasoning).toMatch(/no judgment/);
  // A failing model call is recorded as abstain, not thrown away or counted as success.
  const broken = await llmJudge(scripted([]), { task: { instruction: 'x' }, snapshot: ref.snapshot });
  expect(broken).toMatchObject({ verdict: 'abstain', status: 'error' });
});

test('llmJudge: an invalid verdict is rejected by schema validation and the model can retry', async () => {
  const model = scripted([
    () => call('submit_judgment', { verdict: 'maybe', reasoning: '?' }),
    () => call('submit_judgment', { verdict: 'fail', reasoning: 'Not saved.' }),
  ]);
  const r = await llmJudge(model, { task: { instruction: 'x' }, snapshot: ref.snapshot });
  expect(r.verdict).toBe('fail');
  expect(model.requests).toHaveLength(2);
});

test('form bodies: field names that are Object.prototype members stay plain fields', () => {
  const { body } = decodeBody(
    'constructor=x&__proto__=y&toString=a&toString=b',
    'application/x-www-form-urlencoded',
    1e6,
  );
  const plain = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  expect(Object.keys(plain).toSorted()).toEqual(['__proto__', 'constructor', 'toString']);
  expect(Object.getOwnPropertyDescriptor(plain, '__proto__')?.value).toBe('y');
  expect(plain.constructor).toBe('x');
  expect(plain.toString).toEqual(['a', 'b']);
});
