/**
 * Bring your own model and assay.config.ts (ADR 0017): the three model forms, JSON mode with
 * its repair retry and the AI SDK's automatic fallback to it, mode-aware cassette keys,
 * config loading and precedence in the library and the CLI. No key and no network.
 */
import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockLanguageModelV4 } from 'ai/test';
import { UnsupportedFunctionalityError } from 'ai';
import {
  defineConfig,
  loadConfig,
  resolveModel,
  verify,
  verifyMany,
  type CheckSet,
  type EvidenceSnapshot,
  type ModelClient,
  type ModelRequest,
  type ModelTurn,
  type ToolSpec,
} from '../../src/index.ts';
import { compileTask } from '../../src/compiler/index.ts';
import { aiSdkModel } from '../../src/model/ai-sdk.ts';
import {
  isJsonModeModel,
  jsonModeModel,
  parseJsonReply,
  recordingModel,
  replayModel,
  requestKey,
  runAgent,
} from '../../src/model/index.ts';
import { canonicalJson, sha256 } from '../../src/snapshot/digest.ts';
import { unwrapNodes } from '../../src/stress/index.ts';
import { run as runCli } from '../../src/cli/main.ts';
import { CONFIG_TEMPLATE } from '../../src/cli/commands/init.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const src = (p: string) => join(root, 'src', p);
const shop = (p: string) => join(root, 'examples/tiny-shop', p);
const tmp = () => mkdtempSync(join(tmpdir(), 'assay-config-'));

const TWO_MUGS = JSON.parse(readFileSync(shop('tasks/03-cart-two-mugs.checks.json'), 'utf8')) as CheckSet;
const BLUE_MUG = shop('tasks/02-add-blue-mug.checks.json');
const ADDED_BLUE = shop('references/02-add-blue-mug/added-blue-mug.json');
const ref = (task: string, name: string): EvidenceSnapshot =>
  JSON.parse(readFileSync(shop(`references/${task}/${name}.json`), 'utf8')).snapshot;
/** A correct run whose cart table lost its semantics: the checks abstain, so it escalates. */
const unanchored = () => unwrapNodes(ref('03-cart-two-mugs', 'both-mugs'), { role: 'table' });

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

const turnOf = (text: string): ModelTurn => ({
  stop: 'end_turn',
  text,
  toolCalls: [],
  raw: [{ role: 'assistant', content: text }],
  usage: { inputTokens: 10, outputTokens: 5 },
  model: 'text-model-1',
});

/** A custom adapter that only produces text: it plays `replies` and keeps the requests it got. */
function textAdapter(replies: string[], capabilities = { tools: false }) {
  const requests: ModelRequest[] = [];
  let i = 0;
  const client: ModelClient & { requests: ModelRequest[] } = {
    id: 'my-llm',
    capabilities,
    requests,
    async turn(req) {
      requests.push(structuredClone(req));
      const reply = replies[i++];
      if (reply === undefined) throw new Error('script exhausted');
      return turnOf(reply);
    },
  };
  return client;
}

const call = (tool: string, input: unknown) => JSON.stringify({ tool, input });
const verdicts = JSON.stringify({
  verdicts: ['R1', 'R2'].map((requirement) => ({ requirement, status: 'pass', cites: [1], reasoning: 'cited' })),
});

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

/** A config file in a fresh directory; `@assay/*` imports point at the sources. */
function configDir(body: string, file = 'assay.config.ts'): string {
  const dir = tmp();
  // The test runner's own TypeScript loader reads a scope without "type" as CommonJS.
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }');
  writeFileSync(join(dir, file), body.replaceAll('@assay/', `${src('')}/`));
  return dir;
}

