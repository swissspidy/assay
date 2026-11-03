import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicError } from '@anthropic-ai/sdk';
import {
  anthropicModel,
  canonical,
  checkRubric,
  compileTask,
  coversClause,
  coverage,
  parseOutcomes,
  parseOutcomesDetailed,
  validateCheckSet,
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
    expect(errs.join('\n')).toContain('not fully quoted');
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
      trust: 'structured',
    },
    {
      requirement: 'R2',
      quote: 'the newsletter checkbox in the preferences is checked',
      checks: ['C3'],
      channels: ['a11y'],
      trust: 'semantic',
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

// ---------------------------------------------------------------------------
// Review fixes
// ---------------------------------------------------------------------------

test.describe('outcome parsing edge cases', () => {
  test('a single Then line does not switch plain text to Gherkin', () => {
    expect(parseOutcomes('The cart shows 2 items\nThen the total updates').map((c) => c.text)).toEqual([
      'The cart shows 2 items',
      'the total updates',
    ]);
  });
  test('Gherkin: * steps, Scenario resets, continuation lines, ignored lines reported', () => {
    const text =
      'Scenario: a\n  When I pay\n  Then the order is placed\n    with a confirmation number\n  * a receipt is shown\nScenario: b\n  And this is not an outcome';
    const p = parseOutcomesDetailed(text);
    expect(p.clauses.map((c) => c.text)).toEqual([
      'the order is placed with a confirmation number',
      'a receipt is shown',
    ]);
    for (const c of p.clauses) expect(canonical(text.slice(c.start, c.end))).toBe(c.text);
    expect(p.ignored).toEqual(['Scenario: a', 'When I pay', 'Scenario: b', 'And this is not an outcome']);
  });
  test('Markdown checkboxes, bold Then and header lines', () => {
    const p = parseOutcomesDetailed(
      'Expected outcomes:\n- [ ] **Then** the mug is in the cart\n- [x] Then: the total is $12',
    );
    expect(p.clauses.map((c) => c.text)).toEqual(['the mug is in the cart', 'the total is $12']);
    expect(p.ignored).toEqual(['Expected outcomes:']);
  });
});

test.describe('rubric hardening', () => {
  const clauses = parseOutcomes(NEWSLETTER.outcomes);
  const req = (quote: string, kind: 'hard' | 'soft' = 'hard', text = 'x') => ({
    id: 'R1',
    kind,
    text,
    source: { field: 'outcomes' as const, quote },
  });
  test('empty or blank quotes and texts are rejected', () => {
    expect(checkRubric(NEWSLETTER, [req('')], clauses).join()).toContain('quote is empty');
    expect(checkRubric(NEWSLETTER, [req('   ')], clauses).join()).toContain('quote is empty');
    expect(
      checkRubric(NEWSLETTER, [req('the newsletter subscription is saved', 'hard', ' ')], clauses).join(),
    ).toContain('text is empty');
  });
  test('a stray word does not cover clauses; one quote cannot merge two outcomes', () => {
    expect(coversClause('the', 'the newsletter subscription is saved')).toBe(false);
    expect(coversClause('the newsletter subscription is saved', 'the newsletter subscription is saved')).toBe(true);
    // a partial quote that drops the decisive word does not cover the clause
    expect(coversClause('the order ships', 'the order ships express')).toBe(false);
    const merged = checkRubric(
      NEWSLETTER,
      [req('the newsletter subscription is saved\nThen the newsletter checkbox in the preferences is checked')],
      clauses,
    );
    expect(merged.join()).toContain('spans 2 expected outcomes');
  });
  test('an expected outcome cannot be soft unless it says it is optional', () => {
    const errs = checkRubric(
      NEWSLETTER,
      [
        req('the newsletter subscription is saved'),
        { ...req('the newsletter checkbox in the preferences is checked', 'soft'), id: 'R2' },
      ],
      clauses,
    );
    expect(errs.join()).toContain('must be hard');
    const optional = {
      id: 'o',
      instruction: 'Order it.',
      outcomes: 'Then the order is placed\nThen ideally a receipt is shown',
    };
    expect(
      checkRubric(
        optional,
        [
          { id: 'R1', kind: 'hard', text: 'x', source: { field: 'outcomes', quote: 'the order is placed' } },
          { id: 'R2', kind: 'soft', text: 'y', source: { field: 'outcomes', quote: 'ideally a receipt is shown' } },
        ],
        parseOutcomes(optional.outcomes),
      ),
    ).toEqual([]);
  });
  test('the validator also rejects blank quotes', () => {
    const cs = {
      schema: 'assay.checks/v1',
      id: 'x',
      version: '1',
      task: { instruction: 'Do it.' },
      requirements: [{ id: 'R1', kind: 'hard', text: 't', source: { field: 'instruction', quote: '   ' } }],
      checks: [],
    };
    expect(validateCheckSet(cs).errors.join()).toContain('quote is blank');
  });
});

test('trust: anyOf is as weak as its weakest branch', () => {
  const cs = {
    schema: 'assay.checks/v1' as const,
    id: 'x',
    version: '1',
    task: { instruction: 'Place an order.' },
    requirements: [
      {
        id: 'R1',
        kind: 'hard' as const,
        text: 't',
        source: { field: 'instruction' as const, quote: 'place an order' },
      },
    ],
    checks: [
      {
        id: 'C1',
        requirement: 'R1',
        description: 'd',
        assert: {
          kind: 'anyOf' as const,
          of: [
            {
              kind: 'value' as const,
              source: { from: 'text' as const, pattern: 'Order #(\\d+)' },
              expect: { exists: true as const },
            },
            { kind: 'request' as const, match: { method: 'POST' } },
          ],
        },
      },
    ],
  };
  expect(coverage(cs)[0]!.trust).toBe('freetext');
  expect(
    coverage({ ...cs, checks: [{ ...cs.checks[0]!, assert: { kind: 'allOf', of: cs.checks[0]!.assert.of } }] })[0]!
      .trust,
  ).toBe('structured');
});

test.describe('agent loop', () => {
  const tool = (name: string, done?: boolean) => ({
    spec: { name, description: '', inputSchema: { type: 'object', properties: {} } },
    run: () => ({ content: `${name} ran`, ...(done ? { done: name } : {}) }),
  });
  test('max_tokens and refusal stop the loop before any tool runs', async () => {
    let ran = false;
    for (const stop of ['max_tokens', 'refusal'] as const) {
      const run = await runAgent({
        model: scripted([() => ({ stop, ...call('t', {}) })]),
        system: 's',
        prompt: 'p',
        tools: [{ ...tool('t'), run: () => ((ran = true), { content: '' }) }],
      });
      expect(run.status).toBe(stop);
    }
    expect(ran).toBe(false);
  });
  test('all results of a turn go back in one message; calls after a finishing call do not run', async () => {
    const ran: string[] = [];
    const t = (name: string, done?: boolean) => ({
      ...tool(name, done),
      run: () => (ran.push(name), { content: 'ok', ...(done ? { done: name } : {}) }),
    });
    const model = scripted([
      () => ({
        toolCalls: [
          { id: '1', name: 'a', input: {} },
          { id: '2', name: 'b', input: {} },
        ],
      }),
      () => ({
        toolCalls: [
          { id: '3', name: 'finish', input: {} },
          { id: '4', name: 'a', input: {} },
        ],
      }),
    ]);
    const run = await runAgent({ model, system: 's', prompt: 'p', tools: [t('a'), t('b'), t('finish', true)] });
    expect(run.status).toBe('done');
    expect(run.result).toBe('finish');
    expect(ran).toEqual(['a', 'b', 'finish']);
    expect(model.requests[1]!.messages.at(-1)).toMatchObject({
      role: 'user',
      toolResults: [{ toolCallId: '1' }, { toolCallId: '2' }],
    });
    expect(run.transcript.at(-1)).toMatchObject({
      toolResults: [{ toolCallId: '3' }, { toolCallId: '4', isError: true }],
    });
  });
  test('empty assistant turns are not sent back; nudges are bounded', async () => {
    const model = scripted([() => ({ raw: [] }), () => ({ raw: [] }), () => ({ raw: [] })]);
    const run = await runAgent({ model, system: 's', prompt: 'p', tools: [tool('t')], maxNudges: 2 });
    expect(run.status).toBe('gave_up');
    expect(model.requests).toHaveLength(3);
    expect(model.requests[2]!.messages.some((m) => m.role === 'assistant')).toBe(false);
  });
});

test.describe('Anthropic adapter (fake client)', () => {
  const message = (content: unknown[], stop = 'end_turn') =>
    ({
      id: 'm',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content,
      stop_reason: stop,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
    }) as never;
  const fake = (results: (() => unknown)[]) => {
    const params: unknown[] = [];
    let i = 0;
    return {
      params,
      client: {
        beta: {
          messages: {
            stream(p: unknown) {
              params.push(p);
              const r = results[i++]!;
              return { finalMessage: async () => r() as never };
            },
          },
        },
      },
    };
  };
  test('request shape, tool results, caching, fallbacks and usage', async () => {
    const f = fake([() => message([{ type: 'tool_use', id: 'tu1', name: 't', input: { a: 1 } }], 'tool_use')]);
    const m = await anthropicModel({ client: f.client });
    expect(m.id).toBe('anthropic:claude-opus-5-5@high');
    const turn = await m.turn({
      system: 'sys',
      tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' }, strict: true }],
      messages: [
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: '', toolCalls: [], raw: [{ type: 'text', text: 'prev' }] },
        { role: 'user', toolResults: [{ toolCallId: 'x', content: 'r', isError: true }], text: 'more' },
      ],
    });
    expect(turn).toMatchObject({ stop: 'tool_use', toolCalls: [{ id: 'tu1', name: 't', input: { a: 1 } }] });
    expect(turn.usage).toEqual({ inputTokens: 130, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20 });
    expect(f.params[0]).toMatchObject({
      model: 'claude-opus-5-5',
      cache_control: { type: 'ephemeral' },
      output_config: { effort: 'high' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      tools: [{ name: 't', strict: true, eager_input_streaming: true }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'prev' }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'x', content: 'r', is_error: true },
            { type: 'text', text: 'more' },
          ],
        },
      ],
    });
    expect(JSON.stringify(f.params[0])).not.toContain('thinking');
  });
  test('a tool input that streamed as invalid JSON is retried; persistent failure becomes ModelError', async () => {
    const parseError = () => {
      throw new AnthropicError('Unable to parse tool parameter JSON from model.');
    };
    const ok = await anthropicModel({
      client: fake([parseError, () => message([{ type: 'text', text: 'done' }])]).client,
    });
    expect((await ok.turn({ system: 's', messages: [{ role: 'user', text: 'x' }], tools: [] })).text).toBe('done');
    const bad = await anthropicModel({ client: fake([parseError, parseError, parseError]).client });
    await expect(bad.turn({ system: 's', messages: [{ role: 'user', text: 'x' }], tools: [] })).rejects.toThrow(
      'after 3 attempts',
    );
  });
});

