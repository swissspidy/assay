import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkRubric,
  compileTask,
  parseOutcomes,
  recordingModel,
  replayModel,
  rubricFromClauses,
  runAgent,
  type Check,
  type EvidenceSnapshot,
  type ModelClient,
  type ModelRequest,
  type ModelTurn,
  type Reference,
  type TaskInput,
} from '../../src/index.ts';

const ref = (task: string, name: string): EvidenceSnapshot =>
  JSON.parse(readFileSync(new URL(`../../examples/tiny-shop/references/${task}/${name}.json`, import.meta.url), 'utf8'))
    .snapshot;

/** A fake model that plays a fixed script; each step sees the request (to inspect tool results). */
function scripted(steps: ((req: ModelRequest) => Partial<ModelTurn>)[]): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let i = 0;
  return {
    id: 'scripted:test',
    requests,
    async turn(req) {
      requests.push(structuredClone(req));
      const step = steps[i++];
      if (!step) throw new Error('script exhausted');
      const t = step(req);
      const toolCalls = t.toolCalls ?? [];
      return {
        stop: t.stop ?? (toolCalls.length ? 'tool_use' : 'end_turn'),
        text: t.text ?? '',
        toolCalls,
        raw: t.raw ?? [{ type: 'scripted', n: i }],
        usage: { inputTokens: 10, outputTokens: 5 },
        model: 'scripted:test',
      };
    },
  };
}

const call = (name: string, input: unknown, id = `${name}-${Math.random().toString(36).slice(2, 8)}`) => ({
  toolCalls: [{ id, name, input }],
});
const lastResults = (req: ModelRequest) => {
  const m = req.messages.at(-1)!;
  return m.role === 'user' ? (m.toolResults ?? []) : [];
};

const NEWSLETTER: TaskInput = {
  id: 'tiny-shop/newsletter',
  instruction: 'Subscribe me to the Tiny Shop newsletter.',
  outcomes: 'Then the newsletter subscription is saved\nThen the newsletter checkbox in the preferences is checked',
};

test.describe('outcome parsing', () => {
  test('gherkin: only Then/And/But after Then, positions are exact', () => {
    const text =
      'Given I am logged in\nWhen I subscribe\nThen the subscription is saved\n  And a confirmation is shown.\nWhen I reload\nAnd nothing';
    const c = parseOutcomes(text);
    expect(c.map((x) => x.text)).toEqual(['the subscription is saved', 'a confirmation is shown']);
    for (const x of c) expect(text.slice(x.start, x.end)).toBe(x.text);
  });
  test('markdown list and plain lines', () => {
    expect(parseOutcomes('# Outcomes\n- the cart has a mug\n2. Then the total is $12')).toEqual([
      expect.objectContaining({ text: 'the cart has a mug' }),
      expect.objectContaining({ text: 'the total is $12' }),
    ]);
    expect(parseOutcomes('order placed\n\nemail sent').map((c) => c.text)).toEqual(['order placed', 'email sent']);
  });
});

test.describe('rubric', () => {
  test('deterministic rubric quotes each clause', () => {
    const r = rubricFromClauses(NEWSLETTER);
    expect(r.map((x) => x.source.quote)).toEqual([
      'the newsletter subscription is saved',
      'the newsletter checkbox in the preferences is checked',
    ]);
    expect(checkRubric(NEWSLETTER, r, parseOutcomes(NEWSLETTER.outcomes))).toEqual([]);
  });
  test('rejects paraphrased quotes and uncovered outcomes', () => {
    const errs = checkRubric(
      NEWSLETTER,
      [{ id: 'R1', kind: 'hard', text: 'saved', source: { field: 'outcomes', quote: 'the subscription was stored' } }],
      parseOutcomes(NEWSLETTER.outcomes),
    );
    expect(errs.join('\n')).toContain('not verbatim');
    expect(errs.join('\n')).toContain('has no requirement quoting it');
  });
});

test('agent loop rejects schema-invalid tool input before running the tool', async () => {
  let ran = false;
  const model = scripted([
    () => call('echo', { n: 'not a number' }),
    (req) => ({ text: lastResults(req)[0]!.content }),
  ]);
  const run = await runAgent({
    model,
    system: 's',
    prompt: 'p',
    maxNudges: 0,
    tools: [
      {
        spec: {
          name: 'echo',
          description: '',
          inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
        },
        run: () => {
          ran = true;
          return { content: 'ok' };
        },
      },
    ],
  });
  expect(ran).toBe(false);
  expect(model.requests[1]!.messages.at(-1)).toMatchObject({ toolResults: [{ isError: true }] });
  expect(run.status).toBe('gave_up');
});

const GOOD_CHECKS: Check[] = [
  {
    id: 'C1',
    requirement: 'R1',
    description: 'Settings were saved (PUT /api/settings → 200).',
    assert: { kind: 'request', match: { method: 'PUT', url: { path: '/api/settings' }, status: 200 } },
  },
  {
    id: 'C2',
    requirement: 'R1',
    description: 'The last saved settings have newsletter = true.',
    assert: {
      kind: 'value',
      source: {
        from: 'response',
        match: { method: 'PUT', url: { path: '/api/settings' } },
        pointer: '/newsletter',
        pick: 'last',
      },
      expect: { equals: true },
    },
  },
  {
    id: 'C3',
    requirement: 'R2',
    description: 'The newsletter checkbox is checked.',
    assert: {
      kind: 'state',
      target: { role: 'checkbox', name: { contains: 'newsletter', ignoreCase: true } },
      expect: { checked: true },
    },
  },
];

