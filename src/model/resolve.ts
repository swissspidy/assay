/**
 * Bring your own model (ADR 0017): turn what a user configures as `model` into a
 * `ModelClient`. Three forms are accepted:
 *
 * - any Vercel AI SDK language model (`anthropic('…')`, `openai('…')`, `ollama('…')`);
 * - a custom adapter, `{ id, turn(request) }`, with Assay's own request and turn types;
 * - a `'provider:model'` string, resolved through the AI SDK provider package if it is
 *   installed (`'anthropic:claude-opus-5-5'` → `@ai-sdk/anthropic`).
 *
 * Nothing here imports the AI SDK statically: it is an optional peer dependency, loaded
 * only when an AI SDK model is used.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isJsonModeModel, jsonModeModel } from './json-mode.ts';
import type { ModelClient, ModelMode } from './types.ts';
import { createAiSdkModel, type AiFunctions, type AiSdkOptions } from './ai-sdk-core.ts';
import { ModelError } from './types.ts';

/**
 * The part of an AI SDK `LanguageModel` object Assay looks at. Declared structurally, so
 * these types do not depend on the optional `ai` package.
 */
export interface LanguageModelLike {
  readonly specificationVersion: string;
  readonly provider: string;
  readonly modelId: string;
  doGenerate(options: never): PromiseLike<unknown>;
}

/** What `model` accepts, in the config and in the library's options. */
export type ModelInput =
  | string
  | LanguageModelLike
  | ModelClient
  /** Called only when a model is needed, so a config can import its provider lazily. */
  | (() => ModelInput | Promise<ModelInput>);

export interface ModelOptions {
  /**
   * How to drive the model: `auto` (default) uses native tool calling and falls back to
   * JSON mode when the provider reports that the model has none; `tools` and `json`
   * force one. A custom adapter is driven in JSON mode when it declares
   * `capabilities: { tools: false }`.
   */
  mode?: ModelMode | 'auto';
  /**
   * The id recorded in outcome records, check set provenance and cassette keys. Defaults
   * to the string you wrote, `<provider>:<modelId>` for an AI SDK model, or the adapter's
   * own id.
   */
  id?: string;
  /** AI SDK models: passed to `generateText` unchanged. */
  providerOptions?: Record<string, Record<string, unknown>>;
  /** AI SDK models: the output token limit. */
  maxOutputTokens?: number;
  /** AI SDK models: retries on transient API errors. */
  maxRetries?: number;
}

/** A provider name in `'provider:model'` and the AI SDK package (and its export) that serves it. */
export const PROVIDERS: Readonly<Record<string, { pkg: string; factory: string }>> = {
  anthropic: { pkg: '@ai-sdk/anthropic', factory: 'anthropic' },
  openai: { pkg: '@ai-sdk/openai', factory: 'openai' },
  google: { pkg: '@ai-sdk/google', factory: 'google' },
  'google-vertex': { pkg: '@ai-sdk/google-vertex', factory: 'vertex' },
  'amazon-bedrock': { pkg: '@ai-sdk/amazon-bedrock', factory: 'bedrock' },
  bedrock: { pkg: '@ai-sdk/amazon-bedrock', factory: 'bedrock' },
  azure: { pkg: '@ai-sdk/azure', factory: 'azure' },
  mistral: { pkg: '@ai-sdk/mistral', factory: 'mistral' },
  groq: { pkg: '@ai-sdk/groq', factory: 'groq' },
  xai: { pkg: '@ai-sdk/xai', factory: 'xai' },
  deepseek: { pkg: '@ai-sdk/deepseek', factory: 'deepseek' },
  cohere: { pkg: '@ai-sdk/cohere', factory: 'cohere' },
  cerebras: { pkg: '@ai-sdk/cerebras', factory: 'cerebras' },
  fireworks: { pkg: '@ai-sdk/fireworks', factory: 'fireworks' },
  togetherai: { pkg: '@ai-sdk/togetherai', factory: 'togetherai' },
  perplexity: { pkg: '@ai-sdk/perplexity', factory: 'perplexity' },
  ollama: { pkg: 'ollama-ai-provider-v2', factory: 'ollama' },
  openrouter: { pkg: '@openrouter/ai-sdk-provider', factory: 'openrouter' },
  gateway: { pkg: 'ai', factory: 'gateway' },
};

