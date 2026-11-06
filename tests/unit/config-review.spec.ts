/**
 * Regression tests for the review of the config / bring-your-own-model change (PR #29).
 * Each test reproduces one finding. No key and no network.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV4 } from 'ai/test';
import {
  lockCheckSet,
  resolveModel,
  verify,
  type AssayConfig,
  type CheckSet,
  type EvidenceSnapshot,
  type ModelClient,
  type ModelRequest,
  type ModelTurn,
  type ToolSpec,
} from '../../src/index.ts';
import { compileTask } from '../../src/compiler/index.ts';
import { aiSdkModel } from '../../src/model/ai-sdk.ts';
import { isJsonModeModel, jsonModeModel, recordingModel, replayModel, runAgent } from '../../src/model/index.ts';
import { cachedUntilRejected, normalizeConfig } from '../../src/config/config.ts';
import { selectModel } from '../../src/cli/model.ts';
import { outFile } from '../../src/cli/commands/capture.ts';
import { configuredChecks } from '../../src/cli/commands/validate.ts';
import { run as runCli } from '../../src/cli/main.ts';
import { applyConfig } from '../../src/verifier/escalate.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const shop = (p: string) => join(root, 'examples/tiny-shop', p);
const tmp = () => mkdtempSync(join(tmpdir(), 'assay-review-'));
const TWO_MUGS = JSON.parse(readFileSync(shop('tasks/03-cart-two-mugs.checks.json'), 'utf8')) as CheckSet;
const ADDED_BLUE = shop('references/02-add-blue-mug/added-blue-mug.json');
const decided = (): EvidenceSnapshot =>
  JSON.parse(readFileSync(shop('references/03-cart-two-mugs/both-mugs.json'), 'utf8')).snapshot;

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
const FINISH: ToolSpec = { name: 'finish', description: 'Finish.', inputSchema: { type: 'object', properties: {} } };
const call = (tool: string, input: unknown) => JSON.stringify({ tool, input });
const turnOf = (text: string): ModelTurn => ({
  stop: 'end_turn',
  text,
  toolCalls: [],
  raw: [],
  usage: { inputTokens: 1, outputTokens: 1 },
  model: 'text-model',
});

/** A text-only adapter (no tool calling) that plays `replies` and keeps its requests. */
function textAdapter(replies: string[]) {
  const requests: ModelRequest[] = [];
  let i = 0;
  const client: ModelClient & { requests: ModelRequest[] } = {
    id: 'text-only',
    capabilities: { tools: false },
    requests,
    async turn(req) {
      requests.push(structuredClone(req));
      return turnOf(replies[i++] ?? '');
    },
  };
  return client;
}

async function assay(argv: string[], env: Record<string, string | undefined> = {}, cwd?: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(argv, {
    out: (t) => stdout.push(t),
    err: (t) => stderr.push(t),
    color: false,
    errColor: false,
    env,
    ...(cwd ? { cwd } : {}),
  });
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

test('capture: a configured snapshots path is always a directory; --out names a file', () => {
  const url = new URL('http://shop.test/cart');
  const now = new Date('2026-11-06T00:00:00.000Z');
  expect(outFile('runs.json', url, now)).toBe('runs.json');
  expect(outFile('runs.json', url, now, { directory: true })).toBe(
    join('runs.json', 'shop.test-2026-11-06T00-00-00-000Z.json'),
  );
});

test('capture: the config is read before Chromium is launched', async () => {
  const r = await assay([
    'capture',
    'http://127.0.0.1:9/',
    '--executable-path',
    '/nonexistent/chromium',
    '--config',
    join(tmp(), 'missing.ts'),
  ]);
  expect(r.code).toBe(4);
  expect(r.stderr).toContain('config file not found');
});

test('validate: a checks directory whose name has glob characters is read literally', () => {
  const base = tmp();
  mkdirSync(join(base, 'project[abc]', 'sub'), { recursive: true });
  mkdirSync(join(base, 'projecta'));
  writeFileSync(join(base, 'project[abc]', 'sub', 'x.checks.json'), '{}');
  writeFileSync(join(base, 'projecta', 'y.checks.json'), '{}');
  expect(configuredChecks(join(base, 'project[abc]'))).toEqual([join(base, 'project[abc]', 'sub', 'x.checks.json')]);
  // A glob in a config file that lives in such a directory keeps the directory literal.
  const config = normalizeConfig({ checks: '**/*.checks.json' }, join(base, 'project[abc]'));
  expect(configuredChecks(config.checks!)).toEqual([join(base, 'project[abc]', 'sub', 'x.checks.json')]);
});

test('CLI: a qualified --model is not routed through $ASSAY_PROVIDER', async () => {
  await expect(selectModel({ model: 'mistral:mistral-large-latest' }, { ASSAY_PROVIDER: 'anthropic' })).rejects.toThrow(
    '@ai-sdk/mistral',
  );
  await expect(selectModel({}, { ASSAY_PROVIDER: 'anthropic', ASSAY_MODEL: 'mistral:m' })).rejects.toThrow(
    '@ai-sdk/mistral',
  );
});

test('compileTask reports a missing correct reference before it resolves the model', async () => {
  const snapshot = JSON.parse(readFileSync(ADDED_BLUE, 'utf8')).snapshot;
  const { report } = await compileTask(
    { id: 't', instruction: 'Add a Blue Mug.' },
    [{ name: 'wrong', kind: 'negative', snapshot }],
    { model: 'mistral:not-installed' },
  );
  expect(report).toMatchObject({ status: 'failed', model: 'mistral:not-installed' });
  expect(report.reason).toContain('At least one successful reference');
});

test('config: escalate.on must be an array of "abstain" and "fail"', () => {
  expect(() => normalizeConfig({ escalate: { on: ['bogus'] } }, '/')).toThrow('`escalate.on`');
  expect(() => normalizeConfig({ escalate: { on: 'abstain' } }, '/')).toThrow('`escalate.on`');
  expect(() => normalizeConfig({ escalate: { includeSoft: 'yes' } }, '/')).toThrow('`escalate.includeSoft`');
  expect(() => normalizeConfig({ escalate: { onn: [] } }, '/')).toThrow('unknown option `escalate.onn`');
  expect(normalizeConfig({ escalate: { on: ['abstain', 'fail'], includeSoft: true } }, '/').escalate).toEqual({
    on: ['abstain', 'fail'],
    includeSoft: true,
  });
});

type CallOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;
const usage = (cacheRead?: number, cacheWrite?: number): GenerateResult['usage'] => ({
  inputTokens: { total: 100, noCache: undefined, cacheRead, cacheWrite },
  outputTokens: { total: 20, text: undefined, reasoning: undefined },
});
function sdk(steps: ((opts: CallOptions) => Partial<GenerateResult>)[]) {
  let i = 0;
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'small',
    doGenerate: async (opts) => {
      const r = steps[i++]!(opts);
      return {
        content: r.content ?? [],
        finishReason: { unified: 'stop', raw: undefined },
        usage: r.usage ?? usage(),
        warnings: r.warnings ?? [],
        response: { modelId: 'small' },
      };
    },
  });
}
const text = (t: string): Partial<GenerateResult> => ({ content: [{ type: 'text', text: t }] });
const ECHO_REQ: ModelRequest = { system: 's', messages: [{ role: 'user', text: 'Say hi.' }], tools: [ECHO] };