test.describe('rubric coverage (re-review)', () => {
  const task = (outcomes: string) => ({ id: 't', instruction: 'Do it.', outcomes });
  const r = (id: string, quote: string, kind: 'hard' | 'soft' = 'hard') => ({
    id,
    kind,
    text: quote,
    source: { field: 'outcomes' as const, quote },
  });
  test('a quote dropping a word is uncovered unless another requirement quotes the rest', () => {
    const t = task('Then the order ships express');
    const cl = parseOutcomes(t.outcomes);
    expect(checkRubric(t, [r('R1', 'the order ships')], cl).join()).toContain('not fully quoted');
    expect(checkRubric(t, [r('R1', 'the order ships'), r('R2', 'express')], cl)).toEqual([]);
  });
  test('duplicate and nested clauses do not make rubrics impossible', () => {
    const dup = task('Then a b c\nThen a b c');
    expect(checkRubric(dup, [r('R1', 'a b c')], parseOutcomes(dup.outcomes))).toEqual([]);
    const nested = task('Then the order is placed\nThen the order is placed with express shipping');
    expect(
      checkRubric(nested, [r('R1', 'the order is placed with express shipping')], parseOutcomes(nested.outcomes)),
    ).toEqual([]);
  });
  test('a clause can be split into a hard part and an optional soft part', () => {
    const t = task('Then the confirmation is shown, ideally with a delivery date');
    const cl = parseOutcomes(t.outcomes);
    expect(
      checkRubric(t, [r('R1', 'the confirmation is shown'), r('R2', 'ideally with a delivery date', 'soft')], cl),
    ).toEqual([]);
    // the non-optional part cannot be soft just because the clause mentions "ideally"
    expect(
      checkRubric(
        t,
        [r('R1', 'the confirmation is shown', 'soft'), r('R2', 'ideally with a delivery date', 'soft')],
        cl,
      ).join(),
    ).toContain('must be hard');
  });
  test('a bullet list with * is a list, not Gherkin', () => {
    expect(parseOutcomes('* the cart has a mug\n* the total is $12').map((c) => c.text)).toEqual([
      'the cart has a mug',
      'the total is $12',
    ]);
  });
  test('outcomes that parse to nothing fail the compile with a reason', async () => {
    const { report } = await compileTask(
      { id: 't', instruction: 'Do it.', outcomes: 'Given a cart\nWhen I pay' },
      [{ name: 'r', kind: 'success', snapshot: ref('01-newsletter', 'subscribed') }],
      { model: scripted([]) },
    );
    expect(report.status).toBe('failed');
    expect(report.reason).toContain('no outcome clause');
    expect(report.warnings.join()).toContain('When I pay');
  });
});

test('adapter aborts the failed stream before retrying', async () => {
  let aborted = 0;
  let calls = 0;
  const client = {
    beta: {
      messages: {
        stream() {
          calls++;
          return {
            abort: () => aborted++,
            finalMessage: async () => {
              if (calls === 1) throw new AnthropicError('Unable to parse tool parameter JSON from model.');
              return {
                model: 'claude-opus-5-5',
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 1, output_tokens: 1 },
              } as never;
            },
          };
        },
      },
    },
  };
  const m = await anthropicModel({ client });
  expect((await m.turn({ system: 's', messages: [{ role: 'user', text: 'x' }], tools: [] })).text).toBe('ok');
  expect(aborted).toBe(1);
});