test.describe('JSON mode', () => {
  test('a reply is parsed and validated; fences, prose around it and several calls are accepted', () => {
    expect(parseJsonReply(call('echo', { text: 'hi' }), [ECHO])).toEqual({
      calls: [{ name: 'echo', input: { text: 'hi' } }],
      errors: [],
    });
    expect(parseJsonReply('Sure:\n```json\n{"tool": "echo", "input": {"text": "a"}}\n```', [ECHO]).errors).toEqual([]);
    expect(
      parseJsonReply(`[${call('echo', { text: 'a' })}, ${call('echo', { text: 'b' })}]`, [ECHO]).calls,
    ).toHaveLength(2);
    expect(parseJsonReply('I will echo it.', [ECHO]).errors).toEqual(['the reply holds no JSON object']);
    expect(parseJsonReply(call('shout', {}), [ECHO]).errors[0]).toContain('unknown tool "shout"');
    const invalid = parseJsonReply(call('echo', { txt: 'a' }), [ECHO]);
    expect(invalid.calls).toHaveLength(1);
    expect(invalid.errors[0]).toContain('echo input:');
  });

  test('tools go into the system prompt, results come back as text, and an invalid reply gets one repair', async () => {
    const inner = textAdapter(['I would echo hi.', call('echo', { text: 'hi' }), call('finish', {})]);
    const model = jsonModeModel(inner);
    const run = await runAgent<string>({
      model,
      system: 'Be brief.',
      prompt: 'Say hi.',
      tools: [
        { spec: ECHO, run: (i: { text: string }) => ({ content: `echo: ${i.text}` }) },
        {
          spec: { name: 'finish', description: 'Finish.', inputSchema: { type: 'object', properties: {} } },
          run: () => ({ content: 'ok', done: 'finished' }),
        },
      ],
    });
    expect(run).toMatchObject({ status: 'done', result: 'finished', turns: 2, modes: ['json'] });
    // The wrapped model never sees tools: they are described in the system prompt.
    expect(inner.requests.every((r) => r.tools.length === 0)).toBe(true);
    expect(inner.requests[0]!.system).toContain('## echo');
    expect(inner.requests[0]!.system).toContain('"tool": "<tool name>"');
    // The repair: the bad reply and what is wrong with it.
    expect(inner.requests[1]!.messages.at(-2)).toMatchObject({ role: 'assistant', text: 'I would echo hi.' });
    expect(inner.requests[1]!.messages.at(-1)!).toMatchObject({ role: 'user' });
    expect((inner.requests[1]!.messages.at(-1) as { text: string }).text).toContain('not a valid tool call');
    // The next turn carries the repaired reply (not the failed one) and the result as text.
    const third = inner.requests[2]!.messages;
    expect(third.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(third[1]).toMatchObject({ text: call('echo', { text: 'hi' }) });
    expect((third[2] as { text: string }).text).toBe('Result of echo:\necho: hi');
  });

  test('a reply still invalid after the repair goes to the loop, which answers it', async () => {
    const inner = textAdapter([call('echo', { txt: 1 }), call('echo', { txt: 2 }), call('echo', { text: 'ok' })]);
    const seen: unknown[] = [];
    const run = await runAgent<string>({
      model: jsonModeModel(inner),
      system: 's',
      prompt: 'go',
      maxTurns: 2,
      tools: [{ spec: ECHO, run: (i: { text: string }) => (seen.push(i), { content: 'done', done: i.text }) }],
    });
    expect(run).toMatchObject({ status: 'done', result: 'ok', turns: 2 });
    expect(JSON.stringify(inner.requests[2]!.messages.at(-1))).toContain('Invalid input');
    expect(seen).toEqual([{ text: 'ok' }]);
  });

  test('an adapter without tool calling escalates through verify, and the record says how it was driven', async () => {
    const adapter = textAdapter([
      call('find_nodes', { text: 'Mug' }),
      'Both mugs are there.',
      call('submit_verdict', JSON.parse(verdicts)),
    ]);
    const res = await verify(TWO_MUGS, unanchored(), { verifier: adapter, config: false });
    expect(res.checksOutcome.verdict).toBe('abstain');
    expect(res.outcome.verdict).toBe('success');
    expect(res.record.escalation).toMatchObject({ status: 'done', model: 'my-llm', modes: ['json'], turns: 2 });
    // A native-tools run keeps the record as it was: no `modes`.
    const native = await verify(TWO_MUGS, unanchored(), {
      config: false,
      verifier: {
        id: 'native',
        turn: async (req) => ({
          ...turnOf(''),
          stop: 'tool_use',
          raw: [],
          toolCalls: [
            req.messages.length === 1
              ? { id: 'a', name: 'find_nodes', input: { text: 'Mug' } }
              : { id: 'b', name: 'submit_verdict', input: JSON.parse(verdicts) },
          ],
        }),
      },
    });
    expect(native.outcome.verdict).toBe('success');
    expect(native.record.escalation).not.toHaveProperty('modes');
  });
});

type CallOptions = Parameters<MockLanguageModelV4['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

function sdk(steps: ((opts: CallOptions) => Partial<GenerateResult> | Promise<Partial<GenerateResult>>)[]) {
  let i = 0;
  return new MockLanguageModelV4({
    provider: 'mock',
    modelId: 'small-model',
    doGenerate: async (opts) => {
      const step = steps[i++];
      if (!step) throw new Error('script exhausted');
      const r = await step(opts);
      const content = r.content ?? [];
      return {
        content,
        finishReason: { unified: content.some((c) => c.type === 'tool-call') ? 'tool-calls' : 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 20, text: undefined, reasoning: undefined },
        },
        warnings: r.warnings ?? [],
        response: { modelId: 'small-model' },
      };
    },
  });
}
const text = (t: string): Partial<GenerateResult> => ({ content: [{ type: 'text', text: t }] });
const ECHO_REQ: ModelRequest = { system: 's', messages: [{ role: 'user', text: 'Say hi.' }], tools: [ECHO] };

test.describe('AI SDK capability detection', () => {
  test('a provider error saying the model has no tools switches to JSON mode for good', async () => {
    const m = sdk([
      () => {
        throw new UnsupportedFunctionalityError({ functionality: 'tools' });
      },
      (opts) => {
        expect(opts.tools).toBeUndefined();
        expect(JSON.stringify(opts.prompt[0])).toContain('## echo');
        return text(call('echo', { text: 'hi' }));
      },
      (opts) => {
        expect(opts.tools).toBeUndefined(); // sticky: no second try with tools
        return text(call('echo', { text: 'again' }));
      },
    ]);
    const model = aiSdkModel(m, { maxRetries: 0 });
    const turn = await model.turn(ECHO_REQ);
    expect(turn).toMatchObject({
      mode: 'json',
      stop: 'tool_use',
      toolCalls: [{ name: 'echo', input: { text: 'hi' } }],
    });
    expect((await model.turn(ECHO_REQ)).toolCalls[0]!.input).toEqual({ text: 'again' });
  });

  test('an Ollama-style "does not support tools" message and an "unsupported tools" warning both fall back', async () => {
    const byMessage = sdk([
      () => {
        throw new Error('registry.ollama.ai/library/gemma:2b does not support tools');
      },
      () => text(call('echo', { text: 'a' })),
    ]);
    expect((await aiSdkModel(byMessage, { maxRetries: 0 }).turn(ECHO_REQ)).mode).toBe('json');
    const byWarning = sdk([
      () => ({ ...text('Hi!'), warnings: [{ type: 'unsupported', feature: 'tools' }] }),
      () => text(call('echo', { text: 'b' })),
    ]);
    const t = await aiSdkModel(byWarning).turn(ECHO_REQ);
    expect(t).toMatchObject({ mode: 'json', toolCalls: [{ input: { text: 'b' } }] });
    expect(t.usage.inputTokens).toBe(200); // the discarded call is counted
  });

  test('native tools are marked; other errors are not a fallback; mode forces either way', async () => {
    const native = sdk([
      () => ({ content: [{ type: 'tool-call', toolCallId: 'c', toolName: 'echo', input: '{"text":"x"}' }] }),
    ]);
    expect((await aiSdkModel(native).turn(ECHO_REQ)).mode).toBe('tools');
    const failing = sdk([
      () => {
        throw new Error('overloaded');
      },
    ]);
    await expect(aiSdkModel(failing, { maxRetries: 0 }).turn(ECHO_REQ)).rejects.toThrow('overloaded');
    const forced = sdk([(opts) => (expect(opts.tools).toBeUndefined(), text(call('echo', { text: 'j' })))]);
    expect((await aiSdkModel(forced, { mode: 'json' }).turn(ECHO_REQ)).mode).toBe('json');
    const noFallback = sdk([() => ({ ...text('Hi!'), warnings: [{ type: 'unsupported', feature: 'tools' }] })]);
    expect(await aiSdkModel(noFallback, { mode: 'tools' }).turn(ECHO_REQ)).toMatchObject({
      mode: 'tools',
      text: 'Hi!',
    });
  });
});

test.describe('cassettes', () => {
  test('the tools key is the key every existing cassette uses; the JSON key adds the mode', () => {
    expect(requestKey(ECHO_REQ, 'm')).toBe(sha256(canonicalJson({ model: 'm', request: ECHO_REQ })));
    expect(requestKey(ECHO_REQ, 'm', 'tools')).toBe(requestKey(ECHO_REQ, 'm'));
    expect(requestKey(ECHO_REQ, 'm', 'json')).toBe(
      sha256(canonicalJson({ model: 'm', mode: 'json', request: ECHO_REQ })),
    );
  });

  test('a JSON-mode run records under its mode and replays; a replay pinned to tools does not use it', async () => {
    const file = join(tmp(), 'c.json');
    const rec = recordingModel(jsonModeModel(textAdapter([call('echo', { text: 'hi' })])), file);
    const live = await rec.turn(ECHO_REQ);
    rec.save();
    const cassette = JSON.parse(readFileSync(file, 'utf8'));
    expect(Object.keys(cassette.turns)).toEqual([requestKey(ECHO_REQ, 'my-llm', 'json')]);
    expect(await replayModel(file).turn(ECHO_REQ)).toEqual(live);
    expect(await replayModel(file, { mode: 'json' }).turn(ECHO_REQ)).toEqual(live);
    await expect(replayModel(file, { mode: 'tools' }).turn(ECHO_REQ)).rejects.toThrow('has no recording');
  });
});

test.describe('model forms', () => {
  test('an adapter is used as it is, or in JSON mode when it has no tools; an AI SDK model is wrapped', async () => {
    const adapter: ModelClient = { id: 'mine', turn: async () => turnOf('') };
    expect(await resolveModel(adapter)).toBe(adapter);
    expect(isJsonModeModel(await resolveModel(adapter, { mode: 'json' }))).toBe(true);
    expect(isJsonModeModel(await resolveModel(textAdapter([])))).toBe(true);
    expect((await resolveModel(adapter, { id: 'renamed' })).id).toBe('renamed');
    expect((await resolveModel(sdk([]))).id).toBe('mock:small-model');
    // An AI SDK model object is a valid `model` for the config's types.
    expect(defineConfig({ model: sdk([]) }).model).toBeDefined();
    expect((await resolveModel(() => adapter)).id).toBe('mine');
    await expect(resolveModel({ nope: true } as never)).rejects.toThrow('not a model: expected "provider:model"');
  });

  test('a "provider:model" string loads the provider package, or names the one to install', async () => {
    const m = await resolveModel('anthropic:claude-haiku-4-5');
    expect(m.id).toBe('anthropic:claude-haiku-4-5'); // the string is the id (cassettes, records)
    await expect(resolveModel('mistral:mistral-large-latest')).rejects.toThrow(
      'model "mistral:mistral-large-latest" needs the AI SDK provider package @ai-sdk/mistral: npm i -D @ai-sdk/mistral',
    );
    await expect(resolveModel('ollama:llama3.1:8b')).rejects.toThrow('ollama-ai-provider-v2');
    await expect(resolveModel('llama3:8b')).rejects.toThrow('names no known provider');
    expect((await resolveModel('anthropic/claude-opus-5-5')).id).toBe('anthropic/claude-opus-5-5'); // a gateway id
  });
});

test.describe('assay.config.ts', () => {
  test('is found in the project root, typed, and its paths resolve against it', async () => {
    expect(defineConfig({ checks: 'x' })).toEqual({ checks: 'x' });
    const dir = configDir(`import { defineConfig, type AssayConfig } from '@assay/index.ts';
const stress: AssayConfig['stress'] = { skipVariants: ['reorder'] };
export default defineConfig({ model: 'anthropic:claude-opus-5-5', checks: 'checks', recordDir: 'records', stress });
`);
    const { config, path } = await loadConfig({ cwd: dir });
    expect(path).toBe(join(dir, 'assay.config.ts'));
    expect(config).toEqual({
      model: 'anthropic:claude-opus-5-5',
      checks: join(dir, 'checks'),
      recordDir: join(dir, 'records'),
      stress: { skipVariants: ['reorder'] },
    });
    expect((await loadConfig({ cwd: tmp() })).config).toEqual({});
    const mjs = configDir(`export default async () => ({ snapshots: 'runs' });`, 'assay.config.mjs');
    expect((await loadConfig({ cwd: mjs })).config).toEqual({ snapshots: join(mjs, 'runs') });
  });

  test('a typo or a bad value is an error naming the file and the option', async () => {
    const typo = configDir(`export default { modle: 'openai:gpt-5' };`);
    await expect(loadConfig({ cwd: typo })).rejects.toThrow('unknown option `modle`');
    const signed = configDir(`export default { requireLocked: 'signed' };`);
    await expect(loadConfig({ cwd: signed })).rejects.toThrow('`requireLocked: "signed"` needs `trustedKeys`');
    await expect(loadConfig({ cwd: tmp(), path: 'missing.ts' })).rejects.toThrow('config file not found');
  });

  test('the init template loads and names the measured model', async () => {
    const dir = configDir(CONFIG_TEMPLATE.replace("'@swissspidy/assay'", "'@assay/index.ts'"));
    const { config } = await loadConfig({ cwd: dir });
    expect(config).toEqual({
      model: 'anthropic:claude-opus-5-5',
      checks: join(dir, 'checks'),
      snapshots: join(dir, 'snapshots'),
    });
  });

  test('verify takes recordDir, requireLocked and escalation from the config; explicit options win', async () => {
    const records = tmp();
    const adapter = () =>
      textAdapter([call('find_nodes', { text: 'Mug' }), call('submit_verdict', JSON.parse(verdicts))]);
    const escalated = await verify(TWO_MUGS, unanchored(), {
      config: { escalate: true, model: adapter(), recordDir: records },
    });
    expect(escalated.outcome.verdict).toBe('success');
    expect(escalated.record.escalation).toMatchObject({ model: 'my-llm', modes: ['json'] });
    expect(readdirSync(join(records, 'records'))).toHaveLength(1);
    // escalate: false wins over the config, and the model is never loaded.
    const never = () => {
      throw new Error('the model must not be loaded');
    };
    const off = await verify(TWO_MUGS, unanchored(), { escalate: false, config: { escalate: true, model: never } });
    expect(off.outcome.verdict).toBe('abstain');
    // Without escalation a configured model is never resolved, even when it could not be.
    expect((await verify(TWO_MUGS, unanchored(), { config: { model: never } })).outcome.verdict).toBe('abstain');
    // Escalation asked for, nothing to escalate: the model is not loaded either.
    const decided = ref('03-cart-two-mugs', 'both-mugs');
    expect((await verify(TWO_MUGS, decided, { config: { escalate: true, model: never } })).outcome.verdict).toBe(
      'success',
    );
    await expect(verify(TWO_MUGS, decided, { config: { escalate: true } })).rejects.toThrow(
      'verify with escalation needs a model',
    );
    await expect(verify(TWO_MUGS, decided, { config: { requireLocked: true } })).rejects.toThrow('not locked');
    expect(
      (await verify(TWO_MUGS, decided, { requireLocked: false, config: { requireLocked: true } })).outcome.verdict,
    ).toBe('success');
  });

  test('library calls never read assay.config.* from the current directory by themselves', async () => {
    const dir = configDir(`export default { requireLocked: true, model: () => { throw new Error('read'); } };`);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      // The project's config would refuse the unlocked set; without `config` it is not read.
      const decided = ref('03-cart-two-mugs', 'both-mugs');
      expect((await verify(TWO_MUGS, decided)).outcome.verdict).toBe('success');
      expect(await verifyMany(TWO_MUGS, [decided])).toHaveLength(1);
      await expect(compileTask({ id: 't', instruction: 'x' }, [])).rejects.toThrow('compileTask needs a model');
      // Passed as a path, it applies.
      await expect(verify(TWO_MUGS, decided, { config: 'assay.config.ts' })).rejects.toThrow('not locked');
    } finally {
      process.chdir(cwd);
    }
  });

  test('compileTask takes the model from the config and reproduces the committed check set', async () => {
    const cassette = shop('compiled/02-add-blue-mug.cassette.json');
    const task = JSON.parse(readFileSync(BLUE_MUG, 'utf8')).task;
    const model = replayModel(cassette);
    const dir = configDir(`import { replayModel } from '@assay/model/replay.ts';
export default { model: replayModel(${JSON.stringify(cassette)}) };`);
    const { checkSet } = await compileTask(
      { id: 'tiny-shop/02-add-blue-mug', instruction: task.instruction, outcomes: task.outcomes },
      [{ name: 'added-blue-mug', kind: 'success', snapshot: JSON.parse(readFileSync(ADDED_BLUE, 'utf8')).snapshot }],
      { config: join(dir, 'assay.config.ts'), provenance: model.recorded },
    );
    expect(JSON.stringify(checkSet, null, 2) + '\n').toBe(
      readFileSync(shop('compiled/02-add-blue-mug.checks.json'), 'utf8'),
    );
    await expect(compileTask({ id: 't', instruction: 'x' }, [], { config: false })).rejects.toThrow(
      'compileTask needs a model. Set `model` in assay.config.ts',
    );
  });
});