test('AI SDK: "tool calling is not supported" falls back to JSON mode', async () => {
  const m = sdk([
    () => {
      throw new Error('tool calling is not supported for this model');
    },
    () => text(call('echo', { text: 'a' })),
  ]);
  expect((await aiSdkModel(m, { maxRetries: 0 }).turn(ECHO_REQ)).mode).toBe('json');
});

test('AI SDK: the discarded call of a fallback counts its cache tokens too', async () => {
  const m = sdk([
    () => ({ ...text('Hi!'), usage: usage(40, 10), warnings: [{ type: 'unsupported', feature: 'tools' }] }),
    () => ({ ...text(call('echo', { text: 'b' })), usage: usage(30) }),
  ]);
  const t = await aiSdkModel(m).turn(ECHO_REQ);
  expect(t.usage).toEqual({ inputTokens: 200, outputTokens: 40, cacheReadTokens: 70, cacheWriteTokens: 10 });
});

test('a text-only adapter is driven in JSON mode when recorded, passed to runAgent, or resolved, and never twice', async () => {
  const run = (model: ModelClient) =>
    runAgent<string>({
      model,
      system: 's',
      prompt: 'go',
      maxTurns: 3,
      tools: [{ spec: FINISH, run: () => ({ content: 'ok', done: 'finished' }) }],
    });
  // runAgent directly.
  const direct = textAdapter([call('finish', {})]);
  expect(await run(direct)).toMatchObject({ status: 'done', modes: ['json'] });
  expect(direct.requests[0]!.tools).toEqual([]);
  // Recorded, then replayed.
  const file = join(tmp(), 'c.json');
  const inner = textAdapter([call('finish', {})]);
  const rec = recordingModel(inner, file);
  expect(await run(rec)).toMatchObject({ status: 'done', modes: ['json'] });
  rec.save();
  expect(inner.requests[0]!.tools).toEqual([]);
  expect(await run(replayModel(file))).toMatchObject({ status: 'done', result: 'finished', modes: ['json'] });
  // Not wrapped twice: JSON-mode clients and AI SDK clients in JSON mode are used as they are.
  const json = jsonModeModel(textAdapter([]));
  expect(isJsonModeModel(json)).toBe(true);
  expect(await resolveModel(json)).toBe(json);
  const sdkJson = aiSdkModel(sdk([]), { mode: 'json' });
  expect(await resolveModel(sdkJson)).toBe(sdkJson);
  expect(await resolveModel(json, { mode: 'json' })).toBe(json);
});

test('the playwright helpers retry a project config that failed to load', async () => {
  let calls = 0;
  const load = cachedUntilRejected(async () => {
    if (++calls === 1) throw new Error('flaky');
    return 'ok';
  });
  await expect(load()).rejects.toThrow('flaky');
  expect(await load()).toBe('ok');
  expect(await load()).toBe('ok');
  expect(calls).toBe(2);
});