function newsletterScript() {
  return scripted([
    // rubric
    () =>
      call('submit_rubric', {
        requirements: [
          {
            id: 'R1',
            kind: 'hard',
            text: 'Subscription saved',
            field: 'outcomes',
            quote: 'the newsletter subscription is saved',
          },
          {
            id: 'R2',
            kind: 'hard',
            text: 'Checkbox checked',
            field: 'outcomes',
            quote: 'the newsletter checkbox in the preferences is checked',
          },
        ],
      }),
    // discovery: explore, try a wrong submission, then fix it
    () => call('page_outline', {}),
    (req) => {
      expect(lastResults(req)[0]!.content).toContain('checkbox "Email me the newsletter" [checked]');
      return call('network_log', { method: 'PUT' });
    },
    () =>
      call('submit_checks', {
        checks: [
          GOOD_CHECKS[0],
          GOOD_CHECKS[1],
          {
            ...GOOD_CHECKS[2],
            assert: { ...GOOD_CHECKS[2]!.assert, target: { role: 'checkbox', name: 'Newsletter' } },
          },
        ],
      }),
    (req) => {
      const r = lastResults(req)[0]!;
      expect(r.isError).toBe(true);
      expect(r.content).toContain('C3 abstains (anchor_missing)');
      return call('submit_checks', { checks: GOOD_CHECKS });
    },
  ]);
}

test('compileTask: rubric, exploration, repair until the checks pass on the references', async () => {
  const refs: Reference[] = [
    { name: 'subscribed', kind: 'success', snapshot: ref('01-newsletter', 'subscribed') },
    { name: 'never-subscribed', kind: 'negative', snapshot: ref('01-newsletter', 'never-subscribed') },
  ];
  const model = newsletterScript();
  const { checkSet, report } = await compileTask(NEWSLETTER, refs, { model });
  expect(report.status).toBe('compiled');
  expect(checkSet!.checks.map((c) => c.id)).toEqual(['C1', 'C2', 'C3']);
  expect(report.turns).toEqual({ rubric: 1, discovery: 4 });
  expect(report.references).toEqual([
    { name: 'subscribed', kind: 'success', verdict: 'success' },
    { name: 'never-subscribed', kind: 'negative', verdict: 'fail' },
  ]);
  expect(report.coverage).toEqual([
    {
      requirement: 'R1',
      quote: 'the newsletter subscription is saved',
      checks: ['C1', 'C2'],
      channels: ['network'],
      strongestTrust: 'structured',
    },
    {
      requirement: 'R2',
      quote: 'the newsletter checkbox in the preferences is checked',
      checks: ['C3'],
      channels: ['a11y'],
      strongestTrust: 'semantic',
    },
  ]);
  // the trajectory is never part of the prompt unless given
  expect(JSON.stringify(model.requests[1]!.messages[0])).not.toContain('<trajectory>');
});

test('compileTask rejects a check set that still succeeds on an incorrect run', async () => {
  const lax: Check[] = [
    {
      id: 'C1',
      requirement: 'R1',
      description: 'any settings page',
      assert: { kind: 'url', match: { path: '/settings' } },
    },
  ];
  const model = scripted([
    () => call('submit_checks', { checks: lax }),
    (req) => {
      expect(lastResults(req)[0]!.content).toContain('still reports success');
      return { text: 'I give up.' };
    },
    () => ({ text: 'Still giving up.' }),
  ]);
  const { checkSet, report } = await compileTask(
    { id: 't', instruction: 'Subscribe me to the newsletter.' },
    [
      { name: 'ok', kind: 'success', snapshot: ref('01-newsletter', 'subscribed') },
      { name: 'bad', kind: 'negative', snapshot: ref('01-newsletter', 'never-subscribed') },
    ],
    { model, rubric: 'deterministic', maxTurns: 3 },
  );
  expect(checkSet).toBeUndefined();
  expect(report.status).toBe('failed');
});

test('cassettes: a recorded compile replays identically without a model; changed inputs are detected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assay-cassette-'));
  const path = join(dir, 'newsletter.json');
  const refs: Reference[] = [{ name: 'subscribed', kind: 'success', snapshot: ref('01-newsletter', 'subscribed') }];
  const rec = recordingModel(newsletterScript(), path);
  const first = await compileTask(NEWSLETTER, refs, { model: rec });
  rec.save();
  const second = await compileTask(NEWSLETTER, refs, { model: replayModel(path) });
  expect(second.checkSet).toEqual(first.checkSet);
  await expect(
    compileTask({ ...NEWSLETTER, instruction: 'Subscribe me to the newsletter, please.' }, refs, {
      model: replayModel(path),
    }),
  ).rejects.toThrow('no recording for this request');
});
