/**
 * Model selection for the CLI (ADR 0010, ADR 0017). The first of these that is set wins:
 *
 * 1. Flags: `--provider` / `--model`. `--model provider:model` is the string form of the
 *    config (`openai:gpt-5`); a bare id goes to `--provider` (default: anthropic).
 * 2. Environment: $ASSAY_PROVIDER / $ASSAY_MODEL, read the same way.
 * 3. The config: `model` (and `modelOptions`) in assay.config.ts.
 * 4. With $ANTHROPIC_API_KEY set: `anthropicModel` (claude-opus-5-5), as before configs existed.
 *
 * `--cassette <file>` replays an existing cassette, else records a live run to it; then no
 * live model is resolved at all. ASSAY_MODEL_MODE=replay never calls a model;
 * ASSAY_MODEL_MODE=record re-records.
 */
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LoadedConfig } from '../config/config.ts';
import { noModelError, parseModelString, resolveModel } from '../model/resolve.ts';
import type { ModelClient } from '../model/types.ts';
import { ModelError } from '../model/types.ts';
import { CliError, UsageError, type Values } from './io.ts';

export interface SelectedModel {
  model: ModelClient;
  mode: 'live' | 'record' | 'replay';
  /** The recorded model and time for a cassette (what the compiler writes as provenance). */
  provenance?: { model: string; at: string };
  /** Move a recorded cassette into place (no-op when nothing was recorded, or when replaying). */
  save(): void;
}

export type Provider = 'anthropic' | 'ai-sdk';

export function providerOf(values: Values, env: Record<string, string | undefined>): Provider {
  const p = (values.provider as string | undefined) ?? (env.ASSAY_PROVIDER || 'anthropic');
  if (p !== 'anthropic' && p !== 'ai-sdk')
    throw new UsageError(`--provider must be "anthropic" or "ai-sdk", got ${JSON.stringify(p)}`);
  return p;
}

/** A model error (a missing provider package, a bad model string) as a one-line CLI error. */
async function cli<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ModelError) throw new CliError(e.message);
    throw e;
  }
}

/** The live model, by precedence: flags, environment, config, then the Anthropic default with a key. */
async function chooseLive(
  values: Values,
  env: Record<string, string | undefined>,
  loaded: LoadedConfig,
  command: string,
): Promise<ModelClient> {
  const provider = (values.provider as string | undefined) ?? (env.ASSAY_PROVIDER || undefined);
  const id = (values.model as string | undefined) ?? (env.ASSAY_MODEL || undefined);
  const { config } = loaded;
  const mode = config.modelOptions?.mode;
  if (provider !== undefined || id !== undefined) {
    // "openai:gpt-5" is the config's string form and names its own provider, so only an
    // explicit --provider flag (not $ASSAY_PROVIDER) overrides it; a bare id keeps its old meaning.
    if (values.provider === undefined && id !== undefined && parseModelString(id))
      return cli(resolveModel(id, mode ? { mode } : {}));
    return liveModel(providerOf(values, env), id, env);
  }
  if (config.model !== undefined) {
    return cli(
      resolveModel(config.model, {
        ...config.modelOptions,
        ...(loaded.path ? { cwd: dirname(loaded.path) } : {}),
      }),
    );
  }
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return liveModel('anthropic', undefined, env);
  throw new CliError(
    noModelError(
      `assay ${command}`,
      'pass --model <provider:model>, set ANTHROPIC_API_KEY (Claude through @anthropic-ai/sdk), or replay a recording with --cassette <file>',
    ).message,
  );
}

const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ERR_MODULE_NOT_FOUND';

async function liveModel(provider: Provider, id: string | undefined, env: Record<string, string | undefined>) {
  if (provider === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) {
      throw new CliError('no model key: set ANTHROPIC_API_KEY, or pass --cassette <file> to replay a recording.');
    }
    const { anthropicModel } = await import('../model/anthropic.ts');
    return anthropicModel(id ? { model: id } : {});
  }
  if (!id) throw new UsageError('--provider ai-sdk needs a model id: --model or ASSAY_MODEL');
  const { aiSdkModel } = await import('../model/ai-sdk.ts').catch((e: unknown) => {
    throw missing(e) ? new CliError('--provider ai-sdk requires the optional dependency `ai` (npm i ai).') : e;
  });
  return aiSdkModel(id);
}

export async function selectModel(
  values: Values,
  env: Record<string, string | undefined>,
  loaded: LoadedConfig = { config: {} },
  command = 'compile',
): Promise<SelectedModel> {
  if (values.provider !== undefined) providerOf(values, env);
  const live = () => chooseLive(values, env, loaded, command);
  const cassette = values.cassette as string | undefined;
  const mode = env.ASSAY_MODEL_MODE || undefined;
  if (mode !== undefined && mode !== 'replay' && mode !== 'record') {
    throw new CliError(`ASSAY_MODEL_MODE must be "replay" or "record", got ${JSON.stringify(mode)}`);
  }
  const { recordingModel, replayModel } = await import('../model/replay.ts');
  if (!cassette) {
    if (mode) throw new UsageError(`ASSAY_MODEL_MODE=${mode} needs --cassette <file>`);
    return { model: await live(), mode: 'live', save: () => {} };
  }
  const exists = existsSync(cassette);
  if (mode === 'replay' || (exists && mode !== 'record')) {
    if (!exists) throw new CliError(`no cassette at ${cassette} (ASSAY_MODEL_MODE=replay never calls a model)`);
    const forced = loaded.config.modelOptions?.mode;
    const model = replayModel(cassette, forced === 'tools' || forced === 'json' ? { mode: forced } : {});
    return { model, mode: 'replay', provenance: model.recorded, save: () => {} };
  }
  const rec = recordingModel(await live(), cassette);
  // Saved only when a turn was recorded: an empty recording must not replace a cassette.
  let turns = 0;
  const model: ModelClient = {
    id: rec.id,
    async turn(req) {
      const out = await rec.turn(req);
      turns++;
      return out;
    },
  };
  return { model, mode: 'record', provenance: rec.recorded, save: () => turns > 0 && rec.save() };
}
