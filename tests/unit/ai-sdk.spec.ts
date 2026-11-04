/** The Vercel AI SDK adapter, against the AI SDK's own mock language model. */
import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';
import { runVerifier, verify, type CheckSet, type EvidenceSnapshot, type ToolSpec } from '../../src/index.ts';
import { aiSdkModel, toAiSdkMessages } from '../../src/model/ai-sdk.ts';
import { ModelError, recordingModel, replayModel, runAgent } from '../../src/model/index.ts';
import { unwrapNodes } from '../../src/stress/index.ts';

type CallOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
type Content = GenerateResult['content'][number];

const usage = (input = 100, output = 20, cacheRead?: number, cacheWrite?: number): GenerateResult['usage'] => ({
  inputTokens: { total: input, noCache: undefined, cacheRead, cacheWrite },
  outputTokens: { total: output, text: undefined, reasoning: undefined },
});

const toolCall = (name: string, input: unknown, id = `${name}-${Math.random().toString(36).slice(2, 8)}`): Content => ({
  type: 'tool-call',
  toolCallId: id,
  toolName: name,
  input: typeof input === 'string' ? input : JSON.stringify(input),
});

/** A mock AI SDK model that plays a script; each step sees the provider-level call options. */
function scriptedSdk(steps: ((opts: CallOptions) => Content[] | Partial<GenerateResult>)[]) {
  let i = 0;
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'mock-model',
    doGenerate: async (opts) => {
      const step = steps[i++];
      if (!step) throw new Error('script exhausted');
      const out = step(opts);
      const r: Partial<GenerateResult> = Array.isArray(out) ? { content: out } : out;
      const content = r.content ?? [];
      return {
        content,
        finishReason: r.finishReason ?? {
          unified: content.some((c) => c.type === 'tool-call') ? 'tool-calls' : 'stop',
          raw: undefined,
        },
        usage: r.usage ?? usage(),
        warnings: [],
        response: r.response ?? { modelId: 'mock-model-2026' },
      };
    },
  });
}

const ref = (task: string, name: string): EvidenceSnapshot =>
  JSON.parse(readFileSync(new URL(`../../examples/tiny-shop/references/${task}/${name}.json`, import.meta.url), 'utf8'))
    .snapshot;
const TWO_MUGS = JSON.parse(
  readFileSync(new URL('../../examples/tiny-shop/tasks/03-cart-two-mugs.checks.json', import.meta.url), 'utf8'),
) as CheckSet;
/** A correct run whose cart table lost its semantics: the checks abstain. */
const unanchored = () => unwrapNodes(ref('03-cart-two-mugs', 'both-mugs'), { role: 'table' });

const verdict = (requirement: string, status: 'pass' | 'fail' | 'unknown', cites: number[] = []) => ({
  requirement,
  status,
  cites,
  reasoning: 'see cited observations',
});

const ECHO: ToolSpec = {
  name: 'echo',
  description: 'Echo the text back.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
};

test('one turn: system, tools (JSON Schema, no execute), stop reason, usage with cache tokens, served model', async () => {
  const sdk = scriptedSdk([
    () => ({
      content: [{ type: 'text', text: 'Echoing.' }, toolCall('echo', { text: 'hi' }, 'c1')],
      usage: usage(1200, 30, 1000, 150),
    }),
  ]);
  const model = aiSdkModel(sdk);
  expect(model.id).toBe('mock:mock-model');
  const turn = await model.turn({ system: 'Be brief.', messages: [{ role: 'user', text: 'Say hi.' }], tools: [ECHO] });

  const call = sdk.doGenerateCalls[0]!;
  expect(call.prompt).toEqual([
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: [{ type: 'text', text: 'Say hi.' }] },
  ]);
  expect(call.tools).toEqual([
    expect.objectContaining({
      type: 'function',
      name: 'echo',
      description: ECHO.description,
      inputSchema: ECHO.inputSchema,
    }),
  ]);
  expect(turn).toMatchObject({
    stop: 'tool_use',
    text: 'Echoing.',
    toolCalls: [{ id: 'c1', name: 'echo', input: { text: 'hi' } }],
    usage: { inputTokens: 1200, outputTokens: 30, cacheReadTokens: 1000, cacheWriteTokens: 150 },
    model: 'mock-model-2026',
  });
  expect((turn.raw as { role: string }[]).map((m) => m.role)).toEqual(['assistant']);
});