test('verify reads a config object anew on every call, so later edits apply', async () => {
  const config: AssayConfig = { requireLocked: false };
  expect((await verify(TWO_MUGS, decided(), { config })).outcome.verdict).toBe('success');
  config.requireLocked = true;
  await expect(verify(TWO_MUGS, decided(), { config })).rejects.toThrow('not locked');
  expect((await verify(lockCheckSet(TWO_MUGS, 'r'), decided(), { config })).outcome.verdict).toBe('success');
});

test("the config's model options reach an explicit verifier given as a string or AI SDK model (not its id)", async () => {
  const unanchored = JSON.parse(readFileSync(shop('references/03-cart-two-mugs/both-mugs.json'), 'utf8')).snapshot;
  const { unwrapNodes } = await import('../../src/stress/index.ts');
  const snapshot = unwrapNodes(unanchored, { role: 'table' });
  const verdicts = {
    verdicts: ['R1', 'R2'].map((requirement) => ({ requirement, status: 'pass', cites: [1], reasoning: 'cited' })),
  };
  const seen: (unknown[] | undefined)[] = [];
  const steps = [call('find_nodes', { text: 'Mug' }), call('submit_verdict', verdicts)].map(
    (reply) => (opts: CallOptions) => (seen.push(opts.tools), text(reply)),
  );
  const res = await verify(TWO_MUGS, snapshot, {
    verifier: sdk(steps),
    config: { modelOptions: { mode: 'json', id: 'config-model' } },
  });
  expect(res.outcome.verdict).toBe('success');
  expect(seen).toEqual([undefined, undefined]); // driven in JSON mode, from the config
  expect(res.record.escalation).toMatchObject({ model: 'mock:small', modes: ['json'] }); // its own id
});

test('a "provider:model" string loads `ai` and the provider package from the project first', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'package.json'), '{ "name": "project", "type": "module" }');
  const pkg = (name: string, body: string) => {
    const d = join(dir, 'node_modules', ...name.split('/'));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.js' }));
    writeFileSync(join(d, 'index.js'), body);
  };
  // A project whose `ai` is not the one next to Assay (a linked or global Assay).
  pkg(
    'ai',
    `export const jsonSchema = (s) => s;
export const generateText = async () => ({ finishReason: 'stop', text: 'from the project ai', toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1 }, response: { messages: [], modelId: 'stub' }, warnings: [] });`,
  );
  pkg(
    '@ai-sdk/anthropic',
    `export const anthropic = (id) => ({ specificationVersion: 'v4', provider: 'stub', modelId: id,
  doGenerate: async () => { throw new Error('not the project provider'); } });`,
  );
  const m = await resolveModel('anthropic:claude-x', { cwd: dir });
  const t = await m.turn({ system: 's', messages: [{ role: 'user', text: 'hi' }], tools: [] });
  expect(t.text).toBe('from the project ai');
});

test('config model options apply per model: an explicit client verifier gets none while an AI SDK proposer gets them', async () => {
  const { unwrapNodes } = await import('../../src/stress/index.ts');
  const snapshot = unwrapNodes(decided(), { role: 'table' });
  const verdicts = {
    verdicts: ['R1', 'R2'].map((requirement) => ({ requirement, status: 'pass', cites: [1], reasoning: 'cited' })),
  };
  // An explicit client (as a replayModel would be) that answers with native tool calls.
  const verifierTools: number[] = [];
  const verifier: ModelClient = {
    id: 'replayed',
    async turn(req) {
      verifierTools.push(req.tools.length);
      return {
        ...turnOf(''),
        stop: 'tool_use',
        toolCalls: [
          req.messages.length === 1
            ? { id: 'a', name: 'find_nodes', input: { text: 'Mug' } }
            : { id: 'b', name: 'submit_verdict', input: verdicts },
        ],
      };
    },
  };
  const proposerTools: unknown[] = [];
  const proposer = sdk(
    Array.from({ length: 12 }, () => (opts: CallOptions) => (proposerTools.push(opts.tools), text('no'))),
  );
  const res = await verify(TWO_MUGS, snapshot, { verifier, proposer, config: { modelOptions: { mode: 'json' } } });
  expect(res.outcome.verdict).toBe('success');
  expect(verifierTools.every((n) => n > 0)).toBe(true); // the client got its tool requests, not JSON mode
  expect(proposerTools.length).toBeGreaterThan(0);
  expect(proposerTools.every((t) => t === undefined)).toBe(true); // the AI SDK proposer was driven in JSON mode
});

test("config model options apply per model: the config's id names the config model, not an explicit proposer", async () => {
  const configModel: ModelClient = { id: 'cfg', turn: async () => turnOf('') };
  const out = applyConfig(
    { escalate: true, proposer: sdk([]) },
    { model: configModel, modelOptions: { id: 'config-id' } },
  );
  // As verify resolves them.
  expect((await resolveModel(out.verifier!, out.modelOptions ?? {})).id).toBe('config-id');
  expect((await resolveModel(out.proposer!, out.modelOptions ?? {})).id).toBe('mock:small');
});