test.describe('CLI', () => {
  test('init writes the config once, and every command finds it', async () => {
    const dir = tmp();
    const first = await assay(['init'], {}, dir);
    expect(first).toMatchObject({ code: 0 });
    expect(first.stdout).toContain(`Created ${join(dir, 'assay.config.ts')}`);
    expect(readFileSync(join(dir, 'assay.config.ts'), 'utf8')).toBe(CONFIG_TEMPLATE);
    const again = await assay(['init'], {}, dir);
    expect(again.code).toBe(4);
    expect(again.stderr).toContain('already exists (--force replaces it)');
    expect((await assay(['init', '--force'], {}, dir)).code).toBe(0);
  });

  test('flags win over the environment, which wins over the config', async () => {
    const dir = configDir(`export default { model: 'mistral:from-config' };`);
    const args = ['compile', 'Do it.', '-r', ADDED_BLUE];
    expect((await assay(args, {}, dir)).stderr).toContain(
      '"mistral:from-config" needs the AI SDK provider package @ai-sdk/mistral',
    );
    expect((await assay(args, { ASSAY_MODEL: 'cohere:from-env' }, dir)).stderr).toContain('"cohere:from-env" needs');
    expect(
      (await assay([...args, '--model', 'groq:from-flag'], { ASSAY_MODEL: 'cohere:from-env' }, dir)).stderr,
    ).toContain('"groq:from-flag" needs');
    // --config points elsewhere; a replayed cassette needs no live model at all.
    const other = configDir(`export default { model: () => { throw new Error('not loaded'); } };`);
    const out = join(tmp(), 'checks.json');
    const replayed = await assay(
      [
        'compile',
        BLUE_MUG,
        '--id',
        'tiny-shop/02-add-blue-mug',
        '-r',
        ADDED_BLUE,
        '-o',
        out,
        '--cassette',
        shop('compiled/02-add-blue-mug.cassette.json'),
        '--config',
        join(other, 'assay.config.ts'),
      ],
      { ASSAY_MODEL_MODE: 'replay' },
    );
    expect(replayed.code).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(shop('compiled/02-add-blue-mug.checks.json'), 'utf8'));
  });

  test('a command that needs no model never loads one; a config model is used for escalation', async () => {
    const records = tmp();
    const dir = configDir(`import { readFileSync } from 'node:fs';
let i = 0;
const replies = ${JSON.stringify([call('find_nodes', { text: 'Mug' }), call('submit_verdict', JSON.parse(verdicts))])};
export default {
  model: { id: 'cfg-llm', capabilities: { tools: false }, async turn() {
    return { stop: 'end_turn', text: replies[i++], toolCalls: [], raw: [], usage: { inputTokens: 1, outputTokens: 1 }, model: 'cfg-llm' };
  } },
  recordDir: ${JSON.stringify(records)},
  checks: ${JSON.stringify(shop('tasks'))},
};`);
    const unanchoredFile = join(tmp(), 'run.json');
    writeFileSync(unanchoredFile, JSON.stringify(unanchored()));
    const plain = await assay(['verify', shop('tasks/03-cart-two-mugs.checks.json'), unanchoredFile], {}, dir);
    expect(plain.code).toBe(2); // abstain: no escalation asked for
    expect(plain.stdout).toContain('Record: ');
    const escalated = await assay(
      ['verify', shop('tasks/03-cart-two-mugs.checks.json'), unanchoredFile, '--escalate', '--json'],
      {},
      dir,
    );
    expect(escalated.code).toBe(0);
    expect(JSON.parse(escalated.stdout).escalation).toMatchObject({ model: 'cfg-llm', modes: ['json'] });
    const validated = await assay(['validate'], {}, dir);
    expect(validated.code).toBe(0);
    expect(validated.stdout).toContain('02-add-blue-mug.checks.json: valid');
    expect(readdirSync(join(records, 'records')).length).toBe(2);
  });

  test('requireLocked from the config; a flag turns it off; validate without files or config is a usage error', async () => {
    const dir = configDir(`export default { requireLocked: true };`);
    const refused = await assay(['verify', BLUE_MUG, ADDED_BLUE], {}, dir);
    expect(refused.code).toBe(4);
    expect(refused.stderr).toContain('not locked');
    expect((await assay(['verify', BLUE_MUG, ADDED_BLUE, '--no-require-locked'], {}, dir)).code).toBe(0);
    expect((await assay(['validate', BLUE_MUG], {}, dir)).code).toBe(1);
    const none = await assay(['validate'], {}, tmp());
    expect(none.code).toBe(3);
    expect(none.stderr).toContain('`checks` in assay.config.ts');
  });
});