/**
 * The error when something needs a model and none is configured, with the three forms.
 * `alternatives` adds what else the caller accepts (the CLI's flags).
 */
export function noModelError(what: string, alternatives = 'pass `model` in the options'): ModelError {
  return new ModelError(
    [
      `${what} needs a model. Set \`model\` in assay.config.ts (\`npx assay init\` writes one), e.g.`,
      `  model: 'anthropic:claude-opus-5-5',  // a "provider:model" string (npm i -D ai @ai-sdk/anthropic)`,
      `  model: openai('gpt-5'),              // any Vercel AI SDK model`,
      `  model: { id: 'my-llm', turn },       // your own adapter`,
      `Or ${alternatives}.`,
    ].join('\n'),
  );
}

/** The three forms, for error messages. */
export const MODEL_FORMS = `"provider:model" (e.g. 'anthropic:claude-opus-5-5'), an AI SDK model (e.g. anthropic('claude-opus-5-5')), or an adapter { id, turn(request) }`;

const isModuleNotFound = (e: unknown) =>
  ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes((e as NodeJS.ErrnoException)?.code ?? '');

/**
 * Import an optional package as the project in `cwd` sees it, else from Assay's own location.
 * The project comes first: with a linked or globally installed Assay, its own location may hold
 * no copy, or another one (its development dependencies). Undefined when neither has it.
 */