test('options pass through; finish reasons map to stop reasons; missing usage details are left out', async () => {
  const sdk = scriptedSdk([
    () => ({ content: [{ type: 'text', text: '…' }], finishReason: { unified: 'length', raw: 'max_tokens' } }),
    () => ({ content: [], finishReason: { unified: 'content-filter', raw: 'refusal' } }),
    () => ({ content: [{ type: 'text', text: 'done' }] }),
  ]);
  const model = aiSdkModel(sdk, {
    id: 'custom-id',
    providerOptions: { mock: { effort: 'high' } },
    maxOutputTokens: 500,
  });
  expect(model.id).toBe('custom-id');
  const req = { system: 's', messages: [{ role: 'user' as const, text: 'x' }], tools: [{ ...ECHO, strict: true }] };
  expect((await model.turn(req)).stop).toBe('max_tokens');
  expect(sdk.doGenerateCalls[0]).toMatchObject({
    providerOptions: { mock: { effort: 'high' } },
    maxOutputTokens: 500,
    tools: [{ name: 'echo', strict: true }],
  });
  expect((await model.turn(req)).stop).toBe('refusal');
  const last = await model.turn(req);
  expect(last.stop).toBe('end_turn');
  expect(last.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
});

test('the agent loop keeps control: reasoning is sent back, tool results return as a tool message, bad input is answered', async () => {
  let ran = 0;
  const sdk = scriptedSdk([
    () => [
      { type: 'reasoning', text: 'I should echo.', providerMetadata: { mock: { signature: 'sig-1' } } },
      toolCall('echo', '{"text": ', 'bad'), // unparseable input
    ],
    (opts) => {
      const tool = opts.prompt.at(-1)!;
      expect(tool.role).toBe('tool');
      expect(tool.content[0]).toMatchObject({ type: 'tool-result', toolCallId: 'bad', toolName: 'echo' });
      expect(JSON.stringify(tool.content[0])).toContain('Invalid input');
      return [toolCall('echo', { text: 'hello' }, 'good')];
    },
    (opts) => {
      // The first assistant turn went back as the SDK produced it, reasoning and its metadata included.
      const assistant = opts.prompt.find((m) => m.role === 'assistant')!;
      expect(assistant.content[0]).toMatchObject({
        type: 'reasoning',
        text: 'I should echo.',
        providerOptions: { mock: { signature: 'sig-1' } },
      });
      expect(opts.prompt.at(-1)!.content[0]).toMatchObject({
        type: 'tool-result',
        toolCallId: 'good',
        output: { type: 'text', value: 'echo: hello' },
      });
      return [toolCall('finish', {}, 'f')];
    },
  ]);
  const run = await runAgent<string>({
    model: aiSdkModel(sdk),
    system: 's',
    prompt: 'go',
    tools: [
      {
        spec: ECHO,
        run: (i: { text: string }) => {
          ran++;
          return { content: `echo: ${i.text}` };
        },
      },
      {
        spec: { name: 'finish', description: 'Finish.', inputSchema: { type: 'object', properties: {} } },
        run: () => ({ content: 'ok', done: 'finished' }),
      },
    ],
  });
  expect(run).toMatchObject({ status: 'done', result: 'finished', turns: 3, models: ['mock-model-2026'] });
  expect(ran).toBe(1); // the unparseable call never reached the tool
});

test('provider errors become ModelError', async () => {
  const sdk = new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error('overloaded');
    },
  });
  const model = aiSdkModel(sdk, { maxRetries: 0 });
  await expect(model.turn({ system: 's', messages: [{ role: 'user', text: 'x' }], tools: [] })).rejects.toThrow(
    ModelError,
  );
});

test('messages without SDK raw content are rebuilt from text and tool calls', () => {
  expect(
    toAiSdkMessages([
      { role: 'user', text: 'go' },
      { role: 'assistant', text: 'ok', toolCalls: [{ id: 't1', name: 'echo', input: { text: 'a' } }], raw: null },
      { role: 'user', toolResults: [{ toolCallId: 't1', content: 'nope', isError: true }], text: 'Continue.' },
    ]),
  ).toEqual([
    { role: 'user', content: 'go' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'tool-call', toolCallId: 't1', toolName: 'echo', input: { text: 'a' } },
      ],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 't1', toolName: 'echo', output: { type: 'error-text', value: 'nope' } },
      ],
    },
    { role: 'user', content: 'Continue.' },
  ]);
});

/** The verifier explores, then cites what it saw. */
const verifierScript = () =>
  scriptedSdk([
    (opts) => {
      expect(opts.tools?.map((t) => t.name)).toContain('submit_verdict');
      expect(opts.tools?.map((t) => t.name)).not.toContain('open_page'); // no live access offered
      return [toolCall('find_nodes', { text: 'Mug' })];
    },
    (opts) => {
      expect(JSON.stringify(opts.prompt.at(-1))).toContain('Blue Mug');
      return [toolCall('submit_verdict', { verdicts: [verdict('R1', 'pass', [1]), verdict('R2', 'pass', [1])] })];
    },
  ]);

test('end to end: an abstained run escalates to a verifier on an AI SDK model and is rescued', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'assay-ai-sdk-'));
  const res = await verify(TWO_MUGS, unanchored(), { verifier: aiSdkModel(verifierScript()), recordDir: dir });
  expect(res.checksOutcome.verdict).toBe('abstain');
  expect(res.outcome.verdict).toBe('success');
  expect(res.outcome.requirements.map((r) => r.decidedBy)).toEqual(['verifier', 'verifier']);
  expect(res.record.escalation).toMatchObject({
    status: 'done',
    model: 'mock:mock-model',
    modelsUsed: ['mock-model-2026'],
    turns: 2,
    usage: { inputTokens: 200, outputTokens: 40 },
  });
  expect(res.written?.recordFile).toBeDefined();
  expect(readdirSync(join(dir, 'records'))).toHaveLength(1);

  const direct = await runVerifier(aiSdkModel(verifierScript()), {
    task: TWO_MUGS.task,
    requirements: TWO_MUGS.requirements,
    snapshot: unanchored(),
  });
  expect(direct.verdicts.map((v) => v.status)).toEqual(['pass', 'pass']);
});

test('a recorded AI SDK verifier run replays without the model', async () => {
  const cassette = join(mkdtempSync(join(tmpdir(), 'assay-ai-sdk-cassette-')), 'verifier.json');
  const rec = recordingModel(aiSdkModel(verifierScript()), cassette);
  const live = await verify(TWO_MUGS, unanchored(), { verifier: rec });
  rec.save();
  const replayed = await verify(TWO_MUGS, unanchored(), { verifier: replayModel(cassette) });
  expect(replayed.outcome.verdict).toBe('success');
  expect(replayed.record.requirements).toEqual(live.record.requirements);
  expect(replayed.record.escalation?.verdicts).toEqual(live.record.escalation?.verdicts);
});