export async function importOptional(pkg: string, cwd = process.cwd()): Promise<Record<string, unknown> | undefined> {
  const req = createRequire(join(cwd, 'package.json'));
  let resolved: string | undefined;
  try {
    resolved = req.resolve(pkg);
  } catch {
    // Not in the project: fall back to Assay's own location below.
  }
  if (resolved !== undefined) {
    try {
      // require() of the package (CommonJS, or ES modules in Node 24) loads it as the project would.
      return req(pkg) as Record<string, unknown>;
    } catch {
      // An ES module require() cannot load (top-level await): import the resolved file instead.
      return (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
    }
  }
  try {
    return (await import(pkg)) as Record<string, unknown>;
  } catch (e) {
    if (isModuleNotFound(e) && String((e as Error).message).includes(pkg)) return undefined;
    throw e;
  }
}

export const isModelClient = (x: unknown): x is ModelClient =>
  !!x && typeof x === 'object' && typeof (x as ModelClient).turn === 'function';

export const isLanguageModel = (x: unknown): x is LanguageModelLike =>
  !!x &&
  typeof x === 'object' &&
  typeof (x as LanguageModelLike).doGenerate === 'function' &&
  typeof (x as LanguageModelLike).modelId === 'string';

/** A short description of a model input, for records and messages, without resolving it. */
export function describeModel(input: ModelInput | undefined, opts: ModelOptions = {}): string {
  if (opts.id) return opts.id;
  if (typeof input === 'string') return input;
  if (isModelClient(input)) return input.id;
  if (isLanguageModel(input)) return `${input.provider}:${input.modelId}`;
  return typeof input === 'function' ? 'model (from a function)' : 'model';
}

/** The AI SDK functions from the `ai` package (the project's first), or undefined when it is not installed. */
async function aiFunctions(cwd: string): Promise<AiFunctions | undefined> {
  const ai = await importOptional('ai', cwd);
  if (!ai) return undefined;
  if (typeof ai.generateText !== 'function' || typeof ai.jsonSchema !== 'function')
    throw new ModelError('the installed `ai` package has no generateText or jsonSchema: Assay needs ai 7 or later');
  return ai as unknown as AiFunctions;
}

async function loadAiSdk(why: string, cwd: string): Promise<AiFunctions> {
  const ai = await aiFunctions(cwd);
  if (!ai) throw new ModelError(`${why} needs the Vercel AI SDK, an optional peer dependency: npm i -D ai`);
  return ai;
}

function aiOptions(opts: ModelOptions): AiSdkOptions {
  return {
    ...(opts.id ? { id: opts.id } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.providerOptions ? { providerOptions: opts.providerOptions } : {}),
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
  } as AiSdkOptions;
}

/** Split `'provider:model'`; undefined when the prefix is not a known provider (`llama3:8b`). */
export function parseModelString(s: string): { provider: string; modelId: string } | undefined {
  const i = s.indexOf(':');
  if (i <= 0) return undefined;
  const provider = s.slice(0, i);
  const modelId = s.slice(i + 1);
  return Object.hasOwn(PROVIDERS, provider) && modelId ? { provider, modelId } : undefined;
}

async function fromString(s: string, opts: ModelOptions, cwd: string): Promise<ModelClient> {
  const parsed = parseModelString(s);
  if (!parsed) {
    // A gateway id ("anthropic/claude-opus-5-5") goes to the AI SDK's default provider.
    if (/^[\w.-]+\/[\w.:-]+$/.test(s)) {
      return createAiSdkModel(await loadAiSdk(`model "${s}"`, cwd), s, aiOptions(opts));
    }
    throw new ModelError(
      `model "${s}" names no known provider: write "provider:model", e.g. "anthropic:claude-opus-5-5" (providers: ${Object.keys(PROVIDERS).join(', ')}), or pass an AI SDK model or an adapter in assay.config.ts`,
    );
  }
  const { provider, modelId } = parsed;
  const { pkg, factory } = PROVIDERS[provider]!;
  const [ai, mod] = await Promise.all([aiFunctions(cwd), importOptional(pkg, cwd)]);
  // Name everything that is missing at once.
  const missing = [...(ai ? [] : ['ai']), ...(mod || pkg === 'ai' ? [] : [pkg])];
  if (missing.length) {
    const what =
      missing.length === 2
        ? `the Vercel AI SDK and its provider package ${pkg}`
        : missing[0] === 'ai'
          ? 'the Vercel AI SDK'
          : `the AI SDK provider package ${pkg}`;
    throw new ModelError(`model "${s}" needs ${what}: npm i -D ${missing.join(' ')}`);
  }
  const make = mod![factory];
  if (typeof make !== 'function') throw new ModelError(`${pkg} has no export "${factory}" to create "${s}" with`);
  const model = (make as (id: string) => LanguageModelLike)(modelId);
  return createAiSdkModel(ai!, model as never, { id: s, ...aiOptions(opts) });
}

/**
 * Resolve a model input into a `ModelClient`. A `ModelClient` is returned as it is (in
 * JSON mode when it declares no tool calling, or `mode: 'json'` is given); an AI SDK
 * model is wrapped with `aiSdkModel`; a string is looked up as `'provider:model'`.
 */
export async function resolveModel(
  input: ModelInput,
  opts: ModelOptions & { cwd?: string } = {},
): Promise<ModelClient> {
  const cwd = opts.cwd ?? process.cwd();
  if (typeof input === 'function') return resolveModel(await input(), opts);
  if (typeof input === 'string') return fromString(input.trim(), opts, cwd);
  if (isModelClient(input)) {
    if (typeof input.id !== 'string' || !input.id) throw new ModelError('a model adapter needs a string `id`');
    // A client that drives JSON mode itself (jsonModeModel, an AI SDK client) is never wrapped again.
    if (isJsonModeModel(input)) return input;
    const json = opts.mode === 'json' || (opts.mode !== 'tools' && input.capabilities?.tools === false);
    const client =
      opts.id && opts.id !== input.id
        ? {
            id: opts.id,
            turn: input.turn.bind(input),
            ...(input.capabilities ? { capabilities: input.capabilities } : {}),
          }
        : input;
    return json ? jsonModeModel(client) : client;
  }
  if (isLanguageModel(input)) {
    const ai = await loadAiSdk(`model ${input.provider}:${input.modelId}`, cwd);
    return createAiSdkModel(ai, input as never, aiOptions(opts));
  }
  throw new ModelError(`not a model: expected ${MODEL_FORMS}`);
}
